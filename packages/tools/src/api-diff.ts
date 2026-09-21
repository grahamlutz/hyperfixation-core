#!/usr/bin/env tsx
/**
 * The mechanical half of planning/hyperfixation-versioning-policy.md: a member that leaves or
 * changes shape in a committed `etc/*.api.md` must have been announced a release earlier.
 *
 * The parsing is deliberately shallow — an API Extractor report is generated, so its shape is
 * stable — and reorder-tolerant, because an incremental build reorders union members and the
 * gate must not fire on that noise.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CORE_ROOT } from "./proc.js";

export type Bump = "none" | "patch" | "minor" | "major";

const BUMP_ORDER: readonly Bump[] = ["none", "patch", "minor", "major"];

export interface Deprecation {
  readonly package: string;
  readonly symbol: string;
  readonly since: string;
  readonly removeIn: string;
}

/** One `etc/*.api.md`, at the baseline and at HEAD. An empty side means the file did not exist. */
export interface ReportPair {
  readonly package: string;
  readonly version: string;
  readonly file: string;
  readonly baseline: string;
  readonly head: string;
}

export interface Member {
  readonly signature: string;
  readonly deprecated: boolean;
}

export interface Declaration {
  readonly name: string;
  readonly deprecated: boolean;
  readonly members: ReadonlyMap<string, Member>;
}

/** `member` is `""` for the declaration line itself — a function, const or type alias. */
export interface Change {
  readonly package: string;
  readonly file: string;
  readonly symbol: string;
  readonly member: string;
  readonly kind: "removed" | "retyped";
  /**
   * A value that left a const's literal set — `"deploy"` out of `COMMANDS`. A tuple member cannot
   * carry an `@deprecated` tag of its own, so a `deprecations.json` entry naming `COMMANDS.deploy`
   * is the whole announcement and the baseline-tag gate does not apply.
   */
  readonly literalMember?: string;
}

export interface Finding extends Change {
  readonly problems: readonly string[];
}

// --- parsing -----------------------------------------------------------------------------

/**
 * Offsets of `wanted` that sit outside every bracket and string. `<` and `>` are deliberately
 * not brackets: they would make `=>` unbalanced, and a union inside a generic argument is
 * order-insensitive too.
 */
function topLevel(text: string, wanted: string): number[] {
  const found: number[] = [];
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (quote !== "") {
      if (char === quote && text[i - 1] !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    else if (char === wanted && depth === 0) found.push(i);
  }
  return found;
}

/**
 * Sorts the arms of an unbracketed union so `A | B` and `B | A` are one signature — the union
 * reordering an incremental API Extractor build produces is noise, not an API change. The arms
 * start after the last `=` or `:` before the union, so the declaration's own prefix stays put.
 * A reordering this does not understand is reported, which is the safe direction.
 */
export function normalizeSignature(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const tail = flat.endsWith(";") ? ";" : "";
  const body = tail === "" ? flat : flat.slice(0, -1);
  const pipes = topLevel(body, "|");
  const first = pipes[0];
  if (first === undefined) return flat;
  const anchors = [...topLevel(body, "="), ...topLevel(body, ":")].filter((at) => at < first);
  const start = anchors.length === 0 ? 0 : Math.max(...anchors) + 1;
  const arms: string[] = [];
  let from = start;
  for (const at of pipes) {
    arms.push(body.slice(from, at));
    from = at + 1;
  }
  arms.push(body.slice(from));
  const sorted = arms
    .map((arm) => arm.trim())
    .sort()
    .join(" | ");
  return `${body.slice(0, start).trim()} ${sorted}${tail}`.trim();
}

const MEMBER_MODIFIERS =
  /^(export|declare|abstract|static|readonly|public|protected|private|get|set|async)\s+/;

function memberKey(text: string): string {
  let rest = text.trim();
  while (MEMBER_MODIFIERS.test(rest)) rest = rest.replace(MEMBER_MODIFIERS, "");
  const name = /^(\[[^\]]*\]|"[^"]*"|'[^']*'|[A-Za-z_$][\w$]*)/.exec(rest)?.[1];
  return name ?? normalizeSignature(rest);
}

