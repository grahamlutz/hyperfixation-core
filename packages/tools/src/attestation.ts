import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NPMJS_REGISTRY, type Exec } from "./registry.js";

/** What `--provenance` must have recorded for a release of this repo to be ours. */
export const SOURCE_REPOSITORY = "https://github.com/grahamlutz/hyperfixation-core";
export const RELEASE_WORKFLOW = ".github/workflows/release.yml";

const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";

/**
 * The registry's attestation endpoint: a list of Sigstore bundles, each wrapping a DSSE envelope
 * whose base64 payload is an in-toto statement. npm files two per publish — its own
 * `publish/v0.1` receipt and the SLSA provenance the OIDC exchange produced; only the second one
 * says where the tarball was built, so it is the one with something to check.
 */
export type AttestationBundle = {
  readonly predicateType?: string;
  readonly bundle?: { readonly dsseEnvelope?: { readonly payload?: string } };
};

export type AttestationsResponse = { readonly attestations?: readonly AttestationBundle[] };

/** `undefined` means the version has no attestations at all — a 404, not a failure. */
export type AttestationFetcher = (
  name: string,
  version: string,
) => Promise<AttestationsResponse | undefined>;

export function attestationsUrl(registry: string, name: string, version: string): string {
  return `${registry.replace(/\/+$/u, "")}/-/npm/v1/attestations/${name.replace("/", "%2f")}@${version}`;
}

export function httpAttestationFetcher(registry: string = NPMJS_REGISTRY): AttestationFetcher {
  return async (name, version) => {
    const response = await fetch(attestationsUrl(registry, name, version), {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return undefined;
    return (await response.json()) as AttestationsResponse;
  };
}

type Statement = {
  readonly predicateType?: string;
  readonly subject?: readonly {
    readonly name?: string;
    readonly digest?: { readonly sha512?: string };
  }[];
  readonly predicate?: {
    readonly buildDefinition?: {
      readonly externalParameters?: {
        readonly workflow?: { readonly repository?: string; readonly path?: string };
      };
      readonly resolvedDependencies?: readonly {
        readonly digest?: { readonly gitCommit?: string };
      }[];
    };
    readonly runDetails?: { readonly metadata?: { readonly invocationId?: string } };
  };
};

function decodeStatement(bundle: AttestationBundle): Statement | undefined {
  const payload = bundle.bundle?.dsseEnvelope?.payload;
  if (payload === undefined) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as Statement;
  } catch {
    return undefined;
  }
}

/** `dist.integrity`'s spelling of the hex digest an in-toto subject carries. */
export function integrityOfDigest(sha512Hex: string): string {
  return `sha512-${Buffer.from(sha512Hex, "hex").toString("base64")}`;
}

export type Provenance = {
  readonly repository: string | undefined;
  readonly workflow: string | undefined;
  readonly commits: readonly string[];
  readonly integrity: string | undefined;
  readonly runUrl: string | undefined;
};

/** The SLSA statement's claims, or `undefined` when the response carries no provenance. */
export function readProvenance(response: AttestationsResponse): Provenance | undefined {
  for (const bundle of response.attestations ?? []) {
    const statement = decodeStatement(bundle);
    if (statement?.predicateType !== PROVENANCE_PREDICATE) continue;
    const build = statement.predicate?.buildDefinition;
    const digest = statement.subject?.[0]?.digest?.sha512;
    return {
      repository: build?.externalParameters?.workflow?.repository,
      workflow: build?.externalParameters?.workflow?.path,
      commits: (build?.resolvedDependencies ?? [])
        .map((dependency) => dependency.digest?.gitCommit)
        .filter((commit): commit is string => commit !== undefined),
      integrity: digest === undefined ? undefined : integrityOfDigest(digest),
      runUrl: statement.predicate?.runDetails?.metadata?.invocationId,
    };
  }
  return undefined;
}

export type ProvenanceExpectation = {
  readonly name: string;
  readonly version: string;
  /** The registry's `dist.integrity` — what the attested digest must name. */
  readonly integrity: string | undefined;
  readonly commit: string;
};

/**
 * Every claim that does not hold, not just the first. An attestation that verifies pins the
 * tarball to a commit and a workflow, which is what a rebuild on the verifier's machine only
 * ever approximated.
 */
export function provenanceProblems(
  expected: ProvenanceExpectation,
  provenance: Provenance,
): string[] {
  const where = `${expected.name}@${expected.version}`;
  const problems: string[] = [];
  if (provenance.repository !== SOURCE_REPOSITORY) {
    problems.push(
      `${where} was attested to ${provenance.repository ?? "(no repository)"}, not ${SOURCE_REPOSITORY}`,
    );
  }
  if (provenance.workflow !== RELEASE_WORKFLOW) {
    problems.push(
      `${where} was attested to workflow ${provenance.workflow ?? "(none)"}, not ${RELEASE_WORKFLOW}`,
    );
  }
  if (!provenance.commits.includes(expected.commit)) {
    problems.push(
      `${where} was attested at ${provenance.commits.join(", ") || "(no commit)"}, not the release commit ${expected.commit}`,
    );
  }
  if (provenance.integrity !== expected.integrity) {
    problems.push(
      `${where} attests ${provenance.integrity ?? "(no digest)"}, but the registry serves ${expected.integrity ?? "(absent)"}`,
    );
  }
  return problems;
}

export type SignatureAudit = (
  names: readonly string[],
  version: string,
) => Promise<readonly string[]>;

type AuditReport = {
  readonly invalid?: readonly { readonly name?: string; readonly version?: string }[];
  readonly missing?: readonly { readonly name?: string; readonly version?: string }[];
};

const describe = (entry: { name?: string; version?: string }): string =>
  `${entry.name ?? "(unnamed)"}@${entry.version ?? "?"}`;

/**
 * `npm audit signatures` is the only Sigstore verifier already on the machine: it checks the
 * registry signature *and* the provenance bundle cryptographically, which nothing in this
 * package can do by decoding a payload. It needs a real install tree rather than a flag, so it
 * gets a throwaway project. `invalid` is a forged or altered signature or attestation; `missing`
 * is a package the registry never signed.
 */
export function npmSignatureAudit(exec: Exec): SignatureAudit {
  return async (names, version) => {
    const work = await mkdtemp(join(tmpdir(), "hf-audit-"));
    try {
      await writeFile(join(work, "package.json"), JSON.stringify({ name: "hf-audit", private: true }));
      const specs = names.map((name) => `${name}@${version}`);
      if (
        exec("npm", ["install", ...specs, "--no-audit", "--no-fund", "--ignore-scripts"], {
          cwd: work,
        }).status !== 0
      ) {
        return [`npm install of ${specs.join(" ")} failed, so their signatures went unchecked`];
      }
      const result = exec("npm", ["audit", "signatures", "--json"], { cwd: work, capture: true });
      let report: AuditReport;
      try {
        report = JSON.parse(result.stdout) as AuditReport;
      } catch {
        return [`npm audit signatures produced no report (exit ${result.status})`];
      }
      return [
        ...(report.invalid ?? []).map(
          (entry) => `${describe(entry)} failed npm audit signatures — signature or attestation invalid`,
        ),
        ...(report.missing ?? [])
          .filter((entry) => entry.name?.startsWith("@hyperfixation/") === true)
          .map((entry) => `${describe(entry)} has no registry signature`),
      ];
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };
}
