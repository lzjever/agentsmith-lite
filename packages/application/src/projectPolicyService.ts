import { sanitizeProjectAuditDetail, type EndpointHealthErrorCategory, type ProjectAlert, type ProjectAlertType, type ProjectAuditAction, type ProjectAuditEvent, type ProjectAuditResourceKind, type ProjectResourcePolicy, type ProjectResourceUsage, type ProjectUsageEndpoint, type ProjectUsageLimit, type ProjectUsageOverview, type ProviderUsage, type UpdateProjectResourcePolicyInput } from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import type { ProductStore } from "../../ports/src/store.js";
import { AuthorizationService } from "./authorizationService.js";
import { matchesAlertRule, measureAlertRule } from "./alertRuleService.js";

type Limit = ProjectAlertType;
const zeroUsage = (projectId: string): ProjectResourceUsage => ({ projectId, activeTasks: 0, providerRequests: 0, providerTokens: 0, providerCost: 0, projectFileBytes: 0, updatedAt: nowIso() });
const providerReservationBudget = { tokens: 4096, cost: 1 } as const;

export class ProjectPolicyService {
  constructor(private readonly store: ProductStore, private readonly authorization: AuthorizationService) {}

  async getPolicy(userId: string, projectId: string): Promise<ProjectResourcePolicy> { await this.authorization.requireProject(userId, projectId); return this.requirePolicy(projectId); }
  async getUsageOverview(userId: string, projectId: string, endpointId?: string): Promise<ProjectUsageOverview> {
    await this.authorization.requireProject(userId, projectId);
    const [project, policy, usage, endpoints] = await Promise.all([this.store.findProject(projectId), this.requirePolicy(projectId), this.usage(projectId), this.store.listEndpointsForProject(projectId)]);
    if (!project) throw new ProductError("Project not found", 404);
    if (endpointId !== undefined && !endpoints.some((endpoint) => endpoint.id === endpointId)) throw new ProductError("Endpoint not found", 404);
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const firstDay = new Date(today); firstDay.setUTCDate(firstDay.getUTCDate() - 29);
    const since = firstDay.toISOString();
    const allSettlements = await this.store.listSettledProjectProviderSettlements(projectId, since);
    const selectedSettlements = endpointId === undefined ? allSettlements : allSettlements.filter((settlement) => settlement.endpointId === endpointId);
    const daily = Array.from({ length: 30 }, (_, index) => { const date = new Date(firstDay); date.setUTCDate(firstDay.getUTCDate() + index); return { date: date.toISOString().slice(0, 10), requests: 0, tokens: 0, cost: 0 }; });
    const dailyByDate = new Map(daily.map((day) => [day.date, day]));
    for (const settlement of selectedSettlements) {
      const day = dailyByDate.get(settlement.settledAt!.slice(0, 10));
      if (!day) continue;
      day.requests += 1; day.tokens += settlement.usage?.tokens ?? 0; day.cost += settlement.usage?.cost ?? 0;
    }
    const endpointUsage = new Map<string, ProjectUsageEndpoint>(endpoints.map((endpoint) => [endpoint.id, { endpointId: endpoint.id, endpointName: endpoint.name, requests: 0, tokens: 0, cost: 0, limits: [] }]));
    for (const settlement of allSettlements) {
      if (settlement.endpointId === null) continue;
      const endpoint = endpointUsage.get(settlement.endpointId);
      if (!endpoint) continue;
      endpoint.requests += 1; endpoint.tokens += settlement.usage?.tokens ?? 0; endpoint.cost += settlement.usage?.cost ?? 0;
    }
    for(const endpoint of endpointUsage.values()){const windows=(policy.endpointWindows??[]).filter(item=>item.endpointId===endpoint.endpointId);endpoint.limits=windows.map(window=>{const cutoff=Date.now()-window.windowSeconds*1000;const windowSettlements=allSettlements.filter(item=>item.endpointId===endpoint.endpointId&&Date.parse(item.settledAt!)>=cutoff);const current=windowSettlements.reduce((sum,item)=>sum+(window.metric==="providerRequests"?1:window.metric==="providerTokens"?(item.usage?.tokens??0):(item.usage?.cost??0)),0);const oldest=windowSettlements[0]?.settledAt;const resetAt=new Date(oldest?Date.parse(oldest)+window.windowSeconds*1000:Date.now()+window.windowSeconds*1000).toISOString();return{metric:window.metric,current,limit:window.limit,remaining:Math.max(0,window.limit-current),window:{kind:"rolling",windowSeconds:window.windowSeconds,startedAt:new Date(cutoff).toISOString(),resetAt}}})}
    const trendTotals = daily.reduce((total, day) => ({ requests: total.requests + day.requests, tokens: total.tokens + day.tokens, cost: total.cost + day.cost }), { requests: 0, tokens: 0, cost: 0 });
    const mine=selectedSettlements.filter(item=>item.actorId===userId).reduce((sum,item)=>({requests:sum.requests+1,tokens:sum.tokens+(item.usage?.tokens??0),cost:sum.cost+(item.usage?.cost??0)}),{requests:0,tokens:0,cost:0});
    return { projectId, usage, limits: usageLimits(policy, usage, project.createdAt), daily, trendTotals, endpoints: [...endpointUsage.values()], selectedEndpointId: endpointId ?? null,currentUser:{userId,...mine} };
  }
  async alerts(userId: string, projectId: string) {
    await this.authorization.requireProject(userId, projectId);
    const activeTypes = new Set((await this.store.listActiveProjectAlerts(projectId)).map((alert) => alert.type));
    for (const type of activeTypes) await recoverProjectAlerts(this.store, projectId, type, undefined, true);
    return this.store.listProjectAlerts(projectId);
  }
  async transitionAlert(userId: string, projectId: string, alertId: string, status: "resolved" | "dismissed") {
    const action: ProjectAuditAction = status === "resolved" ? "alert.resolve" : "alert.dismiss";
    let alert: ProjectAlert;
    try {
      await this.authorization.requireProject(userId, projectId, "admin");
      const transitioned = await this.store.transitionProjectAlert(projectId, alertId, status, nowIso());
      if (!transitioned) throw new ProductError("Active project alert not found", 404);
      alert = transitioned;
    } catch (error) {
      await this.auditEvent(projectId, userId, action, "rejected", alertId, "alert");
      throw error;
    }
    await this.auditEvent(projectId, userId, action, "accepted", alert.id, "alert");
    return alert;
  }
  async audit(userId:string,projectId:string):Promise<import("../../contracts/src/api.js").ProjectAuditEventView[]>;
  async audit(userId:string,projectId:string,query:import("../../contracts/src/api.js").ProjectAuditQuery):Promise<import("../../contracts/src/api.js").ProjectAuditPage>;
  async audit(userId: string, projectId: string, query?: import("../../contracts/src/api.js").ProjectAuditQuery):Promise<import("../../contracts/src/api.js").ProjectAuditEventView[]|import("../../contracts/src/api.js").ProjectAuditPage> {
    await this.authorization.requireProject(userId, projectId);
    const [events, members] = await Promise.all([
      this.store.queryProjectAuditEvents(projectId, query??{limit:100}),
      this.store.listProjectMemberships(projectId)
    ]);
    const actors = new Map(members.map((member) => [member.userId, member]));
    const items=events.items.map((event) => {
      const actor = event.actorId ? actors.get(event.actorId) : undefined;
      return { ...event,detail:safeAuditDetail(event.detail), actorDisplayName: actor?.displayName ?? null, actorEmail: actor?.email ?? null };
    });return query===undefined?items:{nextCursor:events.nextCursor,items};
  }
  async updatePolicy(userId: string, projectId: string, input: UpdateProjectResourcePolicyInput): Promise<ProjectResourcePolicy> {
    let result: ProjectResourcePolicy;
    try {
      await this.authorization.requireProject(userId, projectId, "admin");
      const updated = validatePolicyInput(input);
      if(updated.endpointWindows){const endpoints=await this.store.listEndpointsForProject(projectId);const endpointIds=new Set(endpoints.map(endpoint=>endpoint.id));if(updated.endpointWindows.some(window=>!endpointIds.has(window.endpointId)))throw new ProductError("Endpoint policy window endpoint not found",404)}
      if (Object.keys(updated).length === 0) throw new ProductError("Project policy update requires at least one limit");
      const patched = await this.store.patchProjectResourcePolicy(projectId, updated, nowIso()); if (!patched) throw new ProductError("Project policy not found", 404);
      result = patched;
    } catch (error) {
      await this.auditEvent(projectId, userId, "policy.update", "rejected", projectId);
      throw error;
    }
    await this.auditEvent(projectId, userId, "policy.update", "accepted", projectId);
    return result;
  }
  async reserveTask(projectId: string, actorId: string, taskId: string): Promise<void> { await this.change(projectId, actorId, "task.create", taskId, { activeTasks: 1 }, "active_tasks_limit"); }
  async recordTaskReservationRejected(projectId: string, actorId: string, taskId: string): Promise<void> {
    await this.openAlert(projectId, "active_tasks_limit");
    await this.auditEvent(projectId, actorId, "task.create", "rejected", taskId);
  }
  async recordOperation(projectId: string, actorId: string | null, action: ProjectAuditAction, status: "accepted" | "rejected", resourceId: string | null, resourceKind = auditResourceKind(action), detail?: import("../../contracts/src/api.js").ProjectAuditSafeDetail): Promise<void> {
    await this.auditEvent(projectId, actorId, action, status, resourceId, resourceKind, detail);
  }
  async raiseAlert(projectId: string, type: ProjectAlertType): Promise<void> { await this.openAlert(projectId, type); }
  async evaluateTaskFailure(projectId:string,endpointId:string):Promise<void>{await evaluateProjectAlert(this.store,projectId,"task_failure",{endpointId});}
  async recordProviderFailure(projectId:string,actorId:string|null,endpointId:string|null,errorCategory:EndpointHealthErrorCategory):Promise<void>{
    const timestamp=nowIso();
    await recordProjectFailure(this.store,"provider_failure",{
      id:newId("audit"),projectId,actorId,action:"provider.request",status:"rejected",resourceKind:"provider",resourceId:endpointId,
      detail:{...(endpointId?{endpointId}:{}),errorCategory},createdAt:timestamp
    },endpointId?{endpointId}:{});
  }
  async releaseTask(projectId: string, taskId: string): Promise<void> { await this.change(projectId, null, "task.cleaned", taskId, { activeTasks: -1 }, undefined);await recoverProjectAlerts(this.store,projectId,"active_tasks_limit"); }
  async reserveProvider(projectId: string, actorId: string | null, endpointId: string | null, taskId: string | null = null, reservation: Readonly<{ tokens: number; cost: number }> = providerReservationBudget): Promise<string> {
    const reservedAt = nowIso();
    const policy = await this.requirePolicy(projectId);
    const reserved = await this.store.reserveProjectProviderSettlement({ id: newId("providersettle"), projectId, taskId, endpointId,actorId,reservedTokens:reservation.tokens,reservedCost:reservation.cost, reservedAt, expiresAt: new Date(Date.parse(reservedAt) + 5 * 60_000).toISOString() });
    if (reserved) {
      await this.auditEvent(projectId, actorId, "provider.request", "accepted", endpointId);
      return reserved.id;
    }
    const usage = await this.usage(projectId);
    const limits = providerReservationLimits(policy, usage, reservation);
    const alertTypes: ProjectAlertType[] = limits.length ? limits : ["provider_requests_limit"];
    await Promise.all(alertTypes.map((limit) => this.openAlert(projectId, limit)));
    await this.auditEvent(projectId, actorId, "provider.request", "rejected", endpointId);
    throw new ProductError(`Project ${(limits[0] ?? "provider_requests_limit").replaceAll("_", " ")} reached`, 409);
  }
  async markProviderDispatched(id: string): Promise<void> { if (!await this.store.markProjectProviderSettlementDispatched(id, nowIso())) throw new ProductError("Provider settlement not found", 409); }
  async markProviderDelivered(id: string): Promise<void> { if (!await this.store.markProjectProviderSettlementDelivered(id, nowIso())) throw new ProductError("Provider settlement not found", 409); }
  async settleProvider(id: string, providerUsage?: ProviderUsage): Promise<void> {
    const settled = await this.store.settleProjectProviderSettlement(id, providerUsage, nowIso());
    if (!settled) throw new ProductError("Project policy usage not found", 409);
    const limits: Array<Extract<Limit, "provider_tokens_limit" | "provider_cost_limit">> = ["provider_tokens_limit", "provider_cost_limit"];
    await Promise.all(limits.map((limit) => settled.exceededLimits.includes(limit)
      ? this.openAlert(settled.usage.projectId, limit)
      : recoverProjectAlerts(this.store, settled.usage.projectId, limit)));
  }
  async markProviderUnknown(id: string): Promise<void> { await this.store.markProjectProviderSettlementUnknown(id, nowIso()); }
  async failProvider(id: string): Promise<void> { await this.store.failProjectProviderSettlement(id, nowIso()); }
  async expireProviderReservations(): Promise<void> { await this.store.expireReservedProjectProviderSettlements(nowIso()); await this.store.pruneProjectProviderSettlements(new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(), 100); }
  async authorizeFileBytes(projectId: string, actorId: string | null, _resourceId: string, delta: number): Promise<void> { if (delta > 0) await this.check(projectId, actorId, "file.quota", null, { projectFileBytes: delta }, "project_file_bytes_limit"); }
  async recordFileBytes(projectId: string, actorId: string | null, resourceId: string, delta: number): Promise<void> {
    const adjusted = await this.store.adjustProjectResourceUsage({
      projectId,
      delta: { activeTasks: 0, providerRequests: 0, providerTokens: 0, providerCost: 0, projectFileBytes: delta },
      ...(delta > 0 ? { limit: "project_file_bytes_limit" as const } : {}),
      updatedAt: nowIso()
    });
    if (adjusted) {if(delta<0)await recoverProjectAlerts(this.store,projectId,"project_file_bytes_limit");return;}
    if (delta > 0) {
      await this.requirePolicy(projectId);
      await this.openAlert(projectId, "project_file_bytes_limit");
      await this.auditEvent(projectId, actorId, "file.quota", "rejected", null, "file_quota");
      throw new ProductError("Project project file bytes limit reached", 409);
    }
    throw new ProductError("Project policy usage not found", 409);
  }
  private async requirePolicy(projectId: string) { const policy = await this.store.findProjectResourcePolicy(projectId); if (!policy) throw new ProductError("Project policy not found", 409); return policy; }
  private async usage(projectId: string) { return (await this.store.findProjectResourceUsage(projectId)) ?? zeroUsage(projectId); }
  private async check(projectId: string, actorId: string | null, action: ProjectAuditAction, resourceId: string | null, delta: Partial<ProjectResourceUsage>, limit: Limit) {
    const [policy, usage] = await Promise.all([this.requirePolicy(projectId), this.usage(projectId)]);
    const key = limit === "active_tasks_limit" ? "activeTasks" : limit === "provider_requests_limit" ? "providerRequests" : limit === "provider_tokens_limit" ? "providerTokens" : limit === "provider_cost_limit" ? "providerCost" : "projectFileBytes";
    const policyKey = `${key}Limit` as keyof ProjectResourcePolicy; const maximum = policy[policyKey]; const proposed = usage[key] + (delta[key] ?? 0);
    if (typeof maximum === "number" && proposed > maximum) { await this.openAlert(projectId, limit); await this.auditEvent(projectId, actorId, action, "rejected", resourceId); throw new ProductError(`Project ${limit.replaceAll("_", " ")} reached`, 409); }
  }
  private async change(projectId: string, actorId: string | null, action: ProjectAuditAction, resourceId: string, delta: Partial<ProjectResourceUsage>, limit: Limit | undefined) {
    const adjusted = await this.store.adjustProjectResourceUsage({
      projectId,
      delta: { activeTasks: delta.activeTasks ?? 0, providerRequests: delta.providerRequests ?? 0, providerTokens: delta.providerTokens ?? 0, providerCost: delta.providerCost ?? 0, projectFileBytes: delta.projectFileBytes ?? 0 },
      ...(limit ? { limit } : {}),
      updatedAt: nowIso()
    });
    if (!adjusted) {
      if (limit) {
        await this.requirePolicy(projectId);
        await this.openAlert(projectId, limit);
        await this.auditEvent(projectId, actorId, action, "rejected", resourceId);
        throw new ProductError(`Project ${limit.replaceAll("_", " ")} reached`, 409);
      }
      throw new ProductError("Project policy usage not found", 409);
    }
    await this.auditEvent(projectId, actorId, action, "accepted", resourceId);
  }
  private async openAlert(projectId: string, type: Limit) { await emitProjectAlert(this.store, projectId, type); }
  private async auditEvent(projectId: string, actorId: string | null, action: ProjectAuditAction, status: "accepted" | "rejected", resourceId: string | null, resourceKind = auditResourceKind(action), detail?: import("../../contracts/src/api.js").ProjectAuditSafeDetail) { await this.store.appendProjectAuditEvent({ id: newId("audit"), projectId, actorId, action, status, resourceKind, resourceId, ...(detail ? { detail: safeAuditDetail(detail) } : {}), createdAt: nowIso() }); }
}

