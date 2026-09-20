import { requireOperatorConfig } from "../config.js";
import type { Step } from "../new-cloud.js";
import { ProviderError } from "../providers/http.js";
import { SentryClient, type SentryProjectKey } from "../providers/sentry.js";
import { StepFailed, type CloudStepContext } from "./context.js";

/**
 * The app's Sentry project, and the DSN the deployment reports to.
 *
 * The keys endpoint is both the lookup and the answer: a 200 means the project is there and hands
 * back its DSN in the same request, so a cold run against an existing project neither creates a
 * second one nor needs a list of every project the token can see. Only a 404 creates.
 *
 * The DSN reaches the app through the Coolify env PATCH; it is a credential, so it is recorded in
 * the state and never printed.
 */
export const sentryStep: Step<CloudStepContext> = {
  name: "sentry",
  run: async (context) => {
    const { names } = context;
    const required = requireOperatorConfig(context.config, ["HF_SENTRY_TOKEN", "HF_SENTRY_ORG"], {
      env: context.env,
    });
    const org = required.HF_SENTRY_ORG;

    const sentry = new SentryClient({ token: required.HF_SENTRY_TOKEN, fetch: context.fetch });
    let keys = await listKeys(sentry, org, names.appName);
    if (keys === undefined) {
      await sentry.createProject(org, {
        name: names.appName,
        slug: names.appName,
        platform: "node",
      });
      keys = await sentry.listProjectKeys(org, names.appName);
      context.io.out(`${names.given}: created the Sentry project ${org}/${names.appName}`);
    } else {
      context.io.out(`${names.given}: adopting the Sentry project ${org}/${names.appName}`);
    }

    const dsn = keys[0]?.dsn.public;
    if (dsn === undefined) {
      throw new StepFailed(
        `the Sentry project ${org}/${names.appName} has no client key: create one in Sentry and ` +
          "re-run hf new",
      );
    }
    await context.state.patch({ sentryDsn: dsn });
  },
};

/** The project's keys, or `undefined` when Sentry says there is no such project. */
async function listKeys(
  sentry: SentryClient,
  org: string,
  project: string,
): Promise<SentryProjectKey[] | undefined> {
  try {
    return await sentry.listProjectKeys(org, project);
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404) return undefined;
    throw error;
  }
}
