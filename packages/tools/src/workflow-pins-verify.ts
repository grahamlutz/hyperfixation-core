import { pathToFileURL } from "node:url";
import { CORE_ROOT } from "./proc.js";
import { spawnExec, type Exec } from "./registry.js";
import { pinTable, type PinTable } from "./workflow-pins.js";

const USAGE = `Usage: pnpm pins:verify

Asks GitHub whether every entry of \`packages/tools/src/workflow-pins.json\` is still true: that
\`<owner>/<repo>\`'s \`<tag>\` resolves to the commit the table pins. \`workflow-pins.test.ts\`
checks the workflows against that table offline; only this can check the table against the world,
which is why it needs the network and CI does not run it.

Run it when bumping a pin, and when a pinned action's release history looks rewritten. A tag that
has moved is not by itself a compromise — an owner may have re-tagged — but the pin is then no
longer the commit anyone reviewed, so re-read the diff before following it.

Environment: GH_TOKEN, or an authenticated \`gh\`.`;

export type PinResult = {
  readonly action: string;
  readonly sha: string;
  readonly version: string;
  /** What the tag resolves to now, or undefined when the lookup itself failed. */
  readonly resolved: string | undefined;
};

/** A tag → commit resolver. The real one is `gh`; the tests pass a table. */
export type ResolveTag = (action: string, version: string) => string | undefined;

export function checkPins(table: PinTable, resolve: ResolveTag): PinResult[] {
  const results: PinResult[] = [];
  for (const [action, pins] of Object.entries(table)) {
    for (const [sha, version] of Object.entries(pins)) {
      results.push({ action, sha, version, resolved: resolve(action, version) });
    }
  }
  return results;
}

export function mismatches(results: readonly PinResult[]): PinResult[] {
  return results.filter((result) => result.resolved !== result.sha);
}

function ghResolver(exec: Exec, cwd: string): ResolveTag {
  return (action, version) => {
    const result = exec("gh", ["api", `repos/${action}/commits/${version}`, "--jq", ".sha"], {
      cwd,
      capture: true,
    });
    if (result.status !== 0) return undefined;
    const sha = result.stdout.trim();
    return sha === "" ? undefined : sha;
  };
}

function main(): number {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }

  const results = checkPins(pinTable(), ghResolver(spawnExec, CORE_ROOT));
  for (const result of results) {
    if (result.resolved === result.sha) {
      console.log(`ok        ${result.action}@${result.version}`);
    } else {
      console.log(
        `MISMATCH  ${result.action}@${result.version} → ${result.resolved ?? "unresolvable"}`,
      );
    }
  }

  const bad = mismatches(results);
  if (bad.length === 0) {
    console.log(`\n${results.length} pins, all still the commit their tag names.`);
    return 0;
  }
  console.error(
    `\n${bad.length} of ${results.length} pins no longer match:\n` +
      bad
        .map(
          (result) =>
            `    ${result.action} ${result.version} is ${result.resolved ?? "unresolvable"}, ` +
            `the table pins ${result.sha}`,
        )
        .join("\n"),
  );
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
