import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  ADMIN_URL,
  leakedDatabases,
  SCRATCH_PREFIX,
  TEST_PREFIX,
  withAdmin,
} from "./dev-cluster.js";
import {
  buildxPresent,
  colimaRunning,
  dockerDiskUsage,
  inspectContainer,
  isAnonymousVolume,
  PG_CONTAINER,
  PG_PORT,
} from "./docker.js";
import { mainCheckout, templateDir } from "./proc.js";
import { classifyRepo } from "./worktrees.js";

const USAGE = `Usage: pnpm dev:doctor

What is wrong with this machine's dev infrastructure, one line per finding: colima, the docker
data disk, the hyperfixation-pg container, the test cluster on ${PG_PORT}, buildx, leaked test
and scratch databases, and how many git worktrees are merged-PR leftovers. Mutates nothing;
\`pnpm dev:clean\` and \`pnpm worktrees:clean\` are what act on the findings.

Environment: HF_TEST_DATABASE_URL, HF_TEMPLATE_DIR (default ../hyperfixation-template).`;

/** Below this much free on the docker data disk a build starts failing in the middle. */
const DISK_WARN_KB = 5 * 1024 * 1024;
const DISK_FAIL_KB = 1 * 1024 * 1024;

type Severity = "ok" | "warn" | "fail";
const MARKER: Record<Severity, string> = { ok: "OK  ", warn: "WARN", fail: "FAIL" };

interface Finding {
  check: string;
  severity: Severity;
  message: string;
}

const findings: Finding[] = [];
function report(check: string, severity: Severity, message: string): void {
  findings.push({ check, severity, message });
}

function gigabytes(kb: number): string {
  return `${(kb / 1024 / 1024).toFixed(1)} GB`;
}

function checkDocker(): void {
  const colima = colimaRunning();
  report("colima", colima ? "ok" : "fail", colima ? "running" : "not running: `colima start`");
  if (!colima) return;

  const disk = dockerDiskUsage();
  if (disk === undefined) {
    report("disk", "warn", "could not read df -k /var/lib/docker");
  } else {
    const severity =
      disk.freeKb < DISK_FAIL_KB ? "fail" : disk.freeKb < DISK_WARN_KB ? "warn" : "ok";
    report(
      "disk",
      severity,
      `${gigabytes(disk.freeKb)} free on /var/lib/docker (${disk.usePercent}% used)`,
    );
  }

  const container = inspectContainer(PG_CONTAINER);
  if (!container.exists) {
    report(PG_CONTAINER, "fail", "no such container");
  } else if (!container.running) {
    report(PG_CONTAINER, "fail", `exists but is not running: \`docker start ${PG_CONTAINER}\``);
  } else {
    report(PG_CONTAINER, "ok", "running");
    if (container.restartPolicy !== "unless-stopped") {
      report(
        `${PG_CONTAINER} restart`,
        "warn",
        `policy is \`${container.restartPolicy || "no"}\`, not \`unless-stopped\`: it will not come back after a colima restart`,
      );
    }
    const anonymous = container.volumes.filter(isAnonymousVolume);
    if (anonymous.length > 0) {
      report(
        `${PG_CONTAINER} volume`,
        "warn",
        `data is on an anonymous volume (${anonymous[0]?.slice(0, 12)}…): recreate with -v hyperfixation-pg-data:/var/lib/postgresql/data`,
      );
    } else {
      report(`${PG_CONTAINER} volume`, "ok", `named: ${container.volumes.join(", ")}`);
    }
  }

  const buildx = buildxPresent();
  report("buildx", buildx ? "ok" : "fail", buildx ? "present" : "not installed");
}

async function checkCluster(): Promise<void> {
  try {
    await withAdmin(async (client) => {
      await client.query("SELECT 1");
      report("cluster", "ok", `accepting connections at ${ADMIN_URL}`);
      for (const prefix of [TEST_PREFIX, SCRATCH_PREFIX]) {
        const leaked = await leakedDatabases(client, prefix);
        report(
          `${prefix}*`,
          leaked.length > 0 ? "warn" : "ok",
          `${leaked.length} leaked (no backend): \`pnpm dev:clean\``,
        );
      }
    });
  } catch (error) {
    report("cluster", "fail", `${ADMIN_URL}: ${error instanceof Error ? error.message : error}`);
  }
}

async function checkWorktrees(): Promise<void> {
  for (const repoDir of [mainCheckout(), templateDir()]) {
    if (!existsSync(join(repoDir, ".git"))) {
      report("worktrees", "warn", `no checkout at ${repoDir}`);
      continue;
    }
    const { slug, candidates } = await classifyRepo(repoDir);
    const leftovers = candidates.filter((candidate) => candidate.removable);
    report(
      `worktrees ${slug}`,
      leftovers.length > 0 ? "warn" : "ok",
      `${candidates.length} worktrees, ${leftovers.length} merged-PR leftovers: \`pnpm worktrees:clean\``,
    );
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { help: { type: "boolean", default: false } } });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  checkDocker();
  await checkCluster();
  await checkWorktrees();

  for (const finding of findings) {
    console.log(`${MARKER[finding.severity]} ${finding.check}: ${finding.message}`);
  }
  return findings.some((finding) => finding.severity === "fail") ? 1 : 0;
}

process.exitCode = await main();
