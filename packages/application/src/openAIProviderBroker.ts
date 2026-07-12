import type { ChatMessage, ChatResponse, DiscoverEndpointModelsInput, EndpointHealthErrorCategory, EndpointModelDiscovery, ModelEndpoint, ProviderUsage } from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";
import type { OpenAICompatibleClient } from "../../openai-compatible-client/src/index.js";
import { ProjectPolicyService } from "./projectPolicyService.js";

interface ProviderCallContext {
  endpoint: ModelEndpoint;
  settlementEndpointId: string | null;
  apiKey: string;
  actorId: string | null;
  taskId?: string | null;
}

interface StreamProviderCallContext extends ProviderCallContext {
  signal?: AbortSignal;
  onDelta: (content: string) => void;
}

export class OpenAIProviderBroker {
  constructor(
    private readonly client: OpenAICompatibleClient,
    private readonly policies: ProjectPolicyService
  ) {}

  async completeChat(context: ProviderCallContext, messages: ChatMessage[]): Promise<ChatResponse> {
    return this.settledCall(context, () => this.client.completeChat(context.endpoint, messages, { apiKey: context.apiKey }), (response) => response.usage);
  }

  async streamChat(context: StreamProviderCallContext, messages: ChatMessage[]): Promise<ChatResponse> {
    return this.settledCall(context, async () => {
      if (!this.client.streamChat) {
        const response = await this.client.completeChat(context.endpoint, messages, { apiKey: context.apiKey });
        context.onDelta(response.message.content);
        return response;
      }
      return this.client.streamChat(context.endpoint, messages, {
        apiKey: context.apiKey,
        ...(context.signal ? { signal: context.signal } : {}),
        onDelta: context.onDelta
      });
    }, (response) => response.usage);
  }

  async validateEndpoint(context: ProviderCallContext): Promise<Awaited<ReturnType<NonNullable<OpenAICompatibleClient["validateEndpoint"]>>>> {
    if (!this.client.validateEndpoint) throw new ProductError("Endpoint health checks are unavailable", 503);
    return this.settledCall(context, () => this.client.validateEndpoint!(context.endpoint, context.apiKey), () => ({ tokens: 0, cost: 0 }), { tokens: 0, cost: 0 });
  }

  async discoverModels(context: ProviderCallContext, input: DiscoverEndpointModelsInput): Promise<EndpointModelDiscovery> {
    if (!this.client.discoverModels) throw new ProductError("Endpoint model discovery is unavailable", 503);
    return this.settledCall(context, () => this.client.discoverModels!(input, context.apiKey), () => ({ tokens: 0, cost: 0 }), { tokens: 0, cost: 0 });
  }

  async forwardChatCompletion<T>(
    context: ProviderCallContext,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    consume: (response: Response) => Promise<{ value: T; usage?: ProviderUsage }>
  ): Promise<T> {
    if (!this.client.rawChatCompletion) throw new ProductError("OpenAI-compatible provider transport is unavailable", 503);
    return this.settledCall(context, async () => {
      const response = await this.client.rawChatCompletion!(context.endpoint, { apiKey: context.apiKey, body, headers });
      return consume(response);
    }, (result) => result.usage).then((result) => result.value);
  }

  private async settledCall<T>(context: ProviderCallContext, call: () => Promise<T>, usage: (result: T) => ProviderUsage | undefined = () => undefined, reservation?: { tokens: number; cost: number }): Promise<T> {
    const settlementId = await this.policies.reserveProvider(context.endpoint.projectId, context.actorId, context.settlementEndpointId, context.taskId ?? null, reservation);
    try {
      await this.policies.markProviderDispatched(settlementId);
    } catch (error) {
      await this.policies.failProvider(settlementId);
      throw error;
    }

    let result: T;
    try {
      result = await call();
    } catch (error) {
      await this.policies.failProvider(settlementId);
      await this.policies.recordProviderFailure(context.endpoint.projectId, context.actorId, context.settlementEndpointId, providerFailureCategory(error));
      if (error instanceof ProductError || isAbortError(error)) throw error;
      throw new ProductError("OpenAI-compatible provider request failed", 502);
    }

    try {
      await this.policies.markProviderDelivered(settlementId);
      const measured = usage(result);
      if (measured) await this.policies.settleProvider(settlementId, measured);
      else await this.policies.markProviderUnknown(settlementId);
    } catch (error) {
      await this.policies.markProviderUnknown(settlementId);
      throw error;
    }
    return result;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function providerFailureCategory(error:unknown):EndpointHealthErrorCategory{
  const category=error&&typeof error==="object"?(error as {providerCategory?:unknown}).providerCategory:undefined;
  return category==="auth"||category==="network"||category==="upstream"||category==="timeout"||category==="rate_limit"||category==="unknown"?category:"unknown";
}
