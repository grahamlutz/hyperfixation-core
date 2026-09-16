import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { testBuildSha } from "./build-sha.js";
import { FencingFailureInTest, type FencingFailure } from "./fencing.js";
import {
  WORKER_APP_NAME_ENV,
  WORKER_CONTROL_ENV,
  WORKER_DATABASE_URL_ENV,
  WORKER_FAILED,
  WORKER_FENCING_FAILURE,
  WORKER_READY,
  WORKER_RELEASE,
  WORKER_SHUTDOWN,
  type WorkerControl,
} from "./worker-protocol.js";

/**
 * TypeScript worker modules are run the way the tests around them are. The loader is applied
 * with `--import` rather than by running tsx's CLI, which forks the script into a grandchild:
 * `SIGKILL` cannot be forwarded, so killing the CLI would leave the worker alive holding the
 * advisory lock — and `kill()` modelling process death is the whole point of the harness.
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const TYPESCRIPT = /\.[cm]?tsx?$/;

export const DEFAULT_READY_TIMEOUT_MS = 120_000;

export interface SpawnWorkerOptions {
  /**
   * Path to the worker entrypoint, which must call `runWorkerModule()` from
   * `@hyperfixation/testing/worker`. `.ts` is run through tsx, anything else through node.
   * Two tests spawning two modules is how "worker A on v1, worker B on v2" is arranged.
   */
  module: string;
  appName: string;
  databaseUrl: string;
  /** `HF_BUILD_SHA`; a fresh `test-<uuid>` by default, so no two workers share a version. */
  version?: string;
  /** See `WorkerControl.drainMs`. */
  drainMs?: number;
  /** Knobs the module reads back with `workerControl()`; `drainMs` is merged in. */
  control?: WorkerControl;
}

export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SpawnedWorker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly module: string;
  readonly version: string;
  /** Everything the worker has written to stdout and stderr so far, interleaved. */
  output(): string;
  /** Resolves when `line` appears in that output; rejects if the worker fails or exits first. */
  waitFor(line: string, timeoutMs?: number): Promise<void>;
  /** Resolves when the worker printed its ready marker. */
  ready(timeoutMs?: number): Promise<void>;
  /** `performance.now()` when the ready marker appeared; `undefined` until it does. */
  readyAt(): number | undefined;
  /** Every fencing refusal the worker reported, in the order it reported them. */
  fencingFailures(): readonly FencingFailure[];
  /** The exit, once there is one; `undefined` while the worker is still up. */
  exit(): WorkerExit | undefined;
  readonly exited: Promise<WorkerExit>;
  /** Writes one line to the worker's stdin. */
  send(line: string): void;
  /** Lets a worker parked by `parkFor()` carry on from where it stopped. */
  release(): void;
  /** Asks for a clean shutdown over stdin; resolves with the exit. */
  shutdown(): Promise<WorkerExit>;
  /** `SIGKILL`, which is also how a worker's advisory lock is released in production. */
  kill(): Promise<WorkerExit>;
}

/**
 * Runs a worker entrypoint as a child process and gives a test the handles to drive it:
 * its interleaved log, its ready state, stdin, a kill, and its exit.
 */
