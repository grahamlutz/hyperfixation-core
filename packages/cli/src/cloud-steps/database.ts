import type { CloudContext, Step } from "../new-cloud.js";
import { provisionDatabase } from "../provision-database.js";

/**
 * Step 8: `hf_<app>`, its extensions and its three roles, immediately before `coolify`.
 *
 * Immediately before on purpose. This is the one step that rotates — a run with no password in
 * the state cache gives an existing role a new one — and a deployed app keeps the old password
 * until `coolify` PATCHes the environment and `deploy` restarts the containers. Everything
 * fallible therefore happens earlier, and `rotated` is what refuses to call a run that stopped in
 * between finished.
 */
export function databaseStep(): Step {
  return {
    name: "database",
    run: async (context: CloudContext) => {
      const result = await provisionDatabase(await context.database(), {
        app: context.name,
        state: context.state,
      });

      if (result.rotated) context.rotated = true;
      context.io.out(
        `database: ${result.createdDatabase ? "created" : "found"} ${result.databaseName}, ` +
          `roles ${result.roles.migrator}, ${result.roles.application}, ${result.roles.readonly}` +
          (result.rotated ? " (passwords rotated — Coolify and a redeploy follow)" : ""),
      );
    },
  };
}
