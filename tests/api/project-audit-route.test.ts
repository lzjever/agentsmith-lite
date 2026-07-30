import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createTestApiServer as createApiServer } from "../../packages/api-entry-node/src/server.js";

describe("project Audit API",()=>{
  it("uses canonical scoped cursors and exposes bounded actor and subject identity candidates",async()=>{
    const dataRoot=await mkdtemp(path.join(tmpdir(),"asl-project-audit-route-"));
    const store=createLocalInMemoryProductStore();
    const api=await createApiServer({port:0,dataRoot,builtinAdminPassword:"admin-password",store});
    try{
      await post(api.baseUrl,"/api/v1/auth/bootstrap",{password:"admin-password"});
      const login=await post(api.baseUrl,"/api/v1/auth/login",{email:"admin@agentsmith-lite.local",password:"admin-password"});
      const cookie=login.headers.get("set-cookie")?.split(";")[0]??"";
      const {csrfToken,user}=await login.json() as {csrfToken:string;user:{id:string}};
      const workspace=(await json(api.baseUrl,"POST","/api/v1/workspaces",{name:"Audit"},cookie,csrfToken)).workspace;
      const project=await json(api.baseUrl,"POST",`/api/v1/workspaces/${workspace.id}/projects`,{name:"Primary"},cookie,csrfToken);
      const other=await json(api.baseUrl,"POST",`/api/v1/workspaces/${workspace.id}/projects`,{name:"Other"},cookie,csrfToken);
      const formerId="user_former_auditor";
      await store.createUser({id:formerId,email:"former@example.test",emailVerified:true,passwordHash:"external:oidc",createdAt:"2026-07-20T00:00:00.000Z",updatedAt:"2026-07-20T00:00:00.000Z"});
      await store.upsertUserProfilePreferences({userId:formerId,displayName:"Former Auditor",timezone:null,bio:null,jobTitle:null,company:null,greetingPreference:null,interests:[],updatedAt:"2026-07-20T00:00:00.000Z"},null);
      for(const id of ["user","user_a","user_b"]){
        await store.createUser({id,email:`${id}@example.test`,emailVerified:true,passwordHash:"external:oidc",createdAt:"2026-07-20T00:00:00.000Z",updatedAt:"2026-07-20T00:00:00.000Z"});
        await store.appendProjectAuditEvent({id:`identity_${id}`,projectId:project.id,actorId:id,subjectUserId:user.id,action:"sandbox.released",status:"accepted",resourceKind:"sandbox",resourceId:`task_${id}`,createdAt:"2026-07-20T11:00:00.000Z"});
      }
      await store.appendProjectAuditEvent({id:"audit_system_actor",projectId:project.id,actorId:null,subjectUserId:user.id,action:"sandbox.released",status:"accepted",resourceKind:"sandbox",resourceId:"task_system_actor",createdAt:"2026-07-20T11:30:00.000Z"});
      await store.appendProjectAuditEvent({id:"audit_null_subject",projectId:project.id,actorId:formerId,subjectUserId:null,action:"sandbox.released",status:"accepted",resourceKind:"sandbox",resourceId:"task_null_subject",createdAt:"2026-07-20T11:31:00.000Z"});
      await store.createUser({id:"audit_outsider",email:"outsider@example.test",emailVerified:true,passwordHash:"external:oidc",createdAt:"2026-07-20T00:00:00.000Z",updatedAt:"2026-07-20T00:00:00.000Z"});
      await store.createSession({id:"audit-outsider-session",userId:"audit_outsider",csrfToken:"audit-outsider-csrf",createdAt:"2026-07-20T00:00:00.000Z",expiresAt:"2999-01-01T00:00:00.000Z"});
      const roleSessions = {
        admin: "audit-admin-session",
        member: "audit-member-session",
        viewer: "audit-viewer-session"
      } as const;
      for (const role of ["admin", "member", "viewer"] as const) {
        const userId = `audit_${role}`;
        await store.createUser({id:userId,email:`${role}@example.test`,emailVerified:true,passwordHash:"external:oidc",createdAt:"2026-07-20T00:00:00.000Z",updatedAt:"2026-07-20T00:00:00.000Z"});
        await store.upsertProjectMembership({projectId:project.id,userId,role,createdAt:"2026-07-20T00:00:00.000Z",updatedAt:"2026-07-20T00:00:00.000Z"});
        await store.createSession({id:roleSessions[role],userId,csrfToken:`audit-${role}-csrf`,createdAt:"2026-07-20T00:00:00.000Z",expiresAt:"2999-01-01T00:00:00.000Z"});
      }
      const tiedAt="2026-07-20T12:00:00.000Z";
      for(let index=0;index<23;index+=1)await store.appendProjectAuditEvent({id:`route_audit_${String(index).padStart(2,"0")}`,projectId:project.id,actorId:formerId,subjectUserId:user.id,action:"sandbox.failed",status:"accepted",resourceKind:"sandbox",resourceId:`task_${index}`,createdAt:tiedAt});
      await store.appendProjectAuditEvent({id:"route_other",projectId:other.id,actorId:user.id,subjectUserId:formerId,action:"sandbox.failed",status:"accepted",resourceKind:"sandbox",resourceId:"task_other",createdAt:tiedAt});

      const first=await get(api.baseUrl,`/api/v1/projects/${project.id}/audit?action=sandbox.failed`,cookie);
      assert.equal(first.status,200);
      const firstPage=await first.json() as {items:Array<{id:string;actorDisplayName:string|null;subjectEmail:string|null}>;nextCursor:string|null};
      assert.equal(firstPage.items.length,20);
      assert.deepEqual(firstPage.items[0],{...firstPage.items[0],id:"route_audit_22",actorDisplayName:"Former Auditor",subjectEmail:"admin@agentsmith-lite.local"});
      assert.ok(firstPage.nextCursor);
      const second=await get(api.baseUrl,`/api/v1/projects/${project.id}/audit?action=sandbox.failed&limit=10&cursor=${firstPage.nextCursor}`,cookie);
      assert.deepEqual((await second.json() as {items:Array<{id:string}>}).items.map((item)=>item.id),["route_audit_02","route_audit_01","route_audit_00"]);
      for(const pathname of [
        `/api/v1/projects/${project.id}/audit?action=sandbox.released&cursor=${firstPage.nextCursor}`,
        `/api/v1/projects/${other.id}/audit?action=sandbox.failed&cursor=${firstPage.nextCursor}`,
        `/api/v1/projects/${project.id}/audit?action=sandbox.failed&cursor=${firstPage.nextCursor}=`,
        `/api/v1/projects/${project.id}/audit?limit=101`,
        `/api/v1/projects/${project.id}/audit?action=`,
        `/api/v1/projects/${project.id}/audit?from=`,
        `/api/v1/projects/${project.id}/audit?unknown=true`,
      ])assert.equal((await get(api.baseUrl,pathname,cookie)).status,400,pathname);

      const actors=await get(api.baseUrl,`/api/v1/projects/${project.id}/audit/identities?role=actor&q=${formerId}&limit=20`,cookie);
      assert.deepEqual(await actors.json(),{items:[{id:formerId,displayName:"Former Auditor",email:"former@example.test"}],nextCursor:null});
      const subjects=await get(api.baseUrl,`/api/v1/projects/${project.id}/audit/identities?role=subject&q=admin`,cookie);
      assert.deepEqual((await subjects.json() as {items:Array<{id:string}>}).items.map((item)=>item.id),[user.id]);
      assert.deepEqual((await (await get(api.baseUrl,`/api/v1/projects/${project.id}/audit/identities?role=actor&q=admin`,cookie)).json() as {items:unknown[]}).items,[]);
      const identityFirst=await (await get(api.baseUrl,`/api/v1/projects/${project.id}/audit/identities?role=actor&q=user&limit=2`,cookie)).json() as {items:Array<{id:string}>;nextCursor:string|null};
      assert.deepEqual(identityFirst.items.map((item)=>item.id),["user","user_a"]);
      assert.ok(identityFirst.nextCursor);
      const identitySecond=await (await get(api.baseUrl,`/api/v1/projects/${project.id}/audit/identities?role=actor&q=user&limit=2&cursor=${identityFirst.nextCursor}`,cookie)).json() as {items:Array<{id:string}>;nextCursor:string|null};
      assert.deepEqual(identitySecond.items.map((item)=>item.id),["user_b",formerId]);
      assert.equal(identitySecond.nextCursor,null);
      for(const pathname of [
        `/api/v1/projects/${project.id}/audit/identities?role=subject&q=user&cursor=${identityFirst.nextCursor}`,
        `/api/v1/projects/${project.id}/audit/identities?role=actor&q=user_a&cursor=${identityFirst.nextCursor}`,
        `/api/v1/projects/${other.id}/audit/identities?role=actor&q=user&cursor=${identityFirst.nextCursor}`,
      ])assert.equal((await get(api.baseUrl,pathname,cookie)).status,400,pathname);
      assert.equal((await get(api.baseUrl,`/api/v1/projects/${project.id}/audit/identities?role=actor&q=User&cursor=${identityFirst.nextCursor}`,cookie)).status,200);
      const systemActors=await get(api.baseUrl,`/api/v1/projects/${project.id}/audit?actorId=system&action=sandbox.released`,cookie);
      assert.equal(systemActors.status,200);
      assert.deepEqual((await systemActors.json() as {items:Array<{id:string}>}).items.map((item)=>item.id),["audit_system_actor"]);
      assert.equal((await get(api.baseUrl,`/api/v1/projects/${project.id}/audit?subjectUserId=system`,cookie)).status,400);
      assert.equal((await get(api.baseUrl,`/api/v1/projects/${project.id}/audit`,`asl_session=audit-outsider-session`)).status,403);
      assert.equal((await get(api.baseUrl,`/api/v1/projects/${project.id}/audit/identities?role=actor`,`asl_session=audit-outsider-session`)).status,403);
      for (const role of ["member", "viewer"] as const) {
        const roleCookie = `asl_session=${roleSessions[role]}`;
        assert.equal((await get(api.baseUrl,`/api/v1/projects/${project.id}/audit`,roleCookie)).status,403);
        assert.equal((await get(api.baseUrl,`/api/v1/projects/${project.id}/audit/identities?role=actor`,roleCookie)).status,403);
      }
      const adminCookie = `asl_session=${roleSessions.admin}`;
      assert.equal((await get(api.baseUrl,`/api/v1/projects/${project.id}/audit`,adminCookie)).status,200);
      assert.equal((await get(api.baseUrl,`/api/v1/projects/${project.id}/audit/identities?role=actor`,adminCookie)).status,200);
      await store.setProjectLifecycleStatus(project.id,"archived","2026-07-20T13:00:00.000Z");
      for (const roleCookie of [cookie, adminCookie]) {
        assert.equal((await get(api.baseUrl,`/api/v1/projects/${project.id}/audit`,roleCookie)).status,200);
        assert.equal((await get(api.baseUrl,`/api/v1/projects/${project.id}/audit/identities?role=actor`,roleCookie)).status,200);
      }
      for(const query of ["role=any","role=actor&limit=51",`role=actor&q=${"x".repeat(121)}`,"role=actor&unknown=true"]){
        assert.equal((await get(api.baseUrl,`/api/v1/projects/${project.id}/audit/identities?${query}`,cookie)).status,400,query);
      }
    }finally{
      await api.close();
      await rm(dataRoot,{recursive:true,force:true});
    }
  });
});

async function post(baseUrl:string,pathname:string,body:unknown):Promise<Response>{
  return fetch(baseUrl+pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
}

async function json(baseUrl:string,method:string,pathname:string,body:unknown,cookie:string,csrf:string):Promise<any>{
  const response=await fetch(baseUrl+pathname,{method,headers:{"content-type":"application/json",cookie,"x-csrf-token":csrf,"idempotency-key":crypto.randomUUID()},body:JSON.stringify(body)});
  if(response.status!==200)assert.fail(await response.text());
  return response.json();
}

function get(baseUrl:string,pathname:string,cookie:string):Promise<Response>{
  return fetch(baseUrl+pathname,{headers:{cookie}});
}
