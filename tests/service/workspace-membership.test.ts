import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { ProductError } from "../../packages/domain/src/errors.js";

describe("workspace memberships", () => {
  it("uses explicit memberships for access and protects the final owner", async () => {
    const store=createInMemoryProductStore(); const services=createApplicationServices({store,dataRoot:"/agentsmith-lite",builtinAdminPassword:"admin-password"});
    const owner=await services.auth.loginExternalPrincipal({issuer:"https://issuer",subject:"owner",email:"owner@example.test",emailVerified:true});
    const admin=await services.auth.loginExternalPrincipal({issuer:"https://issuer",subject:"admin",email:"admin@example.test",emailVerified:true});
    const member=await services.auth.loginExternalPrincipal({issuer:"https://issuer",subject:"member",email:"member@example.test",emailVerified:true});
    const viewer=await services.auth.loginExternalPrincipal({issuer:"https://issuer",subject:"viewer",email:"viewer@example.test",emailVerified:true});
    const workspace=await services.workspaces.createWorkspace(owner.user.id,{name:"Workspace"});
    await store.upsertUserProfilePreferences({userId:owner.user.id,displayName:"Owner display",timezone:null,bio:null,jobTitle:null,company:null,greetingPreference:null,interests:[],updatedAt:new Date().toISOString()});
    await store.upsertUserProfilePreferences({userId:member.user.id,displayName:"Member display",timezone:null,bio:null,jobTitle:null,company:null,greetingPreference:null,interests:[],updatedAt:new Date().toISOString()});
    const ownerWorkspace = (await services.workspaces.listWorkspaces(owner.user.id))[0];
    assert.equal(ownerWorkspace?.capabilities.canManageMembers,true);
    assert.deepEqual([ownerWorkspace?.owner, ownerWorkspace?.memberRole], [{ displayName: "Owner display", email: owner.user.email }, "owner"]);
    await services.workspaceMemberships.add(owner.user.id,workspace.id,{email:admin.user.email},"admin");
    const addedMember=await services.workspaceMemberships.add(owner.user.id,workspace.id,{email:member.user.email},"member");
    assert.deepEqual([addedMember.displayName,addedMember.email,addedMember.role],["Member display",member.user.email,"member"]);
    const changedMember=await services.workspaceMemberships.change(owner.user.id,workspace.id,member.user.id,"viewer");
    assert.deepEqual([changedMember.displayName,changedMember.email,changedMember.role],["Member display",member.user.email,"viewer"]);
    await services.workspaceMemberships.change(owner.user.id,workspace.id,member.user.id,"member");
    await assert.rejects(()=>services.workspaceMemberships.add(owner.user.id,workspace.id,{email:member.user.email},"viewer"),status(409));
    assert.equal((await store.findWorkspaceMembership(workspace.id,member.user.id))?.role,"member");
    await services.workspaceMemberships.add(owner.user.id,workspace.id,{email:viewer.user.email},"viewer");
    const firstProject=await services.workspaces.createProject(owner.user.id,workspace.id,{name:"First project"});
    const secondProject=await services.workspaces.createProject(owner.user.id,workspace.id,{name:"Second project"});
    await services.memberships.addMember(owner.user.id,firstProject.id,member.user.id,"member");
    await services.memberships.addMember(owner.user.id,secondProject.id,member.user.id,"viewer");
    assert.deepEqual((await services.workspaceMemberships.list(owner.user.id,workspace.id)).find((entry)=>entry.userId===owner.user.id)?.displayName,"Owner display");
    const memberWorkspace = (await services.workspaces.listWorkspaces(member.user.id))[0];
    assert.equal(memberWorkspace?.id,workspace.id);
    assert.deepEqual([memberWorkspace?.owner, memberWorkspace?.memberRole], [{ displayName: "Owner display", email: owner.user.email }, "member"]);
    assert.equal(memberWorkspace?.capabilities.canCreateProject,false);
    const adminProject=await services.workspaces.createProject(admin.user.id,workspace.id,{name:"Admin project"});
    await assert.rejects(()=>services.workspaces.createProject(member.user.id,workspace.id,{name:"Blocked"}),status(403));
    assert.equal((await services.workspaces.listWorkspaces(viewer.user.id))[0]?.id,workspace.id);
    await assert.rejects(()=>services.workspaces.createProject(viewer.user.id,workspace.id,{name:"Viewer blocked"}),status(403));
    await services.contexts.upsert(viewer.user.id,{workspaceId:workspace.id,scope:"workspace_personal",contextKey:"viewer.note",content:"private",contentType:"text"});
    await assert.rejects(()=>services.contexts.upsert(viewer.user.id,{workspaceId:workspace.id,scope:"workspace_shared",contextKey:"viewer.shared",content:"blocked",contentType:"text"}),status(403));
    await assert.rejects(()=>services.workspaceMemberships.change(admin.user.id,workspace.id,owner.user.id,"member"),status(409));
    await assert.rejects(()=>services.workspaceMemberships.remove(admin.user.id,workspace.id,owner.user.id),status(409));
    assert.equal((await store.findWorkspaceMembership(workspace.id,owner.user.id))?.role,"owner");
    assert.equal((await store.findProjectMembership(firstProject.id,owner.user.id))?.role,"owner");
    await assert.rejects(()=>services.workspaceMemberships.remove(owner.user.id,workspace.id,admin.user.id),status(409));
    assert.equal((await store.findWorkspaceMembership(workspace.id,admin.user.id))?.role,"admin");
    assert.equal((await store.findProjectMembership(adminProject.id,admin.user.id))?.role,"owner");

    await services.workspaceMemberships.transferOwner(owner.user.id,workspace.id,viewer.user.id);
    assert.equal(await store.updateManagedWorkspaceMembershipRole(workspace.id,viewer.user.id,"member",new Date().toISOString()),"owner");
    assert.equal((await store.findWorkspaceMembership(workspace.id,viewer.user.id))?.role,"owner");

    for(const project of [firstProject,secondProject])await store.createUserNotification({id:`notice_${project.id}`,userId:member.user.id,type:"project_alert",title:"Project alert",body:"Membership will be removed",projectId:project.id,resourceKind:"alert",resourceId:`alert_${project.id}`,linkPath:`/projects/${project.id}/alerts`,readAt:null,createdAt:"2026-07-11T00:00:00.000Z"});
    await store.createUserNotification({id:"notice_workspace_owner",userId:owner.user.id,type:"project_alert",title:"Owner alert",body:"Retain",projectId:firstProject.id,resourceKind:"alert",resourceId:"alert_owner",linkPath:`/projects/${firstProject.id}/alerts`,readAt:null,createdAt:"2026-07-11T00:00:00.000Z"});
    await services.workspaceMemberships.remove(admin.user.id,workspace.id,member.user.id);
    assert.equal(await store.findWorkspaceMembership(workspace.id,member.user.id),null);
    assert.equal(await store.findProjectMembership(firstProject.id,member.user.id),null);
    assert.equal(await store.findProjectMembership(secondProject.id,member.user.id),null);
    assert.deepEqual(await store.listUserNotifications(member.user.id),[]);
    assert.deepEqual((await store.listUserNotifications(owner.user.id)).map((item)=>item.id),["notice_workspace_owner"]);
    for (const projectId of [firstProject.id, secondProject.id]) {
      const removals = (await store.listProjectAuditEvents(projectId)).filter((event) => event.action === "membership.remove");
      assert.deepEqual(removals.map((event) => [event.actorId, event.resourceKind, event.resourceId, event.status]), [[admin.user.id, "member", member.user.id, "accepted"]]);
    }
    await assert.rejects(()=>services.authorization.requireProject(member.user.id,firstProject.id,"view"),status(403));
  });
  it("accepts only one concurrent workspace membership add",async()=>{
    const store=createInMemoryProductStore();const services=createApplicationServices({store,dataRoot:"/agentsmith-lite",builtinAdminPassword:"admin-password"});
    const owner=await services.auth.loginExternalPrincipal({issuer:"https://issuer",subject:"concurrent-owner",email:"concurrent-owner@example.test",emailVerified:true});
    const member=await services.auth.loginExternalPrincipal({issuer:"https://issuer",subject:"concurrent-member",email:"concurrent-member@example.test",emailVerified:true});
    const workspace=await services.workspaces.createWorkspace(owner.user.id,{name:"Workspace"});
    const results=await Promise.allSettled([services.workspaceMemberships.add(owner.user.id,workspace.id,{email:member.user.email},"member"),services.workspaceMemberships.add(owner.user.id,workspace.id,{email:member.user.email},"viewer")]);
    assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
    const rejected=results.find((result):result is PromiseRejectedResult=>result.status==="rejected");assert.ok(rejected?.reason instanceof ProductError);assert.equal((rejected.reason as ProductError).statusCode,409);
  });
  it("replays workspace membership creation, role changes, and removal",async()=>{const store=createInMemoryProductStore();const services=createApplicationServices({store,dataRoot:"/agentsmith-lite",builtinAdminPassword:"admin-password"});const owner=await services.auth.loginExternalPrincipal({issuer:"https://issuer",subject:"replay-owner",email:"replay-owner@example.test",emailVerified:true});const member=await services.auth.loginExternalPrincipal({issuer:"https://issuer",subject:"replay-member",email:"replay-member@example.test",emailVerified:true});const workspace=await services.workspaces.createWorkspace(owner.user.id,{name:"Workspace"});const add=services.workspaceMemberships.add.bind(services.workspaceMemberships) as (actor:string,workspaceId:string,identity:{email:string},role:"member",key:string)=>Promise<{userId:string}>;const first=await add(owner.user.id,workspace.id,{email:member.user.email},"member","workspace-member-key");const replayed=await add(owner.user.id,workspace.id,{email:member.user.email},"member","workspace-member-key");assert.equal(replayed.userId,first.userId);const change=services.workspaceMemberships.change.bind(services.workspaceMemberships) as (actor:string,workspaceId:string,userId:string,role:"viewer",key:string)=>Promise<{role:string}>;const changed=await change(owner.user.id,workspace.id,member.user.id,"viewer","workspace-member-change-key");assert.deepEqual(await change(owner.user.id,workspace.id,member.user.id,"viewer","workspace-member-change-key"),changed);const remove=services.workspaceMemberships.remove.bind(services.workspaceMemberships) as (actor:string,workspaceId:string,userId:string,key:string)=>Promise<void>;await remove(owner.user.id,workspace.id,member.user.id,"workspace-member-remove-key");await remove(owner.user.id,workspace.id,member.user.id,"workspace-member-remove-key");assert.equal((await store.listWorkspaceMemberships(workspace.id)).filter(item=>item.userId===member.user.id).length,0);});
});
function status(code:number){return (error:unknown)=>error instanceof ProductError&&error.statusCode===code;}
