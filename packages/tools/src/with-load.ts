import { spawn } from "node:child_process";
import { startLoad } from "./load.js";

const USAGE = `Usage: pnpm load:run <workers> <seconds> -- <command> [args...]

Runs a command while <workers> processes each spin one core, for race probes that only fail
under CPU contention. The load stops when the command exits, when this process is signalled,
after <seconds> at the latest, and whenever this process dies for any reason — including
SIGKILL, which is what a torn-down agent session amounts to.

Use this instead of \`(while :; do :; done) &\` in a shell one-liner: \`kill $(jobs -p)\` finds
no jobs in a zsh command substitution, so the loops outlive the command that started them.`;

async function main(argv: readonly string[]): Promise<number> {
  const split = argv.indexOf("--");
  const [workersArg, secondsArg] = argv.slice(0, split === -1 ? 0 : split);
  const command = split === -1 ? [] : argv.slice(split + 1);
  const workers = Number(workersArg);
  const seconds = Number(secondsArg);
  if (
    command.length === 0 ||
    !Number.isInteger(workers) ||
    workers < 1 ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    console.error(USAGE);
    return 2;
  }

  const load = startLoad(workers, seconds);
  const [bin = "", ...args] = command;
  const child = spawn(bin, args, { stdio: "inherit" });

  const forward = (signal: NodeJS.Signals): void => {
    load.stop();
    child.kill(signal);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, forward);

  return new Promise((resolve) => {
    child.on("error", (error) => {
      console.error(`${bin}: ${error.message}`);
      load.stop();
      resolve(127);
    });
    child.on("close", (code, signal) => {
      load.stop();
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });
}

process.exitCode = await main(process.argv.slice(2));
