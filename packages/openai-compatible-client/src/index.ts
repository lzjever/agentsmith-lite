import type { ChatMessage, ChatResponse, ModelEndpoint } from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";

export interface CompleteChatOptions {
  apiKey: string;
}

export interface OpenAICompatibleClient {
  completeChat(endpoint: ModelEndpoint, messages: ChatMessage[], options: CompleteChatOptions): Promise<ChatResponse>;
}

export interface ModelCredential {
  apiKey: string;
  baseUrl: string;
}

export interface ModelCredentialResolver {
  resolveCredential(secretRef: string): ModelCredential;
}

export class EnvModelCredentialResolver implements ModelCredentialResolver {
  resolveCredential(secretRef: string): ModelCredential {
    validateApiKeySecretRef(secretRef);
    const slug = secretRef.slice("secret/".length);
    const suffix = slug.toUpperCase().replaceAll("-", "_");
    const apiKey = process.env[`AGENTSMITH_LITE_MODEL_API_KEY_${suffix}`];
    const baseUrl = process.env[`AGENTSMITH_LITE_MODEL_BASE_URL_${suffix}`];
    if (!apiKey) {
      throw new ProductError("Model API key secret is not configured", 500);
    }
    if (!baseUrl) {
      throw new ProductError("Model base URL is not configured", 500);
    }
    return { apiKey, baseUrl: normalizeOpenAICompatibleBaseUrl(baseUrl, 500) };
  }
}

export class FetchOpenAICompatibleClient implements OpenAICompatibleClient {
  async completeChat(endpoint: ModelEndpoint, messages: ChatMessage[], options: CompleteChatOptions): Promise<ChatResponse> {
    const response = await this.fetchChatCompletion(endpoint, messages, options.apiKey);
    const content = parseAssistantContent(response);
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
      }
    };
  }

  private async fetchChatCompletion(endpoint: ModelEndpoint, messages: ChatMessage[], apiKey: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), endpoint.requestTimeoutSecs * 1000);
    try {
      const response = await fetch(chatCompletionsUrl(endpoint.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model: endpoint.model, messages }),
        signal: controller.signal
      });

      if (response.status === 429) {
        throw new ProductError("OpenAI-compatible provider rate limited the request", 429);
      }
      if (!response.ok) {
        throw new ProductError("OpenAI-compatible provider request failed", 502);
      }

      try {
        return await response.json();
      } catch {
        throw new ProductError("OpenAI-compatible provider returned malformed JSON", 502);
      }
    } catch (error) {
      if (error instanceof ProductError) {
        throw error;
      }
      if (isAbortError(error)) {
        throw new ProductError("OpenAI-compatible provider request timed out", 504);
      }
      throw new ProductError("OpenAI-compatible provider request failed", 502);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function validateOpenAICompatibleEndpoint(endpoint: Pick<ModelEndpoint, "protocol" | "baseUrl" | "model" | "apiKeySecretRef" | "requestTimeoutSecs">): void {
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
  validateApiKeySecretRef(endpoint.apiKeySecretRef);
  if (!Number.isInteger(endpoint.requestTimeoutSecs) || endpoint.requestTimeoutSecs < 1 || endpoint.requestTimeoutSecs > 600) {
    throw new ProductError("Endpoint requestTimeoutSecs must be between 1 and 600");
  }
}

export function validateApiKeySecretRef(secretRef: string): void {
  if (!/^secret\/[a-z0-9][a-z0-9-]{0,62}$/.test(secretRef)) {
    throw new ProductError("Endpoint apiKeySecretRef must be secret/<slug>");
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
