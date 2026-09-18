import { stat } from "node:fs/promises";
import path from "node:path";
import { resolveApp, type ResolvedApp } from "./app.js";
import { run } from "./spawn.js";

/** Postgres and mailpit, and nothing else; the app itself runs on the host under `hf dev`. */
export const DEV_COMPOSE_FILE = "docker-compose.yml";

/**
 * The version a local process runs under.
 *
 * `startWorker()` refuses an `HF_BUILD_SHA` shorter than seven characters and DBOS treats it as
 * the `applicationVersion`, which is the thing a redeploy changes. A timestamp is what makes a
 * restart of `hf dev` look like a redeploy — the run model's bump path is then exercised by an
 * ordinary edit-and-restart loop rather than only by the redeploy suite — and the `dev-` prefix
 * is what guarantees it can never collide with a deployed commit sha.
 */
export function devBuildSha(now: number = Date.now()): string {
  return `dev-${String(now)}`;
}

export interface DevOptions {
  dir?: string;
  /** Skips `docker compose up`; for a database that is already running elsewhere. */
  skipCompose?: boolean;
  /** Runs `docker compose up` and `hf migrate`'s prerequisites, then stops. */
  composeOnly?: boolean;
  buildSha?: string;
}

export interface DevResult {
  app: ResolvedApp;
  buildSha: string;
}

/**
 * `hf dev` — the dev infrastructure, then the app's own `dev` script under a version the worker
 * will accept.
 *
 * It runs `pnpm dev` rather than reimplementing it: `next dev` is the app's to configure, and
 * the one thing the app's script cannot do for itself is invent a build sha, because a value
 * committed to `.env` would be the same "version" across every restart and a redeploy that
 * changed nothing is not a redeploy.
 */
export async function dev(options: DevOptions = {}): Promise<DevResult> {
  const app = await resolveApp(options.dir);
  const buildSha = options.buildSha ?? devBuildSha();

  if (options.skipCompose !== true && (await isFile(path.join(app.dir, DEV_COMPOSE_FILE)))) {
    await run("docker", ["compose", "-f", DEV_COMPOSE_FILE, "up", "-d", "--wait"], {
      cwd: app.dir,
    });
  }

  if (options.composeOnly === true) return { app, buildSha };

  await run("pnpm", ["dev"], {
    cwd: app.dir,
    env: { ...app.env, HF_PROCESS: "web", HF_BUILD_SHA: buildSha },
  });

  return { app, buildSha };
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}
