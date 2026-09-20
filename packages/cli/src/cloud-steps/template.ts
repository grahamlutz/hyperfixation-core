import { readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Step } from "../new-cloud.js";
import { substituteTree, TEMPLATE_MARKER, TemplateError } from "../new.js";
import { exists, type CloudStepContext } from "./context.js";

/**
 * Where the fetch lands before it becomes the app.
 *
 * Beside the target rather than under `os.tmpdir()`, so the rename is a rename and not a second
 * copy across filesystems, and dot-prefixed so a half-fetched tree does not look like an app.
 */
export function templateTempDir(dir: string): string {
  return path.join(path.dirname(dir), `.${path.basename(dir)}.hf-new`);
}

/**
 * The app's files: giget's fetch of the template, substituted, renamed into place.
 *
 * Nothing is ever written to the target directory except by that rename, so a crash — mid-fetch,
 * mid-substitution — leaves the target absent and the next run free to start over rather than an
 * app-shaped directory the operator has to judge. The leftover temp directory is what that next
 * run removes first.
 *
 * No `.env` is written, unlike `hf new --local`: in the cloud every value lives in Coolify's
 * environment, and a `.env` in the app directory would only be a second copy of the app's secrets
 * on the laptop that ran `hf new`.
 */
export const templateStep: Step<CloudStepContext> = {
  name: "template",
  run: async (context) => {
    const { dir, names } = context;
    if (await exists(dir)) {
      await adoptOrRefuse(context);
      return;
    }

    const temp = templateTempDir(dir);
    await rm(temp, { recursive: true, force: true });
    const fetched = await context.fetchTemplate(context.from, temp);
    await substituteTree(fetched, names);
    // The marker is what `assertTemplateSource` looks for: an app is never a template twice.
    await rm(path.join(fetched, TEMPLATE_MARKER));
    // Recorded before the rename, not after: a crash between the two must leave a directory this
    // run's state vouches for, or the rerun would refuse the app it just made.
    await context.state.patch({ templateStartedAt: new Date(context.now()).toISOString() });
    await rename(fetched, dir);

    context.io.out(`${names.given}: template fetched into ${dir}`);
  },
};

/**
 * A directory already at the target: this app on a run that crashed after the rename, or
 * something else.
 *
 * Adopted only on a genuine resume — the state cache records that this app's template step began
 * (`templateStartedAt`) or finished. With no such record the directory is not ours however much it
 * looks like it: an earlier `hf new --local` leaves a substituted scaffold with the right
 * `package.json` name, and adopting it once pushed a stale template to a new repo.
 *
 * On a resume, "this app" means a substituted template — its `package.json` carries the
 * underscored app name and the marker is gone. Anything else is the local flow's rule, refused
 * rather than written into.
 */
async function adoptOrRefuse(context: CloudStepContext): Promise<void> {
  const { dir, names, state } = context;
  const resuming = state.state.templateStartedAt !== undefined || state.isDone("template");
  if (!resuming) {
    throw new TemplateError(
      `${dir} already exists and hf has no record of creating it, so it will not adopt it on a ` +
        `first run. Move it away (or delete it) and rerun; the template is fetched fresh.`,
    );
  }
  const substituted =
    !(await exists(path.join(dir, TEMPLATE_MARKER))) && (await packageName(dir)) === names.appName;
  if (!substituted) {
    throw new TemplateError(`${dir} already exists; hf new will not write into it`);
  }
  context.io.out(`${names.given}: adopting the app directory already at ${dir}`);
}

async function packageName(dir: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    const name = (parsed as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}
