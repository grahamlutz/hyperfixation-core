import type { StepPool } from "@hyperfixation/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlPool } from "./control-pool.js";
import {
  clearWorkerRuntime,
  setWorkerRuntime,
  WorkerNotStarted,
  workerRuntime,
  type WorkerRuntime,
} from "./worker-runtime.js";

/** Neither pool is opened: nothing here reads past `appName` and `applicationVersion`. */
const RUNTIME: WorkerRuntime = {
  appName: "demo",
  applicationVersion: "abc1234",
  steps: {} as StepPool,
  control: {} as ControlPool,
};

const VERSIONED_KEY = "@hyperfixation/workflows#workerRuntime.v1";
const UNVERSIONED_KEY = "@hyperfixation/workflows#workerRuntime";

function slotAt(key: string): { current?: WorkerRuntime } | undefined {
  const host = globalThis as unknown as Record<symbol, { current?: WorkerRuntime } | undefined>;
  return host[Symbol.for(key)];
}

describe("the worker runtime", () => {
  // The slot is the realm's, not this file's: a runtime left set is a started worker as far as
  // every later case and every later file in this vitest worker is concerned.
  afterEach(() => {
    clearWorkerRuntime();
    vi.resetModules();
  });

  it("refuses until a worker set one, naming the operation", () => {
    expect(() => workerRuntime("step(score)")).toThrow(WorkerNotStarted);
    expect(() => workerRuntime("step(score)")).toThrow(/step\(score\)/);
  });

  it("is one runtime across two copies of this module", async () => {
    const first = await import("./worker-runtime.js");
    first.setWorkerRuntime(RUNTIME);

    vi.resetModules();
    const second = await import("./worker-runtime.js");
    expect(second.setWorkerRuntime).not.toBe(first.setWorkerRuntime);

    // The hazard `define-flow.ts` would hit otherwise: it reads `workerRuntime()` and
    // `withRunContext()` on adjacent lines, and a per-module holder answers `WorkerNotStarted`
    // for a worker that started.
    expect(second.workerRuntime("flow score")).toBe(RUNTIME);
  });

  it("keys its slot by shape version, so another version of this package cannot read it", () => {
    setWorkerRuntime(RUNTIME);

    // The cheap shape guard the other two process globals do not need. `WorkerRuntime` is a
    // structural record read field by field, so a v2 of a different shape resolving this same
    // symbol would be a wrong answer; resolving its own gets it `WorkerNotStarted` instead.
    expect(slotAt(VERSIONED_KEY)?.current).toBe(RUNTIME);
    expect(slotAt(UNVERSIONED_KEY)).toBeUndefined();
  });
});
