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
    const ownerWorkspace = (await services.workspaces.listWorkspaces(owner.user.id))[0];
    assert.equal(ownerWorkspace?.capabilities.canManageMembers,true);
    assert.deepEqual([ownerWorkspace?.owner, ownerWorkspace?.memberRole], [{ displayName: "Owner display", email: owner.user.email }, "owner"]);
    await services.workspaceMemberships.add(owner.user.id,workspace.id,{email:admin.user.email},"admin");
    await services.workspaceMemberships.add(owner.user.id,workspace.id,{email:member.user.email},"member");
    await services.workspaceMemberships.add(owner.user.id,workspace.id,{email:viewer.user.email},"viewer");
    const firstProject=await services.workspaces.createProject(owner.user.id,workspace.id,{name:"First project"});
    const secondProject=await services.workspaces.createProject(owner.user.id,workspace.id,{name:"Second project"});
    await services.memberships.addMember(owner.user.id,firstProject.id,{email:member.user.email},"member");
    await services.memberships.addMember(owner.user.id,secondProject.id,{email:member.user.email},"viewer");
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

    await services.workspaceMemberships.remove(admin.user.id,workspace.id,member.user.id);
    assert.equal(await store.findWorkspaceMembership(workspace.id,member.user.id),null);
    assert.equal(await store.findProjectMembership(firstProject.id,member.user.id),null);
    assert.equal(await store.findProjectMembership(secondProject.id,member.user.id),null);
    await assert.rejects(()=>services.authorization.requireProject(member.user.id,firstProject.id,"view"),status(403));
  });
});
function status(code:number){return (error:unknown)=>error instanceof ProductError&&error.statusCode===code;}
