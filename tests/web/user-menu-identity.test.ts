import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { userMenuIdentity } from "../../src/components/app-shell/user-menu-identity.js";

describe("user menu identity", () => {
  it("uses the local display name while keeping the verified email visible", () => {
    assert.deepEqual(
      userMenuIdentity({ id: "user_1", email: "owner@example.test", displayName: "  Percy Product Review  " }),
      {
        primary: "Percy Product Review",
        secondary: "owner@example.test",
        initials: "PP"
      }
    );
  });

  it("falls back to the email when no local display name is set", () => {
    assert.deepEqual(
      userMenuIdentity({ id: "user_1", email: "owner@example.test" }),
      {
        primary: "owner@example.test",
        secondary: "Signed in",
        initials: "OE"
      }
    );
  });
});
