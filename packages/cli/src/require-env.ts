import type { ResolvedApp } from "./app.js";

export class MissingEnv extends Error {
  readonly names: readonly string[];

  constructor(names: readonly string[], dir: string) {
    super(`${names.join(", ")} unset: set ${names.length === 1 ? "it" : "them"} in ${dir}/.env`);
    this.name = "MissingEnv";
    this.names = names;
  }
}

/** Reads one var out of `.env`-under-`process.env`, or names the file the user has to edit. */
export function requireEnv(app: ResolvedApp, name: string): string {
  const value = app.env[name];
  if (value === undefined || value === "") throw new MissingEnv([name], app.dir);
  return value;
}
