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

export interface RegistryClient {
  readonly url: string;
  versionDocument(name: string, version: string): Promise<VersionDocument>;
}

/**
 * The per-version document, not the full packument: npmjs serves a cached packument that 404s
 * for minutes after a publish, so `npm view` would report a published package as missing and
 * the already-published skip would re-publish it.
 */
export function versionDocumentUrl(registry: string, name: string, version: string): string {
  return `${registry.replace(/\/+$/, "")}/${name.replace("/", "%2f")}/${version}`;
}

export function httpRegistryClient(url: string = NPMJS_REGISTRY): RegistryClient {
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
  };
}

/**
 * How long a freshly published version document may keep 404ing. Observed on the 0.1.1 publish:
 * `npm view` answered immediately while the per-version document 404ed for about a minute.
 */
export const PROPAGATION_WINDOW_MS = 180_000;

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

/** Step 6: every version document is present and its `dist.integrity` matches the local tarball. */
export async function registryProblems(
  registry: RegistryClient,
  version: string,
  tarballs: ReadonlyMap<string, string>,
  integrityOf: (tarball: string) => Promise<string> = tarballIntegrity,
  wait: PropagationWait = {},
): Promise<string[]> {
  const problems: string[] = [];
  for (const [name, tarball] of tarballs) {
    const { document, waitedMs } = await awaitVersionDocument(registry, name, version, wait);
    if (document.status !== 200) {
      const waited = waitedMs > 0 ? ` after ${Math.round(waitedMs / 1000)}s` : "";
      problems.push(
        `${name}@${version} is not on ${registry.url} (HTTP ${document.status}${waited})`,
      );
      continue;
    }
    const local = await integrityOf(tarball);
    if (document.integrity !== local) {
      problems.push(
        `${name}@${version} integrity is ${document.integrity ?? "(absent)"} on the registry, ${local} locally`,
      );
    }
  }
  return problems;
}

export function dispatchCommand(version: string): string {
  return [
    "gh api repos/grahamlutz/hyperfixation-template/dispatches",
    "-f event_type=hyperfixation-core-release",
    `-f client_payload[version]=${version}`,
  ].join(" ");
}
