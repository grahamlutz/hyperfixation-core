import { requireOperatorConfig } from "../config.js";
import type { Step } from "../new-cloud.js";
import { LangfuseClient } from "../providers/langfuse.js";
import type { CloudStepContext } from "./context.js";

/** Langfuse keeps data indefinitely at 0, and any other value needs a paid entitlement. */
const RETENTION_DAYS = 0;

/**
 * The app's Langfuse project and a key pair for it.
 *
 * The project is found by name, so a cold run reuses the one it made before rather than filling
 * the organization with duplicates. The key pair is **not** reused: Langfuse returns a secret key
 * once, at creation, and the only copy is the state file this run may not have — so a new key is
 * created and the old ones keep working, which costs an unused key and never an app that cannot
 * authenticate.
 */
export const langfuseStep: Step<CloudStepContext> = {
  name: "langfuse",
  run: async (context) => {
    const { names } = context;
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
