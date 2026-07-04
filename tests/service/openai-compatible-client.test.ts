import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, it } from "node:test";
import type { ChatMessage, ModelEndpoint } from "../../packages/contracts/src/api.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import { EnvModelCredentialResolver, FetchOpenAICompatibleClient } from "../../packages/openai-compatible-client/src/index.js";

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

describe("EnvModelCredentialResolver", () => {
  const envNames = [
    "AGENTSMITH_LITE_MODEL_API_KEY_OPENAI",
    "AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI"
  ];
  const originalEnv = new Map<string, string | undefined>();

  afterEach(() => {
    for (const name of envNames) {
      const value = originalEnv.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    originalEnv.clear();
  });

  it("maps secret refs to configured model API key and base URL env vars", () => {
    rememberEnv();
    process.env.AGENTSMITH_LITE_MODEL_API_KEY_OPENAI = "sk-env-openai";
    process.env.AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI = "https://models.example.com/v1";

    assert.deepEqual(new EnvModelCredentialResolver().resolveCredential("secret/openai"), {
      apiKey: "sk-env-openai",
      baseUrl: "https://models.example.com/v1"
    });
  });

  it("rejects invalid secret refs before reading environment", () => {
    rememberEnv();
    process.env.AGENTSMITH_LITE_MODEL_API_KEY_OPENAI = "sk-env-openai";
    process.env.AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI = "https://models.example.com/v1";

    assert.throws(
      () => new EnvModelCredentialResolver().resolveCredential("secret/open_ai"),
      (error: unknown) => error instanceof ProductError && error.statusCode === 400
    );
  });

  it("requires both model API key and base URL env vars", () => {
    rememberEnv();
    process.env.AGENTSMITH_LITE_MODEL_API_KEY_OPENAI = "sk-env-openai";
    delete process.env.AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI;
    assert.throws(
      () => new EnvModelCredentialResolver().resolveCredential("secret/openai"),
      (error: unknown) => error instanceof ProductError && error.statusCode === 500
    );

    delete process.env.AGENTSMITH_LITE_MODEL_API_KEY_OPENAI;
    process.env.AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI = "https://models.example.com/v1";
    assert.throws(
      () => new EnvModelCredentialResolver().resolveCredential("secret/openai"),
      (error: unknown) => error instanceof ProductError && error.statusCode === 500
    );
  });

  function rememberEnv(): void {
    for (const name of envNames) {
      if (!originalEnv.has(name)) {
        originalEnv.set(name, process.env[name]);
      }
    }
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
    apiKeySecretRef: "secret/openai",
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
