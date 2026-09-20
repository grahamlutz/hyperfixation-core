export { main, COMMANDS, USAGE, type Command, type Io } from "./cli.js";
export {
  newApp,
  placeholders,
  substitute,
  TemplateError,
  TEMPLATE_MARKER,
  EXCLUDED_ENTRIES,
  type NewAppOptions,
  type NewAppResult,
} from "./new.js";
export {
  findTemplateSource,
  requireTemplateSource,
  TEMPLATE_DIR_ENV,
} from "./template-source.js";
export { deriveNames, APP_ID, GIVEN_NAME, InvalidAppName, type AppNames } from "./names.js";
export { resolveApp, NotAnApp, type ResolveAppOptions, type ResolvedApp } from "./app.js";
export { declaredNames, parseEnvFile, readEnvFile } from "./env-file.js";
export { MissingEnv, requireEnv } from "./require-env.js";
export {
  credentialsOf,
  provisionLocalRoles,
  type LocalRoleOptions,
  type LocalRoleResult,
} from "./roles.js";
export {
  migrateApp,
  MIGRATE_ENTRY,
  type MigrateAppOptions,
  type MigrateAppResult,
} from "./migrate.js";
export { bootstrapApp, type BootstrapAppOptions, type BootstrapAppResult } from "./bootstrap.js";
export {
  statusTokenApp,
  StatusTokenAlreadySet,
  type StatusTokenAppOptions,
  type StatusTokenAppResult,
  type StatusTokenKind,
} from "./status-token.js";
export { checkApp, type CheckAppResult, type CheckFinding } from "./check.js";
export { probeApp, type AppRegistry } from "./probe.js";
export {
  generate,
  GENERATOR_BIN,
  GENERATOR_CONFIG,
  NoGenerators,
  type GenerateOptions,
} from "./gen.js";
export { dev, devBuildSha, DEV_COMPOSE_FILE, type DevOptions, type DevResult } from "./dev.js";
export { run, CommandFailed, type RunOptions } from "./spawn.js";
export {
  createLocalRunner,
  createSshRunner,
  shellQuote,
  sshExecArgv,
  sshTunnelArgv,
  RunnerError,
  DEFAULT_TUNNEL_READY_TIMEOUT_MS,
  type ExecOptions,
  type ExecResult,
  type LocalRunner,
  type LocalRunnerOptions,
  type Runner,
  type SshRunnerOptions,
  type Tunnel,
} from "./runner.js";
export {
  findPostgresContainer,
  openDatabase,
  openDatabaseUrl,
  redactPasswords,
  DatabaseTransportError,
  DEFAULT_POSTGRES_PORT,
  type AdminCredentials,
  type Database,
  type DatabaseTransport,
  type OpenDatabaseOptions,
  type QueryOptions,
  type QueryResult,
} from "./database.js";
export {
  createLocalDirectoryBackupSource,
  createS3BackupSource,
  BackupSourceError,
  COOLIFY_BACKUP_DIR,
  type BackupDump,
  type BackupSource,
  type BackupSourceKind,
  type LocalDirectoryBackupSourceOptions,
} from "./backup-source.js";
export {
  formatRestoreCheck,
  pgRestoreArgv,
  pgRestoreInContainerArgv,
  restoreCheck,
  restoreCheckApp,
  RestoreCheckError,
  SCRATCH_SUFFIX,
  STALE_DUMP_HOURS,
  type RestoreCheckAppOptions,
  type RestoreCheckOptions,
  type RestoreCheckResult,
  type RestoreCheckRow,
  type RestoreVerdict,
} from "./restore-check.js";
export {
  provisionDatabase,
  ProvisionDatabaseError,
  REQUIRED_EXTENSIONS,
  type ProvisionDatabaseOptions,
  type ProvisionDatabaseResult,
} from "./provision-database.js";
