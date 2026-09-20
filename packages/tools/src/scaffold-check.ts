import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { withTarballOverrides } from "./overrides.js";
import { packPublishable } from "./pack.js";
import { CORE_ROOT, templateDir } from "./proc.js";

const USAGE = `Usage: pnpm scaffold:check [--port <n>] [--keep]

Proves a fresh install of the packed CLI can scaffold an app and start it: packs every
publishable package, installs the nine tarballs into a throwaway global prefix, runs
\`hf new --local\` against the template checkout, then \`hf up\` until the web process answers
/api/status with 401, then the scaffolded app's own \`pnpm test\`.

  --port <n>   the port the app's web process listens on (default 3000)
  --keep       leave the temporary directory and the app's compose stack in place

Environment: HF_TEMPLATE_DIR (default ../hyperfixation-template), HF_TEST_DATABASE_URL.`;

/** The name the scratch app is scaffolded under; `hf new` derives its database from it. */
const APP = "scratch";

const BOOTSTRAP_EMAIL = "ci@example.invalid";
const BUDGET_USD = "10";

/**
 * How long `hf up` gets to install, bring compose up, migrate, bootstrap and serve its first
 * request. Generous because a cold runner pulls two images and a whole `node_modules`; the
 * point of the bound is that a wedged step fails the job rather than hanging it.
 */
const UP_TIMEOUT_MS = 360_000;

/**
 * How long a version must have been on the registry before this install will resolve it.
 *
 * Every pnpm install in this workspace and in the template already refuses anything younger
 * (`minimumReleaseAge`); npm has no such setting, so the same rule is passed as `--before`.
 * Without it a lockfile-free global install takes the newest of every range, and a family
 * mid-publish with one member still missing — `@peculiar/asn1-*` on 2026-09-20 — fails an
 * install that has nothing to do with this PR.
 */
const MINIMUM_RELEASE_AGE_MS = 24 * 60 * 60 * 1000;

/** `hf new` deletes this from the copy; finding one means a scaffolded app is a template. */
const TEMPLATE_MARKER = ".hyperfixation-template";

/** The tokens `hf new` substitutes. One left in the tree is an app that will not run. */
const PLACEHOLDERS = ["__APP_NAME__", "__DB_NAME__"];

/** Directories a scaffold check never reads; only `node_modules` can exist by then. */
const NOT_WALKED = new Set([".git", "node_modules", ".next", ".turbo", "dist"]);

export class ScaffoldError extends Error {}

/**
 * The negative half of the check: what a scaffolded app must *not* contain.
 *
 * A broken marker or a missed substitution leaves an app that installs and typechecks — the
 * checks that already run — and only fails later, on a database named `__DB_NAME__`. So they
 * are asserted directly, on the tree, before anything is installed into it.
 */
export async function scaffoldFindings(dir: string): Promise<string[]> {
  const findings: string[] = [];
  if (existsSync(join(dir, TEMPLATE_MARKER))) {
    findings.push(`${TEMPLATE_MARKER} survived the copy: the app is still a template source`);
  }
  for (const file of await walk(dir)) {
    // Read as bytes: a placeholder left in a binary file counts, and nothing here needs text.
    const contents = await readFile(file);
    for (const token of PLACEHOLDERS) {
      if (contents.includes(token)) findings.push(`${token} left in ${file.slice(dir.length + 1)}`);
    }
  }
  return findings;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (NOT_WALKED.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): boolean {
  console.log(`\n$ ${command} ${args.join(" ")}   (in ${options.cwd})`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  return result.status === 0;
}

/**
 * Installs every packed tarball into one throwaway global prefix, and returns its `bin`.
 *
 * All nine at once, rather than the CLI alone: `pnpm pack` rewrites the CLI's `workspace:*`
 * dependencies to this version, and installing its siblings beside it in the same global root
 * is what makes them resolve to the tarballs under test instead of to whatever npm has
 * published under that version.
 */
function installGlobally(prefix: string, tarballs: ReadonlyMap<string, string>): string {
  const before = new Date(Date.now() - MINIMUM_RELEASE_AGE_MS).toISOString();
  const ok = run(
    "npm",
    ["install", "--global", "--prefix", prefix, "--before", before, ...tarballs.values()],
    { cwd: prefix },
  );
  if (!ok) throw new ScaffoldError("npm install -g of the packed tarballs failed");
  return join(prefix, "bin");
}

/** Waits for the web process to answer `/api/status` with 401 — served, and asking for a token. */
async function untilUnauthorized(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + UP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new ScaffoldError(`hf up exited with ${child.exitCode} before ${url} answered`);
    }
    try {
      const response = await fetch(url);
      if (response.status === 401) return;
      console.log(`  ${url} answered ${response.status}, waiting for 401`);
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 2_000));
  }
  throw new ScaffoldError(`${url} did not answer 401 within ${UP_TIMEOUT_MS / 1000}s`);
}