type AlertEvaluationContext={endpointId?:string};
type FailureAlertType=Extract<ProjectAlertType,"endpoint_failure"|"provider_failure"|"sandbox_failure">;

export async function recordProjectFailure(store:ProductStore,type:FailureAlertType,event:ProjectAuditEvent,context:AlertEvaluationContext={}):Promise<void>{
  await store.appendProjectAuditEvent({...event,detail:safeAuditDetail(event.detail)});
  await evaluateProjectAlert(store,event.projectId,type,context);
}
export async function emitProjectAlert(store: ProductStore, projectId: string, type: ProjectAlertType, context: AlertEvaluationContext = {}): Promise<void> {
  await evaluateProjectAlert(store,projectId,type,context);
}
async function evaluateProjectAlert(store: ProductStore, projectId: string, type: ProjectAlertType, context: AlertEvaluationContext = {}): Promise<void> {
  const timestamp = nowIso();
  const [rules, members, project] = await Promise.all([store.listProjectAlertRules(projectId), store.listProjectMemberships(projectId), store.findProject(projectId)]);
  const configured=rules.filter(rule=>rule.enabled&&rule.alertType===type&&(rule.scope?.kind!=="endpoint"||rule.scope.endpointId===context.endpointId));
  await recoverProjectAlerts(store,projectId,type,context.endpointId,true);
  if(!configured.length){if(type==="task_failure")return;if(isFailureAlertType(type)&&await store.measureProjectAlertRule({projectId,alertType:type,metric:"failure_count",windowSeconds:3600,endpointId:context.endpointId??null,now:timestamp})<1)return;await store.upsertActiveProjectAlert({id:newId("alert"),projectId,type,status:"active",deliveryStatus:"not_configured",ruleId:null,metric:null,metricValue:null,threshold:null,endpointId:context.endpointId??null,acknowledgedAt:null,acknowledgedBy:null,silencedUntil:null,createdAt:timestamp,updatedAt:timestamp,resolvedAt:null,dismissedAt:null});return}
  const active=await store.listActiveProjectAlerts(projectId);
  for(const rule of configured){const value=await measureAlertRule(store,rule,timestamp);if(!matchesAlertRule(rule,value)){const current=active.find(alert=>alert.ruleId===rule.id&&(alert.endpointId??null)===(rule.scope?.kind==="endpoint"?rule.scope.endpointId:null));if(current)await resolveAlert(store,current,timestamp);continue}const alert=await store.upsertActiveProjectAlert({id:newId("alert"),projectId,type,status:"active",deliveryStatus:"pending",ruleId:rule.id,metric:rule.metric??null,metricValue:value,threshold:rule.threshold??null,endpointId:rule.scope?.kind==="endpoint"?rule.scope.endpointId:null,acknowledgedAt:null,acknowledgedBy:null,silencedUntil:null,createdAt:timestamp,updatedAt:timestamp,resolvedAt:null,dismissedAt:null});if(alert.deliveryStatus!=="pending"||(alert.silencedUntil!==null&&alert.silencedUntil!==undefined&&alert.silencedUntil>timestamp))continue;
    const title = `Project alert: ${alertLabel(type)}`;
    const body = project ? `${project.name}: ${alertLabel(type)}.` : `A project reported ${alertLabel(type)}.`;
    const linkPath = project ? `/workspaces/${project.workspaceId}/projects/${project.id}/alerts` : null;
    const deliveries = await Promise.allSettled(members.filter((member) => member.role === "owner" || member.role === "admin").map((member) => store.createUserNotification({ id: newId("notice"), userId: member.userId, type: "project_alert", title, body, projectId, resourceKind: "project", resourceId: projectId, linkPath, readAt: null, createdAt: timestamp }, `project-alert:${alert.id}:${member.userId}`)));
    await store.updateProjectAlertDeliveryStatus(projectId, alert.id, deliveries.length > 0 && deliveries.some((delivery) => delivery.status === "fulfilled") ? "delivered" : "failed", timestamp);
  }
}
export async function recoverProjectAlerts(store:ProductStore,projectId:string,type:ProjectAlertType,endpointId?:string,configuredOnly=false):Promise<void>{
  const timestamp=nowIso();
  const rules=new Map((await store.listProjectAlertRules(projectId)).map((rule)=>[rule.id,rule]));
  for(const alert of await store.listActiveProjectAlerts(projectId)){
    if(alert.type!==type||(endpointId!==undefined&&alert.endpointId!==null&&alert.endpointId!==endpointId))continue;
    const rule=alert.ruleId?rules.get(alert.ruleId):undefined;
    if(configuredOnly&&!rule)continue;
    if(rule&&rule.enabled&&matchesAlertRule(rule,await measureAlertRule(store,rule,timestamp)))continue;
    await resolveAlert(store,alert,timestamp);
  }
}
async function resolveAlert(store:ProductStore,alert:ProjectAlert,timestamp:string){const resolved=await store.transitionProjectAlert(alert.projectId,alert.id,"resolved",timestamp);if(resolved)await store.appendProjectAuditEvent({id:newId("audit"),projectId:alert.projectId,actorId:null,action:"alert.resolve",status:"accepted",resourceKind:"alert",resourceId:alert.id,detail:{alertId:alert.id},createdAt:timestamp})}

