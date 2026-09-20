import { requireOperatorConfig } from "../config.js";
import type { Step } from "../new-cloud.js";
import { CoolifyClient } from "../providers/coolify.js";
import type { CloudStepContext } from "./context.js";

/**
 * A daily dump of the app's database, and a checklist line about the one thing the API cannot
 * answer.
 *
 * Every other step detects its own previous work by name; this one cannot. Coolify documents the
 * backups list as "Content is very complex. Will be implemented later.", so there is no response
 * to read a schedule out of, and a POST is the only way to find out anything at all. So the step
 * registers the schedule and says out loud that a duplicate from an earlier run is possible —
 * being told to look is better than a silent second dump, and better than a step that never runs
 * because it cannot prove it is needed.
 *
 * The state record is written by the runner once this resolves, so a failed POST leaves the step
 * unrecorded and the next run registers it instead.
 */
export const backupStep: Step<CloudStepContext> = {
  name: "backup",
  run: async (context) => {
    const { names } = context;
    const required = requireOperatorConfig(
      context.config,
      ["HF_COOLIFY_URL", "HF_COOLIFY_TOKEN", "HF_COOLIFY_POSTGRES_UUID"],
      { env: context.env },
    );

    const coolify = new CoolifyClient({
      url: required.HF_COOLIFY_URL,
      token: required.HF_COOLIFY_TOKEN,
      fetch: context.fetch,
    });

    await coolify.createDatabaseBackup(required.HF_COOLIFY_POSTGRES_UUID, {
      frequency: "daily",
      enabled: true,
      // This app's database alone: `dump_all` would put every app on the cluster in one dump, and
      // E5 restores one database at a time.
      databases_to_backup: names.databaseName,
      dump_all: false,
      backup_now: false,
    });

    context.io.out(`${names.given}: registered a daily backup of ${names.databaseName}`);
    context.checklist.push(
      `check Coolify for an existing backup schedule for ${names.databaseName} — the API cannot ` +
        `list schedules, so an earlier run may have left a second one`,
    );
  },
};
