import { parseArgs } from "node:util";
import {
  ADMIN_URL,
  dropLeaked,
  leakedDatabases,
  SCRATCH_PREFIX,
  TEST_PREFIX,
  withAdmin,
  type LeakedDatabase,
} from "./dev-cluster.js";
import { BUILDER_PRUNE_ARGV, IMAGE_PRUNE_ARGV } from "./docker.js";
import { capture } from "./proc.js";

const USAGE = `Usage: pnpm dev:clean [--yes] [--scratch]

Drops the test databases a killed test process left behind and prunes the docker build cache.
Prints what it would do and changes nothing unless --yes is given.

  --yes        actually drop and prune
  --scratch    also drop scratch_* databases and their hf_<name> roles
  --no-docker  databases only

A database with a backend in pg_stat_activity is never dropped. The docker side prunes build
cache down to 4GB and dangling images only — never \`image prune -a\`, never volumes.

Environment: HF_TEST_DATABASE_URL (default the local dev cluster on 5434).`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      yes: { type: "boolean", default: false },
      scratch: { type: "boolean", default: false },
      "no-docker": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const act = values.yes;
  console.log(`cluster: ${ADMIN_URL}`);
  console.log(act ? "mode:    --yes, dropping\n" : "mode:    dry run (pass --yes to act)\n");

  let failed = false;
  await withAdmin(async (client) => {
    const groups: [string, LeakedDatabase[]][] = [
      [TEST_PREFIX, await leakedDatabases(client, TEST_PREFIX)],
    ];
    if (values.scratch) {
      groups.push([SCRATCH_PREFIX, await leakedDatabases(client, SCRATCH_PREFIX)]);
    }

    for (const [prefix, databases] of groups) {
      console.log(`${prefix}* with no backend: ${databases.length}`);
      for (const database of databases) {
        console.log(`  ${database.name}  roles: ${database.roles.join(", ")}`);
        if (!act) continue;
        try {
          await dropLeaked(client, database);
        } catch (error) {
          failed = true;
          console.error(
            `  FAILED ${database.name}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    }
  });

  if (!values["no-docker"]) {
    console.log("");
    for (const argv of [BUILDER_PRUNE_ARGV, IMAGE_PRUNE_ARGV]) {
      console.log(`${act ? "$" : "would run:"} docker ${argv.join(" ")}`);
      if (!act) continue;
      const result = capture("docker", argv);
      console.log(result.stdout.trim());
      if (!result.ok) {
        failed = true;
        console.error(result.stderr.trim());
      }
    }
  }

  return failed ? 1 : 0;
}

process.exitCode = await main();
