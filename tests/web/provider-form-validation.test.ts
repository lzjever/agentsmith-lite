import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidEndpointRequestTimeout,
  providerBaseUrlError
} from "../../src/components/providers/providerFormValidation.js";

test("provider credential URL validation mirrors the server boundary",()=>{
  assert.equal(providerBaseUrlError("https://api.example.test/v1"),null);
  for(const value of [
    "http://api.example.test/v1",
    "https://user:pass@api.example.test/v1",
    "https://api.example.test/v1?region=one",
    "https://api.example.test/v1#models",
    "not a URL"
  ])assert.notEqual(providerBaseUrlError(value),null,value);
});

test("endpoint timeout accepts only safe integers from 1 through 600",()=>{
  for(const value of [1,600])assert.equal(isValidEndpointRequestTimeout(value),true);
  for(const value of [0,601,1.5,Number.MAX_SAFE_INTEGER+1])assert.equal(isValidEndpointRequestTimeout(value),false);
});
