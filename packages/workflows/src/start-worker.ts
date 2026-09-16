import { DBOS, type WorkflowQueue } from "@dbos-inc/dbos-sdk";
import { createStepPool, runBootChecks, type RecordTable, type StepPool } from "@hyperfixation/db";
import { createControlPool, type ControlPool } from "./control-pool.js";
import { acquireWorkerLock, type WorkerLock } from "./worker-lock.js";
import { setWorkerRuntime } from "./worker-runtime.js";

/** The value of `HF_PROCESS` in the one process shape allowed to launch DBOS. */
export const WORKER_PROCESS = "worker";

/** Enough of a commit sha to be a version; `hf dev` sets `dev-<timestamp>`. */
export const MIN_BUILD_SHA_LENGTH = 7;

export const SYSTEM_DATABASE_SCHEMA = "dbos";
export const SYSTEM_DATABASE_POOL_SIZE = 5;

/**
 * The three queues, by name and concurrency. There is no flow registry yet; when there is,
 * `defineFlow` names one of these and nothing else may.
 */
export const QUEUES = [
  { name: "llm", globalConcurrency: 4 },
  { name: "actions", globalConcurrency: 2 },
  { name: "resolve", globalConcurrency: 1 },
] as const;

export type QueueName = (typeof QUEUES)[number]["name"];

/**
 * Logged on either side of the one `DBOS.launch()` call in the system. Redeploy case 6
 * asserts the first never appears in a second worker's output.
 */
export const LAUNCHING_MARKER = "hf-worker: calling DBOS.launch";
export const LAUNCHED_MARKER = "hf-worker: DBOS launched";

/** One per SIGTERM the handler acts on; redeploy case 11 counts them. */
export const SHUTDOWN_MARKER = "hf-worker: SIGTERM, calling DBOS.shutdown";
export const SHUTDOWN_IGNORED_MARKER = "hf-worker: SIGTERM ignored, already draining";
export const SHUTDOWN_FAILED_MARKER = "hf-worker: DBOS.shutdown rejected";

/** How long the drain waits for workflows running here before it abandons them. */
export const DRAIN_TIMEOUT_MS = 60_000;
/**
 * The handler's own bound, past the drain. Compose's `stop_grace_period: 90s` SIGKILL is the
 * line after this one, and the advisory lock is released by neither before the process dies.
 */
export const SHUTDOWN_WATCHDOG_MS = 75_000;

export class NotAWorkerProcess extends Error {
  readonly hfProcess: string | undefined;

  constructor(hfProcess: string | undefined) {
    super(
      `NotAWorkerProcess: startWorker() needs HF_PROCESS=${WORKER_PROCESS}, got ` +
        `${hfProcess === undefined ? "an unset HF_PROCESS" : JSON.stringify(hfProcess)}`,
    );
    this.name = "NotAWorkerProcess";
    this.hfProcess = hfProcess;
  }
}

export class MissingBuildSha extends Error {
  constructor(buildSha: string | undefined) {
    super(
      `MissingBuildSha: HF_BUILD_SHA must be at least ${MIN_BUILD_SHA_LENGTH} characters, got ` +
        `${buildSha === undefined ? "an unset HF_BUILD_SHA" : JSON.stringify(buildSha)}`,
    );
    this.name = "MissingBuildSha";
  }
}

export interface StartWorkerOptions {
  appName: string;
  /** The application role's connection string: both pools, the lock and DBOS all use it. */
  databaseUrl: string;
  /** Tables registered with `defineRecord`, for E001-E003. */
  recordTables?: readonly RecordTable[];
  /** The app's own migrations directory, for E005. */
  appMigrationsDir?: string;
}

export interface Worker {
  appName: string;
  applicationVersion: string;
  steps: StepPool;
  control: ControlPool;
  lock: WorkerLock;
  queues: Record<QueueName, WorkflowQueue>;
}

/**
 * The only place `DBOS.launch()` runs. Boot checks, then the two pools, then the advisory
 * lock, then launch — a worker that cannot prove it is alone never reaches the launch.
 */
