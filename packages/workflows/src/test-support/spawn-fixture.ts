import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FIXTURE_SHUTDOWN } from "./fixture-protocol.js";

const FIXTURE = fileURLToPath(new URL("./worker-fixture.ts", import.meta.url));
/** The fixture is TypeScript source, so it is run the way the tests around it are. */
const TSX = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));

export interface FixtureExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface FixtureOptions {
  appName: string;
  databaseUrl: string;
  buildSha: string;
  /** Overridden only to prove the guard; defaults to the one value that may launch DBOS. */
  hfProcess?: string;
}

export interface Fixture {
  readonly child: ChildProcessWithoutNullStreams;
  /** Everything the child has written to stdout and stderr so far, interleaved. */
  output(): string;
  /** Resolves when `line` has appeared in that output; rejects if the child exits first. */
  waitFor(line: string, timeoutMs?: number): Promise<void>;
  readonly exited: Promise<FixtureExit>;
  /** Asks for a clean `DBOS.shutdown()`; resolves with the exit. */
  shutdown(): Promise<FixtureExit>;
  /** `SIGKILL`, which is also how a worker's advisory lock is released in production. */
  kill(): Promise<FixtureExit>;
}

export function spawnFixture(options: FixtureOptions): Fixture {
  const child = spawn(TSX, [FIXTURE], {
    env: {
      ...process.env,
      HF_PROCESS: options.hfProcess ?? "worker",
      HF_BUILD_SHA: options.buildSha,
      HF_APP_NAME: options.appName,
      HF_DATABASE_URL: options.databaseUrl,
    },
  });

  let output = "";
  const waiting: { line: string; resolve: () => void; reject: (error: Error) => void }[] = [];

  const absorb = (chunk: Buffer): void => {
    output += chunk.toString();
    for (const waiter of [...waiting]) {
      if (!output.includes(waiter.line)) continue;
      waiting.splice(waiting.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);

  const exited = new Promise<FixtureExit>((resolve) => {
    child.on("exit", (code, signal) => {
      for (const waiter of waiting.splice(0)) {
        waiter.reject(new Error(`fixture exited before printing ${JSON.stringify(waiter.line)}`));
      }
      resolve({ code, signal });
    });
  });

  return {
    child,
    output: () => output,
    waitFor(line: string, timeoutMs = 120_000): Promise<void> {
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
          () => waiter.reject(new Error(`fixture never printed ${JSON.stringify(line)}`)),
          timeoutMs,
        );
        waiting.push(waiter);
      });
    },
    exited,
    shutdown(): Promise<FixtureExit> {
      child.stdin.write(`${FIXTURE_SHUTDOWN}\n`);
      return exited;
    },
    kill(): Promise<FixtureExit> {
      child.kill("SIGKILL");
      return exited;
    },
  };
}
