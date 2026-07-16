"use client";

import { FlaskConical, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, apiClient, type Endpoint, type ProjectAlertRule } from "../../lib/api/client";
import { Button } from "../ui/button";
import { ConfirmationDialog } from "../ui/confirmation-dialog";
import { toast } from "../ui/toast";
import { AlertRuleFormDialog, alertRuleType, alertRuleTypes, type AlertRuleFormValue } from "./AlertRuleFormDialog";

const initialType = alertRuleTypes[0]!;
const initialValue: AlertRuleFormValue = { name: "Task capacity", alertType: initialType.value, metric: initialType.metric, threshold: 1, windowSeconds: initialType.defaultWindowSeconds, scope: { kind: "project" }, enabled: true };

export function AlertRulesPanel({ projectId, canManage, onAccessDenied }: { projectId: string; canManage: boolean; onAccessDenied?: () => void }) {
  const [rules, setRules] = useState<ProjectAlertRule[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectAlertRule | null>(null);
  const [value, setValue] = useState<AlertRuleFormValue>(initialValue);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ProjectAlertRule | null>(null);
  const load = useCallback(async () => {
    setState("loading");
    try {
      const [listed, endpointList] = await Promise.all([apiClient.alertRules(projectId), apiClient.endpoints(projectId).catch(() => [])]); setRules(listed); setEndpoints(endpointList);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!canManage) {
      setDialogOpen(false);
      setRemoving(null);
    }
  }, [canManage]);

  function mutationFailed(reason: unknown, message: string) {
    if (reason instanceof ApiError && reason.status === 403) {
      setDialogOpen(false);
      setRemoving(null);
      onAccessDenied?.();
    }
    toast.error(message);
  }

  function openCreate() {
    setEditing(null);
    setValue(initialValue);
    setFormError("");
    setDialogOpen(true);
  }

  function openEdit(rule: ProjectAlertRule) {
    const type = alertRuleType(rule.alertType);
    setEditing(rule);
    setValue({ name: rule.name ?? type.label, alertType: type.value, metric: type.metric, threshold: rule.threshold ?? 1, windowSeconds: rule.windowSeconds ?? type.defaultWindowSeconds, scope: rule.scope ?? { kind: "project" }, enabled: rule.enabled });
    setFormError("");
    setDialogOpen(true);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || saving) return;
    setSaving(true);
    setFormError("");
    try {
      const saved = editing
        ? await apiClient.updateAlertRule(projectId, editing.id, value)
        : await apiClient.createAlertRule(projectId, value);
      setRules((current) => editing ? current.map((rule) => rule.id === saved.id ? saved : rule) : [...current, saved]);
      setDialogOpen(false);
      toast.success(editing ? "Alert rule updated." : "Alert rule created.");
    } catch (reason) {
      const message = editing ? "Alert rule could not be updated." : "Alert rule could not be created.";
      if (!(reason instanceof ApiError && reason.status === 403)) setFormError(message);
      mutationFailed(reason, message);
    } finally {
      setSaving(false);
    }
  }

  async function toggle(rule: ProjectAlertRule) {
    if (!canManage || busyRuleId !== null) return;
    setBusyRuleId(rule.id);
    try {
      const saved = await apiClient.updateAlertRule(projectId, rule.id, { enabled: !rule.enabled });
      setRules((current) => current.map((item) => item.id === rule.id ? saved : item));
      toast.success(saved.enabled ? "Alert rule enabled." : "Alert rule disabled.");
    } catch (reason) {
      mutationFailed(reason, "Alert rule could not be updated.");
    } finally {
      setBusyRuleId(null);
    }
  }
  async function test(rule: ProjectAlertRule) { if(!canManage||busyRuleId!==null)return;setBusyRuleId(rule.id); try { const result=await apiClient.testAlertRule(projectId,rule.id); const metric=result.metric.replaceAll("_"," "); toast.success(result.matched?`Rule would trigger: ${metric} is ${result.value}, threshold ${result.threshold}.`:`Rule would not trigger: ${metric} is ${result.value}, threshold ${result.threshold}.`); } catch(reason) { mutationFailed(reason,"Alert rule test could not be completed."); } finally { setBusyRuleId(null); } }

  async function remove() {
    if (!removing || !canManage || busyRuleId !== null) return;
    setBusyRuleId(removing.id);
    try {
      await apiClient.deleteAlertRule(projectId, removing.id);
      setRules((current) => current.filter((item) => item.id !== removing.id));
      setRemoving(null);
      toast.success("Alert rule deleted.");
    } catch (error) {
      mutationFailed(error, "Alert rule could not be deleted.");
      throw error;
    } finally {
      setBusyRuleId(null);
    }
  }

  return <section className="mt-8 border-t border-subtle pt-6" aria-label="Alert rules">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="type-title">Alert rules</h2><p className="mt-1 text-sm text-secondary">Rules evaluated by the project service.</p></div>
      {canManage ? <Button onClick={openCreate}><Plus size={16} />Add rule</Button> : <span className="text-sm text-secondary">Read-only</span>}
    </div>
    {state === "loading" ? <p className="mt-4 text-sm text-secondary">Loading alert rules...</p> : null}
    {state === "error" ? <div className="mt-4 flex items-center justify-between gap-3 border-y border-subtle py-3" role="alert"><span className="text-sm text-error">Alert rules could not be loaded.</span><Button variant="quiet" onClick={() => void load()}><RefreshCw size={15} />Retry</Button></div> : null}
    {state === "ready" && rules.length === 0 ? <p className="mt-4 text-sm text-secondary">No alert rules configured.</p> : null}
    {state === "ready" && rules.length > 0 ? <ul className="mt-4 divide-y divide-subtle border-y border-subtle">
      {rules.map((rule) => <li className="flex items-center justify-between gap-3 py-3" key={rule.id}>
        <span className="min-w-0 text-sm text-foreground"><strong className="block truncate font-medium">{rule.name ?? alertRuleTypes.find((type) => type.value === rule.alertType)?.label}</strong><small className="mt-1 block text-secondary">Threshold {rule.threshold ?? 1} · {rule.windowSeconds ? formatWindow(rule.windowSeconds) : "current value"} · {scopeLabel(rule, endpoints)}</small></span>
        <div className="flex items-center gap-2">
          {canManage ? <Button variant="quiet" disabled={busyRuleId === rule.id} onClick={() => void toggle(rule)}>{rule.enabled ? "Enabled" : "Disabled"}</Button> : <span className="text-sm text-secondary">{rule.enabled ? "Enabled" : "Disabled"}</span>}
          {canManage ? <Button variant="quiet" size="icon" aria-label="Test alert rule" disabled={busyRuleId === rule.id} onClick={() => void test(rule)}><FlaskConical size={16} /></Button> : null}
          {canManage ? <Button variant="quiet" size="icon" aria-label="Edit alert rule" onClick={() => openEdit(rule)}><Pencil size={16} /></Button> : null}
          {canManage ? <Button variant="quiet" size="icon" aria-label="Delete alert rule" onClick={() => setRemoving(rule)}><Trash2 size={16} /></Button> : null}
        </div>
      </li>)}
    </ul> : null}
    <AlertRuleFormDialog open={dialogOpen} editing={editing !== null} value={value} endpoints={endpoints} saving={saving} error={formError} onOpenChange={(open) => { setDialogOpen(open); if (!open) setFormError(""); }} onChange={setValue} onSubmit={save} />
    <ConfirmationDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)} title="Delete alert rule" description="This permanently removes the rule from this project." confirmText="Delete" onConfirm={remove} errorContext="Alert rule could not be deleted" />
  </section>;
}
function formatWindow(seconds:number){if(seconds%86400===0)return `${seconds/86400} day window`;if(seconds%3600===0)return `${seconds/3600} hour window`;return `${seconds} second window`;}
function scopeLabel(rule:ProjectAlertRule,endpoints:Endpoint[]){const scope=rule.scope;if(!scope||scope.kind==="project")return "Project";return endpoints.find(endpoint=>endpoint.id===scope.endpointId)?.name??"Endpoint";}
