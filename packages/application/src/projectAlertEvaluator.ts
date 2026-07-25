import { projectAlertTypeLabel, sanitizeProjectAuditDetail, type ActiveProjectAlert, type AlertRuleMetric, type ProjectAlert, type ProjectAlertRule, type ProjectAlertType, type ProjectAuditEvent } from "../../contracts/src/api.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import type { ProductStore } from "../../ports/src/store.js";

export type AlertEvaluationContext = { endpointId?: string; subjectActorId?: string | null };
type FailureAlertType = Extract<ProjectAlertType, "endpoint_failure" | "provider_failure" | "sandbox_failure">;

export async function evaluateProjectAlertRules(
  store: ProductStore,
  projectId: string,
  type: ProjectAlertType,
  context: AlertEvaluationContext = {},
): Promise<number> {
  const timestamp = nowIso();
  const rules = await store.listProjectAlertRules(projectId);
  const configured = rules.filter((rule) =>
    rule.enabled &&
    rule.alertType === type &&
    (rule.scope?.kind !== "endpoint" || rule.scope.endpointId === context.endpointId)
  );
  if(configured.length>50)throw new Error("Project alert rule evaluation exceeds 50 rules");
  if (!configured.length) return 0;
  const [members, project] = await Promise.all([
    store.listProjectMembershipsForFanout(projectId),
    store.findProject(projectId),
  ]);
  for (const rule of configured) {
    const endpointId = rule.scope?.kind === "endpoint" ? rule.scope.endpointId : null;
    const current = await store.findActiveProjectAlert(projectId,type,rule.id,endpointId,null);
    const value = await measureAlertRule(store, rule, timestamp);
    if (!matchesAlertRule(rule, value)) {
      if (current) await resolveAlert(store, current, timestamp);
      continue;
    }
    const alert = await store.upsertActiveProjectAlert({
      id: newId("alert"),
      projectId,
      type,
      status: "active",
      deliveryStatus: "pending",
      ruleId: rule.id,
      metric: rule.metric ?? null,
      metricValue: value,
      threshold: rule.threshold ?? null,
      endpointId,
      subjectActorId: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      silencedUntil: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      resolvedAt: null,
      dismissedAt: null,
    });
    if (isSilenced(alert, timestamp)) continue;
    const title = projectAlertTypeLabel(type, endpointId !== null);
    const body = project ? alertNotificationBody(project.name, alert, title) : `A project reported: ${title}.`;
    const linkPath = project ? `/workspaces/${project.workspaceId}/projects/${project.id}/alerts?alertId=${encodeURIComponent(alert.id)}` : null;
    const deliveries = await Promise.allSettled(
      members
        .filter((member) => member.role === "owner" || member.role === "admin")
        .map((member) => store.createUserNotification({
          id: newId("notice"),
          userId: member.userId,
          type: "project_alert",
          title,
          body,
          projectId,
          resourceKind: "alert",
          resourceId: alert.id,
          linkPath,
          readAt: null,
          createdAt: timestamp,
        }, `project-alert:${alert.id}:${member.userId}`)),
    );
    await store.updateProjectAlertDeliveryStatus(
      projectId,
      alert.id,
      deliveries.length > 0 && deliveries.every((delivery) => delivery.status === "fulfilled") ? "delivered" : "failed",
      timestamp,
    );
  }
  return configured.length;
}

export async function emitProjectAlert(
  store: ProductStore,
  projectId: string,
  type: ProjectAlertType,
  context: AlertEvaluationContext = {},
): Promise<void> {
  if (await evaluateProjectAlertRules(store, projectId, type, context)) return;
  const timestamp = nowIso();
  if (isFailureAlertType(type) && await store.measureProjectAlertRule({
    projectId,
    alertType: type,
    metric: "failure_count",
    windowSeconds: 3600,
    endpointId: context.endpointId ?? null,
    now: timestamp,
  }) < 1) return;
  await store.upsertActiveProjectAlert({
    id: newId("alert"), projectId, type, status: "active", deliveryStatus: "not_configured",
    ruleId: null, metric: null, metricValue: null, threshold: null, endpointId: context.endpointId ?? null,
    subjectActorId: context.subjectActorId ?? null,
    acknowledgedAt: null, acknowledgedBy: null, silencedUntil: null,
    createdAt: timestamp, updatedAt: timestamp, resolvedAt: null, dismissedAt: null,
  });
}

