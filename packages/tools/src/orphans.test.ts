import { describe, expect, it } from "vitest";
import { parseOrphans } from "./orphans.js";

const PS = [
  " 4398     1  57.3 02:10:44 /bin/zsh",
  " 4399     1  56.2 02:10:44 /bin/zsh",
  " 4500     1   0.0 05:00:01 /bin/zsh",
  " 4600  4398  60.0 00:10 /bin/zsh",
  "  609     1  31.0 2-04:00:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "  700     1  90.0 01:00 /usr/local/bin/node",
  "garbage",
].join("\n");

describe("parseOrphans", () => {
  it("keeps only launchd-adopted, busy shells and node", () => {
    expect(parseOrphans(PS).map((orphan) => orphan.pid)).toEqual([4398, 4399, 700]);
  });

  it("carries the fields the report prints", () => {
    expect(parseOrphans(PS)[0]).toEqual({
      pid: 4398,
      cpu: 57.3,
      etime: "02:10:44",
      comm: "/bin/zsh",
    });
  });

  it("finds nothing in empty output", () => {
    expect(parseOrphans("")).toEqual([]);
  });
});
