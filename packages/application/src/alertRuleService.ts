import { isActiveProjectAlertRuleView, type ActiveProjectAlertRuleView, type AlertRuleMetric, type AlertRuleScope, type ProjectAlertRule, type ProjectAlertRuleView, type ProjectAlertType } from "../../contracts/src/api.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { ProductError, NotFoundError } from "../../domain/src/errors.js";
import type { ProductStore } from "../../ports/src/store.js";
import { AuthorizationService } from "./authorizationService.js";
import { runIdempotentMutation } from "./idempotentMutation.js";
import { evaluateProjectAlertRules, measureAlertRule, matchesAlertRule, recoverProjectAlerts } from "./projectAlertEvaluator.js";

const types:readonly ProjectAlertType[]=["active_tasks_limit","provider_requests_limit","provider_tokens_limit","provider_cost_limit","project_file_bytes_limit","endpoint_failure","provider_failure","sandbox_failure"];
const metrics:readonly AlertRuleMetric[]=["active_tasks","provider_requests","provider_tokens","provider_cost","project_file_bytes","failure_count"];
type Input={name?:unknown;alertType?:unknown;metric?:unknown;threshold?:unknown;windowSeconds?:unknown;scope?:unknown;enabled?:unknown;expectedUpdatedAt?:unknown};
type RuleAuditAction="alert.rule.create"|"alert.rule.update"|"alert.rule.delete";