function declarationName(header: string): string | undefined {
  return /\b(?:class|interface|enum|namespace|function|const|let|var|type)\s+([A-Za-z_$][\w$]*)/.exec(
    header,
  )?.[1];
}

/** The names `export { A, B as C }` puts in the public namespace — `A` and `C`. */
function reExportNames(line: string): string[] {
  const inner = /^export\s*(?:type\s*)?\{([^}]*)\}/.exec(line)?.[1];
  if (inner === undefined) return [];
  return inner
    .split(",")
    .map((clause) => clause.trim().split(/\s+as\s+/).at(-1)?.replace(/^type\s+/, "").trim() ?? "")
    .filter(Boolean);
}

function depthOf(line: string): number {
  let depth = 0;
  for (const char of line) {
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
  }
  return depth;
}

function codeBlock(text: string): string {
  const match = /```ts\r?\n([\s\S]*?)```/.exec(text);
  return match?.[1] ?? "";
}

/**
 * The exported declarations of one report, keyed by name. A declaration with a body carries one
 * entry per member plus `""` for its own header line; everything else carries only `""`.
 */
export function parseApiReport(text: string): Map<string, Declaration> {
  const declarations = new Map<string, Declaration>();
  const lines = codeBlock(text).split(/\r?\n/);

  let tags = "";
  let current: { name: string; deprecated: boolean; members: Map<string, Member> } | undefined;
  let memberTags = "";
  let member: string[] = [];
  let depth = 0;

  const finishMember = (): void => {
    if (current === undefined || member.length === 0) return;
    const signature = member.join(" ");
    current.members.set(memberKey(signature), {
      signature: normalizeSignature(signature),
      deprecated: memberTags.includes("@deprecated"),
    });
    member = [];
    memberTags = "";
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    if (trimmed.startsWith("//")) {
      if (depth === 0) tags += ` ${trimmed}`;
      else memberTags += ` ${trimmed}`;
      continue;
    }

    if (depth === 0) {
      if (!trimmed.startsWith("export ")) {
        tags = "";
        continue;
      }
      depth = depthOf(line);
      const name = declarationName(trimmed);
      if (name === undefined) {
        // A bare re-export, `export { JSONSchema7 }`: no body, one entry per exported name.
        for (const clause of reExportNames(trimmed)) {
          declarations.set(clause, {
            name: clause,
            deprecated: tags.includes("@deprecated"),
            members: new Map([["", { signature: clause, deprecated: false }]]),
          });
        }
        tags = "";
        depth = 0;
        continue;
      }
      current = { name, deprecated: tags.includes("@deprecated"), members: new Map() };
      // The header is the declaration's own signature: an interface that gains `extends`, or a
      // function whose return type moved, changes here and nowhere else.
      current.members.set("", { signature: normalizeSignature(trimmed), deprecated: false });
      if (depth === 0) {
        declarations.set(name, current);
        current = undefined;
      }
      tags = "";
      continue;
    }

    const after = depth + depthOf(line);
    depth = after;
    if (after === 0) {
      finishMember();
      if (current !== undefined) declarations.set(current.name, current);
      current = undefined;
      continue;
    }
    member.push(trimmed);
    if (after === 1 && (trimmed.endsWith(";") || trimmed.endsWith("}"))) finishMember();
  }

  if (current !== undefined) {
    finishMember();
    declarations.set(current.name, current);
  }
  return declarations;
}

// --- the diff ----------------------------------------------------------------------------

