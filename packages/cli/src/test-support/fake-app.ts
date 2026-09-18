import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface FakeAppOptions {
  appName: string;
  env?: Record<string, string>;
  /** Names `.env.example` declares; defaults to whatever `env` carries. */
  declared?: readonly string[];
}

/**
 * The smallest directory `resolveApp` accepts: a `package.json`, the registry file that marks
 * an app, and the two env files. Enough for every command's non-database half — the commands
 * that then spawn the app's own toolchain are proven end to end, not here.
 */
export async function fakeApp(options: FakeAppOptions): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hf-app-"));
  const env = options.env ?? {};

  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "drizzle", "meta"), { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: options.appName, private: true }, null, 2)}\n`,
  );
  await writeFile(path.join(dir, "src", "hyperfixation.ts"), "export const app = {};\n");
  await writeFile(
    path.join(dir, "drizzle", "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries: [] }),
  );
  await writeFile(
    path.join(dir, ".env"),
    Object.entries(env)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n"),
  );
  await writeFile(
    path.join(dir, ".env.example"),
    (options.declared ?? Object.keys(env)).map((name) => `${name}=`).join("\n"),
  );

  return dir;
}
