import { fileURLToPath } from "node:url";

/** Resolved from this module so a spawned fixture worker finds it too, whatever its cwd. */
export const PROMPTS_DIR = fileURLToPath(new URL("prompts", import.meta.url));
