import type { StatusReport } from "@hyperfixation/core";
import { requireOperatorConfig } from "../config.js";
import type { Step } from "../new-cloud.js";
import { CoolifyClient } from "../providers/coolify.js";
import type { FetchLike } from "../providers/http.js";
import { appFqdn, gitHead, short, StepFailed, type CloudStepContext, type StepOut } from "./context.js";

/**
 * How long the step waits for Coolify to build and for the app to report the sha it built.
 *
 * One deadline for both halves: what the operator is waiting on is a deployed app answering with
 * the right version, and a build that took fourteen minutes has not left time for anything else.
 */
export const DEPLOY_TIMEOUT_MS = 15 * 60_000;

const FIRST_POLL_MS = 2_000;
const MAX_POLL_MS = 15_000;

/** Coolify's one terminal success; `failed` and `cancelled-*` are the terminal failures. */
const FINISHED = "finished";

/**
 * The compose variable that carries the deployed commit, and the one channel there is for it.
 *
 * Coolify's docker-compose build pack passes the commit into nothing: no `--build-arg`, nothing
 * in the compose environment, and no `.git` in the build context even with
 * `is_preserve_repository_enabled` — so the Dockerfile's `git rev-parse HEAD` fallback cannot run
 * there either, and the worker dies at startup on an unresolved `HF_BUILD_SHA` (verified on the
 * box, 4.3.21). What Coolify *does* do is materialise an application environment entry for every
 * `${VAR}` the compose file interpolates, which is what this fills in before every deploy.
 */
export const SOURCE_COMMIT_ENV = "SOURCE_COMMIT";

/** One deployment of one commit: everything `deployCommit` needs that a step context also has. */
export interface DeployTarget {
  /** The app as the state cache names it — the prefix on every line this prints. */
  name: string;
  appUuid: string;
  fqdn: string;
  /** The exact commit being deployed; `/api/status` has to report this one. */
  sha: string;
  /** `/api/status`'s read token, which is the only way to ask what the app is running. */
  readToken: string;
  coolify: CoolifyClient;
  io: StepOut;
  now(): number;
  sleep(ms: number): Promise<void>;
  fetch?: FetchLike;
}

/**
 * `SOURCE_COMMIT`, then the deploy, then the wait — in that order and never another.
 *
 * The environment write is what the build reads, so a deploy triggered first would build the
 * previous commit's tag and the wait would then time out against a version the app is right to
 * report. Both `hf new`'s tenth step and `hf deploy` come through here for that reason.
 */
export async function deployCommit(target: DeployTarget): Promise<void> {
  const deadline = target.now() + DEPLOY_TIMEOUT_MS;

  await setSourceCommit(target);

  const { deployments } = await target.coolify.deploy(target.appUuid, { force: true });
  const deploymentUuid = deployments[0]?.deployment_uuid;
  if (deploymentUuid === undefined) {
    throw new StepFailed(`Coolify accepted the deploy of ${target.name} but named no deployment`);
  }
  target.io.out(`${target.name}: deployment ${deploymentUuid} queued`);

  await waitForBuild(target, deploymentUuid, deadline);
  await waitForVersion(target, deadline);

  target.io.out(`${target.name}: serving ${short(target.sha)} at https://${target.fqdn}`);
}

/**
 * Deploy, wait for the build, then wait for the app to say it is running that commit.
 *
 * Never skipped while it is not recorded, and recorded only once `/api/status` reports the pushed
 * sha: a redeploy costs a rebuild, whereas a `deploy` marked done off the API's own "finished"
 * would hide a container that came up on the previous image — which is exactly what a rotation
 * needs this step to rule out.
 */
export const deployStep: Step<CloudStepContext> = {
  name: "deploy",
  run: async (context) => {
    const { names } = context;
    const appUuid = context.state.state.coolify?.appUuid;
    if (appUuid === undefined) {
      throw new StepFailed(
        "no Coolify application uuid in the state cache: the coolify step has not run for this app",
      );
    }

    const sha = await gitHead(context);
    if (sha === undefined) {
      throw new StepFailed(`${context.dir} has no commit to deploy: the install step has not run`);
    }

    const fqdn = appFqdn(context);
    const readToken = context.state.state.statusTokens?.read;
    if (readToken === undefined) {
      throw new StepFailed(
        `no read status token in the state cache: nothing can ask https://${fqdn}/api/status ` +
          "what it is running",
      );
    }

    const required = requireOperatorConfig(
      context.config,
      ["HF_COOLIFY_URL", "HF_COOLIFY_TOKEN"],
      { env: context.env },
    );

    await deployCommit({
      name: names.given,
      appUuid,
      fqdn,
      sha,
      readToken,
      coolify: new CoolifyClient({
        url: required.HF_COOLIFY_URL,
        token: required.HF_COOLIFY_TOKEN,
        fetch: context.fetch,
      }),
      io: context.io,
      now: context.now,
      sleep: context.sleep,
      fetch: context.fetch,
    });

    await context.state.patch({ lastDeployedSha: sha });
  },
};

