import { sanitizeProjectAuditDetail, type CreateEndpointInput, type DiscoverEndpointModelsInput, type EndpointHealth, type EndpointModelDiscovery, type ModelEndpoint, type ProjectAuditAction, type UpdateEndpointInput } from "../../contracts/src/api.js";
import { NotFoundError, ProductError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { requireNonEmptyString } from "../../domain/src/validation.js";
import { normalizeOpenAICompatibleBaseUrl, validateOpenAICompatibleEndpoint } from "../../openai-compatible-client/src/index.js";
import type { ProductStore } from "../../ports/src/store.js";
import { WorkspaceService } from "./workspaceService.js";
import { recordProjectFailure, recoverProjectAlerts } from "./projectPolicyService.js";
import { CredentialService } from "./credentialService.js";
import { OpenAIProviderBroker } from "./openAIProviderBroker.js";

export class EndpointService {
  constructor(
    private readonly store: ProductStore,
    private readonly workspaces: WorkspaceService,
    private readonly credentials: CredentialService,
    private readonly provider: OpenAIProviderBroker
  ) {}

  async createEndpoint(userId: string, projectId: string, input: CreateEndpointInput): Promise<ModelEndpoint> {
    await this.workspaces.requireProjectForUser(userId, projectId, "admin");
    const timestamp = nowIso();
    const endpoint: ModelEndpoint = {
      id: newId("endp"),
      projectId,
      name: requireNonEmptyString(input.name, "endpoint.name"),
      protocol: input.protocol,
      baseUrl: requireNonEmptyString(input.baseUrl, "endpoint.baseUrl"),
      model: requireNonEmptyString(input.model, "endpoint.model"),
      credentialId: requireNonEmptyString(input.credentialId, "endpoint.credentialId"),
      capabilities: input.capabilities,
      requestTimeoutSecs: input.requestTimeoutSecs,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    let created: ModelEndpoint;
    try {
      validateOpenAICompatibleEndpoint(endpoint);
      await this.requireCredentialBinding(projectId, endpoint.credentialId, endpoint.baseUrl);
      created = await this.store.createEndpoint(await this.validate(endpoint, userId, null));
    } catch (error) {
      const health = endpointValidationHealth(error);
      if (health) await this.endpointFailure(projectId, userId, "endpoint.create", endpoint.id, healthAuditDetail(health), null);
      else await this.audit(projectId, userId, "endpoint.create", endpoint.id, "rejected");
      throw error;
    }
    await this.audit(projectId, userId, "endpoint.create", created.id, "accepted", healthAuditDetail(created.health));
    return created;
  }

  async listEndpoints(userId: string, projectId: string): Promise<ModelEndpoint[]> {
    await this.workspaces.requireProjectForUser(userId, projectId, "view");
    return this.store.listEndpointsForProject(projectId);
  }

  async updateEndpoint(userId: string, projectId: string, endpointId: string, input: UpdateEndpointInput): Promise<ModelEndpoint> {
    await this.workspaces.requireProjectForUser(userId, projectId, "admin");
    const existing = await this.requireEndpointForProject(projectId, endpointId);
    const endpoint: ModelEndpoint = {
      ...existing,
      name: requireNonEmptyString(input.name, "endpoint.name"),
      protocol: input.protocol,
      baseUrl: requireNonEmptyString(input.baseUrl, "endpoint.baseUrl"),
      model: requireNonEmptyString(input.model, "endpoint.model"),
      credentialId: input.credentialId === undefined ? existing.credentialId : requireNonEmptyString(input.credentialId, "endpoint.credentialId"),
      capabilities: input.capabilities,
      requestTimeoutSecs: input.requestTimeoutSecs,
      updatedAt: nowIso()
    };
    let updated: ModelEndpoint;
    try {
      validateOpenAICompatibleEndpoint(endpoint);
      await this.requireCredentialBinding(projectId, endpoint.credentialId, endpoint.baseUrl);
      const stored = await this.store.updateEndpoint(await this.validate(endpoint, userId, endpoint.id));
      if (!stored) throw new NotFoundError("Endpoint not found");
      updated = stored;
    } catch (error) {
      const health = endpointValidationHealth(error);
      if (health) await this.endpointFailure(projectId, userId, "endpoint.update", endpointId, healthAuditDetail(health));
      else await this.audit(projectId, userId, "endpoint.update", endpointId, "rejected");
      throw error;
    }
    await this.audit(projectId, userId, "endpoint.update", endpointId, "accepted", healthAuditDetail(updated.health));
    return updated;
  }

  async deleteEndpoint(userId: string, projectId: string, endpointId: string): Promise<void> {
    await this.workspaces.requireProjectForUser(userId, projectId, "admin");
    await this.requireEndpointForProject(projectId, endpointId);
    const result = await this.store.deleteEndpoint(endpointId);
    if (result === "referenced_by_tasks") {
      throw new ProductError("Endpoint cannot be deleted while tasks reference it", 409);
    }
    if (result === "not_found") {
      throw new NotFoundError("Endpoint not found");
    }
    await this.audit(projectId, userId, "endpoint.delete", endpointId, "accepted");
  }

  async discoverModels(userId: string, projectId: string, input: DiscoverEndpointModelsInput): Promise<EndpointModelDiscovery> {
    await this.workspaces.requireProjectForUser(userId, projectId, "admin");
    let checked: EndpointModelDiscovery;
    let settlementEndpointId: string|null = null;
    try {
      settlementEndpointId = input.endpointId === undefined
        ? null
        : (await this.requireEndpointForProject(projectId, requireNonEmptyString(input.endpointId, "endpoint.id"))).id;
      const probe = this.discoveryProbe(projectId, input);
      validateOpenAICompatibleEndpoint(probe);
      await this.requireCredentialBinding(projectId, probe.credentialId, probe.baseUrl);
      const credential = await this.credentials.resolve(projectId, probe.credentialId);
      const result = await this.provider.discoverModels(
        { endpoint: probe, settlementEndpointId, apiKey: credential.apiKey, actorId: userId },
        { baseUrl: probe.baseUrl, credentialId: probe.credentialId, requestTimeoutSecs: probe.requestTimeoutSecs }
      );
      checked = { ...result, health: this.checkedHealth(result.health) };
    } catch (error) {
      await this.audit(projectId,userId,"endpoint.model_discover",settlementEndpointId,"rejected");
      throw error;
    }
    const detail={modelCount:checked.models.length,...(healthAuditDetail(checked.health)??{})};
    if(checked.health.status==="unavailable")await this.endpointFailure(projectId,userId,"endpoint.model_discover",settlementEndpointId,detail);
    else await this.audit(projectId,userId,"endpoint.model_discover",settlementEndpointId,"accepted",detail);
    return checked;
  }

  async recheckEndpoint(userId: string, projectId: string, endpointId: string): Promise<ModelEndpoint> {
    await this.workspaces.requireProjectForUser(userId, projectId, "admin");
    const existing = await this.requireEndpointForProject(projectId, endpointId);
    const checked = await this.healthFor(existing, userId, existing.id);
    const updated = await this.store.updateEndpoint({ ...existing, health: checked, updatedAt: nowIso() });
    if (!updated) throw new NotFoundError("Endpoint not found");
    if (checked.status === "unavailable") {
      await this.endpointFailure(projectId,userId,"endpoint.health_check",endpointId,healthAuditDetail(checked));
    } else {
      await this.audit(projectId,userId,"endpoint.health_check",endpointId,"accepted",healthAuditDetail(checked));
      await recoverProjectAlerts(this.store, projectId, "endpoint_failure", endpointId);
    }
    return updated;
  }

  private async audit(projectId: string, actorId: string, action: EndpointAuditAction, resourceId: string|null, status: "accepted" | "rejected", detail?:import("../../contracts/src/api.js").ProjectAuditSafeDetail): Promise<void> {
    const safeDetail=sanitizeProjectAuditDetail({...detail,...(resourceId?{endpointId:resourceId}:{})});
    await this.store.appendProjectAuditEvent({ id: newId("audit"), projectId, actorId, action, status, resourceKind: "endpoint", resourceId, detail:safeDetail, createdAt: nowIso() });
  }

  private async endpointFailure(projectId: string, actorId: string, action: EndpointAuditAction, resourceId: string|null, detail?:import("../../contracts/src/api.js").ProjectAuditSafeDetail, evaluationEndpointId: string|null=resourceId): Promise<void> {
    const timestamp=nowIso();
    await recordProjectFailure(this.store,"endpoint_failure",{
      id:newId("audit"),projectId,actorId,action,status:"rejected",resourceKind:"endpoint",resourceId,
      detail:sanitizeProjectAuditDetail({...detail,...(resourceId?{endpointId:resourceId}:{})}),createdAt:timestamp
    },evaluationEndpointId?{endpointId:evaluationEndpointId}:{});
  }

  async requireEndpointForProject(projectId: string, endpointId: string): Promise<ModelEndpoint> {
    const endpoint = await this.store.findEndpoint(endpointId);
    if (!endpoint || endpoint.projectId !== projectId) {
      throw new NotFoundError("Endpoint not found");
    }
    return endpoint;
  }

  async requireCredentialEndpointForUser(userId: string, projectId: string, endpointId: string): Promise<ModelEndpoint> {
    await this.workspaces.requireProjectForUser(userId, projectId, "write");
    const endpoint = await this.requireEndpointForProject(projectId, endpointId);
    return endpoint;
  }

  private async requireCredentialBinding(projectId: string, credentialId: string, baseUrl: string): Promise<void> {
    const credential = await this.store.findProjectCredential(credentialId);
    if (!credential || credential.projectId !== projectId) throw new NotFoundError("Credential not found");
    if (normalizeOpenAICompatibleBaseUrl(baseUrl) !== credential.baseUrl) throw new ProductError("Endpoint baseUrl does not match the credential binding");
  }

  private async validate(endpoint: ModelEndpoint, actorId: string, settlementEndpointId: string | null): Promise<ModelEndpoint> {
    const health = await this.healthFor(endpoint, actorId, settlementEndpointId);
    if (health.status !== "healthy") throw new EndpointValidationError(health);
    return { ...endpoint, health };
  }

  private discoveryProbe(projectId: string, input: DiscoverEndpointModelsInput): ModelEndpoint {
    return { id: "endpoint_probe", projectId, name: "probe", protocol: "openai_chat_completions", baseUrl: requireNonEmptyString(input.baseUrl, "endpoint.baseUrl"), model: "probe", credentialId: requireNonEmptyString(input.credentialId, "endpoint.credentialId"), capabilities: ["text"], requestTimeoutSecs: input.requestTimeoutSecs, createdAt: nowIso(), updatedAt: nowIso() };
  }

  private async healthFor(endpoint: ModelEndpoint, actorId: string | null, settlementEndpointId: string | null): Promise<EndpointHealth> {
    const credential = await this.credentials.resolve(endpoint.projectId, endpoint.credentialId);
    const result = await this.provider.validateEndpoint({ endpoint, settlementEndpointId, apiKey: credential.apiKey, actorId });
    return this.checkedHealth(result.status === "healthy" ? { status: "healthy", checkedAt: null, errorCategory: null } : { status: "unavailable", checkedAt: null, errorCategory: result.errorCategory });
  }

  private checkedHealth(health: EndpointHealth): EndpointHealth {
    return { ...health, checkedAt: nowIso() };
  }
}

type EndpointAuditAction = Extract<ProjectAuditAction, `endpoint.${string}`>;

class EndpointValidationError extends ProductError {
  constructor(readonly health: EndpointHealth) {
    super(`Endpoint validation failed: ${health.errorCategory}`, 422);
  }
}

function endpointValidationHealth(error:unknown):EndpointHealth|undefined{return error instanceof EndpointValidationError?error.health:undefined}

function healthAuditDetail(health: EndpointHealth | undefined): import("../../contracts/src/api.js").ProjectAuditSafeDetail | undefined {
  return health ? { healthStatus: health.status, ...(health.errorCategory ? { errorCategory: health.errorCategory } : {}) } : undefined;
}
