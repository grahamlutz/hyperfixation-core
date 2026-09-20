import type { Step } from "../new-cloud.js";
import { provisionDatabase } from "../provision-database.js";
import type { CloudStepContext } from "./context.js";

/**
 * `hf_<app>`, its extensions and its three roles, immediately before `coolify`.
 *
 * Immediately before on purpose. This is the one step that rotates — a run with no password in the
 * state cache gives an existing role a new one — and a deployed app keeps the old password until
 * `coolify` PATCHes the environment and `deploy` restarts the containers. Everything fallible
 * therefore happens earlier, and `rotated` is what refuses to call a run that stopped in between
 * finished.
 */
export const databaseStep: Step<CloudStepContext> = {
  name: "database",
  run: async (context) => {
    const { names } = context;
    const result = await provisionDatabase(await context.database(), {
      app: names.given,
      state: context.state,
    });

    if (result.rotated) context.rotated = true;
    context.io.out(
      `${names.given}: ${result.createdDatabase ? "created" : "found"} ${result.databaseName}, ` +
        `roles ${result.roles.migrator}, ${result.roles.application}, ${result.roles.readonly}` +
        (result.rotated ? " (passwords rotated — Coolify and a redeploy follow)" : ""),
    );
  },
};
