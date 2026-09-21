import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { downstreamMatrix } from "./downstream-matrix.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Step = { uses?: string; run?: string; id?: string; with?: Record<string, unknown> };
type Permissions = Record<string, string> | string;
type Job = {
  steps?: Step[];
  strategy?: { matrix?: unknown; "fail-fast"?: boolean };
  outputs?: Record<string, string>;
  permissions?: Permissions;
};
type Workflow = { jobs: Record<string, Job>; permissions?: Permissions };

function workflow(name: string): Workflow {
  return parse(readFileSync(path.join(ROOT, ".github/workflows", name), "utf8")) as Workflow;
}

function jobs(name: string): Record<string, Job> {
  return workflow(name).jobs;
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

  // `id-token: write` is the npm publishing identity. This job runs `pnpm update` in someone
  // else's checkout, so it is the one job in the repo that must never be able to mint one —
  // and job-level permissions replace the workflow's, so its own block is the whole answer.
  it("keeps id-token away from the job that runs a downstream repo's install", () => {
    expect(release.bump.permissions).toEqual({ contents: "read" });
  });

  // Without it one repo refusing its bump cancels the rest, which is the behaviour the loop
  // inside `release:ci` was replaced to get rid of.
  it("lets the other repos open their PR when one repo refuses", () => {
    expect(release.bump.strategy?.["fail-fast"]).toBe(false);
  });

  it("builds that matrix from downstream.txt", () => {
    expect((release["bump-list"].steps ?? []).some((step) => step.run === "pnpm downstream:matrix")).toBe(
      true,
    );
    const matrix = downstreamMatrix(readFileSync(path.join(ROOT, "downstream.txt"), "utf8"));
    expect(matrix.include.length).toBeGreaterThan(0);
  });
});

/**
 * A job with no `permissions:` anywhere above it inherits the repository default, which can be
 * write-all. Both workflows set a read-only default at workflow level; this is what fails a
 * workflow added later that does not.
 */
describe("every job's permissions", () => {
  for (const name of ["release.yml", "ci.yml"]) {
    it(`are declared for every job in ${name}`, () => {
      const parsed = workflow(name);
      const undeclared = Object.entries(parsed.jobs)
        .filter(([, job]) => job.permissions === undefined && parsed.permissions === undefined)
        .map(([job]) => `${name}: ${job}`);

      expect(undeclared).toEqual([]);
    });
  }
});

describe("ci.yml's app token", () => {
  it("scopes the downstream checkout's token to its own matrix repo, read-only", () => {
    const scopes = tokenScopes(jobs("ci.yml")["downstream-matrix"]);

    expect(scopes).toHaveLength(1);
    expect(scopes[0].repositories).toBe("${{ matrix.name }}");
    expect(scopes[0]["permission-contents"]).toBe("read");
  });
});
