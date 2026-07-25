import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createTestApiServer as createApiServer } from "../../packages/api-entry-node/src/server.js";

describe("workspace and project directory API", () => {
  it("exposes bounded pages and authoritative exact resources", async () => {
    const root=await mkdtemp(path.join(tmpdir(),"asl-directory-api-"));
    const store=createLocalInMemoryProductStore();
    const api=await createApiServer({port:0,dataRoot:root,builtinAdminPassword:"admin-password",store});
    try {
      await post(api.baseUrl,"/api/v1/auth/bootstrap",{password:"admin-password"});
      const login=await post(api.baseUrl,"/api/v1/auth/login",{email:"admin@agentsmith-lite.local",password:"admin-password"});
      const cookie=login.headers.get("set-cookie")?.split(";")[0]??"";
      const {csrfToken}=await login.json() as {csrfToken:string};
      const first=await mutate(api.baseUrl,"POST","/api/v1/workspaces",{name:"First"},cookie,csrfToken);
      const second=await mutate(api.baseUrl,"POST","/api/v1/workspaces",{name:"Second"},cookie,csrfToken);
      assert.equal(first.workspace.name,"First");
      assert.equal(first.projectCount,0);

      const firstPage=await getJson(api.baseUrl,"/api/v1/workspaces?limit=1",cookie);
      assert.equal(firstPage.items.length,1);
      assert.ok(firstPage.nextCursor);
      const secondPage=await getJson(api.baseUrl,`/api/v1/workspaces?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,cookie);
      assert.equal(secondPage.items.length,1);
      assert.notEqual(secondPage.items[0].id,firstPage.items[0].id);
      assert.equal((await fetch(api.baseUrl+"/api/v1/workspaces?limit=51",{headers:{cookie}})).status,400);
      assert.equal((await fetch(api.baseUrl+"/api/v1/workspaces?cursor=",{headers:{cookie}})).status,400);
      assert.equal((await fetch(api.baseUrl+"/api/v1/workspaces?unknown=true",{headers:{cookie}})).status,400);

      const beta=await mutate(api.baseUrl,"POST",`/api/v1/workspaces/${first.workspace.id}/projects`,{name:"beta",sandboxLimit:3},cookie,csrfToken);
      const alpha=await mutate(api.baseUrl,"POST",`/api/v1/workspaces/${first.workspace.id}/projects`,{name:"Alpha"},cookie,csrfToken);
      assert.equal(beta.sandboxLimit,3);
      assert.equal("taskConcurrencyLimit" in beta,false);
      const legacyProject=await fetch(`${api.baseUrl}/api/v1/workspaces/${first.workspace.id}/projects`,{method:"POST",headers:{"content-type":"application/json",cookie,"x-csrf-token":csrfToken,"idempotency-key":crypto.randomUUID()},body:JSON.stringify({name:"Legacy",taskConcurrencyLimit:3})});
      assert.equal(legacyProject.status,400);
      await mutate(api.baseUrl,"PUT",`/api/v1/projects/${beta.id}/pin`,{pinned:true},cookie,csrfToken,false);
      const projects=await getJson(api.baseUrl,`/api/v1/workspaces/${first.workspace.id}/projects?limit=1`,cookie);
      assert.deepEqual(projects.items.map((item:{id:string})=>item.id),[beta.id]);
      assert.equal(projects.items[0].sandboxLimit,3);
      assert.equal("taskConcurrencyLimit" in projects.items[0],false);
      assert.equal(projects.total,2);
      assert.ok(projects.nextCursor);
      const filtered=await getJson(api.baseUrl,`/api/v1/workspaces/${first.workspace.id}/projects?q=alp`,cookie);
      assert.deepEqual(filtered.items.map((item:{id:string})=>item.id),[alpha.id]);

      const workspaceDetail=await getJson(api.baseUrl,`/api/v1/workspaces/${first.workspace.id}`,cookie);
      assert.equal(workspaceDetail.workspace.id,first.workspace.id);
      assert.equal(workspaceDetail.projectCount,2);
      const projectDetail=await getJson(api.baseUrl,`/api/v1/projects/${beta.id}`,cookie);
      assert.equal(projectDetail.project.id,beta.id);
      assert.equal(projectDetail.project.sandboxLimit,3);
      assert.equal("taskConcurrencyLimit" in projectDetail.project,false);
      assert.equal(projectDetail.workspace.id,first.workspace.id);
      assert.equal((await fetch(api.baseUrl+"/api/v1/projects",{headers:{cookie}})).status,404);
      assert.equal((await fetch(api.baseUrl+"/api/v1/dashboard",{headers:{cookie}})).status,404);

      await store.createUser({id:"user_other",email:"other@example.test",emailVerified:true,passwordHash:"external:oidc",createdAt:"2026-07-24T00:00:00.000Z",updatedAt:"2026-07-24T00:00:00.000Z"});
      await store.createSession({id:"session_other",userId:"user_other",csrfToken:"csrf_other",createdAt:"2026-07-24T00:00:00.000Z",expiresAt:"2999-01-01T00:00:00.000Z"});
      const otherCookie="asl_session=session_other";
      assert.equal((await fetch(api.baseUrl+`/api/v1/workspaces?cursor=${encodeURIComponent(firstPage.nextCursor)}`,{headers:{cookie:otherCookie}})).status,400);
      assert.equal((await fetch(api.baseUrl+`/api/v1/workspaces/${first.workspace.id}`,{headers:{cookie:otherCookie}})).status,403);
      assert.equal((await fetch(api.baseUrl+`/api/v1/projects/${beta.id}`,{headers:{cookie:otherCookie}})).status,403);
      assert.notEqual(second.workspace.id,first.workspace.id);
    } finally {
      await api.close();
      await rm(root,{recursive:true,force:true});
    }
  });
});

async function post(baseUrl:string,pathname:string,body:unknown):Promise<Response> {
  return fetch(baseUrl+pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
}

async function mutate(baseUrl:string,method:string,pathname:string,body:unknown,cookie:string,csrf:string,idempotent=true):Promise<any> {
  const response=await fetch(baseUrl+pathname,{method,headers:{"content-type":"application/json",cookie,"x-csrf-token":csrf,...(idempotent?{"idempotency-key":crypto.randomUUID()}:{})},body:JSON.stringify(body)});
  assert.equal(response.status,200,await response.clone().text());
  return response.json();
}

async function getJson(baseUrl:string,pathname:string,cookie:string):Promise<any> {
  const response=await fetch(baseUrl+pathname,{headers:{cookie}});
  assert.equal(response.status,200,await response.clone().text());
  return response.json();
}
