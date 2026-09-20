import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type ChunkMap,
  type MergedPr,
  type Repo,
  chunkOf,
  prKey,
  REPOS,
  renderTable,
  replaceBlock,
  statusRows,
} from "./plan-status.js";

const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PLANNING = join(CORE_ROOT, "planning");
const MAP_FILE = join(PLANNING, "plan-sync-map.json");
const ORDER_DOC = /^hyperfixation-phase(\d+)-order-.*\.md$/;

const USAGE = `Usage: pnpm plan:sync [--doc <path>] [--write]

Rewrites the generated status table in a phase-order doc from the merged PRs of both repos.
Every other byte of the doc — the markers included — is left alone.

  --doc <path>   the doc to sync (default: the highest-numbered planning/…-order-*.md)
  --write        write the file; without it, print the diff and change nothing

A chunk id comes from a \`Chunk: <id>\` line in the PR body, or from planning/plan-sync-map.json
for PRs merged before that convention. A PR with neither is ignored.`;

async function currentOrderDoc(): Promise<string> {
  const phases = (await readdir(PLANNING))
    .map((name) => ({ name, phase: Number(ORDER_DOC.exec(name)?.[1] ?? NaN) }))
    .filter(({ phase }) => Number.isFinite(phase))
    .sort((a, b) => a.phase - b.phase);
  const latest = phases.at(-1);
  if (latest === undefined) throw new Error(`No phase-order doc in ${PLANNING}.`);
  return join(PLANNING, latest.name);
}

function mergedPrs(repo: Repo): MergedPr[] {
  const result = spawnSync(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repo.slug,
      "--state",
      "merged",
      "--json",
      "number,title,body,mergedAt",
      "--limit",
      "200",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  if (result.status !== 0) throw new Error(`gh pr list failed for ${repo.slug}`);
  const prs = JSON.parse(result.stdout) as Omit<MergedPr, "repo">[];
  return prs.map((pr) => ({ ...pr, repo }));
}

async function readMap(): Promise<ChunkMap> {
  if (!existsSync(MAP_FILE)) return {};
  return JSON.parse(await readFile(MAP_FILE, "utf8")) as ChunkMap;
}

/** git's diff, not a hand-rolled one: the doc is long and a word-level diff is what one wants. */
async function printDiff(docPath: string, candidate: string): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "hf-plan-sync-"));
  try {
    const shadow = join(work, basename(docPath));
    await writeFile(shadow, candidate);
    spawnSync("git", ["--no-pager", "diff", "--no-index", "--", docPath, shadow], {
      cwd: CORE_ROOT,
      stdio: "inherit",
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      doc: { type: "string" },
      write: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const docPath = values.doc !== undefined ? resolve(values.doc) : await currentOrderDoc();
  const map = await readMap();
  const prs = REPOS.flatMap(mergedPrs);
  const rows = statusRows(prs, map);

  const unmapped = Object.keys(map).filter((key) => !prs.some((pr) => prKey(pr) === key));
  if (unmapped.length > 0) {
    console.error(`plan-sync-map.json names PRs that are not merged: ${unmapped.join(", ")}`);
    return 1;
  }

  const ignored = prs.filter((pr) => chunkOf(pr, map) === undefined).length;
  console.log(`${docPath}`);
  console.log(`${prs.length} merged PRs, ${rows.length} chunks, ${ignored} without a chunk id`);

  const before = await readFile(docPath, "utf8");
  const after = replaceBlock(before, renderTable(rows));
  if (after === before) {
    console.log("already up to date");
    return 0;
  }
  if (!values.write) {
    await printDiff(docPath, after);
    console.log("\nnot written — re-run with --write");
    return 0;
  }
  await writeFile(docPath, after);
  console.log("written");
  return 0;
}

process.exitCode = await main();
