import { Client } from "pg";

/**
 * Session-level, so the lock is held by the connection rather than by a transaction, and
 * released only when that connection goes away. Advisory locks are scoped to the database,
 * and the key is namespaced by app name on top of that.
 */
export const WORKER_LOCK_STATEMENT =
  "SELECT pg_try_advisory_lock(hashtext('hf-worker:' || $1::text)) AS acquired";

export class WorkerLockUnavailable extends Error {
  readonly appName: string;

  constructor(appName: string) {
    super(
      `WorkerLockUnavailable: another worker process holds the advisory lock for ${appName}; ` +
        "two workers for one app never run at once",
    );
    this.name = "WorkerLockUnavailable";
    this.appName = appName;
  }
}

export interface WorkerLock {
  readonly appName: string;
  /**
   * **Never closed by code.** The lock must not be free while any step body of this process
   * can still write — `DBOS.shutdown()`'s drain abandons unfinished workflows, so the only
   * safe release is process death (round-2 finding 1, process half). The SIGTERM handler must
   * leave this connection alone.
   */
  readonly connection: Client;
}

/**
 * Taken on a connection of its own, not one of either pool's: a pooled client is returned,
 * recycled and eventually closed, any of which would drop the lock under a running worker.
 */
export async function acquireWorkerLock(
  databaseUrl: string,
  appName: string,
): Promise<WorkerLock> {
  const connection = new Client({ connectionString: databaseUrl });
  await connection.connect();

  let acquired: boolean;
  try {
    const result = await connection.query<{ acquired: boolean }>(WORKER_LOCK_STATEMENT, [appName]);
    acquired = result.rows[0]?.acquired === true;
  } catch (error) {
    await connection.end().catch(() => undefined);
    throw error;
  }

  if (!acquired) {
    // Nothing is held on this connection, so it is not a lock connection and closing it here
    // costs nothing — the holder is some other process.
    await connection.end().catch(() => undefined);
    throw new WorkerLockUnavailable(appName);
  }

  return { appName, connection };
}
