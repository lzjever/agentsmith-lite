import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { ProjectAlert, ProjectAlertRuleView } from "../../packages/contracts/src/api.js";

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

    const [active]=await services.policies.alerts(owner.user.id,project.id);
    assert.equal(active?.type,"sandbox_failure");
    assert.equal(active?.deliveryStatus,"delivered");
    assert.equal((await services.notifications.list(owner.user.id)).some((item)=>item.title==="Sandbox failure"),true);
    assert.equal((await services.alertRules.update(owner.user.id,project.id,rule.id,{enabled:false})).enabled,false);
  });

  it("keeps migrated Task alert, rule, and audit semantics read-only",async()=>{
    const store=createLocalInMemoryProductStore();
    const services=createApplicationServices({store,dataRoot:"/tmp/asl-historical-alert-rule",builtinAdminPassword:"admin-password"});
    const owner=await services.auth.loginExternalPrincipal({issuer:"https://idp.test",subject:"historical-owner",email:"historical-owner@example.test",emailVerified:true});
    const workspace=await services.workspaces.createWorkspace(owner.user.id,{name:"Workspace"});
    const project=await services.workspaces.createProject(owner.user.id,workspace.id,{name:"Project"});
    const timestamp="2026-07-22T00:00:00.000Z";
    const historicalRule:ProjectAlertRuleView={
      id:"alert_rule_historical",
      projectId:project.id,
      name:"Former task failures",
      alertType:"historical_task_failure",
      metric:"failure_count",
      condition:"greater_than_or_equal",
      threshold:1,
      windowSeconds:3600,
      scope:{kind:"project"},
      enabled:false,
      retiredWasEnabled:true,
      createdAt:timestamp,
      updatedAt:timestamp,
    };
    const historicalAlert:ProjectAlert={
      id:"alert_historical",
      projectId:project.id,
      type:"historical_task_failure",
      status:"resolved",
      deliveryStatus:"delivered",
      createdAt:timestamp,
      updatedAt:timestamp,
      resolvedAt:timestamp,
      dismissedAt:null,
    };
    const listRules=store.listProjectAlertRules.bind(store);
    const findAlert=store.findProjectAlert.bind(store);
    store.listProjectAlertRules=async(projectId)=>projectId===project.id?[historicalRule]:listRules(projectId);
    store.findProjectAlert=async(projectId,id)=>projectId===project.id&&id===historicalAlert.id?historicalAlert:findAlert(projectId,id);

    assert.deepEqual(await services.alertRules.list(owner.user.id,project.id),[historicalRule]);
    await assert.rejects(()=>services.alertRules.update(owner.user.id,project.id,historicalRule.id,{enabled:true}),/Historical alert rules are read-only/);
    await assert.rejects(()=>services.alertRules.remove(owner.user.id,project.id,historicalRule.id),/Historical alert rules are read-only/);
    await assert.rejects(()=>services.alertRules.test(owner.user.id,project.id,historicalRule.id),/Historical alert rules are read-only/);
    await assert.rejects(()=>services.alertRules.acknowledge(owner.user.id,project.id,historicalAlert.id),/Historical alerts are read-only/);
    await assert.rejects(()=>services.alertRules.silence(owner.user.id,project.id,historicalAlert.id,null),/Historical alerts are read-only/);
    await assert.rejects(()=>services.policies.transitionAlert(owner.user.id,project.id,historicalAlert.id,"dismissed"),/Historical alerts are read-only/);
    await assert.rejects(
      ()=>store.appendProjectAuditEvent({id:"audit_historical_write",projectId:project.id,actorId:null,action:"task.historical_terminal",status:"accepted",resourceKind:"task",resourceId:"task_1",detail:{historicalAction:"task.failed"},createdAt:timestamp}),
      /Historical audit events are read-only/
    );
  });
});
