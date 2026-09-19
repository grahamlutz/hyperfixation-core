import { describe, expect, it } from "vitest";
import {
  approvalsResource,
  budgetPeriodsResource,
  runsResource,
  ADMIN_APPROVALS_RESOURCE,
  ADMIN_BUDGET_PERIODS_RESOURCE,
  ADMIN_RUNS_RESOURCE,
  SET_BUDGET_ACTION,
} from "./machinery.js";

describe("the machinery resources", () => {
  it("sit over the machinery tables, with their fields off the schema", () => {
    expect(approvalsResource).toMatchObject({
      name: ADMIN_APPROVALS_RESOURCE,
      table: "hf_approval",
      primaryKey: ["id"],
    });
    expect(runsResource).toMatchObject({
      name: ADMIN_RUNS_RESOURCE,
      table: "hf_run",
      primaryKey: ["runId"],
    });
    expect(budgetPeriodsResource).toMatchObject({
      name: ADMIN_BUDGET_PERIODS_RESOURCE,
      table: "hf_budget_period",
      primaryKey: ["period"],
    });
  });

  it("carries each field's SQL column, so the template never re-derives it", () => {
    const column = (resource: typeof runsResource, name: string) =>
      resource.fields.find((field) => field.name === name)?.column;

    expect(column(runsResource, "currentWorkflowId")).toBe("current_workflow_id");
    expect(column(approvalsResource, "editedDraft")).toBe("edited_draft");
    expect(column(budgetPeriodsResource, "budgetUsd")).toBe("budget_usd");
  });

  it("leaves approvals and runs read-only: no action, so no write path exists", () => {
    expect(approvalsResource.actions).toEqual([]);
    expect(runsResource.actions).toEqual([]);
  });

  it("offers the budget action against one period", () => {
    expect(budgetPeriodsResource.actions).toEqual([
      { name: SET_BUDGET_ACTION, label: "Set budget", scope: "row" },
    ]);
  });

  it("lists what an admin scans each table for", () => {
    expect(approvalsResource.list).toEqual([
      "id",
      "type",
      "status",
      "recordType",
      "recordId",
      "assigneeId",
      "createdAt",
    ]);
    expect(runsResource.list).toEqual([
      "runId",
      "flow",
      "status",
      "attempt",
      "recordType",
      "recordId",
      "startedAt",
    ]);
    expect(budgetPeriodsResource.list).toEqual(["period", "budgetUsd", "spentUsd"]);
  });
});
