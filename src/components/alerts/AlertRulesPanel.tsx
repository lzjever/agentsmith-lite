"use client";

import { FlaskConical, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type Endpoint, type ProjectAlertRule } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { Button } from "../ui/button";
import { ConfirmationDialog } from "../ui/confirmation-dialog";
import { toast } from "../ui/toast";
import { AlertRuleFormDialog, alertRuleType, alertRuleTypes, type AlertRuleFormValue } from "./AlertRuleFormDialog";

const initialType = alertRuleTypes[0]!;
const initialValue: AlertRuleFormValue = { name: "Task capacity", alertType: initialType.value, metric: initialType.metric, threshold: 1, windowSeconds: initialType.defaultWindowSeconds, scope: { kind: "project" }, enabled: true };

export function AlertRulesPanel({ projectId, endpoints = [], canManage, onAccessDenied, onInstancesChanged }: { projectId: string; endpoints?: Endpoint[]; canManage: boolean; onAccessDenied?: (reason: unknown) => void; onInstancesChanged?: () => Promise<void> }) {
  const mutationKeys = useMutationKeys();
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const [rules, setRules] = useState<ProjectAlertRule[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectAlertRule | null>(null);
  const [value, setValue] = useState<AlertRuleFormValue>(initialValue);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ProjectAlertRule | null>(null);
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setState("loading");
    try {
      const listed = await apiClient.alertRules(projectId);
      if (!mounted.current || request !== loadRequest.current) return;
      setRules(listed);
      setState("ready");
    } catch {
      if (!mounted.current || request !== loadRequest.current) return;
      setState("error");
    }
  }, [projectId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!canManage) {
      mutationKeys.clear("alert-rule.create");
      mutationKeys.clear("alert-rule.update");
      mutationKeys.clear("alert-rule.delete");
      setDialogOpen(false);
      setRemoving(null);
    }
  }, [canManage]);

  function mutationFailed(reason: unknown, message: string) {
    if (isReadOnlyMutationError(reason)) {
      setDialogOpen(false);
      setRemoving(null);
      onAccessDenied?.(reason);
    }
    toast.error(message);
  }

  function forgetMissingRule(reason: unknown, ruleId: string) {
    if (!isMissingRule(reason)) return false;
    setRules((current) => current.filter((rule) => rule.id !== ruleId));
    if (editing?.id === ruleId) {
      setDialogOpen(false);
      setEditing(null);
    }
    if (removing?.id === ruleId) setRemoving(null);
    void onInstancesChanged?.();
    toast.error("Alert rule no longer exists.");
    return true;
  }

  function openCreate() {
    mutationKeys.clear("alert-rule.create");
    setEditing(null);
    setValue(initialValue);
    setFormError("");
    setDialogOpen(true);
  }

  function openEdit(rule: ProjectAlertRule) {
    setEditing(rule);
    setValue(alertRuleFormValue(rule));
    setFormError("");
    setDialogOpen(true);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || saving || busyRuleId !== null || (editing !== null && !alertRuleChanged(value, editing))) return;
    setSaving(true);
    setFormError("");
    try {
      const saved = editing
        ? await apiClient.updateAlertRule(projectId, editing.id, value, mutationKeys.requestKey("alert-rule.update", `${editing.id}:form`, value))
        : await apiClient.createAlertRule(projectId, value, mutationKeys.requestKey("alert-rule.create", projectId, value));
      if (editing) mutationKeys.complete("alert-rule.update", `${editing.id}:form`);
      else mutationKeys.complete("alert-rule.create", projectId);
      if (!mounted.current) return;
      setRules((current) => editing ? current.map((rule) => rule.id === saved.id ? saved : rule) : [...current, saved]);
      await onInstancesChanged?.();
      if (!mounted.current) return;
      setDialogOpen(false);
      toast.success(editing ? "Alert rule updated." : "Alert rule created.");
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof ApiError) mutationKeys.complete(editing ? "alert-rule.update" : "alert-rule.create", editing ? `${editing.id}:form` : projectId);
      if (editing && forgetMissingRule(reason, editing.id)) return;
      const message = editing ? "Alert rule could not be updated." : "Alert rule could not be created.";
      if (!isReadOnlyMutationError(reason)) setFormError(message);
      mutationFailed(reason, message);
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  async function toggle(rule: ProjectAlertRule) {
    if (!canManage || busyRuleId !== null) return;
    setBusyRuleId(rule.id);
    try {
      const identity = `${rule.id}:toggle:${!rule.enabled}`;
      const saved = await apiClient.updateAlertRule(projectId, rule.id, { enabled: !rule.enabled }, mutationKeys.key("alert-rule.update", identity));
      mutationKeys.complete("alert-rule.update", identity);
      if (!mounted.current) return;
      setRules((current) => current.map((item) => item.id === rule.id ? saved : item));
      await onInstancesChanged?.();
      if (!mounted.current) return;
      toast.success(saved.enabled ? "Alert rule enabled." : "Alert rule disabled.");
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof ApiError) mutationKeys.complete("alert-rule.update", `${rule.id}:toggle:${!rule.enabled}`);
      if (forgetMissingRule(reason, rule.id)) return;
      mutationFailed(reason, "Alert rule could not be updated.");
    } finally {
      if (mounted.current) setBusyRuleId(null);
    }
  }
  async function test(rule: ProjectAlertRule) { if(!canManage||busyRuleId!==null)return;setBusyRuleId(rule.id); try { const result=await apiClient.testAlertRule(projectId,rule.id); if(!mounted.current)return; const metric=result.metric.replaceAll("_"," "); toast.success(result.matched?`Rule would trigger: ${metric} is ${result.value}, threshold ${result.threshold}.`:`Rule would not trigger: ${metric} is ${result.value}, threshold ${result.threshold}.`); } catch(reason) { if(!mounted.current)return;if(forgetMissingRule(reason,rule.id))return; mutationFailed(reason,"Alert rule test could not be completed."); } finally { if(mounted.current)setBusyRuleId(null); } }

  async function remove() {
    if (!removing || !canManage || busyRuleId !== null) return;
    setBusyRuleId(removing.id);
    try {
      let alreadyMissing = false;
      await apiClient.deleteAlertRule(projectId, removing.id, mutationKeys.key("alert-rule.delete", removing.id)).catch((error) => {
        if (!isMissingRule(error)) throw error;
        alreadyMissing = true;
      });
      mutationKeys.complete("alert-rule.delete", removing.id);
      if (!mounted.current) return;
      setRules((current) => current.filter((item) => item.id !== removing.id));
      await onInstancesChanged?.();
      if (!mounted.current) return;
      setRemoving(null);
      toast.success(alreadyMissing ? "Alert rule no longer exists." : "Alert rule deleted.");
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError) mutationKeys.complete("alert-rule.delete", removing.id);
      mutationFailed(error, "Alert rule could not be deleted.");
      throw error;
    } finally {
      if (mounted.current) setBusyRuleId(null);
    }
  }

  return <section className="mt-8 border-t border-subtle pt-6" aria-label="Alert rules">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="type-title">Alert rules</h2><p className="mt-1 text-sm text-secondary">Choose when project administrators should be notified.</p></div>
      {canManage ? <Button disabled={busyRuleId !== null} onClick={openCreate}><Plus size={16} />Add rule</Button> : <span className="text-sm text-secondary">Read-only</span>}
    </div>
    {state === "loading" ? <p className="mt-4 text-sm text-secondary">Loading alert rules...</p> : null}
    {state === "error" ? <div className="mt-4 flex items-center justify-between gap-3 border-y border-subtle py-3" role="alert"><span className="text-sm text-error">Alert rules could not be loaded.</span><Button variant="quiet" onClick={() => void load()}><RefreshCw size={15} />Retry</Button></div> : null}
    {state === "ready" && rules.length === 0 ? <p className="mt-4 text-sm text-secondary">No alert rules configured.</p> : null}
    {state === "ready" && rules.length > 0 ? <ul className="mt-4 divide-y divide-subtle border-y border-subtle">
      {rules.map((rule) => <li className="flex items-center justify-between gap-3 py-3" key={rule.id}>
        <span className="min-w-0 text-sm text-foreground"><strong className="block truncate font-medium">{rule.name ?? alertRuleTypes.find((type) => type.value === rule.alertType)?.label}</strong><small className="mt-1 block text-secondary">Threshold {rule.threshold ?? 1} · {rule.windowSeconds ? formatWindow(rule.windowSeconds) : "current value"} · {scopeLabel(rule, endpoints)}</small></span>
        <div className="flex items-center gap-2">
          {canManage ? <Button variant="quiet" disabled={busyRuleId !== null} onClick={() => void toggle(rule)}>{rule.enabled ? "Enabled" : "Disabled"}</Button> : <span className="text-sm text-secondary">{rule.enabled ? "Enabled" : "Disabled"}</span>}
          {canManage ? <Button variant="quiet" size="icon" aria-label="Test alert rule" disabled={busyRuleId !== null} onClick={() => void test(rule)}><FlaskConical size={16} /></Button> : null}
          {canManage ? <Button variant="quiet" size="icon" aria-label="Edit alert rule" disabled={busyRuleId !== null} onClick={() => openEdit(rule)}><Pencil size={16} /></Button> : null}
          {canManage ? <Button variant="quiet" size="icon" aria-label="Delete alert rule" disabled={busyRuleId !== null} onClick={() => setRemoving(rule)}><Trash2 size={16} /></Button> : null}
        </div>
      </li>)}
    </ul> : null}
    <AlertRuleFormDialog open={dialogOpen} editing={editing !== null} value={value} endpoints={endpoints} saving={saving} canSave={busyRuleId === null && (editing === null || alertRuleChanged(value, editing))} error={formError} onOpenChange={(open) => { setDialogOpen(open); if (!open) { mutationKeys.clear("alert-rule.create"); setFormError(""); } }} onChange={setValue} onSubmit={save} />
    <ConfirmationDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)} title="Delete alert rule" description="This permanently removes the rule from this project." confirmText="Delete" confirmDisabled={busyRuleId !== null} onConfirm={remove} errorContext="Alert rule could not be deleted" />
  </section>;
}
function formatWindow(seconds:number){if(seconds%86400===0)return `${seconds/86400} day window`;if(seconds%3600===0)return `${seconds/3600} hour window`;return `${seconds} second window`;}
function scopeLabel(rule:ProjectAlertRule,endpoints:Endpoint[]){const scope=rule.scope;if(!scope||scope.kind==="project")return "Project";return endpoints.find(endpoint=>endpoint.id===scope.endpointId)?.name??"Endpoint";}
function alertRuleFormValue(rule: ProjectAlertRule): AlertRuleFormValue { const type=alertRuleType(rule.alertType);return {name:rule.name??type.label,alertType:type.value,metric:type.metric,threshold:rule.threshold??1,windowSeconds:rule.windowSeconds??type.defaultWindowSeconds,scope:rule.scope??{kind:"project"},enabled:rule.enabled}; }
function alertRuleChanged(value: AlertRuleFormValue, rule: ProjectAlertRule): boolean { const original=alertRuleFormValue(rule);return value.name!==original.name||value.alertType!==original.alertType||value.metric!==original.metric||value.threshold!==original.threshold||value.windowSeconds!==original.windowSeconds||value.enabled!==original.enabled||value.scope.kind!==original.scope.kind||(value.scope.kind==="endpoint"&&original.scope.kind==="endpoint"&&value.scope.endpointId!==original.scope.endpointId); }
function isMissingRule(error:unknown):boolean{return error instanceof ApiError&&error.status===404&&error.message==="Alert rule not found";}
