import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";
import type { ChatMessage, ChatResponse, DiscoverEndpointModelsInput, EndpointHealthErrorCategory, EndpointModelDiscovery, ModelEndpoint } from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";

export interface CompleteChatOptions {
  apiKey: string;
}
export interface StreamChatOptions extends CompleteChatOptions { signal?: AbortSignal; onDelta: (content: string) => void; }
export interface RawChatCompletionOptions extends CompleteChatOptions { body: Record<string, unknown>; headers?: Record<string, string>; signal?: AbortSignal; }


export interface OpenAICompatibleClient {
  completeChat(endpoint: ModelEndpoint, messages: ChatMessage[], options: CompleteChatOptions): Promise<ChatResponse>;
  streamChat?(endpoint: ModelEndpoint, messages: ChatMessage[], options: StreamChatOptions): Promise<ChatResponse>;
  validateEndpoint?(endpoint: ModelEndpoint, apiKey: string): Promise<{ status: "healthy" } | { status: "unavailable"; errorCategory: EndpointHealthErrorCategory }>;
  discoverModels?(input: DiscoverEndpointModelsInput, apiKey: string): Promise<EndpointModelDiscovery>;
  rawChatCompletion?(endpoint: ModelEndpoint, options: RawChatCompletionOptions): Promise<Response>;
}


export class FetchOpenAICompatibleClient implements OpenAICompatibleClient {
  constructor(private readonly providerFetch: typeof fetch = fetch, private readonly networkPolicy?: ProviderNetworkPolicy) {
    networkPolicy?.privateHosts?.forEach(normalizeConfiguredProviderHost);
  }

  async validateEndpoint(endpoint: ModelEndpoint, apiKey: string): Promise<{ status: "healthy" } | { status: "unavailable"; errorCategory: EndpointHealthErrorCategory }> {
    try {
      const response = await this.requestProvider(chatCompletionsUrl(endpoint.baseUrl), endpoint.requestTimeoutSecs, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: endpoint.model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1, stream: false }) });
      let body: unknown;
      try { body = await response.json(); } catch { throw providerError("OpenAI-compatible provider returned malformed JSON", 502, "upstream"); }
      try { parseAssistantContent(body); } catch { throw providerError("OpenAI-compatible provider returned a malformed chat response", 502, "upstream"); }
      return { status: "healthy" };
    } catch (error) {
      return { status: "unavailable", errorCategory: providerErrorCategory(error) };
    }
  }
  async discoverModels(input: DiscoverEndpointModelsInput, apiKey: string): Promise<EndpointModelDiscovery> {
    try {
      const response = await this.requestProvider(modelsUrl(input.baseUrl), input.requestTimeoutSecs, { headers: { authorization: `Bearer ${apiKey}` } });
      let body: unknown;
      try { body = await response.json(); } catch { throw providerError("OpenAI-compatible provider returned malformed model discovery JSON", 502, "upstream"); }
      if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) {
        throw providerError("OpenAI-compatible provider returned a malformed model discovery response", 502, "upstream");
      }
      return { models: modelIds(body), health: { status: "healthy", checkedAt: null, errorCategory: null } };
    } catch (error) {
      return { models: [], health: { status: "unavailable", checkedAt: null, errorCategory: providerErrorCategory(error) } };
    }
  }
  async completeChat(endpoint: ModelEndpoint, messages: ChatMessage[], options: CompleteChatOptions): Promise<ChatResponse> {
    const response = await this.fetchChatCompletion(endpoint, messages, options.apiKey);
    const content = parseAssistantContent(response);
    const usage = providerUsage(response);
    return {
      message: {
        role: "assistant",
        content
      },
      endpointSnapshot: {
        id: endpoint.id,
        baseUrl: endpoint.baseUrl,
        model: endpoint.model,
        protocol: endpoint.protocol
      },
      ...(usage ? { usage } : {})
    };
  }
  async streamChat(endpoint: ModelEndpoint, messages: ChatMessage[], options: StreamChatOptions): Promise<ChatResponse> {
    const response = await this.rawChatCompletion(endpoint, { apiKey: options.apiKey, body: { model:endpoint.model,messages,stream:true,stream_options:{include_usage:true} }, ...(options.signal ? { signal: options.signal } : {}) });
    if (!response.body) throw new ProductError("OpenAI-compatible provider response was empty", 502);
    try {
      const reader=response.body.getReader(); const decoder=new TextDecoder(); let buffer="", content="", usage: import("../../contracts/src/api.js").ProviderUsage|undefined;
      while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split("\n");buffer=lines.pop()??"";for(const line of lines){if(!line.startsWith("data:"))continue;const data=line.slice(5).trim();if(!data||data==="[DONE]")continue;try{const event=JSON.parse(data);const delta=event?.choices?.[0]?.delta?.content;if(typeof delta==="string"&&delta){content+=delta;options.onDelta(delta);}const next=providerUsage(event);if(next)usage=next;}catch{}}}
      return {message:{role:"assistant",content},endpointSnapshot:{id:endpoint.id,baseUrl:endpoint.baseUrl,model:endpoint.model,protocol:endpoint.protocol},...(usage?{usage}:{})};
    } catch (error) { if (options.signal?.aborted) throw error; throw sanitizeProviderError(error); }
  }

  async rawChatCompletion(endpoint: ModelEndpoint, options: RawChatCompletionOptions): Promise<Response> {
    return this.requestProvider(chatCompletionsUrl(endpoint.baseUrl), endpoint.requestTimeoutSecs, { method: "POST", headers: { "content-type": "application/json", ...options.headers, authorization: `Bearer ${options.apiKey}` }, body: JSON.stringify(options.body) }, options.signal);
  }

  private async fetchChatCompletion(endpoint: ModelEndpoint, messages: ChatMessage[], apiKey: string): Promise<unknown> {
    const response = await this.rawChatCompletion(endpoint, { apiKey, body: { model: endpoint.model, messages } });
    try {
      return await response.json();
    } catch { throw new ProductError("OpenAI-compatible provider returned malformed JSON", 502); }
  }

  private async requestProvider(url: string, timeoutSecs: number, init: RequestInit, externalSignal?: AbortSignal): Promise<Response> {
    if (this.networkPolicy) await assertProviderTargetAllowed(url, this.networkPolicy);
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    };
    const timeout = setTimeout(() => {
      controller.abort();
      release();
    }, timeoutSecs * 1000);
    try {
      const response = await this.providerFetch(url, { ...init, redirect: "error", signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw providerStatusError(response.status);
      }
      if (!response.body) {
        release();
        return response;
      }
      return responseWithLifecycle(response, release, (error) => externalSignal?.aborted ? error : sanitizeProviderError(error));
    } catch (error) {
      release();
      if (externalSignal?.aborted) throw error;
      throw sanitizeProviderError(error);
    }
  }
}

