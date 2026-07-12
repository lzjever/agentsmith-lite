import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, it } from "node:test";
import type { ChatMessage, ModelEndpoint } from "../../packages/contracts/src/api.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import { FetchOpenAICompatibleClient } from "../../packages/openai-compatible-client/src/index.js";

describe("FetchOpenAICompatibleClient", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    servers.length = 0;
  });

  it("posts OpenAI-compatible chat completions with resolved credentials and maps the first choice", async () => {
    const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: unknown }> = [];
    const baseUrl = await serve(async (req, res) => {
      const body = JSON.parse(await readBody(req)) as unknown;
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      sendJson(res, 200, { choices: [{ message: { content: "hello from provider" } }] });
    });
    const endpoint = endpointFixture({ baseUrl: baseUrl + "/v1/" });
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];

    const response = await new FetchOpenAICompatibleClient().completeChat(endpoint, messages, { apiKey: "sk-test-secret" });

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.url, "/v1/chat/completions");
    assert.equal(seen[0]?.headers.authorization, "Bearer sk-test-secret");
    assert.match(String(seen[0]?.headers["content-type"]), /^application\/json/);
    assert.deepEqual(seen[0]?.body, { model: "gpt-compatible", messages });
    assert.deepEqual(response, {
      message: { role: "assistant", content: "hello from provider" },
      endpointSnapshot: {
        id: endpoint.id,
        baseUrl: endpoint.baseUrl,
        model: endpoint.model,
        protocol: endpoint.protocol
      }
    });
  });

  it("appends chat completions without double slashes when baseUrl has no trailing slash", async () => {
    let seenUrl = "";
    const baseUrl = await serve(async (req, res) => {
      seenUrl = req.url ?? "";
      sendJson(res, 200, { choices: [{ message: { content: "ok" } }] });
    });

    await new FetchOpenAICompatibleClient().completeChat(endpointFixture({ baseUrl }), [{ role: "user", content: "hi" }], { apiKey: "secret" });

    assert.equal(seenUrl, "/chat/completions");
  });

  it("validates OpenAI-compatible credentials through the models endpoint without returning provider content", async () => {
    let seenUrl = "";
    const baseUrl = await serve(async (req, res) => { seenUrl = req.url ?? ""; sendJson(res, 200, { data: [] }); });
    const result = await new FetchOpenAICompatibleClient().validateEndpoint!(endpointFixture({ baseUrl }), "sk-test-secret");
    assert.deepEqual(result, { status: "healthy" });
    assert.equal(seenUrl, "/models");
  });

  it("discovers a bounded, de-duplicated provider model list without creating a catalog", async () => {
    const baseUrl = await serve(async (_req, res) => sendJson(res, 200, { data: [{ id: "z-model" }, { id: "a-model" }, { id: "a-model" }, { id: 3 }] }));

    const result = await new FetchOpenAICompatibleClient().discoverModels!({ baseUrl, credentialId: "credential_1", requestTimeoutSecs: 30 }, "sk-test-secret");

    assert.deepEqual(result, { models: ["a-model", "z-model"], health: { status: "healthy", checkedAt: null, errorCategory: null } });
  });

  it("returns a sanitized health category for rejected validation without reading a provider body", async () => {
    const baseUrl = await serve(async (_req, res) => {
      sendJson(res, 401, { error: { message: "invalid sk-provider-secret" } });
    });

    const result = await new FetchOpenAICompatibleClient().validateEndpoint!(endpointFixture({ baseUrl }), "sk-provider-secret");

    assert.deepEqual(result, { status: "unavailable", errorCategory: "auth" });
    assert.doesNotMatch(JSON.stringify(result), /sk-provider-secret/);
  });

  it("maps timeout to ProductError 504 without leaking the api key", async () => {
    const baseUrl = await serve(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    await assertProviderError(
      () => new FetchOpenAICompatibleClient().completeChat(
        endpointFixture({ baseUrl, requestTimeoutSecs: 0.001 as never }),
        [{ role: "user", content: "hi" }],
        { apiKey: "sk-timeout-secret" }
      ),
      504,
      "sk-timeout-secret"
    );
  });

  it("maps provider rate limits to ProductError 429 without leaking the api key", async () => {
    const baseUrl = await serve(async (_req, res) => {
      sendJson(res, 429, { error: { message: "provider says sk-rate-limit-secret" } });
    });

    await assertProviderError(
      () => new FetchOpenAICompatibleClient().completeChat(endpointFixture({ baseUrl }), [{ role: "user", content: "hi" }], { apiKey: "sk-rate-limit-secret" }),
      429,
      "sk-rate-limit-secret"
    );
  });

  it("maps non-2xx provider responses to ProductError 502 without leaking provider bodies", async () => {
    const baseUrl = await serve(async (_req, res) => {
      sendJson(res, 500, { error: "upstream exploded with sk-non-2xx-secret" });
    });

    await assertProviderError(
      () => new FetchOpenAICompatibleClient().completeChat(endpointFixture({ baseUrl }), [{ role: "user", content: "hi" }], { apiKey: "sk-non-2xx-secret" }),
      502,
      "sk-non-2xx-secret"
    );
  });

  it("maps malformed provider responses to ProductError 502 without leaking the api key", async () => {
    const malformedJsonUrl = await serve(async (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not-json");
    });
    await assertProviderError(
      () => new FetchOpenAICompatibleClient().completeChat(endpointFixture({ baseUrl: malformedJsonUrl }), [{ role: "user", content: "hi" }], { apiKey: "sk-json-secret" }),
      502,
      "sk-json-secret"
    );

    const missingChoicesUrl = await serve(async (_req, res) => {
      sendJson(res, 200, { choices: [] });
    });
    await assertProviderError(
      () => new FetchOpenAICompatibleClient().completeChat(endpointFixture({ baseUrl: missingChoicesUrl }), [{ role: "user", content: "hi" }], { apiKey: "sk-choice-secret" }),
      502,
      "sk-choice-secret"
    );
  });

  async function serve(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void): Promise<string> {
    const server = http.createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((error: unknown) => {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(error instanceof Error ? error.message : "handler failed");
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  }
});

function endpointFixture(overrides: Partial<ModelEndpoint> = {}): ModelEndpoint {
  return {
    id: "endp_test",
    projectId: "proj_test",
    name: "Test endpoint",
    protocol: "openai_chat_completions",
    baseUrl: "https://models.example.com/v1",
    model: "gpt-compatible",
    credentialId: "cred_test",
    capabilities: ["text"],
    requestTimeoutSecs: 30,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function assertProviderError(action: () => Promise<unknown>, statusCode: number, secret: string): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => {
      assert.ok(error instanceof ProductError);
      assert.equal(error.statusCode, statusCode);
      assert.doesNotMatch(error.message, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    }
  );
}