export class AlertRuleService {
  constructor(private readonly store: ProductStore, private readonly authorization: AuthorizationService) {}
  async list(userId:string,projectId:string){await this.authorization.requireProject(userId,projectId);return this.store.listProjectAlertRules(projectId)}
  async create(userId:string,projectId:string,input:Input,idempotencyKey?:string){await this.authorization.requireProject(userId,projectId,"admin");const type=alertType(input.alertType);const selectedMetric=metric(input.metric,type);const normalized={projectId,name:text(input.name,"name",type.replaceAll("_"," ")),alertType:type,metric:selectedMetric,condition:"greater_than_or_equal" as const,threshold:number(input.threshold,"threshold",1),windowSeconds:window(input.windowSeconds,selectedMetric),scope:await this.scope(projectId,type,input.scope),enabled:input.enabled===undefined?true:boolean(input.enabled,"enabled")};const create=async(id:string)=>{const existing=(await this.store.listProjectAlertRules(projectId)).find((rule)=>rule.id===id);if(existing)return existing;const timestamp=nowIso();const saved=await this.store.createProjectAlertRule({id,...normalized,createdAt:timestamp,updatedAt:timestamp});await this.audit(projectId,userId,"alert.rule.create",saved.id);if(saved.enabled)await evaluateProjectAlertRules(this.store,projectId,saved.alertType,evaluationContext(saved.scope));return saved};if(!idempotencyKey)return create(newId("alert_rule"));return runIdempotentMutation({store:this.store,actorId:userId,scopeId:projectId,operation:"project.alert-rule.create",key:idempotencyKey,request:normalized,resourceId:newId("alert_rule"),failureMessage:"Alert rule could not be created",run:create})}
  async update(userId:string,projectId:string,id:string,input:Input,idempotencyKey?:string){
    await this.authorization.requireProject(userId,projectId,"admin");
    const update=async()=>{
      const current=requireActiveRule((await this.store.listProjectAlertRules(projectId)).find(rule=>rule.id===id));
      const expected=expectedTimestamp(input.expectedUpdatedAt,current.updatedAt);
      const type=input.alertType===undefined?current.alertType:alertType(input.alertType);
      const typeChanged=type!==current.alertType;
      const selectedMetric=input.metric===undefined?(typeChanged?defaultMetric(type):(current.metric??defaultMetric(type))):metric(input.metric,type);
      if(!metricFor(type,selectedMetric))throw new ProductError("metric is invalid for alertType");
      const metricChanged=selectedMetric!==(current.metric??defaultMetric(current.alertType));
      const selectedScope=input.scope===undefined?(supportsEndpointScope(type)?(current.scope??{kind:"project"}):{kind:"project"} as const):await this.scope(projectId,type,input.scope);
      const updated:ProjectAlertRule={...current,name:input.name===undefined?(current.name??type.replaceAll("_"," ")):text(input.name,"name"),alertType:type,metric:selectedMetric,condition:"greater_than_or_equal",threshold:input.threshold===undefined?(current.threshold??1):number(input.threshold,"threshold"),windowSeconds:input.windowSeconds===undefined?(typeChanged||metricChanged?defaultWindow(selectedMetric):(current.windowSeconds??defaultWindow(selectedMetric))):window(input.windowSeconds,selectedMetric),scope:selectedScope,enabled:input.enabled===undefined?current.enabled:boolean(input.enabled,"enabled"),updatedAt:nextTimestamp(current.updatedAt)};
      const saved=await this.store.updateProjectAlertRule(updated,expected);
      if(!saved){if((await this.store.listProjectAlertRules(projectId)).some(rule=>rule.id===id))throw new ProductError("Alert rule changed elsewhere. Reload and try again.",409);throw new NotFoundError("Alert rule not found")}
      await this.audit(projectId,userId,"alert.rule.update",id);
      await recoverProjectAlerts(this.store,projectId,current.alertType,scopeEndpoint(current.scope),true);
      if(saved.enabled)await evaluateProjectAlertRules(this.store,projectId,saved.alertType,evaluationContext(saved.scope));
      return saved;
    };
    if(!idempotencyKey)return update();
    return runIdempotentMutation({store:this.store,actorId:userId,scopeId:projectId,operation:"project.alert-rule.update",key:idempotencyKey,request:{id,input},resourceId:id,failureMessage:"Alert rule could not be updated",run:update});
  }
  async remove(userId:string,projectId:string,id:string,idempotencyKey?:string){
    await this.authorization.requireProject(userId,projectId,"admin");
    const remove=async()=>{
      const current=requireActiveRule((await this.store.listProjectAlertRules(projectId)).find(rule=>rule.id===id));
      if(current.enabled&&!await this.store.updateProjectAlertRule({...current,enabled:false,updatedAt:nowIso()}))throw new NotFoundError("Alert rule not found");
      await recoverProjectAlerts(this.store,projectId,current.alertType,scopeEndpoint(current.scope),true);
      if(!await this.store.deleteProjectAlertRule(projectId,id))throw new NotFoundError("Alert rule not found");
      await this.audit(projectId,userId,"alert.rule.delete",id);
      return{deleted:true as const};
    };
    if(!idempotencyKey)return remove();
    return runIdempotentMutation({store:this.store,actorId:userId,scopeId:projectId,operation:"project.alert-rule.delete",key:idempotencyKey,request:{id},resourceId:id,failureMessage:"Alert rule could not be deleted",run:remove});
  }
  async test(userId:string,projectId:string,id:string){await this.authorization.requireProject(userId,projectId,"admin");const rule=requireActiveRule((await this.store.listProjectAlertRules(projectId)).find(item=>item.id===id));const evaluatedAt=nowIso();const value=await measureAlertRule(this.store,rule,evaluatedAt);const threshold=rule.threshold??1;return{matched:matchesAlertRule(rule,value),metric:rule.metric??defaultMetric(rule.alertType),value,threshold,evaluatedAt}}
  async acknowledge(userId:string,projectId:string,id:string,idempotencyKey?:string){await this.authorization.requireProject(userId,projectId,"admin");await requireMutableAlert(this.store,projectId,id);const acknowledge=async()=>{const now=nowIso();const alert=await this.store.updateProjectAlertState(projectId,id,{acknowledgedAt:now,acknowledgedBy:userId},now);if(!alert)throw new NotFoundError("Active project alert not found");await this.instanceAudit(projectId,userId,"alert.acknowledge",id);return alert};if(!idempotencyKey)return acknowledge();return runIdempotentMutation({store:this.store,actorId:userId,scopeId:projectId,operation:"project.alert.acknowledge",key:idempotencyKey,request:{id},resourceId:id,failureMessage:"Alert could not be acknowledged",run:acknowledge})}
  async silence(userId:string,projectId:string,id:string,until:unknown,idempotencyKey?:string){await this.authorization.requireProject(userId,projectId,"admin");await requireMutableAlert(this.store,projectId,id);const value=until===null?null:timestamp(until);const silence=async()=>{if(value!==null&&(Date.parse(value)<=Date.now()||Date.parse(value)>Date.now()+30*86400000))throw new ProductError("silencedUntil must be in the next 30 days");const alert=await this.store.updateProjectAlertState(projectId,id,{silencedUntil:value},nowIso());if(!alert)throw new NotFoundError("Active project alert not found");await this.instanceAudit(projectId,userId,"alert.silence",id);return alert};if(!idempotencyKey)return silence();return runIdempotentMutation({store:this.store,actorId:userId,scopeId:projectId,operation:"project.alert.silence",key:idempotencyKey,request:{id,silencedUntil:value},resourceId:id,failureMessage:"Alert silence could not be updated",run:silence})}
  private async scope(projectId:string,type:ProjectAlertType,value:unknown):Promise<AlertRuleScope>{if(value===undefined)return{kind:"project"};if(!value||typeof value!=="object")throw new ProductError("scope is invalid");const input=value as Record<string,unknown>;if(input.kind==="project")return{kind:"project"};if(!supportsEndpointScope(type))throw new ProductError("Alert rule type only supports project scope");if(input.kind!=="endpoint"||typeof input.endpointId!=="string")throw new ProductError("scope is invalid");const endpoint=await this.store.findEndpoint(input.endpointId);if(!endpoint||endpoint.projectId!==projectId)throw new ProductError("Alert rule endpoint not found",404);return{kind:"endpoint",endpointId:input.endpointId}}
  private async audit(projectId:string,userId:string,action:RuleAuditAction,id:string){await this.store.appendProjectAuditEvent({id:newId("audit"),projectId,actorId:userId,action,status:"accepted",resourceKind:"alert",resourceId:id,detail:{alertRuleId:id},createdAt:nowIso()})}
  private async instanceAudit(projectId:string,userId:string,action:"alert.acknowledge"|"alert.silence",id:string){await this.store.appendProjectAuditEvent({id:newId("audit"),projectId,actorId:userId,action,status:"accepted",resourceKind:"alert",resourceId:id,detail:{alertId:id},createdAt:nowIso()})}
}
export { measureAlertRule, matchesAlertRule } from "./projectAlertEvaluator.js";
function alertType(value:unknown){if(typeof value!=="string"||!isProjectAlertType(value))throw new ProductError("alertType is invalid");return value}
function defaultMetric(type:ProjectAlertType):AlertRuleMetric{return type==="active_tasks_limit"?"active_tasks":type==="provider_requests_limit"?"provider_requests":type==="provider_tokens_limit"?"provider_tokens":type==="provider_cost_limit"?"provider_cost":type==="project_file_bytes_limit"?"project_file_bytes":"failure_count"}
function metric(value:unknown,type:ProjectAlertType){const selected=value===undefined?defaultMetric(type):typeof value==="string"&&isAlertRuleMetric(value)?value:null;if(selected===null||!metricFor(type,selected))throw new ProductError("metric is invalid for alertType");return selected}
function metricFor(type:ProjectAlertType,selected:AlertRuleMetric):boolean{return selected===defaultMetric(type)}
function text(value:unknown,field:string,fallback?:string){if(value===undefined&&fallback)return fallback;if(typeof value!=="string"||value.trim().length<1||value.trim().length>80)throw new ProductError(`${field} must be 1 to 80 characters`);return value.trim()}
function number(value:unknown,field:string,fallback?:number){if(value===undefined&&fallback!==undefined)return fallback;if(typeof value!=="number"||!Number.isFinite(value)||value<0)throw new ProductError(`${field} must be a non-negative number`);return value}
function window(value:unknown,selectedMetric:AlertRuleMetric){if(value===undefined)return defaultWindow(selectedMetric);if(value===null){if(selectedMetric==="failure_count")throw new ProductError("windowSeconds is required for failure_count");return null}if(typeof value!=="number"||!Number.isInteger(value)||value<60||value>2592000)throw new ProductError("windowSeconds must be between 60 and 2592000");return value}
function defaultWindow(selectedMetric:AlertRuleMetric):number|null{return selectedMetric==="failure_count"?3600:null}
function boolean(value:unknown,field:string){if(typeof value!=="boolean")throw new ProductError(`${field} must be a boolean`);return value}
function timestamp(value:unknown){if(typeof value!=="string"||!Number.isFinite(Date.parse(value)))throw new ProductError("silencedUntil must be an ISO timestamp");return new Date(value).toISOString()}
function expectedTimestamp(value:unknown,current:string){if(value===undefined)return current;if(typeof value!=="string"||!Number.isFinite(Date.parse(value)))throw new ProductError("expectedUpdatedAt must be an ISO timestamp");return new Date(value).toISOString()}
function nextTimestamp(previous:string){const now=Date.now();const prior=Date.parse(previous);return new Date(Number.isFinite(prior)&&now<=prior?prior+1:now).toISOString()}
function supportsEndpointScope(type:ProjectAlertType){return type!=="active_tasks_limit"&&type!=="project_file_bytes_limit"}
function scopeEndpoint(scope:AlertRuleScope|undefined){return scope?.kind==="endpoint"?scope.endpointId:undefined}
function evaluationContext(scope:AlertRuleScope|undefined){return scope?.kind==="endpoint"?{endpointId:scope.endpointId}:{} }
function requireActiveRule(rule:ProjectAlertRuleView|undefined):ActiveProjectAlertRuleView{if(!rule)throw new NotFoundError("Alert rule not found");if(!isActiveProjectAlertRuleView(rule))throw new ProductError("Historical alert rules are read-only",409,"historical_alert_rule_read_only");return rule}
async function requireMutableAlert(store:ProductStore,projectId:string,id:string):Promise<void>{const alert=await store.findProjectAlert(projectId,id);if(alert?.type==="historical_task_failure")throw new ProductError("Historical alerts are read-only",409,"historical_alert_read_only")}
function isProjectAlertType(value:string):value is ProjectAlertType{return types.some((type)=>type===value)}
function isAlertRuleMetric(value:string):value is AlertRuleMetric{return metrics.some((metric)=>metric===value)}
