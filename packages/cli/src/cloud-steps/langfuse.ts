import { requireOperatorConfig } from "../config.js";
import type { Step } from "../new-cloud.js";
import { LangfuseClient } from "../providers/langfuse.js";
import type { CloudStepContext } from "./context.js";

/** Langfuse keeps data indefinitely at 0, and any other value needs a paid entitlement. */
const RETENTION_DAYS = 0;

/** Said in the warning and again in the closing checklist, so neither run nor log has to be read. */
const NOT_CONFIGURED =
  "Langfuse tracing is not configured: neither HF_LANGFUSE_ORG_KEY nor an " +
  "HF_LANGFUSE_PUBLIC_KEY/HF_LANGFUSE_SECRET_KEY pair is set, so LANGFUSE_BASE_URL, " +
  "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY were not sent to Coolify and the app records no " +
  "traces. To add them later, take a project's key pair from Langfuse → project settings → API " +
  "keys, set all three in Coolify's environment for this application, and redeploy.";

/**
 * The app's Langfuse project and a key pair for it.
 *
 * The project is found by name, so a cold run reuses the one it made before rather than filling
 * the organization with duplicates. The key pair is **not** reused: Langfuse returns a secret key
 * once, at creation, and the only copy is the state file this run may not have — so a new key is
 * created and the old ones keep working, which costs an unused key and never an app that cannot
 * authenticate.
 *
 * Creating a project needs an organization-scoped key, which is a paid-plan feature: without one
 * the step falls back to the project key pair the operator configured, and without that to a
 * warning. Both fallbacks record the step — an app with no tracing is a deployed app, and only
 * the operator can decide otherwise.
 */
export const langfuseStep: Step<CloudStepContext> = {
  name: "langfuse",
  run: async (context) => {
    const { names } = context;
    if ((context.config.HF_LANGFUSE_ORG_KEY ?? "") === "") {
      await reuseOrSkip(context);
      return;
    }

    const required = requireOperatorConfig(
      context.config,
      ["HF_LANGFUSE_URL", "HF_LANGFUSE_ORG_KEY"],
      { env: context.env },
    );

    const langfuse = new LangfuseClient({
      url: required.HF_LANGFUSE_URL,
      orgKey: required.HF_LANGFUSE_ORG_KEY,
      fetch: context.fetch,
    });

    const { data } = await langfuse.listProjects();
    const existing = data.find((project) => project.name === names.appName);
    const projectId =
      existing?.id ??
      (await langfuse.createProject({ name: names.appName, retention: RETENTION_DAYS })).id;
    context.io.out(
      `${names.given}: ${existing === undefined ? "created" : "adopting"} the Langfuse project ` +
        names.appName,
    );

    const key = await langfuse.createApiKey(projectId, { note: `hf new ${names.given}` });
    await context.state.patch({
      langfuse: { publicKey: key.publicKey, secretKey: key.secretKey },
    });
  },
};

/**
 * The two paths without an org key: the operator's own project key pair, or nothing.
 *
 * No request either way — a project-scoped pair cannot list or create projects, so there is
 * nothing to ask Langfuse that would not fail.
 */
async function reuseOrSkip(context: CloudStepContext): Promise<void> {
  const { names, config } = context;
  const publicKey = config.HF_LANGFUSE_PUBLIC_KEY ?? "";
  const secretKey = config.HF_LANGFUSE_SECRET_KEY ?? "";

  if (publicKey === "" || secretKey === "") {
    context.io.out(`WARNING: ${names.given}: ${NOT_CONFIGURED}`);
    context.checklist.push(NOT_CONFIGURED);
    return;
  }

  // The public key names the project without being a secret, which is the only identifier this
  // path has: nothing here may ask Langfuse what the project is called.
  context.io.out(
    `${names.given}: reusing the configured Langfuse project keys (${publicKey}) — every app ` +
      "configured with them traces into that one project",
  );
  await context.state.patch({ langfuse: { publicKey, secretKey } });
}
