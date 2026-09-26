import { createStepPool, type StepPool } from "@hyperfixation/db";
import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import type { StepContext } from "@hyperfixation/workflows";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  fetch,
  fetchDomainOf,
  urlHash,
  DEFAULT_FETCH_MIN_INTERVAL_MS,
  FETCH_BODY_LIMIT_BYTES,
} from "./fetch.js";

/**
 * A host per case, because `hf_fetch_domain` is per host and one shared host would make the
 * interval a case writes visible to every case after it — which is an ordering dependency, and
 * `vitest --shuffle` runs in CI.
 */
const host = (name: string): string => `https://${name}.hf.test`;

/** Short enough to keep the suite quick, long enough that no scheduling jitter fakes it. */
const MIN_INTERVAL_MS = 400;

const server = setupServer();

let database: TestDatabase;
let pool: Pool;
let steps: StepPool;
/** Every request msw saw, in order, with the moment it arrived. */
let requests: { url: string; at: number }[];

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "error" });
  database = await createTestDatabase();
  pool = new Pool({ max: 4, connectionString: database.applicationUrl });
  steps = createStepPool({ connectionString: database.applicationUrl });
}, 120_000);

afterAll(async () => {
  server.close();
  await steps?.end();
  await pool?.end();
  await database?.drop();
});

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  server.resetHandlers();
});

/** Answers `url` with `body`, and records that it was asked. */
function serve(url: string, body: string, init?: ResponseInit): void {
  server.use(
    http.get(url, ({ request }) => {
      requests.push({ url: request.url, at: Date.now() });
      return HttpResponse.text(body, init);
    }),
  );
}

/** A step context under a named attempt, with the `hf_run` row its `ctx.tx` fence reads. */
async function context(runId: string, key = "fetch"): Promise<StepContext> {
  await asRole(database.applicationUrl, async (pg) => {
    await pg.query(
      "INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id) " +
        "VALUES ($1, 'test', '{}', 'running', 1, $1) ON CONFLICT (run_id) DO NOTHING",
      [runId],
    );
  });
  return { runId, attempt: 1, workflowId: runId, key, tx: (work) => steps.tx(runId, runId, work) };
}

async function rowOf(url: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await pool.query(
    "SELECT status, content_type, error, run_id, octet_length(body) AS bytes, " +
      "expires_at > now() AS fresh FROM hf_raw_fetch WHERE url_hash = $1",
    [urlHash(url)],
  );
  return rows[0];
}

