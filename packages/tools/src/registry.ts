import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const NPMJS_REGISTRY = "https://registry.npmjs.org";

export type ExecResult = { readonly status: number; readonly stdout: string };

export type ExecOptions = {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Capture stdout instead of inheriting it — for the commands whose output is parsed. */
  readonly capture?: boolean;
};

export type Exec = (
  command: string,
  args: readonly string[],
  options: ExecOptions,
) => ExecResult;

export const spawnExec: Exec = (command, args, options) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture === true ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
};

export type VersionDocument = { readonly status: number; readonly integrity?: string };

/** What `Accept: application/vnd.npm.install-v1+json` serves: the document an installer resolves from. */
export type AbbreviatedPackument = {
  readonly status: number;
  readonly versions?: readonly string[];
  readonly latest?: string;
};

export interface RegistryClient {
  readonly url: string;
  versionDocument(name: string, version: string): Promise<VersionDocument>;
}

/**
 * A client that can also read the abbreviated packument. A per-version document being a `200`
 * does not mean an installer can see the version: npmjs serves the two from different caches,
 * and the 0.1.8 release opened a bump PR in the minute the packument was still stale.
 */
export interface PackumentRegistryClient extends RegistryClient {
  abbreviatedPackument(name: string): Promise<AbbreviatedPackument>;
}

/**
 * The per-version document, not the full packument: npmjs serves a cached packument that 404s
 * for minutes after a publish, so `npm view` would report a published package as missing and
 * the already-published skip would re-publish it.
 */
export function versionDocumentUrl(registry: string, name: string, version: string): string {
  return `${registry.replace(/\/+$/, "")}/${name.replace("/", "%2f")}/${version}`;
}

export function abbreviatedPackumentUrl(registry: string, name: string): string {
  return `${registry.replace(/\/+$/, "")}/${name.replace("/", "%2f")}`;
}

export function httpRegistryClient(url: string = NPMJS_REGISTRY): PackumentRegistryClient {
  return {
    url,
    async versionDocument(name, version) {
      const response = await fetch(versionDocumentUrl(url, name, version), {
        headers: { accept: "application/json" },
      });
      if (!response.ok) return { status: response.status };
      const document = (await response.json()) as { dist?: { integrity?: string } };
      return { status: response.status, integrity: document.dist?.integrity };
    },
    async abbreviatedPackument(name) {
      const response = await fetch(abbreviatedPackumentUrl(url, name), {
        headers: { accept: "application/vnd.npm.install-v1+json" },
      });
      if (!response.ok) return { status: response.status };
      const document = (await response.json()) as {
        versions?: Record<string, unknown>;
        "dist-tags"?: Record<string, string>;
      };
      return {
        status: response.status,
        versions: Object.keys(document.versions ?? {}),
        latest: document["dist-tags"]?.latest,
      };
    },
  };
}

/**
 * How long a freshly published version document may keep 404ing. Observed on the 0.1.1 publish:
 * `npm view` answered immediately while the per-version document 404ed for about a minute — but
 * on 0.1.9 `@hyperfixation/admin` spent the whole 180s window at 404 with the tarball already
 * uploaded, so the old window was shorter than npmjs's worst case, not longer.
 */
export const PROPAGATION_WINDOW_MS = 900_000;

const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;

export type PropagationWait = {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly windowMs?: number;
};

const realSleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

/** The document, retrying a 404 with backoff until the propagation window is spent. */
export async function awaitVersionDocument(
  registry: RegistryClient,
  name: string,
  version: string,
  wait: PropagationWait = {},
): Promise<{ readonly document: VersionDocument; readonly waitedMs: number }> {
  const sleep = wait.sleep ?? realSleep;
  const windowMs = wait.windowMs ?? PROPAGATION_WINDOW_MS;
  let document = await registry.versionDocument(name, version);
  let waitedMs = 0;
  let delay = FIRST_RETRY_MS;
  while (document.status === 404 && waitedMs < windowMs) {
    const next = Math.min(delay, windowMs - waitedMs);
    await sleep(next);
    waitedMs += next;
    delay = Math.min(delay * 2, MAX_RETRY_MS);
    document = await registry.versionDocument(name, version);
  }
  return { document, waitedMs };
}

/** Why an installer cannot yet resolve `version` from this packument, or `undefined` when it can. */
export function packumentMiss(
  name: string,
  version: string,
  packument: AbbreviatedPackument,
): string | undefined {
  if (packument.status !== 200) return `${name} packument is HTTP ${packument.status}`;
  if (!(packument.versions ?? []).includes(version)) {
    return `${name} packument does not list ${version}`;
  }
  if (packument.latest !== version) {
    return `${name} packument has dist-tags.latest ${packument.latest ?? "(absent)"}, not ${version}`;
  }
  return undefined;
}

