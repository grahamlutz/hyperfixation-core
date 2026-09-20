import { deployCommit } from "./cloud-steps/deploy.js";
import { spawnStepExec, StepFailed, type StepExec, type StepOut } from "./cloud-steps/index.js";
import { gitAuthEnv } from "./cloud-steps/repo.js";
import { loadOperatorConfig, requireOperatorConfig, type OperatorConfig } from "./config.js";
import { deriveNames } from "./names.js";
import { CoolifyClient } from "./providers/coolify.js";
import type { FetchLike } from "./providers/http.js";
import { openAppState } from "./state.js";

/** What a commit looks like once `git` has resolved it; `/api/status` reports the same form. */
const FULL_SHA = /^[0-9a-f]{40}$/;

export interface DeployAppOptions {
  /** The app as `hf new` named it, which is also its state file's name. */
  app: string;
  /** The commit to deploy. Defaults to `main`'s on the app's own repository. */
  sha?: string;
  io: StepOut;
  config?: OperatorConfig;
  /** Where the per-app state files are. Defaults to `stateDir()`. */
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  exec?: StepExec;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeployAppResult {
  app: string;
  /** The commit the app answered `/api/status` with before this returned. */
  sha: string;
  url: string;
}

/**
 * `hf deploy <name>` — point the app at a commit and wait until it says it is serving it.
 *
 * The same path as `hf new`'s tenth step, and the reason there is a command at all: auto-deploy
 * is off, so a merge to main changes nothing on the box until this runs. Everything it needs is
 * in the state cache the provisioning run wrote; nothing here is interactive.
 */
export async function deployApp(options: DeployAppOptions): Promise<DeployAppResult> {
  const env = options.env ?? process.env;
  const config = options.config ?? (await loadOperatorConfig({ env }));
  const names = deriveNames(options.app);
  const required = requireOperatorConfig(
    config,
    ["HF_COOLIFY_URL", "HF_COOLIFY_TOKEN", "HF_BASE_DOMAIN", "HF_GITHUB_TOKEN"],
    { env },
  );

  const store = await openAppState(names.given, { dir: options.stateDir, env });
  const { coolify, statusTokens, repo } = store.state;
  const appUuid = coolify?.appUuid;
  const readToken = statusTokens?.read;
  if (appUuid === undefined || readToken === undefined) {
    const missing = appUuid === undefined ? "Coolify application uuid" : "read status token";
    throw new StepFailed(
      `${store.file} has no ${missing}: hf new has not finished provisioning ${names.given}`,
    );
  }

  const sha =
    options.sha === undefined
      ? await mainSha(options, repo, required.HF_GITHUB_TOKEN)
      : options.sha;
  if (!FULL_SHA.test(sha)) {
    throw new StepFailed(
      `${sha} is not a commit sha: --sha takes the full forty hex characters, because that is ` +
        "what /api/status reports back",
    );
  }

  const fqdn = `${names.given}.${required.HF_BASE_DOMAIN}`;
  await deployCommit({
    name: names.given,
    appUuid,
    fqdn,
    sha,
    readToken,
    coolify: new CoolifyClient({
      url: required.HF_COOLIFY_URL,
      token: required.HF_COOLIFY_TOKEN,
      fetch: options.fetch,
    }),
    io: options.io,
    now: options.now ?? (() => Date.now()),
    sleep: options.sleep ?? (async (ms) => await new Promise((resolve) => setTimeout(resolve, ms))),
    fetch: options.fetch,
  });

  await store.patch({ lastDeployedSha: sha });
  return { app: names.given, sha, url: `https://${fqdn}` };
}

/**
 * `main`'s sha on the app's repository, read with `git ls-remote` and no checkout.
 *
 * The remote rather than a local clone: the operator running this has just merged a pull request,
 * and whatever is in a directory on the laptop is not what the box would build.
 */
async function mainSha(
  options: DeployAppOptions,
  repo: string | undefined,
  token: string,
): Promise<string> {
  if (repo === undefined) {
    throw new StepFailed(
      `no owner/name repository in ${options.app}'s state cache: nothing can be asked what main ` +
        "is. Pass --sha <sha>.",
    );
  }

  const url = `https://github.com/${repo}.git`;
  const exec = options.exec ?? spawnStepExec;
  const outcome = await exec("git", ["ls-remote", url, "refs/heads/main"], {
    cwd: process.cwd(),
    capture: true,
    env: gitAuthEnv(token),
  });

  const sha = /^([0-9a-f]{40})\s/.exec(outcome.stdout.trim())?.[1];
  if (outcome.code !== 0 || sha === undefined) {
    throw new StepFailed(
      `git ls-remote ${url} refs/heads/main named no commit: the repository may be gone, the ` +
        "branch unborn, or HF_GITHUB_TOKEN unable to read it. Pass --sha <sha>.",
    );
  }
  return sha;
}
