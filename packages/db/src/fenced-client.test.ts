import { from as copyFrom, to as copyTo } from "pg-copy-streams";
import { describe, expect, it } from "vitest";

import { classify } from "./classify.js";
import { extractStatementText } from "./fenced-client.js";

describe("extractStatementText", () => {
  it("passes a query string through", () => {
    expect(extractStatementText("SELECT 1")).toBe("SELECT 1");
  });

  it("reads the text of a { text, values } config", () => {
    expect(
      extractStatementText({
        text: "UPDATE hf_run SET status = $1 WHERE run_id = $2",
        values: ["done", "r1"],
      }),
    ).toBe("UPDATE hf_run SET status = $1 WHERE run_id = $2");
  });

  it("falls back to opaque text for a Submittable carrying no statement", () => {
    const submittable = { submit: () => {} };
    expect(classify(extractStatementText(submittable))).toBe("write");
  });
});

describe("pg-copy-streams", () => {
  it("classifies a CopyFrom Submittable as a write", () => {
    const copy = copyFrom("COPY hf_run (run_id, status) FROM STDIN WITH (FORMAT csv)");

    expect(typeof copy.submit).toBe("function");
    expect(extractStatementText(copy)).toBe(
      "COPY hf_run (run_id, status) FROM STDIN WITH (FORMAT csv)",
    );
    expect(classify(extractStatementText(copy))).toBe("write");
  });

  it("classifies a CopyTo Submittable as a write", () => {
    const copy = copyTo("COPY hf_run TO STDOUT");

    expect(classify(extractStatementText(copy))).toBe("write");
  });
});
