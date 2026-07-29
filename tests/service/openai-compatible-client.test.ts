import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https, { type RequestOptions } from "node:https";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import type { DetailedPeerCertificate } from "node:tls";
import type { ChatMessage, ModelEndpoint } from "../../packages/contracts/src/api.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import { FetchOpenAICompatibleClient, type ProviderNetworkPolicy } from "../../packages/openai-compatible-client/src/index.js";

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

  it("validates the configured model through Chat Completions without returning provider content", async () => {
    let seen: { url: string; body: unknown } | undefined;
    const baseUrl = await serve(async (req, res) => { seen = { url: req.url ?? "", body: JSON.parse(await readBody(req)) as unknown }; sendJson(res, 200, { choices: [{ message: { content: "ok" } }] }); });
    const result = await new FetchOpenAICompatibleClient().validateEndpoint!(endpointFixture({ baseUrl }), "sk-test-secret");
    assert.deepEqual(result, { status: "healthy" });
    assert.equal(seen?.url, "/chat/completions");
    assert.deepEqual(seen?.body, { model: "gpt-compatible", messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1, stream: false });
  });

  it("does not report malformed Chat Completions output as healthy", async () => {
    const baseUrl = await serve(async (_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("not json"); });
    const result = await new FetchOpenAICompatibleClient().validateEndpoint!(endpointFixture({ baseUrl }), "sk-test-secret");
    assert.deepEqual(result, { status: "unavailable", errorCategory: "upstream" });
  });

  it("blocks private provider targets unless operations explicitly allow the hostname", async () => {
    let calls = 0;
    let requestedUrl: string | undefined;
    let requestedSignal: AbortSignal | null | undefined;
    const providerFetch: typeof fetch = async (url, init) => {
      calls += 1;
      requestedUrl = url.toString();
      requestedSignal = init?.signal;
      assert.equal(init?.redirect, "error");
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } });
    };
    const endpoint = endpointFixture({ baseUrl: "https://provider.internal/v1" });
    const resolvePrivate = async () => [{ address: "10.20.30.40", family: 4 as const }];

    await assert.rejects(() => new FetchOpenAICompatibleClient(providerFetch, { resolve: resolvePrivate }).completeChat(endpoint, [{ role: "user", content: "hi" }], { apiKey: "secret" }), /provider host is not allowed/);
    assert.equal(calls, 0);

    const response = await new FetchOpenAICompatibleClient(providerFetch, { privateHosts: ["provider.internal"], resolve: resolvePrivate }).completeChat(endpoint, [{ role: "user", content: "hi" }], { apiKey: "secret" });
    assert.equal(response.message.content, "ok");
    assert.equal(calls, 1);
    assert.equal(requestedUrl, "https://provider.internal/v1/chat/completions");
    assert.ok(requestedSignal instanceof AbortSignal);
  });

  it("keeps an explicitly supplied custom fetch after public DNS approval", async () => {
    let resolutionCalls = 0;
    let fetchCalls = 0;
    let requestedUrl: string | undefined;
    let requestedRedirect: RequestRedirect | undefined;
    let requestedSignal: AbortSignal | null | undefined;
    const providerFetch: typeof fetch = async (url, init) => {
      fetchCalls += 1;
      requestedUrl = url.toString();
      requestedRedirect = init?.redirect;
      requestedSignal = init?.signal;
      return chatCompletionResponse();
    };
    const client = clientWithHttpsRequest(
      providerFetch,
      {
        resolve: async () => {
          resolutionCalls += 1;
          return [{ address: "93.184.216.34", family: 4 }];
        }
      },
      (() => {
        throw new Error("custom fetch must remain the transport");
      }) as typeof https.request
    );

    const response = await client.completeChat(
      endpointFixture({ baseUrl: "https://provider.example.test/v1" }),
      [{ role: "user", content: "hi" }],
      { apiKey: "secret" }
    );

    assert.equal(response.message.content, "ok");
    assert.equal(resolutionCalls, 1);
    assert.equal(fetchCalls, 1);
    assert.equal(requestedUrl, "https://provider.example.test/v1/chat/completions");
    assert.equal(requestedRedirect, "error");
    assert.ok(requestedSignal instanceof AbortSignal);
  });

  it("uses the one approved DNS address for the HTTPS connection carrying Authorization", async () => {
    let resolutionCalls = 0;
    let providerFetchCalls = 0;
    let authorizationReachedUnapprovedAddress = false;
    let requestOptions: RequestOptions | undefined;
    const resolve = async () => {
      resolutionCalls += 1;
      return resolutionCalls === 1
        ? [{ address: "93.184.216.34", family: 4 as const }]
        : [{ address: "10.20.30.40", family: 4 as const }];
    };
    const providerFetch: typeof fetch = async (_url, init) => {
      providerFetchCalls += 1;
      const secondResolution = await resolve();
      assert.equal(secondResolution[0]?.address, "10.20.30.40");
      authorizationReachedUnapprovedAddress = new Headers(init?.headers).has("authorization");
      return chatCompletionResponse();
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = providerFetch;
    try {
      const providerHttpsRequest = stubHttpsRequest(async (options) => {
        requestOptions = options;
        return { body: JSON.stringify({ choices: [{ message: { content: "pinned" } }] }) };
      });
      const client = clientWithHttpsRequest(providerFetch, { resolve }, providerHttpsRequest);

      const response = await client.completeChat(
        endpointFixture({ baseUrl: "https://provider.example.test/v1" }),
        [{ role: "user", content: "hi" }],
        { apiKey: "sk-pinned-secret" }
      );

      assert.equal(resolutionCalls, 1);
      assert.equal(providerFetchCalls, 0);
      assert.equal(authorizationReachedUnapprovedAddress, false);
      assert.equal(requestOptions?.hostname, "93.184.216.34");
      assert.equal(new Headers(requestOptions?.headers as HeadersInit).get("authorization"), "Bearer sk-pinned-secret");
      assert.equal(response.message.content, "pinned");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("tries approved addresses in order before TLS commitment and sends the body once", async () => {
    let resolutionCalls = 0;
    const attempts: StubTlsAttempt[] = [];
    const providerHttpsRequest = stubTlsHttpsRequest(
      ["fail-before-secure", "respond"],
      attempts
    );
    const client = clientWithHttpsRequest(
      globalThis.fetch,
      {
        resolve: async () => {
          resolutionCalls += 1;
          return [
            { address: "2606:4700:4700::1111", family: 6 },
            { address: "93.184.216.34", family: 4 }
          ];
        }
      },
      providerHttpsRequest
    );

    const response = await client.completeChat(
      endpointFixture({ baseUrl: "https://provider.example.test:8443/v1" }),
      [{ role: "user", content: "hi" }],
      { apiKey: "secret" }
    );

    assert.equal(response.message.content, "fallback");
    assert.equal(resolutionCalls, 1);
    assert.deepEqual(attempts.map(({ options }) => [options.hostname, options.family]), [
      ["2606:4700:4700::1111", 6],
      ["93.184.216.34", 4]
    ]);
    assert.deepEqual(attempts.map(({ bodies }) => bodies), [
      [],
      [JSON.stringify({ model: "gpt-compatible", messages: [{ role: "user", content: "hi" }] })]
    ]);
    assert.equal(attempts.some(({ endedBeforeSecure }) => endedBeforeSecure), false);
    for (const { options } of attempts) {
      assert.equal(options.agent, false);
      assert.equal(options.servername, "provider.example.test");
      assert.equal(new Headers(options.headers as HeadersInit).get("host"), "provider.example.test:8443");
      assert.equal(
        options.checkServerIdentity?.(
          String(options.hostname),
          { subject: { CN: "provider.example.test" }, subjectaltname: "DNS:provider.example.test" } as DetailedPeerCertificate
        ),
        undefined
      );
      assert.match(
        options.checkServerIdentity?.(
          String(options.hostname),
          { subject: { CN: "other.example.test" }, subjectaltname: "DNS:other.example.test" } as DetailedPeerCertificate
        )?.message ?? "",
        /provider\.example\.test/
      );
    }
  });

  it("does not try another approved address after TLS commitment", async () => {
    const attempts: StubTlsAttempt[] = [];
    const client = clientWithHttpsRequest(
      globalThis.fetch,
      {
        resolve: async () => [
          { address: "2606:4700:4700::1111", family: 6 },
          { address: "93.184.216.34", family: 4 }
        ]
      },
      stubTlsHttpsRequest(["fail-after-secure", "respond"], attempts)
    );

    await assertProviderError(
      () => client.completeChat(
        endpointFixture({ baseUrl: "https://provider.example.test/v1" }),
        [{ role: "user", content: "hi" }],
        { apiKey: "sk-post-secure-secret" }
      ),
      502,
      "sk-post-secure-secret"
    );

    assert.deepEqual(attempts.map(({ options }) => options.hostname), ["2606:4700:4700::1111"]);
    assert.deepEqual(attempts.map(({ bodies }) => bodies.length), [1]);
    assert.equal(attempts[0]?.endedBeforeSecure, false);
  });

  it("discovers a bounded, de-duplicated provider model list without creating a catalog", async () => {
    const baseUrl = await serve(async (_req, res) => sendJson(res, 200, { data: [{ id: "z-model" }, { id: "a-model" }, { id: "a-model" }, { id: 3 }] }));

    const result = await new FetchOpenAICompatibleClient().discoverModels!({ baseUrl, credentialId: "credential_1", requestTimeoutSecs: 30 }, "sk-test-secret");

    assert.deepEqual(result, { models: ["a-model", "z-model"], health: { status: "healthy", checkedAt: null, errorCategory: null } });
  });

  it("does not report malformed model discovery output as healthy", async () => {
    const baseUrl = await serve(async (_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("not json"); });

    const result = await new FetchOpenAICompatibleClient().discoverModels!({ baseUrl, credentialId: "credential_1", requestTimeoutSecs: 30 }, "sk-test-secret");

    assert.deepEqual(result, { models: [], health: { status: "unavailable", checkedAt: null, errorCategory: "upstream" } });
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

  it("keeps the timeout active while a streaming response body is being read", { timeout: 1_000 }, async () => {
    const encoder = new TextEncoder();
    const providerFetch: typeof fetch = async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n"));
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      }
    }), { headers: { "content-type": "text/event-stream" } });

    await assertProviderError(
      () => new FetchOpenAICompatibleClient(providerFetch).streamChat!(
        endpointFixture({ requestTimeoutSecs: 0.02 as never }),
        [{ role: "user", content: "hi" }],
        { apiKey: "sk-stream-timeout-secret", onDelta: () => undefined }
      ),
      504,
      "sk-stream-timeout-secret"
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

interface StubHttpsResponse {
  statusCode?: number;
  headers?: http.IncomingHttpHeaders;
  body: string;
}

interface StubTlsAttempt {
  options: RequestOptions;
  bodies: string[];
  endedBeforeSecure: boolean;
}

type StubTlsAction = "fail-before-secure" | "fail-after-secure" | "respond";

function clientWithHttpsRequest(
  providerFetch: typeof fetch,
  networkPolicy: ProviderNetworkPolicy,
  providerHttpsRequest: typeof https.request
): FetchOpenAICompatibleClient {
  const InternalClient = FetchOpenAICompatibleClient as unknown as new (
    providerFetch: typeof fetch,
    networkPolicy: ProviderNetworkPolicy,
    providerHttpsRequest: typeof https.request
  ) => FetchOpenAICompatibleClient;
  return new InternalClient(providerFetch, networkPolicy, providerHttpsRequest);
}

function stubHttpsRequest(handler: (options: RequestOptions, body: string) => Promise<StubHttpsResponse>): typeof https.request {
  return ((options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const request = new EventEmitter() as EventEmitter & {
      write(chunk: string | Uint8Array): boolean;
      end(chunk?: string | Uint8Array): void;
      destroy(error?: Error): void;
    };
    const chunks: Buffer[] = [];
    request.write = (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
      return true;
    };
    request.end = (chunk) => {
      if (chunk !== undefined) request.write(chunk);
      queueMicrotask(() => {
        handler(options, Buffer.concat(chunks).toString("utf8")).then(({ statusCode = 200, headers = { "content-type": "application/json" }, body }) => {
          const response = new PassThrough() as PassThrough & IncomingMessage;
          response.statusCode = statusCode;
          response.statusMessage = "OK";
          response.headers = headers;
          callback(response);
          if (!response.destroyed) response.end(body);
        }, (error: unknown) => request.emit("error", error));
      });
    };
    request.destroy = (error) => {
      if (error) queueMicrotask(() => request.emit("error", error));
    };
    const signal = options.signal;
    const abort = () => request.emit("error", Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    if (signal?.aborted) queueMicrotask(abort);
    else signal?.addEventListener("abort", abort, { once: true });
    const socket = new EventEmitter();
    queueMicrotask(() => {
      request.emit("socket", socket);
      socket.emit("secureConnect");
    });
    return request;
  }) as typeof https.request;
}

function stubTlsHttpsRequest(actions: readonly StubTlsAction[], attempts: StubTlsAttempt[]): typeof https.request {
  return ((options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const action = actions[attempts.length];
    assert.ok(action, "unexpected HTTPS request attempt");
    const attempt: StubTlsAttempt = { options, bodies: [], endedBeforeSecure: false };
    attempts.push(attempt);
    const request = new EventEmitter() as EventEmitter & {
      write(chunk: string | Uint8Array): boolean;
      end(chunk?: string | Uint8Array): void;
      destroy(error?: Error): void;
    };
    const socket = new EventEmitter();
    let secure = false;
    request.write = (chunk) => {
      if (!secure) attempt.endedBeforeSecure = true;
      attempt.bodies.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
    request.end = (chunk) => {
      if (!secure) attempt.endedBeforeSecure = true;
      if (chunk !== undefined) request.write(chunk);
      if (action === "fail-after-secure") {
        queueMicrotask(() => request.emit("error", new Error("request failed after secureConnect")));
      } else if (action === "respond") {
        queueMicrotask(() => {
          const response = new PassThrough() as PassThrough & IncomingMessage;
          response.statusCode = 200;
          response.statusMessage = "OK";
          response.headers = { "content-type": "application/json" };
          callback(response);
          response.end(JSON.stringify({ choices: [{ message: { content: "fallback" } }] }));
        });
      }
    };
    request.destroy = (error) => {
      if (error) queueMicrotask(() => request.emit("error", error));
    };
    const abort = () => request.emit("error", Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    if (options.signal?.aborted) queueMicrotask(abort);
    else options.signal?.addEventListener("abort", abort, { once: true });
    queueMicrotask(() => {
      request.emit("socket", socket);
      if (action === "fail-before-secure") {
        request.emit("error", new Error("TLS connection failed"));
      } else {
        secure = true;
        socket.emit("secureConnect");
      }
    });
    return request;
  }) as typeof https.request;
}

function chatCompletionResponse(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
    headers: { "content-type": "application/json" }
  });
}

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
