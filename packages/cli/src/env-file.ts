import { readFile } from "node:fs/promises";

/**
 * Just enough dotenv for the template's own `.env`: `NAME=value`, `#` comments, and optional
 * surrounding quotes. No interpolation and no `export` — the template writes neither, and a
 * parser that guesses at shell semantics would disagree with compose, which reads the same file
 * with rules of its own.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    env[name] = unquote(raw);
  }
  return env;
}

export async function readEnvFile(file: string): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await readFile(file, "utf8"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw cause;
  }
}

/** The names `.env.example` declares, in file order — the app's own env contract. */
export function declaredNames(contents: string): string[] {
  return Object.keys(parseEnvFile(contents));
}

function unquote(value: string): string {
  if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
    const quote = value[0];
    if (value.endsWith(quote)) return value.slice(1, -1);
  }
  return value;
}
