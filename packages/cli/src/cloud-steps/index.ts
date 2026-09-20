import type { Step } from "../new-cloud.js";
import { backupStep } from "./backup.js";
import type { CloudStepContext } from "./context.js";
import { coolifyStep } from "./coolify.js";
import { databaseStep } from "./database.js";
import { deployStep } from "./deploy.js";
import { dnsStep } from "./dns.js";
import { installStep } from "./install.js";
import { langfuseStep } from "./langfuse.js";
import { repoStep } from "./repo.js";
import { sentryStep } from "./sentry.js";
import { templateStep } from "./template.js";

/**
 * The steps of a cloud `hf new`, in `STEPS` order — which `runSteps` asserts, because that order
 * is the rotation-safety argument rather than a preference.
 */
export const CLOUD_STEPS: readonly Step<CloudStepContext>[] = [
  templateStep,
  installStep,
  repoStep,
  backupStep,
  sentryStep,
  langfuseStep,
  dnsStep,
  databaseStep,
  coolifyStep,
  deployStep,
];

export {
  backupStep,
  coolifyStep,
  databaseStep,
  deployStep,
  dnsStep,
  installStep,
  langfuseStep,
  repoStep,
  sentryStep,
  templateStep,
};
export { EnvDrift, neededEnvNames } from "./coolify.js";
export { DEPLOY_TIMEOUT_MS } from "./deploy.js";
export {
  appFqdn,
  cloudCommands,
  defaultTemplateFetch,
  spawnStepExec,
  StepFailed,
  type CloudCommands,
  type CloudStepContext,
  type StepExec,
  type StepExecOptions,
  type StepExecOutcome,
  type StepOut,
  type TemplateFetch,
} from "./context.js";
