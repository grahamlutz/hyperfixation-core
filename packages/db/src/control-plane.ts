import { DBOS } from "@dbos-inc/dbos-sdk";
import type { ClientBase, Pool, PoolClient } from "pg";

/**
 * The bound on a control-plane wait. Fenced writes are short by construction, so a wait this
 * long is a bug being reported rather than work being lost.
 */
export const CONTROL_PLANE_LOCK_TIMEOUT = "30s";

/** Postgres `lock_not_available`, what `lock_timeout` raises. */
export const LOCK_NOT_AVAILABLE = "55P03";

const LOCK_TIMEOUT_PATTERN = /^\d+(?:ms|s|min)$/;

export class ControlPlaneInWorkflow extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(`ControlPlaneInWorkflow: ${operation} is a control-plane operation and cannot run inside a run`);
    this.name = "ControlPlaneInWorkflow";
    this.operation = operation;
  }
}

export class CommitLost extends Error {
  readonly operation: string;
  readonly commandTag: string | undefined;

  constructor(operation: string, commandTag: string | undefined) {
    super(
      `CommitLost: ${operation} answered COMMIT with ${commandTag ?? "no command tag"}; ` +
        "nothing the transaction wrote is durable",
    );
    this.name = "CommitLost";
    this.operation = operation;
    this.commandTag = commandTag;
  }
}

export class RunNotFound extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`RunNotFound: no hf_run row for ${runId}`);
    this.name = "RunNotFound";
    this.runId = runId;
  }
}

export class ConcurrentBump extends Error {
  readonly runId: string;
  readonly attempt: number;

  constructor(runId: string, attempt: number) {
    super(`ConcurrentBump: hf_run ${runId} left attempt ${attempt} before this bump could write it`);
    this.name = "ConcurrentBump";
    this.runId = runId;
    this.attempt = attempt;
  }
}

export class WorkflowIdCollision extends Error {
  readonly runId: string;
  readonly workflowId: string;

  constructor(runId: string, workflowId: string) {
    super(
      `WorkflowIdCollision: a dbos.workflow_status row already exists for ${workflowId}, ` +
        `the id ${runId}'s next attempt was about to take`,
    );
    this.name = "WorkflowIdCollision";
    this.runId = runId;
    this.workflowId = workflowId;
  }
}

export class RunLockTimeout extends Error {
  readonly code = LOCK_NOT_AVAILABLE;
  readonly runId: string;

  constructor(runId: string, cause: unknown) {
    super(
      `RunLockTimeout (${LOCK_NOT_AVAILABLE}): waiting on the hf_run row of ${runId} ` +
        "exceeded the control-plane lock_timeout",
      { cause },
    );
    this.name = "RunLockTimeout";
    this.runId = runId;
  }
}

/**
 * The first thing every control-plane operation does, before any statement. `DBOS` is read on
 * each call rather than destructured, so a stubbed predicate is seen (`fence.test.ts` (vii)).
 */
export function assertNotInWorkflow(operation: string): void {
  if (DBOS.isWithinWorkflow()) throw new ControlPlaneInWorkflow(operation);
}

export interface ControlPlaneTxOptions {
  /** Names the operation in `ControlPlaneInWorkflow` and `CommitLost`. */
  operation: string;
  /** A Postgres interval literal; tests shorten it to reach `55P03` in test time. */
  lockTimeout?: string;
}

/**
 * The only way a control-plane transaction is opened or committed. **Nothing inside `work` may
 * catch**: a swallowed error leaves the transaction aborted, and Postgres then answers `COMMIT`
 * with a `ROLLBACK` command tag that node-pg does not raise — the tag assert below is what makes
 * that loud instead of silent (round-3 finding 5).
 */