export async function recoverProjectAlerts(
  store: ProductStore,
  projectId: string,
  type: ProjectAlertType,
  target: Readonly<{ ruleId?: string; endpointId?: string | null; subjectActorId?: string | null; unconfiguredFallback?: boolean }> = {},
): Promise<void> {
  const timestamp = nowIso();
  const endpointId=target.endpointId??null;
  if(target.ruleId){
    const alert=await store.findActiveProjectAlert(projectId,type,target.ruleId,endpointId,null);
    if(alert){
      const rule=await store.findProjectAlertRule(projectId,target.ruleId);
      if(!rule||!ruleStillOwnsAlert(rule,alert)||!matchesAlertRule(rule,await measureAlertRule(store,rule,timestamp)))await resolveAlert(store,alert,timestamp);
    }
  }
  if(target.unconfiguredFallback){
    const fallback=await store.findActiveProjectAlert(projectId,type,null,endpointId,target.subjectActorId??null);
    if(fallback)await resolveAlert(store,fallback,timestamp);
  }
}

export async function recordProjectFailure(
  store: ProductStore,
  type: FailureAlertType,
  event: ProjectAuditEvent,
  context: AlertEvaluationContext = {},
): Promise<void> {
  await store.appendProjectAuditEvent({ ...event, detail: sanitizeProjectAuditDetail(event.detail) });
  await emitProjectAlert(store, event.projectId, type, context);
}

export async function measureAlertRule(store: ProductStore, rule: ProjectAlertRule, now = nowIso()): Promise<number> {
  return store.measureProjectAlertRule({
    projectId: rule.projectId,
    alertType: rule.alertType,
    metric: rule.metric ?? defaultAlertMetric(rule.alertType),
    windowSeconds: rule.windowSeconds ?? null,
    endpointId: rule.scope?.kind === "endpoint" ? rule.scope.endpointId : null,
    now,
  });
}

export function matchesAlertRule(rule: ProjectAlertRule, value: number): boolean {
  return value >= (rule.threshold ?? 1);
}

export function defaultAlertMetric(type: ProjectAlertType) {
  return type === "active_tasks_limit" ? "active_tasks" as const
    : type === "provider_requests_limit" ? "provider_requests" as const
    : type === "provider_tokens_limit" ? "provider_tokens" as const
    : type === "provider_cost_limit" ? "provider_cost" as const
    : type === "project_file_bytes_limit" ? "project_file_bytes" as const
    : "failure_count" as const;
}

function ruleStillOwnsAlert(rule: ProjectAlertRule, alert: ActiveProjectAlert): boolean {
  const endpointId = rule.scope?.kind === "endpoint" ? rule.scope.endpointId : null;
  return rule.enabled && rule.alertType === alert.type && endpointId === (alert.endpointId ?? null);
}

async function resolveAlert(store: ProductStore, alert: ActiveProjectAlert, timestamp: string) {
  const resolved = await store.transitionProjectAlert(alert.projectId, alert.id, "resolved", timestamp);
  if (resolved) await store.appendProjectAuditEvent({
    id: newId("audit"), projectId: alert.projectId, actorId: null, action: "alert.resolve", status: "accepted",
    resourceKind: "alert", resourceId: alert.id, detail: { alertId: alert.id }, createdAt: timestamp,
  });
}

function isSilenced(alert: ProjectAlert, timestamp: string): boolean {
  return Boolean(alert.silencedUntil && alert.silencedUntil > timestamp);
}
function alertNotificationBody(projectName: string, alert: ProjectAlert, title: string): string {
  if (!alert.metric || alert.metricValue === null || alert.metricValue === undefined) return `${projectName}: ${title}.`;
  const threshold = alert.threshold === null || alert.threshold === undefined ? "" : ` of ${alert.threshold}`;
  return `${projectName}: ${alertMetricLabel(alert.metric)} ${alert.metricValue}${threshold}.`;
}
function alertMetricLabel(metric: AlertRuleMetric): string {
  return {
    active_tasks: "Active sandboxes",
    provider_requests: "Provider requests",
    provider_tokens: "Provider tokens",
    provider_cost: "Provider cost",
    project_file_bytes: "File storage",
    failure_count: "Failures",
  }[metric];
}
function isFailureAlertType(type: ProjectAlertType): type is FailureAlertType { return type === "endpoint_failure" || type === "provider_failure" || type === "sandbox_failure"; }
