"use client";

import { Save } from "lucide-react";
import type { FormEvent } from "react";
import type { Endpoint, ProjectAlertType } from "../../lib/api/client";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

export const alertRuleTypes: Array<{ value: ProjectAlertType; label: string }> = [
  { value: "active_tasks_limit", label: "Task capacity" }, { value: "provider_requests_limit", label: "Provider requests" },
  { value: "provider_tokens_limit", label: "Provider tokens" }, { value: "provider_cost_limit", label: "Provider cost" },
  { value: "project_file_bytes_limit", label: "File storage" }, { value: "endpoint_failure", label: "Endpoint failure" },
  { value: "provider_failure", label: "Provider failure" }, { value: "task_failure", label: "Task failure" },
  { value: "sandbox_failure", label: "Sandbox failure" }
];

export interface AlertRuleFormValue { name: string; alertType: ProjectAlertType; threshold: number; windowSeconds: number | null; scope: { kind: "project" } | { kind: "endpoint"; endpointId: string }; enabled: boolean; }

export function AlertRuleFormDialog({ open, editing, value, endpoints, saving, error, onOpenChange, onChange, onSubmit }: {
  open: boolean; editing: boolean; value: AlertRuleFormValue; endpoints: Endpoint[]; saving: boolean; error: string;
  onOpenChange: (open: boolean) => void; onChange: (value: AlertRuleFormValue) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}><DialogContent><form onSubmit={onSubmit}>
    <DialogHeader title={editing ? "Edit alert rule" : "Create alert rule"} description="Evaluate one allowlisted project or endpoint metric and notify in product." />
    <div className="grid gap-4 px-5 py-5">
      {error ? <p role="alert" className="rounded-sm border border-error/40 bg-error/5 px-3 py-2 text-sm text-error">{error}</p> : null}
      <Label className="grid gap-2 text-sm text-primary">Name<Input aria-label="Rule name" value={value.name} maxLength={80} required disabled={saving} onChange={(event) => onChange({ ...value, name: event.target.value })} /></Label>
      <Label className="grid gap-2 text-sm text-primary">Alert type<Select value={value.alertType} onValueChange={(alertType) => onChange({ ...value, alertType: alertType as ProjectAlertType })} disabled={saving}><SelectTrigger aria-label="Alert type"><SelectValue /></SelectTrigger><SelectContent>{alertRuleTypes.map((type) => <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>)}</SelectContent></Select></Label>
      <div className="grid gap-4 sm:grid-cols-2">
        <Label className="grid gap-2 text-sm text-primary">Threshold<Input aria-label="Threshold" type="number" min="0" step="any" value={value.threshold} required disabled={saving} onChange={(event) => onChange({ ...value, threshold: Number(event.target.value) })} /></Label>
        <Label className="grid gap-2 text-sm text-primary">Window<Select value={value.windowSeconds === null ? "current" : String(value.windowSeconds)} onValueChange={(next) => onChange({ ...value, windowSeconds: next === "current" ? null : Number(next) })} disabled={saving}><SelectTrigger aria-label="Evaluation window"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="current">Current value</SelectItem><SelectItem value="3600">Last hour</SelectItem><SelectItem value="86400">Last 24 hours</SelectItem><SelectItem value="604800">Last 7 days</SelectItem></SelectContent></Select></Label>
      </div>
      <Label className="grid gap-2 text-sm text-primary">Scope<Select value={value.scope.kind === "project" ? "project" : value.scope.endpointId} onValueChange={(next) => onChange({ ...value, scope: next === "project" ? { kind: "project" } : { kind: "endpoint", endpointId: next } })} disabled={saving}><SelectTrigger aria-label="Rule scope"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="project">Entire project</SelectItem>{endpoints.map((endpoint) => <SelectItem value={endpoint.id} key={endpoint.id}>{endpoint.name}</SelectItem>)}</SelectContent></Select></Label>
      <Label className="flex items-center gap-3 text-sm text-primary"><Checkbox checked={value.enabled} disabled={saving} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} />Enabled</Label>
    </div>
    <DialogFooter><Button type="button" variant="quiet" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={saving}><Save size={15} />{saving ? "Saving..." : editing ? "Save changes" : "Create rule"}</Button></DialogFooter>
  </form></DialogContent></Dialog>;
}
