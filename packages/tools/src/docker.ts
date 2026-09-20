import { capture } from "./proc.js";

/** The dev cluster's container, as `hf dev` and the plan's `docker run` name it. */
export const PG_CONTAINER = "hyperfixation-pg";

/** The port `packages/testing`'s `ADMIN_URL` default expects it on. */
export const PG_PORT = 5434;

/**
 * Build cache only, and only down to 4 GB. `docker builder prune` is `docker buildx prune`,
 * whose `--keep-storage` was renamed `--reserved-space` in buildx 0.37.
 */
export const BUILDER_PRUNE_ARGV = [
  "builder",
  "prune",
  "--force",
  "--reserved-space",
  "4GB",
] as const;

/**
 * Dangling images only. `-a` would take every image no container is currently running — the
 * pgvector and node bases a dev machine rebuilds from — and `docker system prune` or any
 * `--volumes` would reach the `hyperfixation-pg` data volume, which is the one thing on this
 * machine that is not reproducible.
 */
export const IMAGE_PRUNE_ARGV = ["image", "prune", "-f"] as const;

export interface DiskUsage {
  freeKb: number;
  usePercent: number;
}

/** The `df -k` body line: filesystem, 1K-blocks, used, available, use%, mountpoint. */
export function parseDf(output: string): DiskUsage | undefined {
  const line = output.trim().split("\n").at(-1) ?? "";
  const fields = line.trim().split(/\s+/);
  if (fields.length < 6) return undefined;
  const freeKb = Number(fields[3]);
  const usePercent = Number(fields[4]?.replace("%", ""));
  if (!Number.isFinite(freeKb) || !Number.isFinite(usePercent)) return undefined;
  return { freeKb, usePercent };
}

export interface ContainerState {
  exists: boolean;
  running: boolean;
  restartPolicy: string;
  volumes: readonly string[];
}

/** An anonymous volume's name is the 64-hex id docker generated for it. */
export function isAnonymousVolume(name: string): boolean {
  return /^[0-9a-f]{64}$/.test(name);
}

export function colimaRunning(): boolean {
  return capture("colima", ["status"]).ok;
}

export function dockerDiskUsage(): DiskUsage | undefined {
  const df = capture("colima", ["ssh", "--", "df", "-k", "/var/lib/docker"]);
  return df.ok ? parseDf(df.stdout) : undefined;
}

export function buildxPresent(): boolean {
  return capture("docker", ["buildx", "version"]).ok;
}

export function inspectContainer(name: string): ContainerState {
  const result = capture("docker", [
    "inspect",
    name,
    "--format",
    "{{.State.Running}}\t{{.HostConfig.RestartPolicy.Name}}\t{{range .Mounts}}{{.Name}} {{end}}",
  ]);
  if (!result.ok) return { exists: false, running: false, restartPolicy: "", volumes: [] };
  const [running = "", restartPolicy = "", mounts = ""] = result.stdout.trim().split("\t");
  return {
    exists: true,
    running: running === "true",
    restartPolicy,
    volumes: mounts.split(/\s+/).filter((mount) => mount.length > 0),
  };
}