function responseWithLifecycle(response: Response, release: () => void, sanitizeBodyError: (error: unknown) => unknown): Response {
  const reader = response.body!.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        release();
        controller.error(sanitizeBodyError(error));
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason);
    }
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export interface ProviderNetworkPolicy {
  privateHosts?: readonly string[];
  resolve?: (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]>;
}

const nonPublicAddresses = createNonPublicAddressList();

async function assertProviderTargetAllowed(url: string, policy: ProviderNetworkPolicy): Promise<void> {
  const hostname = normalizeHostname(new URL(url).hostname);
  const allowed = new Set((policy.privateHosts ?? []).map(normalizeConfiguredProviderHost));
  if (allowed.has(hostname)) return;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) throw disallowedProviderHost();
  let addresses: readonly { address: string; family: 4 | 6 }[];
  try { addresses = await (policy.resolve ?? resolveProviderHost)(hostname); } catch { throw disallowedProviderHost(); }
  if (addresses.length === 0 || addresses.some(({ address, family }) => nonPublicAddresses.check(address, family === 4 ? "ipv4" : "ipv6"))) throw disallowedProviderHost();
}

async function resolveProviderHost(hostname: string): Promise<readonly { address: string; family: 4 | 6 }[]> {
  const resolved = await lookup(hostname, { all: true, verbatim: true });
  return resolved.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
}

function normalizeConfiguredProviderHost(value: string): string {
  const normalized = normalizeHostname(value.trim());
  if (!normalized || normalized.includes("/") || normalized.includes(":")) throw new Error("AGENTSMITH_LITE_PRIVATE_PROVIDER_HOSTS must contain comma-separated hostnames or IPv4 addresses without ports");
  return normalized;
}

function normalizeHostname(value: string): string { return value.toLowerCase().replace(/\.$/, ""); }
function disallowedProviderHost(): ProductError { return providerError("OpenAI-compatible provider host is not allowed", 502, "network"); }
function createNonPublicAddressList(): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) list.addSubnet(network, prefix, "ipv4");
  for (const [network, prefix] of [["::",128],["::1",128],["fc00::",7],["fe80::",10],["ff00::",8],["2001:db8::",32]] as const) list.addSubnet(network, prefix, "ipv6");
  return list;
}

function providerStatusError(status: number): ProductError {
  if (status === 429) return providerError("OpenAI-compatible provider rate limited the request", 429, "rate_limit");
  if (status === 401 || status === 403) return providerError("OpenAI-compatible provider rejected authentication", 502, "auth");
  return providerError("OpenAI-compatible provider request failed", 502, "upstream");
}

