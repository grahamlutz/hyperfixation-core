import { spawn, type ChildProcess } from "node:child_process";

/**
 * One core's worth of spin. It works in 25ms slices and yields between them so the IPC channel
 * is read: a bare `while (true)` never sees its parent die, which is how 24 shells came to burn
 * a core each for hours after their session ended. It leaves when the deadline passes or the
 * parent's end of the channel closes, whichever comes first, so no exit path of the parent
 * (including SIGKILL) can strand it.
 */
export const WORKER_SOURCE = `
const deadline = Date.now() + Number(process.env.HF_LOAD_SECONDS) * 1000;
process.on("disconnect", () => process.exit(0));
function spin() {
  if (!process.connected || Date.now() >= deadline) process.exit(0);
  const slice = Date.now() + 25;
  while (Date.now() < slice);
  setImmediate(spin);
}
spin();
`;

export interface Load {
  pids: readonly number[];
  stop(): void;
}

export function startLoad(workers: number, seconds: number): Load {
  const children: ChildProcess[] = [];
  for (let i = 0; i < workers; i++) {
    children.push(
      spawn(process.execPath, ["-e", WORKER_SOURCE], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, HF_LOAD_SECONDS: String(seconds) },
      }),
    );
  }
  return {
    pids: children.flatMap((child) => (child.pid === undefined ? [] : [child.pid])),
    stop() {
      for (const child of children) child.kill("SIGKILL");
    },
  };
}