/** Removals and retypes only; an addition is not a change the policy cares about. */
export function apiChanges(pair: ReportPair): Change[] {
  const before = parseApiReport(pair.baseline);
  const after = parseApiReport(pair.head);
  const changes: Change[] = [];
  for (const [name, declaration] of before) {
    const now = after.get(name);
    for (const [key, member] of declaration.members) {
      const replacement = now?.members.get(key);
      if (replacement === undefined) {
        changes.push({
          package: pair.package,
          file: pair.file,
          symbol: name,
          member: key,
          kind: "removed",
        });
      } else if (replacement.signature !== member.signature) {
        const lost = constLiteralRemovals(member.signature, replacement.signature);
        if (lost !== undefined) {
          for (const value of lost) {
            changes.push({
              package: pair.package,
              file: pair.file,
              symbol: name,
              member: key,
              kind: "removed",
              literalMember: value,
            });
          }
        } else if (
          !onlyAddsOptionalParameters(member.signature, replacement.signature) &&
          !onlyAddsProperties(member.signature, replacement.signature)
        ) {
          changes.push({
            package: pair.package,
            file: pair.file,
            symbol: name,
            member: key,
            kind: "retyped",
          });
        }
      }
    }
  }
  return changes;
}

/** `export const NAME = <literal>;`, or `export const NAME: <literal>;` as the report writes it. */
const CONST_DECLARATION = /^export const ([A-Za-z0-9_$]+)\s*(?::|=)\s*(.+);$/;

/**
 * What a `const`'s printed literal lost, for a pair of signatures that declare the same const and
 * differ only inside that literal: `undefined` when the pair is not that (so the caller reports it
 * as a retype), otherwise the values the literal no longer carries — empty when it only grew or
 * reordered.
 *
 * A const's literal is mostly a value the report happens to print rather than a contract: `hf`'s
 * `USAGE` text is reprinted by every command added, and the gates a retype otherwise has to clear
 * say nothing about prose. A *set* of string literals is different — `COMMANDS` is the list of
 * commands `hf` accepts, so a value leaving it breaks callers exactly like a removed export, and
 * only a superset is excused. The const disappearing from the report is still a removal.
 */
export function constLiteralRemovals(before: string, after: string): string[] | undefined {
  const one = CONST_DECLARATION.exec(before);
  const two = CONST_DECLARATION.exec(after);
  if (one === null || two === null || one[1] !== two[1]) return undefined;
  const from = literalShape(one[2]!);
  const to = literalShape(two[2]!);
  if (from === undefined || to === undefined) return undefined;
  // Two plain strings: `USAGE`'s prose, which the gate leaves to `COMMANDS` beside it.
  if (from.kind === "text" && to.kind === "text") return [];
  return [...from.values].filter((value) => !to.values.has(value));
}

/** A quoted string exactly as the report prints one, escapes and all. */
const STRING_LITERAL = /^"(?:[^"\\]|\\.)*"$/;

/** A number as the report prints one — a threshold like `STALE_DUMP_HOURS`. */
const NUMBER_LITERAL = /^-?\d+(?:\.\d+)?$/;

/**
 * How the gate reads a const's literal type: `text` for a single string or number, `set` for a
 * readonly tuple or union whose every arm is a string literal, and `undefined` for anything else —
 * which is reported rather than excused, the safe direction for a shape this does not understand.
 * A set that shrank to one arm is `text` on the new side, and its values still compare.
 */
function literalShape(type: string): { kind: "text" | "set"; values: Set<string> } | undefined {
  const trimmed = type.trim();
  if (STRING_LITERAL.test(trimmed)) {
    return { kind: "text", values: new Set([trimmed.slice(1, -1)]) };
  }
  if (NUMBER_LITERAL.test(trimmed)) return { kind: "text", values: new Set([trimmed]) };
  const arms = tupleArms(trimmed) ?? unionArms(trimmed);
  if (arms === undefined || !arms.every((arm) => STRING_LITERAL.test(arm))) return undefined;
  return { kind: "set", values: new Set(arms.map((arm) => arm.slice(1, -1))) };
}

