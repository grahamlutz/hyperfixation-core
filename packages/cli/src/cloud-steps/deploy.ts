import type { StatusReport } from "@hyperfixation/core";
import { requireOperatorConfig } from "../config.js";
import type { Step } from "../new-cloud.js";
import { CoolifyClient } from "../providers/coolify.js";
import { appFqdn, gitHead, short, StepFailed, type CloudStepContext } from "./context.js";

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

    const required = requireOperatorConfig(
      context.config,
      ["HF_COOLIFY_URL", "HF_COOLIFY_TOKEN"],
      { env: context.env },
    );
    const coolify = new CoolifyClient({
      url: required.HF_COOLIFY_URL,
      token: required.HF_COOLIFY_TOKEN,
      fetch: context.fetch,
    });
    const deadline = context.now() + DEPLOY_TIMEOUT_MS;

    const { deployments } = await coolify.deploy(appUuid, { force: true });
    const deploymentUuid = deployments[0]?.deployment_uuid;
    if (deploymentUuid === undefined) {
      throw new StepFailed(`Coolify accepted the deploy of ${names.given} but named no deployment`);
    }
    context.io.out(`${names.given}: deployment ${deploymentUuid} queued`);

    await waitForBuild(context, coolify, deploymentUuid, deadline);
    await waitForVersion(context, sha, deadline);

    await context.state.patch({ lastDeployedSha: sha });
    context.io.out(
      `${names.given}: serving ${short(sha)} at https://${appFqdn(context)}`,
    );
  },
};

async function waitForBuild(
  context: CloudStepContext,
  coolify: CoolifyClient,
  deploymentUuid: string,
  deadline: number,
): Promise<void> {
  for (let wait = FIRST_POLL_MS; ; wait = Math.min(wait * 2, MAX_POLL_MS)) {
    const deployment = await coolify.getDeployment(deploymentUuid);
    if (deployment.status === FINISHED) return;
    if (deployment.status.startsWith("failed") || deployment.status.startsWith("cancelled")) {
      throw new StepFailed(
        `Coolify deployment ${deploymentUuid} ended ${deployment.status}: read the build log in ` +
          "Coolify, fix it, and re-run hf new",
      );
    }
    if (context.now() >= deadline) {
      throw new StepFailed(
        `Coolify deployment ${deploymentUuid} was still ${deployment.status} after ` +
          `${String(DEPLOY_TIMEOUT_MS / 60_000)} minutes`,
      );
    }
    await context.sleep(wait);
  }
}

/**
 * Polls `/api/status` under the read token until it reports `sha`.
 *
 * A refusal or an unparseable answer is not a failure here — the containers are restarting, and the
 * old ones answer until the new ones are healthy — so only the deadline ends this loop.
 */
async function waitForVersion(
  context: CloudStepContext,
  sha: string,
  deadline: number,
): Promise<void> {
  const url = `https://${appFqdn(context)}/api/status`;
  const token = context.state.state.statusTokens?.read;
  if (token === undefined) {
    throw new StepFailed(
      `no read status token in the state cache: nothing can ask ${url} what it is running`,
    );
  }
  const doFetch = context.fetch ?? ((input, init) => globalThis.fetch(input, init));

  let last = "nothing yet";
  for (let wait = FIRST_POLL_MS; ; wait = Math.min(wait * 2, MAX_POLL_MS)) {
    try {
      const response = await doFetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
      if (!response.ok) {
        last = `HTTP ${String(response.status)}`;
      } else {
        const report = (await response.json()) as StatusReport;
        const version = report.applicationVersion;
        if (version === sha) return;
        last = version === null ? "no applicationVersion" : `applicationVersion ${short(version)}`;
      }
    } catch (error) {
      last = (error as Error).message;
    }

    if (context.now() >= deadline) {
      throw new StepFailed(
        `${url} never reported ${short(sha)} within ` +
          `${String(DEPLOY_TIMEOUT_MS / 60_000)} minutes (last: ${last}). The build finished, so ` +
          "check that SOURCE_COMMIT reached the image — hf doctor reports the same mismatch.",
      );
    }
    await context.sleep(wait);
  }
}
