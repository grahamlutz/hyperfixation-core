export class AppPaused extends Error {
  readonly runId: string;
  readonly key: string;

  constructor(runId: string, key: string) {
    super(`AppPaused: the app is paused, refusing llm.run ${JSON.stringify(key)} of run ${runId}`);
    this.name = "AppPaused";
    this.runId = runId;
    this.key = key;
  }
}

/**
 * Same key, different call. Never served from the cached row: a key that means two different
 * things is a bug in the flow, and answering the second call with the first one's output would
 * hide it behind a plausible result.
 */
export class LedgerKeyCollision extends Error {
  readonly runId: string;
  readonly key: string;
  readonly storedInputHash: string;
  readonly inputHash: string;

  constructor(runId: string, key: string, storedInputHash: string, inputHash: string) {
    super(
      `LedgerKeyCollision: run ${runId} already has an hf_llm_call row for key ` +
        `${JSON.stringify(key)} with input_hash ${storedInputHash}, and this call hashes to ` +
        `${inputHash}`,
    );
    this.name = "LedgerKeyCollision";
    this.runId = runId;
    this.key = key;
    this.storedInputHash = storedInputHash;
    this.inputHash = inputHash;
  }
}

export class BudgetExceeded extends Error {
  readonly period: string;
  readonly budgetUsd: string;
  readonly spentUsd: string;
  readonly reservedUsd: string;
  readonly estimatedCostUsd: number;

  constructor(
    period: string,
    budgetUsd: string,
    spentUsd: string,
    reservedUsd: string,
    estimatedCostUsd: number,
  ) {
    super(
      `BudgetExceeded: period ${period} has spent ${spentUsd} and reserved ${reservedUsd} of ` +
        `${budgetUsd}; a call estimated at ${estimatedCostUsd} does not fit`,
    );
    this.name = "BudgetExceeded";
    this.period = period;
    this.budgetUsd = budgetUsd;
    this.spentUsd = spentUsd;
    this.reservedUsd = reservedUsd;
    this.estimatedCostUsd = estimatedCostUsd;
  }
}
