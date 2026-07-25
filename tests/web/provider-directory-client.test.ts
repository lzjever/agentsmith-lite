import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { apiClient } from "../../src/lib/api/client.js";

const originalFetch=globalThis.fetch;

afterEach(()=>{globalThis.fetch=originalFetch});

it("sends bounded provider directory scope, including empty cursors and Usage user",async()=>{
  const requests:string[]=[];
  globalThis.fetch=async(input)=>{
    requests.push(requestUrl(input));
    return Response.json({items:[],nextCursor:null,total:0,readiness:{taskReady:0}});
  };

  await apiClient.credentials("project/1",{q:"Provider",cursor:"",limit:20});
  await apiClient.endpoints("project/1",{q:"Model",mode:"task_ready",cursor:"endpoint+/=",limit:20});
  await apiClient.endpointUsage("project/1",{q:"Usage",cursor:"usage+/=",limit:20,userId:"user/1"});

  assert.deepEqual(requests,[
    "/api/v1/projects/project%2F1/credentials?q=Provider&cursor=&limit=20",
    "/api/v1/projects/project%2F1/endpoints?q=Model&mode=task_ready&cursor=endpoint%2B%2F%3D&limit=20",
    "/api/v1/projects/project%2F1/usage/endpoints?q=Usage&userId=user%2F1&cursor=usage%2B%2F%3D&limit=20"
  ]);
});

function requestUrl(input:string|URL|Request):string{
  const value=typeof input==="string"?input:input instanceof URL?input.toString():input.url;
  const url=new URL(value,"https://agentsmith.test");
  return `${url.pathname}${url.search}`;
}
