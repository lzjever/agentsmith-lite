import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memberDirectoryPickerItems } from "../../src/components/members/memberDirectoryPickerItems.js";

describe("member directory picker items", () => {
  it("uses one deduped source for current-page, selected, and pinned options", () => {
    const you={userId:"user_you",displayName:"You",email:"you@example.test"};
    const selected={userId:"user_selected",displayName:"Selected",email:"selected@example.test"};
    const pageMember={userId:"user_page",displayName:"Page member",email:"page@example.test"};

    const items=memberDirectoryPickerItems({
      page:[pageMember,selected],
      pinned:[you,selected],
      selected
    });

    assert.deepEqual(items.map((item)=>item.userId),["user_you","user_selected","user_page"]);
    assert.equal(items.find((item)=>item.userId==="user_you"),you);
  });
});
