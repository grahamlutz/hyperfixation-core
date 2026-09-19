import { hfApproval, hfBudgetPeriod, hfRun } from "@hyperfixation/db";
import { resourceFromTable, type AdminResource } from "./resource.js";

export const ADMIN_APPROVALS_RESOURCE = "approvals";
export const ADMIN_RUNS_RESOURCE = "runs";
export const ADMIN_BUDGET_PERIODS_RESOURCE = "budget-periods";

/** The action's name on the resource; `AdminRouter.actions.setBudget` runs it. */
export const SET_BUDGET_ACTION = "set-budget";

/**
 * Read-only: a decision is the workflow's to make through `decide()`, which fences it against
 * the run. An admin who could edit `hf_approval` directly would be deciding behind the fence.
 */
export const approvalsResource: AdminResource = resourceFromTable(hfApproval, {
  name: ADMIN_APPROVALS_RESOURCE,
  list: ["id", "type", "status", "recordType", "recordId", "assigneeId", "createdAt"],
});

/** Read-only for the same reason: `current_workflow_id` is the fencing token, not a field. */
export const runsResource: AdminResource = resourceFromTable(hfRun, {
  name: ADMIN_RUNS_RESOURCE,
  list: ["runId", "flow", "status", "attempt", "recordType", "recordId", "startedAt"],
});

/**
 * The one machinery table an admin may write, and only `budget_usd` through the action.
 * `spent_usd` is the ledger's own running total — editing it would make the gate lie.
 */
export const budgetPeriodsResource: AdminResource = resourceFromTable(hfBudgetPeriod, {
  name: ADMIN_BUDGET_PERIODS_RESOURCE,
  list: ["period", "budgetUsd", "spentUsd"],
  actions: [{ name: SET_BUDGET_ACTION, label: "Set budget", scope: "row" }],
});
