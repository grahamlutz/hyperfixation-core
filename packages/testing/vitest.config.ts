import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "testing",
    environment: "node",
    passWithNoTests: true,
  },
});
