"use client";

import { FlaskConical, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Banner, Button, Dialog, DialogHeader, EmptyState, Heading, IconButton, Text, useToast } from "@astryxdesign/core";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type ProjectAlertRule } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { AlertRuleFormDialog, alertRuleType, alertRuleTypes, type AlertRuleFormValue } from "./AlertRuleFormDialog";

const initialType = alertRuleTypes[0]!;
const initialValue: AlertRuleFormValue = { name: "Sandbox capacity", alertType: initialType.value, metric: initialType.metric, threshold: 1, windowSeconds: initialType.defaultWindowSeconds, scope: { kind: "project" }, enabled: true };

export function AlertRulesPanel({ projectId, canManage, onAccessDenied, onInstancesChanged }: { projectId: string; canManage: boolean; onAccessDenied?: (reason: unknown) => void; onInstancesChanged?: () => Promise<void> }) {
  const mutationKeys = useMutationKeys();
  const showToast = useToast();
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const panelHeadingRef = useRef<HTMLDivElement>(null);
  const [rules, setRules] = useState<ProjectAlertRule[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectAlertRule | null>(null);
  const [value, setValue] = useState<AlertRuleFormValue>(initialValue);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ProjectAlertRule | null>(null);
  const [panelError, setPanelError] = useState("");
  const [panelNotice, setPanelNotice] = useState("");
  const [removeError, setRemoveError] = useState("");
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setState("loading");
    setPanelError("");
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
      setPanelError("");
      setRemoveError("");
    }
  }, [canManage]);

  function mutationFailed(reason: unknown, message: string) {
    if (isReadOnlyMutationError(reason)) {
      setDialogOpen(false);
      setRemoving(null);
      onAccessDenied?.(reason);
      return;
    }
    setPanelError(message);
  }

  function forgetMissingRule(reason: unknown, ruleId: string) {
    if (!isMissingRule(reason)) return false;
    setRules((current) => current.filter((rule) => rule.id !== ruleId));
    if (editing?.id === ruleId) {
      setDialogOpen(false);
      setEditing(null);
    }
    if (removing?.id === ruleId) {
      setRemoving(null);
      requestAnimationFrame(() => panelHeadingRef.current?.focus({ preventScroll: true }));
    }
    void onInstancesChanged?.();
    setPanelNotice("Alert rule no longer exists. The rule list has been updated.");
    return true;
  }

  function openCreate() {
    mutationKeys.clear("alert-rule.create");
    setEditing(null);
    setValue(initialValue);
    setFormError("");
    setPanelError("");
    setPanelNotice("");
    setDialogOpen(true);
  }

  function openEdit(rule: ProjectAlertRule) {
    setEditing(rule);
    setValue(alertRuleFormValue(rule));
    setFormError("");
    setPanelError("");
    setPanelNotice("");
    setDialogOpen(true);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || saving || busyRuleId !== null || (value.scope.kind==="endpoint"&&!value.scope.endpointId) || (editing !== null && !alertRuleChanged(value, editing))) return;
    setSaving(true);
    setFormError("");
    try {
      const update = editing ? { ...value, expectedUpdatedAt: editing.updatedAt } : null;
      const saved = editing
        ? await apiClient.updateAlertRule(projectId, editing.id, update!, mutationKeys.requestKey("alert-rule.update", `${editing.id}:form`, update))
        : await apiClient.createAlertRule(projectId, value, mutationKeys.requestKey("alert-rule.create", projectId, value));
      if (editing) mutationKeys.complete("alert-rule.update", `${editing.id}:form`);
      else mutationKeys.complete("alert-rule.create", projectId);
      if (!mounted.current) return;
      setRules((current) => editing ? current.map((rule) => rule.id === saved.id ? saved : rule) : [...current, saved]);
      await onInstancesChanged?.();
      if (!mounted.current) return;
      setDialogOpen(false);
      showToast({ body: editing ? "Alert rule updated." : "Alert rule created.", type: "info" });
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof ApiError) mutationKeys.complete(editing ? "alert-rule.update" : "alert-rule.create", editing ? `${editing.id}:form` : projectId);
      if (editing && isRuleConflict(reason)) {
        setDialogOpen(false);
        await load();
        if (mounted.current) setPanelNotice("Alert rule changed elsewhere. Latest rules loaded; review before editing again.");
        return;
      }
      if (editing && forgetMissingRule(reason, editing.id)) return;
      const message = editing ? "Alert rule could not be updated." : "Alert rule could not be created.";
      if (isReadOnlyMutationError(reason)) mutationFailed(reason, message);
      else setFormError(message);
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  async function toggle(rule: ProjectAlertRule) {
    if (!canManage || busyRuleId !== null) return;
    setPanelError("");
    setBusyRuleId(rule.id);
    try {
      const identity = `${rule.id}:toggle:${!rule.enabled}`;
      const saved = await apiClient.updateAlertRule(projectId, rule.id, { enabled: !rule.enabled, expectedUpdatedAt: rule.updatedAt }, mutationKeys.key("alert-rule.update", identity));
      mutationKeys.complete("alert-rule.update", identity);
      if (!mounted.current) return;
      setRules((current) => current.map((item) => item.id === rule.id ? saved : item));
      await onInstancesChanged?.();
      if (!mounted.current) return;
      showToast({ body: saved.enabled ? "Alert rule enabled." : "Alert rule disabled.", type: "info" });
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof ApiError) mutationKeys.complete("alert-rule.update", `${rule.id}:toggle:${!rule.enabled}`);
      if (isRuleConflict(reason)) {
        await load();
        if (mounted.current) setPanelNotice("Alert rule changed elsewhere. Latest rules loaded; review before trying again.");
        return;
      }
      if (forgetMissingRule(reason, rule.id)) return;
      mutationFailed(reason, "Alert rule could not be updated.");
    } finally {
      if (mounted.current) setBusyRuleId(null);
    }
  }
  async function test(rule: ProjectAlertRule) { if(!canManage||busyRuleId!==null)return;setPanelError("");setPanelNotice("");setBusyRuleId(rule.id); try { const result=await apiClient.testAlertRule(projectId,rule.id); if(!mounted.current)return; const metric=result.metric==="active_sandboxes"?"Active sandboxes":result.metric.replaceAll("_"," "); setPanelNotice(result.matched?`Rule would trigger: ${metric} is ${result.value}, threshold ${result.threshold}.`:`Rule would not trigger: ${metric} is ${result.value}, threshold ${result.threshold}.`); } catch(reason) { if(!mounted.current)return;if(forgetMissingRule(reason,rule.id))return; mutationFailed(reason,"Alert rule test could not be completed."); } finally { if(mounted.current)setBusyRuleId(null); } }

  async function remove() {
    if (!removing || !canManage || busyRuleId !== null) return;
    setBusyRuleId(removing.id);
    setRemoveError("");
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
      requestAnimationFrame(() => panelHeadingRef.current?.focus({ preventScroll: true }));
      if (alreadyMissing) setPanelNotice("Alert rule no longer exists. The rule list has been updated.");
      else showToast({ body: "Alert rule deleted.", type: "info" });
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError) mutationKeys.complete("alert-rule.delete", removing.id);
      if (isReadOnlyMutationError(error)) {
        mutationFailed(error, "Alert rule could not be deleted.");
      } else {
        setRemoveError(error instanceof Error ? error.message : "Alert rule could not be deleted.");
      }
    } finally {
      if (mounted.current) setBusyRuleId(null);
    }
  }

  return <section className="mt-8 border-t border-border pt-6" aria-label="Alert rules">
    <div ref={panelHeadingRef} tabIndex={-1} className="flex flex-wrap items-center justify-between gap-3 outline-none">
      <div><Heading level={2}>Alert rules</Heading><Text as="p" type="supporting" color="secondary" display="block" className="mt-1">Choose when project administrators should be notified.</Text></div>
      {canManage ? <Button label="Add rule" variant="secondary" icon={<Plus size={16} />} isDisabled={busyRuleId !== null} onClick={openCreate} /> : <Text type="supporting" color="secondary">Read-only</Text>}
    </div>
    {panelError ? <Banner className="mt-4" status="error" title="Alert rule update failed" description={panelError} isDismissable onDismiss={() => setPanelError("")} /> : null}
    {panelNotice ? <Banner className="mt-4" status="info" title="Alert rule status" description={panelNotice} isDismissable onDismiss={() => setPanelNotice("")} /> : null}
    {state === "loading" ? <Text as="p" type="supporting" color="secondary" display="block" className="mt-4">Loading alert rules...</Text> : null}
    {state === "error" ? <Banner className="mt-4" status="error" title="Alert rules unavailable" description="Alert rules could not be loaded." endContent={<Button label="Retry" variant="ghost" icon={<RefreshCw size={15} />} onClick={() => void load()} />} /> : null}
    {state === "ready" && rules.length === 0 ? <EmptyState className="mt-4" isCompact title="No alert rules configured" /> : null}
    {state === "ready" && rules.length > 0 ? <ul className="mt-4 divide-y divide-border border-y border-border">
      {rules.map((rule) => <li className="flex items-center justify-between gap-3 py-3" key={rule.id}>
        <span className="min-w-0"><Text weight="semibold" display="block" maxLines={1}>{rule.name ?? alertRuleTypes.find((type) => type.value === rule.alertType)?.label}</Text><Text type="supporting" color="secondary" display="block" className="mt-1">{`Threshold ${rule.threshold ?? 1} · ${rule.windowSeconds ? formatWindow(rule.windowSeconds) : "current value"} · ${scopeLabel(rule)}`}</Text></span>
        <div className="flex items-center gap-2">
          {canManage ? <Button label={rule.enabled ? "Enabled" : "Disabled"} variant="ghost" isDisabled={busyRuleId !== null} onClick={() => void toggle(rule)} /> : <Text type="supporting" color="secondary">{rule.enabled ? "Enabled" : "Disabled"}</Text>}
          {canManage ? <IconButton label="Test alert rule" tooltip="Test alert rule" variant="ghost" icon={<FlaskConical size={16} />} isDisabled={busyRuleId !== null} onClick={() => void test(rule)} /> : null}
          {canManage ? <IconButton label="Edit alert rule" tooltip="Edit alert rule" variant="ghost" icon={<Pencil size={16} />} isDisabled={busyRuleId !== null} onClick={() => openEdit(rule)} /> : null}
          {canManage ? <IconButton label="Delete alert rule" tooltip="Delete alert rule" variant="ghost" icon={<Trash2 size={16} />} isDisabled={busyRuleId !== null} onClick={() => { setRemoveError(""); setRemoving(rule); }} /> : null}
        </div>
      </li>)}
    </ul> : null}
    <AlertRuleFormDialog open={dialogOpen} editing={editing !== null} value={value} projectId={projectId} saving={saving} canSave={busyRuleId===null&&(editing===null||alertRuleChanged(value,editing))&&(value.scope.kind==="project"||Boolean(value.scope.endpointId))} error={formError} onOpenChange={(open) => { setDialogOpen(open); if (!open) { mutationKeys.clear("alert-rule.create"); setFormError(""); } }} onChange={setValue} onSubmit={save} />
    <DeleteAlertRuleDialog open={removing !== null} busy={busyRuleId !== null} error={removeError} onOpenChange={(open) => { if (!open && busyRuleId === null) { setRemoving(null); setRemoveError(""); } }} onConfirm={remove} />
  </section>;
}
function DeleteAlertRuleDialog({ open, busy, error, onOpenChange, onConfirm }: { open: boolean; busy: boolean; error: string; onOpenChange: (open: boolean) => void; onConfirm: () => Promise<void> }) {
  const handleOpenChange = (next: boolean) => !busy && onOpenChange(next);
  const descriptionId = useId();
  return (
    <Dialog
      className="[&_button]:min-h-11 [&_button]:min-w-11"
      isOpen={open}
      onOpenChange={handleOpenChange}
      role="alertdialog"
      purpose={busy ? "required" : "form"}
      padding={0}
      width="min(32rem, calc(100dvw - 1rem))"
      maxHeight="calc(100dvh - 1rem)"
      aria-label="Delete alert rule"
      aria-describedby={descriptionId}
    >
      <DialogHeader title="Delete alert rule" hasDivider />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <Text id={descriptionId} as="p" display="block" color="secondary">
          This permanently removes the rule from this project.
        </Text>
        <div className="mt-4">
          {error ? (
            <Banner
              status="error"
              title="Alert rule could not be deleted"
              description={error}
            />
          ) : null}
        </div>
      </div>
      <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:px-6 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal">
        <Button data-autofocus="" label="Cancel" type="button" variant="ghost" size="lg" isDisabled={busy} onClick={() => handleOpenChange(false)} />
        <Button label="Delete" type="button" variant="destructive" size="lg" isDisabled={busy} isLoading={busy} onClick={() => { if (!busy) void onConfirm(); }} />
      </div>
    </Dialog>
  );
}
function formatWindow(seconds:number){if(seconds%86400===0)return `${seconds/86400} day window`;if(seconds%3600===0)return `${seconds/3600} hour window`;return `${seconds} second window`;}
function scopeLabel(rule:ProjectAlertRule){const scope=rule.scope;if(!scope||scope.kind==="project")return "Project";return rule.endpointName??`Endpoint ${scope.endpointId}`;}
function alertRuleFormValue(rule: ProjectAlertRule): AlertRuleFormValue { const type=alertRuleType(rule.alertType);return {name:rule.name??type.label,alertType:type.value,metric:type.metric,threshold:rule.threshold??1,windowSeconds:rule.windowSeconds??type.defaultWindowSeconds,scope:rule.scope??{kind:"project"},enabled:rule.enabled}; }
function alertRuleChanged(value: AlertRuleFormValue, rule: ProjectAlertRule): boolean { const original=alertRuleFormValue(rule);return value.name!==original.name||value.alertType!==original.alertType||value.metric!==original.metric||value.threshold!==original.threshold||value.windowSeconds!==original.windowSeconds||value.enabled!==original.enabled||value.scope.kind!==original.scope.kind||(value.scope.kind==="endpoint"&&original.scope.kind==="endpoint"&&value.scope.endpointId!==original.scope.endpointId); }
function isMissingRule(error:unknown):boolean{return error instanceof ApiError&&error.status===404&&error.message==="Alert rule not found";}
function isRuleConflict(error:unknown):boolean{return error instanceof ApiError&&error.status===409&&error.message==="Alert rule changed elsewhere. Reload and try again.";}
