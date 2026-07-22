import { sanitizeProjectAuditDetail, type EndpointHealthErrorCategory, type ProjectAlert, type ProjectAlertType, type ProjectAuditAction, type ProjectAuditResourceKind, type ProjectResourcePolicy, type ProjectResourceUsage, type ProjectUsageEndpoint, type ProjectUsageLimit, type ProjectUsageOverview, type ProviderUsage, type UpdateProjectResourcePolicyInput, type UpdateProjectResourcePolicyRequest } from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { formatDecimal } from "../../domain/src/kubernetesQuantity.js";
import type { PersistedAgentTask, PersistedSandboxRunState, ProductStore, SandboxUsageSettlement } from "../../ports/src/store.js";
import { AuthorizationService } from "./authorizationService.js";
import { runIdempotentMutation } from "./idempotentMutation.js";
import { emitProjectAlert, evaluateProjectAlertRules, recordProjectFailure, recoverProjectAlerts } from "./projectAlertEvaluator.js";

type Limit = ProjectAlertType;
const zeroUsage = (projectId: string): ProjectResourceUsage => ({ projectId, activeTasks: 0, providerRequests: 0, providerTokens: 0, providerCost: 0, projectFileBytes: 0, updatedAt: nowIso() });
export const DEFAULT_PROVIDER_RESERVATION = { tokens: 4096, cost: 1 } as const;
function ownedRunMatchesTask(run:PersistedSandboxRunState,task:PersistedAgentTask):boolean{return run.runId===task.runId&&run.taskId===task.id&&run.projectId===task.projectId&&run.workspaceId===task.workspaceId&&run.fileLibraryId===task.fileLibraryId&&run.startedByUserId===(task.createdByUserId??null)}
function ownedSettlementMatchesTask(value:SandboxUsageSettlement,task:PersistedAgentTask):boolean{return value.runId===task.runId&&value.taskId===task.id&&value.projectId===task.projectId&&value.workspaceId===task.workspaceId&&value.fileLibraryId===task.fileLibraryId&&value.startedByUserId===(task.createdByUserId??null)}

export class ProjectPolicyService {
  constructor(private readonly store: ProductStore, private readonly authorization: AuthorizationService) {}

