import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS, main, USAGE, type Io } from "./cli.js";
import { TEMPLATE_MARKER } from "./new.js";

function io(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

let workspace: string;
let source: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "hf-cli-"));
  source = path.join(workspace, "template");
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(path.join(source, TEMPLATE_MARKER), "placeholders:\n");
  await writeFile(path.join(source, "package.json"), '{ "name": "__APP_NAME__" }\n');
  await writeFile(path.join(source, ".env.example"), "DATABASE_URL=__DB_NAME__\n");
  await writeFile(path.join(source, "src", "hyperfixation.ts"), 'name: "__APP_NAME__",\n');
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("the hf binary's argument handling", () => {
  it("prints usage and fails when given nothing, because a bare hf did not ask for anything", async () => {
    const { io: sink, out } = io();

    expect(await main([], sink)).toBe(1);
    expect(out.join("\n")).toContain("hf new <name> --local");
  });

  it("prints usage and succeeds on --help", async () => {
    const { io: sink, out } = io();

    expect(await main(["--help"], sink)).toBe(0);
    expect(out.join("\n")).toContain("hf migrate");
  });

  it("names an unknown command", async () => {
    const { io: sink, err } = io();

    expect(await main(["deploy"], sink)).toBe(1);
    expect(err.join("\n")).toContain('unknown command "deploy"');
  });

  it("documents every command it dispatches", () => {
    expect(COMMANDS).toEqual([
      "new",
      "migrate",
      "bootstrap",
      "status-token",
      "check",
      "gen",
      "dev",
    ]);
    for (const command of COMMANDS) expect(USAGE).toContain(`hf ${command}`);
  });
});

describe("hf new through main", () => {
  it("creates the app and prints what to do next", async () => {
    const { io: sink, out } = io();

    const code = await main(
      ["new", "demo-app", "--local", "--from", source, "--into", workspace],
      sink,
    );

    expect(code).toBe(0);
    expect(await readFile(path.join(workspace, "demo-app", "package.json"), "utf8")).toContain(
      "demo_app",
    );
    expect(out.join("\n")).toContain("app demo_app, database hf_demo_app");
  });

  it("turns a refusal into one line and a non-zero code, not a stack", async () => {
    const { io: sink, err } = io();

    const code = await main(["new", "Demo", "--local", "--from", source], sink);

    expect(code).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("app name must match");
  });

  it("refuses without --local, so a half-provisioned cloud app is never the outcome", async () => {
    const { io: sink, err } = io();

    expect(await main(["new", "demo-app", "--from", source, "--into", workspace], sink)).toBe(1);
    expect(err[0]).toContain("--local");
  });

  it("needs a name", async () => {
    const { io: sink, err } = io();

    expect(await main(["new", "--local", "--from", source], sink)).toBe(1);
    expect(err[0]).toContain("hf new needs a name");
  });
});
