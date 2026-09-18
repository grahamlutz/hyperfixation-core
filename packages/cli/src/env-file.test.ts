import { describe, expect, it } from "vitest";
import { declaredNames, parseEnvFile } from "./env-file.js";

describe("parseEnvFile", () => {
  it("reads the shapes the template's own .env.example uses", () => {
    expect(
      parseEnvFile(
        ["# a comment", "HF_PROCESS=web", "", "SENTRY_DSN=", "  EMAIL_FROM = demo@localhost  "].join(
          "\n",
        ),
      ),
    ).toEqual({ HF_PROCESS: "web", SENTRY_DSN: "", EMAIL_FROM: "demo@localhost" });
  });

  it("keeps a value containing an = sign whole", () => {
    expect(parseEnvFile("DATABASE_URL=postgres://u:p@h/db?a=b").DATABASE_URL).toBe(
      "postgres://u:p@h/db?a=b",
    );
  });

  it("strips matching quotes and nothing else", () => {
    expect(parseEnvFile(`A="x"\nB='y'\nC="z\nD=it's`)).toEqual({
      A: "x",
      B: "y",
      C: '"z',
      D: "it's",
    });
  });

  it("declares a name that is set to empty, which is what hf check counts as present", () => {
    expect(declaredNames("SENTRY_DSN=\nOPENAI_API_KEY=")).toEqual([
      "SENTRY_DSN",
      "OPENAI_API_KEY",
    ]);
  });
});
