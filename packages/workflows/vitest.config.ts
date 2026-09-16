import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "workflows",
    environment: "node",
    passWithNoTests: true,
  },
});
