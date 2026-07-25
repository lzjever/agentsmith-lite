import assert from "node:assert/strict";
import test from "node:test";
import { providerDirectoryExactFailure, providerDirectoryPickerItems, providerDirectoryRetryTargets } from "../../src/components/providers/providerDirectoryPickerItems.js";

test("provider picker keeps selected exact items available and dedupes one option source",()=>{
  const selected={id:"selected",name:"Selected exact"};
  const page=[{id:"page",name:"Page item"},{id:"selected",name:"Stale page label"}];
  assert.deepEqual(providerDirectoryPickerItems(page,[selected,selected]),[selected,page[0]]);
});

test("provider picker distinguishes unavailable exact items and retries every failed request",()=>{
  assert.deepEqual(providerDirectoryExactFailure("Endpoint",404,"Endpoint not found"),{message:"Selected endpoint is no longer available.",unavailable:true});
  assert.deepEqual(providerDirectoryExactFailure("Endpoint",503,"Service unavailable"),{message:"Service unavailable",unavailable:false});
  assert.deepEqual(providerDirectoryRetryTargets("page failed",{message:"exact failed",unavailable:false}),{page:true,exact:true});
  assert.deepEqual(providerDirectoryRetryTargets("",{message:"unavailable",unavailable:true}),{page:false,exact:true});
});
