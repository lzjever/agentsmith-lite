import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { ChatMessage, ChatResponse, ModelEndpoint } from "../../packages/contracts/src/api.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import type { ModelCredentialResolver, OpenAICompatibleClient } from "../../packages/openai-compatible-client/src/index.js";

describe("ChatService", () => {
  it("requires project access, resolves the endpoint secret, and passes the resolved key to the client", async () => {
    const calls: Array<{ endpoint: ModelEndpoint; messages: ChatMessage[]; apiKey: string }> = [];
    const services = createApplicationServices({
      store: createInMemoryProductStore(),
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      chatClient: fakeClient(calls),
      modelCredentialResolver: fakeResolver({ "secret/openai": { apiKey: "sk-resolved", baseUrl: "https://models.example.com/v1" } })
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });
    const endpoint = await services.endpoints.createEndpoint(user.id, project.id, endpointInput());
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];

    const response = await services.chat.sendChat(user.id, project.id, endpoint.id, messages);

    assert.equal(response.message.content, "fake response");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.endpoint.id, endpoint.id);
    assert.deepEqual(calls[0]?.messages, messages);
    assert.equal(calls[0]?.apiKey, "sk-resolved");
  });

  it("does not resolve secrets or call providers when the user cannot access the project", async () => {
    const clientCalls: unknown[] = [];
    const resolvedRefs: string[] = [];
    const services = createApplicationServices({
      store: createInMemoryProductStore(),
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      chatClient: fakeClient(clientCalls),
      modelCredentialResolver: trackingResolver(resolvedRefs, { "secret/openai": { apiKey: "sk-resolved", baseUrl: "https://models.example.com/v1" } })
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });
    const endpoint = await services.endpoints.createEndpoint(user.id, project.id, endpointInput());

    await assert.rejects(
      () => services.chat.sendChat("user_missing", project.id, endpoint.id, [{ role: "user", content: "hello" }]),
      ProductError
    );
    assert.deepEqual(resolvedRefs, []);
    assert.equal(clientCalls.length, 0);
  });

  it("does not resolve secrets or call providers when the endpoint is missing", async () => {
    const clientCalls: unknown[] = [];
    const resolvedRefs: string[] = [];
    const services = createApplicationServices({
      store: createInMemoryProductStore(),
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      chatClient: fakeClient(clientCalls),
      modelCredentialResolver: trackingResolver(resolvedRefs, { "secret/openai": { apiKey: "sk-resolved", baseUrl: "https://models.example.com/v1" } })
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });

    await assert.rejects(
      () => services.chat.sendChat(user.id, project.id, "endp_missing", [{ role: "user", content: "hello" }]),
      /Endpoint not found/
    );
    assert.deepEqual(resolvedRefs, []);
    assert.equal(clientCalls.length, 0);
  });

  it("does not call the provider when the endpoint secret is not configured", async () => {
    const clientCalls: unknown[] = [];
    const services = createApplicationServices({
      store: createInMemoryProductStore(),
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      chatClient: fakeClient(clientCalls),
      modelCredentialResolver: fakeResolver({})
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });
    const endpoint = await services.endpoints.createEndpoint(user.id, project.id, endpointInput());

    await assert.rejects(
      () => services.chat.sendChat(user.id, project.id, endpoint.id, [{ role: "user", content: "hello" }]),
      (error: unknown) => error instanceof ProductError && error.statusCode === 500
    );
    assert.equal(clientCalls.length, 0);
  });

  it("resolves credentials but does not call the provider when endpoint baseUrl differs from the credential binding", async () => {
    const clientCalls: unknown[] = [];
    const resolvedRefs: string[] = [];
    const services = createApplicationServices({
      store: createInMemoryProductStore(),
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      chatClient: fakeClient(clientCalls),
      modelCredentialResolver: trackingResolver(resolvedRefs, {
        "secret/openai": { apiKey: "sk-resolved", baseUrl: "https://models.example.com/v1" }
      })
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });
    const endpoint = await services.endpoints.createEndpoint(user.id, project.id, endpointInput({
      baseUrl: "https://evil.example.com/v1"
    }));

    await assert.rejects(
      () => services.chat.sendChat(user.id, project.id, endpoint.id, [{ role: "user", content: "hello" }]),
      (error: unknown) => error instanceof ProductError && error.statusCode === 400
    );
    assert.deepEqual(resolvedRefs, ["secret/openai"]);
    assert.equal(clientCalls.length, 0);
  });
});

function endpointInput(overrides: Partial<ReturnType<typeof endpointInputBase>> = {}) {
  return {
    ...endpointInputBase(),
    ...overrides
  };
}

function endpointInputBase() {
  return {
    name: "OpenAI-compatible",
    protocol: "openai_chat_completions" as const,
    baseUrl: "https://models.example.com/v1",
    model: "gpt-compatible",
    apiKeySecretRef: "secret/openai",
    capabilities: ["text" as const],
    requestTimeoutSecs: 30
  };
}

function fakeClient(calls: unknown[]): OpenAICompatibleClient {
  return {
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
    }
  };
}

function fakeResolver(values: Record<string, { apiKey: string; baseUrl: string }>): ModelCredentialResolver {
  return trackingResolver([], values);
}

function trackingResolver(calls: string[], values: Record<string, { apiKey: string; baseUrl: string }>): ModelCredentialResolver {
  return {
    resolveCredential(secretRef: string): { apiKey: string; baseUrl: string } {
      calls.push(secretRef);
      const value = values[secretRef];
      if (!value) {
        throw new ProductError("Model credential is not configured", 500);
      }
      return value;
    }
  };
}
