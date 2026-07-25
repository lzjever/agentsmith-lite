import assert from "node:assert/strict";
import test from "node:test";
import { endpointLocationWithoutFocus } from "../../src/components/endpoints/endpoints-page/endpointFocus.js";

test("removing a focused endpoint preserves every other query parameter",()=>{
  assert.equal(
    endpointLocationWithoutFocus("/workspaces/w/projects/p/endpoints","q=provider&endpointId=endp%2F1&view=compact","endp/1"),
    "/workspaces/w/projects/p/endpoints?q=provider&view=compact"
  );
  assert.equal(
    endpointLocationWithoutFocus("/workspaces/w/projects/p/endpoints","q=provider&endpointId=other","endp/1"),
    "/workspaces/w/projects/p/endpoints?q=provider&endpointId=other"
  );
});
