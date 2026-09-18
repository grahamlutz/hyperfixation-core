import { hfUser } from "@hyperfixation/db";
import { resourceFromTable, type AdminResource } from "./resource.js";

export const ADMIN_USERS_RESOURCE = "users";

/** The action's name on the resource; `AdminRouter.actions.resetSecondFactor` runs it. */
export const RESET_SECOND_FACTOR_ACTION = "reset-second-factor";

/**
 * Phase 1's one resource. Every field comes off `hf_user`'s Drizzle metadata; the list is the
 * five columns an admin scans for — who, what they are called, what they may do, whether they
 * are shut out, and when they arrived.
 */
export const usersResource: AdminResource = resourceFromTable(hfUser, {
  name: ADMIN_USERS_RESOURCE,
  list: ["email", "name", "role", "banned", "createdAt"],
  actions: [
    { name: RESET_SECOND_FACTOR_ACTION, label: "Reset second factor", scope: "row" },
  ],
});
