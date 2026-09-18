import { Client } from "pg";

/**
 * Session-level, so the lock is held by the connection rather than by a transaction, and
 * released only when that connection goes away. Advisory locks are scoped to the database,
 * and the key is namespaced by app name on top of that.
 */
export const WORKER_LOCK_STATEMENT =
  "SELECT pg_try_advisory_lock(hashtext('hf-worker:' || $1::text)) AS acquired, now() AS acquired_at";

/**
 * `<marker> <appName> <iso>`, where the timestamp is the *database's*, read in the same
 * statement as the lock. Redeploy case 7 orders it against the previous worker's last
 * committed write, which is a database timestamp too — two process clocks could not be
 * compared at all.
 */
export const LOCK_ACQUIRED_MARKER = "hf-worker: advisory lock acquired";

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

/**
 * `Client` with `end` typed away. The lock must not be free while any step body of this
 * process can still write — `DBOS.shutdown()`'s drain abandons unfinished workflows, so the
 * only safe release is process death (round-2 finding 1, process half). Omitting `end` makes
 * "never closed by code" a type error for any caller, not just a doc comment the SIGTERM
 * handler has to remember to honor.
 */
export type HeldLockConnection = Omit<Client, "end">;

export interface WorkerLock {
  readonly appName: string;
  readonly connection: HeldLockConnection;
  /** The database clock at acquisition, not this process's. */
  readonly acquiredAt: Date;
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

  let row: { acquired: boolean; acquired_at: Date } | undefined;
  try {
    const result = await connection.query<{ acquired: boolean; acquired_at: Date }>(
      WORKER_LOCK_STATEMENT,
      [appName],
    );
    row = result.rows[0];
  } catch (error) {
    await connection.end().catch(() => undefined);
    throw error;
  }

  if (row?.acquired !== true) {
    // Nothing is held on this connection, so it is not a lock connection and closing it here
    // costs nothing — the holder is some other process.
    await connection.end().catch(() => undefined);
    throw new WorkerLockUnavailable(appName);
  }

  console.info(LOCK_ACQUIRED_MARKER, appName, row.acquired_at.toISOString());
  return { appName, connection, acquiredAt: row.acquired_at };
}
