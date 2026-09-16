import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "db",
    environment: "node",
    passWithNoTests: true,
    // Every test file provisions its own hermetic database against the same Postgres instance,
    // including a real `dbos schema -r` subprocess; running files in parallel makes that
    // contend for real and intermittently times out. Sequential is slower but reliable.
    fileParallelism: false,
  },
});
