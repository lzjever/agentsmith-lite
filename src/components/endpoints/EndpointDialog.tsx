"use client";

import { RefreshCw, Save, X } from "lucide-react";
import { type FormEvent, useId } from "react";
import {
  Banner,
  Button,
  CheckboxInput,
  IconButton,
  NumberInput,
  Selector,
  Text,
  TextInput,
} from "@astryxdesign/core";
import type {
  EndpointCapability,
  EndpointInput,
} from "../../lib/api/client";
import { CredentialPicker } from "../providers/ProviderDirectoryPicker";
import { Dialog } from "../ui/Dialog";
import { endpointCapabilities } from "./endpoints-page-utils";

export function EndpointDialog({
  open,
  input,
  editing,
  saving,
  discovering,
  models,
  discoveryGuidance,
  canSubmit,
  canSave,
  nameConflict,
  error,
  projectId,
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
  discoveryGuidance: string;
  canSubmit: boolean;
  canSave: boolean;
  nameConflict: boolean;
  error: string;
  projectId:string;
  onDiscoverModels: () => void;
  onDismissError: () => void;
  onOpenChange: (open: boolean) => void;
  onChange: (value: EndpointInput) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const formId = useId();
  const title = editing ? "Edit endpoint" : "Create endpoint";
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
      title={title}
      subtitle="Configure an OpenAI-compatible model connection."
      busy={saving || discovering}
      primaryAction={
        <Button
          type="submit"
          form={formId}
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
      }
    >
      <form id={formId} onSubmit={onSubmit}>
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
                      tooltip="Dismiss endpoint error"
                      icon={<X size={15} />}
                      onClick={onDismissError}
                    />
                  }
                />
              ) : null}
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <TextInput
                  label="Name"
                  value={input.name}
                  onChange={(value) => set("name", value.slice(0, 160))}
                  isRequired
                  isDisabled={saving}
                  {...(nameConflict && { status: { type: "error", message: "An endpoint already uses this name." } as const })}
                  width="100%"
                />
                <div>
                  <TextInput
                    label="Model"
                    value={input.model}
                    onChange={(value) => set("model", value)}
                    isRequired
                    isDisabled={saving}
                    width="100%"
                  />
                  {discoveryGuidance ? (
                    <Text
                      as="p"
                      type="supporting"
                      color="secondary"
                      display="block"
                      className="mt-1"
                      role="status"
                    >
                      {discoveryGuidance}
                    </Text>
                  ) : null}
                </div>
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
                <CredentialPicker projectId={projectId} value={input.credentialId} disabled={saving||discovering} onChange={(credential)=>onChange({...input,credentialId:credential.id,baseUrl:credential.baseUrl})} onUnavailable={()=>onChange({...input,credentialId:"",baseUrl:""})}/>
                <div className="min-w-0">
                  <NumberInput
                    label="Timeout (seconds)"
                    value={input.requestTimeoutSecs}
                    onChange={(value) => set("requestTimeoutSecs", value)}
                    min={1}
                    isRequired
                    isDisabled={saving}
                    size="lg"
                    width="100%"
                  />
                </div>
                <div className="flex items-end gap-2 sm:col-span-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="lg"
                    label={discovering ? "Checking" : "Discover models"}
                    icon={
                      <RefreshCw size={15} />
                    }
                    isLoading={discovering}
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
                  <legend><Text type="label">Capabilities</Text></legend>
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
      </form>
    </Dialog>
  );
}