function tupleArms(type: string): string[] | undefined {
  const inner = /^readonly\s*\[([\s\S]*)\]$/.exec(type)?.[1];
  if (inner === undefined) return undefined;
  return split(inner, ",");
}

function unionArms(type: string): string[] | undefined {
  return topLevel(type, "|").length === 0 ? undefined : split(type, "|");
}

/** `text` cut at every top-level `separator`, trimmed, with the empty pieces dropped. */
function split(text: string, separator: string): string[] {
  const arms: string[] = [];
  let from = 0;
  for (const at of topLevel(text, separator)) {
    arms.push(text.slice(from, at));
    from = at + 1;
  }
  arms.push(text.slice(from));
  return arms.map((arm) => arm.trim()).filter((arm) => arm !== "");
}

/**
 * True when `after` is `before` with properties added to its object types and nothing else —
 * no property removed, none retyped, and the same text around the braces.
 *
 * "Adding one is not [breaking]" reaches inside a printed object type as well as into a list of
 * exports. A `drizzle` table is the case that forced it: `hf_session` gaining a nullable column
 * reprints the whole of `hfSession`'s `columns` member and, through `AUTH_SCHEMA`, of
 * `AUTH_SCHEMA.session`, so an additive core migration read as two retyped members and asked for a
 * two-release deprecation of something nothing was deprecating. A consumer on N-1 still finds
 * every column it knew, which is the test the policy actually states.
 *
 * Recursive because the addition is usually nested — a column inside `columns` inside the table's
 * type argument. A pair this does not understand as an object is reported, the safe direction.
 *
 * An object the *caller* supplies is the exception: a required property added to an options
 * parameter fails every existing call, so inside a parameter list only an optional addition is
 * excused. A property of a printed type nobody writes by hand — a drizzle column — is read, not
 * constructed, and still is.
 */
export function onlyAddsProperties(before: string, after: string): boolean {
  return addsProperties(before, after, parameterSpan(before) !== undefined);
}

/** `supplied`: the signature is a call, so its objects are ones a caller has to write. */
function addsProperties(before: string, after: string, supplied: boolean): boolean {
  if (before === after) return true;
  const one = bracedSpan(before);
  const two = bracedSpan(after);
  if (one === undefined || two === undefined) return false;
  if (one.head !== two.head || one.tail !== two.tail) return false;

  const added = objectEntries(two.body);
  if (added === undefined) return false;
  const existing = objectEntries(one.body);
  if (existing === undefined) return false;

  for (const [key, entry] of existing) {
    const replacement = added.get(key);
    if (replacement === undefined) return false;
    if (replacement.optional !== entry.optional) return false;
    if (replacement.type !== entry.type && !addsProperties(entry.type, replacement.type, supplied)) {
      return false;
    }
  }
  if (supplied) {
    for (const [key, entry] of added) {
      if (!existing.has(key) && !entry.optional) return false;
    }
  }
  return true;
}

/**
 * A signature split around its outermost `{ … }`, or `undefined` when it has none — or when that
 * `{` is not matched by the signature's last `}`, which means the signature holds more than one
 * object. `run(a: { x: string; }, b: { y: string; })` is why: taking the first `{` to the last `}`
 * flattened both bodies into one namespace, so `x` moving from `a` to `b` left the key set
 * identical and read as no change at all. A signature this cannot split into one object is
 * reported.
 */
function bracedSpan(signature: string): { head: string; body: string; tail: string } | undefined {
  const last = signature.lastIndexOf("}");
  let open: number | undefined;
  let depth = 0;
  let quote = "";
  for (let i = 0; i < signature.length; i += 1) {
    const char = signature[i] ?? "";
    if (quote !== "") {
      if (char === quote && signature[i - 1] !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") {
      if (open === undefined) open = i;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth !== 0 || open === undefined) continue;
      if (i !== last) return undefined;
      return {
        head: signature.slice(0, open),
        body: signature.slice(open + 1, i),
        tail: signature.slice(i + 1),
      };
    }
  }
  return undefined;
}

