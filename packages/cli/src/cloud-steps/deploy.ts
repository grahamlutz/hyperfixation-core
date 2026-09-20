import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StatusReport } from "@hyperfixation/core";
import type { CloudContext, Step } from "../new-cloud.js";

/**
 * How long the whole step waits for Coolify to build and for the app to report the sha it built.
 *
 * One deadline for both halves: what the operator is waiting on is a deployed app answering with
 * the right version, and a build that took fourteen minutes has not left time for anything else.
 */
export const DEPLOY_TIMEOUT_MS = 15 * 60_000;

const FIRST_POLL_MS = 2_000;
const MAX_POLL_MS = 15_000;

/** Coolify's terminal deployment statuses; anything else is still in flight. */
const FINISHED = "finished";

export class DeployStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployStepError";
  }
}

/** `git rev-parse HEAD` in `dir` — the sha the deploy has to end up reporting. */
export async function gitHeadSha(dir: string): Promise<string> {
  const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: dir });
  return stdout.trim();
}

/**
 * Step 10: deploy, wait for the build, then wait for the app to say it is running that commit.
 *
 * Never skipped while it is not recorded, and recorded only once `/api/status` reports the pushed
 * sha: a redeploy costs a rebuild, whereas a `deploy` marked done off the API's own "finished"
 * would hide a container that came up on the previous image — which is exactly what a rotation
 * needs this step to rule out.
 */
export function deployStep(): Step {
  return { name: "deploy", run: runDeployStep };
}

async function runDeployStep(context: CloudContext): Promise<void> {
  const appUuid = context.state.state.coolify?.appUuid;
  if (appUuid === undefined) {
    throw new DeployStepError(
      "no Coolify application uuid in the state cache: the coolify step has not run for this app",
    );
  }

  const sha = await context.headSha();
  const deadline = context.now() + DEPLOY_TIMEOUT_MS;

  const { deployments } = await context.coolify.deploy(appUuid, { force: true });
  const deploymentUuid = deployments[0]?.deployment_uuid;
  if (deploymentUuid === undefined) {
    throw new DeployStepError(`Coolify accepted the deploy of ${context.name} but named no deployment`);
  }
  context.io.out(`deploy: ${context.name} deployment ${deploymentUuid} queued`);

  await waitForBuild(context, deploymentUuid, deadline);
  await waitForVersion(context, sha, deadline);

  await context.state.patch({ lastDeployedSha: sha });
  context.io.out(`deploy: ${context.name} is serving ${sha.slice(0, 7)} at https://${context.fqdn}`);
}

async function waitForBuild(
  context: CloudContext,
  deploymentUuid: string,
  deadline: number,
): Promise<void> {
  for (let wait = FIRST_POLL_MS; ; wait = Math.min(wait * 2, MAX_POLL_MS)) {
    const deployment = await context.coolify.getDeployment(deploymentUuid);
    if (deployment.status === FINISHED) return;
    if (deployment.status.startsWith("failed") || deployment.status.startsWith("cancelled")) {
      throw new DeployStepError(
        `Coolify deployment ${deploymentUuid} of ${context.name} ended ${deployment.status}: ` +
          "read the build log in Coolify, fix it, and rerun hf new",
      );
    }
    if (context.now() >= deadline) {
      throw new DeployStepError(
        `Coolify deployment ${deploymentUuid} of ${context.name} was still ${deployment.status} ` +
          `after ${String(DEPLOY_TIMEOUT_MS / 60_000)} minutes`,
      );
    }
    await context.sleep(wait);
  }
}

/**
 * Polls `/api/status` under the read token until it reports `sha`.
 *
 * A refusal or an unparseable answer is not a failure here — the containers are restarting, and
 * the old ones answer until the new ones are healthy — so only the deadline ends this loop.
 */
async function waitForVersion(context: CloudContext, sha: string, deadline: number): Promise<void> {
  const url = `https://${context.fqdn}/api/status`;
  const token = context.state.state.statusTokens?.read;
  if (token === undefined) {
    throw new DeployStepError(
      `no read status token in the state cache: nothing can ask ${url} what it is running`,
    );
  }

  let last = "nothing yet";
  for (let wait = FIRST_POLL_MS; ; wait = Math.min(wait * 2, MAX_POLL_MS)) {
    try {
      const response = await context.fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
      if (!response.ok) {
        last = `HTTP ${String(response.status)}`;
      } else {
        const report = (await response.json()) as StatusReport;
        const version = report.applicationVersion;
        if (version === sha) return;
        last = version === null ? "no applicationVersion" : `applicationVersion ${version}`;
      }
    } catch (error) {
      last = (error as Error).message;
    }

    if (context.now() >= deadline) {
      throw new DeployStepError(
        `${url} never reported ${sha.slice(0, 7)} within ` +
          `${String(DEPLOY_TIMEOUT_MS / 60_000)} minutes (last: ${last}). The build finished, so ` +
          "check SOURCE_COMMIT reached the image — hf doctor reports the same mismatch.",
      );
    }
    await context.sleep(wait);
  }
}
