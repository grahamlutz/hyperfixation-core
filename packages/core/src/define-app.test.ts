import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import type { Flow } from "@hyperfixation/workflows";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { AppNotAttached, defineApp, NoApplicationVersion } from "./define-app.js";
import { DuplicateRegistration, UnknownRegistration } from "./registry.js";

/** A flow's registration, without `defineFlow`'s DBOS registration behind it. */
function fakeFlow(name: string): Flow<never, unknown> {
  return { name, queue: "llm", workflow: () => Promise.resolve(undefined) };
}

const HANDLES = { pool: {} as Pool, client: {} as DBOSClient };

describe("defineApp", () => {
  it("registers everything it is given and refuses a duplicate name in any registry", () => {
    const app = defineApp({
      name: "demo",
      applicationVersion: "abc1234",
      flows: [fakeFlow("score")],
      sources: [{ name: "ga-filings" }],
      resolvers: [{ name: "business" }],
      scorers: [{ name: "buy-box" }],
      approvalTypes: [{ name: "letter" }],
      channels: [{ name: "email", send: () => Promise.resolve({}) }],
      records: [{ table: "businesses", recordType: "business" }],
    });

    expect(app.flows.names()).toEqual(["score"]);
    expect(app.records.types.require("business").table).toBe("businesses");

    expect(() => app.flows.register(fakeFlow("score"))).toThrow(DuplicateRegistration);
    expect(() => app.sources.register({ name: "ga-filings" })).toThrow(DuplicateRegistration);
    expect(() => app.channels.register({ name: "email", send: () => Promise.resolve({}) })).toThrow(
      DuplicateRegistration,
    );
    expect(() => app.records.types.register({ table: "x", recordType: "business" })).toThrow(
      DuplicateRegistration,
    );
  });

  it("refuses a duplicate given twice at definition", () => {
    expect(() => defineApp({ name: "demo", scorers: [{ name: "s" }, { name: "s" }] })).toThrow(
      DuplicateRegistration,
    );
  });

  it("refuses every control-plane operation until it has the handles", async () => {
    const app = defineApp({ name: "demo", applicationVersion: "abc1234" });

    expect(() => app.controlPlane()).toThrow(AppNotAttached);
    await expect(app.pause()).rejects.toBeInstanceOf(AppNotAttached);
    await expect(app.resume()).rejects.toBeInstanceOf(AppNotAttached);
    await expect(app.reconcile()).rejects.toBeInstanceOf(AppNotAttached);
    await expect(app.status()).rejects.toBeInstanceOf(AppNotAttached);
    await expect(app.records.archive({ recordType: "business", recordId: "1" })).rejects.toBeInstanceOf(
      AppNotAttached,
    );
    await expect(
      app.approvals.decide({ ids: [1], decision: "approved", via: "web", decisionKey: "k" }),
    ).rejects.toBeInstanceOf(AppNotAttached);

    app.attach(HANDLES);
    expect(app.controlPlane()).toBe(HANDLES);

    app.detach();
    expect(() => app.controlPlane()).toThrow(AppNotAttached);
  });

  it("names the operation that had no control plane", () => {
    const app = defineApp({ name: "demo" });
    expect(() => app.controlPlane("records.archive")).toThrow(/records\.archive/);
  });

  it("refuses to start a flow this app never registered", async () => {
    const app = defineApp({ name: "demo", applicationVersion: "abc1234" });
    app.attach(HANDLES);

    // Nothing reaches the pool: the registry is the only source of a queue name for the bump
    // path, so a run started on an unregistered flow would strand at its first re-attempt.
    const unregistered = fakeFlow("unregistered") as Flow<undefined, unknown>;
    await expect(app.runs.start(unregistered, undefined)).rejects.toBeInstanceOf(
      UnknownRegistration,
    );
  });

  it("takes its version from HF_BUILD_SHA and refuses what needs one without it", async () => {
    const sha = process.env.HF_BUILD_SHA;
    process.env.HF_BUILD_SHA = "deadbee";
    try {
      expect(defineApp({ name: "demo" }).applicationVersion).toBe("deadbee");
    } finally {
      if (sha === undefined) delete process.env.HF_BUILD_SHA;
      else process.env.HF_BUILD_SHA = sha;
    }

    delete process.env.HF_BUILD_SHA;
    const app = defineApp({ name: "demo" });
    app.attach(HANDLES);
    try {
      expect(app.applicationVersion).toBeUndefined();
      await expect(app.reconcile()).rejects.toBeInstanceOf(NoApplicationVersion);
      await expect(app.resume()).rejects.toBeInstanceOf(NoApplicationVersion);
    } finally {
      if (sha !== undefined) process.env.HF_BUILD_SHA = sha;
    }
  });
});
