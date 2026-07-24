import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { ProductError } from "../../packages/domain/src/errors.js";

describe("notification and alert rules",()=>{
  it("evaluates Sandbox failures without a terminal Task alert type",async()=>{
    const store=createLocalInMemoryProductStore();
    const services=createApplicationServices({store,dataRoot:"/tmp/asl-alert-rule",builtinAdminPassword:"admin-password"});
    const owner=await services.auth.loginExternalPrincipal({issuer:"https://idp.test",subject:"owner",email:"owner@example.test",emailVerified:true});
    const workspace=await services.workspaces.createWorkspace(owner.user.id,{name:"Workspace"});
    const project=await services.workspaces.createProject(owner.user.id,workspace.id,{name:"Project"});
    const rule=await services.alertRules.create(owner.user.id,project.id,{alertType:"sandbox_failure"});
    await store.appendProjectAuditEvent({id:"sandbox_failure",projectId:project.id,actorId:null,action:"sandbox.failed",status:"accepted",resourceKind:"sandbox",resourceId:"task_1",createdAt:new Date().toISOString()});
    await services.policies.raiseAlert(project.id,"sandbox_failure");

    const [active]=(await services.policies.alerts(owner.user.id,project.id)).items;
    assert.equal(active?.type,"sandbox_failure");
    assert.equal(active?.deliveryStatus,"delivered");
    assert.equal((await services.notifications.list(owner.user.id)).some((item)=>item.title==="Sandbox failure"),true);
    assert.equal((await services.alertRules.update(owner.user.id,project.id,rule.id,{enabled:false})).enabled,false);
  });

  it("caps a project at 50 rules across replay and concurrent creation",async()=>{
    const store=createLocalInMemoryProductStore();
    const services=createApplicationServices({store,dataRoot:"/tmp/asl-alert-rule-cap",builtinAdminPassword:"admin-password"});
    const owner=await services.auth.loginExternalPrincipal({issuer:"https://idp.test",subject:"cap-owner",email:"cap-owner@example.test",emailVerified:true});
    const workspace=await services.workspaces.createWorkspace(owner.user.id,{name:"Workspace"});
    const project=await services.workspaces.createProject(owner.user.id,workspace.id,{name:"Capped"});
    await seedRules(store,project.id,49,"capped");

    const fiftieth=await services.alertRules.create(owner.user.id,project.id,{alertType:"sandbox_failure",enabled:false},"rule-50");
    assert.deepEqual(await services.alertRules.create(owner.user.id,project.id,{alertType:"sandbox_failure",enabled:false},"rule-50"),fiftieth);
    assert.equal((await store.listProjectAlertRules(project.id)).length,50);
    await assert.rejects(
      ()=>services.alertRules.create(owner.user.id,project.id,{alertType:"sandbox_failure",enabled:false},"rule-51"),
      (error:unknown)=>error instanceof ProductError&&error.statusCode===409,
    );

    const racedProject=await services.workspaces.createProject(owner.user.id,workspace.id,{name:"Raced"});
    await seedRules(store,racedProject.id,49,"raced");
    const results=await Promise.allSettled([
      services.alertRules.create(owner.user.id,racedProject.id,{alertType:"provider_failure",enabled:false},"race-a"),
      services.alertRules.create(owner.user.id,racedProject.id,{alertType:"provider_failure",enabled:false},"race-b"),
    ]);
    assert.equal(results.filter((result)=>result.status==="fulfilled").length,1);
    const rejected=results.find((result):result is PromiseRejectedResult=>result.status==="rejected");
    assert.ok(rejected?.reason instanceof ProductError);
    assert.equal((rejected.reason as ProductError).statusCode,409);
    assert.equal((await store.listProjectAlertRules(racedProject.id)).length,50);
  });

  it("finds, tests, updates, and deletes rules by project and ID",async()=>{
    const store=createLocalInMemoryProductStore();
    const services=createApplicationServices({store,dataRoot:"/tmp/asl-alert-rule-by-id",builtinAdminPassword:"admin-password"});
    const owner=await services.auth.loginExternalPrincipal({issuer:"https://idp.test",subject:"by-id-owner",email:"by-id-owner@example.test",emailVerified:true});
    const workspace=await services.workspaces.createWorkspace(owner.user.id,{name:"Workspace"});
    const project=await services.workspaces.createProject(owner.user.id,workspace.id,{name:"Rules"});
    const rule=await services.alertRules.create(owner.user.id,project.id,{alertType:"sandbox_failure",enabled:false});
    store.listProjectAlertRules=async()=>{throw new Error("rule list must not be used for ID operations")};

    assert.equal((await services.alertRules.find(owner.user.id,project.id,rule.id)).id,rule.id);
    assert.equal((await services.alertRules.test(owner.user.id,project.id,rule.id)).metric,"failure_count");
    const updated=await services.alertRules.update(owner.user.id,project.id,rule.id,{name:"Updated",expectedUpdatedAt:rule.updatedAt});
    assert.equal(updated.name,"Updated");
    assert.deepEqual(await services.alertRules.remove(owner.user.id,project.id,rule.id),{deleted:true});
  });
});

async function seedRules(store:ReturnType<typeof createLocalInMemoryProductStore>,projectId:string,count:number,prefix:string){
  for(let index=0;index<count;index+=1){
    const timestamp=new Date(Date.UTC(2026,6,22,0,0,index)).toISOString();
    await store.createProjectAlertRule({id:`alert_rule_${prefix}_${index}`,projectId,name:`Rule ${index}`,alertType:"sandbox_failure",metric:"failure_count",condition:"greater_than_or_equal",threshold:1,windowSeconds:3600,scope:{kind:"project"},enabled:false,createdAt:timestamp,updatedAt:timestamp});
  }
}
