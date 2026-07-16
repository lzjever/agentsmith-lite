import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { ChatMessage, ChatResponse, ModelEndpoint } from "../../packages/contracts/src/api.js";
import { ProductError } from "../../packages/domain/src/errors.js";

import type { OpenAICompatibleClient } from "../../packages/openai-compatible-client/src/index.js";

describe("ChatService", () => {
  it("requires project access, resolves the endpoint secret, and passes the resolved key to the client", async () => {
    const calls: Array<{ endpoint: ModelEndpoint; messages: ChatMessage[]; apiKey: string }> = [];
    const services = createApplicationServices({
      store: createInMemoryProductStore(),
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      providerClient: fakeClient(calls),
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });
    const endpoint = await createCredentialEndpoint(services, user.id, project.id);
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];

    const response = await sendThreadMessage(services, user.id, project.id, endpoint.id, messages[0]!.content);

    assert.equal(response.message.content, "fake response");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.endpoint.id, endpoint.id);
    assert.deepEqual(calls[0]?.messages, messages);
    assert.equal(calls[0]?.apiKey, "sk-resolved");
    assert.deepEqual((await services.chat.listMessages(user.id, project.id, (await services.chat.listThreads(user.id, project.id))[0]!.id)).map((message) => [message.role, message.content]), [["user", "hello"], ["assistant", "fake response"]]);
  });

  it("adds effective context to provider input without storing it in conversation history", async () => {
    const calls: Array<{ endpoint: ModelEndpoint; messages: ChatMessage[]; apiKey: string }> = [];
    const services = createApplicationServices({ store: createInMemoryProductStore(), dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password", providerClient: fakeClient(calls) });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });
    const endpoint = await createCredentialEndpoint(services, user.id, project.id);
    await services.contexts.upsert(user.id, { workspaceId: workspace.id, scope: "workspace_personal", contextKey: "answer.style", content: "Answer in one sentence.", contentType: "text" });

    await sendThreadMessage(services, user.id, project.id, endpoint.id, "hello");

    assert.equal(calls[0]?.messages[0]?.role, "user");
    assert.match(calls[0]?.messages[0]?.content ?? "", /answer\.style[\s\S]*Answer in one sentence/);
    assert.deepEqual(calls[0]?.messages.at(-1), { role: "user", content: "hello" });
    const thread = (await services.chat.listThreads(user.id, project.id))[0]!;
    assert.deepEqual((await services.chat.listMessages(user.id, project.id, thread.id)).map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "hello" },
      { role: "assistant", content: "fake response" }
    ]);
  });

  it("persists the user message and releases the reserved request when a streamed chat is aborted", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({
      store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password",
      providerClient: { async validateEndpoint(){return{status:"healthy" as const};},async completeChat() { throw new Error("not used"); }, async streamChat(_endpoint, _messages, options) { await new Promise<void>((_resolve, reject) => { if (options.signal?.aborted) reject(new DOMException("Aborted", "AbortError")); else options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }); }); throw new Error("unreachable"); } }
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });
    const endpoint = await createCredentialEndpoint(services, user.id, project.id);
    const thread = await services.chat.createThread(user.id, project.id, endpoint.id);
    const setupAudit = await store.listProjectAuditEvents(project.id);
    assertCredentialEndpointThreadSetup(setupAudit);
    const { usage: setupUsage } = await services.policies.getUsageOverview(user.id, project.id);
    assert.deepEqual(providerUsage(setupUsage), { requests: 1, tokens: 0, cost: 0 });
    const controller = new AbortController();
    const content = "aborted chat content";
    const pending = services.chat.streamMessage(user.id, project.id, thread.id, content, null, controller.signal, () => undefined);
    controller.abort();
    await assert.rejects(pending, /Aborted/);
    assert.deepEqual((await services.chat.listMessages(user.id, project.id, thread.id)).map((message) => [message.role, message.content]), [["user", content]]);
    const { usage: current } = await services.policies.getUsageOverview(user.id, project.id);
    assert.deepEqual(providerUsage(current), { requests: 2, tokens: 0, cost: 0 });
    const audit = (await store.listProjectAuditEvents(project.id)).slice(setupAudit.length);
    assert.deepEqual(audit.map((event) => [event.action, event.status]), [["chat.message.send", "accepted"], ["provider.request", "accepted"], ["provider.request", "rejected"], ["chat.message.stop", "accepted"]]);
    assert.equal(JSON.stringify(audit).includes(content), false);
  });

  it("does not resolve secrets or call providers when the user cannot access the project", async () => {
    const clientCalls: unknown[] = [];
    const services = createApplicationServices({
      store: createInMemoryProductStore(),
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      providerClient: fakeClient(clientCalls),
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });
    const endpoint = await createCredentialEndpoint(services, user.id, project.id);

    await assert.rejects(
      () => sendThreadMessage(services, "user_missing", project.id, endpoint.id, "hello"),
      ProductError
    );
    assert.equal(clientCalls.length, 0);
  });

  it("records a deduplicated provider failure alert without storing chat content", async () => {
    const store = createInMemoryProductStore();
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      providerClient: { async validateEndpoint(){return{status:"healthy" as const};},async completeChat() { throw new ProductError("provider unavailable", 502); } } satisfies OpenAICompatibleClient,
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });
    const endpoint = await createCredentialEndpoint(services, user.id, project.id);
    const thread = await services.chat.createThread(user.id, project.id, endpoint.id);
    const setupAudit = await store.listProjectAuditEvents(project.id);
    assertCredentialEndpointThreadSetup(setupAudit);

    const content = "do not persist this";
    await assert.rejects(() => services.chat.sendMessage(user.id, project.id, thread.id, content, null));

    assert.deepEqual((await store.listActiveProjectAlerts(project.id)).map((alert) => alert.type), ["provider_failure"]);
    const audit = (await store.listProjectAuditEvents(project.id)).slice(setupAudit.length);
    assert.deepEqual(audit.map((event) => [event.action, event.status]), [["chat.message.send", "accepted"], ["provider.request", "accepted"], ["provider.request", "rejected"]]);
    assert.equal(JSON.stringify(audit).includes(content), false);
  });

  it("keeps a delivered direct-chat request unknown when persistence fails after the provider response", async () => {
    const store = createInMemoryProductStore();
    const providerCalls:unknown[]=[];
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      providerClient: fakeClient(providerCalls),
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });
    const endpoint = await createCredentialEndpoint(services, user.id, project.id);
    const thread=await services.chat.createThread(user.id,project.id,endpoint.id);
    assertCredentialEndpointThreadSetup(await store.listProjectAuditEvents(project.id));
    const { usage: setupUsage } = await services.policies.getUsageOverview(user.id, project.id);
    assert.deepEqual(providerUsage(setupUsage), { requests: 1, tokens: 0, cost: 0 });
    const markUnknown = store.markProjectProviderSettlementUnknown.bind(store);
    const unknownSettlements: string[] = [];
    store.markProjectProviderSettlementUnknown = async (id, timestamp) => { unknownSettlements.push(id); return markUnknown(id, timestamp); };
    const finalize=store.finalizeProjectChatResponse.bind(store);let failOnce=true;store.finalizeProjectChatResponse=async(id)=>{if(failOnce){failOnce=false;throw new Error("local finalize interrupted");}return finalize(id);};
    await assert.rejects(() => services.chat.sendMessage(user.id,project.id,thread.id,"hello",null),/local finalize interrupted/);
    assert.equal(providerCalls.length,1);assert.deepEqual((await store.listProjectChatMessages(thread.id)).map((item)=>[item.role,item.deliveryStatus]),[["user","response_pending"]]);
    const restarted=createApplicationServices({store,dataRoot:"/agentsmith-lite",builtinAdminPassword:"admin-password",providerClient:fakeClient(providerCalls)});const recovered=await restarted.chat.listMessages(user.id,project.id,thread.id);assert.deepEqual(recovered.map((item)=>[item.role,item.content]),[["user","hello"],["assistant","fake response"]]);assert.equal((await restarted.chat.listMessages(user.id,project.id,thread.id)).length,2);assert.equal(providerCalls.length,1);await assert.rejects(()=>restarted.chat.retryMessage(user.id,project.id,thread.id,recovered[0]!.id,recovered[0]!.version,undefined,()=>undefined),/Only a failed or stopped user message/);
    const { usage: current } = await services.policies.getUsageOverview(user.id, project.id);
    assert.equal(unknownSettlements.length, 1);
    assert.deepEqual(providerUsage(current), { requests: 2, tokens: 0, cost: 0 });
  });

  it("allows a verified non-admin project owner to use a pre-existing credential-bound endpoint", async () => {
    const clientCalls: unknown[] = [];
    const store = createInMemoryProductStore();
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      providerClient: fakeClient(clientCalls),
    });
    const member = await services.auth.loginExternalPrincipal({
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "member-chat-owner",
      email: "member@example.test",
      emailVerified: true
    });
    const workspace = await services.workspaces.createWorkspace(member.user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(member.user.id, workspace.id, { name: "Project" });
    const credential = await services.credentials.create(member.user.id, project.id, { name: "Provider", baseUrl: "https://models.example.com/v1", secret: "sk-resolved" });
    const endpoint = await store.createEndpoint({
      id: "endp_preexisting",
      projectId: project.id,
      ...endpointInput({ credentialId: credential.id }),
      health: { status: "healthy", checkedAt: "2026-01-01T00:00:00.000Z", errorCategory: null },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    const response = await sendThreadMessage(services, member.user.id, project.id, endpoint.id, "hello");

    assert.equal(response.message.content, "fake response");
    assert.equal(clientCalls.length, 1);
  });

  it("does not resolve secrets or call providers when the endpoint is missing", async () => {
    const clientCalls: unknown[] = [];
    const services = createApplicationServices({
      store: createInMemoryProductStore(),
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      providerClient: fakeClient(clientCalls),
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });

    await assert.rejects(
      () => sendThreadMessage(services, user.id, project.id, "endp_missing", "hello"),
      /Endpoint not found/
    );
    assert.equal(clientCalls.length, 0);
  });

  it("does not call the provider when the endpoint secret is not configured", async () => {
    const clientCalls: unknown[] = [];
    const store = createInMemoryProductStore();
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      providerClient: fakeClient(clientCalls),
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });
    const endpoint = await store.createEndpoint({ id: "endp_missing_credential", projectId: project.id, ...endpointInput(), credentialId: "", health: { status: "healthy", checkedAt: "2026-01-01T00:00:00.000Z", errorCategory: null }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });

    await assert.rejects(
      () => sendThreadMessage(services, user.id, project.id, endpoint.id, "hello"),
      (error: unknown) => error instanceof ProductError && error.statusCode === 404
    );
    assert.equal(clientCalls.length, 0);
  });

  it("does not call the provider when a stored endpoint references a credential with a different base URL", async () => {
    const clientCalls: unknown[] = [];
    const store = createInMemoryProductStore();
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      providerClient: fakeClient(clientCalls)
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });
    const credential = await services.credentials.create(user.id, project.id, { name: "Provider", baseUrl: "https://models.example.com/v1", secret: "sk-resolved" });
    const endpoint = await store.createEndpoint({ id: "endp_wrong_binding", projectId: project.id, ...endpointInput({ baseUrl: "https://evil.example.com/v1", credentialId: credential.id }), health: { status: "healthy", checkedAt: "2026-01-01T00:00:00.000Z", errorCategory: null }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });

    await assert.rejects(
      () => sendThreadMessage(services, user.id, project.id, endpoint.id, "hello"),
      (error: unknown) => error instanceof ProductError && error.statusCode === 400
    );
    assert.equal(clientCalls.length, 0);
  });

  it("keeps star and pin independent and validates versioned edit, delete, and branch order",async()=>{
    const services=createApplicationServices({store:createInMemoryProductStore(),dataRoot:"/agentsmith-lite",builtinAdminPassword:"admin-password",providerClient:fakeClient([])});const{user}=await services.auth.loginAfterBootstrap("admin-password");const workspace=await services.workspaces.createWorkspace(user.id,{name:"Workspace"});const project=await services.workspaces.createProject(user.id,workspace.id,{name:"Project"});const endpoint=await createCredentialEndpoint(services,user.id,project.id);const thread=await services.chat.createThread(user.id,project.id,endpoint.id);
    const starred=await services.chat.updateThreadMetadata(user.id,project.id,thread.id,{starred:true});assert.ok(starred.starredAt);assert.equal(starred.pinnedAt,null);const pinned=await services.chat.updateThreadMetadata(user.id,project.id,thread.id,{pinned:true});assert.ok(pinned.starredAt);assert.ok(pinned.pinnedAt);
    await services.chat.sendMessage(user.id,project.id,thread.id,"first",null);let history=await services.chat.listMessages(user.id,project.id,thread.id);await services.chat.sendMessage(user.id,project.id,thread.id,"second",history.at(-1)!.id);history=await services.chat.listMessages(user.id,project.id,thread.id);const first=history[0]!;const branch=await services.chat.branchMessage(user.id,project.id,thread.id,first.id,first.version);assert.deepEqual((await services.chat.listMessages(user.id,project.id,branch.id)).map((item)=>item.content),["first"]);
    const edited=await services.chat.editMessage(user.id,project.id,thread.id,first.id,first.version,"revised");assert.equal(edited.content,"revised");assert.deepEqual((await services.chat.listMessages(user.id,project.id,thread.id)).map((item)=>item.content),["revised"]);await assert.rejects(()=>services.chat.editMessage(user.id,project.id,thread.id,first.id,first.version,"stale"),(error:unknown)=>error instanceof ProductError&&error.statusCode===409);await services.chat.deleteMessage(user.id,project.id,thread.id,edited.id,edited.version);assert.deepEqual(await services.chat.listMessages(user.id,project.id,thread.id),[]);
  });

  it("retries a failed persisted user message without duplicating provider history",async()=>{
    let attempts=0;const histories:ChatMessage[][]=[];const client:OpenAICompatibleClient={async validateEndpoint(){return{status:"healthy" as const};},async completeChat(endpoint,messages){attempts++;histories.push(messages);if(attempts===1)throw new ProductError("provider unavailable",502);return{message:{role:"assistant",content:"recovered"},endpointSnapshot:{id:endpoint.id,baseUrl:endpoint.baseUrl,model:endpoint.model,protocol:endpoint.protocol}};},async streamChat(endpoint,messages,options){const response=await this.completeChat(endpoint,messages,options);options.onDelta(response.message.content);return response;}};
    const services=createApplicationServices({store:createInMemoryProductStore(),dataRoot:"/agentsmith-lite",builtinAdminPassword:"admin-password",providerClient:client});const{user}=await services.auth.loginAfterBootstrap("admin-password");const workspace=await services.workspaces.createWorkspace(user.id,{name:"Workspace"});const project=await services.workspaces.createProject(user.id,workspace.id,{name:"Project"});const endpoint=await createCredentialEndpoint(services,user.id,project.id);const thread=await services.chat.createThread(user.id,project.id,endpoint.id);await assert.rejects(()=>services.chat.sendMessage(user.id,project.id,thread.id,"recover me",null));const failed=(await services.chat.listMessages(user.id,project.id,thread.id))[0]!;assert.equal(failed.deliveryStatus,"failed");const edited=await services.chat.editMessage(user.id,project.id,thread.id,failed.id,failed.version,"revised recovery");assert.equal(edited.deliveryStatus,"failed");await assert.rejects(()=>services.chat.branchMessage(user.id,project.id,thread.id,edited.id,edited.version),(error:unknown)=>error instanceof ProductError&&error.statusCode===409);await services.chat.retryMessage(user.id,project.id,thread.id,edited.id,edited.version,undefined,()=>undefined);assert.deepEqual(histories.map((items)=>items.map((item)=>item.content)),[["recover me"],["revised recovery"]]);assert.deepEqual((await services.chat.listMessages(user.id,project.id,thread.id)).map((item)=>[item.content,item.deliveryStatus]),[["revised recovery","completed"],["recovered","completed"]]);
  });
});

