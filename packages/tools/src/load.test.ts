import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { startLoad, WORKER_SOURCE } from "./load.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number, withinMs: number): Promise<boolean> {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

describe("startLoad", () => {
  it("starts one process per worker and stop() ends them all", async () => {
    const load = startLoad(3, 60);
    expect(load.pids).toHaveLength(3);
    expect(load.pids.every(alive)).toBe(true);
    load.stop();
    expect(await Promise.all(load.pids.map((pid) => gone(pid, 3000)))).toEqual([true, true, true]);
  });

  it("leaves on its own at the deadline", async () => {
    const load = startLoad(1, 0.3);
    expect(await gone(load.pids[0]!, 5000)).toBe(true);
  });

  it("does not outlive a parent that is SIGKILLed", async () => {
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");
         const w = spawn(process.execPath, ["-e", ${JSON.stringify(WORKER_SOURCE)}], {
           stdio: ["ignore", "ignore", "ignore", "ipc"],
           env: { ...process.env, HF_LOAD_SECONDS: "600" },
         });
         console.log(w.pid);
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const worker = await new Promise<number>((resolve) =>
      parent.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim()))),
    );
    expect(alive(worker)).toBe(true);
    parent.kill("SIGKILL");
    expect(await gone(worker, 5000)).toBe(true);
  });
});
