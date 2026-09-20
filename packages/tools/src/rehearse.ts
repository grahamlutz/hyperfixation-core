import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isScalar, parseDocument, YAMLMap } from "yaml";
import { defaultPublishDeps, publish, PublishError } from "./publish.js";
import { isLocalRegistry, readFixedGroup, spawnExec } from "./registry.js";

const TOOLS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_ROOT = resolve(TOOLS_ROOT, "../..");

const USAGE = `Usage: pnpm release:rehearse <version> [--port <n>] [--keep] [--skip-template]

Runs the whole publish path against a throwaway Verdaccio, then installs the published packages
into a scratch project and into a copy of the template checkout. Never talks to npmjs except as
a read-through cache for third-party dependencies.

  --port <n>         listen here instead of 4873 (or an ephemeral port if 4873 is taken)
  --keep             leave the temporary directories in place for inspection
  --skip-template    scratch project only

Environment: HF_TEMPLATE_DIR (default ../hyperfixation-template).`;

/** Everything a fresh install or build regenerates, plus the history the checks never read. */
const NOT_COPIED = new Set([".git", ".next", ".turbo", "node_modules", "dist"]);

export class RehearsalError extends Error {}

/** The one thing a rehearsal must never get wrong. */
export function assertLocalRegistry(url: string): void {
  if (!isLocalRegistry(url)) {
    throw new RehearsalError(`A rehearsal publishes only to localhost; ${url} is not local.`);
  }
}

export async function pickPort(preferred: number): Promise<number> {
  const listen = (port: number): Promise<number | undefined> =>
    new Promise((done) => {
      const server = createServer();
      server.once("error", () => done(undefined));
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        const bound = typeof address === "object" && address !== null ? address.port : undefined;
        server.close(() => done(bound));
      });
    });
  return (await listen(preferred)) ?? (await listen(0)) ?? preferred;
}

/**
 * Pins the template's `@hyperfixation/*` specs to the rehearsed version. The template's own
 * `^0.1.1` would resolve to whatever Verdaccio's npmjs uplink has, which is the published
 * package rather than the one under rehearsal.
 */
export function withVersionOverrides(
  workspaceYaml: string,
  names: readonly string[],
  version: string,
): string {
  const doc = parseDocument(workspaceYaml.trim().length > 0 ? workspaceYaml : "overrides: {}\n");
  const existing = doc.get("overrides");
  const overrides = existing instanceof YAMLMap ? existing : new YAMLMap();
  for (const item of [...overrides.items]) {
    const name = isScalar(item.key) ? String(item.key.value) : String(item.key);
    const value = String(overrides.get(name) ?? "");
    if (name.startsWith("@hyperfixation/") || value.startsWith("link:")) overrides.delete(name);
  }
  for (const name of [...names].sort()) overrides.set(name, version);
  doc.set("overrides", overrides);
  // Verdaccio serves the rehearsed version seconds after it is published.
  doc.set("minimumReleaseAge", 0);
  return doc.toString();
}

function verdaccioConfig(storage: string): string {
  return `storage: ${storage}
log: { type: stdout, format: pretty, level: warn }
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
    cache: true
packages:
  "@hyperfixation/*":
    access: $all
    publish: $anonymous
    unpublish: $anonymous
  "**":
    access: $all
    publish: $anonymous
    proxy: npmjs
`;
}

