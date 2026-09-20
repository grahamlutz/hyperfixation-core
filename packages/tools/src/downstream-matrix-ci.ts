import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { downstreamMatrix } from "./downstream-matrix.js";
import { CORE_ROOT } from "./proc.js";

const USAGE = `Usage: pnpm downstream:matrix

Prints the \`strategy.matrix\` CI runs \`template:check\` over — one entry per \`owner/repo\`
line of downstream.txt. With GITHUB_OUTPUT set, appends \`matrix=<json>\` to it as well.`;

async function main(): Promise<number> {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const file = join(CORE_ROOT, "downstream.txt");
  if (!existsSync(file)) {
    console.error(`No ${file}`);
    return 1;
  }
  let json: string;
  try {
    json = JSON.stringify(downstreamMatrix(await readFile(file, "utf8")));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
  console.log(json);
  const output = process.env.GITHUB_OUTPUT;
  if (output !== undefined && output !== "") await appendFile(output, `matrix=${json}\n`);
  return 0;
}

process.exitCode = await main();
