import { DBOS, type WorkflowQueue } from "@dbos-inc/dbos-sdk";
import { createStepPool, runBootChecks, type RecordTable, type StepPool } from "@hyperfixation/db";
import { createControlPool, type ControlPool } from "./control-pool.js";
import { acquireWorkerLock, type WorkerLock } from "./worker-lock.js";

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

function requireBuildSha(): string {
  const buildSha = process.env.HF_BUILD_SHA;
  if (buildSha === undefined || buildSha.length < MIN_BUILD_SHA_LENGTH) {
    throw new MissingBuildSha(buildSha);
  }
  return buildSha;
}
