export * from "./schema/index.js";
export { classify, type StatementKind } from "./classify.js";
export { UnfencedWrite, unfencedWriteOf } from "./fenced-client.js";
export {
  createStepPool,
  StaleAttempt,
  FENCE_STATEMENT,
  STEP_POOL_SIZE,
  type StepDatabase,
  type StepPool,
  type StepPoolOptions,
} from "./step-pool.js";
/** `runBootChecks` takes these, so the type travels with `.` even though the guards do not. */
export type { RecordTable } from "./delete-guard.js";
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
