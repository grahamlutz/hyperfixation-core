import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

    expect(await main(["provision"], sink)).toBe(1);
    expect(err.join("\n")).toContain('unknown command "provision"');
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
      "up",
      "deploy",
      "doctor",
      "restore-check",
      "version",
    ]);
    for (const command of COMMANDS) expect(USAGE).toContain(`hf ${command}`);
  });
});

describe("hf --version", () => {
  /** The published version itself: a string of its own here would only ever agree by accident. */
  const packaged = async (): Promise<string> =>
    (
      JSON.parse(
        await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
      ) as { version: string }
    ).version;

  it("prints the @hyperfixation/cli version and exits 0", async () => {
    const { io: sink, out } = io();

    expect(await main(["--version"], sink)).toBe(0);
    expect(out).toEqual([await packaged()]);
  });

  it("answers to -v and to hf version alike", async () => {
    const short = io();
    const spelled = io();

    expect(await main(["-v"], short.io)).toBe(0);
    expect(await main(["version"], spelled.io)).toBe(0);
    expect(short.out).toEqual([await packaged()]);
    expect(spelled.out).toEqual([await packaged()]);
  });
});

describe("hf new through main", () => {
  it("creates the app and prints what to do next", async () => {
    const { io: sink, out } = io();

    const code = await main(
      [
        "new",
        "demo-app",
        "--local",
        "--from",
        source,
        "--into",
        workspace,
        "--email",
        "graham@example.com",
        "--budget-usd",
        "10",
      ],
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

    const code = await main(
      ["new", "Demo", "--local", "--from", source, "--email", "g@example.com", "--budget-usd", "10"],
      sink,
    );

    expect(code).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("app name must match");
  });

  it("refuses a local run without a budget and an admin address, naming both", async () => {
    const { io: sink, err } = io();

    expect(
      await main(["new", "demo-app", "--local", "--from", source, "--into", workspace], sink),
    ).toBe(1);
    expect(err[0]).toContain("--budget-usd <amount> and --email <address>");
    expect(await readdir(workspace)).not.toContain("demo-app");
  });

  it("names only the local flag that is missing", async () => {
    const { io: sink, err } = io();

    expect(
      await main(
        ["new", "demo-app", "--local", "--from", source, "--budget-usd", "10"],
        sink,
      ),
    ).toBe(1);
    expect(err[0]).toContain("--email <address>:");
  });

  it("refuses a cloud run without a budget and an admin address, naming both", async () => {
    const { io: sink, err } = io();

    expect(await main(["new", "demo-app", "--from", source, "--into", workspace], sink)).toBe(1);
    expect(err[0]).toContain("--budget-usd <amount> and --email <address>");
    expect(err[0]).toContain("--local");
  });

  it("names only the flag that is missing", async () => {
    const { io: sink, err } = io();

    expect(await main(["new", "demo-app", "--email", "g@example.com"], sink)).toBe(1);
    expect(err[0]).toContain("--budget-usd <amount>:");
  });

  it("needs a name", async () => {
    const { io: sink, err } = io();

    expect(await main(["new", "--local", "--from", source], sink)).toBe(1);
    expect(err[0]).toContain("hf new needs a name");
  });
});
