import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_KEYS,
  ConfigFileInvalid,
  configFile,
  githubAppSlugs,
  loadOperatorConfig,
  MissingConfig,
  requireOperatorConfig,
} from "./config.js";
import { InsecureFileMode } from "./secret-file.js";

const COOLIFY_TOKEN = "cf-token-hunter2";

describe("operator config", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hf-config-"));
    file = path.join(dir, "config.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (config: Record<string, unknown>, mode = 0o600): Promise<void> => {
    await writeFile(file, JSON.stringify(config), { mode });
    await chmod(file, mode);
  };

  it("lives at ~/.config/hf/config.json, or under XDG_CONFIG_HOME", () => {
    expect(configFile({ XDG_CONFIG_HOME: "/x" })).toBe("/x/hf/config.json");
    expect(configFile({ HOME: "/home/g" })).toMatch(/\/\.config\/hf\/config\.json$/);
  });

  it("reads the file and lets the environment override it", async () => {
    await write({ HF_COOLIFY_URL: "https://box", HF_COOLIFY_TOKEN: COOLIFY_TOKEN });

    const config = await loadOperatorConfig({
      file,
      env: { HF_COOLIFY_TOKEN: "from-the-shell", HF_BASE_DOMAIN: "hyperfixation.ai" },
    });

    expect(config).toEqual({
      HF_COOLIFY_URL: "https://box",
      HF_COOLIFY_TOKEN: "from-the-shell",
      HF_BASE_DOMAIN: "hyperfixation.ai",
    });
  });

  it("is empty, not an error, when no file has been written yet", async () => {
    expect(await loadOperatorConfig({ file, env: {} })).toEqual({});
  });

  it("tightens a world-readable config and refuses the run", async () => {
    await write({ HF_COOLIFY_TOKEN: COOLIFY_TOKEN }, 0o644);

    const refusal = await loadOperatorConfig({ file, env: {} }).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(InsecureFileMode);
    expect((refusal as Error).message).not.toContain(COOLIFY_TOKEN);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toContain(COOLIFY_TOKEN);
  });

  it("names every missing key at once rather than one failed request at a time", async () => {
    await write({ HF_COOLIFY_URL: "https://box" });
    const config = await loadOperatorConfig({ file, env: {} });

    const refusal = (() => {
      try {
        requireOperatorConfig(
          config,
          ["HF_COOLIFY_URL", "HF_COOLIFY_TOKEN", "HF_SENTRY_ORG", "HF_BOX_IP"],
          { file },
        );
        return undefined;
      } catch (error) {
        return error as MissingConfig;
      }
    })();

    expect(refusal).toBeInstanceOf(MissingConfig);
    expect(refusal!.names).toEqual(["HF_COOLIFY_TOKEN", "HF_SENTRY_ORG", "HF_BOX_IP"]);
    expect(refusal!.message).toContain(file);
  });

  it("narrows to the keys a command asked for", async () => {
    await write({ HF_COOLIFY_URL: "https://box", HF_COOLIFY_TOKEN: COOLIFY_TOKEN });
    const config = await loadOperatorConfig({ file, env: {} });

    expect(requireOperatorConfig(config, ["HF_COOLIFY_URL"], { file })).toEqual({
      HF_COOLIFY_URL: "https://box",
    });
  });

  it("refuses a misspelled key, and a value that is not a string, by name only", async () => {
    await write({ HF_COOLIFY_TOKN: COOLIFY_TOKEN });
    const misspelled = await loadOperatorConfig({ file, env: {} }).catch((e: unknown) => e);
    expect(misspelled).toBeInstanceOf(ConfigFileInvalid);
    expect((misspelled as Error).message).toContain("HF_COOLIFY_TOKN");
    expect((misspelled as Error).message).not.toContain(COOLIFY_TOKEN);

    await write({ HF_COOLIFY_TOKEN: { value: COOLIFY_TOKEN } });
    const wrongType = await loadOperatorConfig({ file, env: {} }).catch((e: unknown) => e);
    expect(wrongType).toBeInstanceOf(ConfigFileInvalid);
    expect((wrongType as Error).message).not.toContain(COOLIFY_TOKEN);
  });

  it("refuses a truncated file without quoting what it choked on", async () => {
    await writeFile(file, `{"HF_COOLIFY_TOKEN": "${COOLIFY_TOKEN}`, { mode: 0o600 });
    await chmod(file, 0o600);

    const refusal = await loadOperatorConfig({ file, env: {} }).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(ConfigFileInvalid);
    expect((refusal as Error).message).not.toContain(COOLIFY_TOKEN);
  });

  it("carries the twenty-four keys Phase 3 settled on", () => {
    expect(CONFIG_KEYS).toHaveLength(24);
    expect(new Set(CONFIG_KEYS).size).toBe(24);
    expect(CONFIG_KEYS).toContain("HF_GITHUB_APP_SLUGS");
    expect(CONFIG_KEYS).toContain("HF_DB_HOST_INTERNAL");
    expect(CONFIG_KEYS).toContain("HF_ANTHROPIC_API_KEY");
    expect(CONFIG_KEYS).toContain("HF_OPENAI_API_KEY");
    expect(CONFIG_KEYS).toContain("HF_LANGFUSE_PUBLIC_KEY");
    expect(CONFIG_KEYS).toContain("HF_LANGFUSE_SECRET_KEY");
  });

  it("splits HF_GITHUB_APP_SLUGS into the apps to assert, and an unset key into none", async () => {
    await write({ HF_GITHUB_APP_SLUGS: "coolify, hyperfixation-bump ,," });

    expect(githubAppSlugs(await loadOperatorConfig({ file, env: {} }))).toEqual([
      "coolify",
      "hyperfixation-bump",
    ]);
    expect(githubAppSlugs({})).toEqual([]);
  });
});
