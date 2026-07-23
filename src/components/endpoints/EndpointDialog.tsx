"use client";

import { RefreshCw, Save, X } from "lucide-react";
import type { FormEvent } from "react";
import {
  Banner,
  Button,
  CheckboxInput,
  Dialog,
  DialogHeader,
  IconButton,
  Layout,
  LayoutContent,
  LayoutFooter,
  NumberInput,
  Selector,
  TextInput,
} from "@astryxdesign/core";
import type {
  EndpointCapability,
  EndpointInput,
  ProjectCredential,
} from "../../lib/api/client";
import { endpointCapabilities } from "./endpoints-page-utils";

export function EndpointDialog({
  open,
  input,
  editing,
  saving,
  discovering,
  models,
  canSubmit,
  canSave,
  nameConflict,
  error,
  credentials,
  onDiscoverModels,
  onDismissError,
  onOpenChange,
  onChange,
  onSubmit,
}: {
  open: boolean;
  input: EndpointInput;
  editing: boolean;
  saving: boolean;
  discovering: boolean;
  models: string[];
  canSubmit: boolean;
  canSave: boolean;
  nameConflict: boolean;
  error: string;
  credentials: ProjectCredential[];
  onDiscoverModels: () => void;
  onDismissError: () => void;
  onOpenChange: (open: boolean) => void;
  onChange: (value: EndpointInput) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const set = <K extends keyof EndpointInput>(
    key: K,
    value: EndpointInput[K],
  ) => onChange({ ...input, [key]: value });
  const toggle = (capability: EndpointCapability) =>
    set(
      "capabilities",
      input.capabilities.includes(capability)
        ? input.capabilities.filter((item) => item !== capability)
        : [...input.capabilities, capability],
    );
  const handleOpenChange = (next: boolean) => {
    if (!saving && !discovering) onOpenChange(next);
  };

  return (
    <Dialog
      isOpen={open}
      onOpenChange={handleOpenChange}
      purpose="form"
      width="min(34rem, calc(100vw - 2rem))"
      maxHeight="calc(100dvh - 2rem)"
      padding={0}
    >
      <form className="flex min-h-0 flex-1" onSubmit={onSubmit}>
        <Layout
          height="fill"
          defaultHasDividers
          header={
            <DialogHeader
              title={editing ? "Edit endpoint" : "Create endpoint"}
              subtitle="Configure an OpenAI-compatible model connection."
              onOpenChange={handleOpenChange}
            />
          }
          content={
            <LayoutContent>
              {error ? (
                <Banner
                  className="mb-4"
                  status="error"
                  title="Endpoint could not be saved"
                  description={error}
                  endContent={
                    <IconButton
                      type="button"
                      variant="ghost"
                      size="lg"
                      label="Dismiss endpoint error"
                      icon={<X size={15} />}
                      onClick={onDismissError}
                    />
                  }
                />
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <TextInput
                  label="Name"
                  value={input.name}
                  onChange={(value) => set("name", value.slice(0, 160))}
                  isRequired
                  isDisabled={saving}
                  {...(nameConflict && { status: { type: "error", message: "An endpoint already uses this name." } as const })}
                  width="100%"
                />
                <TextInput
                  label="Model"
                  value={input.model}
                  onChange={(value) => set("model", value)}
                  isRequired
                  isDisabled={saving}
                  width="100%"
                />
                <div className="sm:col-span-2">
                  <TextInput
                    label="Base URL"
                    value={input.baseUrl}
                    isRequired
                    isDisabled
                    disabledMessage="Base URL is provided by the selected credential."
                    width="100%"
                  />
                </div>
                <Selector
                  label="Credential"
                  isRequired
                  options={credentials.map((credential) => ({
                    value: credential.id,
                    label: `${credential.name} (${credential.fingerprint})`,
                  }))}
                  value={input.credentialId}
                  onChange={(credentialId) => {
                    const credential = credentials.find(
                      (item) => item.id === credentialId,
                    );
                    onChange({
                      ...input,
                      credentialId,
                      ...(credential ? { baseUrl: credential.baseUrl } : {}),
                    });
                  }}
                  placeholder="Select credential"
                  isDisabled={saving || discovering}
                  size="lg"
                  width="100%"
                />
                <NumberInput
                  label="Timeout"
                  value={input.requestTimeoutSecs}
                  onChange={(value) => set("requestTimeoutSecs", value)}
                  min={1}
                  units="seconds"
                  isRequired
                  isDisabled={saving}
                  size="lg"
                  width="100%"
                />
                <div className="flex items-end gap-2 sm:col-span-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="lg"
                    label={discovering ? "Checking" : "Discover models"}
                    icon={
                      <RefreshCw
                        className={discovering ? "animate-spin" : ""}
                        size={15}
                      />
                    }
                    onClick={onDiscoverModels}
                    isDisabled={
                      !canSubmit ||
                      saving ||
                      discovering ||
                      !input.baseUrl ||
                      !input.credentialId
                    }
                  />
                  {models.length > 0 ? (
                    <Selector
                      label="Discovered models"
                      options={models.map((model) => ({ value: model, label: model }))}
                      value={models.includes(input.model) ? input.model : ""}
                      onChange={(model) => set("model", model)}
                      placeholder="Choose discovered model"
                      isDisabled={saving || discovering}
                      size="lg"
                      className="max-w-sm"
                    />
                  ) : null}
                </div>
                <fieldset className="grid gap-2 sm:col-span-2">
                  <legend className="text-sm text-primary">Capabilities</legend>
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    {endpointCapabilities.map((capability) => (
                      <CheckboxInput
                        key={capability}
                        label={capability === "tool_calls"
                          ? "Tool calls"
                          : capability[0]!.toUpperCase() + capability.slice(1)}
                        value={input.capabilities.includes(capability)}
                        isDisabled={
                          saving ||
                          (input.capabilities.length === 1 &&
                            input.capabilities.includes(capability))
                        }
                        onChange={() => toggle(capability)}
                      />
                    ))}
                  </div>
                </fieldset>
              </div>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  label="Cancel"
                  onClick={() => handleOpenChange(false)}
                  isDisabled={saving || discovering}
                />
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  label="Save"
                  icon={<Save size={15} />}
                  isDisabled={
                    !canSubmit ||
                    !canSave ||
                    saving ||
                    discovering ||
                    !input.credentialId ||
                    input.capabilities.length === 0
                  }
                />
              </div>
            </LayoutFooter>
          }
        />
      </form>
    </Dialog>
  );
}
