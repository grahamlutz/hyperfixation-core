/**
 * The child half of the crash harness: what a worker entrypoint spawned by `spawnWorker()`
 * calls to speak the protocol. A real process is the only shape in which `startWorker()` can
 * be tested at all — DBOS refuses a second launch in one process — so every worker test runs
 * a module like this one.
 */
import { DBOS } from "@dbos-inc/dbos-sdk";
import { withClock, type TestClock } from "./clock.js";
import { fencingFailureOf } from "./fencing.js";
import {
  parkedMarker,
  WORKER_APP_NAME_ENV,
  WORKER_CLOCK,
  WORKER_CONTROL_ENV,
  WORKER_DATABASE_URL_ENV,
  WORKER_FAILED,
  WORKER_FENCING_FAILURE,
  WORKER_READY,
  WORKER_RELEASE,
  WORKER_SHUTDOWN,
  type KillAtControl,
  type KillAtMode,
  type WorkerControl,
} from "./worker-protocol.js";

export interface WorkerModuleContext<C extends WorkerControl> {
  appName: string;
  databaseUrl: string;
  control: C;
}

export interface WorkerModuleOptions<C extends WorkerControl> {
  /** Brings the worker up. Resolving prints the ready marker; throwing fails the worker. */
  start(context: WorkerModuleContext<C>): Promise<unknown>;
  /** Runs on a `shutdown` line on stdin; defaults to `DBOS.shutdown()`. */
  shutdown?(): Promise<void>;
}

/**
 * Prints the line `spawnWorker()` parses. A fencing refusal gets its own marker carrying the
 * statement or operation, so a test never has to read a stack trace to see that the step pool
 * or a control-plane helper refused something.
 */
export function reportWorkerFailure(error: unknown): void {
  const fencing = fencingFailureOf(error);
  if (fencing !== undefined) {
    console.error(`${WORKER_FENCING_FAILURE} ${JSON.stringify(fencing)}`);
    return;
  }
  const thrown = error as Error | undefined;
  console.error(`${WORKER_FAILED} ${thrown?.name ?? "Error"}: ${thrown?.message ?? String(error)}`);
}

export function workerControl<C extends WorkerControl = WorkerControl>(): C {
  const raw = process.env[WORKER_CONTROL_ENV];
  return (raw === undefined || raw === "" ? {} : JSON.parse(raw)) as C;
}

const parked = new Set<() => void>();

/** Real time until `control.clockAt` or a `clock <iso>` line pins it. */
let pinnedClock: TestClock | undefined;

/**
 * The clock a fixture hands to `createLlm({ clock })` inside the step. Live, so a `clock <iso>`
 * line sent while a call is parked at the provider moves the period the completion bills to.
 */
export function workerClock(): () => Date {
  return () => pinnedClock?.() ?? new Date();
}

/** Pins the worker's clock; throws on anything `Date.parse` refuses. */
export function setWorkerClock(at: string | Date): void {
  pinnedClock = withClock(at);
}

/**
 * The child half of `killAt`. A flow module calls this at each of the three points and the
 * call that matches the worker's `killAt` control prints the marker and then **stops** —
 * every mode is a park, never a timing guess, so the parent decides what happens next
 * (`killWhenParked()` for a crash, `release()` to carry on) with the worker demonstrably
 * still at that exact point.
 */
export async function parkFor(
  at: KillAtControl | undefined,
  mode: KillAtMode,
  key: string,
): Promise<void> {
  if (at === undefined || at.mode !== mode || at.key !== key) return;
  await new Promise<void>((resolve) => {
    parked.add(resolve);
    console.log(parkedMarker(at));
  });
}

/** Lets every parked `parkFor()` go; the `release` line on stdin calls this. */
export function releaseParked(): void {
  for (const resolve of [...parked]) {
    parked.delete(resolve);
    resolve();
  }
}

export async function runWorkerModule<C extends WorkerControl = WorkerControl>(
  options: WorkerModuleOptions<C>,
): Promise<void> {
  // No `unhandledRejection` listener is installed on purpose: whether one exists is itself
  // under test (redeploy case 11's Sentry half), and a listener here would change the answer.
  process.on("uncaughtException", (error) => {
    reportWorkerFailure(error);
    process.exit(1);
  });

  const control = workerControl<C>();
  if (control.drainMs !== undefined && control.drainMs > 0) delayDrain(control.drainMs);

  try {
    // Inside the try so an unparseable `clockAt` fails the worker with a marker rather than an
    // unhandled rejection the harness can only see as a timeout.
    if (control.clockAt !== undefined) setWorkerClock(control.clockAt);
    await options.start({
      appName: required(WORKER_APP_NAME_ENV),
      databaseUrl: required(WORKER_DATABASE_URL_ENV),
      control,
    });
  } catch (error) {
    reportWorkerFailure(error);
    // Writes to a pipe are synchronous on POSIX, so the line above is out before this lands.
    process.exit(1);
  }
  console.log(WORKER_READY);

  // A launched worker's dispatch loops hold the process open; stdin is how a test asks it to
  // stop without a signal. SIGTERM is `startWorker()`'s own to handle.
  process.stdin.setEncoding("utf8");
  // Line by line rather than per chunk: `clock <iso>` carries an argument, so a handler that
  // only asked whether a chunk contained a keyword could not read one.
  let pending = "";
  process.stdin.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) handleLine(line.trim(), options);
  });
}

function handleLine<C extends WorkerControl>(
  line: string,
  options: WorkerModuleOptions<C>,
): void {
  if (line === WORKER_RELEASE) {
    releaseParked();
    return;
  }
  if (line.startsWith(`${WORKER_CLOCK} `)) {
    try {
      setWorkerClock(line.slice(WORKER_CLOCK.length + 1));
    } catch (error) {
      reportWorkerFailure(error);
    }
    return;
  }
  if (line !== WORKER_SHUTDOWN) return;
  const shutdown = options.shutdown ?? (() => DBOS.shutdown());
  shutdown().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}

/**
 * Patches `DBOS.shutdown` rather than the stdin handler because the drain a test wants to
 * lengthen is usually the one `startWorker()`'s SIGTERM handler enters, which this module
 * never calls. The real shutdown still runs; only its entry is delayed.
 *
 * It reaches that handler because `@dbos-inc/dbos-sdk` is pinned to one exact version across
 * the workspace, so every package links the same copy and `DBOS` is one object in the child.
 */
function delayDrain(byMs: number): void {
  const shutdown = DBOS.shutdown.bind(DBOS);
  DBOS.shutdown = (options) =>
    new Promise<void>((resolve) => setTimeout(resolve, byMs)).then(() => shutdown(options));
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is unset`);
  return value;
}
