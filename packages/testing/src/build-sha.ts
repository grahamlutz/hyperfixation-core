import { randomUUID } from "node:crypto";

/** What marks a build sha as a test's rather than a deploy's. */
export const TEST_BUILD_SHA_PREFIX = "test-";

/**
 * A build sha no other process shares. DBOS dispatches by `applicationVersion`, so two test
 * workers on one cluster must never mint the same one — hence a uuid rather than a counter.
 */
export function testBuildSha(): string {
  return `${TEST_BUILD_SHA_PREFIX}${randomUUID()}`;
}

/** Gives the current process its own `HF_BUILD_SHA`, for tests that launch in-process. */
export function setTestBuildSha(): string {
  const buildSha = testBuildSha();
  process.env.HF_BUILD_SHA = buildSha;
  return buildSha;
}
