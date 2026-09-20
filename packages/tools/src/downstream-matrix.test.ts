import { describe, expect, it } from "vitest";
import { downstreamMatrix, parseDownstream } from "./downstream-matrix.js";

const TEMPLATE = "grahamlutz/hyperfixation-template";

describe("parseDownstream", () => {
  it("ignores comments, blank lines and surrounding whitespace", () => {
    expect(parseDownstream(`# a comment\n\n  ${TEMPLATE}  \n\n# another\n`)).toEqual([TEMPLATE]);
  });

  it("keeps the file's order and collapses a repeated repo", () => {
    const text = `${TEMPLATE}\ngrahamlutz/demo-app\n${TEMPLATE}\n`;
    expect(parseDownstream(text)).toEqual([TEMPLATE, "grahamlutz/demo-app"]);
  });

  it("names the line number of a slug it rejects", () => {
    expect(() => parseDownstream(`# head\n${TEMPLATE}\nnot a repo\n`)).toThrow(/line 3/);
    expect(() => parseDownstream("owner/repo/extra\n")).toThrow(/owner\/repo slug/);
    expect(() => parseDownstream("https://github.com/o/r\n")).toThrow(/owner\/repo slug/);
  });

  it("reads a file with no trailing newline", () => {
    expect(parseDownstream(TEMPLATE)).toEqual([TEMPLATE]);
  });
});

describe("downstreamMatrix", () => {
  it("emits one include entry per line, split for the app token", () => {
    expect(downstreamMatrix(`# head\n${TEMPLATE}\n`)).toEqual({
      include: [
        { repo: TEMPLATE, owner: "grahamlutz", name: "hyperfixation-template" },
      ],
    });
  });

  it("survives JSON.stringify → fromJSON as a matrix GitHub accepts", () => {
    const matrix = JSON.parse(JSON.stringify(downstreamMatrix(`${TEMPLATE}\nother/app\n`))) as {
      include: { repo: string }[];
    };
    expect(matrix.include.map((e) => e.repo)).toEqual([TEMPLATE, "other/app"]);
  });

  it("refuses an empty file rather than emitting a matrix that checks nothing", () => {
    expect(() => downstreamMatrix("# only comments\n\n")).toThrow(/no repositories/);
  });
});
