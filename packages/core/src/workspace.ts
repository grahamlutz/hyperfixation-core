/**
 * The workspace's descriptors, and the reason they are a second entry point: the workspace is
 * paths, nav items and flattened drafts — no component, no `react`, nothing the template cannot
 * render its own way. Everything here is pure and synchronous; the guard is the template's, on
 * the layout that renders these, because a workspace 404 and a workspace sign-in look the same
 * to a stranger only if one guard covers every route.
 */

import type { ActivityRow } from "./activity.js";
import type { LabelRow } from "./labels.js";
import type { OutcomeRow } from "./outcomes.js";
import type { PageDefinition } from "./pages.js";
import type { RecordDefinition, StageDefinition } from "./records.js";
import type { Registry } from "./registry.js";
import type { TaskRow } from "./tasks.js";
import type { WorkspaceViews } from "./workspace-views.js";

export type {
  ActivityRow,
  LabelRow,
  OutcomeRow,
  PageDefinition,
  RecordDefinition,
  Registry,
  StageDefinition,
  TaskRow,
};

/**
 * The reads themselves are `@hyperfixation/core`'s — they need the pool — but their types are
 * the template's to name, so they are re-exported here with the descriptors.
 */
export type {
  BoardCard,
  BoardColumn,
  BoardOptions,
  BoardView,
  HomeOptions,
  HomeView,
  InboxItem,
  InboxOptions,
  InboxView,
  RecordView,
  ReviewQueueCount,
  TimelineGroup,
  WorkspaceDecideOptions,
  WorkspaceViews,
} from "./workspace-views.js";

/** Where the template mounts the workspace. Only the default; `route()` takes what it is given. */
export const WORKSPACE_BASE_PATH = "/w";

/**
 * How many cards a board reads per record type before it stops. Declared here rather than beside
 * `workspaceBoard` so a template can name the default it is about to override without importing
 * the reads — `workspace-views.ts` re-exports it for `.`.
 */
export const DEFAULT_BOARD_LIMIT = 500;

export type WorkspaceRoute =
  | { kind: "home" }
  | { kind: "inbox" }
  | { kind: "approval"; id: number }
  | { kind: "board"; record: RecordDefinition }
  | { kind: "record"; record: RecordDefinition; id: string }
  | { kind: "page"; page: PageDefinition };

export interface WorkspaceNavItem {
  readonly path: string;
  readonly title: string;
}

/** The two registries the workspace reads. `defineApp` passes its own. */
export interface WorkspaceRegistries {
  readonly records: Registry<RecordDefinition>;
  readonly pages: Registry<PageDefinition>;
}

export interface AppWorkspace extends WorkspaceViews {
  /**
   * The catch-all's body: the segments below the mount point, resolved. `undefined` is a path the
   * workspace does not serve. No guard and no `await` — unlike the admin's `route()`, this one
   * resolves a path and nothing else.
   */
  route(path?: string | readonly string[]): WorkspaceRoute | undefined;
  nav(): WorkspaceNavItem[];
}

export function approvalPath(id: number): string {
  return `${WORKSPACE_BASE_PATH}/approvals/${id}`;
}

function segmentsOf(path: string | readonly string[] | undefined): string[] {
  // A catch-all already hands back the segments below the mount, so an array is taken as-is — a
  // record type named `w` stays reachable. Only a whole pathname has the mount on the front.
  if (typeof path !== "string") return (path ?? []).filter((segment) => segment.length > 0);
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments[0] === WORKSPACE_BASE_PATH.slice(1) ? segments.slice(1) : segments;
}

/** `hf_approval.id` is a bigint identity, so anything else in the slot is not an approval. */
function approvalIdOf(segment: string): number | undefined {
  if (!/^[1-9][0-9]*$/.test(segment)) return undefined;
  const id = Number(segment);
  return Number.isSafeInteger(id) ? id : undefined;
}

