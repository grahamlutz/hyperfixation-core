import { stat } from "node:fs/promises";
import path from "node:path";
import { BootstrapRefused } from "@hyperfixation/auth";
import { resolveApp, type ResolvedApp } from "./app.js";
import { bootstrapApp } from "./bootstrap.js";
import { ensureCompose } from "./dev.js";
import { migrateApp } from "./migrate.js";
import { run } from "./spawn.js";
import { statusTokenApp, type StatusTokenKind } from "./status-token.js";

/**
 * What `hf up` seeds `hf_app_state.budget_usd` with when `HF_BOOTSTRAP_BUDGET_USD` isn't set.
 * Local only: `hf bootstrap` itself still refuses to run without an explicit budget, so a
 * deployed app never starts under a cap nobody chose.
 */
export const DEV_BUDGET_USD = "10";

const BUDGET_ENV = "HF_BOOTSTRAP_BUDGET_USD";

export interface UpOptions {
  dir?: string;
}

export interface UpResult {
  app: ResolvedApp;
  installedDependencies: boolean;
  composeStarted: boolean;
  /** False when an admin already existed and `hf bootstrap` was skipped rather than rerun. */
  bootstrapped: boolean;
  /** True when this run seeded `DEV_BUDGET_USD` because the app's `.env` sets no budget. */
  budgetDefaulted: boolean;
  /** Which token kind(s) were generated this run; empty when both were already set. */
  tokensProvisioned: readonly StatusTokenKind[];
}

/**
 * `hf up` — the whole local QA loop in one idempotent command: install, infra, migrate,
 * bootstrap, status tokens, then `hf dev` in the foreground.
 *
 * Every step but the last is safe to rerun. `hf bootstrap` is the one step whose own contract is
 * "exactly once" (`BootstrapRefused` — an app gets one bootstrap admin, on purpose), so this
 * catches that specific refusal rather than asking `bootstrapApp` to change what it means; every
 * other step already no-ops on its own (`ensureCompose`'s `--wait`, `statusTokenApp`'s default
 * two-kind run leaving a set column alone). `hf dev` itself is the caller's to run afterward,
 * since it blocks in the foreground and this function is meant to return a result.
 */
export async function upApp(options: UpOptions = {}): Promise<UpResult> {
  const app = await resolveApp(options.dir);

  const installedDependencies = await needsInstall(app.dir);
  if (installedDependencies) await run("pnpm", ["install"], { cwd: app.dir });

  const composeStarted = await ensureCompose(app);

  await migrateApp({ dir: app.dir });

  const defaultsBudget = usesDefaultBudget(app);
  const bootstrapped = await bootstrapIfNeeded(app);

  const { tokens } = await statusTokenApp({ dir: app.dir });
  const tokensProvisioned = Object.keys(tokens) as StatusTokenKind[];

  return {
    app,
    installedDependencies,
    composeStarted,
    bootstrapped,
    budgetDefaulted: bootstrapped && defaultsBudget,
    tokensProvisioned,
  };
}

/** True when `node_modules` isn't there yet — `pnpm install` has never run for this app. */
export async function needsInstall(dir: string): Promise<boolean> {
  try {
    return !(await stat(path.join(dir, "node_modules"))).isDirectory();
  } catch {
    return true;
  }
}

/** True when the app's `.env` names no budget, so `hf up` will supply `DEV_BUDGET_USD`. */
export function usesDefaultBudget(app: ResolvedApp): boolean {
  const value = app.env[BUDGET_ENV];
  return value === undefined || value === "";
}

/** Runs `hf bootstrap`; swallows `BootstrapRefused` since the app already has its one admin. */
export async function bootstrapIfNeeded(app: ResolvedApp): Promise<boolean> {
  try {
    await bootstrapApp({
      dir: app.dir,
      budgetUsd: usesDefaultBudget(app) ? DEV_BUDGET_USD : undefined,
    });
    return true;
  } catch (error) {
    if (error instanceof BootstrapRefused) return false;
    throw error;
  }
}
