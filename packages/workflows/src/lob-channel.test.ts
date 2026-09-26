import { createStepPool, type StepPool } from "@hyperfixation/db";
import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { actions, idempotencyKey } from "./actions.js";
import {
  lobChannel,
  renderLetter,
  LobLiveKeyRefused,
  LobRefused,
  type LobLetterRequest,
} from "./lob.js";
import type { StepContext } from "./step.js";

const BASE = "https://lob.test";
const API_KEY = "test_sk_0123456789abcdef";

const ADDRESS = {
  name: "Ada Lovelace",
  line1: "210 King St",
  city: "San Francisco",
  state: "CA",
  zip: "94107",
} as const;

const INJECTION = '<img src=x onerror="alert(1)">';

function letter(overrides: Partial<LobLetterRequest> = {}): LobLetterRequest {
  return {
    to: ADDRESS,
    from: { ...ADDRESS, name: "Demo Co" },
    subject: "A letter",
    body: "Hello.",
    ...overrides,
  };
}

interface Seen {
  idempotencyKey: string | null;
  authorization: string | null;
  body: { file: string; to: Record<string, string>; color: boolean };
}

let seen: Seen[] = [];

function letters(status = 200, json: Record<string, unknown> = { id: "ltr_1" }) {
  return http.post(`${BASE}/v1/letters`, async ({ request }) => {
    seen.push({
      idempotencyKey: request.headers.get("idempotency-key"),
      authorization: request.headers.get("authorization"),
      body: (await request.json()) as Seen["body"],
    });
    return HttpResponse.json(json, { status });
  });
}

const server = setupServer(letters());

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers(letters());
  seen = [];
});
afterAll(() => {
  server.close();
});

function channel(apiKey = API_KEY) {
  return lobChannel({ apiKey, baseUrl: BASE });
}

async function send(request: LobLetterRequest, key = "abc"): Promise<void> {
  await channel().send({ idempotencyKey: key, runId: "run-1", key: "letter", request });
}

describe("lobChannel", () => {
  it("posts the letter with Basic auth and declares it dedupes", async () => {
    expect(channel().dedupes).toBe(true);

    await send(letter());

    expect(seen).toHaveLength(1);
    expect(seen[0]!.authorization).toBe(
      `Basic ${Buffer.from(`${API_KEY}:`).toString("base64")}`,
    );
    expect(seen[0]!.body.to.address_line1).toBe("210 King St");
    expect(seen[0]!.body.color).toBe(false);
  });

  it("escapes a draft that carries markup instead of sending it as markup", async () => {
    await send(letter({ body: INJECTION, subject: INJECTION }));

    const { file } = seen[0]!.body;
    // The characters are all there; the tag and its attribute are not.
    expect(file).not.toContain("<img");
    expect(file).not.toContain('onerror="');
    expect(file).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("refuses a live key unless the channel was built for one", () => {
    expect(() => lobChannel({ apiKey: "live_sk_1", baseUrl: BASE })).toThrow(LobLiveKeyRefused);
    expect(() => lobChannel({ apiKey: "live_sk_1", baseUrl: BASE, live: true })).not.toThrow();
  });

  it("names the status on a 4xx and carries the key nowhere in the failure", async () => {
    const basic = `Basic ${Buffer.from(`${API_KEY}:`).toString("base64")}`;
    server.resetHandlers(
      letters(422, {
        error: { message: `address is undeliverable (sent ${API_KEY} as ${basic})` },
      }),
    );

    const error = await send(letter()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LobRefused);
    const refused = error as LobRefused;
    expect(refused.status).toBe(422);
    expect(refused.message).toContain("HTTP 422");
    expect(refused.message).toContain("address is undeliverable");
    // Neither the key nor the header it was encoded into survives the echo, anywhere on the error.
    const everything = JSON.stringify(refused, Object.getOwnPropertyNames(refused));
    expect(everything).not.toContain(API_KEY);
    expect(everything).not.toContain(basic);
    expect(everything).not.toContain(Buffer.from(`${API_KEY}:`).toString("base64"));
  });

  it("parses the request against the app's own schema before anything is sent", async () => {
    await expect(send({ ...letter(), to: { ...ADDRESS, zip: "nope" } })).rejects.toThrow();

    expect(seen).toHaveLength(0);
  });
});

describe("renderLetter", () => {
  it("makes one paragraph per blank-line-separated block", () => {
    const html = renderLetter(letter({ body: "One.\n\nTwo." }));

    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<p>One.</p><p>Two.</p>");
  });
});

describe("a letter performed as an action", () => {
  let database: TestDatabase;
  let steps: StepPool;

  beforeAll(async () => {
    database = await createTestDatabase();
    steps = createStepPool({ connectionString: database.applicationUrl });
  }, 60_000);

  afterAll(async () => {
    await steps?.end();
    await database?.drop();
  });

  async function context(runId: string, key: string): Promise<StepContext> {
    await asRole(database.applicationUrl, async (pg) => {
      await pg.query(
        "INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id) " +
          "VALUES ($1, 'test', '{}', 'running', 1, $1)",
        [runId],
      );
    });
    return { runId, attempt: 1, workflowId: runId, key, tx: (work) => steps.tx(runId, runId, work) };
  }

  it("sends the action's own idempotency key as the header and logs Lob's id", async () => {
    const runId = "lob-run-1";
    const ctx = await context(runId, "letter");

    const result = await actions.perform(ctx, {
      key: "letter",
      channel: channel(),
      request: letter(),
    });

    expect(seen[0]!.idempotencyKey).toBe(idempotencyKey(runId, "letter"));
    expect(result.externalId).toBe("ltr_1");
    const row = await asRole(database.applicationUrl, async (pg) => {
      const { rows } = await pg.query<{ status: string; idempotency_key: string }>(
        "SELECT status, idempotency_key FROM hf_action_log WHERE run_id = $1",
        [runId],
      );
      return rows[0]!;
    });
    expect(row).toEqual({ status: "ok", idempotency_key: seen[0]!.idempotencyKey });
  });
});