export async function controlPlaneTx<T>(
  pool: Pool,
  options: ControlPlaneTxOptions,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertNotInWorkflow(options.operation);

  const lockTimeout = options.lockTimeout ?? CONTROL_PLANE_LOCK_TIMEOUT;
  if (!LOCK_TIMEOUT_PATTERN.test(lockTimeout)) {
    throw new TypeError(`lockTimeout must be a Postgres interval literal such as '30s': ${lockTimeout}`);
  }

  const client = await pool.connect();
  let result: T;
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);
    result = await work(client);
    const commit = await client.query("COMMIT");
    if (commit.command !== "COMMIT") throw new CommitLost(options.operation, commit.command);
  } catch (error) {
    // The connection's transaction state is aborted or unknown, so it goes back *with* the error
    // and the pool destroys it. `ROLLBACK`'s own failure must not mask the error that got here.
    await client.query("ROLLBACK").catch(() => undefined);
    client.release(error as Error);
    throw error;
  }
  client.release();
  return result;
}

/** Attempt 1 runs under the run's own id; attempt N under `${runId}:${N}`. */
export function attemptWorkflowId(runId: string, attempt: number): string {
  return attempt === 1 ? runId : `${runId}:${attempt}`;
}

export const LOCK_RUN_STATEMENT =
  "SELECT attempt, current_workflow_id, flow, input FROM hf_run WHERE run_id = $1 FOR UPDATE";

export const BUMP_STATEMENT =
  "UPDATE hf_run SET attempt = $1, current_workflow_id = $2, status = 'running' " +
  "WHERE run_id = $3 AND attempt = $4";

export const WORKFLOW_ID_TAKEN_STATEMENT =
  "SELECT 1 FROM dbos.workflow_status WHERE workflow_uuid = $1";

export interface BumpedAttempt {
  runId: string;
  /** The flow and input the new attempt is to be enqueued with. */
  flow: string;
  input: unknown;
  previousAttempt: number;
  attempt: number;
  workflowId: string;
}

interface RunRow {
  attempt: number;
  current_workflow_id: string;
  flow: string;
  input: unknown;
}

/**
 * The one attempt-bump path — `runs.start`, `decide()`, `resume` and `reconcile()` all bump
 * through this function and no other. `client` must already be inside a `controlPlaneTx`; the
 * caller enqueues the returned `workflowId` on the same client, so the enqueue commits with the
 * bump or not at all.
 */
export async function bumpAttempt(client: ClientBase, runId: string): Promise<BumpedAttempt> {
  const locked = await client.query<RunRow>(LOCK_RUN_STATEMENT, [runId]).catch((error: unknown) => {
    // Rethrown, not handled: the transaction stays aborted and `controlPlaneTx` rolls it back.
    // This only attaches the run id, which the raw `lock_timeout` message does not carry.
    throw isLockTimeout(error) ? new RunLockTimeout(runId, error) : error;
  });
  if (locked.rowCount === 0) throw new RunNotFound(runId);

  const previousAttempt = Number(locked.rows[0]!.attempt);
  // Computed here rather than as `attempt = attempt + 1` in SQL: the SQL form has no old value
  // to compare against, so two bumps that both read N both "succeed" (round-2 finding 2). The
  // number computed here is what the next statement's compare-and-set is against.
  const attempt = previousAttempt + 1;
  const workflowId = attemptWorkflowId(runId, attempt);

  const bumped = await client.query(BUMP_STATEMENT, [attempt, workflowId, runId, previousAttempt]);
  if (bumped.rowCount !== 1) throw new ConcurrentBump(runId, previousAttempt);

  // The id is fresh by construction, so a row under it is a bug in the construction — never a
  // silent no-op, which would strand the run under a workflow this transaction did not enqueue.
  const taken = await client.query(WORKFLOW_ID_TAKEN_STATEMENT, [workflowId]);
  if (taken.rowCount !== 0) throw new WorkflowIdCollision(runId, workflowId);

  return {
    runId,
    flow: locked.rows[0]!.flow,
    input: locked.rows[0]!.input,
    previousAttempt,
    attempt,
    workflowId,
  };
}

function isLockTimeout(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === LOCK_NOT_AVAILABLE;
}