/** A printed object property: its type, and whether the key carried a `?`. */
interface ObjectEntry {
  readonly type: string;
  readonly optional: boolean;
}

/**
 * A printed object body as `name → entry`, cut at its top-level `;`. A trailing `?` leaves the key
 * and becomes the entry's optionality, so `b?: number` → `b: number` compares as the same property
 * made required rather than as one dropped and another added. `undefined` when an entry carries no
 * top-level `:` to key it by — a mapped type, an index signature's shorthand, anything this should
 * not pretend to have understood.
 */
function objectEntries(body: string): Map<string, ObjectEntry> | undefined {
  const entries = new Map<string, ObjectEntry>();
  for (const entry of split(body, ";")) {
    const at = topLevel(entry, ":")[0];
    if (at === undefined) return undefined;
    const name = entry.slice(0, at).trim();
    const optional = name.endsWith("?");
    entries.set(optional ? name.slice(0, -1).trim() : name, {
      type: entry.slice(at + 1).trim(),
      optional,
    });
  }
  return entries;
}

/**
 * True when `after` is `before` with optional parameters appended and nothing else touched.
 *
 * "Adding one is not [breaking]" covers a trailing optional parameter: every existing call still
 * compiles, and so does every existing implementation of the member, which may ignore it. Only a
 * literal prefix counts — a parameter inserted, renamed, retyped or made required lands outside
 * this and is reported.
 */
export function onlyAddsOptionalParameters(before: string, after: string): boolean {
  const split = (
    signature: string,
  ): { head: string; params: string[]; tail: string } | undefined => {
    const span = parameterSpan(signature);
    if (span === undefined) return undefined;
    const [open, close] = span;
    const inner = signature.slice(open + 1, close).trim();
    const commas = topLevel(inner, ",");
    const params: string[] = [];
    let from = 0;
    for (const at of commas) {
      params.push(inner.slice(from, at).trim());
      from = at + 1;
    }
    const last = inner.slice(from).trim();
    if (last !== "" || params.length > 0) params.push(last);
    return {
      head: signature.slice(0, open),
      params: params.filter((param) => param !== ""),
      tail: signature.slice(close + 1),
    };
  };

  const one = split(before);
  const two = split(after);
  if (one === undefined || two === undefined) return false;
  if (one.head !== two.head || one.tail !== two.tail) return false;
  if (two.params.length <= one.params.length) return false;
  if (one.params.some((param, index) => param !== two.params[index])) return false;
  return two.params
    .slice(one.params.length)
    .every((param) => /^\.\.\./.test(param) || /^[A-Za-z_$][\w$]*\?\s*:/.test(param));
}

