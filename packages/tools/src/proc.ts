import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * The core checkout the worktrees hang off. `CORE_ROOT` is wherever this file was loaded from,
 * which for an agent's linked worktree is several directories down — and the sibling layout
 * `HF_TEMPLATE_DIR` defaults to is a sibling of the main checkout, not of a worktree.
 */
export function mainCheckout(): string {
  const common = capture("git", [
    "-C",
    CORE_ROOT,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return common.ok ? dirname(common.stdout.trim()) : CORE_ROOT;
}

export function templateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.HF_TEMPLATE_DIR ?? join(mainCheckout(), "../hyperfixation-template"));
}

export interface Captured {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command for its output. Nothing here throws on a non-zero exit or a missing binary:
 * every caller is a check that wants to report "colima is not installed" as a finding rather
 * than as a stack trace.
 */
export function capture(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Captured {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}
