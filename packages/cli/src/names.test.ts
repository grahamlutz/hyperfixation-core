import { describe, expect, it } from "vitest";
import { APP_ID, deriveNames, GIVEN_NAME, InvalidAppName } from "./names.js";

describe("deriveNames", () => {
  it("keeps the given name for the directory and underscores it for every identifier", () => {
    expect(deriveNames("demo-app")).toEqual({
      given: "demo-app",
      appName: "demo_app",
      databaseName: "hf_demo_app",
      applicationRole: "hf_demo_app",
      migratorRole: "hf_demo_app_migrator",
    });
  });

  it("leaves a name that is already an identifier alone", () => {
    expect(deriveNames("demo_app").appName).toBe("demo_app");
    expect(deriveNames("demo_app").given).toBe("demo_app");
  });

  it("refuses a name with a character no identifier can carry", () => {
    for (const bad of ["Demo", "demo app", "demo.app", "1demo", "_demo", "demo!", ""]) {
      expect(() => deriveNames(bad)).toThrow(InvalidAppName);
    }
  });

  it("names the pattern it refused against, because the two differ", () => {
    expect(() => deriveNames("Demo")).toThrow(GIVEN_NAME.source);
    // 61 characters underscore to 61, and `hf_` takes the database name to 64.
    expect(() => deriveNames("a".repeat(61))).toThrow(APP_ID.source);
  });

  it("accepts the longest name whose derived database name still fits", () => {
    const longest = "a".repeat(60);
    expect(deriveNames(longest).databaseName).toHaveLength(63);
  });
});
