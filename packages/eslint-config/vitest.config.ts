import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "eslint-config",
    environment: "node",
    passWithNoTests: true,
  },
});