function sanitizeProviderError(error: unknown): ProductError {
  if (error instanceof ProductError) return error;
  if (isAbortError(error)) return providerError("OpenAI-compatible provider request timed out", 504, "timeout");
  return providerError("OpenAI-compatible provider request failed", 502, "network");
}

function modelsUrl(baseUrl: string): string { return `${baseUrl.replace(/\/$/, "")}/models`; }

function providerError(message: string, statusCode: number, providerCategory: EndpointHealthErrorCategory): ProductError {
  return Object.assign(new ProductError(message, statusCode), { providerCategory });
}

function providerErrorCategory(error: unknown): EndpointHealthErrorCategory {
  return error instanceof ProductError && "providerCategory" in error ? (error as ProductError & { providerCategory: EndpointHealthErrorCategory }).providerCategory : "unknown";
}

function modelIds(body: unknown): string[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) return [];
  return normalizeOpenAICompatibleModelIds((body as { data: unknown[] }).data.map((item) => item && typeof item === "object" ? (item as { id?: unknown }).id : undefined));
}

export function normalizeOpenAICompatibleModelIds(values: readonly unknown[]): string[] {
  const ids = new Set<string>();
  for (const id of values) {
    if (typeof id === "string" && id.trim() && id.length <= 256) ids.add(id.trim());
    if (ids.size === 200) break;
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function providerUsage(response: unknown): import("../../contracts/src/api.js").ProviderUsage | undefined {
  if (!response || typeof response !== "object") return undefined;
  const usage = (response as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const tokens = numberValue(record.total_tokens) ?? sum(numberValue(record.prompt_tokens), numberValue(record.completion_tokens));
  const cost = numberValue(record.cost) ?? numberValue(record.total_cost);
  const result: import("../../contracts/src/api.js").ProviderUsage = {};
  if (tokens !== undefined) result.tokens = tokens;
  if (cost !== undefined) result.cost = cost;
  return Object.keys(result).length ? result : undefined;
}
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function sum(left: number | undefined, right: number | undefined): number | undefined { return left !== undefined && right !== undefined ? left + right : undefined; }

export function validateOpenAICompatibleEndpoint(endpoint: Pick<ModelEndpoint, "protocol" | "baseUrl" | "model" | "requestTimeoutSecs">): void {
  if (endpoint.protocol !== "openai_chat_completions") {
    throw new ProductError("Only openai_chat_completions endpoints are supported");
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint.baseUrl);
  } catch {
    throw new ProductError("Endpoint baseUrl must be a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new ProductError("Endpoint baseUrl must use https");
  }
  if (parsed.username || parsed.password) {
    throw new ProductError("Endpoint baseUrl must not contain credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new ProductError("Endpoint baseUrl must not contain query or hash");
  }
  if (!endpoint.model.trim()) {
    throw new ProductError("Endpoint model is required");
  }
  if (!Number.isInteger(endpoint.requestTimeoutSecs) || endpoint.requestTimeoutSecs < 1 || endpoint.requestTimeoutSecs > 600) {
    throw new ProductError("Endpoint requestTimeoutSecs must be between 1 and 600");
  }
}


export function normalizeOpenAICompatibleBaseUrl(baseUrl: string, statusCode = 400): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ProductError("Endpoint baseUrl must be a valid URL", statusCode);
  }
  if (parsed.protocol !== "https:") {
    throw new ProductError("Endpoint baseUrl must use https", statusCode);
  }
  if (parsed.username || parsed.password) {
    throw new ProductError("Endpoint baseUrl must not contain credentials", statusCode);
  }
  if (parsed.search || parsed.hash) {
    throw new ProductError("Endpoint baseUrl must not contain query or hash", statusCode);
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return path ? `${parsed.origin}${path}` : parsed.origin;
}

function chatCompletionsUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${path}/chat/completions`;
  parsed.search = "";
  return parsed.toString();
}

function parseAssistantContent(response: unknown): string {
  if (!response || typeof response !== "object") {
    throw new ProductError("OpenAI-compatible provider response is malformed", 502);
  }
  const choices = (response as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProductError("OpenAI-compatible provider response is missing choices", 502);
  }
  const first = choices[0];
  if (!first || typeof first !== "object") {
    throw new ProductError("OpenAI-compatible provider response is malformed", 502);
  }
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    throw new ProductError("OpenAI-compatible provider response is missing message", 502);
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string") {
    throw new ProductError("OpenAI-compatible provider response is missing assistant content", 502);
  }
  return content;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