async function untilUp(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new RehearsalError(`Verdaccio exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/-/ping`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new RehearsalError(`Verdaccio did not come up on ${url}`);
}

export type Verdaccio = { readonly url: string; stop: () => Promise<void> };

export async function startVerdaccio(work: string, port: number): Promise<Verdaccio> {
  const config = join(work, "verdaccio.yaml");
  await mkdir(join(work, "storage"), { recursive: true });
  await writeFile(config, verdaccioConfig(join(work, "storage")));

  const child = spawn(
    "pnpm",
    ["exec", "verdaccio", "--config", config, "--listen", `127.0.0.1:${port}`],
    { cwd: TOOLS_ROOT, stdio: ["ignore", "inherit", "inherit"] },
  );
  const url = `http://127.0.0.1:${port}`;
  try {
    await untilUp(url, child);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return {
    url,
    stop: async () => {
      if (child.exitCode !== null) return;
      await new Promise<void>((done) => {
        child.once("exit", () => done());
        child.kill("SIGTERM");
        setTimeout(() => {
          child.kill("SIGKILL");
          done();
        }, 5_000).unref();
      });
    },
  };
}

async function writeScratchProject(
  dir: string,
  names: readonly string[],
  version: string,
): Promise<void> {
  const root = JSON.parse(await readFile(join(CORE_ROOT, "package.json"), "utf8")) as {
    devDependencies: Record<string, string>;
  };
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "hf-rehearsal-scratch",
        private: true,
        type: "module",
        scripts: { typecheck: "tsc -p tsconfig.json --noEmit" },
        dependencies: Object.fromEntries(names.map((name) => [name, version])),
        devDependencies: { typescript: root.devDependencies.typescript },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(dir, "pnpm-workspace.yaml"),
    // `allowBuilds` mirrors the core workspace: without it pnpm 12 fails the install over
    // esbuild's ignored postinstall, which tsx pulls in through the CLI.
    `minimumReleaseAge: 0\nminimumReleaseAgeExclude:\n  - "@hyperfixation/*"\nallowBuilds:\n  esbuild: true\n`,
  );
  await writeFile(
    join(dir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["src"],
      },
      null,
      2,
    )}\n`,
  );
  // Resolving each package's `types` entry is the check: a tarball missing `dist/index.d.ts`
  // or naming a dependency it does not ship fails here and nowhere else.
  await writeFile(
    join(dir, "src/index.ts"),
    `${names.map((name, index) => `import type * as p${index} from "${name}";`).join("\n")}

export type Installed = ${names.map((_, index) => `typeof p${index}`).join(" | ")};
`,
  );
}

type Step = { readonly name: string; readonly ms: number; readonly ok: boolean };

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", default: "4873" },
      keep: { type: "boolean", default: false },
      "skip-template": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const version = positionals[0];

  const work = await mkdtemp(join(tmpdir(), "hf-rehearse-"));
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

  let registry: Verdaccio | undefined;
  try {
    const port = await pickPort(Number(values.port));
    await step("start verdaccio", async () => {
      registry = await startVerdaccio(work, port);
      assertLocalRegistry(registry.url);
      // pnpm sends no credentials without one; the fake token never leaves localhost and no
      // .npmrc is written, which is the property the real publish path also holds.
      process.env[`npm_config_//127.0.0.1:${port}/:_authToken`] = "rehearsal";
      console.log(`verdaccio: ${registry.url}`);
      return true;
    });

    const names = await readFixedGroup(CORE_ROOT);

    await step("publish to verdaccio", async () => {
      if (registry === undefined) return false;
      assertLocalRegistry(registry.url);
      const result = await publish(
        { version, registry: registry.url, dryRun: false, yes: true, keep: false },
        defaultPublishDeps(registry.url),
      );
      return result.published.length === names.length;
    });

    const scratch = join(work, "scratch");
    await step("install into a scratch project", async () => {
      if (registry === undefined) return false;
      await writeScratchProject(scratch, names, version);
      return (
        spawnExec("pnpm", ["install", "--registry", registry.url], { cwd: scratch }).status === 0
      );
    });
    await step("scratch typecheck", () =>
      spawnExec("pnpm", ["typecheck"], { cwd: scratch }).status === 0);

    if (!values["skip-template"]) {
      const templateDir = resolve(
        process.env.HF_TEMPLATE_DIR ?? join(CORE_ROOT, "../hyperfixation-template"),
      );
      const appDir = join(work, "template");
      await step("copy the template and pin it to this version", async () => {
        if (!existsSync(join(templateDir, "package.json"))) {
          throw new RehearsalError(`No template checkout at ${templateDir}. Set HF_TEMPLATE_DIR.`);
        }
        await mkdir(appDir, { recursive: true });
        await cp(templateDir, appDir, {
          recursive: true,
          filter: (source) => !NOT_COPIED.has(basename(source)),
        });
        const settings = join(appDir, "pnpm-workspace.yaml");
        const before = existsSync(settings) ? await readFile(settings, "utf8") : "";
        await writeFile(settings, withVersionOverrides(before, names, version));
        return true;
      });
      await step("install the template", () => {
        if (registry === undefined) return false;
        return (
          spawnExec(
            "pnpm",
            ["install", "--no-frozen-lockfile", "--registry", registry.url],
            { cwd: appDir },
          ).status === 0
        );
      });
      await step("template typecheck", () =>
        spawnExec("pnpm", ["typecheck"], { cwd: appDir }).status === 0);
    }
  } finally {
    await registry?.stop();
    if (values.keep) console.log(`\nKept ${work}`);
    else await rm(work, { recursive: true, force: true });
  }

  const width = Math.max(...steps.map((s) => s.name.length));
  console.log(`\nrelease:rehearse ${version} — ${failed ? "FAIL" : "PASS"}`);
  for (const { name, ms, ok } of steps) {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(width)}  ${(ms / 1000).toFixed(1)}s`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    if (!(error instanceof PublishError) && !(error instanceof RehearsalError)) throw error;
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  }
}
