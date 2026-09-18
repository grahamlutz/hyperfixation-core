import { spawn, type StdioOptions } from "node:child_process";

export class CommandFailed extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(command: string, exitCode: number | null, signal: NodeJS.Signals | null) {
    super(
      `${command} exited ${signal === null ? `with code ${String(exitCode)}` : `on ${signal}`}`,
    );
    this.name = "CommandFailed";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

/**
 * Runs a child to completion and throws on a non-zero exit.
 *
 * `stdio: "inherit"` by default: every command this spawns — the migrator, `turbo gen`, `next
 * dev` — is one whose output the user is meant to read, and buffering it would turn a prompt
 * into a hang. `SIGINT` is deliberately not forwarded; the child shares the terminal's process
 * group and gets it from the terminal at the same moment the CLI does.
 */
export async function run(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<void> {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
  });

  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    },
  );

  // A child killed by the terminal's own SIGINT is the user stopping `hf dev`, not a failure.
  if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") return;
  throw new CommandFailed([command, ...args].join(" "), code, signal);
}
