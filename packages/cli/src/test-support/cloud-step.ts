import type {
  CloudCommands,
  CloudStepContext,
  StepExec,
  StepExecOptions,
  StepExecOutcome,
  TemplateFetch,
} from "../cloud-steps/index.js";
import type { OperatorConfig } from "../config.js";
import type { Database } from "../database.js";
import { deriveNames, type AppNames } from "../names.js";
import type { FetchLike } from "../providers/http.js";
import type { AppStateStore } from "../state.js";

export interface ExecCall {
  command: string;
  args: readonly string[];
  options: StepExecOptions;
}

export interface RecordingExec {
  /** Every command a step ran, in order, with the environment it was given. */
  readonly calls: readonly ExecCall[];
  exec: StepExec;
}

/**
 * A `StepExec` that runs nothing and records what it was asked to run.
 *
 * `reply` answers the commands a step reads back — `git rev-parse HEAD` above all — and anything
 * it does not answer succeeds silently, which is what every other command does on a good run.
 */
export function createRecordingExec(
  reply: (call: ExecCall) => Partial<StepExecOutcome> | undefined = () => undefined,
): RecordingExec {
  const calls: ExecCall[] = [];
  return {
    get calls() {
      return calls;
    },
    exec: async (command, args, options) => {
      const call: ExecCall = { command, args: [...args], options };
      calls.push(call);
      return await Promise.resolve({ code: 0, stdout: "", stderr: "", ...reply(call) });
    },
  };
}

/** True when this call is `git <first argument>` — how a test asserts what a step ran. */
export function isGit(call: ExecCall, subcommand: string): boolean {
  return call.command === "git" && call.args[0] === subcommand;
}

export interface StepContextOptions {
  /** The app directory a step creates or adopts. */
  dir: string;
  state: AppStateStore;
  config?: OperatorConfig;
  names?: AppNames;
  exec?: StepExec;
  fetchTemplate?: TemplateFetch;
  fetch?: FetchLike;
  from?: string;
  email?: string;
  budgetUsd?: string;
  /** The box's cluster. Defaults to one that refuses, like `fetchTemplate` above. */
  database?: () => Promise<Database>;
  commands?: CloudCommands;
  /** The `deploy` step's clock; `sleep` defaults to returning at once, so a poll loop spins. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TestStepContext extends CloudStepContext {
  /** Everything the steps printed. */
  readonly lines: string[];
}

/** A `CloudStepContext` whose every side channel a test can read back. */
export function createStepContext(options: StepContextOptions): TestStepContext {
  const lines: string[] = [];
  return {
    state: options.state,
    rotated: false,
    names: options.names ?? deriveNames("demo-app"),
    dir: options.dir,
    config: options.config ?? {},
    io: { out: (line) => lines.push(line) },
    checklist: [],
    exec: options.exec ?? createRecordingExec().exec,
    from: options.from,
    fetchTemplate:
      options.fetchTemplate ??
      (() => Promise.reject(new Error("this test context fetches no template"))),
    fetch: options.fetch,
    env: {},
    email: options.email ?? "admin@example.com",
    budgetUsd: options.budgetUsd ?? "25",
    database:
      options.database ??
      (() => Promise.reject(new Error("this test context opens no database"))),
    commands: options.commands ?? refusingCommands,
    now: options.now ?? (() => Date.now()),
    sleep: options.sleep ?? (async () => await Promise.resolve()),
    lines,
  };
}

/** What a context that has no business running the app's own commands does when asked. */
const refusingCommands: CloudCommands = {
  migrate: () => Promise.reject(new Error("this test context runs no migrate")),
  bootstrap: () => Promise.reject(new Error("this test context runs no bootstrap")),
  statusToken: () => Promise.reject(new Error("this test context mints no status token")),
};
