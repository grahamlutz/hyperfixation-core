/** The two run statuses an attempt can end in without being finished. */
export const SUSPEND_STATUSES = ["waiting", "paused"] as const;
export type SuspendStatus = (typeof SUSPEND_STATUSES)[number];

/**
 * Ends the current attempt without failing it: the flow stops here and the run is left for a
 * later attempt to pick up. Thrown by the pause gate in `step()`, and by `waitForApproval`
 * when that lands.
 *
 * It must be thrown from the flow body rather than from inside a `DBOS.runStep` body: a step
 * that throws has its error checkpointed through `serialize-error`, and a replay revives a
 * plain `Error` that no `instanceof Suspend` would catch.
 */
export class Suspend extends Error {
  readonly runId: string;
  readonly status: SuspendStatus;

  constructor(runId: string, status: SuspendStatus, reason: string) {
    super(`Suspend: run ${runId} ends this attempt ${status} — ${reason}`);
    this.name = "Suspend";
    this.runId = runId;
    this.status = status;
  }
}
