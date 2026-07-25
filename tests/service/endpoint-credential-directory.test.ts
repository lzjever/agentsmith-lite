import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { ProductError } from "../../packages/domain/src/errors.js";

describe("bounded endpoint and credential directories",()=>{
  it("pages credentials with bound cursors and exact public isolation",async()=>{
    const fixture=await createFixture();
    const tiedAt="2026-07-24T00:01:00.000Z";
    await fixture.credential("credential_\uE000","High BMP",tiedAt);
    await fixture.credential("credential_\u{10000}","Astral",tiedAt);

    const first=await fixture.services.credentials.list(fixture.owner.id,fixture.project.id,{limit:1});
    assert.deepEqual(first.items.map((item)=>item.id),["credential_\u{10000}"]);
    assert.ok(first.nextCursor);
    assert.equal("ciphertext" in first.items[0]!,false);
    const second=await fixture.services.credentials.list(fixture.owner.id,fixture.project.id,{cursor:first.nextCursor!,limit:1});
    assert.deepEqual(second.items.map((item)=>item.id),["credential_\uE000"]);
    assert.deepEqual((await fixture.services.credentials.list(fixture.owner.id,fixture.project.id,{q:"high bmp"})).items.map((item)=>item.id),["credential_\uE000"]);
    await assert.rejects(()=>fixture.services.credentials.list(fixture.viewer.id,fixture.project.id,{cursor:first.nextCursor!}),invalidCursor);
    await assert.rejects(()=>fixture.services.credentials.list(fixture.owner.id,fixture.otherProject.id,{cursor:first.nextCursor!}),invalidCursor);
    await assert.rejects(()=>fixture.services.credentials.list(fixture.owner.id,fixture.project.id,{cursor:""}),invalidCursor);
    await assert.rejects(()=>fixture.services.credentials.list(fixture.owner.id,fixture.project.id,{cursor:"x".repeat(4097)}),invalidCursor);
    await assert.rejects(()=>fixture.services.credentials.list(fixture.owner.id,fixture.project.id,{q:"x".repeat(161)}),status(400));
    await assert.rejects(()=>fixture.services.credentials.list(fixture.owner.id,fixture.project.id,{q:"bad\nquery"}),status(400));
    await assert.rejects(()=>fixture.services.credentials.list(fixture.owner.id,fixture.project.id,{limit:51}),status(400));
    const exact=await fixture.services.credentials.get(fixture.owner.id,fixture.project.id,"credential_\uE000");
    assert.equal(exact.name,"High BMP");
    assert.equal("ciphertext" in exact,false);
    await assert.rejects(()=>fixture.services.credentials.get(fixture.owner.id,fixture.otherProject.id,"credential_\uE000"),status(404));
  });

  it("pages endpoint views by C keyset, task readiness, exact metadata, and bounded business lookups",async()=>{
    const fixture=await createFixture();
    const tiedAt="2026-07-24T00:02:00.000Z";
    const credential=await fixture.credential("credential_endpoint","Provider",tiedAt);
    await fixture.endpoint("endpoint_\uE000","High BMP",credential.id,tiedAt,true);
    await fixture.endpoint("endpoint_\u{10000}","Astral",credential.id,tiedAt,false);

    const first=await fixture.services.endpoints.listEndpoints(fixture.owner.id,fixture.project.id,{limit:1});
    assert.deepEqual(first.items.map((item)=>item.id),["endpoint_\u{10000}"]);
    assert.equal(first.total,2);
    assert.deepEqual(first.readiness,{taskReady:1});
    assert.equal(first.items[0]?.credential?.name,"Provider");
    const second=await fixture.services.endpoints.listEndpoints(fixture.owner.id,fixture.project.id,{cursor:first.nextCursor!,limit:1});
    assert.deepEqual(second.items.map((item)=>item.id),["endpoint_\uE000"]);
    assert.deepEqual((await fixture.services.endpoints.listEndpoints(fixture.owner.id,fixture.project.id,{mode:"task_ready"})).items.map((item)=>item.id),["endpoint_\uE000"]);
    assert.deepEqual((await fixture.services.endpoints.listEndpoints(fixture.owner.id,fixture.project.id,{q:"astral"})).items.map((item)=>item.id),["endpoint_\u{10000}"]);
    await assert.rejects(()=>fixture.services.endpoints.listEndpoints(fixture.owner.id,fixture.project.id,{q:"changed",cursor:first.nextCursor!}),invalidCursor);
    await assert.rejects(()=>fixture.services.endpoints.listEndpoints(fixture.owner.id,fixture.project.id,{mode:"task_ready",cursor:first.nextCursor!}),invalidCursor);
    await assert.rejects(()=>fixture.services.endpoints.listEndpoints(fixture.viewer.id,fixture.project.id,{cursor:first.nextCursor!}),invalidCursor);
    await assert.rejects(()=>fixture.services.endpoints.listEndpoints(fixture.owner.id,fixture.otherProject.id,{cursor:first.nextCursor!}),invalidCursor);
    await assert.rejects(()=>fixture.services.endpoints.listEndpoints(fixture.owner.id,fixture.project.id,{cursor:""}),invalidCursor);
    assert.equal((await fixture.services.endpoints.getEndpoint(fixture.owner.id,fixture.project.id,"endpoint_\uE000")).credential?.id,credential.id);
    await assert.rejects(()=>fixture.services.endpoints.getEndpoint(fixture.owner.id,fixture.otherProject.id,"endpoint_\uE000"),status(404));
    assert.equal(await fixture.store.projectEndpointNameExists(fixture.project.id,"high bmp"),true);
    assert.deepEqual(await fixture.store.findProjectEndpointIds(fixture.project.id,["endpoint_\uE000","missing","endpoint_\uE000"]),["endpoint_\uE000"]);
    assert.deepEqual(await fixture.store.getProjectEndpointReadiness(fixture.project.id),{total:2,taskReady:1});
    const alertAt="2026-07-24T00:03:00.000Z";
    await fixture.store.upsertActiveProjectAlert({id:"alert_endpoint",projectId:fixture.project.id,type:"endpoint_failure",status:"active",deliveryStatus:"not_configured",endpointId:"endpoint_\uE000",createdAt:alertAt,updatedAt:alertAt,resolvedAt:null,dismissedAt:null});
    assert.equal((await fixture.services.policies.alerts(fixture.owner.id,fixture.project.id)).items[0]?.endpointName,"High BMP");

    const batches:string[][]=[],findIds=fixture.store.findProjectEndpointIds.bind(fixture.store);
    fixture.store.findProjectEndpointIds=async(projectId,ids)=>{batches.push(ids);return findIds(projectId,ids)};
    await fixture.services.policies.updatePolicy(fixture.owner.id,fixture.project.id,{endpointWindows:[
      {endpointId:"endpoint_\uE000",metric:"providerRequests",limit:10,windowSeconds:3600},
      {endpointId:"endpoint_\uE000",metric:"providerTokens",limit:100,windowSeconds:3600}
    ]});
    assert.deepEqual(batches,[["endpoint_\uE000"]]);
    await assert.rejects(()=>fixture.services.policies.updatePolicy(fixture.owner.id,fixture.project.id,{endpointWindows:[{endpointId:"missing",metric:"providerRequests",limit:1,windowSeconds:3600}]}),status(404));

    const usage=await fixture.services.policies.getEndpointUsagePage(fixture.owner.id,fixture.project.id,{limit:1});
    assert.equal(usage.items.length,1);assert.ok(usage.nextCursor);
    const viewerUsage=await fixture.services.policies.getEndpointUsagePage(fixture.owner.id,fixture.project.id,{userId:fixture.viewer.id,limit:1});
    assert.ok(viewerUsage.nextCursor);
    await assert.rejects(()=>fixture.services.policies.getEndpointUsagePage(fixture.owner.id,fixture.project.id,{cursor:viewerUsage.nextCursor!}),invalidCursor);
    await assert.rejects(()=>fixture.services.policies.getEndpointUsagePage(fixture.viewer.id,fixture.project.id,{cursor:usage.nextCursor!}),invalidCursor);
    await assert.rejects(()=>fixture.services.policies.getEndpointUsagePage(fixture.owner.id,fixture.otherProject.id,{cursor:usage.nextCursor!}),invalidCursor);
  });
});

