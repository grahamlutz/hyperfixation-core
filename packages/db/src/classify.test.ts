import { describe, expect, it, vi } from "vitest";

import { classify } from "./classify.js";

const parseSpy = vi.hoisted(() => vi.fn());
vi.mock("pgsql-ast-parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pgsql-ast-parser")>();
  parseSpy.mockImplementation(actual.parse);
  return { ...actual, parse: parseSpy };
});

describe("classify", () => {
  it("classifies a plain SELECT as a read", () => {
    expect(classify("SELECT run_id, status FROM hf_run WHERE run_id = $1")).toBe(
      "read",
    );
  });

  it("classifies a SELECT with joins, a subquery, ORDER BY and LIMIT as a read", () => {
    expect(
      classify(`
        SELECT r.run_id, count(l.id) AS calls
        FROM hf_run r
        JOIN hf_llm_call l ON l.run_id = r.run_id
        WHERE r.status IN (SELECT status FROM hf_app_state)
        GROUP BY r.run_id
        HAVING count(l.id) > 0
        ORDER BY r.run_id DESC
        LIMIT 10 OFFSET 5
      `),
    ).toBe("read");
  });

  it("classifies a CTE over reads as a read", () => {
    expect(
      classify(
        "WITH recent AS (SELECT run_id FROM hf_run WHERE status = 'done') SELECT * FROM recent",
      ),
    ).toBe("read");
  });

  // `SELECT … INTO`, `SAVEPOINT` and `COPY` reach 'write' through the fail-closed path:
  // pgsql-ast-parser rejects all three outright.
  it("classifies SELECT … INTO as a write", () => {
    expect(classify("SELECT run_id INTO hf_run_archive FROM hf_run")).toBe(
      "write",
    );
  });

  it("classifies transaction control as a write", () => {
    for (const sql of [
      "BEGIN",
      "START TRANSACTION",
      "COMMIT",
      "ROLLBACK",
      "SAVEPOINT sp1",
      "ROLLBACK TO SAVEPOINT sp1",
      "RELEASE SAVEPOINT sp1",
    ]) {
      expect(classify(sql), sql).toBe("write");
    }
  });

  it("classifies SET and SET LOCAL as a write", () => {
    expect(classify("SET lock_timeout = '30s'")).toBe("write");
    expect(classify("SET LOCAL lock_timeout = '30s'")).toBe("write");
  });

  it("classifies COPY … FROM STDIN as a write", () => {
    expect(classify("COPY hf_run (run_id, status) FROM STDIN")).toBe("write");
  });

  it("classifies plain DML as a write", () => {
    for (const sql of [
      "INSERT INTO hf_run (run_id) VALUES ($1)",
      "UPDATE hf_run SET status = 'done' WHERE run_id = $1",
      "DELETE FROM hf_run WHERE run_id = $1",
      "TRUNCATE hf_run",
      "CREATE TABLE t (a int)",
      "DO $$ BEGIN PERFORM 1; END $$",
    ]) {
      expect(classify(sql), sql).toBe("write");
    }
  });

  it("classifies a CTE wrapping DML as a write", () => {
    expect(
      classify(
        "WITH ins AS (INSERT INTO hf_run (run_id) VALUES ($1) RETURNING run_id) SELECT * FROM ins",
      ),
    ).toBe("write");
    expect(
      classify(
        "WITH upd AS (UPDATE hf_run SET status = 'done' WHERE run_id = $1 RETURNING run_id) SELECT * FROM upd",
      ),
    ).toBe("write");
    expect(
      classify(
        "WITH del AS (DELETE FROM hf_run WHERE run_id = $1 RETURNING run_id) SELECT * FROM del",
      ),
    ).toBe("write");
  });

  it("classifies a SELECT calling a denylisted function as a write", () => {
    expect(classify("SELECT pg_notify('hf', $1)")).toBe("write");
    expect(classify("SELECT setval('hf_run_id_seq', 42)")).toBe("write");
    expect(classify("SELECT nextval('hf_run_id_seq')")).toBe("write");
    expect(classify("SELECT pg_advisory_lock(hashtext('hf-worker'))")).toBe(
      "write",
    );
  });

  it("finds a denylisted call however deeply it is nested", () => {
    for (const sql of [
      "SELECT * FROM (SELECT nextval('s') AS v) t",
      "SELECT a FROM t UNION SELECT nextval('s') FROM u",
      "WITH c AS (SELECT setval('s', 1)) SELECT * FROM c",
      "SELECT run_id FROM hf_run ORDER BY nextval('s')",
      "SELECT CASE WHEN true THEN pg_notify('a', 'b') END",
      "SELECT * FROM dblink_exec('c', 'UPDATE t SET a = 1')",
      "SELECT pg_catalog.setval('s', 1)",
    ]) {
      expect(classify(sql), sql).toBe("write");
    }
  });

  it("matches denylisted functions on the AST, not the raw text", () => {
    expect(classify("SELECT 'pg_notify' AS label FROM hf_run")).toBe("read");
    expect(classify("SELECT run_id FROM hf_run -- nextval('s')")).toBe("read");
  });

  it("classifies a row-locking SELECT as a write", () => {
    expect(
      classify("SELECT 1 FROM hf_run WHERE run_id = $1 AND attempt = $2 FOR SHARE"),
    ).toBe("write");
    expect(classify("SELECT 1 FROM hf_run WHERE run_id = $1 FOR UPDATE")).toBe(
      "write",
    );
  });

  it("classifies unparseable text as a write", () => {
    for (const sql of ["not sql at all !!!", "", "   ", "SELECT FROM"]) {
      expect(classify(sql), JSON.stringify(sql)).toBe("write");
    }
  });

  it("classifies a batch as a write if any statement in it writes", () => {
    expect(classify("SELECT 1; UPDATE hf_run SET status = 'done'")).toBe("write");
    expect(classify("SELECT 1; SELECT 2")).toBe("read");
  });

  it("parses each distinct statement text only once", () => {
    const sql = "SELECT version FROM hf_run WHERE run_id = $1 /* cache probe */";
    parseSpy.mockClear();

    expect(classify(sql)).toBe("read");
    expect(classify(sql)).toBe("read");
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  // Residual false negative, accepted: without a `pg_proc` lookup the classifier cannot know a
  // user-defined function mutates, so a SELECT calling one is a read. Fenced code is unaffected;
  // the exposure is a step that reaches for such a function outside `ctx.tx`.
  it("known gap: a SELECT calling a mutating function outside the denylist reads", () => {
    expect(classify("SELECT archive_old_runs()")).toBe("read");
    expect(classify("SELECT pg_terminate_backend(1234)")).toBe("read");
  });
});
