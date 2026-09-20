import { roleNames } from "@hyperfixation/db/migrator";
import type { AppNames } from "./names.js";

export interface ChecklistInput {
  names: AppNames;
  /** `<name>.<HF_BASE_DOMAIN>`, the host Coolify serves and the passkey relying-party origin. */
  fqdn: string;
  /** `owner/name` of the app's repository, as the state cache recorded it. */
  repo?: string;
  /** The hostname the app's containers reach Postgres by; Metabase is on the same network. */
  dbHost: string;
  /** Where the passwords and tokens this names actually live. */
  stateFile: string;
  /** Which of `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` the environment carries. */
  providerKeysSent: readonly string[];
  /** Lines the steps themselves appended to `context.checklist`, in the order they ran. */
  fromSteps?: readonly string[];
  /** The `/api/status` write token, and only on the run that minted it. */
  writeToken?: string;
}

/**
 * What `hf new` cannot do for the operator, printed when the ten steps are done.
 *
 * No secret is printed but the write token, and that only on the run that generated it: every
 * other value this names is in the state file, which is the one place any of them exists.
 */
export function checklistLines(input: ChecklistInput): string[] {
  const { names, fqdn } = input;
  const origin = `https://${fqdn}`;
  const lines = [`${names.given} is deployed at ${origin}. What is left is yours:`, ""];

  const add = (...parts: string[]): void => {
    lines.push(`  - ${parts[0]!}`, ...parts.slice(1).map((part) => `      ${part}`), "");
  };

  if (input.providerKeysSent.length === 0) {
    add(
      "The app is serving FIXTURE drafts: no ANTHROPIC_API_KEY or OPENAI_API_KEY was configured,",
      "so llm.run returns canned text. /api/status reports llm.mode=fixtures once the app's",
      "worker has reported the mode — until then, and on a core older than 0.1.1, it says",
      "unknown. Paste a key into Coolify's environment for this application and redeploy.",
    );
  }

  add(
    "Third-party keys go into Coolify's environment for this application — and every new name",
    "also has to be added to REQUIRED_ENV (src/env.ts), .env.example and all three",
    "environment: blocks of docker-compose.prod.yml. A name Coolify carries that compose does",
    "not interpolate never reaches a container, and hf new refuses the next run until they agree.",
  );

  add(
    `Metabase reads through ${roleNames(names.appName).readonly}:`,
    `postgres://${roleNames(names.appName).readonly}:<password>@${input.dbHost}:5432/${names.databaseName}`,
    `the password is database.readonlyPassword in ${input.stateFile}.`,
  );

  add(
    `Add the line "${input.repo ?? `<owner>/${names.given}`}" to downstream.txt in`,
    "hyperfixation-core, so the core bump opens a pull request here. (Phase 4 creates the file;",
    "until then this is the line it will need.)",
  );

  add(
    "Merge a core-bump/* pull request only when its checks are green — a bump that fails CI is a",
    "core release this app cannot take. hf doctor lists the open ones with their status.",
  );

  add(
    `Enrol your passkey from exactly ${origin}, not an alias and not an IP: APP_URL is the`,
    "relying-party origin, and a different host enrols a credential the app will never accept.",
  );

  add(`Prove the backup restores: hf restore-check ${names.given}.`);

  // Each step's own line, last: a step knows something about its half that nothing here does.
  for (const line of input.fromSteps ?? []) add(line);

  if (input.writeToken !== undefined) {
    add(
      "The /api/status write token, shown once and stored nowhere but the state file:",
      input.writeToken,
    );
  }

  // One trailing blank from the last `add`, which reads as a gap before the shell prompt.
  return lines.slice(0, -1);
}
