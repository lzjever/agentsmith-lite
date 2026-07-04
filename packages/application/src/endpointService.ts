import type { CreateEndpointInput, ModelEndpoint } from "../../contracts/src/api.js";
import { NotFoundError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { requireNonEmptyString } from "../../domain/src/validation.js";
import { validateOpenAICompatibleEndpoint } from "../../openai-compatible-client/src/index.js";
import type { ProductStore } from "../../ports/src/store.js";
import { WorkspaceService } from "./workspaceService.js";

export class EndpointService {
  constructor(
    private readonly store: ProductStore,
    private readonly workspaces: WorkspaceService
  ) {}

  async createEndpoint(userId: string, projectId: string, input: CreateEndpointInput): Promise<ModelEndpoint> {
    await this.workspaces.requireProjectForUser(userId, projectId);
    const timestamp = nowIso();
    const endpoint: ModelEndpoint = {
      id: newId("endp"),
      projectId,
      name: requireNonEmptyString(input.name, "endpoint.name"),
      protocol: input.protocol,
      baseUrl: requireNonEmptyString(input.baseUrl, "endpoint.baseUrl"),
      model: requireNonEmptyString(input.model, "endpoint.model"),
      apiKeySecretRef: requireNonEmptyString(input.apiKeySecretRef, "endpoint.apiKeySecretRef"),
      capabilities: input.capabilities,
      requestTimeoutSecs: input.requestTimeoutSecs,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    validateOpenAICompatibleEndpoint(endpoint);
    return this.store.createEndpoint(endpoint);
  }

  async listEndpoints(userId: string, projectId: string): Promise<ModelEndpoint[]> {
    await this.workspaces.requireProjectForUser(userId, projectId);
    return this.store.listEndpointsForProject(projectId);
  }

  async requireEndpointForProject(projectId: string, endpointId: string): Promise<ModelEndpoint> {
    const endpoint = await this.store.findEndpoint(endpointId);
    if (!endpoint || endpoint.projectId !== projectId) {
      throw new NotFoundError("Endpoint not found");
    }
    return endpoint;
  }
}

