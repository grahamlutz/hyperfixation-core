import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { downstreamMatrix } from "./downstream-matrix.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Step = { uses?: string; run?: string; id?: string; with?: Record<string, unknown> };
type Job = { steps?: Step[]; strategy?: { matrix?: unknown }; outputs?: Record<string, string> };

function jobs(workflow: string): Record<string, Job> {
  const parsed = parse(readFileSync(path.join(ROOT, ".github/workflows", workflow), "utf8")) as {
    jobs: Record<string, Job>;
  };
  return parsed.jobs;
}

/** What each `create-github-app-token` step in a job asks an installation token for. */
function tokenScopes(job: Job | undefined): Record<string, unknown>[] {
  return (job?.steps ?? [])
    .filter((step) => step.uses?.startsWith("actions/create-github-app-token@") === true)
    .map((step) => step.with ?? {});
}

describe("release.yml's app tokens", () => {
  const release = jobs("release.yml");

  // The publishing job shares a runner with `id-token: write` — the npm identity. A token here
  // that also reached a downstream repo would mean any of those repos could push to core's main
  // and have the next release publish whatever it liked.
  it("scopes the publishing job's token to core alone", () => {
    const scopes = tokenScopes(release.release);

    expect(scopes).toHaveLength(1);
    expect(scopes[0].repositories).toBe("hyperfixation-core");
    expect(scopes[0]["permission-contents"]).toBe("write");
  });

  // One token per repo, from the matrix — so `downstream.txt` and the repositories the release
  // holds credentials for cannot drift apart: they are the same list by construction.
  it("scopes each bump job's token to its own matrix repo", () => {
    const scopes = tokenScopes(release.bump);

    expect(scopes).toHaveLength(1);
    expect(scopes[0].owner).toBe("${{ matrix.owner }}");
    expect(scopes[0].repositories).toBe("${{ matrix.name }}");
    expect(scopes[0]["permission-contents"]).toBe("write");
    expect(scopes[0]["permission-pull-requests"]).toBe("write");
    expect(release.bump.strategy?.matrix).toBe("${{ fromJSON(needs.bump-list.outputs.matrix) }}");
  });

  it("builds that matrix from downstream.txt", () => {
    expect((release["bump-list"].steps ?? []).some((step) => step.run === "pnpm downstream:matrix")).toBe(
      true,
    );
    const matrix = downstreamMatrix(readFileSync(path.join(ROOT, "downstream.txt"), "utf8"));
    expect(matrix.include.length).toBeGreaterThan(0);
  });
});

describe("ci.yml's app token", () => {
  it("scopes the downstream checkout's token to its own matrix repo, read-only", () => {
    const scopes = tokenScopes(jobs("ci.yml")["downstream-matrix"]);

    expect(scopes).toHaveLength(1);
    expect(scopes[0].repositories).toBe("${{ matrix.name }}");
    expect(scopes[0]["permission-contents"]).toBe("read");
  });
});