function endpointInput(overrides: Partial<ReturnType<typeof endpointInputBase>> = {}) {
  return {
    ...endpointInputBase(),
    ...overrides
  };
}

async function sendThreadMessage(services: ReturnType<typeof createApplicationServices>, userId: string, projectId: string, endpointId: string, content: string) {
  const thread = await services.chat.createThread(userId, projectId, endpointId);
  return services.chat.sendMessage(userId, projectId, thread.id, content);
}

function endpointInputBase() {
  return {
    name: "OpenAI-compatible",
    protocol: "openai_chat_completions" as const,
    baseUrl: "https://models.example.com/v1",
    model: "gpt-compatible",
    credentialId: "cred_test",
    capabilities: ["text" as const],
    requestTimeoutSecs: 30
  };
}

async function createCredentialEndpoint(services: ReturnType<typeof createApplicationServices>, userId: string, projectId: string, overrides: Partial<ReturnType<typeof endpointInputBase>> = {}) {
  const input = endpointInput(overrides);
  const credential = await services.credentials.create(userId, projectId, { name: "Provider", baseUrl: input.baseUrl, secret: "sk-resolved" });
  return services.endpoints.createEndpoint(userId, projectId, { ...input, credentialId: credential.id });
}

function fakeClient(calls: unknown[]): OpenAICompatibleClient {
  return {
    async validateEndpoint(){return{status:"healthy" as const};},
    async completeChat(endpoint, messages, options): Promise<ChatResponse> {
      calls.push({ endpoint, messages, apiKey: options.apiKey });
      return {
        message: { role: "assistant", content: "fake response" },
        endpointSnapshot: {
          id: endpoint.id,
          baseUrl: endpoint.baseUrl,
          model: endpoint.model,
          protocol: endpoint.protocol
        }
      };
    },
    async streamChat(endpoint, messages, options): Promise<ChatResponse> { const response=await this.completeChat(endpoint,messages,options); options.onDelta(response.message.content); return response; }
  };
}

function providerUsage(usage: { providerRequests: number; providerTokens: number; providerCost: number }) {
  return { requests: usage.providerRequests, tokens: usage.providerTokens, cost: usage.providerCost };
}

function assertCredentialEndpointThreadSetup(audit: Array<{ action: string; status: string; detail?: unknown }>) {
  assert.deepEqual(audit.map((event) => [event.action, event.status, event.detail]), [
    ["credential.create", "accepted", { credentialVersion: 1 }],
    ["provider.request", "accepted", {}],
    ["endpoint.create", "accepted", { endpointId: audit.find((event) => event.action === "endpoint.create")?.detail && (audit.find((event) => event.action === "endpoint.create")!.detail as { endpointId: string }).endpointId, healthStatus: "healthy" }],
    ["chat.thread.create", "accepted", {}]
  ]);
}
