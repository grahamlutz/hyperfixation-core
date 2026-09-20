import { githubAppSlugs, requireOperatorConfig } from "../config.js";
import type { Step } from "../new-cloud.js";
import { GithubClient } from "../providers/github.js";
import { ProviderError } from "../providers/http.js";
import { gitHead, mustRun, short, StepFailed, type CloudStepContext } from "./context.js";

/** One page of installations, and of an installation's repositories. */
const PER_PAGE = 100;

/**
 * The token reaches `git` through the child's environment alone.
 *
 * Not in argv, where `ps` reads it; not in the remote URL, which `git remote add` writes into
 * `.git/config` and every later `git push` from the operator's shell would then use; and not in
 * anything a step prints. `GIT_CONFIG_COUNT` is how git takes configuration from the environment
 * without a file, so the header outlives neither the child nor this step.
 */
export function gitAuthEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    // GitHub's documented form for a token over HTTPS git; `Bearer` is the API's, not git's.
    GIT_CONFIG_VALUE_0:
      "Authorization: Basic " + Buffer.from(`x-access-token:${token}`, "utf8").toString("base64"),
  };
}

/**
 * The app's private GitHub repository, its first push, and both GitHub Apps on it.
 *
 * The cold-run question is not "is there a repository called this" but "is there a repository
 * holding *this* app": a name someone else took answers 200 just as well, so an existing one is
 * adopted only when its `main` is the commit the install step made. Anything else is refused with
 * the name in the message — pushing over it is not recoverable.
 */
export const repoStep: Step<CloudStepContext> = {
  name: "repo",
  run: async (context) => {
    const { names } = context;
    const required = requireOperatorConfig(
      context.config,
      ["HF_GITHUB_TOKEN", "HF_GITHUB_OWNER", "HF_GITHUB_APP_SLUGS"],
      { env: context.env },
    );
    const owner = required.HF_GITHUB_OWNER;
    const repo = names.given;
    const fullName = `${owner}/${repo}`;

    const head = await gitHead(context);
    if (head === undefined) {
      throw new StepFailed(`${context.dir} has no commit to push: the install step has not run`);
    }

    const github = new GithubClient({ token: required.HF_GITHUB_TOKEN, fetch: context.fetch });
    const existing = await getRepository(github, owner, repo);
    let pushNeeded = true;
    if (existing === undefined) {
      const user = await github.getUser(owner);
      const body = { name: repo, private: true };
      if (user.type === "Organization") await github.createOrgRepository(owner, body);
      else await github.createUserRepository(body);
      context.io.out(`${names.given}: created the private repository ${fullName}`);
    } else {
      const sha = await mainSha(github, owner, repo);
      if (sha === head) {
        pushNeeded = false;
        context.io.out(`${names.given}: adopting ${fullName}, whose main is ${short(head)}`);
      } else if (sha === undefined) {
        context.io.out(`${names.given}: ${fullName} exists and is empty; pushing`);
      } else {
        throw new StepFailed(
          `${fullName} already exists and its main is ${short(sha)}, not this app's ` +
            `${short(head)}: hf new will not push over a repository it did not create. Rename ` +
            `it, or give the app another name.`,
        );
      }
    }

    // `set-url` rather than `add`, because a rerun finds the remote its predecessor added; the
    // URL carries no credentials, so rewriting it is safe to repeat.
    const url = `https://github.com/${owner}/${repo}.git`;
    const remote = await context.exec("git", ["remote", "get-url", "origin"], {
      cwd: context.dir,
      capture: true,
    });
    await mustRun(context, "git", [
      "remote",
      remote.code === 0 ? "set-url" : "add",
      "origin",
      url,
    ]);

    if (pushNeeded) {
      await mustRun(context, "git", ["push", "--set-upstream", "origin", "main"], {
        env: gitAuthEnv(required.HF_GITHUB_TOKEN),
      });
    }

    await assertAppsInstalled(github, githubAppSlugs(context.config), fullName);
    await context.state.patch({ repo: fullName });
  },
};

/**
 * Every `HF_GITHUB_APP_SLUGS` entry installed on the repository, or which one is not.
 *
 * Coolify cannot deploy from a repository its GitHub App cannot see, and that failure otherwise
 * surfaces as a deployment that clones nothing — so it is asserted here, by name, with the URL
 * that fixes it.
 */
async function assertAppsInstalled(
  github: GithubClient,
  slugs: readonly string[],
  fullName: string,
): Promise<void> {
  const installations = await allInstallations(github);
  for (const slug of slugs) {
    const installation = installations.find((candidate) => candidate.app_slug === slug);
    if (installation === undefined) {
      throw new StepFailed(
        `the GitHub App ${slug} is not installed for this token: install it on ${fullName} at ` +
          `https://github.com/apps/${slug}/installations/new and re-run hf new`,
      );
    }
    if (!(await installationReaches(github, installation.id, fullName))) {
      throw new StepFailed(
        `the GitHub App ${slug} is installed but does not reach ${fullName}: add the repository ` +
          `to it at https://github.com/apps/${slug}/installations/new and re-run hf new`,
      );
    }
  }
}

async function allInstallations(
  github: GithubClient,
): Promise<{ id: number; app_slug: string }[]> {
  const found: { id: number; app_slug: string }[] = [];
  for (let page = 1; ; page += 1) {
    const { total_count, installations } = await github.listInstallations({
      per_page: PER_PAGE,
      page,
    });
    found.push(...installations);
    if (installations.length === 0 || found.length >= total_count) return found;
  }
}

async function installationReaches(
  github: GithubClient,
  installationId: number,
  fullName: string,
): Promise<boolean> {
  for (let page = 1, seen = 0; ; page += 1) {
    const listed = await github.listInstallationRepositories(installationId, {
      per_page: PER_PAGE,
      page,
    });
    // `all` is an installation with no repository selection to check: everything the account has,
    // now and later, which the paged list can only under-report.
    if (listed.repository_selection === "all") return true;
    if (listed.repositories.some((candidate) => candidate.full_name === fullName)) return true;
    seen += listed.repositories.length;
    if (listed.repositories.length === 0 || seen >= listed.total_count) return false;
  }
}

/** The repository, or `undefined` for the 404 that covers both absent and invisible. */
async function getRepository(
  github: GithubClient,
  owner: string,
  repo: string,
): Promise<{ full_name: string } | undefined> {
  try {
    return await github.getRepository(owner, repo);
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404) return undefined;
    throw error;
  }
}

/** `main`'s sha, or `undefined` for the 409 GitHub answers about a repository with no commits. */
async function mainSha(
  github: GithubClient,
  owner: string,
  repo: string,
): Promise<string | undefined> {
  try {
    return (await github.getReference(owner, repo, "heads/main")).object.sha;
  } catch (error) {
    if (error instanceof ProviderError && error.status === 409) return undefined;
    throw error;
  }
}