/**
 * Points `SOURCE_COMMIT` at the commit about to be deployed, creating the entry if it is absent.
 *
 * Idempotent, and deliberately outside the `coolify` step's bulk PATCH: this is a value `hf` sets
 * per deploy rather than one of the app's secrets, so it is neither in `secretsHash` nor in what
 * `assertEnvsMatchCompose` compares. Every entry Coolify lists under the name is written, because
 * a compose parse materialises a preview entry beside the non-preview one and the deploy reads
 * its own.
 */
async function setSourceCommit(target: DeployTarget): Promise<void> {
  const existing = (await target.coolify.listEnvs(target.appUuid)).filter(
    (entry) => entry.key === SOURCE_COMMIT_ENV,
  );
  const variable = {
    key: SOURCE_COMMIT_ENV,
    value: target.sha,
    is_buildtime: true,
    is_runtime: true,
  };

  if (existing.length === 0) {
    await target.coolify.createEnv(target.appUuid, variable);
  } else {
    for (const entry of existing) {
      await target.coolify.updateEnv(target.appUuid, {
        ...variable,
        is_preview: entry.is_preview ?? false,
      });
    }
  }
  target.io.out(`${target.name}: ${SOURCE_COMMIT_ENV}=${short(target.sha)} set in Coolify`);
}

async function waitForBuild(
  target: DeployTarget,
  deploymentUuid: string,
  deadline: number,
): Promise<void> {
  for (let wait = FIRST_POLL_MS; ; wait = Math.min(wait * 2, MAX_POLL_MS)) {
    const deployment = await target.coolify.getDeployment(deploymentUuid);
    if (deployment.status === FINISHED) return;
    if (deployment.status.startsWith("failed") || deployment.status.startsWith("cancelled")) {
      throw new StepFailed(
        `Coolify deployment ${deploymentUuid} ended ${deployment.status}: read the build log in ` +
          "Coolify, fix it, and re-run hf new",
      );
    }
    if (target.now() >= deadline) {
      throw new StepFailed(
        `Coolify deployment ${deploymentUuid} was still ${deployment.status} after ` +
          `${String(DEPLOY_TIMEOUT_MS / 60_000)} minutes`,
      );
    }
    await target.sleep(wait);
  }
}

/**
 * Polls `/api/status` under the read token until it reports `target.sha`.
 *
 * A refusal or an unparseable answer is not a failure here — the containers are restarting, and the
 * old ones answer until the new ones are healthy — so only the deadline ends this loop.
 */
async function waitForVersion(target: DeployTarget, deadline: number): Promise<void> {
  const url = `https://${target.fqdn}/api/status`;
  const doFetch = target.fetch ?? ((input, init) => globalThis.fetch(input, init));

  let last = "nothing yet";
  for (let wait = FIRST_POLL_MS; ; wait = Math.min(wait * 2, MAX_POLL_MS)) {
    try {
      const response = await doFetch(url, {
        headers: { authorization: `Bearer ${target.readToken}`, accept: "application/json" },
      });
      if (!response.ok) {
        last = `HTTP ${String(response.status)}`;
      } else {
        const report = (await response.json()) as StatusReport;
        const version = report.applicationVersion;
        if (version === target.sha) return;
        last = version === null ? "no applicationVersion" : `applicationVersion ${short(version)}`;
      }
    } catch (error) {
      last = (error as Error).message;
    }

    if (target.now() >= deadline) {
      throw new StepFailed(
        `${url} never reported ${short(target.sha)} within ` +
          `${String(DEPLOY_TIMEOUT_MS / 60_000)} minutes (last: ${last}). The build finished, so ` +
          `check that ${SOURCE_COMMIT_ENV} reached the image — hf doctor reports the same mismatch.`,
      );
    }
    await target.sleep(wait);
  }
}
