import assert from "node:assert/strict";
import test from "node:test";
import { providerDirectoryPickerItems } from "../../src/components/providers/providerDirectoryPickerItems.js";

test("provider picker keeps selected exact items available and dedupes one option source",()=>{
  const selected={id:"selected",name:"Selected exact"};
  const page=[{id:"page",name:"Page item"},{id:"selected",name:"Stale page label"}];
  assert.deepEqual(providerDirectoryPickerItems(page,[selected,selected]),[selected,page[0]]);
});
