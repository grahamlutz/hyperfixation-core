import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { withTarballOverrides } from "./overrides.js";
import { packPublishable } from "./pack.js";
import { CORE_ROOT } from "./proc.js";

const USAGE = `Usage: pnpm template:check [--full] [--registry <url>] [--keep]

Packs every publishable core package and runs the template's own checks against those
tarballs, in a copy of the template checkout — the user's checkout and its lockfile are
never written to.

  --full             also run the template's lint and \`next build\`
  --registry <url>   resolve the template's third-party dependencies from this registry
  --keep             leave the temporary directory in place for inspection

Environment: HF_TEMPLATE_DIR (default ../hyperfixation-template), HF_TEST_DATABASE_URL.`;

/** Everything a fresh install or build regenerates, plus the history the checks never read. */
const NOT_COPIED = new Set([".git", ".next", ".turbo", "node_modules", "dist"]);

/**
 * `next build` prerenders a page that reads the template's `REQUIRED_ENV` at build time, so it
 * needs values for them; these are the dummies the template's own CI build step passes.
 */
const BUILD_ENV = {
  HF_PROCESS: "web",
  DATABASE_URL: "postgres://unused",
  MIGRATOR_DATABASE_URL: "postgres://unused",
  APP_URL: "https://unused",
  BETTER_AUTH_SECRET: "unused",
  SMTP_URL: "smtp://unused",
  EMAIL_FROM: "unused@example.com",
  SENTRY_DSN: "",
  LANGFUSE_BASE_URL: "",
  LANGFUSE_PUBLIC_KEY: "",
  LANGFUSE_SECRET_KEY: "",
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
};

type Step = { readonly name: string; readonly ms: number; readonly ok: boolean };

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

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      full: { type: "boolean", default: false },
      registry: { type: "string" },
      keep: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const templateDir = resolve(
    process.env.HF_TEMPLATE_DIR ?? join(CORE_ROOT, "../hyperfixation-template"),
  );
  if (!existsSync(join(templateDir, "package.json"))) {
    console.error(`No template checkout at ${templateDir}. Set HF_TEMPLATE_DIR.`);
    return 1;
  }

  const work = await mkdtemp(join(tmpdir(), "hf-template-check-"));
  const tarballDir = join(work, "tarballs");
  const appDir = join(work, "template");
  const steps: Step[] = [];
  let failed = false;

  const step = async (name: string, body: () => boolean | Promise<boolean>): Promise<void> => {
    if (failed) return;
    const started = Date.now();
    let ok = false;
    try {
      ok = await body();
    } catch (error) {
      console.error(error);
    }
    steps.push({ name, ms: Date.now() - started, ok });
    if (!ok) failed = true;
  };

  try {
    console.log(`core:     ${CORE_ROOT}`);
    console.log(`template: ${templateDir}`);
    console.log(`scratch:  ${work}`);

    await step("build core", () => run("pnpm", ["-r", "build"], { cwd: CORE_ROOT }));

    let tarballs = new Map<string, string>();
    await step("pack core", async () => {
      tarballs = await packPublishable(tarballDir);
      console.log([...tarballs.values()].map((t) => `  ${basename(t)}`).join("\n"));
      return tarballs.size > 0;
    });

    await step("copy template and rewrite its overrides", async () => {
      await mkdir(appDir, { recursive: true });
      await cp(templateDir, appDir, {
        recursive: true,
        filter: (source) => !NOT_COPIED.has(basename(source)),
      });
      const settings = join(appDir, "pnpm-workspace.yaml");
      const before = existsSync(settings) ? await readFile(settings, "utf8") : "";
      await writeFile(settings, withTarballOverrides(before, tarballs));
      return true;
    });

    // The copy's lockfile pins the published `@hyperfixation/*`; the overrides above replace
    // them, so the install has to be allowed to re-resolve.
    const install = ["install", "--no-frozen-lockfile"];
    if (values.registry !== undefined) install.push("--registry", values.registry);

    // `flow-restart.test.ts` spawns a real worker and `startWorker()` refuses a version
    // shorter than 7 characters; the template's own CI passes the commit for the same reason.
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: CORE_ROOT, encoding: "utf8" });
    const env = {
      ...process.env,
      HF_BUILD_SHA: process.env.HF_BUILD_SHA ?? head.stdout.trim(),
    };

    await step("install template", () => run("pnpm", install, { cwd: appDir, env }));
    await step("template typecheck", () => run("pnpm", ["typecheck"], { cwd: appDir, env }));
    if (values.full) await step("template lint", () => run("pnpm", ["lint"], { cwd: appDir, env }));
    await step("template test", () => run("pnpm", ["test"], { cwd: appDir, env }));
    if (values.full) {
      await step("template build", () =>
        run("pnpm", ["build"], { cwd: appDir, env: { ...env, ...BUILD_ENV } }),
      );
    }
  } finally {
    if (values.keep) console.log(`\nKept ${work}`);
    else await rm(work, { recursive: true, force: true });
  }

  const width = Math.max(...steps.map((s) => s.name.length));
  console.log(`\ntemplate:check — ${failed ? "FAIL" : "PASS"}`);
  for (const { name, ms, ok } of steps) {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(width)}  ${(ms / 1000).toFixed(1)}s`);
  }
  return failed ? 1 : 0;
}

process.exitCode = await main();