export async function startWorker(options: StartWorkerOptions): Promise<Worker> {
  if (process.env.HF_PROCESS !== WORKER_PROCESS) {
    throw new NotAWorkerProcess(process.env.HF_PROCESS);
  }

  // Ahead of the boot checks only because it opens no connection — E001-E006 are still the
  // first statements this process issues. A missing version is a build misconfiguration, and
  // failing on it before taking a cluster-wide lock keeps the failure cheap.
  const applicationVersion = requireBuildSha();

  await runBootChecks({
    databaseUrl: options.databaseUrl,
    recordTables: options.recordTables,
    appMigrationsDir: options.appMigrationsDir,
  });

  const steps = createStepPool({ connectionString: options.databaseUrl });
  const control = createControlPool({ connectionString: options.databaseUrl });

  // Before the lock and launch: DBOS recovery can run a flow the instant `launch()` returns,
  // and a recovered flow reaches `workerRuntime()` the same as a freshly dispatched one.
  setWorkerRuntime({ appName: options.appName, applicationVersion, steps, control });

  try {
    const lock = await acquireWorkerLock(options.databaseUrl, options.appName);

    DBOS.setConfig({
      name: options.appName,
      systemDatabaseUrl: options.databaseUrl,
      systemDatabaseSchemaName: SYSTEM_DATABASE_SCHEMA,
      systemDatabasePoolSize: SYSTEM_DATABASE_POOL_SIZE,
      applicationVersion,
      executorID: WORKER_PROCESS,
      enablePatching: false,
      runAdminServer: false,
      maxConcurrentQueueDispatches: 1,
      runMigrations: false,
    });

    // Installed before `launch`, so a SIGTERM arriving during it is this process's to drain.
    process.on("SIGTERM", handleSigterm);

    console.info(LAUNCHING_MARKER, applicationVersion);
    await DBOS.launch();
    console.info(LAUNCHED_MARKER, applicationVersion);

    // `registerQueue` writes the queue's row through the system database, so it can only run
    // once DBOS is launched.
    const queues = {} as Record<QueueName, WorkflowQueue>;
    for (const queue of QUEUES) {
      queues[queue.name] = await DBOS.registerQueue(queue.name, {
        globalConcurrency: queue.globalConcurrency,
      });
    }

    return { appName: options.appName, applicationVersion, steps, control, lock, queues };
  } catch (error) {
    // The lock connection is not closed here either: if it was taken, the lock belongs to
    // this process until it dies, whatever went wrong afterwards.
    await steps.end().catch(() => undefined);
    await control.end().catch(() => undefined);
    throw error;
  }
}

/**
 * Process-wide rather than per-worker because `DBOS.shutdown()` is static and carries no
 * re-entry guard of its own: a second delivery that reached it ends in node-pg's "Called end
 * on pool more than once" (round-3 finding 9).
 */
let shuttingDown = false;

/**
 * Deliberately not `async`. An `await`ed `DBOS.shutdown()` that rejects leaves an unhandled
 * rejection, which Sentry's default listener swallows — the process then sits out the whole
 * watchdog instead of exiting (round-3 finding 10). `.then()` with both arms explicit never
 * produces one.
 *
 * The lock connection is untouched here on purpose: the drain abandons unfinished workflows,
 * so step bodies of this process can still be writing, and process death is the only release
 * of the advisory lock that cannot let the next worker in underneath them.
 */
function handleSigterm(): void {
  if (shuttingDown) {
    console.info(SHUTDOWN_IGNORED_MARKER);
    return;
  }
  shuttingDown = true;

  // Armed before anything that could yield, so a `shutdown()` that never settles still ends
  // the process. `unref` so the watchdog is never itself a reason to stay up.
  setTimeout(() => process.exit(1), SHUTDOWN_WATCHDOG_MS).unref();

  console.info(SHUTDOWN_MARKER);
  DBOS.shutdown({ workflowCompletionTimeoutMS: DRAIN_TIMEOUT_MS }).then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(SHUTDOWN_FAILED_MARKER, error);
      process.exit(1);
    },
  );
}

function requireBuildSha(): string {
  const buildSha = process.env.HF_BUILD_SHA;
  if (buildSha === undefined || buildSha.length < MIN_BUILD_SHA_LENGTH) {
    throw new MissingBuildSha(buildSha);
  }
  return buildSha;
}