function alertLabel(type: ProjectAlertType): string { return type.replaceAll("_", " "); }
function isFailureAlertType(type:ProjectAlertType):type is FailureAlertType{return type==="endpoint_failure"||type==="provider_failure"||type==="sandbox_failure"}
function usageLimits(policy: ProjectResourcePolicy, usage: ProjectResourceUsage, projectCreatedAt: string): ProjectUsageLimit[] {
  return [
    usageLimit("activeTasks", usage.activeTasks, policy.activeTasksLimit, projectCreatedAt),
    usageLimit("providerRequests", usage.providerRequests, policy.providerRequestsLimit, projectCreatedAt),
    usageLimit("providerTokens", usage.providerTokens, policy.providerTokensLimit, projectCreatedAt),
    usageLimit("providerCost", usage.providerCost, policy.providerCostLimit, projectCreatedAt),
    usageLimit("projectFileBytes", usage.projectFileBytes, policy.projectFileBytesLimit, projectCreatedAt)
  ];
}
function usageLimit(metric: ProjectUsageLimit["metric"], current: number, limit: number | null, projectCreatedAt: string): ProjectUsageLimit {
  const window = metric === "activeTasks" || metric === "projectFileBytes"
    ? { kind: "current_gauge", resetAt: null } as const
    : { kind: "project_lifetime", startedAt: projectCreatedAt, resetAt: null } as const;
  return { metric, current, limit, remaining: limit === null ? null : Math.max(0, limit - current), window };
}
function providerReservationLimits(policy:ProjectResourcePolicy,usage:ProjectResourceUsage,reservation:Readonly<{tokens:number;cost:number}>):Limit[]{
  return [
    policy.providerRequestsLimit!==null&&usage.providerRequests+1>policy.providerRequestsLimit?"provider_requests_limit":null,
    policy.providerTokensLimit!==null&&usage.providerTokens+reservation.tokens>policy.providerTokensLimit?"provider_tokens_limit":null,
    policy.providerCostLimit!==null&&usage.providerCost+reservation.cost>policy.providerCostLimit?"provider_cost_limit":null
  ].filter((limit):limit is Limit=>limit!==null);
}
function auditResourceKind(action: ProjectAuditAction): ProjectAuditResourceKind { return action.startsWith("credential.") ? "credential" : action.startsWith("endpoint.") ? "endpoint" : action.startsWith("membership.") ? "member" : action.startsWith("alert.") ? "alert" : action === "provider.request" ? "provider" : action.startsWith("task.") ? "task" : action === "artifact.project" ? "artifact" : action === "sandbox.failed" ? "sandbox" : action === "file.quota" ? "file_quota" : action.startsWith("file.") ? "file" : "project"; }
function validatePolicyInput(input: UpdateProjectResourcePolicyInput): UpdateProjectResourcePolicyInput {
  if(input.endpointWindows){const seen=new Set<string>();for(const window of input.endpointWindows){const key=`${window.endpointId}:${window.metric}`;if(seen.has(key))throw new ProductError("Endpoint policy windows must be unique");seen.add(key);if(!window.endpointId||!["providerRequests","providerTokens","providerCost"].includes(window.metric)||!Number.isFinite(window.limit)||window.limit<0||!Number.isInteger(window.windowSeconds)||window.windowSeconds<60||window.windowSeconds>2592000)throw new ProductError("Endpoint policy window is invalid")}}
  for (const [key, value] of Object.entries(input)) {
    if(key==="endpointWindows")continue;
    if (value === null) continue;
    if (!Number.isFinite(value) || value < 0 || (key !== "providerCostLimit" && !Number.isInteger(value))) {
      throw new ProductError("Project policy limits must be non-negative values; count limits must be integers");
    }
  }
  return input;
}
function safeAuditDetail(detail:import("../../contracts/src/api.js").ProjectAuditSafeDetail|undefined){return sanitizeProjectAuditDetail(detail)}
