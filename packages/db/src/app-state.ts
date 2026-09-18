import type { ClientBase, Pool } from "pg";

/**
 * The pause flag, read the way the step gate reads it: `COALESCE` over a missing singleton, so
 * an app whose `hf_app_state` row has not been seeded is not paused rather than an error.
 */
export const APP_PAUSED_STATEMENT =
  "SELECT COALESCE((SELECT paused FROM hf_app_state WHERE id = 1), false) AS paused";

/** Written by `pause`/`resume` only, inside a control-plane transaction. */
export const SET_APP_PAUSED_STATEMENT =
  "UPDATE hf_app_state SET paused = $1, paused_by = $2 WHERE id = 1";

export class AppStateMissing extends Error {
  constructor(operation: string) {
    super(
      `AppStateMissing: ${operation} matched no hf_app_state row; the singleton is seeded by ` +
        "`hf bootstrap` and nothing else can pause an app that has never been bootstrapped",
    );
    this.name = "AppStateMissing";
  }
}

export async function appPaused(queryable: Pool | ClientBase): Promise<boolean> {
  const { rows } = await queryable.query<{ paused: boolean }>(APP_PAUSED_STATEMENT);
  return rows[0]!.paused;
}