/** The first parameter list's `(` and its matching `)`, or nothing when there is none. */
function parameterSpan(text: string): [number, number] | undefined {
  let open: number | undefined;
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (quote !== "") {
      if (char === quote && text[i - 1] !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if ("([{".includes(char)) {
      if (char === "(" && depth === 0) open = i;
      depth += 1;
    } else if (")]}".includes(char)) {
      depth -= 1;
      if (char === ")" && depth === 0 && open !== undefined) return [open, i];
    }
  }
  return undefined;
}

// --- versions ----------------------------------------------------------------------------

function parts(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) throw new Error(`Not a version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** At 0.x the minor is the breaking release, so this is the version a removal may land in. */
export function nextMinor(version: string): string {
  const [major, minor] = parts(version);
  return `${major}.${minor + 1}.0`;
}

export function changesetBump(contents: readonly string[]): Bump {
  let bump: Bump = "none";
  for (const text of contents) {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    for (const line of front.split(/\r?\n/)) {
      const value = /:\s*(patch|minor|major)\s*$/.exec(line)?.[1] as Bump | undefined;
      if (value === undefined) continue;
      if (BUMP_ORDER.indexOf(value) > BUMP_ORDER.indexOf(bump)) bump = value;
    }
  }
  return bump;
}

export function parseDeprecations(text: string): Deprecation[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("deprecations.json must hold an array.");
  return parsed.map((entry, index) => {
    const row = entry as Partial<Deprecation>;
    for (const field of ["package", "symbol", "since", "removeIn"] as const) {
      if (typeof row[field] !== "string") {
        throw new Error(`deprecations.json entry ${index} has no string "${field}".`);
      }
    }
    return row as Deprecation;
  });
}

// --- the gate ----------------------------------------------------------------------------

export interface CheckOptions {
  readonly reports: readonly ReportPair[];
  readonly deprecations: readonly Deprecation[];
  readonly bump: Bump;
}

/**
 * Every removal or retype must clear all three gates: an announced deprecation whose window
 * covers this release, an `@deprecated` tag in the *baseline* report (so consumers saw it a
 * release ago), and a minor on this PR. A finding lists every gate it failed at once — a
 * removal that needs both an entry and a bigger changeset should say so in one run.
 */
export function checkApiDiff(options: CheckOptions): Finding[] {
  const findings: Finding[] = [];
  for (const pair of options.reports) {
    const baseline = parseApiReport(pair.baseline);
    for (const change of apiChanges(pair)) {
      const problems: string[] = [];
      const announced = deprecationSymbol(change);
      const entry = options.deprecations.find(
        (row) => row.package === pair.package && row.symbol === announced,
      );
      if (entry === undefined) {
        problems.push(
          `no deprecations.json entry for ${pair.package} ${announced}; a removal that was never announced is a bug in the release, not a fast path`,
        );
      } else {
        if (compareVersions(entry.since, pair.version) > 0) {
          problems.push(
            `deprecations.json says since ${entry.since}, which is ahead of ${pair.package}@${pair.version} — the deprecation has not shipped yet`,
          );
        }
        if (compareVersions(entry.removeIn, nextMinor(pair.version)) < 0) {
          problems.push(
            `deprecations.json says removeIn ${entry.removeIn}, earlier than the next minor ${nextMinor(pair.version)}`,
          );
        }
      }

      if (change.literalMember === undefined) {
        const declaration = baseline.get(change.symbol);
        const deprecated =
          declaration?.deprecated === true ||
          declaration?.members.get(change.member)?.deprecated === true;
        if (!deprecated) {
          problems.push(`${change.symbol} carries no @deprecated tag in the baseline report`);
        }
      }

      if (BUMP_ORDER.indexOf(options.bump) < BUMP_ORDER.indexOf("minor")) {
        problems.push(
          `a removed or retyped member is a breaking change, so this PR needs a minor changeset (found: ${options.bump})`,
        );
      }

      if (problems.length > 0) findings.push({ ...change, problems });
    }
  }
  return findings;
}

/** What a `deprecations.json` row has to name for this change — `COMMANDS.deploy`, or the symbol. */
function deprecationSymbol(change: Change): string {
  return change.literalMember === undefined
    ? change.symbol
    : `${change.symbol}.${change.literalMember}`;
}

export function formatFindings(findings: readonly Finding[]): string {
  return findings
    .map((finding) => {
      const where =
        finding.literalMember !== undefined
          ? deprecationSymbol(finding)
          : finding.member === ""
            ? finding.symbol
            : `${finding.symbol}.${finding.member}`;
      const head = `${finding.file}: ${where} ${finding.kind}`;
      return [head, ...finding.problems.map((problem) => `    - ${problem}`)].join("\n");
    })
    .join("\n\n");
}

// --- the CLI -----------------------------------------------------------------------------

const USAGE = `Usage: pnpm api:diff

Fails when a member left or changed shape in a committed etc/*.api.md without the two-release
deprecation the versioning policy requires. The baseline is the merge base with
CHANGESET_CHECK_BASE (default main); on main itself it is the last commit that changed the
fixed group's versions.`;

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: CORE_ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.trim() ?? ""}`);
  }
  return result.stdout.trim();
}

function show(ref: string, path: string): string {
  const result = spawnSync("git", ["show", `${ref}:${path}`], { cwd: CORE_ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout : "";
}

/** `packages/<dir>/package.json` for the fixed group — the private ones do not move with it. */
function publishedManifests(): string[] {
  return readdirSync(join(CORE_ROOT, "packages"))
    .map((dir) => ({ dir, path: join(CORE_ROOT, "packages", dir, "package.json") }))
    .filter(({ path }) => existsSync(path))
    .filter(({ path }) => {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as { private?: boolean };
      return manifest.private !== true;
    })
    .map(({ dir }) => `packages/${dir}/package.json`);
}

/**
 * The release commit: the most recent one that *moved* a published package's `version`. Both a
 * removed and an added line are required — a commit that introduces a package writes only the
 * added one, and a new package is not a release.
 */
function lastVersionCommit(): string {
  const manifests = publishedManifests();
  const commits = git("log", "--format=%H", "-50", "--", ...manifests).split("\n");
  for (const commit of commits.filter(Boolean)) {
    const diff = git("show", "--format=", "--unified=0", commit, "--", ...manifests);
    if (/^-\s*"version":/m.test(diff) && /^\+\s*"version":/m.test(diff)) return commit;
  }
  throw new Error("No commit in the last 50 touching a published package.json bumped a version.");
}

function baselineRef(): string {
  const base = (process.env.CHANGESET_CHECK_BASE ?? "main").replace(/^refs\/heads\//, "");
  const baseRef = process.env.CHANGESET_CHECK_BASE_REF ?? `origin/${base}`;
  const mergeBase = git("merge-base", baseRef, "HEAD");
  // On the base branch itself the merge base is HEAD, and diffing HEAD against HEAD would pass
  // everything; the last release is the only meaningful baseline there.
  return mergeBase === git("rev-parse", "HEAD") ? lastVersionCommit() : mergeBase;
}

function reportPaths(ref: string): string[] {
  const tracked = git("ls-tree", "-r", "--name-only", ref).split("\n");
  return tracked.filter((path) => /^packages\/[^/]+\/etc\/[^/]+\.api\.md$/.test(path));
}

function main(): void {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return;
  }

  const base = baselineRef();
  const paths = [...new Set([...reportPaths(base), ...reportPaths("HEAD")])].sort();

  const reports: ReportPair[] = paths.map((path) => {
    const dir = /^packages\/([^/]+)\//.exec(path)?.[1] ?? "";
    const manifest = JSON.parse(
      readFileSync(join(CORE_ROOT, "packages", dir, "package.json"), "utf8"),
    ) as { name: string; version: string };
    const absolute = join(CORE_ROOT, path);
    return {
      package: manifest.name,
      version: manifest.version,
      file: path,
      baseline: show(base, path),
      head: existsSync(absolute) ? readFileSync(absolute, "utf8") : "",
    };
  });

  const deprecationsFile = join(CORE_ROOT, "deprecations.json");
  const deprecations = parseDeprecations(readFileSync(deprecationsFile, "utf8"));

  const added = git("diff", "--name-only", "--diff-filter=A", base, "HEAD")
    .split("\n")
    .filter((path) => path.startsWith(".changeset/") && path.endsWith(".md"))
    .filter((path) => !path.endsWith("README.md"));
  const bump = changesetBump(
    added
      .map((path) => resolve(CORE_ROOT, path))
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path, "utf8")),
  );

  const findings = checkApiDiff({ reports, deprecations, bump });
  if (findings.length === 0) {
    console.log(`No unannounced API removal since ${base.slice(0, 12)} (changeset bump: ${bump}).`);
    return;
  }

  console.error(`The API reports lose members that the deprecation policy did not announce:

${formatFindings(findings)}

planning/hyperfixation-versioning-policy.md: an export leaves over two releases — marked in
deprecations.json and tagged @deprecated in release N, removed in N+1's minor.`);
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`) {
  main();
}
