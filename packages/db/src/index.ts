export * from "./schema/index.js";
export { assertAppMigrationAllowed, MigrationPolicyViolation } from "./migration-policy.js";
export {
  assertAppName,
  provisionRoles,
  roleNames,
  RoleProvisioningError,
  type ProvisionedRoles,
  type ProvisionRolesOptions,
  type RoleNames,
} from "./roles.js";
export {
  migrate,
  runDbosSchema,
  MigratorError,
  CORE_MIGRATIONS_DIR,
  CORE_MIGRATIONS_SCHEMA,
  CORE_MIGRATIONS_TABLE,
  DBOS_SCHEMA,
  type MigrateOptions,
  type MigrateResult,
} from "./migrate.js";
export {
  installDeleteGuards,
  DELETE_GUARD_FUNCTION,
  DELETE_GUARD_REFERENCING_TABLES,
  type DeleteGuardResult,
  type RecordTable,
} from "./delete-guard.js";
export { grantReadOnly, GRANT_RO_EXCLUDED_TABLES, type GrantRoResult } from "./grant-ro.js";
export {
  runBootChecks,
  checkE001,
  checkE002,
  checkE003,
  checkE004,
  checkE005,
  checkE006,
  BootCheckFailure,
  BOOT_CHECK_CODES,
  type BootCheckCode,
  type BootCheckOptions,
  type Queryable,
} from "./boot-checks.js";
