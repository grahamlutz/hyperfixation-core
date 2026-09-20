import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CORE_ROOT } from "./proc.js";

/** `pnpm -r pack` packs private packages too — unlike `pnpm -r publish`, which skips them. */
export async function publishableFilters(): Promise<string[]> {
  const packages = join(CORE_ROOT, "packages");
  const manifests = await readdir(packages, { withFileTypes: true });
  const filters: string[] = [];
  for (const entry of manifests.filter((e) => e.isDirectory())) {
    const manifest = join(packages, entry.name, "package.json");
    if (!existsSync(manifest)) continue;
    const { name, private: isPrivate } = JSON.parse(await readFile(manifest, "utf8")) as {
      name: string;
      private?: boolean;
    };
    if (isPrivate !== true) filters.push("--filter", name);
  }
  return filters;
}

export function packCorePackages(
  destination: string,
  filters: readonly string[],
): Map<string, string> {
  const result = spawnSync(
    "pnpm",
    ["-r", ...filters, "pack", "--pack-destination", destination, "--json"],
    { cwd: CORE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  if (result.status !== 0) throw new Error("pnpm -r pack failed");
  const packed = JSON.parse(result.stdout) as { name: string; filename: string }[];
  return new Map(packed.map(({ name, filename }) => [name, filename]));
}

/** Package name to tarball path for every publishable package, as both checks install them. */
export async function packPublishable(destination: string): Promise<Map<string, string>> {
  return packCorePackages(destination, await publishableFilters());
}
