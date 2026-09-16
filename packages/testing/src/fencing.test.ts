import { fileURLToPath } from "node:url";
import { ControlPlaneInWorkflow, UnfencedWrite } from "@hyperfixation/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { fencingFailureOf, FencingFailureInTest } from "./fencing.js";
import { assertNoFencingFailure, spawnWorker, type SpawnedWorker } from "./spawn-worker.js";

const FENCING_WORKER = fileURLToPath(new URL("./test-modules/fencing-worker.ts", import.meta.url));

const STATEMENT = "UPDATE hf_run SET version = 'escaped'";
const OPERATION = "records.archive";

describe("fencingFailureOf", () => {
  it("finds a refusal wrapped the way Drizzle wraps one", () => {
    const wrapped = new Error("Failed query", { cause: new UnfencedWrite(STATEMENT) });

    expect(fencingFailureOf(wrapped)).toEqual({
      name: "UnfencedWrite",
      detail: STATEMENT,
      message: new UnfencedWrite(STATEMENT).message,
    });
  });

  it("names the operation of a control-plane refusal", () => {
    expect(fencingFailureOf(new ControlPlaneInWorkflow(OPERATION))?.detail).toBe(OPERATION);
  });

  it("leaves every other error alone", () => {
    expect(fencingFailureOf(new Error("connection terminated"))).toBeUndefined();
  });
});

/**
 * The rule: a production refusal raised inside a worker fails the test that spawned it.
 * Nothing here detects an unfenced write — the step pool refuses it in production — so what
 * is under test is only that the refusal survives the process boundary intact.
 */
describe("a worker that hits the production refusals", () => {
  let database: TestDatabase;
  let worker: SpawnedWorker;

  beforeAll(async () => {
    database = await createTestDatabase();
    worker = spawnWorker({
      module: FENCING_WORKER,
      appName: database.appName,
      databaseUrl: database.applicationUrl,
      control: { statement: STATEMENT, operation: OPERATION },
    });
    await worker.ready();
  }, 180_000);

  afterAll(async () => {
    await worker?.kill();
    await database?.drop();
  });

  it("surfaces both refusals with the field that says what was refused", () => {
    expect(worker.fencingFailures()).toEqual([
      { name: "UnfencedWrite", detail: STATEMENT, message: expect.stringContaining(STATEMENT) },
      {
        name: "ControlPlaneInWorkflow",
        detail: OPERATION,
        message: expect.stringContaining(OPERATION),
      },
    ]);
  });

  it("fails the test even though the worker came up and never crashed", () => {
    expect(worker.exit()).toBeUndefined();

    let thrown: unknown;
    try {
      assertNoFencingFailure(worker);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(FencingFailureInTest);
    expect((thrown as Error).message).toContain(worker.version);
    expect((thrown as Error).message).toContain(STATEMENT);
    expect((thrown as Error).message).toContain(OPERATION);
  });
});
