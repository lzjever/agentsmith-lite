import type { ChatMessage, ChatResponse } from "../../contracts/src/api.js";
import type { OpenAICompatibleClient } from "../../openai-compatible-client/src/index.js";
import { EndpointService } from "./endpointService.js";
import { WorkspaceService } from "./workspaceService.js";

export class ChatService {
  constructor(
    private readonly endpointService: EndpointService,
    private readonly workspaces: WorkspaceService,
    private readonly client: OpenAICompatibleClient
  ) {}

  async sendChat(userId: string, projectId: string, endpointId: string, messages: ChatMessage[]): Promise<ChatResponse> {
    await this.workspaces.requireProjectForUser(userId, projectId);
    const endpoint = await this.endpointService.requireEndpointForProject(projectId, endpointId);
    return this.client.completeChat(endpoint, messages);
  }
}

