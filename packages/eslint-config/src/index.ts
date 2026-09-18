import type { Linter } from "eslint";
import tseslint from "typescript-eslint";

/**
 * The four bans follow from the run model: a run crosses a deploy by restarting, never by
 * carrying a workflow across an `applicationVersion` boundary. `patch`/`deprecatePatch` would
 * run new code against another version's checkpoints; `recv`/`send`/`getEvent`/`setEvent` park
 * a workflow in a wait no drain can bound; `sendInTransaction` writes to a DBOS row that may
 * have been garbage-collected, discarding a committed decision.
 */
export const BANNED_DBOS_PROPERTIES = [
  "patch",
  "deprecatePatch",
  "recv",
  "send",
  "getEvent",
  "setEvent",
] as const;

/** Matched on the member name, so an instance `dbosClient.sendInTransaction(…)` is caught too. */
export const BANNED_MEMBER = "sendInTransaction";

/**
 * A package's `exports` map already makes these a resolver error; the lint rule is what names
 * the reason at the point of the import instead of in a `tsc` stack. The plan writes the
 * patterns as `src/*` and `dist/*`; they are `**` here so a nested path cannot slip through.
 */
export const DEEP_IMPORT_PATTERNS = [
  "@hyperfixation/*/src",
  "@hyperfixation/*/src/**",
  "@hyperfixation/*/dist",
  "@hyperfixation/*/dist/**",
] as const;

/**
 * A hint that fails fast in the editor, **not** the enforcement: round-3 finding 3 established
 * that `no-restricted-imports` only constrains the importing file, so a helper in `src/lib/`
 * that imports `@/db` and is imported by a flow is lint-legal. The step pool refuses the write
 * whatever file issued it; this rule just shortens the loop for the common case.
 */
export const FLOW_RAW_HANDLE_PATHS = [
  "@/db",
  "@hyperfixation/db/client",
  "@hyperfixation/core/records",
] as const;

/**
 * The plan scopes the hint to `src/flows/**`; the glob is unanchored so it holds for an app's
 * `src/flows/` and for a fixture that is not under a `src/` at all.
 */
export const FLOW_FILES = ["**/flows/**/*.ts", "**/flows/**/*.tsx"] as const;

const TS_FILES = ["**/*.ts", "**/*.tsx"];

const RAW_HANDLE_MESSAGE =
  "Flows reach the database through ctx.tx only. The step pool refuses an unfenced write anyway; this is the fast hint.";

const bans: Linter.Config = {
  name: "hyperfixation/bans",
  files: TS_FILES,
  languageOptions: {
    parser: tseslint.parser as Linter.Parser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
  rules: {
    "no-restricted-properties": [
      "error",
      ...BANNED_DBOS_PROPERTIES.map((property) => ({
        object: "DBOS",
        property,
        message: `DBOS.${property} is banned: a run crosses a deploy by restarting, not by carrying a workflow across an applicationVersion boundary.`,
      })),
    ],
    "no-restricted-syntax": [
      "error",
      {
        selector: `MemberExpression[property.name="${BANNED_MEMBER}"]`,
        message: `${BANNED_MEMBER} is banned: no core table has an FK to a DBOS row, and a collected workflow row would silently discard the committed decision.`,
      },
    ],
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: [...DEEP_IMPORT_PATTERNS],
            message:
              "Import the package's public entry. A deep import reaches past the exports map, which is the contract.",
          },
        ],
      },
    ],
  },
};

const flowHints: Linter.Config = {
  name: "hyperfixation/flow-raw-handle-hint",
  files: [...FLOW_FILES],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: FLOW_RAW_HANDLE_PATHS.map((name) => ({ name, message: RAW_HANDLE_MESSAGE })),
        patterns: [
          {
            group: [...DEEP_IMPORT_PATTERNS],
            message:
              "Import the package's public entry. A deep import reaches past the exports map, which is the contract.",
          },
        ],
      },
    ],
  },
};

/** Build output is never linted; it is not source anyone can fix. */
const ignores: Linter.Config = {
  name: "hyperfixation/ignores",
  ignores: ["**/dist/**", "**/node_modules/**", "**/.turbo/**"],
};

export const hyperfixation: Linter.Config[] = [ignores, bans, flowHints];

export default hyperfixation;
