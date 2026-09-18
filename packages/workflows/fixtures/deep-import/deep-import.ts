/**
 * The deep-import fixture. It exists to fail `tsc`: every import below the first two reaches
 * past a package's `exports` map, which is the contract those maps *are*. The lint rule names
 * the same mistake earlier, but only in files this repo lints — the resolver refuses it in any
 * file anywhere, which is why this fixture asserts on `tsc` and not on `eslint`.
 *
 * The first two imports are the control: if the public entries stopped resolving, every line
 * here would fail and the fixture would pass for the wrong reason.
 */
import { createStepPool } from "@hyperfixation/db";
import { migrate } from "@hyperfixation/db/migrator";

// Past the map, all four of these:
import { createStepPool as viaSrc } from "@hyperfixation/db/src/step-pool.js";
import { createStepPool as viaDist } from "@hyperfixation/db/dist/step-pool.js";
import { createControlPool } from "@hyperfixation/db/src/internal/control-pool.js";
import { spawnWorker } from "@hyperfixation/testing/src/spawn-worker.js";

export const reachable = { createStepPool, migrate };
export const unreachable = { viaSrc, viaDist, createControlPool, spawnWorker };
