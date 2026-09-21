import { describe, expect, it } from "vitest";
import { redact, secretValues } from "./redact.js";

const TOKEN = "ghs_AAAABBBBCCCCDDDDEEEEFFFF";

describe("redact", () => {
  it("strips a credential out of a URL", () => {
    const message = redact(
      `git clone --depth 1 https://x-access-token:${TOKEN}@github.com/grahamlutz/demo-app.git /tmp/app failed`,
      [],
    );

    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain("x-access-token");
    expect(message).toContain("https://***@github.com/grahamlutz/demo-app.git");
  });

  it("strips the basic credential out of an Authorization header", () => {
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");

    const message = redact(`git -c http.extraheader=AUTHORIZATION: basic ${basic} push failed`, []);

    expect(message).not.toContain(basic);
    expect(message).toContain("AUTHORIZATION: basic ***");
  });

  it("strips any string equal to a known secret environment value", () => {
    const secrets = secretValues({
      GITHUB_TOKEN: TOKEN,
      "npm_config_//registry.npmjs.org/:_authToken": "npm-secret-value",
      PATH: "/usr/bin",
    });

    expect(redact(`gh pr create failed with ${TOKEN}`, secrets)).not.toContain(TOKEN);
    expect(redact("published with npm-secret-value", secrets)).toBe("published with ***");
    expect(redact("/usr/bin is on the PATH", secrets)).toContain("/usr/bin");
  });

  // A three-character value is a flag or a port; blanking every occurrence of it would make the
  // message unreadable without protecting anything.
  it("ignores a secret-named value too short to be a secret", () => {
    const secrets = secretValues({ AUTH_MODE: "jwt" });

    expect(secrets).toEqual([]);
  });

  it("leaves a message with nothing to hide alone", () => {
    expect(redact("pnpm -r build failed in /work/core", [])).toBe(
      "pnpm -r build failed in /work/core",
    );
  });
});