type Running = { readonly child: ChildProcess; stop: () => Promise<void> };

/**
 * `hf up` in the background. It ends in `pnpm dev`, which runs until interrupted, so it is
 * spawned into its own process group and the whole group is signalled — killing the `hf`
 * process alone would leave `next dev` holding the port.
 *
 * Its output is inherited rather than buffered: everything it prints is already the job's log,
 * which is what there is to read when the wait below times out.
 */
function startUp(appDir: string, env: NodeJS.ProcessEnv): Running {
  console.log(`\n$ hf up   (in ${appDir})`);
  const child = spawn("hf", ["up"], { cwd: appDir, env, detached: true, stdio: "inherit" });
  return {
    child,
    stop: async () => {
      const pid = child.pid;
      if (child.exitCode !== null || pid === undefined) return;
      await new Promise<void>((done) => {
        child.once("exit", () => done());
        process.kill(-pid, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // already gone
          }
          done();
        }, 5_000).unref();
      });
    },
  };
}

type Step = { readonly name: string; readonly ms: number; readonly ok: boolean };

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "3000" },
      keep: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const template = templateDir();
  if (!existsSync(join(template, "package.json"))) {
    console.error(`No template checkout at ${template}. Set HF_TEMPLATE_DIR.`);
    return 1;
  }

  const work = await mkdtemp(join(tmpdir(), "hf-scaffold-check-"));
  const tarballDir = join(work, "tarballs");
  const prefix = join(work, "global");
  const appDir = join(work, APP);
  const steps: Step[] = [];
  let failed = false;

  const step = async (name: string, body: () => boolean | Promise<boolean>): Promise<void> => {
    if (failed) return;
    const started = Date.now();
    let ok = false;
    try {
      ok = await body();
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
    steps.push({ name, ms: Date.now() - started, ok });
    if (!ok) failed = true;
  };

  let up: Running | undefined;
  try {
    console.log(`core:     ${CORE_ROOT}`);
    console.log(`template: ${template}`);
    console.log(`scratch:  ${work}`);
    await mkdir(prefix, { recursive: true });

    await step("build core", () => run("pnpm", ["-r", "build"], { cwd: CORE_ROOT }));

    let tarballs = new Map<string, string>();
    await step("pack core", async () => {
      tarballs = await packPublishable(tarballDir);
      console.log([...tarballs.values()].map((t) => `  ${basename(t)}`).join("\n"));
      return tarballs.size > 0;
    });

    let env = process.env;
    await step("install the packed CLI globally", () => {
      const bin = installGlobally(prefix, tarballs);
      env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        // `hf up` runs a plain `pnpm install`, and pnpm freezes the lockfile whenever CI is
        // set. The overrides written below are exactly what the app's copied lockfile does
        // not have yet, so this install has to be allowed to re-resolve.
        npm_config_frozen_lockfile: "false",
        // The app's tests provision a database each off an admin connection; the app's own
        // compose postgres is the one running by then.
        HF_TEST_DATABASE_URL:
          process.env.HF_TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres",
      };
      return true;
    });

    await step("hf new --local", () =>
      run(
        "hf",
        [
          "new",
          APP,
          "--local",
          "--from",
          template,
          "--into",
          work,
          "--email",
          BOOTSTRAP_EMAIL,
          "--budget-usd",
          BUDGET_USD,
        ],
        { cwd: work, env },
      ),
    );

    await step("the app is no longer a template", async () => {
      const findings = await scaffoldFindings(appDir);
      for (const finding of findings) console.error(`  ${finding}`);
      return findings.length === 0;
    });

    await step("point the app at the packed tarballs", async () => {
      const settings = join(appDir, "pnpm-workspace.yaml");
      const before = existsSync(settings) ? await readFile(settings, "utf8") : "";
      await writeFile(settings, withTarballOverrides(before, tarballs));
      return true;
    });

    const status = `http://127.0.0.1:${values.port}/api/status`;
    await step(`hf up until ${status} answers 401`, async () => {
      up = startUp(appDir, env);
      await untilUnauthorized(status, up.child);
      return true;
    });

    await step("the app's own tests", () => run("pnpm", ["test"], { cwd: appDir, env }));
  } finally {
    await up?.stop();
    if (values.keep) console.log(`\nKept ${work}`);
    else {
      if (existsSync(join(appDir, "docker-compose.yml"))) {
        run("docker", ["compose", "-f", "docker-compose.yml", "down", "-v"], { cwd: appDir });
      }
      await rm(work, { recursive: true, force: true });
    }
  }

  const width = Math.max(...steps.map((s) => s.name.length));
  console.log(`\nscaffold:check — ${failed ? "FAIL" : "PASS"}`);
  for (const { name, ms, ok } of steps) {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(width)}  ${(ms / 1000).toFixed(1)}s`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
