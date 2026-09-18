import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RecordTable } from "@hyperfixation/db";
import type { ResolvedApp } from "./app.js";

const execFileAsync = promisify(execFile);

/** Prefixes the one line of the probe's stdout that is ours; the app may log at import. */
const PROBE_MARKER = "hf-probe:";

export interface AppRegistry {
  appName: string;
  recordTables: readonly RecordTable[];
}

const PROBE_SOURCE =
  `const m = await import("./src/hyperfixation.ts");\n` +
  `console.log(${JSON.stringify(PROBE_MARKER)} + JSON.stringify(` +
  `{ appName: m.app.name, recordTables: m.recordTables ?? [] }));\n`;

/**
 * Reads the app's registry by importing it in the app's own process.
 *
 * E001–E003 are checks *about the registered record tables*, so without this `hf check` would
 * run them over an empty list and report green on an app whose tables are wrong. There is no
 * way to learn the list statically: `src/hyperfixation.ts` is TypeScript that resolves
 * `@hyperfixation/*` through the app's own `node_modules`, which is why the probe is a child
 * under the app's `tsx` and not an import here.
 *
 * A failure is `undefined`, not a throw — an app whose dependencies are not installed yet is a
 * finding `hf check` reports, not a reason for it to stop.
 */
export async function probeApp(app: ResolvedApp): Promise<AppRegistry | undefined> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", PROBE_SOURCE],
      {
        cwd: app.dir,
        encoding: "utf8",
        env: {
          ...app.env,
          HF_PROCESS: "migrate",
          // `defineApp()` reads it; the probe never launches DBOS, so any accepted value does.
          HF_BUILD_SHA: app.env.HF_BUILD_SHA ?? "dev-probe",
        },
      },
    );
    const line = stdout.split("\n").find((it) => it.startsWith(PROBE_MARKER));
    if (line === undefined) return undefined;
    return JSON.parse(line.slice(PROBE_MARKER.length)) as AppRegistry;
  } catch {
    return undefined;
  }
}