export function workspaceRoute(
  registries: WorkspaceRegistries,
  path?: string | readonly string[],
): WorkspaceRoute | undefined {
  const segments = segmentsOf(path);
  if (segments.length === 0) return { kind: "home" };

  if (segments[0] === "approvals") {
    if (segments.length === 1) return { kind: "inbox" };
    if (segments.length > 2) return undefined;
    const id = approvalIdOf(segments[1]!);
    return id === undefined ? undefined : { kind: "approval", id };
  }

  if (segments.length <= 2) {
    const record = registries.records.get(segments[0]!);
    if (record !== undefined) {
      const id = segments[1];
      return id === undefined ? { kind: "board", record } : { kind: "record", record, id };
    }
  }

  // Pages are keyed by their whole path, which is also the `href` `nav()` hands the template, so
  // the lookup puts the mount back on the front of the segments it was given.
  const page = registries.pages.get([WORKSPACE_BASE_PATH, ...segments].join("/"));
  return page === undefined ? undefined : { kind: "page", page };
}

export function workspaceNav(registries: WorkspaceRegistries): WorkspaceNavItem[] {
  return [
    { path: WORKSPACE_BASE_PATH, title: "Home" },
    { path: `${WORKSPACE_BASE_PATH}/approvals`, title: "Inbox" },
    ...registries.records.all().map((record) => ({
      path: `${WORKSPACE_BASE_PATH}/${record.recordType}`,
      title: record.title ?? record.recordType,
    })),
    ...registries.pages
      .all()
      .filter((page) => page.nav === true)
      .map((page) => ({ path: page.path, title: page.title })),
  ];
}

/** One row of a draft, ready to be shown or edited. `path` is also an edit form's field name. */
export interface DraftField {
  /** Dotted through objects and bracketed through arrays: `contacts[0].email`. */
  readonly path: string;
  /**
   * The walk from the draft root: object keys verbatim, array indexes as numbers. `path` is a
   * display string and two different leaves can share one — `{"a.b": 1}` and `{a: {b: 2}}` both
   * read `a.b` — so anything writing a value back follows this instead. Empty for a bare scalar
   * draft, which is its own root.
   */
  readonly segments: readonly (string | number)[];
  readonly label: string;
  readonly value: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * A leaf is always text, never `null` or a number: the template renders these as strings and an
 * edit form posts them back as strings, so the conversion happens once, here.
 */
function leafText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  // A function, a symbol or an exotic object: nothing a JSON draft holds, and nothing worth
  // guessing a rendering for.
  return "";
}

function labelOf(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
  const sentence = words.join(" ");
  return sentence.length === 0 ? key : sentence[0]!.toUpperCase() + sentence.slice(1);
}

function flatten(
  value: unknown,
  path: string,
  segments: readonly (string | number)[],
  label: string,
  into: DraftField[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flatten(item, `${path}[${index}]`, [...segments, index], `${label} ${index + 1}`, into);
    });
    return;
  }
  if (isPlainRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      flatten(
        nested,
        path === "" ? key : `${path}.${key}`,
        [...segments, key],
        labelOf(key),
        into,
      );
    }
    return;
  }
  into.push({ path, segments, label, value: leafText(value) });
}

/**
 * A draft — an approval's `payload`, model output — flattened to rows. The values are the draft's
 * own text, unescaped and unmarked-up: escaping belongs to whatever renders them, and a draft
 * holding `<img src=x>` must reach the renderer as that literal string rather than as something
 * this function decided was safe.
 *
 * A container contributes no row of its own, so an empty object or array flattens to nothing.
 */
export function draftFields(draft: unknown): DraftField[] {
  if (Array.isArray(draft) || isPlainRecord(draft)) {
    const fields: DraftField[] = [];
    flatten(draft, "", [], "Value", fields);
    return fields;
  }
  // A bare scalar draft has no key to name it, and `value` is the field name a form would post.
  return [{ path: "value", segments: [], label: "Value", value: leafText(draft) }];
}