  async getPolicy(userId: string, projectId: string): Promise<ProjectResourcePolicy> { await this.authorization.requireProject(userId, projectId); return this.requirePolicy(projectId); }
  async getUsageOverview(userId: string, projectId: string, endpointId?: string, selectedUserId = userId): Promise<ProjectUsageOverview> {
    const access=await this.authorization.projectAccess(userId,projectId);
    if(selectedUserId!==userId&&!access.canAdmin)throw new ProductError("Project admin permission is required to view another member's sandbox usage",403);
    if(!await this.store.findProjectMembership(projectId,selectedUserId))throw new ProductError("Project member not found",404);
    const [project, policy, usage, endpoints] = await Promise.all([this.store.findProject(projectId), this.requirePolicy(projectId), this.usage(projectId), this.store.listEndpointsForProject(projectId)]);
    if (!project) throw new ProductError("Project not found", 404);
    if (endpointId !== undefined && !endpoints.some((endpoint) => endpoint.id === endpointId)) throw new ProductError("Endpoint not found", 404);
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const firstDay = new Date(today); firstDay.setUTCDate(firstDay.getUTCDate() - 29);
    const since = firstDay.toISOString();
    const allSettlements = await this.store.listSettledProjectProviderSettlements(projectId, since);
    const selectedSettlements = endpointId === undefined ? allSettlements : allSettlements.filter((settlement) => settlement.endpointId === endpointId);
    const userSettlements = selectedSettlements.filter((settlement) => settlement.actorId === userId);
    const daily = Array.from({ length: 30 }, (_, index) => { const date = new Date(firstDay); date.setUTCDate(firstDay.getUTCDate() + index); return { date: date.toISOString().slice(0, 10), requests: 0, tokens: 0, cost: 0 }; });
    const dailyByDate = new Map(daily.map((day) => [day.date, day]));
    for (const settlement of userSettlements) {
      const day = dailyByDate.get(settlement.settledAt!.slice(0, 10));
      if (!day) continue;
      day.requests += 1; day.tokens += settlement.usage?.tokens ?? 0; day.cost += settlement.usage?.cost ?? 0;
    }
    const endpointUsage = new Map<string, ProjectUsageEndpoint & { endpointId: string }>(endpoints.map((endpoint) => [endpoint.id, { endpointId: endpoint.id, endpointName: endpoint.name, requests: 0, tokens: 0, cost: 0, limits: [] }]));
    let unassignedEndpointUsage: ProjectUsageEndpoint | undefined;
    for (const settlement of allSettlements) {
      if (settlement.endpointId === null) {
        unassignedEndpointUsage ??= { endpointId: null, endpointName: "Other provider activity", requests: 0, tokens: 0, cost: 0 };
        unassignedEndpointUsage.requests += 1; unassignedEndpointUsage.tokens += settlement.usage?.tokens ?? 0; unassignedEndpointUsage.cost += settlement.usage?.cost ?? 0;
        continue;
      }
      const endpoint = endpointUsage.get(settlement.endpointId);
      if (!endpoint) continue;
      endpoint.requests += 1; endpoint.tokens += settlement.usage?.tokens ?? 0; endpoint.cost += settlement.usage?.cost ?? 0;
    }
    const measuredAt=Date.now();
    for(const endpoint of endpointUsage.values()){const windows=(policy.endpointWindows??[]).filter(item=>item.endpointId===endpoint.endpointId);endpoint.limits=[];for(const window of windows){const cutoff=new Date(measuredAt-window.windowSeconds*1000).toISOString();const measured=await this.store.measureProjectProviderWindow({projectId,endpointId:endpoint.endpointId,actorId:userId,metric:window.metric,since:cutoff});const resetAt=measured.oldestReservedAt?new Date(Date.parse(measured.oldestReservedAt)+window.windowSeconds*1000).toISOString():null;endpoint.limits.push({metric:window.metric,current:measured.current,limit:window.limit,remaining:Math.max(0,window.limit-measured.current),window:{kind:"rolling",windowSeconds:window.windowSeconds,startedAt:cutoff,resetAt}})}}
    const trendTotals = daily.reduce((total, day) => ({ requests: total.requests + day.requests, tokens: total.tokens + day.tokens, cost: total.cost + day.cost }), { requests: 0, tokens: 0, cost: 0 });
    const sandbox=await this.sandboxUsage(projectId,selectedUserId);
    return { projectId, usage, limits: usageLimits(policy, usage, project.createdAt), daily, trendTotals, endpoints: [...endpointUsage.values(), ...(unassignedEndpointUsage ? [unassignedEndpointUsage] : [])], selectedEndpointId: endpointId ?? null, sandbox };
  }
  private async sandboxUsage(projectId:string,selectedUserId:string):Promise<import("../../contracts/src/api.js").ProjectSandboxUsage>{
    const [tasks,runs,settlements]=await Promise.all([this.store.listTasksForProject(projectId),this.store.sandboxRuns.list(),this.store.listSandboxUsageSettlements(projectId,selectedUserId)]);
    const projectRuns=runs.filter((run)=>run.projectId===projectId&&run.startedByUserId===selectedUserId),runsById=new Map(projectRuns.map((run)=>[run.runId,run])),settlementsById=new Map(settlements.map((value)=>[value.runId,value]));
    const ownedTasks=tasks.filter((task)=>!task.deletedAt&&task.executionMode==="live"&&(task.createdByUserId??null)===selectedUserId),tasksByRun=new Map(ownedTasks.map((task)=>[task.runId,task]));
    const availableTaskIds=new Set(tasks.filter((task)=>!task.deletedAt).map((task)=>task.id));
    for(const task of ownedTasks){const run=runsById.get(task.runId),settlement=settlementsById.get(task.runId);if(!(run&&ownedRunMatchesTask(run,task))&&!(settlement&&ownedSettlementMatchesTask(settlement,task)))throw new ProductError("Sandbox usage is unavailable because an owned run or settlement is missing or mismatched",503,"sandbox_usage_unavailable");if(run&&(run.cleanupStatus==="cleaned"||run.phase==="cleaned")&&!settlement)throw new ProductError("Sandbox usage is unavailable because a cleaned run settlement is missing",503,"sandbox_usage_unavailable");}
    for(const run of projectRuns){if(run.cleanupStatus!=="cleaned"&&run.phase!=="cleaned"){const task=tasksByRun.get(run.runId);if(!task||!ownedRunMatchesTask(run,task))throw new ProductError("Sandbox usage is unavailable because an owned run is missing or mismatched",503,"sandbox_usage_unavailable");}}
    const measuredAt=Date.now();
    const rows:import("../../contracts/src/api.js").ProjectSandboxUsageRow[]=[...settlements.map((value)=>({taskId:value.taskId,taskAvailable:availableTaskIds.has(value.taskId),runId:value.runId,fileLibraryId:value.fileLibraryId,state:"settled" as const,startedAt:value.startedAt,releasedAt:value.releasedAt,durationSeconds:value.durationSeconds,resources:structuredClone(value.resources),releaseReason:value.releaseReason})),...projectRuns.filter((run)=>run.cleanupStatus!=="cleaned"&&run.phase!=="cleaned").map((run)=>({taskId:run.taskId,taskAvailable:true,runId:run.runId,fileLibraryId:run.fileLibraryId,state:"live" as const,startedAt:run.startedAt,releasedAt:null,durationSeconds:run.startedAt?Math.max(0,(measuredAt-Date.parse(run.startedAt))/1000):0,resources:structuredClone(run.resourceSnapshot),releaseReason:null}))].sort((a,b)=>(b.startedAt??b.releasedAt??"").localeCompare(a.startedAt??a.releasedAt??"")||b.runId.localeCompare(a.runId));
    let totalDurationMs=0n,cpuRequestMillisMs=0n,memoryRequestByteMs=0n;
    for(const row of rows){const roundedDurationMs=Math.round(row.durationSeconds*1000);if(!Number.isSafeInteger(roundedDurationMs)||roundedDurationMs<0)throw new ProductError("Sandbox usage is unavailable because a duration is outside the supported range",503,"sandbox_usage_unavailable");const durationMs=BigInt(roundedDurationMs);totalDurationMs+=durationMs;cpuRequestMillisMs+=BigInt(row.resources.cpuRequestMillis)*durationMs;memoryRequestByteMs+=BigInt(row.resources.memoryRequestBytes)*durationMs;}
    return{selectedUserId,activeCount:rows.filter((row)=>row.state==="live"&&row.startedAt!==null).length,launches:rows.filter((row)=>row.startedAt!==null).length,totalDurationSeconds:formatDecimal(totalDurationMs,3),cpuRequestSeconds:formatDecimal(cpuRequestMillisMs,6),memoryRequestByteSeconds:formatDecimal(memoryRequestByteMs,3),rows};
  }
  async alerts(userId:string,projectId:string):Promise<ProjectAlert[]>;
  async alerts(userId:string,projectId:string,query:import("../../contracts/src/api.js").ProjectAlertQuery):Promise<import("../../contracts/src/api.js").ProjectAlertPage>;
  async alerts(userId: string, projectId: string, query?: import("../../contracts/src/api.js").ProjectAlertQuery): Promise<ProjectAlert[] | import("../../contracts/src/api.js").ProjectAlertPage> {
    await this.authorization.requireProject(userId, projectId);
    const activeTypes = new Set((await this.store.listActiveProjectAlerts(projectId)).map((alert) => alert.type));
    for (const type of activeTypes) await recoverProjectAlerts(this.store, projectId, type, undefined, true);
    if (!query) return this.store.listProjectAlerts(projectId);
    const [page, active] = await Promise.all([
      this.store.queryProjectAlerts(projectId, query),
      this.store.listActiveProjectAlerts(projectId),
    ]);
    return { ...page, activeCount: active.length };
  }
  async alert(userId:string,projectId:string,alertId:string):Promise<ProjectAlert>{
    await this.authorization.requireProject(userId,projectId);
    let alert=await this.store.findProjectAlert(projectId,alertId);
    if(!alert)throw new ProductError("Project alert not found",404);
    if(alert.status==="active"){
      await recoverProjectAlerts(this.store,projectId,alert.type,undefined,true);
      alert=await this.store.findProjectAlert(projectId,alertId);
      if(!alert)throw new ProductError("Project alert not found",404);
    }
    return alert;
  }
  async transitionAlert(userId: string, projectId: string, alertId: string, status: "resolved" | "dismissed", idempotencyKey?: string) {
    const action: ProjectAuditAction = status === "resolved" ? "alert.resolve" : "alert.dismiss";
    try {
      await this.authorization.requireProject(userId, projectId, "admin");
    } catch (error) {
      await this.auditEvent(projectId, userId, action, "rejected", alertId, "alert");
      throw error;
    }
    const transition = async () => {
      let alert: ProjectAlert;
      try {
        const transitioned = await this.store.transitionProjectAlert(projectId, alertId, status, nowIso());
        if (!transitioned) throw new ProductError("Active project alert not found", 404);
        alert = transitioned;
      } catch (error) {
        await this.auditEvent(projectId, userId, action, "rejected", alertId, "alert");
        throw error;
      }
      await this.auditEvent(projectId, userId, action, "accepted", alert.id, "alert");
      return alert;
    };
    if (!idempotencyKey) return transition();
    return runIdempotentMutation({ store: this.store, actorId: userId, scopeId: projectId, operation: "project.alert.transition", key: idempotencyKey, request: { alertId, status }, resourceId: alertId, failureMessage: "Alert could not be updated", run: transition });
  }
  async audit(userId:string,projectId:string):Promise<import("../../contracts/src/api.js").ProjectAuditEventView[]>;
  async audit(userId:string,projectId:string,query:import("../../contracts/src/api.js").ProjectAuditQuery):Promise<import("../../contracts/src/api.js").ProjectAuditPage>;
  async audit(userId: string, projectId: string, query?: import("../../contracts/src/api.js").ProjectAuditQuery):Promise<import("../../contracts/src/api.js").ProjectAuditEventView[]|import("../../contracts/src/api.js").ProjectAuditPage> {
    await this.authorization.requireProject(userId, projectId);
    const [events, members] = await Promise.all([
      this.store.queryProjectAuditEvents(projectId, query??{limit:100}),
      this.store.listProjectMemberships(projectId)
    ]);
    const actors = new Map(members.map((member) => [member.userId, { displayName: member.displayName, email: member.email }]));
    const missingActorIds = new Set(events.items.flatMap((event) => event.actorId && !actors.has(event.actorId) ? [event.actorId] : []));
    for (const actorId of missingActorIds) {
      const actor = await this.store.findUserById(actorId);
      if (!actor) continue;
      const profile = await this.store.findUserProfilePreferences(actorId);
      actors.set(actorId, { displayName: profile?.displayName ?? null, email: actor.email });
    }
    const items=events.items.map((event) => {
      const actor = event.actorId ? actors.get(event.actorId) : undefined;
      return { ...event,detail:safeAuditDetail(event.detail), actorDisplayName: actor?.displayName ?? null, actorEmail: actor?.email ?? null };
    });return query===undefined?items:{nextCursor:events.nextCursor,items};
  }
  async updatePolicy(userId: string, projectId: string, input: UpdateProjectResourcePolicyInput & Partial<Pick<UpdateProjectResourcePolicyRequest,"expectedUpdatedAt">>, idempotencyKey?: string): Promise<ProjectResourcePolicy> {
    try {
      await this.authorization.requireProject(userId, projectId, "admin");
    } catch (error) {
      await this.auditEvent(projectId, userId, "policy.update", "rejected", projectId);
      throw error;
    }
    const update = async () => {
      let result: ProjectResourcePolicy;
      let previous!: ProjectResourcePolicy;
      try {
        const { expectedUpdatedAt, ...policyInput } = input;
        const updated = validatePolicyInput(policyInput);
        previous = await this.requirePolicy(projectId);
        const expected = expectedPolicyTimestamp(expectedUpdatedAt, previous.updatedAt);
        if(updated.endpointWindows){const endpoints=await this.store.listEndpointsForProject(projectId);const endpointIds=new Set(endpoints.map(endpoint=>endpoint.id));if(updated.endpointWindows.some(window=>!endpointIds.has(window.endpointId)))throw new ProductError("Endpoint policy window endpoint not found",404)}
        if (Object.keys(updated).length === 0) throw new ProductError("Project policy update requires at least one limit");
        const patched = await this.store.patchProjectResourcePolicy(projectId, updated, nextTimestamp(previous.updatedAt), expected);
        if (!patched) {
          if (await this.store.findProjectResourcePolicy(projectId)) throw new ProductError("Project policy changed elsewhere. Reload and try again.", 409);
          throw new ProductError("Project policy not found", 404);
        }
        result = patched;
      } catch (error) {
        await this.auditEvent(projectId, userId, "policy.update", "rejected", projectId);
        throw error;
      }
      await this.auditEvent(projectId, userId, "policy.update", "accepted", projectId);
      await this.recoverChangedPolicyAlerts(previous, result);
      return result;
    };
    if (!idempotencyKey) return update();
    return runIdempotentMutation({ store: this.store, actorId: userId, scopeId: projectId, operation: "project.policy.update", key: idempotencyKey, request: input, resourceId: projectId, failureMessage: "Project policy could not be updated", run: update });
  }
  async reserveTask(projectId: string, actorId: string, taskId: string): Promise<void> { await this.change(projectId, actorId, "task.create", taskId, { activeTasks: 1 }, "active_tasks_limit"); await evaluateProjectAlertRules(this.store, projectId, "active_tasks_limit"); }
  async recordTaskReservationRejected(projectId: string, actorId: string, taskId: string): Promise<void> {
    await this.openAlert(projectId, "active_tasks_limit");
    await this.auditEvent(projectId, actorId, "task.create", "rejected", taskId);
  }
  async recordOperation(projectId: string, actorId: string | null, action: ProjectAuditAction, status: "accepted" | "rejected", resourceId: string | null, resourceKind = auditResourceKind(action), detail?: import("../../contracts/src/api.js").ProjectAuditSafeDetail): Promise<void> {
    await this.auditEvent(projectId, actorId, action, status, resourceId, resourceKind, detail);
  }
  async raiseAlert(projectId: string, type: ProjectAlertType): Promise<void> { await this.openAlert(projectId, type); }
  async evaluateTaskFailure(projectId:string,endpointId:string):Promise<void>{await emitProjectAlert(this.store,projectId,"task_failure",{endpointId});await recoverProjectAlerts(this.store,projectId,"task_failure");}
  async recordProviderFailure(projectId:string,actorId:string|null,endpointId:string|null,errorCategory:EndpointHealthErrorCategory):Promise<void>{
    const timestamp=nowIso();
    await recordProjectFailure(this.store,"provider_failure",{
      id:newId("audit"),projectId,actorId,action:"provider.request",status:"rejected",resourceKind:"provider",resourceId:endpointId,
      detail:{...(endpointId?{endpointId}:{}),errorCategory},createdAt:timestamp
    },endpointId?{endpointId}:{});
  }
  async releaseTask(projectId: string, taskId: string): Promise<void> { await this.change(projectId, null, "task.cleaned", taskId, { activeTasks: -1 }, undefined); await evaluateProjectAlertRules(this.store, projectId, "active_tasks_limit"); await recoverProjectAlerts(this.store,projectId,"active_tasks_limit"); }
  async reserveProvider(projectId: string, actorId: string | null, endpointId: string | null, taskId: string | null = null, reservation: Readonly<{ tokens: number; cost: number }> = DEFAULT_PROVIDER_RESERVATION): Promise<string> {
    const reservedAt = nowIso();
    const policy = await this.requirePolicy(projectId);
    const reserved = await this.store.reserveProjectProviderSettlement({ id: newId("providersettle"), projectId, taskId, endpointId,actorId,reservedTokens:reservation.tokens,reservedCost:reservation.cost, reservedAt, expiresAt: new Date(Date.parse(reservedAt) + 5 * 60_000).toISOString() });
    if (reserved) {
      await this.auditEvent(projectId, actorId, "provider.request", "accepted", endpointId);
      return reserved.id;
    }
    const usage = await this.usage(projectId);
    const projectLimits = providerReservationLimits(policy, usage, reservation);
    const endpointLimits = await this.endpointReservationLimits(policy, projectId, actorId, endpointId, reservation, reservedAt);
    const limits = [...projectLimits, ...endpointLimits].filter((limit, index, values) => values.indexOf(limit) === index);
    const alertScopes = [
      ...projectLimits.map((limit) => ({ limit, endpointId: null })),
      ...endpointLimits.map((limit) => ({ limit, endpointId })),
      ...(!limits.length ? [{ limit: "provider_requests_limit" as const, endpointId }] : []),
    ].filter((value, index, values) => values.findIndex((candidate) => candidate.limit === value.limit && candidate.endpointId === value.endpointId) === index);
    await Promise.all(alertScopes.map(({ limit, endpointId: scopeEndpointId }) => this.openAlert(projectId, limit, scopeEndpointId)));
    await this.auditEvent(projectId, actorId, "provider.request", "rejected", endpointId);
    const reason = projectLimits[0] ?? endpointLimits[0] ?? "provider_requests_limit";
    const scope = projectLimits.length ? "Project" : endpointLimits.length ? "Endpoint rolling" : "Project";
    throw new ProductError(`${scope} ${reason.replaceAll("_", " ")} reached`, 409, `${reason}_reached`);
  }
  async markProviderDispatched(id: string): Promise<void> { if (!await this.store.markProjectProviderSettlementDispatched(id, nowIso())) throw new ProductError("Provider settlement not found", 409); }
  async markProviderDelivered(id: string): Promise<void> { if (!await this.store.markProjectProviderSettlementDelivered(id, nowIso())) throw new ProductError("Provider settlement not found", 409); }
  async settleProvider(id: string, providerUsage?: ProviderUsage): Promise<void> {
    const settled = await this.store.settleProjectProviderSettlement(id, providerUsage, nowIso());
    if (!settled) throw new ProductError("Project policy usage not found", 409);
    const types = ["provider_requests_limit", "provider_tokens_limit", "provider_cost_limit"] as const;
    for (const type of types) {
      await evaluateProjectAlertRules(this.store, settled.usage.projectId, type, settled.endpointId ? { endpointId: settled.endpointId } : {});
      if (type === "provider_requests_limit") continue;
      if (settled.exceededLimits.includes(type)) await this.openAlert(settled.usage.projectId, type, null);
      else await recoverProjectAlerts(this.store, settled.usage.projectId, type, null);
    }
  }
  async markProviderUnknown(id: string): Promise<void> { await this.store.markProjectProviderSettlementUnknown(id, nowIso()); }
  async failProvider(id: string): Promise<void> { await this.store.failProjectProviderSettlement(id, nowIso()); }
  async expireProviderReservations(): Promise<void> { await this.store.expireProjectProviderSettlements(nowIso()); await this.store.pruneProjectProviderSettlements(new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(), 100); }
  async recordFileBytes(projectId: string, actorId: string | null, resourceId: string, delta: number): Promise<void> {
    const adjusted = await this.store.adjustProjectResourceUsage({
      projectId,
      delta: { activeTasks: 0, providerRequests: 0, providerTokens: 0, providerCost: 0, projectFileBytes: delta },
      ...(delta > 0 ? { limit: "project_file_bytes_limit" as const } : {}),
      updatedAt: nowIso()
    });
    if (adjusted) {
      await this.bestEffortFileProjection("file alert evaluation",async()=>{await evaluateProjectAlertRules(this.store,projectId,"project_file_bytes_limit");if(delta<0)await recoverProjectAlerts(this.store,projectId,"project_file_bytes_limit")});
      return;
    }
    if (delta > 0) {
      await this.requirePolicy(projectId);
      await this.bestEffortFileProjection("file quota projection",async()=>{await this.openAlert(projectId,"project_file_bytes_limit");await this.auditEvent(projectId,actorId,"file.quota","rejected",null,"file_quota")});
      throw new ProductError("Project file bytes limit reached", 409, "project_file_bytes_limit_reached");
    }
    throw new ProductError("Project policy usage not found", 409);
  }
  async reconcileFileLibraryBytes(projectId: string, fileLibraryBytes: number): Promise<void> {
    if (!Number.isSafeInteger(fileLibraryBytes) || fileLibraryBytes < 0) throw new ProductError("Project file bytes must be a non-negative integer");
    const usage = await this.store.setProjectFileBytes(projectId, fileLibraryBytes, nowIso());
    if (!usage) throw new ProductError("Project policy usage not found", 409);
    await this.bestEffortFileProjection("file reconciliation projection",async()=>{await evaluateProjectAlertRules(this.store,projectId,"project_file_bytes_limit");await recoverProjectAlerts(this.store,projectId,"project_file_bytes_limit")});
    const policy=await this.requirePolicy(projectId);
    if(policy.projectFileBytesLimit!==null&&fileLibraryBytes>policy.projectFileBytesLimit){await this.bestEffortFileProjection("file quota projection",()=>this.openAlert(projectId,"project_file_bytes_limit"));throw new ProductError("Project file bytes limit reached",409,"project_file_bytes_limit_reached");}
  }
  async recordFileMutation(projectId:string,actorId:string,action:Extract<ProjectAuditAction,"file.upload"|"file.delete">,resourceId:string,filePath:string,delta:number,bytes:number,mediaType:string):Promise<void>{
    await this.recordFileBytes(projectId,actorId,filePath,delta);
    await this.bestEffortFileProjection("file mutation audit",()=>this.recordOperation(projectId,actorId,action,"accepted",resourceId,"file",{filePath,bytes,mediaType}));
  }
  async refreshFileAlerts(projectId: string): Promise<void> { await evaluateProjectAlertRules(this.store,projectId,"project_file_bytes_limit");await recoverProjectAlerts(this.store,projectId,"project_file_bytes_limit"); }
  private async requirePolicy(projectId: string) { const policy = await this.store.findProjectResourcePolicy(projectId); if (!policy) throw new ProductError("Project policy not found", 409); return policy; }
  private async bestEffortFileProjection(label:string,action:()=>Promise<void>):Promise<void>{try{await action()}catch(error){console.error(`${label} failed`,error)}}
  private async usage(projectId: string) { return (await this.store.findProjectResourceUsage(projectId)) ?? zeroUsage(projectId); }
  private async recoverChangedPolicyAlerts(previous: ProjectResourcePolicy, updated: ProjectResourcePolicy): Promise<void> {
    const usage = await this.usage(updated.projectId);
    const limits: Array<{ before: number | null; after: number | null; current: number; next: number; type: Limit }> = [
      { before: previous.activeTasksLimit, after: updated.activeTasksLimit, current: usage.activeTasks, next: 1, type: "active_tasks_limit" },
      { before: previous.providerRequestsLimit, after: updated.providerRequestsLimit, current: usage.providerRequests, next: 1, type: "provider_requests_limit" },
      { before: previous.providerTokensLimit, after: updated.providerTokensLimit, current: usage.providerTokens, next: DEFAULT_PROVIDER_RESERVATION.tokens, type: "provider_tokens_limit" },
      { before: previous.providerCostLimit, after: updated.providerCostLimit, current: usage.providerCost, next: DEFAULT_PROVIDER_RESERVATION.cost, type: "provider_cost_limit" },
      { before: previous.projectFileBytesLimit, after: updated.projectFileBytesLimit, current: usage.projectFileBytes, next: 1, type: "project_file_bytes_limit" },
    ];
    for (const limit of limits) {
      if (limit.before === limit.after || (limit.after !== null && limit.current + limit.next > limit.after)) continue;
      await recoverProjectAlerts(this.store, updated.projectId, limit.type, null);
    }
    for (const window of previous.endpointWindows ?? []) {
      const current = (updated.endpointWindows ?? []).find((candidate) => candidate.endpointId === window.endpointId && candidate.metric === window.metric);
      if (current?.limit === window.limit && current.windowSeconds === window.windowSeconds) continue;
      await recoverProjectAlerts(this.store, updated.projectId, providerMetricLimit(window.metric), window.endpointId);
    }
  }
  private async endpointReservationLimits(policy: ProjectResourcePolicy, projectId: string, actorId: string | null, endpointId: string | null, reservation: Readonly<{ tokens: number; cost: number }>, measuredAt: string): Promise<Limit[]> {
    if (endpointId === null) return [];
    const limits: Limit[] = [];
    for (const window of policy.endpointWindows ?? []) {
      if (window.endpointId !== endpointId) continue;
      const measured = await this.store.measureProjectProviderWindow({
        projectId,
        endpointId,
        actorId,
        metric: window.metric,
        since: new Date(Date.parse(measuredAt) - window.windowSeconds * 1000).toISOString(),
      });
      const requested = window.metric === "providerRequests" ? 1 : window.metric === "providerTokens" ? reservation.tokens : reservation.cost;
      if (measured.current + requested <= window.limit) continue;
      limits.push(providerMetricLimit(window.metric));
    }
    return limits;
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
        throw new ProductError(`Project ${limit.replaceAll("_", " ")} reached`, 409, `${limit}_reached`);
      }
      throw new ProductError("Project policy usage not found", 409);
    }
    await this.auditEvent(projectId, actorId, action, "accepted", resourceId);
  }
  private async openAlert(projectId: string, type: Limit, endpointId?: string | null) { await emitProjectAlert(this.store, projectId, type, endpointId ? { endpointId } : {}); }
  private async auditEvent(projectId: string, actorId: string | null, action: ProjectAuditAction, status: "accepted" | "rejected", resourceId: string | null, resourceKind = auditResourceKind(action), detail?: import("../../contracts/src/api.js").ProjectAuditSafeDetail) { await this.store.appendProjectAuditEvent({ id: newId("audit"), projectId, actorId, action, status, resourceKind, resourceId, ...(detail ? { detail: safeAuditDetail(detail) } : {}), createdAt: nowIso() }); }
}

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
function providerMetricLimit(metric: "providerRequests" | "providerTokens" | "providerCost"): Limit { return metric === "providerRequests" ? "provider_requests_limit" : metric === "providerTokens" ? "provider_tokens_limit" : "provider_cost_limit"; }
function auditResourceKind(action: ProjectAuditAction): ProjectAuditResourceKind {
  if (action.startsWith("credential.")) return "credential";
  if (action.startsWith("endpoint.")) return "endpoint";
  if (action.startsWith("membership.")) return "member";
  if (action.startsWith("alert.")) return "alert";
  if (action === "provider.request") return "provider";
  if (action.startsWith("task.")) return "task";
  if (action === "artifact.project") return "artifact";
  if (action === "sandbox.failed") return "sandbox";
  if (action === "file.quota") return "file_quota";
  if (action.startsWith("file.")) return "file";
  return "project";
}
function validatePolicyInput(input: UpdateProjectResourcePolicyInput): UpdateProjectResourcePolicyInput {
  if (input.activeTasksLimit === null) throw new ProductError("Project active tasks limit cannot be unlimited");
  if (input.endpointWindows) {
    const seen = new Set<string>();
    for (const window of input.endpointWindows) {
      const key = `${window.endpointId}:${window.metric}`;
      if (seen.has(key)) throw new ProductError("Endpoint policy windows must be unique");
      seen.add(key);
      if (!window.endpointId || !["providerRequests", "providerTokens", "providerCost"].includes(window.metric) || !Number.isFinite(window.limit) || window.limit < 0 || !Number.isInteger(window.windowSeconds) || window.windowSeconds < 60 || window.windowSeconds > 2592000) throw new ProductError("Endpoint policy window is invalid");
      if (window.metric !== "providerCost" && !Number.isInteger(window.limit)) throw new ProductError("Endpoint policy count limits must be integers");
    }
  }
  for (const [key, value] of Object.entries(input)) {
    if(key==="endpointWindows")continue;
    if (value === null) continue;
    if (!Number.isFinite(value) || value < 0 || (key !== "providerCostLimit" && !Number.isInteger(value))) {
      throw new ProductError("Project policy limits must be non-negative values; count limits must be integers");
    }
  }
  return input;
}
function expectedPolicyTimestamp(value:string|undefined,current:string):string{if(value===undefined)return current;if(!Number.isFinite(Date.parse(value)))throw new ProductError("expectedUpdatedAt must be an ISO timestamp");return new Date(value).toISOString()}
function nextTimestamp(previous:string):string{const now=Date.now();const prior=Date.parse(previous);return new Date(Number.isFinite(prior)&&now<=prior?prior+1:now).toISOString()}
function safeAuditDetail(detail:import("../../contracts/src/api.js").ProjectAuditSafeDetail|undefined){return sanitizeProjectAuditDetail(detail)}
