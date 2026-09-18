import { randomBytes } from "node:crypto";
import { hashStatusToken } from "@hyperfixation/core";
import { AppStateMissing } from "@hyperfixation/db";
import { Pool, type PoolClient } from "pg";
import { resolveApp, type ResolvedApp } from "./app.js";
import { requireEnv } from "./require-env.js";

export type StatusTokenKind = "read" | "write";

const COLUMN: Record<StatusTokenKind, "read_token_hash" | "write_token_hash"> = {
  read: "read_token_hash",
  write: "write_token_hash",
};

const SELECT_HASHES_STATEMENT =
  "SELECT read_token_hash, write_token_hash FROM hf_app_state WHERE id = 1 FOR UPDATE";

const AUDIT_STATEMENT =
  "INSERT INTO hf_audit (actor_id, action, target_type, target_id, meta) " +
  "VALUES (NULL, 'app.status_token_provisioned', 'hf_app_state', '1', $1::jsonb)";

/** One column already carries a hash and `--rotate` was not passed to authorize replacing it. */
export class StatusTokenAlreadySet extends Error {
  readonly kind: StatusTokenKind;

  constructor(kind: StatusTokenKind) {
    super(`the ${kind} token is already set; pass --rotate to replace it`);
    this.name = "StatusTokenAlreadySet";
    this.kind = kind;
  }
}

export interface StatusTokenAppOptions {
  dir?: string;
  /** Which token(s) to (re)generate. Both when omitted. */
  kinds?: readonly StatusTokenKind[];
  /** Overwrites a hash that is already set; otherwise a set column is refused. */
  rotate?: boolean;
  /**
   * True when `kinds` was narrowed by an explicit `--read`/`--write`, rather than defaulted to
   * both. An explicit ask for a kind that is already set is refused the same as before, since
   * the operator named it on purpose; the *default* two-kind run instead skips whichever kind
   * is already set and only fills the gap — otherwise "run it to provision the token nobody set
   * up yet" would also require `--rotate`, and `--rotate` would take out the other, live token.
   */
  explicit?: boolean;
}

export interface StatusTokenAppResult {
  app: ResolvedApp;
  /** The plaintext of each token generated this run — the only time it is ever available. */
  tokens: Partial<Record<StatusTokenKind, string>>;
}

/**
 * `hf status-token` — provisions `hf_app_state.read_token_hash`/`write_token_hash`, the two
 * secrets `/api/status` is authorized against (`statusTokenMatches` in `@hyperfixation/core`
 * refuses every request when a hash is unset, so an app cannot serve status until this has run
 * at least once).
 *
 * Connects as the **application** role, like `hf bootstrap`: this only ever updates the
 * singleton row an app already owns, never anything a migrator-level grant is needed for.
 *
 * Read and write tokens are independent secrets — the write token is strictly the more
 * privileged of the two (`createStatusHandler` accepts it on `GET` as well), so rotating one
 * does not have to rotate the other. Each plaintext token is printed exactly once, by the
 * caller; nothing here ever stores or logs it.
 */
export async function statusTokenApp(
  options: StatusTokenAppOptions = {},
): Promise<StatusTokenAppResult> {
  const app = await resolveApp(options.dir);
  const databaseUrl = requireEnv(app, "DATABASE_URL");
  const kinds = options.kinds ?? (["read", "write"] as const);

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const tokens = await rotateTokens(
        client,
        kinds,
        options.rotate ?? false,
        options.explicit ?? false,
      );
      await client.query("COMMIT");
      return { app, tokens };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function rotateTokens(
  client: PoolClient,
  kinds: readonly StatusTokenKind[],
  allowRotate: boolean,
  explicit: boolean,
): Promise<Partial<Record<StatusTokenKind, string>>> {
  const { rows } = await client.query<{
    read_token_hash: string | null;
    write_token_hash: string | null;
  }>(SELECT_HASHES_STATEMENT);
  const existing = rows[0];
  if (existing === undefined) throw new AppStateMissing("hf status-token");

  const toGenerate: StatusTokenKind[] = [];
  for (const kind of kinds) {
    const alreadySet = existing[COLUMN[kind]] !== null;
    if (!alreadySet || allowRotate) {
      toGenerate.push(kind);
    } else if (explicit) {
      throw new StatusTokenAlreadySet(kind);
    }
    // Default two-kind run, already set, no --rotate: silently left alone.
  }

  const tokens: Partial<Record<StatusTokenKind, string>> = {};
  for (const kind of toGenerate) {
    const token = randomBytes(32).toString("base64url");
    tokens[kind] = token;
    await client.query(`UPDATE hf_app_state SET ${COLUMN[kind]} = $1 WHERE id = 1`, [
      hashStatusToken(token),
    ]);
  }

  if (toGenerate.length > 0) {
    await client.query(AUDIT_STATEMENT, [JSON.stringify({ kinds: toGenerate })]);
  }
  return tokens;
}