export function spawnWorker(options: SpawnWorkerOptions): SpawnedWorker {
  const version = options.version ?? testBuildSha();
  const control: WorkerControl = { ...options.control };
  if (options.drainMs !== undefined) control.drainMs = options.drainMs;

  const args = TYPESCRIPT.test(options.module)
    ? ["--import", TSX_LOADER, options.module]
    : [options.module];
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      // `WORKER_PROCESS` in `@hyperfixation/workflows`, which this package cannot import:
      // its tests depend on this harness, so the dependency only runs the other way.
      HF_PROCESS: "worker",
      HF_BUILD_SHA: version,
      [WORKER_APP_NAME_ENV]: options.appName,
      [WORKER_DATABASE_URL_ENV]: options.databaseUrl,
      [WORKER_CONTROL_ENV]: JSON.stringify(control),
    },
  });

  let output = "";
  let pending = "";
  let readyAt: number | undefined;
  let exit: WorkerExit | undefined;
  const fencingFailures: FencingFailure[] = [];
  const waiting: { line: string; resolve: () => void; reject: (error: Error) => void }[] = [];

  const resolveMatched = (): void => {
    for (const waiter of [...waiting]) {
      if (!output.includes(waiter.line)) continue;
      waiting.splice(waiting.indexOf(waiter), 1);
      waiter.resolve();
    }
  };

  const rejectAll = (why: string): void => {
    for (const waiter of waiting.splice(0)) {
      waiter.reject(new Error(`worker ${why} before printing ${JSON.stringify(waiter.line)}`));
    }
  };

  const absorbLine = (line: string): void => {
    if (line.includes(WORKER_READY) && readyAt === undefined) readyAt = performance.now();
    const marked = line.indexOf(WORKER_FENCING_FAILURE);
    if (marked >= 0) {
      fencingFailures.push(
        JSON.parse(line.slice(marked + WORKER_FENCING_FAILURE.length)) as FencingFailure,
      );
    }
  };

  const absorb = (chunk: Buffer): void => {
    const text = chunk.toString();
    output += text;
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) absorbLine(line);
    resolveMatched();
    // `WORKER_FAILED` is terminal, so every waiter left is already lost; rejecting here is
    // what turns "the test timed out" into "the worker said why". A fencing marker is not
    // terminal — the worker reporting one usually carries on — so it only fails the test
    // through `assertNoFencingFailure`.
    if (text.includes(WORKER_FAILED)) rejectAll("failed");
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);

  child.on("exit", (code, signal) => {
    exit = { code, signal };
  });

  // `close`, not `exit`: the pipes are still being drained when a process dies, so a test
  // that reads `output()` after `exited` would otherwise race the worker's last lines.
  const exited = new Promise<WorkerExit>((resolve) => {
    child.on("close", (code, signal) => {
      if (pending !== "") {
        absorbLine(pending);
        pending = "";
      }
      exit ??= { code, signal };
      rejectAll("exited");
      resolve(exit);
    });
  });

  const waitFor = (line: string, timeoutMs = DEFAULT_READY_TIMEOUT_MS): Promise<void> => {
    if (output.includes(line)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const settle = (): void => {
        clearTimeout(timer);
        const index = waiting.indexOf(waiter);
        if (index >= 0) waiting.splice(index, 1);
      };
      const waiter = {
        line,
        resolve: () => {
          settle();
          resolve();
        },
        reject: (error: Error) => {
          settle();
          reject(new Error(`${error.message}\n${output}`));
        },
      };
      const timer = setTimeout(
        () => waiter.reject(new Error(`worker never printed ${JSON.stringify(line)}`)),
        timeoutMs,
      );
      waiting.push(waiter);
    });
  };

  const send = (line: string): void => {
    child.stdin.write(`${line}\n`);
  };

  return {
    child,
    module: options.module,
    version,
    output: () => output,
    waitFor,
    ready: (timeoutMs?: number) => waitFor(WORKER_READY, timeoutMs),
    readyAt: () => readyAt,
    fencingFailures: () => fencingFailures,
    exit: () => exit,
    exited,
    send,
    release(): void {
      send(WORKER_RELEASE);
    },
    shutdown(): Promise<WorkerExit> {
      send(WORKER_SHUTDOWN);
      return exited;
    },
    kill(): Promise<WorkerExit> {
      child.kill("SIGKILL");
      return exited;
    },
  };
}

/**
 * Turns the marker a worker printed back into a thrown error. The refusal is the worker's —
 * this package detects nothing — so what a test gets is the production message, attributed to
 * the module that raised it.
 */
export function assertNoFencingFailure(worker: SpawnedWorker): void {
  const failures = worker.fencingFailures();
  if (failures.length === 0) return;
  throw new FencingFailureInTest(`worker ${worker.version} (${worker.module})`, failures);
}
