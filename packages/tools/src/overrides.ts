import { isScalar, parseDocument, YAMLMap } from "yaml";

export const SCOPE = "@hyperfixation/";

/**
 * pnpm 12 reads `overrides` from `pnpm-workspace.yaml` and no longer from `package.json` — the
 * template's own file says so, and its `minimumReleaseAgeExclude` / `allowBuilds` live there
 * too, so the rewrite edits the document in place rather than replacing it.
 *
 * `link:` overrides go with the `@hyperfixation/*` ones: a checkout that still carries the
 * Phase 1 development bridge points them into this core checkout's `node_modules`, which is
 * the layout the packed tarballs are here to replace.
 */
export function withTarballOverrides(
  workspaceYaml: string,
  tarballs: ReadonlyMap<string, string>,
): string {
  const doc = parseDocument(workspaceYaml.trim().length > 0 ? workspaceYaml : "overrides: {}\n");

  const existing = doc.get("overrides");
  const overrides = existing instanceof YAMLMap ? existing : new YAMLMap();
  for (const item of [...overrides.items]) {
    const name = isScalar(item.key) ? String(item.key.value) : String(item.key);
    const value = String(overrides.get(name) ?? "");
    if (name.startsWith(SCOPE) || value.startsWith("link:")) overrides.delete(name);
  }
  for (const [name, tarball] of [...tarballs].sort(([a], [b]) => a.localeCompare(b))) {
    overrides.set(name, `file:${tarball}`);
  }

  doc.set("overrides", overrides);
  return doc.toString();
}