describe("fetch.get", () => {
  it("answers a second call inside the TTL from the row, making no request", async () => {
    const url = `${host("ttl")}/cached.json`;
    serve(url, '{"ok":true}', { headers: { "content-type": "application/json" } });

    const first = await fetch.get(await context("fetch-ttl-1"), { url, minIntervalMs: 0 });
    const second = await fetch.get(await context("fetch-ttl-2"), { url, minIntervalMs: 0 });

    expect(requests).toHaveLength(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.body?.toString("utf8")).toBe('{"ok":true}');
    expect(second.contentType).toContain("application/json");
    // The cache is keyed by URL, not by run: the second run reads the first run's row.
    expect(await rowOf(url)).toMatchObject({ status: 200, run_id: "fetch-ttl-1", fresh: true });
  });

  it("refetches once the row has expired", async () => {
    const url = `${host("expiry")}/expiring.txt`;
    serve(url, "one");

    await fetch.get(await context("fetch-expiry"), { url, ttlMs: 1, minIntervalMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await fetch.get(await context("fetch-expiry"), {
      url,
      ttlMs: 60_000,
      minIntervalMs: 0,
    });

    expect(requests).toHaveLength(2);
    expect(again.cached).toBe(false);
  });

  it("spaces two concurrent misses on one host by the domain's interval", async () => {
    const options = { minIntervalMs: MIN_INTERVAL_MS, ttlMs: 60_000 };
    const a = `${host("race")}/a.txt`;
    const b = `${host("race")}/b.txt`;
    serve(a, "a");
    serve(b, "b");

    await Promise.all([
      fetch.get(await context("fetch-race-a"), { url: a, ...options }),
      fetch.get(await context("fetch-race-b"), { url: b, ...options }),
    ]);

    expect(requests).toHaveLength(2);
    // Postgres' clock and this process' are not the same clock, so the gap is asserted with a
    // tolerance rather than exactly; the point is that it is an interval, not a coincidence.
    expect(requests[1]!.at - requests[0]!.at).toBeGreaterThanOrEqual(MIN_INTERVAL_MS - 50);
  });

  it("enters an unknown host at one request a second", async () => {
    const url = `${host("default-interval")}/first.txt`;
    serve(url, "first");
    await fetch.get(await context("fetch-default"), { url });

    const { rows } = await pool.query<{ min_interval_ms: number }>(
      "SELECT min_interval_ms FROM hf_fetch_domain WHERE domain = $1",
      [fetchDomainOf(url)],
    );
    expect(rows[0]?.min_interval_ms).toBe(DEFAULT_FETCH_MIN_INTERVAL_MS);
  });

  it("refuses a body over the cap, and refuses it again from the error row", async () => {
    const url = `${host("huge")}/huge.bin`;
    serve(url, "x".repeat(6 * 1024 * 1024));

    await expect(
      fetch.get(await context("fetch-huge"), { url, minIntervalMs: 0 }),
    ).rejects.toMatchObject({
      name: "FetchTooLarge",
      limitBytes: FETCH_BODY_LIMIT_BYTES,
      // Declared, so nothing was transferred to find it out.
      bytes: 6 * 1024 * 1024,
    });
    // The refusal is a committed row: the status it refused is there, and the body is not.
    expect(await rowOf(url)).toMatchObject({ status: 200, bytes: null, fresh: true });

    await expect(
      fetch.get(await context("fetch-huge-2"), { url, minIntervalMs: 0 }),
    ).rejects.toMatchObject({ name: "FetchTooLarge" });
    expect(requests).toHaveLength(1);
  });

  it("refuses a chunked body that declares no length, mid-stream", async () => {
    const url = `${host("chunked")}/stream.bin`;
    const chunk = 512 * 1024;
    server.use(
      http.get(url, ({ request }) => {
        requests.push({ url: request.url, at: Date.now() });
        let sent = 0;
        return new HttpResponse(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent === 12) return void controller.close();
              sent += 1;
              controller.enqueue(new Uint8Array(chunk));
            },
          }),
        );
      }),
    );

    await expect(
      fetch.get(await context("fetch-chunked"), { url, minIntervalMs: 0 }),
    ).rejects.toMatchObject({
      name: "FetchTooLarge",
      // Abandoned on the first chunk past the cap rather than after all 6 MB arrived.
      bytes: FETCH_BODY_LIMIT_BYTES + chunk,
    });
    expect(await rowOf(url)).toMatchObject({ bytes: null, fresh: true });
  });
});

/**
 * What `collectDemoSource` will do once the template reads its fixture through `fetch.get`: two
 * collects, one request. The template's own `contract.test.ts` asserts it end to end; this is
 * the same assertion against the machinery, so a regression is caught before it ships.
 */
describe("a collector reading its source through fetch.get", () => {
  const url = `${host("collect")}/demoBusinesses.json`;
  const fixture = JSON.stringify([{ externalId: "1", payload: { normalized_name: "acme" } }]);

  const collect = async (runId: string): Promise<unknown> => {
    const row = await fetch.get(await context(runId, "load"), {
      url,
      ttlMs: 60_000,
      minIntervalMs: 0,
    });
    return JSON.parse(row.body!.toString("utf8"));
  };

  it("makes one request across two collects", async () => {
    serve(url, fixture);

    const first = await collect("collect-1");
    const second = await collect("collect-2");

    expect(second).toEqual(first);
    expect(requests).toHaveLength(1);
  });
});
