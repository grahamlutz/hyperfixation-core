import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import type { Flow } from "@hyperfixation/workflows";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { AppNotAttached, defineApp, NoApplicationVersion } from "./define-app.js";
import { DuplicateRegistration, InvalidDefinition, UnknownRegistration } from "./registry.js";
import { defineResolver, type ResolverDefinition } from "./resolvers.js";
import { defineSchedule } from "./schedules.js";
import { defineScorer, type ScorerDefinition } from "./scorers.js";
import { defineSource, type SourceDefinition } from "./sources.js";
import { defineSpec } from "./specs.js";

/** A flow's registration, without `defineFlow`'s DBOS registration behind it. */
function fakeFlow(name: string): Flow<never, unknown> {
  return { name, queue: "llm", workflow: () => Promise.resolve(undefined) };
}

interface Filing {
  readonly ein: string;
}

const SPEC = defineSpec({ name: "buy-box", version: 1, criteria: { minMargin: 0.2 } });

function fakeSource(name: string): SourceDefinition<Filing> {
  return defineSource({
    name,
    recordType: "business",
    fetch: async function* () {
      yield { externalId: "1", payload: { ein: "11-1111111" } };
    },
  });
}

function fakeResolver(name: string): ResolverDefinition<Filing> {
  return defineResolver({
    name,
    recordType: "business",
    exactKeys: ["ein"],
    fuzzy: { field: "normalized_name", threshold: 0.4 },
    create: () => Promise.resolve({ id: "1" }),
    update: () => Promise.resolve(),
  });
}

function fakeScorer(name: string): ScorerDefinition<Filing, { minMargin: number }> {
  return defineScorer({
    name,
    recordType: "business",
    spec: SPEC,
    score: () => Promise.resolve({ score: 0.5 }),
  });
}

const HANDLES = { pool: {} as Pool, client: {} as DBOSClient };

describe("defineApp", () => {
  it("registers everything it is given and refuses a duplicate name in any registry", () => {
    const app = defineApp({
      name: "demo",
      applicationVersion: "abc1234",
      flows: [fakeFlow("score")],
      sources: [fakeSource("ga-filings")],
      resolvers: [fakeResolver("business")],
      specs: [SPEC],
      scorers: [fakeScorer("buy-box")],
      approvalTypes: [{ name: "letter" }],
      channels: [{ name: "email", send: () => Promise.resolve({}) }],
      records: [{ table: "businesses", recordType: "business" }],
      pages: [{ path: "/w", title: "Home", nav: true }],
      schedules: [defineSchedule({ name: "nightly", flow: fakeFlow("score"), every: 60_000 })],
    });

    expect(app.flows.names()).toEqual(["score"]);
    expect(app.records.types.require("business").table).toBe("businesses");

    expect(() => app.flows.register(fakeFlow("score"))).toThrow(DuplicateRegistration);
    expect(() => app.sources.register(fakeSource("ga-filings"))).toThrow(DuplicateRegistration);
    expect(() => app.channels.register({ name: "email", send: () => Promise.resolve({}) })).toThrow(
      DuplicateRegistration,
    );
    expect(() => app.records.types.register({ table: "x", recordType: "business" })).toThrow(
      DuplicateRegistration,
    );
  });

  it("refuses a duplicate given twice at definition", () => {
    expect(() =>
      defineApp({ name: "demo", specs: [SPEC], scorers: [fakeScorer("s"), fakeScorer("s")] }),
    ).toThrow(DuplicateRegistration);
  });

  it("refuses a scorer whose spec this app never registered", () => {
    expect(() => defineApp({ name: "demo", scorers: [fakeScorer("buy-box")] })).toThrow(
      UnknownRegistration,
    );
    expect(() => defineApp({ name: "demo", scorers: [fakeScorer("buy-box")] })).toThrow(
      /no spec named "buy-box"/,
    );
  });

  it("refuses a schedule whose flow this app never registered", () => {
    const schedule = defineSchedule({ name: "nightly", flow: fakeFlow("score"), every: 60_000 });

    // At definition, not at the first firing: an unregistered flow has no queue on this worker.
    expect(() => defineApp({ name: "demo", schedules: [schedule] })).toThrow(UnknownRegistration);
    expect(() =>
      defineApp({ name: "demo", flows: [fakeFlow("score")], schedules: [schedule] }),
    ).not.toThrow();
  });

  it("refuses a fuzzy threshold outside (0, 1]", () => {
    for (const threshold of [0, 1.5, -0.2]) {
      expect(() =>
        defineResolver({
          name: "business",
          recordType: "business",
          exactKeys: ["ein"],
          fuzzy: { field: "normalized_name", threshold },
          create: () => Promise.resolve({ id: "1" }),
          update: () => Promise.resolve(),
        }),
      ).toThrow(InvalidDefinition);
    }
  });

  it("refuses a spec version that is not an integer of at least 1", () => {
    for (const version of [0, -1, 1.5]) {
      expect(() => defineSpec({ name: "buy-box", version, criteria: {} })).toThrow(
        InvalidDefinition,
      );
    }
  });

  it("refuses a schedule interval that is not positive", () => {
    expect(() =>
      defineSchedule({ name: "nightly", flow: fakeFlow("score"), every: 0 }),
    ).toThrow(InvalidDefinition);
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