export type PackumentMiss = { readonly name: string; readonly reason: string };

async function packumentMisses(
  registry: PackumentRegistryClient,
  names: readonly string[],
  version: string,
): Promise<PackumentMiss[]> {
  const misses: PackumentMiss[] = [];
  for (const name of names) {
    const reason = packumentMiss(name, version, await registry.abbreviatedPackument(name));
    if (reason !== undefined) misses.push({ name, reason });
  }
  return misses;
}

/**
 * Polls until every name's abbreviated packument serves `version`, with the same backoff and
 * window as `awaitVersionDocument`. A `pnpm update` run before this holds resolves the version
 * the packument still names, which is how release 0.1.8 pinned three packages a release behind.
 */
export async function awaitInstallable(
  registry: PackumentRegistryClient,
  names: readonly string[],
  version: string,
  wait: PropagationWait = {},
): Promise<{ readonly misses: readonly PackumentMiss[]; readonly waitedMs: number }> {
  const sleep = wait.sleep ?? realSleep;
  const windowMs = wait.windowMs ?? PROPAGATION_WINDOW_MS;
  let misses = await packumentMisses(registry, names, version);
  let waitedMs = 0;
  let delay = FIRST_RETRY_MS;
  while (misses.length > 0 && waitedMs < windowMs) {
    const next = Math.min(delay, windowMs - waitedMs);
    await sleep(next);
    waitedMs += next;
    delay = Math.min(delay * 2, MAX_RETRY_MS);
    misses = await packumentMisses(
      registry,
      misses.map((miss) => miss.name),
      version,
    );
  }
  return { misses, waitedMs };
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function isLocalRegistry(url: string): boolean {
  const hostname = host(url);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/** npm's `dist.integrity` format for a tarball. */
export async function tarballIntegrity(file: string): Promise<string> {
  return `sha512-${createHash("sha512")
    .update(await readFile(file))
    .digest("base64")}`;
}

export type Manifest = {
  readonly name: string;
  readonly version: string;
  readonly dir: string;
  readonly dependencies: Readonly<Record<string, string>>;
};

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

type RawManifest = {
  name?: string;
  version?: string;
  private?: boolean;
} & Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>>;

function dependenciesOf(raw: RawManifest): Record<string, string> {
  return Object.assign({}, ...DEPENDENCY_FIELDS.map((field) => raw[field] ?? {})) as Record<
    string,
    string
  >;
}

/** The names of the fixed version group — the packages a release publishes together. */
export async function readFixedGroup(root: string): Promise<string[]> {
  const config = JSON.parse(await readFile(join(root, ".changeset/config.json"), "utf8")) as {
    fixed?: string[][];
  };
  const group = config.fixed?.[0] ?? [];
  if (group.length === 0) throw new Error(`No fixed group in ${root}/.changeset/config.json`);
  return group;
}

/** The fixed group's manifests, in `packages/*` order; throws if the group names one that is absent. */
export async function readGroupManifests(
  root: string,
  group: readonly string[],
): Promise<Manifest[]> {
  const byName = new Map<string, Manifest>();
  const packages = join(root, "packages");
  for (const entry of await readdir(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packages, entry.name);
    const file = join(dir, "package.json");
    if (!existsSync(file)) continue;
    const raw = JSON.parse(await readFile(file, "utf8")) as RawManifest;
    if (raw.name === undefined) continue;
    byName.set(raw.name, {
      name: raw.name,
      version: raw.version ?? "",
      dir,
      dependencies: dependenciesOf(raw),
    });
  }
  return group.map((name) => {
    const manifest = byName.get(name);
    if (manifest === undefined) throw new Error(`${name} is in the fixed group but not in ${packages}`);
    return manifest;
  });
}

export function versionMismatches(
  manifests: readonly Manifest[],
  version: string,
): string[] {
  return manifests
    .filter((manifest) => manifest.version !== version)
    .map((manifest) => `${manifest.name} is at ${manifest.version || "(no version)"}, not ${version}`);
}

/**
 * Publish order: a package's dependents go after it. npm resolves a dependency range at install
 * time, so a consumer published first is briefly uninstallable.
 */
export function topologicalOrder(manifests: readonly Manifest[]): string[] {
  const names = new Set(manifests.map((manifest) => manifest.name));
  const remaining = new Map(
    manifests.map((manifest) => [
      manifest.name,
      new Set(Object.keys(manifest.dependencies).filter((dep) => names.has(dep))),
    ]),
  );
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, deps]) => [...deps].every((dep) => ordered.includes(dep)))
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) throw new Error(`Dependency cycle among ${[...remaining.keys()].join(", ")}`);
    for (const name of ready) {
      ordered.push(name);
      remaining.delete(name);
    }
  }
  return ordered;
}

