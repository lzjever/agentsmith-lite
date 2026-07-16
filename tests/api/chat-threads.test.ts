import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createTestApiServer as createApiServer, type RunningApiServer } from "../../packages/api-entry-node/src/server.js";
import type { ChatResponse, ModelEndpoint } from "../../packages/contracts/src/api.js";
import type { OpenAICompatibleClient } from "../../packages/openai-compatible-client/src/index.js";

let streamChatImpl: OpenAICompatibleClient["streamChat"] | undefined;

describe("project chat threads API", () => {
  let api: RunningApiServer;
  let root = "";
  let cookie = "";
  let csrf = "";
  let projectId = "";
  let otherProjectId = "";
  let endpointId = "";
  let otherEndpointId = "";
  const viewerCookie = "asl_session=viewer_session";
  const viewerCsrf = "viewer_csrf";

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "asl-chat-threads-"));
    const store = createLocalInMemoryProductStore();
    api = await createApiServer({ port: 0, dataRoot: root, builtinAdminPassword: "admin-password", store, providerClient: fakeClient() });
    await store.createUser({ id: "viewer_1", email: "viewer@example.test", emailVerified: true, passwordHash: "external:oidc", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    await store.createSession({ id: "viewer_session", userId: "viewer_1", csrfToken: viewerCsrf, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" });
    await request("POST", "/api/v1/auth/bootstrap", { password: "admin-password" });
    const login = await request("POST", "/api/v1/auth/login", { email: "admin@agentsmith-lite.local", password: "admin-password" });
    cookie = login.response.headers.get("set-cookie")?.split(";")[0] ?? "";
    csrf = (login.body as { csrfToken: string }).csrfToken;
    const workspace = await requestJson("POST", "/api/v1/workspaces", { name: "W" });
    projectId = (await requestJson("POST", `/api/v1/workspaces/${workspace.id}/projects`, { name: "P1" })).id;
    otherProjectId = (await requestJson("POST", `/api/v1/workspaces/${workspace.id}/projects`, { name: "P2" })).id;
    const credential = await requestJson("POST", `/api/v1/projects/${projectId}/credentials`, { name: "E1 credential", baseUrl: "https://models.example.test/v1", secret: "sk-test-key" });
    const otherCredential = await requestJson("POST", `/api/v1/projects/${otherProjectId}/credentials`, { name: "E2 credential", baseUrl: "https://models.example.test/v1", secret: "sk-test-key" });
    endpointId = (await requestJson("POST", `/api/v1/projects/${projectId}/endpoints`, endpointInput("E1", credential.id))).id;
    otherEndpointId = (await requestJson("POST", `/api/v1/projects/${otherProjectId}/endpoints`, endpointInput("E2", otherCredential.id))).id;
    await requestJson("POST", `/api/v1/workspaces/${workspace.id}/members`, { email: "viewer@example.test", role: "member" });
    await requestJson("POST", `/api/v1/projects/${projectId}/members`, { userId: "viewer_1", role: "viewer" });
  });

  after(async () => { await api.close(); await rm(root, { recursive: true, force: true }); });

  it("projects endpoint task eligibility and preserves thread history order", async () => {
    const endpoints = await requestJson("GET", `/api/v1/projects/${projectId}/endpoints`, undefined);
    assert.equal(endpoints[0]?.taskEligible, true);
    const first = await requestJson("POST", `/api/v1/projects/${projectId}/chat/threads`, { endpointId });
    const second = await requestJson("POST", `/api/v1/projects/${projectId}/chat/threads`, { endpointId });
    await sendMessage(first.id, "first");
    const history = await requestJson("GET", `/api/v1/projects/${projectId}/chat/threads/${first.id}/messages`, undefined);
    assert.deepEqual(history.map((message: { role: string; content: string }) => [message.role, message.content]), [["user", "first"], ["assistant", "answer:first"]]);
    const threads = await requestJson("GET", `/api/v1/projects/${projectId}/chat/threads`, undefined);
    assert.deepEqual(threads.map((thread: { id: string }) => thread.id), [first.id, second.id]);
  });

  it("rejects foreign endpoints, cross-project thread access, and viewer mutations while retaining viewer reads", async () => {
    const foreignEndpoint = await request("POST", `/api/v1/projects/${projectId}/chat/threads`, { endpointId: otherEndpointId });
    assert.equal(foreignEndpoint.response.status, 404);
    const thread = await requestJson("POST", `/api/v1/projects/${projectId}/chat/threads`, { endpointId });
    const crossProject = await request("GET", `/api/v1/projects/${otherProjectId}/chat/threads/${thread.id}/messages`);
    assert.equal(crossProject.response.status, 404);
    const viewerThreads = await request("GET", `/api/v1/projects/${projectId}/chat/threads`, undefined, viewerCookie);
    assert.equal(viewerThreads.response.status, 200);
    const viewerCreate = await request("POST", `/api/v1/projects/${projectId}/chat/threads`, { endpointId }, viewerCookie, viewerCsrf);
    assert.equal(viewerCreate.response.status, 403);
    const viewerRename=await request("PATCH",`/api/v1/projects/${projectId}/chat/threads/${thread.id}`,{title:"Forbidden"},viewerCookie,viewerCsrf);assert.equal(viewerRename.response.status,403);
    const viewerSend = await request("POST", `/api/v1/projects/${projectId}/chat/threads/${thread.id}/messages`, { content: "no", afterMessageId: null }, viewerCookie, viewerCsrf);
    assert.equal(viewerSend.response.status, 403);
    await sendMessage(thread.id,"owner message");const history=await requestJson("GET",`/api/v1/projects/${projectId}/chat/threads/${thread.id}/messages`);const viewerEdit=await request("PATCH",`/api/v1/projects/${projectId}/chat/threads/${thread.id}/messages/${history[0].id}`,{content:"Forbidden",expectedVersion:history[0].version},viewerCookie,viewerCsrf);assert.equal(viewerEdit.response.status,403);
  });

  it("aborts the provider stream when the chat client disconnects", async () => {
    const thread = await requestJson("POST", `/api/v1/projects/${projectId}/chat/threads`, { endpointId });
    let markStarted!: () => void;
    let markAborted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
    streamChatImpl = async (_endpoint, _messages, options) => {
      markStarted();
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) reject(new DOMException("Aborted", "AbortError"));
        else options.signal?.addEventListener("abort", () => { markAborted(); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
      });
      throw new Error("unreachable");
    };
    const controller = new AbortController();
    try {
      const pending = fetch(`${api.baseUrl}/api/v1/projects/${projectId}/chat/threads/${thread.id}/messages`, { method: "POST", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf }, body: JSON.stringify({ content: "disconnect", afterMessageId: null }), signal: controller.signal });
      await started;
      controller.abort();
      await assert.rejects(pending, /AbortError/);
      await aborted;
    } finally {
      streamChatImpl = undefined;
    }
  });

  it("keeps star separate from pin and enforces message versions, ordering, and attachment-free bodies",async()=>{
    const pinned=await requestJson("POST",`/api/v1/projects/${projectId}/chat/threads`,{endpointId});const starred=await requestJson("POST",`/api/v1/projects/${projectId}/chat/threads`,{endpointId});await requestJson("PATCH",`/api/v1/projects/${projectId}/chat/threads/${pinned.id}`,{pinned:true});const starResult=await requestJson("PATCH",`/api/v1/projects/${projectId}/chat/threads/${starred.id}`,{starred:true});assert.ok(starResult.starredAt);assert.equal(starResult.pinnedAt,null);const ordered=await requestJson("GET",`/api/v1/projects/${projectId}/chat/threads`);assert.ok(ordered.findIndex((item:any)=>item.id===starred.id)<ordered.findIndex((item:any)=>item.id===pinned.id));
    await sendMessage(starred.id,"editable");const history=await requestJson("GET",`/api/v1/projects/${projectId}/chat/threads/${starred.id}/messages`);const userMessage=history[0];const edited=await requestJson("PATCH",`/api/v1/projects/${projectId}/chat/threads/${starred.id}/messages/${userMessage.id}`,{content:"edited",expectedVersion:userMessage.version});assert.equal(edited.content,"edited");const stale=await request("PATCH",`/api/v1/projects/${projectId}/chat/threads/${starred.id}/messages/${userMessage.id}`,{content:"stale",expectedVersion:userMessage.version});assert.equal(stale.response.status,409);const branch=await requestJson("POST",`/api/v1/projects/${projectId}/chat/threads/${starred.id}/messages/${edited.id}/branch`,{expectedVersion:edited.version});assert.deepEqual((await requestJson("GET",`/api/v1/projects/${projectId}/chat/threads/${branch.id}/messages`)).map((item:any)=>item.content),["edited"]);const rejected=await request("POST",`/api/v1/projects/${projectId}/chat/threads`,{endpointId,attachments:["secret"]});assert.equal(rejected.response.status,400);await requestJson("DELETE",`/api/v1/projects/${projectId}/chat/threads/${starred.id}/messages/${edited.id}`,{expectedVersion:edited.version});assert.deepEqual(await requestJson("GET",`/api/v1/projects/${projectId}/chat/threads/${starred.id}/messages`),[]);
  });

  it("rejects URL and attachment fields on the chat send contract",async()=>{const thread=await requestJson("POST",`/api/v1/projects/${projectId}/chat/threads`,{endpointId});const response=await request("POST",`/api/v1/projects/${projectId}/chat/threads/${thread.id}/messages`,{content:"hello",afterMessageId:null,url:"https://example.test",attachments:[]});assert.equal(response.response.status,400);});

  it("updates thread titles and removes deleted threads from the list",async()=>{const thread=await requestJson("POST",`/api/v1/projects/${projectId}/chat/threads`,{endpointId});const renamed=await requestJson("PATCH",`/api/v1/projects/${projectId}/chat/threads/${thread.id}`,{title:"Retained title"});assert.equal(renamed.title,"Retained title");await requestJson("DELETE",`/api/v1/projects/${projectId}/chat/threads/${thread.id}`);const listed=await requestJson("GET",`/api/v1/projects/${projectId}/chat/threads`);assert.equal(listed.some((item:any)=>item.id===thread.id),false);});

  async function requestJson(method: string, pathname: string, body?: unknown) { const result = await request(method, pathname, body); assert.equal(result.response.status, 200, `${method} ${pathname}: ${JSON.stringify(result.body)}`); return result.body as any; }
  async function request(method: string, pathname: string, body?: unknown, session = cookie, token = csrf): Promise<{ response: Response; body: unknown }> {
    const response = await fetch(api.baseUrl + pathname, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(session ? { cookie: session } : {}), ...(["POST", "PATCH", "DELETE"].includes(method) && token ? { "x-csrf-token": token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, body: await response.json() };
  }
  async function sendMessage(threadId: string, content: string): Promise<void> {
    const history=await requestJson("GET",`/api/v1/projects/${projectId}/chat/threads/${threadId}/messages`);const afterMessageId=history.at(-1)?.id??null;
    const response = await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/chat/threads/${threadId}/messages`, { method: "POST", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf }, body: JSON.stringify({ content,afterMessageId }) });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /event: delta/);
    assert.match(stream, /event: done/);
  }
});

function endpointInput(name: string, credentialId: string) { return { name, protocol: "openai_chat_completions" as const, baseUrl: "https://models.example.test/v1", model: "model", credentialId, capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30 }; }
function fakeClient(): OpenAICompatibleClient { return { async validateEndpoint(){return{status:"healthy" as const};},async completeChat(endpoint: ModelEndpoint, messages): Promise<ChatResponse> { const content = messages.at(-1)?.content ?? ""; return { message: { role: "assistant", content: `answer:${content}` }, endpointSnapshot: { id: endpoint.id, baseUrl: endpoint.baseUrl, model: endpoint.model, protocol: endpoint.protocol } }; }, async streamChat(endpoint, messages, options) { if (streamChatImpl) return streamChatImpl(endpoint, messages, options); const response = await this.completeChat(endpoint, messages, options); options.onDelta(response.message.content); return response; } }; }
