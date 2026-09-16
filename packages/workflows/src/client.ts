import { DBOSClient } from "@dbos-inc/dbos-sdk";
import { runBootChecks, type RecordTable } from "@hyperfixation/db";
import { SYSTEM_DATABASE_SCHEMA } from "./start-worker.js";

export const CLIENT_POOL_SIZE = 2;

export interface GetClientOptions {
  appName: string;
  /** The application role's connection string, the same one the worker launches on. */
  databaseUrl: string;
  recordTables?: readonly RecordTable[];
  appMigrationsDir?: string;
}

let client: Promise<DBOSClient> | undefined;

/**
 * The web process's whole relationship with DBOS: it enqueues through this client and never
 * calls `DBOS.launch()`.
 *
 * The promise is cached rather than the client, so concurrent first callers share one
 * boot-check pass and one client; a failed boot caches nothing, so the next caller retries.
 */
export function getClient(options: GetClientOptions): Promise<DBOSClient> {
  client ??= createClient(options).catch((error: unknown) => {
    client = undefined;
    throw error;
  });
  return client;
}

async function createClient(options: GetClientOptions): Promise<DBOSClient> {
  await runBootChecks({
    databaseUrl: options.databaseUrl,
    recordTables: options.recordTables,
    appMigrationsDir: options.appMigrationsDir,
  });

  return await DBOSClient.create({
    systemDatabaseUrl: options.databaseUrl,
    systemDatabaseSchemaName: SYSTEM_DATABASE_SCHEMA,
    systemDatabasePoolSize: CLIENT_POOL_SIZE,
    applicationName: options.appName,
  });
}