/** Packs the named packages and returns name → tarball path. */
export function packPackages(
  exec: Exec,
  root: string,
  names: readonly string[],
  destination: string,
): Map<string, string> {
  const filters = names.flatMap((name) => ["--filter", name]);
  const result = exec(
    "pnpm",
    ["-r", ...filters, "pack", "--pack-destination", destination, "--json"],
    { cwd: root, capture: true },
  );
  if (result.status !== 0) throw new Error("pnpm -r pack failed");
  const packed = JSON.parse(result.stdout) as { name: string; filename: string }[];
  return new Map(packed.map(({ name, filename }) => [name, filename]));
}

/**
 * `workspace:*` is rewritten to a real range by `pnpm pack`, not by `pnpm publish` — so the
 * packed manifest is the only place the rewrite can be checked before the tarball is uploaded.
 */
export function workspaceRangeLeftovers(
  exec: Exec,
  root: string,
  tarballs: ReadonlyMap<string, string>,
): string[] {
  const leftovers: string[] = [];
  for (const [name, tarball] of tarballs) {
    const result = exec("tar", ["-xzOf", tarball, "package/package.json"], {
      cwd: root,
      capture: true,
    });
    if (result.status !== 0) throw new Error(`Could not read the packed manifest of ${name}`);
    const raw = JSON.parse(result.stdout) as RawManifest;
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dependency, range] of Object.entries(raw[field] ?? {})) {
        if (range.startsWith("workspace:")) {
          leftovers.push(`${name} ${field}["${dependency}"] is still ${range}`);
        }
      }
    }
  }
  return leftovers;
}

export type RegistryComparison = {
  readonly name: string;
  readonly document: VersionDocument;
  readonly waitedMs: number;
  /** The integrity of the tarball packed here; absent when the document never arrived. */
  readonly local: string | undefined;
};

/** Each package's version document beside the integrity of the tarball packed locally. */
export async function compareTarballs(
  registry: RegistryClient,
  version: string,
  tarballs: ReadonlyMap<string, string>,
  integrityOf: (tarball: string) => Promise<string> = tarballIntegrity,
  wait: PropagationWait = {},
): Promise<RegistryComparison[]> {
  const comparisons: RegistryComparison[] = [];
  for (const [name, tarball] of tarballs) {
    const { document, waitedMs } = await awaitVersionDocument(registry, name, version, wait);
    comparisons.push({
      name,
      document,
      waitedMs,
      local: document.status === 200 ? await integrityOf(tarball) : undefined,
    });
  }
  return comparisons;
}

/** Why the version document is not usable, or `undefined` when it is a 200. */
export function missingProblem(
  registryUrl: string,
  version: string,
  comparison: RegistryComparison,
): string | undefined {
  if (comparison.document.status === 200) return undefined;
  const waited = comparison.waitedMs > 0 ? ` after ${Math.round(comparison.waitedMs / 1000)}s` : "";
  return `${comparison.name}@${version} is not on ${registryUrl} (HTTP ${comparison.document.status}${waited})`;
}

/** How the registry's tarball differs from the one packed here, or `undefined` when it does not. */
export function integrityDifference(
  version: string,
  comparison: RegistryComparison,
): string | undefined {
  if (comparison.document.integrity === comparison.local) return undefined;
  return `${comparison.name}@${version} integrity is ${comparison.document.integrity ?? "(absent)"} on the registry, ${comparison.local ?? "(absent)"} locally`;
}

/** Step 6: every version document is present and its `dist.integrity` matches the local tarball. */
export async function registryProblems(
  registry: RegistryClient,
  version: string,
  tarballs: ReadonlyMap<string, string>,
  integrityOf: (tarball: string) => Promise<string> = tarballIntegrity,
  wait: PropagationWait = {},
): Promise<string[]> {
  const comparisons = await compareTarballs(registry, version, tarballs, integrityOf, wait);
  return comparisons.flatMap((comparison) => {
    const missing = missingProblem(registry.url, version, comparison);
    if (missing !== undefined) return [missing];
    return [integrityDifference(version, comparison)].filter(
      (problem): problem is string => problem !== undefined,
    );
  });
}

export function dispatchCommand(version: string): string {
  return [
    "gh api repos/grahamlutz/hyperfixation-template/dispatches",
    "-f event_type=hyperfixation-core-release",
    `-f client_payload[version]=${version}`,
  ].join(" ");
}
