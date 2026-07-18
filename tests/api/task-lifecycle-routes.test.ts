import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createTestApiServer as createApiServer, type RunningApiServer } from "../../packages/api-entry-node/src/server.js";

describe("task lifecycle API routes", () => {
  const store = createLocalInMemoryProductStore();
  let api: RunningApiServer;
  let dataRoot = "";
  let cookie = "";
  let csrf = "";
  let userId = "";
  let projectId = "";
  let endpointId = "";

  before(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-task-routes-"));
    api = await createApiServer({
      port: 0,
      dataRoot,
      builtinAdminPassword: "admin-password",
      store,
      providerClient: {
        completeChat: async () => { throw new Error("not used"); },
        validateEndpoint: async () => ({ status: "healthy" })
      }
    });
    await fetch(api.baseUrl + "/api/v1/auth/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "admin-password" }) });
    const login = await fetch(api.baseUrl + "/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@agentsmith-lite.local", password: "admin-password" }) });
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const identity = await login.json() as { csrfToken: string; user: { id: string } };
    csrf = identity.csrfToken;
    userId = identity.user.id;
    const workspace = await json("POST", "/api/v1/workspaces", { name: "Workspace" });
    const project = await json("POST", `/api/v1/workspaces/${workspace.id}/projects`, { name: "Project" }); projectId = project.id;
    const credential = await json("POST", `/api/v1/projects/${projectId}/credentials`, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "sk-test" });
    const endpoint = await json("POST", `/api/v1/projects/${projectId}/endpoints`, { name: "Endpoint", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "model", credentialId: credential.id, capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30 }); endpointId = endpoint.id;
  });

  after(async () => { await api.close(); await rm(dataRoot, { recursive: true, force: true }); });

  it("requires Idempotency-Key and replays the original create response", async () => {
    const missing = await request("POST", `/api/v1/projects/${projectId}/tasks`, { prompt: "first", endpointId });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: "Idempotency-Key header is required" });

    const first = await json("POST", `/api/v1/projects/${projectId}/tasks`, { endpointId, prompt: "first", title: "First" }, "create-1");
    const replay = await json("POST", `/api/v1/projects/${projectId}/tasks`, { title: "First", prompt: "first", endpointId }, "create-1");
    assert.equal(replay.id, first.id);
    assert.equal(first.terminalReason, "not_executed");
    const detail = await json("GET", `/api/v1/tasks/${first.id}/detail`);
    assert.equal(detail.task.id, first.id);
    assert.equal(detail.capabilities.deleteTask, true);
    assert.equal(detail.capabilities.cancelTask, false);
    assert.equal(detail.capabilities.editTask, true);
    assert.equal(detail.capabilities.retryTask, true);
    assert.equal(detail.capabilities.duplicateTask, true);
    assert.equal(detail.capabilities.archiveTask, true);
    const mismatch = await request("POST", `/api/v1/projects/${projectId}/tasks`, { endpointId, prompt: "changed", title: "First" }, "create-1");
    assert.equal(mismatch.status, 409);

    for (const [method, pathname, body] of [
      ["POST", `/api/v1/tasks/${first.id}/retry`, {}],
      ["POST", `/api/v1/tasks/${first.id}/duplicate`, {}],
      ["POST", `/api/v1/tasks/${first.id}/messages`, { content: "continue" }],
      ["POST", `/api/v1/tasks/${first.id}/cancel`, {}],
      ["POST", `/api/v1/tasks/${first.id}/archive`, {}],
      ["DELETE", `/api/v1/tasks/${first.id}`, undefined]
    ] as const) {
      const response = await request(method, pathname, body);
      assert.equal(response.status, 400, `${method} ${pathname}`);
      assert.deepEqual(await response.json(), { error: "Idempotency-Key header is required" });
    }
  });

  it("returns a stable code when the active task limit rejects creation", async () => {
    const createTaskAtomically = store.createTaskAtomically.bind(store);
    store.createTaskAtomically = async () => null;
    try {
      const rejected = await request("POST", `/api/v1/projects/${projectId}/tasks`, { endpointId, prompt: "over quota" }, "quota-task-create");
      assert.equal(rejected.status, 409);
      assert.deepEqual(await rejected.json(), {
        error: "Project active tasks limit reached",
        code: "active_tasks_limit_reached"
      });
      const replayed = await request("POST", `/api/v1/projects/${projectId}/tasks`, { endpointId, prompt: "over quota" }, "quota-task-create");
      assert.deepEqual(await replayed.json(), {
        error: "Project active tasks limit reached",
        code: "active_tasks_limit_reached"
      });
    } finally {
      store.createTaskAtomically = createTaskAtomically;
    }
  });

  it("stores HTTP URL inputs in the fixed project files tree",async()=>{
    const missing=await request("POST",`/api/v1/projects/${projectId}/files/url-note`,{url:"https://docs.example.test/guide?q=task"});assert.equal(missing.status,400);
    const note=await json("POST",`/api/v1/projects/${projectId}/files/url-note`,{url:"https://docs.example.test/guide?q=task"},"url-note-key");
    const replay=await json("POST",`/api/v1/projects/${projectId}/files/url-note`,{url:"https://docs.example.test/guide?q=task"},"url-note-key");assert.deepEqual(replay,note);
    assert.match(note.path,/^files\/url-inputs\/docs\.example\.test-[a-f0-9-]+\.md$/);
    const download=await request("GET",`/api/v1/projects/${projectId}/files/download?path=${encodeURIComponent(note.path)}`);
    assert.equal(download.status,200);
    assert.equal(await download.text(),"# URL input\n\nhttps://docs.example.test/guide?q=task\n");
    assert.equal((await request("POST",`/api/v1/projects/${projectId}/files/url-note`,{url:"file:///etc/passwd"},"invalid-url-note-1")).status,400);
    assert.equal((await request("POST",`/api/v1/projects/${projectId}/files/url-note`,{url:"https://user:secret@example.test/"},"invalid-url-note-2")).status,400);
    const events=await store.listProjectAuditEvents(projectId);assert.equal(events.filter(event=>event.action==="file.upload"&&event.resourceId===note.path&&event.status==="accepted").length,1);

    const recoveredUrl="https://docs.example.test/recovered";
    const recoveredRequest={projectId,url:recoveredUrl};
    const recoveredPath="files/url-inputs/recovered-request.md";
    await store.beginTaskIdempotency({actorId:userId,projectId,operation:"project.file.url-note",key:"recovered-url-note-key",requestHash:createHash("sha256").update(JSON.stringify(recoveredRequest)).digest("base64url"),resourceId:recoveredPath,claimToken:"expired-url-note-claim",now:"2026-01-01T00:00:00.000Z",leaseExpiresAt:"2026-01-01T00:00:01.000Z"});
    const recovered=await json("POST",`/api/v1/projects/${projectId}/files/url-note`,{url:recoveredUrl},"recovered-url-note-key");
    assert.equal(recovered.path,recoveredPath);
    assert.equal(await (await request("GET",`/api/v1/projects/${projectId}/files/download?path=${encodeURIComponent(recoveredPath)}`)).text(),`# URL input\n\n${recoveredUrl}\n`);
  });

  it("requires an idempotency key and replays a file upload",async()=>{
    const pathname=`/api/v1/projects/${projectId}/files?path=${encodeURIComponent("files/retry-safe.txt")}`;
    const upload=(bytes:string,key?:string)=>fetch(api.baseUrl+pathname,{method:"PUT",headers:{cookie,"x-csrf-token":csrf,"content-type":"text/plain",...(key?{"idempotency-key":key}:{})},body:bytes});
    const missing=await upload("first");assert.equal(missing.status,400);assert.deepEqual(await missing.json(),{error:"Idempotency-Key header is required"});
    const first=await upload("first","file-upload-key");assert.equal(first.status,200);const written=await first.json() as {path:string;bytes:number};
    const replay=await upload("first","file-upload-key");assert.equal(replay.status,200);assert.deepEqual(await replay.json(),written);
    const mismatch=await upload("changed","file-upload-key");assert.equal(mismatch.status,409);
    const events=await store.listProjectAuditEvents(projectId);assert.equal(events.filter(event=>event.action==="file.upload"&&event.resourceId===written.path&&event.status==="accepted").length,1);
    const remove=(key?:string)=>fetch(api.baseUrl+`/api/v1/projects/${projectId}/files`,{method:"DELETE",headers:{cookie,"x-csrf-token":csrf,"content-type":"application/json",...(key?{"idempotency-key":key}:{})},body:JSON.stringify({path:written.path})});
    const missingDelete=await remove();assert.equal(missingDelete.status,400);
    const deleted=await remove("file-delete-key");assert.equal(deleted.status,200);const deletion=await deleted.json();
    const deleteReplay=await remove("file-delete-key");assert.equal(deleteReplay.status,200);assert.deepEqual(await deleteReplay.json(),deletion);
    const afterDelete=await store.listProjectAuditEvents(projectId);assert.equal(afterDelete.filter(event=>event.action==="file.delete"&&event.resourceId===written.path&&event.status==="accepted").length,1);
  });

  it("searches, filters, sorts, paginates, edits, archives, retries, duplicates, and deletes", async () => {
    const alpha = await json("POST", `/api/v1/projects/${projectId}/tasks`, { endpointId, prompt: "alpha body", title: "Alpha" }, "create-alpha");
    const beta = await json("POST", `/api/v1/projects/${projectId}/tasks`, { endpointId, prompt: "beta body", title: "Beta" }, "create-beta");
    const edited = await json("PATCH", `/api/v1/tasks/${alpha.id}`, { title: "Alpha edited" }, "edit-alpha");
    assert.equal(edited.title, "Alpha edited");
    const alphaSecond = await json("POST", `/api/v1/projects/${projectId}/tasks`, { endpointId, prompt: "alpha second body", title: "Alpha second" }, "create-alpha-second");
    const archived = await json("POST", `/api/v1/tasks/${beta.id}/archive`, {}, "archive-beta");
    assert.ok(archived.archivedAt);

    const page = await json("GET", `/api/v1/projects/${projectId}/tasks?search=alpha&status=completed&sort=title&direction=asc&limit=1`);
    assert.deepEqual(page.items.map((task: { id: string }) => task.id), [alpha.id]);
    assert.equal(page.total, 2);
    assert.ok(page.nextCursor);
    const nextPage = await json("GET", `/api/v1/projects/${projectId}/tasks?search=alpha&status=completed&sort=title&direction=asc&limit=1&cursor=${page.nextCursor}`);
    assert.deepEqual(nextPage.items.map((task: { id: string }) => task.id), [alphaSecond.id]);
    assert.equal(nextPage.nextCursor, null);
    assert.equal((await request("GET", `/api/v1/projects/${projectId}/tasks?cursor=!`)).status, 400);
    const archivedPage = await json("GET", `/api/v1/projects/${projectId}/tasks?archived=only`);
    assert.deepEqual(archivedPage.items.map((task: { id: string }) => task.id), [beta.id]);

    const retry = await json("POST", `/api/v1/tasks/${alpha.id}/retry`, {}, "retry-alpha");
    const duplicate = await json("POST", `/api/v1/tasks/${alpha.id}/duplicate`, {}, "duplicate-alpha");
    assert.notEqual(retry.id, alpha.id); assert.notEqual(duplicate.id, alpha.id); assert.notEqual(retry.id, duplicate.id);
    const deleted = await json("DELETE", `/api/v1/tasks/${beta.id}`, undefined, "delete-beta");
    assert.deepEqual(deleted, { deleted: true, taskId: beta.id });
    assert.deepEqual(await json("DELETE", `/api/v1/tasks/${beta.id}`, undefined, "delete-beta"), deleted);
    assert.deepEqual(await json("POST", `/api/v1/tasks/${beta.id}/archive`, {}, "archive-beta"), archived);
    assert.equal((await request("GET", `/api/v1/tasks/${beta.id}`)).status, 404);
  });

  it("creates one linked successor and serves authorized interaction snapshot and SSE", async () => {
    const source = await json("POST", `/api/v1/projects/${projectId}/tasks`, { endpointId, prompt: "source", title: "Source" }, "create-source");
    const receipt = await json("POST", `/api/v1/tasks/${source.id}/messages`, { content: "continue" }, "message-source");
    assert.equal(receipt.disposition, "successor_created");
    assert.notEqual(receipt.targetTaskId, source.id);
    assert.equal((await json("GET", `/api/v1/tasks/${receipt.targetTaskId}`)).sourceTaskId, source.id);

    const snapshot = await json("GET", `/api/v1/tasks/${source.id}/interactions?limit=10`);
    assert.equal(snapshot.items.some((item: { kind: string; targetTaskId?: string }) => item.kind === "execution_boundary" && item.targetTaskId === receipt.targetTaskId), true);
    assert.equal(typeof snapshot.streamCursor, "string");
    const newest = await json("GET", `/api/v1/tasks/${source.id}/interactions?limit=1`);
    assert.equal(newest.hasMoreBefore, true);
    const older = await json("GET", `/api/v1/tasks/${source.id}/interactions?limit=1&cursor=${encodeURIComponent(newest.nextPageCursor)}`);
    assert.equal(older.items.length, 1);
    const timestamp = new Date().toISOString();
    await store.persistTaskInteractionMutation({ taskId:source.id, changes:[{ sourceKind:"product", sourceId:"route-catch-up", sourceRevision:1, interaction:{ id:"route-catch-up", revision:1, taskId:source.id, kind:"system_error", title:"Recovered update", body:null, contentMode:"none", position:100, occurredAt:timestamp, updatedAt:timestamp, status:"resolved", code:null, retryable:false, detailsOmitted:false } }] });
    const controller = new AbortController();
    const stream = await fetch(api.baseUrl + `/api/v1/tasks/${source.id}/interactions/stream`, { headers:{cookie,"last-event-id":snapshot.streamCursor}, signal:controller.signal });
    assert.equal(stream.status, 200); assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    const originalNow = Date.now;
    const baseTime = originalNow();
    let streamText = "";
    try {
      while (!streamText.includes("event: interaction")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        streamText += decoder.decode(chunk.value, { stream: true });
      }
      Date.now = () => baseTime + 6_000;
      while (!streamText.includes(": heartbeat")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        streamText += decoder.decode(chunk.value, { stream: true });
      }
      Date.now = () => baseTime + 31_000;
      while (!streamText.includes("event: reconnect")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        streamText += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      Date.now = originalNow;
      clearTimeout(timeout);
      controller.abort();
    }
    assert.match(streamText, /event: state/);
    assert.match(streamText, /event: state/);
    assert.match(streamText, /event: interaction/);
    assert.match(streamText, /id: tic1\./);
    assert.match(streamText, /: heartbeat/);
    assert.match(streamText, /event: reconnect/);
    assert.equal((await request("GET", `/api/v1/tasks/${source.id}/interactions/stream?cursor=!`)).status, 400);
    assert.equal((await request("GET", `/api/v1/tasks/${receipt.targetTaskId}/interactions/stream?cursor=${encodeURIComponent(snapshot.streamCursor)}`)).status, 400);
    assert.equal((await fetch(api.baseUrl + `/api/v1/tasks/${source.id}/interactions`)).status, 401);
    assert.equal((await fetch(api.baseUrl + `/api/v1/tasks/${source.id}/messages`, { method:"POST", headers:{"content-type":"application/json","idempotency-key":"unauthorized-message"}, body:JSON.stringify({content:"no access"}) })).status, 401);
    assert.equal((await request("GET", `/api/v1/tasks/${source.id}/events`)).status, 404);
    assert.equal((await request("POST", `/api/v1/tasks/${source.id}/follow-ups`, {prompt:"continue"}, "old-follow-up")).status, 404);
    await json("DELETE", `/api/v1/tasks/${source.id}`, undefined, "delete-source");
    const replay = await json("POST", `/api/v1/tasks/${source.id}/messages`, { content: "continue" }, "message-source");
    assert.equal(replay.targetTaskId, receipt.targetTaskId);
    assert.equal(replay.duplicate, true);
  });

  async function request(method: string, pathname: string, body?: unknown, idempotencyKey?: string): Promise<Response> {
    const headers: Record<string, string> = { cookie, "content-type": "application/json" };
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) headers["x-csrf-token"] = csrf;
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    else if (method === "POST" && (pathname === "/api/v1/workspaces" || /^\/api\/v1\/workspaces\/[^/]+\/projects$/.test(pathname) || /^\/api\/v1\/projects\/[^/]+\/(credentials|endpoints)$/.test(pathname))) headers["idempotency-key"] = crypto.randomUUID();
    return fetch(api.baseUrl + pathname, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }

  async function json(method: string, pathname: string, body?: unknown, idempotencyKey?: string): Promise<any> {
    const response = await request(method, pathname, body, idempotencyKey);
    if (response.status !== 200) assert.fail(`${response.status}: ${await response.text()}`);
    return response.json();
  }
});
