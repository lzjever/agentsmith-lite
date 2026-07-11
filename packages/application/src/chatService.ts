import type { ChatMessage, ChatResponse } from "../../contracts/src/api.js";
import { normalizeOpenAICompatibleBaseUrl, type ModelCredentialResolver, type OpenAICompatibleClient } from "../../openai-compatible-client/src/index.js";
import { ProductError } from "../../domain/src/errors.js";
import { EndpointService } from "./endpointService.js";

export class ChatService {
  constructor(
    private readonly endpointService: EndpointService,
    private readonly client: OpenAICompatibleClient,
    private readonly modelCredentialResolver: ModelCredentialResolver
  ) {}

  async sendChat(userId: string, projectId: string, endpointId: string, messages: ChatMessage[]): Promise<ChatResponse> {
    const endpoint = await this.endpointService.requireCredentialEndpointForUser(userId, projectId, endpointId);
    const credential = this.modelCredentialResolver.resolveCredential(endpoint.apiKeySecretRef);
    const endpointBaseUrl = normalizeOpenAICompatibleBaseUrl(endpoint.baseUrl);
    const credentialBaseUrl = normalizeOpenAICompatibleBaseUrl(credential.baseUrl, 500);
    if (endpointBaseUrl !== credentialBaseUrl) {
      throw new ProductError("Endpoint baseUrl does not match the configured credential binding");
    }
    return this.client.completeChat(endpoint, messages, { apiKey: credential.apiKey });
  }
}
