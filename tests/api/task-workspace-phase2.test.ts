import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createTestApiServer, type RunningApiServer } from "../../packages/api-entry-node/src/server.js";

describe("Phase 2 task workspace API", () => {
  let api: RunningApiServer;
  let dataRoot: string;
  let cookie: string;
  let csrf: string;
  let projectId: string;
  let endpointId: string;

  before(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-task-workspace-"));
    api = await createTestApiServer({ port: 0, dataRoot, builtinAdminPassword: "admin-password", providerClient:{completeChat:async()=>{throw new Error("not used");},validateEndpoint:async()=>({status:"healthy"})} });
    await request("POST", "/api/v1/auth/bootstrap", { password: "admin-password" }, false);
    const login = await request("POST", "/api/v1/auth/login", { email: "admin@agentsmith-lite.local", password: "admin-password" }, false);
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    csrf = (await login.json()).csrfToken;
    const workspace = await json("POST", "/api/v1/workspaces", { name: "Workspace" });
    projectId = (await json("POST", `/api/v1/workspaces/${workspace.id}/projects`, { name: "Project" })).id;
    const credential = await json("POST", `/api/v1/projects/${projectId}/credentials`, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "secret" });
    endpointId = (await json("POST", `/api/v1/projects/${projectId}/endpoints`, { name: "Endpoint", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "model", credentialId: credential.id, capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30 })).id;
  });

  after(async () => { await api.close(); await rm(dataRoot, { recursive: true, force: true }); });

  it("accepts exactly create_new or use_existing and returns the stable binding", async () => {
    const created = await json("POST", `/api/v1/projects/${projectId}/tasks`, { endpointId, prompt: "new", fileLibrary: { mode: "create_new", name: "New workspace" } }, "task-new");
    assert.equal(typeof created.fileLibraryId, "string");
    const library = await json("POST", `/api/v1/projects/${projectId}/file-libraries`, { name: "Existing" });
    const existing = await json("POST", `/api/v1/projects/${projectId}/tasks`, { endpointId, prompt: "existing", fileLibrary: { mode: "use_existing", id: library.id } }, "task-existing");
    assert.equal(existing.fileLibraryId, library.id);
    await assertTaskError({endpointId,prompt:"bound",fileLibrary:{mode:"use_existing",id:library.id}},"task-bound",409,"file_library_already_bound");
    await assertTaskError({endpointId,prompt:"missing",fileLibrary:{mode:"use_existing",id:"library_missing"}},"task-missing",404,"file_library_not_found");
    await assertTaskError({endpointId,prompt:"name",fileLibrary:{mode:"create_new",name:"New workspace"}},"task-name-conflict",409,"file_library_name_conflict");

    for (const body of [
      { endpointId, prompt: "missing" },
      { endpointId, prompt: "legacy", inputPaths: ["files/a.txt"], fileLibrary: { mode: "use_existing", id: library.id } },
      { endpointId, prompt: "mixed", fileLibrary: { mode: "create_new", name: "Mixed", id: library.id } },
      { endpointId, prompt: "unknown", fileLibrary: { mode: "unknown", id: library.id } }
    ]) assert.equal((await request("POST", `/api/v1/projects/${projectId}/tasks`, body, true, crypto.randomUUID())).status, 400);
  });

  it("removes fixed files, task inputs, retry, and duplicate routes and rejects terminal messages", async () => {
    const task = await json("POST", `/api/v1/projects/${projectId}/tasks`, { endpointId, prompt: "terminal", fileLibrary: { mode: "create_new", name: "Terminal workspace" } }, "task-terminal");
    for (const [method, pathname] of [
      ["GET", `/api/v1/projects/${projectId}/files`],
      ["GET", `/api/v1/tasks/${task.id}/inputs`],
      ["POST", `/api/v1/tasks/${task.id}/retry`],
      ["POST", `/api/v1/tasks/${task.id}/duplicate`]
    ] as const) assert.equal((await request(method, pathname, method === "POST" ? {} : undefined, true, crypto.randomUUID())).status, 404);
    const message = await request("POST", `/api/v1/tasks/${task.id}/messages`, { content: "continue" }, true, "terminal-message");
    assert.equal(message.status, 409);
    const archived=await json("POST",`/api/v1/tasks/${task.id}/archive`,{},"archive-terminal");
    assert.ok(archived.archivedAt);
    let library=(await json("GET",`/api/v1/projects/${projectId}/file-libraries`)).find((item:{id:string})=>item.id===task.fileLibraryId);
    assert.equal(library.boundTask.id,task.id);
    const upload=await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/file-libraries/${task.fileLibraryId}/files?path=kept.txt`,{method:"PUT",headers:{cookie,"x-csrf-token":csrf,"idempotency-key":"kept-upload","content-type":"application/octet-stream"},body:"keep me"});
    assert.equal(upload.status,200,await upload.text());
    assert.equal((await json("GET",`/api/v1/projects/${projectId}/usage`)).usage.projectFileBytes,7);
    await json("DELETE",`/api/v1/tasks/${task.id}`,undefined,"delete-terminal");
    library=(await json("GET",`/api/v1/projects/${projectId}/file-libraries`)).find((item:{id:string})=>item.id===task.fileLibraryId);
    assert.equal(library.boundTask,null);
    assert.equal(await (await request("GET",`/api/v1/projects/${projectId}/file-libraries/${task.fileLibraryId}/files/download?path=kept.txt`)).text(),"keep me");
    assert.equal((await json("GET",`/api/v1/projects/${projectId}/usage`)).usage.projectFileBytes,7);
  });

  function request(method: string, pathname: string, body?: unknown, authenticated = true, key:string = crypto.randomUUID()): Promise<Response> {
    return fetch(api.baseUrl + pathname, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(authenticated ? { cookie } : {}), ...(authenticated && ["POST", "PATCH", "DELETE", "PUT"].includes(method) ? { "x-csrf-token": csrf, "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function json(method: string, pathname: string, body?: unknown, key?: string): Promise<any> {
    const response = await request(method, pathname, body, true, key);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text);
  }
  async function assertTaskError(body:unknown,key:string,status:number,code:string):Promise<void>{
    const response=await request("POST",`/api/v1/projects/${projectId}/tasks`,body,true,key);
    assert.equal(response.status,status);
    assert.equal((await response.json()).code,code);
  }
});
