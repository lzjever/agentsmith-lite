import assert from "node:assert/strict";
import test from "node:test";
import { providerDirectoryExactFailure, providerDirectoryExactItemAvailable, providerDirectoryExactResultApplies, providerDirectoryPickerItems, providerDirectoryRetryTargets } from "../../src/components/providers/providerDirectoryPickerItems.js";

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

test("task-ready exact restoration rejects endpoints that are not explicitly eligible",()=>{
  assert.equal(providerDirectoryExactItemAvailable("task_ready",{id:"ready",taskEligible:true}),true);
  assert.equal(providerDirectoryExactItemAvailable("task_ready",{id:"not-ready",taskEligible:false}),false);
  assert.equal(providerDirectoryExactItemAvailable("task_ready",{id:"legacy"}),false);
  assert.equal(providerDirectoryExactItemAvailable("all",{id:"not-ready",taskEligible:false}),true);
});

test("an exact result applies only to the same current value and revision",()=>{
  assert.equal(providerDirectoryExactResultApplies("A","A",3,3),true);
  assert.equal(providerDirectoryExactResultApplies("A","B",3,3),false);
  assert.equal(providerDirectoryExactResultApplies("A","A",2,3),false);
});
