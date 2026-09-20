import { parseArgs } from "node:util";
import { bootstrapApp } from "./bootstrap.js";
import { checkApp } from "./check.js";
import { dev, devBuildSha } from "./dev.js";
import { doctor, doctorLines } from "./doctor.js";
import { generate } from "./gen.js";
import { migrateApp } from "./migrate.js";
import { newApp } from "./new.js";
import { formatRestoreCheck, restoreCheckApp } from "./restore-check.js";
import { statusTokenApp, type StatusTokenKind } from "./status-token.js";
import { requireTemplateSource } from "./template-source.js";
import { DEV_BUDGET_USD, upApp } from "./up.js";

export const COMMANDS = [
  "new",
  "migrate",
  "bootstrap",
  "status-token",
  "check",
  "gen",
  "dev",
  "up",
  "doctor",
  "restore-check",
] as const;

export type Command = (typeof COMMANDS)[number];

export const USAGE = `hf — the hyperfixation CLI

  hf new <name> --local     copy the template into ./<name>, substitute its placeholders, and
                            prompt for the bootstrap admin's email
      --from <dir>            template checkout (default: the sibling hyperfixation-template)
      --into <dir>            where to create <name> (default: the working directory)
      --email <address>       the bootstrap admin's address; skips the prompt

  hf up                     install, infra, migrate, bootstrap, status tokens, then hf dev —
                            the whole local loop after hf new, safe to rerun; seeds a $10
                            budget unless HF_BOOTSTRAP_BUDGET_USD is set in .env

  hf migrate                create the application role, then run the app's migrate.ts
      --skip-roles            the cloud path, where the roles already exist

  hf bootstrap              grant the app its one bootstrap admin, and seed hf_app_state
      --email <address>       the address to promote; otherwise HF_BOOTSTRAP_EMAIL
      --budget-usd <amount>    the app's starting budget; otherwise HF_BOOTSTRAP_BUDGET_USD

  hf status-token           provision /api/status's read and write tokens
      --read                   only the read token; refuses if it is already set
      --write                  only the write token; refuses if it is already set
      --rotate                 replace a token that is already set
                               (no flags: fills in whichever of the two is unset)

  hf check                  declared env, pending migrations, and E001-E006

  hf doctor [name]          every deployed app in the state cache, or one: /api/status under its
                            read token, the deployed version against main, E006 as the app role,
                            the last restore check, and open core-bump PRs. Exits 1 on any finding

  hf gen [generator]        the app's turbo generators

  hf dev                    docker compose up, then pnpm dev under HF_BUILD_SHA=dev-<timestamp>
      --no-compose            leave the dev infrastructure alone
      --compose-only          bring the infrastructure up and stop

  hf restore-check <name>   restore the newest hf_<name> dump beside the live database and
                            compare row counts; exits 1 on any mismatch
      --backup-dir <dir>      where the dumps are (default: Coolify's on the box)
      --from-s3               read the dump from object storage (not implemented)

Every command but \`new\`, \`doctor\` and \`restore-check\` runs against the app at or above the working directory, or --dir.
`;

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const consoleIo: Io = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/**
 * Parses argv and runs one command, returning the process's exit code.
 *
 * Every failure is caught here and printed as one line: these commands fail for reasons the
 * user can act on — a name that is not an identifier, an unset var, a template checkout that is
 * not there — and a stack trace in front of that sentence buries it.
 */
export async function main(argv: readonly string[], io: Io = consoleIo): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    io.out(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (!(COMMANDS as readonly string[]).includes(command)) {
    io.err(`unknown command ${JSON.stringify(command)}`);
    io.err(USAGE);
    return 1;
  }

  try {
    return await dispatch(command as Command, rest, io);
  } catch (error) {
    io.err(`hf ${command}: ${(error as Error).message}`);
    return 1;
  }
}

async function dispatch(command: Command, argv: readonly string[], io: Io): Promise<number> {
  switch (command) {
    case "new":
      return await commandNew(argv, io);
    case "migrate":
      return await commandMigrate(argv, io);
    case "bootstrap":
      return await commandBootstrap(argv, io);
    case "status-token":
      return await commandStatusToken(argv, io);
    case "check":
      return await commandCheck(argv, io);
    case "gen":
      return await commandGen(argv);
    case "dev":
      return await commandDev(argv, io);
    case "up":
      return await commandUp(argv, io);
    case "doctor":
      return await commandDoctor(argv, io);
    case "restore-check":
      return await commandRestoreCheck(argv, io);
  }
}

async function commandNew(argv: readonly string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      local: { type: "boolean", default: false },
      from: { type: "string" },
      into: { type: "string" },
      email: { type: "string" },
    },
    allowPositionals: true,
  });

  const name = positionals[0];
  if (name === undefined) {
    io.err("hf new needs a name: hf new <name> --local");
    return 1;
  }

  const from = values.from ?? (await requireTemplateSource());
  const result = await newApp({
    name,
    from,
    into: values.into,
    local: values.local,
    email: values.email,
  });

  io.out(`created ${result.dir} from ${from}`);
  io.out(`  app ${result.appName}, database ${result.databaseName}`);
  io.out(
    `  ${result.substituted.length} file(s) substituted` +
      (result.wroteEnv ? ", .env written from .env.example" : "") +
      (result.wroteBootstrapEmail ? ", HF_BOOTSTRAP_EMAIL set" : ""),
  );
  io.out("");
  io.out(`next: cd ${result.given} && hf up`);
  return 0;
}

