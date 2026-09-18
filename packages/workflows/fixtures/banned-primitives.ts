/**
 * Redeploy case 5's fixture. It is deliberately lint-illegal, which is why it lives outside
 * `src/`: the package's own `lint` script is `eslint src`, so nothing but the case itself ever
 * points `eslint` at this file. It is never compiled and never run — `tsconfig.json` includes
 * only `src` — so it does not have to typecheck either.
 *
 * Each shape is one the run model forbids: a patched redeploy, a workflow parked in `recv`,
 * and a decision written to a DBOS row that may already be collected.
 */
import { DBOS, type DBOSClient } from "@dbos-inc/dbos-sdk";

export async function reviewRecord(recordId: string): Promise<string> {
  DBOS.patch("review", 2);

  return await DBOS.recv<string>(`approval:${recordId}`, 7 * 24 * 60 * 60);
}

export async function publishDecision(
  dbosClient: DBOSClient,
  workflowId: string,
  decision: string,
): Promise<void> {
  await dbosClient.sendInTransaction(workflowId, decision, "approval");
}
