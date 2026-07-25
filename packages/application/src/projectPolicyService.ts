import { sanitizeProjectAuditDetail, type EndpointHealthErrorCategory, type ProjectAlert, type ProjectAlertCursorKey, type ProjectAlertType, type ProjectAlertView, type ProjectAuditAction, type ProjectAuditIdentityPage, type ProjectAuditIdentityQuery, type ProjectAuditQuery, type ProjectAuditResourceKind, type ProjectEndpointUsagePage, type ProjectEndpointUsageQuery, type ProjectFileStorageUsage, type ProjectResourcePolicy, type ProjectResourcePolicyView, type ProjectResourceUsage, type ProjectSandboxRunHistoryPage, type ProjectUsageLimit, type ProjectUsageOverview, type ProviderUsage, type UpdateProjectResourcePolicyInput, type UpdateProjectResourcePolicyRequest } from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { formatDecimal } from "../../domain/src/kubernetesQuantity.js";
import type { ProductStore } from "../../ports/src/store.js";
import { AuthorizationService } from "./authorizationService.js";
import { decodeEndpointUsageCursor, encodeEndpointUsageCursor, normalizeProviderDirectoryQuery, providerDirectoryLimit, type EndpointUsageSnapshot } from "./endpointCredentialDirectory.js";
import { runIdempotentMutation } from "./idempotentMutation.js";
import { emitProjectAlert, evaluateProjectAlertRules, recordProjectFailure, recoverProjectAlerts } from "./projectAlertEvaluator.js";

type Limit = ProjectAlertType;
const zeroUsage = (projectId: string): ProjectResourceUsage => ({ projectId, activeSandboxes: 0, providerRequests: 0, providerTokens: 0, providerCost: 0, projectFileBytes: 0, projectFileBytesMeasuredAt: null, updatedAt: nowIso() });
export const DEFAULT_PROVIDER_RESERVATION = { tokens: 4096, cost: 1 } as const;
interface SandboxRunCursor { v:1;projectId:string;selectedUserId:string;scopeMeasuredAt:string;key:{releasedAt:string;runId:string}; }
interface ProjectAlertCursor { v:1;projectId:string;view:ProjectAlertView;key:ProjectAlertCursorKey; }
type ProjectAuditFilters=Omit<ProjectAuditQuery,"cursor"|"limit">;
interface ProjectAuditCursor { v:1;projectId:string;filters:ProjectAuditFilters;key:{createdAt:string;id:string}; }
interface ProjectAuditIdentityCursor { v:1;projectId:string;role:"actor"|"subject";q:string;key:{id:string}; }

