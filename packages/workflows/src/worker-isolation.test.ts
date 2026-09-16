import { DBOS } from "@dbos-inc/dbos-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { MissingBuildSha, NotAWorkerProcess, startWorker } from "./start-worker.js";

/**
 * The worker-isolation case: nothing but a process that says it is a worker may reach
 * `DBOS.launch()`. This file is one of the shapes the case names — a vitest import — and it
 * proves its own half by running at all.
 *
 * The `hf migrate` and `next build` halves need the CLI and the template, neither of which
 * exists yet; they land with those.
 */
describe("worker isolation", () => {
  const originalProcess = process.env.HF_PROCESS;
  const originalSha = process.env.HF_BUILD_SHA;

  afterEach(() => {
    restore("HF_PROCESS", originalProcess);
    restore("HF_BUILD_SHA", originalSha);
  });

  it("is not itself a worker process", () => {
    expect(process.env.HF_PROCESS).not.toBe("worker");
  });

  it("leaves DBOS unlaunched after importing the package", async () => {
    await import("./index.js");

    expect(DBOS.isInitialized()).toBe(false);
  });

  it("refuses startWorker before any boot check, pool or connection", async () => {
    // The url is unroutable on purpose: reaching a boot check would fail as a connection
    // error, so `NotAWorkerProcess` is evidence that nothing was attempted.
    const started = startWorker({
      appName: "unreachable",
      databaseUrl: "postgresql://nobody@203.0.113.1:1/nowhere",
    });

    await expect(started).rejects.toBeInstanceOf(NotAWorkerProcess);
    expect(DBOS.isInitialized()).toBe(false);
  });

  it("refuses a process that claims some other shape", async () => {
    process.env.HF_PROCESS = "web";

    await expect(
      startWorker({ appName: "web", databaseUrl: "postgresql://nobody@203.0.113.1:1/nowhere" }),
    ).rejects.toBeInstanceOf(NotAWorkerProcess);
  });

  it("refuses a worker whose build sha is missing or too short", async () => {
    process.env.HF_PROCESS = "worker";
    const options = {
      appName: "worker",
      databaseUrl: "postgresql://nobody@203.0.113.1:1/nowhere",
    };

    delete process.env.HF_BUILD_SHA;
    await expect(startWorker(options)).rejects.toBeInstanceOf(MissingBuildSha);

    process.env.HF_BUILD_SHA = "abc123";
    await expect(startWorker(options)).rejects.toBeInstanceOf(MissingBuildSha);

    expect(DBOS.isInitialized()).toBe(false);
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
