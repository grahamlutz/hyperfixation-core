import { describe, expect, it } from "vitest";
import { BUILDER_PRUNE_ARGV, IMAGE_PRUNE_ARGV, isAnonymousVolume, parseDf } from "./docker.js";

describe("prune argv", () => {
  const argv = [...BUILDER_PRUNE_ARGV, ...IMAGE_PRUNE_ARGV];

  it("prunes build cache down to 4GB, unprompted", () => {
    expect(BUILDER_PRUNE_ARGV).toEqual(["builder", "prune", "--force", "--reserved-space", "4GB"]);
  });

  it("prunes dangling images only", () => {
    expect(IMAGE_PRUNE_ARGV).toEqual(["image", "prune", "-f"]);
  });

  // The whole safety argument for `dev:clean --yes` is that these flags are absent: any of them
  // would delete a base image, the build cache wholesale, or the hyperfixation-pg data volume.
  it("never says -a, --all, --volumes or system", () => {
    for (const forbidden of ["-a", "--all", "--volumes", "--force-rm", "system", "container"]) {
      expect(argv).not.toContain(forbidden);
    }
  });
});

describe("parseDf", () => {
  it("reads the available column and the use percentage", () => {
    const output = [
      "Filesystem     1K-blocks     Used Available Use% Mounted on",
      "/dev/vdb1       30785444 18563336  10632964  64% /var/lib/docker",
      "",
    ].join("\n");

    expect(parseDf(output)).toEqual({ freeKb: 10632964, usePercent: 64 });
  });

  it("returns undefined for output it does not recognize", () => {
    expect(parseDf("")).toBeUndefined();
    expect(parseDf("df: /var/lib/docker: No such file or directory")).toBeUndefined();
  });
});

describe("isAnonymousVolume", () => {
  it("tells docker's generated id from a name someone chose", () => {
    expect(
      isAnonymousVolume("bbe59e0a0c6b333b5cb1294572374209aa89e1997866e2a025201abfd8102812"),
    ).toBe(true);
    expect(isAnonymousVolume("hyperfixation-pg-data")).toBe(false);
  });
});
