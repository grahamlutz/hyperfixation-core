import { requireOperatorConfig } from "../config.js";
import type { Step } from "../new-cloud.js";
import { CoolifyClient, type CoolifyS3Storage } from "../providers/coolify.js";
import { ProviderError } from "../providers/http.js";
import type { CloudStepContext } from "./context.js";

/**
 * A daily dump of the app's database, off the box.
 *
 * Coolify accepts `save_s3: true` with no `s3_storage_uuid`, runs the backup, logs `S3 storage
 * configuration is missing or has been deleted (S3 storage ID: null). S3 backup has been disabled`
 * and keeps the only copy on the same disk as the database — which is not a backup. So the storage
 * is resolved first: `HF_COOLIFY_S3_STORAGE_UUID`, or the one usable storage on the box when there
 * is exactly one. None or several and the step does not guess: it registers the schedule
 * `save_s3: false` and says so in a warning and the closing checklist, because a schedule that is
 * honestly local-only beats one that looks remote in the UI and is not.
 *
 * A rerun reconciles rather than duplicates: the schedules are listed and the one for this app's
 * database is PATCHed. Coolify documents that list as "Content is very complex. Will be implemented
 * later.", so the response is narrowed by hand and anything unreadable falls back to the old
 * behaviour — register, and say out loud that a duplicate is possible.
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

    const storage = await resolveStorage(context, coolify);
    const schedule = {
      frequency: "daily",
      enabled: true,
      // This app's database alone: `dump_all` would put every app on the cluster in one dump, and
      // E5 restores one database at a time.
      databases_to_backup: names.databaseName,
      dump_all: false,
      ...(storage === undefined
        ? { save_s3: false }
        : { save_s3: true, s3_storage_uuid: storage }),
    };
    const where = storage === undefined ? "on the box only" : "to S3";

    const database = required.HF_COOLIFY_POSTGRES_UUID;
    const existing = await existingSchedule(coolify, database, names.databaseName);
    if (typeof existing === "object") {
      await coolify.updateDatabaseBackup(database, existing.uuid, schedule);
      context.io.out(
        `${names.given}: updated the daily backup of ${names.databaseName} ${where}, ` +
          `the schedule an earlier run registered`,
      );
      return;
    }

    await coolify.createDatabaseBackup(database, { ...schedule, backup_now: false });
    context.io.out(`${names.given}: registered a daily backup of ${names.databaseName} ${where}`);
    if (existing === "unreadable") {
      context.checklist.push(
        `check Coolify for a second backup schedule for ${names.databaseName} — its backups list ` +
          `could not be read, so an earlier run may have left one`,
      );
    }
  },
};

/**
 * The S3 storage the dump goes to, or `undefined` with the reason said out loud.
 *
 * The config key wins outright and is not checked against the list: an operator who named a uuid
 * has answered the question, and a `GET` that disagrees would only be a second opinion about a
 * storage Coolify itself will validate.
 */
async function resolveStorage(
  context: CloudStepContext,
  coolify: CoolifyClient,
): Promise<string | undefined> {
  const configured = context.config.HF_COOLIFY_S3_STORAGE_UUID;
  if (configured !== undefined && configured !== "") return configured;

  const usable = (await coolify.listS3Storages()).filter((storage) => storage.is_usable === true);
  if (usable.length === 1) return usable[0]!.uuid;

  const note = localOnlyNote(context.names.databaseName, usable);
  context.io.out(`WARNING: ${context.names.given}: ${note}`);
  context.checklist.push(note);
  return undefined;
}

/** What is left to the operator when the step will not pick a storage for them. */
function localOnlyNote(databaseName: string, usable: readonly CoolifyS3Storage[]): string {
  const problem =
    usable.length === 0
      ? "Coolify has no usable S3 storage"
      : `Coolify has ${String(usable.length)} usable S3 storages (${usable
          .map((storage) => `${storage.name} (${storage.uuid})`)
          .join(", ")}) and hf will not choose between them`;
  return (
    `${databaseName}'s daily backup is local-only — every copy sits on the same box as the ` +
    `database, so losing the box loses the data. ${problem}. Set HF_COOLIFY_S3_STORAGE_UUID to ` +
    `the storage to upload to (Coolify → Storages → the S3 storage → uuid in the URL), adding ` +
    `one there first if there is none, and re-run hf new.`
  );
}

/**
 * This app's existing schedule, `"none"` for a list that has none, and `"unreadable"` for a list
 * this cannot narrow — a shape upstream does not document, or a box that refuses the request.
 */
async function existingSchedule(
  coolify: CoolifyClient,
  databaseUuid: string,
  databaseName: string,
): Promise<{ uuid: string } | "none" | "unreadable"> {
  let listed: unknown;
  try {
    listed = await coolify.listDatabaseBackups(databaseUuid);
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return "unreadable";
  }
  if (!Array.isArray(listed)) return "unreadable";

  for (const entry of listed as unknown[]) {
    if (typeof entry !== "object" || entry === null) return "unreadable";
    const { uuid, databases_to_backup } = entry as Record<string, unknown>;
    if (typeof uuid !== "string" || typeof databases_to_backup !== "string") return "unreadable";
    if (databases_to_backup === databaseName) return { uuid };
  }
  return "none";
}
