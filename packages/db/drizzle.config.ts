import { defineConfig } from "drizzle-kit";

// Core migrations track in drizzle.hf_core_migrations; an app's own migrations
// track in the default table, so the two journals never collide.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  migrations: {
    table: "hf_core_migrations",
    schema: "drizzle",
  },
  dbCredentials: {
    url: process.env.HF_DATABASE_URL ?? "postgres://localhost:5432/hyperfixation",
  },
});
