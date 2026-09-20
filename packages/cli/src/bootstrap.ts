import { bootstrapAdmin, BOOTSTRAP_EMAIL_ENV, type BootstrapResult } from "@hyperfixation/auth";
import { Pool } from "pg";
import { resolveApp, type ResolvedApp } from "./app.js";
import { MissingEnv, requireEnv } from "./require-env.js";

export interface BootstrapAppOptions {
  dir?: string;
  /** Overrides `HF_BOOTSTRAP_EMAIL`; one of the two has to be set. */
  email?: string;
  name?: string;
  /**
   * Overrides `HF_BOOTSTRAP_BUDGET_USD`; one of the two has to be set. Not part of
   * `REQUIRED_ENV` — like `HF_BOOTSTRAP_EMAIL`, it is a one-shot bootstrap input, not something
   * the deployed `web`/`worker`/`migrate` containers carry, so a flag is `.env.example`'s only
   * alternative for a local run.
   */
  budgetUsd?: string;
  /** Connection URLs in place of a `.env`; see `ResolveAppOptions`. */
  env?: Record<string, string>;
}

export interface BootstrapAppResult extends BootstrapResult {
  app: ResolvedApp;
}

const BOOTSTRAP_BUDGET_ENV = "HF_BOOTSTRAP_BUDGET_USD";

/**
 * `hf bootstrap` — the app's first admin, granted from the box and never from a request.
 *
 * It connects as the **application** role, not the migrator: the row it writes is an ordinary
 * `hf_user` row and the audit line an ordinary `hf_audit` row, and running the one grant that
 * has no admin behind it with owner privileges would be the only reason this command ever
 * needed them. `bootstrapAdmin` does the refusing; this only decides which address to offer it.
 *
 * It also seeds the `hf_app_state` singleton (`ON CONFLICT (id) DO NOTHING`), independently of
 * the admin grant: `AppStateMissing` documents this command as the only thing that seeds it, and
 * a redeploy that reruns `hf bootstrap` against an already-admin'd app must still be able to
 * seed it if it hasn't been yet — `budget_usd` has no default, so nothing else ever will.
 */
export async function bootstrapApp(
  options: BootstrapAppOptions = {},
): Promise<BootstrapAppResult> {
  const app = await resolveApp(options.dir, { env: options.env });
  const databaseUrl = requireEnv(app, "DATABASE_URL");
  const budgetUsd = options.budgetUsd ?? requireEnv(app, BOOTSTRAP_BUDGET_ENV);
  if (!Number.isFinite(Number(budgetUsd)) || Number(budgetUsd) <= 0) {
    throw new Error(`${BOOTSTRAP_BUDGET_ENV} must be a positive number, got ${budgetUsd}`);
  }

  const designated = app.env[BOOTSTRAP_EMAIL_ENV];
  const email = options.email ?? designated;
  if (email === undefined || email === "") {
    throw new MissingEnv([BOOTSTRAP_EMAIL_ENV], app.dir);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query(
      "INSERT INTO hf_app_state (id, budget_usd) VALUES (1, $1) ON CONFLICT (id) DO NOTHING",
      [budgetUsd],
    );
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