function encodeSandboxRunCursor(value:SandboxRunCursor):string{return Buffer.from(JSON.stringify(value),"utf8").toString("base64url")}
function encodeProjectAlertCursor(value:ProjectAlertCursor):string{return Buffer.from(JSON.stringify(value),"utf8").toString("base64url")}
function encodeProjectAuditCursor(value:ProjectAuditCursor):string{return Buffer.from(JSON.stringify(value),"utf8").toString("base64url")}
function encodeProjectAuditIdentityCursor(value:ProjectAuditIdentityCursor):string{return Buffer.from(JSON.stringify(value),"utf8").toString("base64url")}
function decodeSandboxRunCursor(cursor:string,projectId:string,selectedUserId:string):SandboxRunCursor{
  const invalid=()=>new ProductError("Sandbox Run history cursor is invalid");
  if(cursor.length<1||cursor.length>4096||!/^[A-Za-z0-9_-]+$/u.test(cursor))throw invalid();
  let parsed:unknown;
  try{parsed=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"))}catch{throw invalid()}
  if(!isRecord(parsed)||!hasExactKeys(parsed,["v","projectId","selectedUserId","scopeMeasuredAt","key"])||parsed.v!==1||typeof parsed.projectId!=="string"||typeof parsed.selectedUserId!=="string"||typeof parsed.scopeMeasuredAt!=="string"||!isRecord(parsed.key)||!hasExactKeys(parsed.key,["releasedAt","runId"])||typeof parsed.key.releasedAt!=="string"||typeof parsed.key.runId!=="string")throw invalid();
  const value=parsed as unknown as SandboxRunCursor;
  if(value.projectId!==projectId||value.selectedUserId!==selectedUserId||!isCanonicalIso(value.scopeMeasuredAt)||!isCanonicalIso(value.key.releasedAt)||value.key.releasedAt>value.scopeMeasuredAt||!validCursorId(value.key.runId)||encodeSandboxRunCursor(value)!==cursor)throw invalid();
  return value;
}
function decodeProjectAlertCursor(cursor:string,projectId:string,view:ProjectAlertView):ProjectAlertCursor{
  const invalid=()=>new ProductError("Alert cursor is invalid");
  if(cursor.length<1||cursor.length>4096||!/^[A-Za-z0-9_-]+$/u.test(cursor))throw invalid();
  let parsed:unknown;
  try{parsed=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"))}catch{throw invalid()}
  if(!isRecord(parsed)||!hasExactKeys(parsed,["v","projectId","view","key"])||parsed.v!==1||typeof parsed.projectId!=="string"||(parsed.view!=="active"&&parsed.view!=="history")||!isRecord(parsed.key)||!hasExactKeys(parsed.key,["createdAt","id"])||typeof parsed.key.createdAt!=="string"||typeof parsed.key.id!=="string")throw invalid();
  const value=parsed as unknown as ProjectAlertCursor;
  if(value.projectId!==projectId||value.view!==view||!isCanonicalIso(value.key.createdAt)||!validCursorId(value.key.id)||encodeProjectAlertCursor(value)!==cursor)throw invalid();
  return value;
}
function decodeProjectAuditCursor(cursor:string,projectId:string,filters:ProjectAuditFilters):ProjectAuditCursor{
  const invalid=()=>new ProductError("Audit cursor is invalid");
  if(cursor.length<1||cursor.length>4096||!/^[A-Za-z0-9_-]+$/u.test(cursor))throw invalid();
  let parsed:unknown;
  try{parsed=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"))}catch{throw invalid()}
  if(!isRecord(parsed)||!hasExactKeys(parsed,["v","projectId","filters","key"])||parsed.v!==1||typeof parsed.projectId!=="string"||!isRecord(parsed.filters)||!isRecord(parsed.key)||!hasExactKeys(parsed.key,["createdAt","id"])||typeof parsed.key.createdAt!=="string"||typeof parsed.key.id!=="string")throw invalid();
  const value=parsed as unknown as ProjectAuditCursor;
  if(value.projectId!==projectId||JSON.stringify(value.filters)!==JSON.stringify(filters)||!isCanonicalIso(value.key.createdAt)||!validCursorId(value.key.id)||encodeProjectAuditCursor(value)!==cursor)throw invalid();
  return value;
}
function decodeProjectAuditIdentityCursor(cursor:string,projectId:string,role:"actor"|"subject",q:string):ProjectAuditIdentityCursor{
  const invalid=()=>new ProductError("Audit identity cursor is invalid");
  if(cursor.length<1||cursor.length>4096||!/^[A-Za-z0-9_-]+$/u.test(cursor))throw invalid();
  let parsed:unknown;
  try{parsed=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"))}catch{throw invalid()}
  if(!isRecord(parsed)||!hasExactKeys(parsed,["v","projectId","role","q","key"])||parsed.v!==1||typeof parsed.projectId!=="string"||(parsed.role!=="actor"&&parsed.role!=="subject")||typeof parsed.q!=="string"||!isRecord(parsed.key)||!hasExactKeys(parsed.key,["id"])||typeof parsed.key.id!=="string")throw invalid();
  const value=parsed as unknown as ProjectAuditIdentityCursor;
  if(value.projectId!==projectId||value.role!==role||value.q!==q||!validCursorId(value.key.id)||encodeProjectAuditIdentityCursor(value)!==cursor)throw invalid();
  return value;
}
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value)}
function hasExactKeys(value:Record<string,unknown>,keys:string[]):boolean{const actual=Object.keys(value);return actual.length===keys.length&&keys.every((key,index)=>actual[index]===key)}
function isCanonicalIso(value:string):boolean{const time=Date.parse(value);return Number.isFinite(time)&&new Date(time).toISOString()===value}
function validCursorId(value:string):boolean{return value.length>0&&value.length<=1024&&!/[\u0000-\u001f\u007f]/u.test(value)}

export class ProjectPolicyService {
  constructor(private readonly store: ProductStore, private readonly authorization: AuthorizationService) {}

  async getPolicy(userId: string, projectId: string): Promise<ProjectResourcePolicyView> { await this.authorization.requireProject(userId, projectId); return this.requirePolicyView(projectId); }
  async getUsageOverview(userId: string, projectId: string, endpointId?: string, selectedUserId = userId): Promise<ProjectUsageOverview> {
    const access=await this.requireUsageScope(userId,projectId,selectedUserId);
    const measuredAt=nowIso(),today=new Date(measuredAt);today.setUTCHours(0,0,0,0);
    const firstDay = new Date(today); firstDay.setUTCDate(firstDay.getUTCDate() - 29);
    const periodStart=firstDay.toISOString(),periodEnd=new Date(today.getTime()+24*60*60_000).toISOString();
    const read=await this.store.readProjectUsageOverview({projectId,userId,selectedUserId,periodStart,periodEnd,selectedEndpointId:endpointId??null,measuredAt});
    const resultKind=read.kind;
    switch(resultKind){
      case "available":{
        const daily = Array.from({ length: 30 }, (_, index) => { const date = new Date(firstDay); date.setUTCDate(firstDay.getUTCDate() + index); return { date: date.toISOString().slice(0, 10), requests: 0, tokens: 0, cost: 0 }; });
        const dailyByDate = new Map(daily.map((day) => [day.date, day]));
        for(const aggregate of read.value.provider.daily){const day=dailyByDate.get(aggregate.date);if(day)Object.assign(day,aggregate)}
        const {projectCreatedAt,policy,provider,sandbox}=read.value,usage=read.value.usage??zeroUsage(projectId);
        return{projectId,canSelectMemberUsage:access.canAdmin,limits:usageLimits(policy,usage,projectCreatedAt),fileStorage:fileStorageUsage(policy,usage),provider:{userId,periodStart,periodEnd,selectedEndpointId:endpointId??null,selectedEndpoint:provider.selectedEndpoint,daily,totals:provider.totals},sandbox:{selectedUserId,summaryStartedAt:projectCreatedAt,measuredAt,unreleasedCount:sandbox.unreleasedCount,launches:sandbox.launches,totalDurationSeconds:formatDecimal(BigInt(sandbox.totalDurationMilliseconds),3),cpuRequestSeconds:formatDecimal(BigInt(sandbox.cpuRequestMillisMilliseconds),6),memoryRequestByteSeconds:formatDecimal(BigInt(sandbox.memoryRequestByteMilliseconds),3),liveRuns:sandbox.liveRuns}};
      }
      case "project_not_found":throw new ProductError("Project not found",404);
      case "policy_not_found":throw new ProductError("Project policy not found",409);
      case "endpoint_not_found":throw new ProductError("Endpoint not found",404);
      case "selected_member_not_found":throw new ProductError("Project member not found",404);
      case "integrity_error":throw new ProductError("Sandbox usage is unavailable because stored Run ownership or settlement data is inconsistent",503,"sandbox_usage_unavailable");
      default:{
        const exhaustive:never=resultKind;
        return exhaustive;
      }
    }
  }
  async getEndpointUsagePage(userId:string,projectId:string,query:ProjectEndpointUsageQuery={}):Promise<ProjectEndpointUsagePage>{
    const selectedUserId=query.userId??userId;
    await this.requireUsageScope(userId,projectId,selectedUserId);
    const q=normalizeProviderDirectoryQuery(query.q),limit=providerDirectoryLimit(query.limit);
    const scope={actorId:userId,projectId,userId:selectedUserId,q};
    const decoded=query.cursor!==undefined?decodeEndpointUsageCursor(query.cursor,scope):undefined;
    const snapshot=decoded?.snapshot??endpointUsageSnapshot(nowIso());
    const page=await this.store.queryProjectEndpointUsagePage({
      projectId,userId:selectedUserId,...snapshot,q,...(decoded?{after:decoded.after}:{}),limit
    });
    const last=page.items.at(-1);
    return{items:page.items.map(({cursorCreatedAt:_,cursorId:__,...item})=>item),nextCursor:page.hasMore&&last?encodeEndpointUsageCursor(scope,snapshot,{createdAt:last.cursorCreatedAt,id:last.cursorId}):null,total:page.total};
  }
  async getSandboxRunHistory(userId:string,projectId:string,query:Readonly<{selectedUserId?:string;cursor?:string;limit?:number}>={}):Promise<ProjectSandboxRunHistoryPage>{
    const selectedUserId=query.selectedUserId??userId,access=await this.requireUsageScope(userId,projectId,selectedUserId),limit=query.limit??20;
    if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new ProductError("Sandbox Run history limit must be between 1 and 50");
    const decoded=query.cursor?decodeSandboxRunCursor(query.cursor,projectId,selectedUserId):null,scopeMeasuredAt=decoded?.scopeMeasuredAt??nowIso();
    const page=await this.store.querySandboxUsageSettlements({projectId,selectedUserId,scopeMeasuredAt,...(decoded?{after:decoded.key}:{}),limit});
    const last=page.items.at(-1);
    return{projectId,selectedUserId,summaryStartedAt:access.project.createdAt,scopeMeasuredAt,items:page.items,nextCursor:page.hasMore&&last?encodeSandboxRunCursor({v:1,projectId,selectedUserId,scopeMeasuredAt,key:{releasedAt:last.releasedAt,runId:last.runId}}):null};
  }
  private async requireUsageScope(userId:string,projectId:string,selectedUserId:string){
    const access=await this.authorization.projectAccess(userId,projectId);
    if(selectedUserId!==userId&&!access.canAdmin)throw new ProductError("Project admin permission is required to view another member's sandbox usage",403);
    if(selectedUserId!==userId&&!await this.store.findProjectMembership(projectId,selectedUserId))throw new ProductError("Project member not found",404);
    return access;
  }
  async alerts(userId:string,projectId:string,query:import("../../contracts/src/api.js").ProjectAlertQuery={}):Promise<import("../../contracts/src/api.js").ProjectAlertPage>{
    await this.authorization.requireProject(userId, projectId);
    const view=query.view??"active",limit=query.limit??20;
    if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new ProductError("Alert limit must be between 1 and 50");
    const decoded=query.cursor?decodeProjectAlertCursor(query.cursor,projectId,view):null;
    const page=await this.store.queryProjectAlerts(projectId,{view,...(decoded?{after:decoded.key}:{}),limit});
    const last=page.items.at(-1);
    return{view,items:page.items,nextCursor:page.hasMore&&last?encodeProjectAlertCursor({v:1,projectId,view,key:{createdAt:last.createdAt,id:last.id}}):null,activeCount:page.activeCount};
  }
  async alert(userId:string,projectId:string,alertId:string):Promise<ProjectAlert>{
    await this.authorization.requireProject(userId,projectId);
    const alert=await this.store.findProjectAlert(projectId,alertId);
    if(!alert)throw new ProductError("Project alert not found",404);
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
  async audit(userId:string,projectId:string,query:ProjectAuditQuery):Promise<import("../../contracts/src/api.js").ProjectAuditPage>{
    await this.authorization.requireProject(userId, projectId);
    const limit=query.limit??20;
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ProductError("Audit limit must be between 1 and 100");
    const filters=normalizeProjectAuditFilters(query);
    const decoded=query.cursor?decodeProjectAuditCursor(query.cursor,projectId,filters):null;
    const page=await this.store.queryProjectAuditEvents(projectId,{...filters,...(decoded?{after:decoded.key}:{}),limit});
    const items=page.items.map((event)=>({...event,detail:safeAuditDetail(event.detail)}));
    const last=items.at(-1);
    return{items,nextCursor:page.hasMore&&last?encodeProjectAuditCursor({v:1,projectId,filters,key:{createdAt:last.createdAt,id:last.id}}):null};
  }
  async auditIdentities(userId:string,projectId:string,query:ProjectAuditIdentityQuery):Promise<ProjectAuditIdentityPage>{
    await this.authorization.requireProject(userId,projectId);
    if(query.role!=="actor"&&query.role!=="subject")throw new ProductError("Audit identity role is invalid");
    const q=(query.q??"").trim().toLowerCase();
    if(q.length>120||/[\u0000-\u001f\u007f]/u.test(q))throw new ProductError("Audit identity query is invalid");
    const limit=query.limit??20;
    if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new ProductError("Audit identity limit must be between 1 and 50");
    const decoded=query.cursor?decodeProjectAuditIdentityCursor(query.cursor,projectId,query.role,q):null;
    const page=await this.store.queryProjectAuditIdentities(projectId,{role:query.role,q,...(decoded?{after:decoded.key}:{}),limit});
    const last=page.items.at(-1);
    return{items:page.items,nextCursor:page.hasMore&&last?encodeProjectAuditIdentityCursor({v:1,projectId,role:query.role,q,key:{id:last.id}}):null};
  }
  async updatePolicy(userId: string, projectId: string, input: UpdateProjectResourcePolicyInput & Partial<Pick<UpdateProjectResourcePolicyRequest,"expectedUpdatedAt">>, idempotencyKey?: string): Promise<ProjectResourcePolicyView> {
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
        if(updated.endpointWindows){const submitted=[...new Set(updated.endpointWindows.map((window)=>window.endpointId))],found=new Set(await this.store.findProjectEndpointIds(projectId,submitted));if(submitted.some((id)=>!found.has(id)))throw new ProductError("Endpoint policy window endpoint not found",404)}
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
      return this.requirePolicyView(projectId);
    };
    if (!idempotencyKey) return update();
    return runIdempotentMutation({ store: this.store, actorId: userId, scopeId: projectId, operation: "project.policy.update", key: idempotencyKey, request: input, resourceId: projectId, failureMessage: "Project policy could not be updated", run: update });
  }
  async recordProjectSandboxCapacityRejected(projectId: string): Promise<void> {
    await this.openAlert(projectId, "sandbox_capacity");
  }
  async refreshSandboxCapacityAlerts(projectId:string):Promise<void>{
    await evaluateProjectAlertRules(this.store,projectId,"sandbox_capacity");
    await recoverProjectAlerts(this.store,projectId,"sandbox_capacity",{unconfiguredFallback:true});
  }
  async refreshSandboxFailureAlerts(projectId:string,endpointId?:string):Promise<void>{
    await emitProjectAlert(this.store,projectId,"sandbox_failure",endpointId?{endpointId}:{});
  }
  async recordOperation(projectId: string, actorId: string | null, action: ProjectAuditAction, status: "accepted" | "rejected", resourceId: string | null, resourceKind = auditResourceKind(action), detail?: import("../../contracts/src/api.js").ProjectAuditSafeDetail): Promise<void> {
    await this.auditEvent(projectId, actorId, action, status, resourceId, resourceKind, detail);
  }
  async raiseAlert(projectId: string, type: ProjectAlertType): Promise<void> { await this.openAlert(projectId, type); }
  async recordProviderFailure(projectId:string,actorId:string|null,endpointId:string|null,errorCategory:EndpointHealthErrorCategory):Promise<void>{
    const timestamp=nowIso();
    await recordProjectFailure(this.store,"provider_failure",{
      id:newId("audit"),projectId,actorId,action:"provider.request",status:"rejected",resourceKind:"provider",resourceId:endpointId,
      detail:{...(endpointId?{endpointId}:{}),errorCategory},createdAt:timestamp
    },endpointId?{endpointId}:{});
  }
  async reserveProvider(projectId: string, actorId: string | null, endpointId: string | null, taskId: string | null = null, reservation: Readonly<{ tokens: number; cost: number }> = DEFAULT_PROVIDER_RESERVATION): Promise<string> {
    const reservedAt = nowIso();
    const policy = await this.requirePolicy(projectId);
    const reserved = await this.store.reserveProjectProviderSettlement({ id: newId("providersettle"), projectId, taskId, endpointId,actorId,reservedTokens:reservation.tokens,reservedCost:reservation.cost, reservedAt, expiresAt: new Date(Date.parse(reservedAt) + 5 * 60_000).toISOString() });
    if (reserved) {
      for(const type of ["provider_requests_limit","provider_tokens_limit","provider_cost_limit"] as const){
        await recoverProjectAlerts(this.store,projectId,type,{unconfiguredFallback:true});
        if(endpointId)await recoverProjectAlerts(this.store,projectId,type,{endpointId,subjectActorId:actorId,unconfiguredFallback:true});
      }
      await this.auditEvent(projectId, actorId, "provider.request", "accepted", endpointId);
      return reserved.id;
    }
    const usage = await this.usage(projectId);
    const projectLimits = providerReservationLimits(policy, usage, reservation);
    const endpointLimits = await this.endpointReservationLimits(policy, projectId, actorId, endpointId, reservation, reservedAt);
    const limits = [...projectLimits, ...endpointLimits].filter((limit, index, values) => values.indexOf(limit) === index);
    const alertScopes = [
      ...projectLimits.map((limit) => ({ limit, endpointId: null, subjectActorId: null })),
      ...endpointLimits.map((limit) => ({ limit, endpointId, subjectActorId: actorId })),
      ...(!limits.length ? [{ limit: "provider_requests_limit" as const, endpointId, subjectActorId: endpointId ? actorId : null }] : []),
    ].filter((value, index, values) => values.findIndex((candidate) => candidate.limit === value.limit && candidate.endpointId === value.endpointId && candidate.subjectActorId === value.subjectActorId) === index);
    await Promise.all(alertScopes.map(({ limit, endpointId: scopeEndpointId, subjectActorId }) => this.openAlert(projectId, limit, scopeEndpointId, subjectActorId)));
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
      if (settled.exceededLimits.includes(type)) await this.openAlert(settled.usage.projectId, type, null);
      else {
        await recoverProjectAlerts(this.store, settled.usage.projectId, type, { unconfiguredFallback: true });
        if (settled.endpointId) await recoverProjectAlerts(this.store, settled.usage.projectId, type, { endpointId: settled.endpointId, subjectActorId:settled.actorId, unconfiguredFallback: true });
      }
    }
    await evaluateProjectAlertRules(this.store, settled.usage.projectId, "provider_failure", settled.endpointId ? { endpointId: settled.endpointId } : {});
    await recoverProjectAlerts(this.store, settled.usage.projectId, "provider_failure", { endpointId: settled.endpointId, unconfiguredFallback: true });
  }
  async markProviderUnknown(id: string): Promise<void> { await this.store.markProjectProviderSettlementUnknown(id, nowIso()); }
  async failProvider(id: string): Promise<void> { await this.store.failProjectProviderSettlement(id, nowIso()); }
  async expireProviderReservations(): Promise<void> { await this.store.expireProjectProviderSettlements(nowIso()); await this.store.pruneProjectProviderSettlements(new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(), 100); }
  async recordFileBytes(projectId: string, actorId: string | null, resourceId: string, delta: number): Promise<void> {
    const adjusted = await this.store.adjustProjectResourceUsage({
      projectId,
      delta: { activeSandboxes: 0, providerRequests: 0, providerTokens: 0, providerCost: 0, projectFileBytes: delta },
      ...(delta > 0 ? { limit: "project_file_bytes_limit" as const } : {}),
      updatedAt: nowIso()
    });
    if (adjusted) {
      await this.bestEffortFileProjection("file alert evaluation",async()=>{
        const policy=await this.requirePolicy(projectId);
        await this.projectFileAlertProjection(projectId,adjusted.projectFileBytes,policy.projectFileBytesLimit);
      });
      return;
    }
    if (delta > 0) {
      await this.requirePolicy(projectId);
      await this.bestEffortFileProjection("file quota projection",async()=>{await this.openAlert(projectId,"project_file_bytes_limit");await this.auditEvent(projectId,actorId,"file.quota","rejected",null,"file_quota")});
      throw new ProductError("Project file bytes limit reached", 409, "project_file_bytes_limit_reached");
    }
    throw new ProductError("Project policy usage not found", 409);
  }
  async reconcileFileLibraryBytes(projectId: string, fileLibraryBytes: number): Promise<ProjectFileStorageUsage> {
    if (!Number.isSafeInteger(fileLibraryBytes) || fileLibraryBytes < 0) throw new ProductError("Project file bytes must be a non-negative integer");
    const usage = await this.store.setProjectFileBytes(projectId, fileLibraryBytes, nowIso());
    if (!usage) throw new ProductError("Project policy usage not found", 409);
    const policy=await this.requirePolicy(projectId);
    await this.bestEffortFileProjection("file reconciliation projection",()=>this.projectFileAlertProjection(projectId,fileLibraryBytes,policy.projectFileBytesLimit));
    return fileStorageUsage(policy,usage);
  }
  async recordFileMutation(projectId:string,actorId:string,action:Extract<ProjectAuditAction,"file.upload"|"file.delete">,resourceId:string,filePath:string,delta:number,bytes:number,mediaType:string):Promise<void>{
    await this.recordFileBytes(projectId,actorId,filePath,delta);
    await this.bestEffortFileProjection("file mutation audit",()=>this.recordOperation(projectId,actorId,action,"accepted",resourceId,"file",{filePath,bytes,mediaType}));
  }
  async refreshFileAlerts(projectId: string): Promise<void> {
    const [policy,usage]=await Promise.all([this.requirePolicy(projectId),this.usage(projectId)]);
    await this.projectFileAlertProjection(projectId,usage.projectFileBytes,policy.projectFileBytesLimit);
  }
  private async projectFileAlertProjection(projectId:string,bytes:number,limit:number|null):Promise<void>{
    if(limit!==null&&bytes>limit)await this.openAlert(projectId,"project_file_bytes_limit");
    else{await evaluateProjectAlertRules(this.store,projectId,"project_file_bytes_limit");await recoverProjectAlerts(this.store,projectId,"project_file_bytes_limit",{unconfiguredFallback:true})}
  }
  private async requirePolicy(projectId: string) { const policy = await this.store.findProjectResourcePolicy(projectId); if (!policy) throw new ProductError("Project policy not found", 409); return policy; }
  private async requirePolicyView(projectId:string){const policy=await this.store.findProjectResourcePolicyView(projectId);if(!policy)throw new ProductError("Project policy not found",409);return policy}
  private async bestEffortFileProjection(label:string,action:()=>Promise<void>):Promise<void>{try{await action()}catch(error){console.error(`${label} failed`,error)}}
  private async usage(projectId: string) { return (await this.store.findProjectResourceUsage(projectId)) ?? zeroUsage(projectId); }
  private async recoverChangedPolicyAlerts(previous: ProjectResourcePolicy, updated: ProjectResourcePolicy): Promise<void> {
    const usage = await this.usage(updated.projectId);
    const limits: Array<{ before: number | null; after: number | null; current: number; next: number; type: Limit }> = [
      { before: previous.sandboxLimit, after: updated.sandboxLimit, current: usage.activeSandboxes, next: 1, type: "sandbox_capacity" },
      { before: previous.providerRequestsLimit, after: updated.providerRequestsLimit, current: usage.providerRequests, next: 1, type: "provider_requests_limit" },
      { before: previous.providerTokensLimit, after: updated.providerTokensLimit, current: usage.providerTokens, next: DEFAULT_PROVIDER_RESERVATION.tokens, type: "provider_tokens_limit" },
      { before: previous.providerCostLimit, after: updated.providerCostLimit, current: usage.providerCost, next: DEFAULT_PROVIDER_RESERVATION.cost, type: "provider_cost_limit" },
      { before: previous.projectFileBytesLimit, after: updated.projectFileBytesLimit, current: usage.projectFileBytes, next: 1, type: "project_file_bytes_limit" },
    ];
    for (const limit of limits) {
      if (limit.before === limit.after || (limit.after !== null && limit.current + limit.next > limit.after)) continue;
      await recoverProjectAlerts(this.store, updated.projectId, limit.type, {unconfiguredFallback:true});
    }
    for (const window of previous.endpointWindows ?? []) {
      const current = (updated.endpointWindows ?? []).find((candidate) => candidate.endpointId === window.endpointId && candidate.metric === window.metric);
      if (current?.limit === window.limit && current.windowSeconds === window.windowSeconds) continue;
      await this.recoverEndpointQuotaFallbacks(updated.projectId,providerMetricLimit(window.metric),window.endpointId);
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
      delta: { activeSandboxes: delta.activeSandboxes ?? 0, providerRequests: delta.providerRequests ?? 0, providerTokens: delta.providerTokens ?? 0, providerCost: delta.providerCost ?? 0, projectFileBytes: delta.projectFileBytes ?? 0 },
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
  private async recoverEndpointQuotaFallbacks(projectId:string,type:Limit,endpointId:string):Promise<void>{
    await recoverProjectAlerts(this.store,projectId,type,{endpointId,subjectActorId:null,unconfiguredFallback:true});
    for(const member of await this.store.listProjectMembershipsForFanout(projectId)){
      await recoverProjectAlerts(this.store,projectId,type,{endpointId,subjectActorId:member.userId,unconfiguredFallback:true});
    }
  }
  private async openAlert(projectId: string, type: Limit, endpointId?: string | null, subjectActorId: string | null = null) { await emitProjectAlert(this.store, projectId, type, endpointId ? { endpointId, subjectActorId } : {}); }
  private async auditEvent(projectId: string, actorId: string | null, action: ProjectAuditAction, status: "accepted" | "rejected", resourceId: string | null, resourceKind = auditResourceKind(action), detail?: import("../../contracts/src/api.js").ProjectAuditSafeDetail) { await this.store.appendProjectAuditEvent({ id: newId("audit"), projectId, actorId, action, status, resourceKind, resourceId, ...(detail ? { detail: safeAuditDetail(detail) } : {}), createdAt: nowIso() }); }
}

function usageLimits(policy: ProjectResourcePolicy, usage: ProjectResourceUsage, projectCreatedAt: string): ProjectUsageLimit[] {
  return [
    usageLimit("activeSandboxes", usage.activeSandboxes, policy.sandboxLimit, projectCreatedAt),
    usageLimit("providerRequests", usage.providerRequests, policy.providerRequestsLimit, projectCreatedAt),
    usageLimit("providerTokens", usage.providerTokens, policy.providerTokensLimit, projectCreatedAt),
    usageLimit("providerCost", usage.providerCost, policy.providerCostLimit, projectCreatedAt)
  ];
}

function fileStorageUsage(policy:ProjectResourcePolicy,usage:ProjectResourceUsage):ProjectFileStorageUsage{
  const limitBytes=policy.projectFileBytesLimit;
  return{recordedBytes:usage.projectFileBytes,measuredAt:usage.projectFileBytesMeasuredAt,limitBytes,remainingBytes:limitBytes===null?null:Math.max(0,limitBytes-usage.projectFileBytes)};
}
function usageLimit(metric: ProjectUsageLimit["metric"], current: number, limit: number | null, projectCreatedAt: string): ProjectUsageLimit {
  const window = metric === "activeSandboxes"
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
  if (input.sandboxLimit === null) throw new ProductError("Project Sandbox limit cannot be unlimited");
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
function endpointUsageSnapshot(measuredAt:string):EndpointUsageSnapshot{const today=new Date(measuredAt);today.setUTCHours(0,0,0,0);const firstDay=new Date(today);firstDay.setUTCDate(firstDay.getUTCDate()-29);return{periodStart:firstDay.toISOString(),periodEnd:new Date(today.getTime()+24*60*60_000).toISOString(),measuredAt}}
function safeAuditDetail(detail:import("../../contracts/src/api.js").ProjectAuditSafeDetail|undefined){return sanitizeProjectAuditDetail(detail)}
function normalizeProjectAuditFilters(query:ProjectAuditQuery):ProjectAuditFilters{
  const actor=Object.hasOwn(query,"actorId")?normalizeAuditUserFilter(query.actorId,"actorId"):undefined;
  const subject=Object.hasOwn(query,"subjectUserId")?normalizeAuditUserFilter(query.subjectUserId,"subjectUserId"):undefined;
  return{
    ...(actor!==undefined?{actorId:actor}:{}),
    ...(subject!==undefined?{subjectUserId:subject}:{}),
    ...(query.action!==undefined?{action:query.action}:{}),
    ...(query.status!==undefined?{status:query.status}:{}),
    ...(query.resourceKind!==undefined?{resourceKind:query.resourceKind}:{}),
    ...(query.resourceId!==undefined?{resourceId:normalizeAuditText(query.resourceId,"resource ID",1024)}:{}),
    ...(query.from!==undefined?{from:normalizeAuditTimestamp(query.from,"from")}:{}),
    ...(query.to!==undefined?{to:normalizeAuditTimestamp(query.to,"to")}:{}),
  };
}
function normalizeAuditUserFilter(value:string|null|undefined,name:string):string|null{
  if(value===null)return null;
  if(value===undefined)throw new ProductError(`Audit ${name} is invalid`);
  return normalizeAuditText(value,name,128);
}
function normalizeAuditText(value:string,name:string,max:number):string{
  if(!value||value.length>max||/[\u0000-\u001f\u007f]/u.test(value))throw new ProductError(`Audit ${name} is invalid`);
  return value;
}
function normalizeAuditTimestamp(value:string,name:string):string{
  const time=Date.parse(value);
  if(!Number.isFinite(time))throw new ProductError(`Audit ${name} timestamp is invalid`);
  return new Date(time).toISOString();
}