async function commandMigrate(argv: readonly string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { dir: { type: "string" }, "skip-roles": { type: "boolean", default: false } },
  });

  const result = await migrateApp({ dir: values.dir, skipRoles: values["skip-roles"] });
  if (result.roles !== undefined) {
    io.out(
      `${result.roles.created ? "created" : "updated"} application role ${result.roles.applicationRole}`,
    );
  }
  io.out(`migrated ${result.app.appName}`);
  return 0;
}

async function commandBootstrap(argv: readonly string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      dir: { type: "string" },
      email: { type: "string" },
      name: { type: "string" },
      "budget-usd": { type: "string" },
    },
  });

  const result = await bootstrapApp({
    dir: values.dir,
    email: values.email,
    name: values.name,
    budgetUsd: values["budget-usd"],
  });
  io.out(
    `${result.created ? "created" : "promoted"} ${result.email} as ${result.app.appName}'s admin`,
  );
  return 0;
}

async function commandStatusToken(argv: readonly string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      dir: { type: "string" },
      read: { type: "boolean", default: false },
      write: { type: "boolean", default: false },
      rotate: { type: "boolean", default: false },
    },
  });

  const explicit = values.read || values.write;
  const kinds: StatusTokenKind[] = explicit
    ? [...(values.read ? (["read"] as const) : []), ...(values.write ? (["write"] as const) : [])]
    : ["read", "write"];

  const result = await statusTokenApp({
    dir: values.dir,
    kinds,
    rotate: values.rotate,
    explicit,
  });

  const generated = kinds.filter((kind) => result.tokens[kind] !== undefined);
  if (generated.length === 0) {
    io.out(`${result.app.appName}: every requested token is already set; nothing to do`);
    return 0;
  }

  io.out(`${result.app.appName}: status token(s) provisioned — shown once, not stored:`);
  for (const kind of generated) io.out(`  ${kind}: ${result.tokens[kind]}`);
  for (const kind of kinds) {
    if (!generated.includes(kind)) io.out(`  ${kind}: already set, left alone`);
  }
  return 0;
}

async function commandCheck(argv: readonly string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args: [...argv], options: { dir: { type: "string" } } });

  const result = await checkApp({ dir: values.dir });
  if (result.ok) {
    io.out(`${result.app.appName}: env, migrations and E001-E006 all clear`);
    return 0;
  }
  for (const finding of result.findings) io.err(`${finding.code}: ${finding.message}`);
  return 1;
}

async function commandDoctor(argv: readonly string[], io: Io): Promise<number> {
  const { positionals } = parseArgs({ args: [...argv], allowPositionals: true });

  const result = await doctor({ name: positionals[0] });
  for (const line of doctorLines(result)) io.out(line);
  return result.ok ? 0 : 1;
}

async function commandGen(argv: readonly string[]): Promise<number> {
  // No `parseArgs`: everything after `hf gen` is the generator's, including flags this CLI
  // happens to share a name with.
  const dirFlag = argv.indexOf("--dir");
  const dir = dirFlag === -1 ? undefined : argv[dirFlag + 1];
  const rest = dirFlag === -1 ? argv : [...argv.slice(0, dirFlag), ...argv.slice(dirFlag + 2)];

  await generate({ dir, args: rest });
  return 0;
}

async function commandDev(argv: readonly string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      dir: { type: "string" },
      "no-compose": { type: "boolean", default: false },
      "compose-only": { type: "boolean", default: false },
    },
  });

  // Printed before the child starts, not after it exits: `pnpm dev` runs until interrupted,
  // and the version is what the user needs in front of them while it does.
  const buildSha = devBuildSha();
  io.out(`HF_BUILD_SHA=${buildSha}`);

  await dev({
    dir: values.dir,
    skipCompose: values["no-compose"],
    composeOnly: values["compose-only"],
    buildSha,
  });
  return 0;
}

async function commandRestoreCheck(argv: readonly string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      "backup-dir": { type: "string" },
      "from-s3": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const name = positionals[0];
  if (name === undefined) {
    io.err("hf restore-check needs a name: hf restore-check <name>");
    return 1;
  }

  const result = await restoreCheckApp({
    app: name,
    backupDir: values["backup-dir"],
    fromS3: values["from-s3"],
  });
  for (const line of formatRestoreCheck(result)) io.out(line);
  return result.ok ? 0 : 1;
}

async function commandUp(argv: readonly string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args: [...argv], options: { dir: { type: "string" } } });

  const result = await upApp({ dir: values.dir });

  io.out(
    result.installedDependencies ? "installed dependencies" : "dependencies already installed",
  );
  io.out(
    result.composeStarted ? "brought up the dev infrastructure" : "no docker-compose.yml to bring up",
  );
  io.out(`migrated ${result.app.appName}`);
  io.out(result.bootstrapped ? "bootstrapped the admin" : "admin already bootstrapped; left alone");
  if (result.budgetDefaulted) {
    io.out(
      `HF_BOOTSTRAP_BUDGET_USD unset: seeded the monthly LLM budget at $${DEV_BUDGET_USD} (dev default)`,
    );
  }
  io.out(
    result.tokensProvisioned.length > 0
      ? `provisioned status token(s): ${result.tokensProvisioned.join(", ")}`
      : "status tokens already provisioned",
  );

  // Printed before the child starts, not after it exits: `pnpm dev` runs until interrupted,
  // and the version is what the user needs in front of them while it does.
  const buildSha = devBuildSha();
  io.out(`HF_BUILD_SHA=${buildSha}`);

  await dev({ dir: result.app.dir, skipCompose: true, buildSha });
  return 0;
}
