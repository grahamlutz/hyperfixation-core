import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { UnknownPrompt } from "./errors.js";

export interface LoadedPrompt {
  name: string;
  text: string;
  /** sha256 of the bytes read, which is what lands on the ledger row. */
  hash: string;
}

/**
 * `<promptsDir>/<name>.md`, read on every call and never cached: an edited prompt takes effect
 * without a restart, and the hash on the row is of the bytes this call actually sent.
 */
export async function loadPrompt(promptsDir: string, name: string): Promise<LoadedPrompt> {
  const file = join(promptsDir, `${name}.md`);
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (cause) {
    throw new UnknownPrompt(name, file, { cause });
  }
  return {
    name,
    text: bytes.toString("utf8"),
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
}
