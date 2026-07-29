"use client";

import { Save } from "lucide-react";
import { type FormEvent, useId } from "react";
import {
  Banner,
  Button,
  CheckboxInput,
  Dialog as AstryxDialog,
  DialogHeader,
  NumberInput,
  Selector,
  TextInput,
} from "@astryxdesign/core";
import type { AlertRuleMetric } from "../../../packages/contracts/src/api.js";
import type { ProjectAlertType } from "../../lib/api/client";
import { EndpointPicker } from "../providers/ProviderDirectoryPicker";

export const alertRuleTypes: Array<{ value: ProjectAlertType; label: string; metric: AlertRuleMetric; defaultWindowSeconds: number | null }> = [
  { value: "sandbox_capacity", label: "Sandbox capacity", metric: "active_sandboxes", defaultWindowSeconds: null },
  { value: "provider_requests_limit", label: "Provider requests", metric: "provider_requests", defaultWindowSeconds: 3600 },
  { value: "provider_tokens_limit", label: "Provider tokens", metric: "provider_tokens", defaultWindowSeconds: 3600 },
  { value: "provider_cost_limit", label: "Provider cost", metric: "provider_cost", defaultWindowSeconds: 3600 },
  { value: "project_file_bytes_limit", label: "File storage", metric: "project_file_bytes", defaultWindowSeconds: null },
  { value: "endpoint_failure", label: "Endpoint failure", metric: "failure_count", defaultWindowSeconds: 3600 },
  { value: "provider_failure", label: "Provider failure", metric: "failure_count", defaultWindowSeconds: 3600 },
  { value: "sandbox_failure", label: "Sandbox failure", metric: "failure_count", defaultWindowSeconds: 3600 },
];

export interface AlertRuleFormValue { name: string; alertType: ProjectAlertType; metric: AlertRuleMetric; threshold: number; windowSeconds: number | null; scope: { kind: "project" } | { kind: "endpoint"; endpointId: string }; enabled: boolean; }

const standardWindowSeconds = new Set([3600, 86400, 604800]);

export function AlertRuleFormDialog({ open, editing, value, projectId, saving, canSave, error, onOpenChange, onChange, onSubmit }: {
  open: boolean; editing: boolean; value: AlertRuleFormValue; projectId:string;saving: boolean; error: string;
  canSave: boolean;
  onOpenChange: (open: boolean) => void; onChange: (value: AlertRuleFormValue) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const title = editing ? "Edit alert rule" : "Create alert rule";
  const description = "Monitor one project or endpoint metric and notify project administrators.";
  const handleOpenChange = (next: boolean) => !saving && onOpenChange(next);
  const formId = useId();

  return (
    <AstryxDialog
      className="[&_button]:min-h-11 [&_button]:min-w-11"
      isOpen={open}
      onOpenChange={handleOpenChange}
      purpose="form"
      padding={0}
      width="min(34rem, calc(100dvw - 1rem))"
      maxHeight="calc(100dvh - 1rem)"
      aria-label={title}
    >
      <DialogHeader
        title={title}
        subtitle={description}
        hasDivider
        {...(!saving ? { onOpenChange: handleOpenChange } : {})}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <form id={formId} className="grid gap-4" onSubmit={onSubmit}>
          {error ? (
            <Banner
              status="error"
              title="Alert rule could not be saved"
              description={error}
            />
          ) : null}
          <TextInput
            label="Name"
            value={value.name}
            onChange={(name) => onChange({ ...value, name: name.slice(0, 80) })}
            isRequired
            hasAutoFocus
            data-autofocus=""
            isDisabled={saving}
            width="100%"
          />
          <Selector
            label="Alert type"
            options={alertRuleTypes.map((type) => ({ value: type.value, label: type.label }))}
            value={value.alertType}
            onChange={(alertType) => {
              const type = alertRuleType(alertType as ProjectAlertType);
              onChange({
                ...value,
                alertType: type.value,
                metric: type.metric,
                windowSeconds: type.defaultWindowSeconds,
                scope: supportsEndpointScope(type.value) ? value.scope : { kind: "project" },
              });
            }}
            isDisabled={saving}
            size="lg"
          />
          <TextInput
            label="Metric"
            value={value.metric === "active_sandboxes" ? "Active sandboxes" : value.metric.replaceAll("_", " ")}
            isDisabled
            disabledMessage="Metric is determined by the alert type."
            width="100%"
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberInput
              label="Threshold"
              value={value.threshold}
              min={0}
              onChange={(threshold) => onChange({ ...value, threshold })}
              isRequired
              isDisabled={saving}
              size="lg"
              width="100%"
            />
            <Selector
              label="Window"
              options={[
                ...(supportsCurrentValue(value.metric) ? [{ value: "current", label: "Current value" }] : []),
                ...(value.windowSeconds !== null && !standardWindowSeconds.has(value.windowSeconds)
                  ? [{ value: String(value.windowSeconds), label: `${value.windowSeconds} seconds (current)` }]
                  : []),
                { value: "3600", label: "Last hour" },
                { value: "86400", label: "Last 24 hours" },
                { value: "604800", label: "Last 7 days" },
              ]}
              value={value.windowSeconds === null ? "current" : String(value.windowSeconds)}
              onChange={(next) => onChange({ ...value, windowSeconds: next === "current" ? null : Number(next) })}
              isDisabled={saving}
              size="lg"
            />
          </div>
          <Selector
            label="Scope"
            options={[
              { value: "project", label: "Entire project" },
              ...(supportsEndpointScope(value.alertType)?[{value:"endpoint",label:"One endpoint"}]:[]),
            ]}
            value={value.scope.kind}
            onChange={(next) =>
              onChange({
                ...value,
                scope: next === "project"
                  ? { kind: "project" }
                  : { kind: "endpoint", endpointId: value.scope.kind==="endpoint"?value.scope.endpointId:"" },
              })
            }
            isDisabled={saving || !supportsEndpointScope(value.alertType)}
            size="lg"
          />
          {supportsEndpointScope(value.alertType)&&value.scope.kind==="endpoint"?<EndpointPicker projectId={projectId} value={value.scope.endpointId} label="Endpoint scope" disabled={saving} onChange={(endpoint)=>onChange({...value,scope:{kind:"endpoint",endpointId:endpoint.id}})} onUnavailable={()=>onChange({...value,scope:{kind:"endpoint",endpointId:""}})}/>:null}
          <CheckboxInput
            label="Enabled"
            value={value.enabled}
            isDisabled={saving}
            onChange={(enabled) => onChange({ ...value, enabled })}
          />
        </form>
      </div>
      <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:px-6 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal">
        <Button
          label="Cancel"
          type="button"
          variant="ghost"
          size="lg"
          isDisabled={saving}
          onClick={() => handleOpenChange(false)}
        />
        <Button
          label={saving ? "Saving..." : editing ? "Save changes" : "Create rule"}
          type="submit"
          form={formId}
          variant="primary"
          size="lg"
          icon={<Save size={15} />}
          isDisabled={saving || !canSave}
          isLoading={saving}
        />
      </div>
    </AstryxDialog>
  );
}

export function alertRuleType(alertType: ProjectAlertType) {
  return alertRuleTypes.find((type) => type.value === alertType) ?? alertRuleTypes[0]!;
}
function supportsEndpointScope(type:ProjectAlertType){return type!=="sandbox_capacity"&&type!=="project_file_bytes_limit";}
function supportsCurrentValue(metric:AlertRuleMetric){return metric==="active_sandboxes"||metric==="project_file_bytes";}
