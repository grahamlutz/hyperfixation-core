import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidAppName } from "./names.js";
import { newApp, TEMPLATE_MARKER, TemplateError } from "./new.js";
import { findTemplateSource } from "./template-source.js";

let workspace: string;
let source: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "hf-new-"));
  source = path.join(workspace, "template");
  await mkdir(path.join(source, "src"), { recursive: true });
  await mkdir(path.join(source, "node_modules", "left-behind"), { recursive: true });
  await writeFile(path.join(source, TEMPLATE_MARKER), "placeholders:\n  - __APP_NAME__\n");
  await writeFile(path.join(source, "package.json"), '{ "name": "__APP_NAME__" }\n');
  await writeFile(
    path.join(source, ".env.example"),
    "DATABASE_URL=postgres://hf___APP_NAME__@localhost:5432/__DB_NAME__\n",
  );
  await writeFile(path.join(source, "src", "hyperfixation.ts"), 'name: "__APP_NAME__",\n');
  await writeFile(path.join(source, "node_modules", "left-behind", "index.js"), "");
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Every test but the email-prompt ones passes `--email` so none of them block on real stdin. */
const NO_PROMPT = "skip@example.com";

describe("hf new --local", () => {
  it("copies the template, substitutes both placeholders, and removes the marker", async () => {
    const result = await newApp({
      name: "demo-app",
      from: source,
      into: workspace,
      local: true,
      email: NO_PROMPT,
    });

    expect(result.dir).toBe(path.join(workspace, "demo-app"));
    expect(await readFile(path.join(result.dir, "package.json"), "utf8")).toBe(
      '{ "name": "demo_app" }\n',
    );
    expect(await readFile(path.join(result.dir, "src", "hyperfixation.ts"), "utf8")).toBe(
      'name: "demo_app",\n',
    );
    expect(await readdir(result.dir)).not.toContain(TEMPLATE_MARKER);
    expect(result.substituted).toContain("package.json");
  });

  it("derives the application role and the database from the same underscored name", async () => {
    const result = await newApp({
      name: "demo-app",
      from: source,
      into: workspace,
      local: true,
      email: NO_PROMPT,
    });

    expect(await readFile(path.join(result.dir, ".env.example"), "utf8")).toBe(
      "DATABASE_URL=postgres://hf_demo_app@localhost:5432/hf_demo_app\n",
    );
  });

  it("writes .env from the substituted .env.example, so the app is runnable as copied", async () => {
    const result = await newApp({
      name: "demo-app",
      from: source,
      into: workspace,
      local: true,
      email: NO_PROMPT,
    });

    expect(result.wroteEnv).toBe(true);
    expect(await readFile(path.join(result.dir, ".env"), "utf8")).toBe(
      `${await readFile(path.join(result.dir, ".env.example"), "utf8")}HF_BOOTSTRAP_EMAIL=${NO_PROMPT}\n`,
    );
  });

  it("leaves node_modules behind", async () => {
    const result = await newApp({
      name: "demo-app",
      from: source,
      into: workspace,
      local: true,
      email: NO_PROMPT,
    });

    expect(await readdir(result.dir)).not.toContain("node_modules");
  });

  it("writes --email to .env as HF_BOOTSTRAP_EMAIL and skips the prompt", async () => {
    const result = await newApp({
      name: "demo-app",
      from: source,
      into: workspace,
      local: true,
      email: "graham@example.com",
    });

    expect(result.wroteBootstrapEmail).toBe(true);
    expect(await readFile(path.join(result.dir, ".env"), "utf8")).toContain(
      "HF_BOOTSTRAP_EMAIL=graham@example.com",
    );
  });

  it("prompts for the bootstrap email when --email is not given", async () => {
    let asked = false;
    const result = await newApp({
      name: "demo-app",
      from: source,
      into: workspace,
      local: true,
      promptEmail: async () => {
        asked = true;
        return "prompted@example.com";
      },
    });

    expect(asked).toBe(true);
    expect(result.wroteBootstrapEmail).toBe(true);
    expect(await readFile(path.join(result.dir, ".env"), "utf8")).toContain(
      "HF_BOOTSTRAP_EMAIL=prompted@example.com",
    );
  });

  it("leaves HF_BOOTSTRAP_EMAIL unwritten when the prompt answer is blank", async () => {
    const result = await newApp({
      name: "demo-app",
      from: source,
      into: workspace,
      local: true,
      promptEmail: async () => "",
    });

    expect(result.wroteBootstrapEmail).toBe(false);
    expect(await readFile(path.join(result.dir, ".env"), "utf8")).not.toContain(
      "HF_BOOTSTRAP_EMAIL",
    );
  });

  it("refuses a source with no marker rather than rewriting whatever is there", async () => {
    await rm(path.join(source, TEMPLATE_MARKER));

    await expect(
      newApp({ name: "demo-app", from: source, into: workspace, local: true }),
    ).rejects.toThrow(TEMPLATE_MARKER);
  });

  it("refuses a target directory that already exists", async () => {
    await mkdir(path.join(workspace, "demo-app"));

    await expect(
      newApp({ name: "demo-app", from: source, into: workspace, local: true }),
    ).rejects.toThrow(TemplateError);
  });

  it("refuses an invalid name before it creates anything", async () => {
    await expect(
      newApp({ name: "Demo App", from: source, into: workspace, local: true }),
    ).rejects.toThrow(InvalidAppName);
    expect(await readdir(workspace)).toEqual(["template"]);
  });

  it("refuses to run without --local, because the cloud half is Phase 3", async () => {
    await expect(
      newApp({ name: "demo-app", from: source, into: workspace, local: false }),
    ).rejects.toThrow("--local");
  });
});

describe("hf new against the real template checkout", () => {
  it("leaves no placeholder anywhere in the copy", async (ctx) => {
    const template = await findTemplateSource();
    if (template === undefined) ctx.skip();

    const result = await newApp({
      name: "demo-app",
      from: template as string,
      into: workspace,
      local: true,
      email: NO_PROMPT,
    });

    const leftovers: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && !full.endsWith(".png")) {
          const text = await readFile(full, "utf8");
          if (text.includes("__APP_NAME__") || text.includes("__DB_NAME__")) {
            leftovers.push(path.relative(result.dir, full));
          }
        }
      }
    };
    await walk(result.dir);

    expect(leftovers).toEqual([]);
    // The files track B put a placeholder in, all of them, through one copy.
    expect(result.substituted).toEqual(
      expect.arrayContaining([
        ".env.example",
        "CLAUDE.md",
        "README.md",
        "docker-compose.prod.yml",
        "docker-compose.yml",
        "drizzle.config.ts",
        "package.json",
        "src/env.ts",
        "src/hyperfixation.ts",
      ]),
    );
  }, 60_000);
});
