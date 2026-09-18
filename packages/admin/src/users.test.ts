import { describe, expect, it } from "vitest";
import {
  ADMIN_USERS_RESOURCE,
  RESET_SECOND_FACTOR_ACTION,
  usersResource,
} from "./users.js";

describe("the users resource", () => {
  it("is the one resource Phase 1 ships, over hf_user", () => {
    expect(usersResource.name).toBe(ADMIN_USERS_RESOURCE);
    expect(usersResource.table).toBe("hf_user");
  });

  it("lists the columns an admin scans a user list for", () => {
    expect(usersResource.list).toEqual(["email", "name", "role", "banned", "createdAt"]);
  });

  it("offers the reset action against one row", () => {
    expect(usersResource.actions).toEqual([
      { name: RESET_SECOND_FACTOR_ACTION, label: "Reset second factor", scope: "row" },
    ]);
  });
});
