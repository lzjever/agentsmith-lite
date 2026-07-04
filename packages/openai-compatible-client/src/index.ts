import type { ChatMessage, ChatResponse, ModelEndpoint } from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";

export interface OpenAICompatibleClient {
  completeChat(endpoint: ModelEndpoint, messages: ChatMessage[]): Promise<ChatResponse>;
}

export class MockOpenAICompatibleClient implements OpenAICompatibleClient {
  async completeChat(endpoint: ModelEndpoint, messages: ChatMessage[]): Promise<ChatResponse> {
    validateOpenAICompatibleEndpoint(endpoint);
    const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
    return {
      message: {
        role: "assistant",
        content: `Mock OpenAI-compatible response from ${endpoint.model}: ${lastUserMessage?.content ?? ""}`
      },
      endpointSnapshot: {
        id: endpoint.id,
        baseUrl: endpoint.baseUrl,
        model: endpoint.model,
        protocol: endpoint.protocol
      }
    };
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
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ProductError("Endpoint baseUrl must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new ProductError("Endpoint baseUrl must not contain credentials");
  }
  if (!endpoint.model.trim()) {
    throw new ProductError("Endpoint model is required");
  }
  if (!endpoint.apiKeySecretRef.trim() || endpoint.apiKeySecretRef.startsWith("sk-")) {
    throw new ProductError("Endpoint apiKeySecretRef must reference a stored secret, not a raw key");
  }
  if (!Number.isInteger(endpoint.requestTimeoutSecs) || endpoint.requestTimeoutSecs < 1 || endpoint.requestTimeoutSecs > 600) {
    throw new ProductError("Endpoint requestTimeoutSecs must be between 1 and 600");
  }
}

