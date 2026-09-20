import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scaffoldFindings } from "./scaffold-check.js";

let app: string;

beforeEach(async () => {
  app = await mkdtemp(join(tmpdir(), "hf-scaffold-findings-"));
  await mkdir(join(app, "src"), { recursive: true });
  await writeFile(join(app, "package.json"), '{ "name": "scratch" }\n');
  await writeFile(join(app, "src", "hyperfixation.ts"), 'name: "scratch",\n');
});

afterEach(async () => {
  await rm(app, { recursive: true, force: true });
});

describe("scaffoldFindings", () => {
  it("passes a scaffolded app that kept no template of its own", async () => {
    expect(await scaffoldFindings(app)).toEqual([]);
  });

  it("reports a marker the copy did not delete", async () => {
    await writeFile(join(app, ".hyperfixation-template"), "");

    expect(await scaffoldFindings(app)).toEqual([
      expect.stringContaining(".hyperfixation-template"),
    ]);
  });

  it("reports an un-substituted placeholder, naming the file it is in", async () => {
    await writeFile(join(app, "src", "env.ts"), "const db = '__DB_NAME__';\n");

    expect(await scaffoldFindings(app)).toEqual(["__DB_NAME__ left in src/env.ts"]);
  });

  it("looks inside an installed app without walking its node_modules", async () => {
    await mkdir(join(app, "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(app, "node_modules", "left-pad", "index.js"), "// __APP_NAME__\n");

    expect(await scaffoldFindings(app)).toEqual([]);
  });
});
