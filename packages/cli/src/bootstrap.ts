import { bootstrapAdmin, BOOTSTRAP_EMAIL_ENV, type BootstrapResult } from "@hyperfixation/auth";
import { Pool } from "pg";
import { resolveApp, type ResolvedApp } from "./app.js";
import { MissingEnv, requireEnv } from "./require-env.js";

export interface BootstrapAppOptions {
  dir?: string;
  /** Overrides `HF_BOOTSTRAP_EMAIL`; one of the two has to be set. */
  email?: string;
  name?: string;
}

export interface BootstrapAppResult extends BootstrapResult {
  app: ResolvedApp;
}

/**
 * `hf bootstrap` — the app's first admin, granted from the box and never from a request.
 *
 * It connects as the **application** role, not the migrator: the row it writes is an ordinary
 * `hf_user` row and the audit line an ordinary `hf_audit` row, and running the one grant that
 * has no admin behind it with owner privileges would be the only reason this command ever
 * needed them. `bootstrapAdmin` does the refusing; this only decides which address to offer it.
 */
export async function bootstrapApp(
  options: BootstrapAppOptions = {},
): Promise<BootstrapAppResult> {
  const app = await resolveApp(options.dir);
  const databaseUrl = requireEnv(app, "DATABASE_URL");

  const designated = app.env[BOOTSTRAP_EMAIL_ENV];
  const email = options.email ?? designated;
  if (email === undefined || email === "") {
    throw new MissingEnv([BOOTSTRAP_EMAIL_ENV], app.dir);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await bootstrapAdmin(pool, {
      email,
      name: options.name,
      // Explicitly, and from the app's `.env` rather than this process's environment: a
      // designation the deploy made is the app's, and `--email` on its own must not become one
      // — that would turn the first-user branch's refusal into a promotion of whoever was typed.
      designatedEmail: designated === undefined || designated === "" ? null : designated,
    });
    return { ...result, app };
  } finally {
    await pool.end();
  }
}
