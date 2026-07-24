"use client";

import { Save } from "lucide-react";
import { type FormEvent, useId } from "react";
import {
  Banner,
  Button,
  CheckboxInput,
  DialogHeader,
  Layout,
  LayoutContent,
  LayoutFooter,
  NumberInput,
  Selector,
  TextInput,
} from "@astryxdesign/core";
import type { AlertRuleMetric } from "../../../packages/contracts/src/api.js";
import type { Endpoint, ProjectAlertType } from "../../lib/api/client";
import { Dialog } from "../ui/Dialog";

export const alertRuleTypes: Array<{ value: ProjectAlertType; label: string; metric: AlertRuleMetric; defaultWindowSeconds: number | null }> = [
  { value: "active_tasks_limit", label: "Task capacity", metric: "active_tasks", defaultWindowSeconds: null },
  { value: "provider_requests_limit", label: "Provider requests", metric: "provider_requests", defaultWindowSeconds: null },
  { value: "provider_tokens_limit", label: "Provider tokens", metric: "provider_tokens", defaultWindowSeconds: null },
  { value: "provider_cost_limit", label: "Provider cost", metric: "provider_cost", defaultWindowSeconds: null },
  { value: "project_file_bytes_limit", label: "File storage", metric: "project_file_bytes", defaultWindowSeconds: null },
  { value: "endpoint_failure", label: "Endpoint failure", metric: "failure_count", defaultWindowSeconds: 3600 },
  { value: "provider_failure", label: "Provider failure", metric: "failure_count", defaultWindowSeconds: 3600 },
  { value: "sandbox_failure", label: "Sandbox failure", metric: "failure_count", defaultWindowSeconds: 3600 },
];

export interface AlertRuleFormValue { name: string; alertType: ProjectAlertType; metric: AlertRuleMetric; threshold: number; windowSeconds: number | null; scope: { kind: "project" } | { kind: "endpoint"; endpointId: string }; enabled: boolean; }

const standardWindowSeconds = new Set([3600, 86400, 604800]);

export function AlertRuleFormDialog({ open, editing, value, endpoints, saving, canSave, error, onOpenChange, onChange, onSubmit }: {
  open: boolean; editing: boolean; value: AlertRuleFormValue; endpoints: Endpoint[]; saving: boolean; error: string;
  canSave: boolean;
  onOpenChange: (open: boolean) => void; onChange: (value: AlertRuleFormValue) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const title = editing ? "Edit alert rule" : "Create alert rule";
  const description = "Monitor one project or endpoint metric and notify project administrators.";
  const handleOpenChange = (next: boolean) => !saving && onOpenChange(next);
  const formId = useId();

  return (
    <Dialog
      isOpen={open}
      onOpenChange={handleOpenChange}
      purpose="form"
      width="min(34rem, calc(100vw - 2rem))"
      maxHeight="calc(100dvh - 2rem)"
      aria-label={title}
    >
      <Layout
        height="fill"
        defaultHasDividers
        header={
          <DialogHeader
            title={title}
            subtitle={description}
            onOpenChange={handleOpenChange}
          />
        }
        content={
          <LayoutContent>
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
                value={value.metric.replaceAll("_", " ")}
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
                    ...(value.metric !== "failure_count" ? [{ value: "current", label: "Current value" }] : []),
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
                  ...(supportsEndpointScope(value.alertType)
                    ? endpoints.map((endpoint) => ({ value: endpoint.id, label: endpoint.name }))
                    : []),
                ]}
                value={value.scope.kind === "project" ? "project" : value.scope.endpointId}
                onChange={(next) =>
                  onChange({
                    ...value,
                    scope: next === "project"
                      ? { kind: "project" }
                      : { kind: "endpoint", endpointId: next },
                  })
                }
                isDisabled={saving || !supportsEndpointScope(value.alertType)}
                size="lg"
              />
              <CheckboxInput
                label="Enabled"
                value={value.enabled}
                isDisabled={saving}
                onChange={(enabled) => onChange({ ...value, enabled })}
              />
            </form>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
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
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

export function alertRuleType(alertType: ProjectAlertType) {
  return alertRuleTypes.find((type) => type.value === alertType) ?? alertRuleTypes[0]!;
}
function supportsEndpointScope(type:ProjectAlertType){return type!=="active_tasks_limit"&&type!=="project_file_bytes_limit";}
