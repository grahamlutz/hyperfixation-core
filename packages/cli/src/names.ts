/**
 * What a user may type. Hyphens are allowed here and nowhere downstream: `demo-app` is a
 * directory and an npm package name, and the plan's own exit bar spells the example with one.
 */
export const GIVEN_NAME = /^[a-z][a-z0-9_-]{0,62}$/;

/**
 * The plan's rule, applied to every derived identifier — the database, both roles, and the
 * name `defineApp` carries into the advisory lock and DBOS. `@hyperfixation/db`'s own
 * `assertAppName` is this same pattern, so an app name that fails here fails `migrate()` later
 * anyway; refusing at `hf new` is the only point at which the directory does not yet exist.
 */
export const APP_ID = /^[a-z][a-z0-9_]{0,62}$/;

export class InvalidAppName extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAppName";
  }
}

export interface AppNames {
  /** Exactly what was typed; the directory `hf new` creates. */
  given: string;
  /** `__APP_NAME__`: the given name with `-` replaced by `_`. */
  appName: string;
  /** `__DB_NAME__`. */
  databaseName: string;
  /** `hf_<appName>` — the same string as the database name, as `roleNames()` derives it. */
  applicationRole: string;
  migratorRole: string;
}

/**
 * The substitution `hf new` performs, and the only place the two placeholders are defined.
 *
 * `__APP_NAME__` is the *underscored* form rather than what was typed, because it is what
 * `src/hyperfixation.ts` hands `defineApp` and what the template's `.env.example` builds the
 * application role out of — both of which reach `roleNames()`, which refuses a hyphen. The
 * directory keeps the typed name; nothing inside the app does.
 */
export function deriveNames(given: string): AppNames {
  if (!GIVEN_NAME.test(given)) {
    throw new InvalidAppName(
      `app name must match ${GIVEN_NAME.source}, got ${JSON.stringify(given)}`,
    );
  }

  const appName = given.replaceAll("-", "_");
  const databaseName = `hf_${appName}`;
  if (!APP_ID.test(databaseName)) {
    throw new InvalidAppName(
      `database name must match ${APP_ID.source}, but ${JSON.stringify(given)} derives ` +
        `${JSON.stringify(databaseName)} — an app name may be at most 60 characters`,
    );
  }

  return {
    given,
    appName,
    databaseName,
    applicationRole: databaseName,
    migratorRole: `${databaseName}_migrator`,
  };
}
