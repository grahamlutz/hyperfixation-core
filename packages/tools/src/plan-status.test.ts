import { describe, expect, it } from "vitest";
import {
  type MergedPr,
  END,
  REPOS,
  START,
  chunkOf,
  renderTable,
  replaceBlock,
  statusRows,
} from "./plan-status.js";

const [core, template] = REPOS;

function pr(partial: Partial<MergedPr> & Pick<MergedPr, "number">): MergedPr {
  return {
    repo: core,
    title: `PR ${partial.number}`,
    body: "",
    mergedAt: "2026-09-20T00:00:00Z",
    ...partial,
  };
}

/** The shape `gh pr list --json number,title,body,mergedAt` returns, minus the repo this adds. */
const GH_OUTPUT = JSON.stringify([
  {
    number: 58,
    title: "Give the cloud hf new its template fetch, env overlay and step runner",
    body: "Chunk: E3\r\n\r\n## Built\r\n\r\nThe env overlay wins over a `.env` file.\r\n",
    mergedAt: "2026-09-20T01:00:00Z",
  },
  {
    number: 60,
    title: "Stop a child that exits before reading its stdin from failing the run with EPIPE",
    body: "Fixes the EPIPE.\n",
    mergedAt: "2026-09-20T02:00:00Z",
  },
]);

describe("chunkOf", () => {
  it("reads the Chunk line out of a body with CRLF endings and a ## Built section", () => {
    const [first] = (JSON.parse(GH_OUTPUT) as Omit<MergedPr, "repo">[]).map((p) => ({
      ...p,
      repo: core,
    }));
    expect(chunkOf(first)).toBe("E3");
  });

  it("ignores a PR with no Chunk line rather than guessing one", () => {
    expect(chunkOf(pr({ number: 60, title: "Stop an EPIPE", body: "Chunky prose.\n" }))).toBe(
      undefined,
    );
  });

  it("does not read a Chunk: mentioned mid-sentence", () => {
    expect(chunkOf(pr({ number: 1, body: "Ordered before Chunk: E2 landed.\n" }))).toBe(undefined);
  });

  it("falls back to the checked-in map for a PR that predates the convention", () => {
    const map = { "core#51": "0", "template#28": "0", "core#57": "misc" };
    expect(chunkOf(pr({ number: 51 }), map)).toBe("0");
    expect(chunkOf(pr({ number: 28, repo: template }), map)).toBe("0");
    expect(chunkOf(pr({ number: 57 }), map)).toBe("misc");
    expect(chunkOf(pr({ number: 59 }), map)).toBe(undefined);
  });

  it("lets the map win over a stale Chunk line", () => {
    expect(chunkOf(pr({ number: 51, body: "Chunk: D9\n" }), { "core#51": "0" })).toBe("0");
  });
});

describe("statusRows", () => {
  const prs = [
    pr({ number: 62, body: "Chunk: E3\n", mergedAt: "2026-09-20T05:00:00Z" }),
    pr({ number: 30, repo: template, body: "Chunk: D1\n", mergedAt: "2026-09-20T00:00:00Z" }),
    pr({ number: 58, body: "Chunk: E3\n", mergedAt: "2026-09-20T01:00:00Z" }),
    pr({ number: 63, body: "no chunk here\n" }),
    pr({ number: 51, mergedAt: "2026-09-19T00:00:00Z" }),
  ];
  const rows = statusRows(prs, { "core#51": "0" });

  it("groups PRs per chunk in the order the doc numbers them, and drops the chunkless", () => {
    expect(rows.map((r) => r.chunk)).toEqual(["0", "D1", "E3"]);
  });

  it("orders a chunk's PRs by merge time", () => {
    expect(rows.at(-1)?.prs.map((p) => p.number)).toEqual([58, 62]);
  });

  it("sorts chunk numbers numerically, not lexically", () => {
    const many = [2, 10].map((n) => pr({ number: n, body: `Chunk: D${n}\n` }));
    expect(statusRows(many).map((r) => r.chunk)).toEqual(["D2", "D10"]);
  });
});

describe("renderTable", () => {
  it("links each PR, dates the chunk by its last merge, and summarises by the first title", () => {
    const prs = [
      pr({ number: 58, title: "Fetch the template", mergedAt: "2026-09-20T01:00:00Z" }),
      pr({ number: 62, title: "Deploy it", mergedAt: "2026-09-21T01:00:00Z" }),
    ];
    const table = renderTable(statusRows(prs, { "core#58": "E3", "core#62": "E3" }));

    expect(table).toContain(
      "| E3 | [core #58](https://github.com/grahamlutz/hyperfixation-core/pull/58), " +
        "[core #62](https://github.com/grahamlutz/hyperfixation-core/pull/62) | 2026-09-21 | " +
        "Fetch the template |",
    );
  });

  it("escapes a pipe in a title so the row keeps its four cells", () => {
    const table = renderTable(statusRows([pr({ number: 1, title: "a | b", body: "Chunk: X\n" })]));
    expect(table).toContain("| a \\| b |");
  });
});

describe("replaceBlock", () => {
  const doc = [
    "# Phase 3",
    "",
    "## Status",
    "",
    START,
    "| Chunk | PRs |",
    "|---|---|",
    "| stale | none |",
    END,
    "",
    "## Chunk 0 — First publish — ✅ Done",
    "",
    "> **Built (core #51, template #28).** Hand-written prose that must survive.",
    "",
  ].join("\n");

  it("leaves every byte outside the markers identical", () => {
    const after = replaceBlock(doc, "| Chunk |\n|---|\n| E3 |");

    expect(after.slice(0, after.indexOf(START))).toBe(doc.slice(0, doc.indexOf(START)));
    expect(after.slice(after.indexOf(END))).toBe(doc.slice(doc.indexOf(END)));
    expect(after).toContain("> **Built (core #51, template #28).** Hand-written prose");
    expect(after).not.toContain("| stale | none |");
  });

  it("is idempotent", () => {
    const table = renderTable(statusRows([pr({ number: 1, body: "Chunk: E3\n" })]));
    const once = replaceBlock(doc, table);
    expect(replaceBlock(once, table)).toBe(once);
  });

  it("refuses a doc whose markers are missing, doubled or inverted", () => {
    expect(() => replaceBlock("# Phase 3\n", "x")).toThrow(START);
    expect(() => replaceBlock(`${START}\n${doc}`, "x")).toThrow("more than one");
    expect(() => replaceBlock(`${END}\n${START}\n`, "x")).toThrow("comes before");
  });
});
