import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "workflows",
    environment: "node",
    passWithNoTests: true,
    // See packages/db/vitest.config.ts: real hermetic databases and worker child processes
    // against one shared Postgres instance contend for real when test files run in parallel.
    fileParallelism: false,
  },
});