async function createFixture(){
  const store=createInMemoryProductStore();
  const services=createApplicationServices({
    store,dataRoot:"/agentsmith-lite",builtinAdminPassword:"admin-password",
    providerClient:{async validateEndpoint(){return{status:"healthy" as const}},async completeChat(){throw new Error("not used")}}
  });
  const owner=(await services.auth.loginAfterBootstrap("admin-password")).user;
  const workspace=await services.workspaces.createWorkspace(owner.id,{name:"Workspace"});
  const project=await services.workspaces.createProject(owner.id,workspace.id,{name:"Project"});
  const otherProject=await services.workspaces.createProject(owner.id,workspace.id,{name:"Other"});
  const viewer=(await services.auth.loginExternalPrincipal({issuer:"https://idp.test",subject:"viewer",email:"viewer@example.test",emailVerified:true})).user;
  const joinedAt="2026-07-24T00:00:00.000Z";
  await store.upsertWorkspaceMembership({workspaceId:workspace.id,userId:viewer.id,role:"viewer",createdAt:joinedAt,updatedAt:joinedAt});
  await store.upsertProjectMembership({projectId:project.id,userId:viewer.id,role:"viewer",createdAt:joinedAt,updatedAt:joinedAt});
  return{
    store,services,owner,viewer,project,otherProject,
    async credential(id:string,name:string,createdAt:string){
      return store.createProjectCredential({id,projectId:project.id,name,type:"api_key",baseUrl:"https://models.example.test/v1",fingerprint:id,version:1,keyId:"test",nonce:Buffer.alloc(12),ciphertext:Buffer.from("secret"),authTag:Buffer.alloc(16),createdAt,lastRotatedAt:null,updatedAt:createdAt});
    },
    async endpoint(id:string,name:string,credentialId:string,createdAt:string,taskReady:boolean){
      return store.createEndpoint({id,projectId:project.id,name,protocol:"openai_chat_completions",baseUrl:"https://models.example.test/v1",model:"model",credentialId,capabilities:taskReady?["text","tool_calls"]:["text"],requestTimeoutSecs:30,health:{status:"healthy",checkedAt:createdAt,errorCategory:null},createdAt,updatedAt:createdAt});
    }
  };
}

function status(code:number){return(error:unknown)=>error instanceof ProductError&&error.statusCode===code}
function invalidCursor(error:unknown){return error instanceof ProductError&&error.statusCode===400&&/cursor is invalid/.test(error.message)}
