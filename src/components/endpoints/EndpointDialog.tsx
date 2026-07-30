"use client";

import { RefreshCw, Save, X } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import {
  Banner,
  Button,
  CheckboxInput,
  Dialog,
  DialogHeader,
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
import { isValidEndpointRequestTimeout } from "../providers/providerFormValidation";
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
  const timeoutParentValid=isValidEndpointRequestTimeout(input.requestTimeoutSecs);
  const [timeoutRawValid,setTimeoutRawValid]=useState(timeoutParentValid);
  useEffect(()=>setTimeoutRawValid(timeoutParentValid),[open,input.requestTimeoutSecs,timeoutParentValid]);
  const timeoutValid=timeoutParentValid&&timeoutRawValid;
  const handleSubmit=(event:FormEvent<HTMLFormElement>)=>{
    if(!timeoutValid){
      event.preventDefault();
      return;
    }
    onSubmit(event);
  };

  return (
    <Dialog
      className="[&_button]:min-h-11 [&_button]:min-w-11"
      isOpen={open}
      onOpenChange={handleOpenChange}
      purpose="form"
      padding={0}
      width="min(42rem, calc(100dvw - 1rem))"
      maxHeight="calc(100dvh - 1rem)"
      aria-label={title}
    >
      <DialogHeader
        className="p-4 sm:px-6"
        title={title}
        subtitle="Configure an OpenAI-compatible model connection."
        hasDivider
        {...(!saving && !discovering ? { onOpenChange: handleOpenChange } : {})}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <form id={formId} onSubmit={handleSubmit}>
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
              hasAutoFocus
              data-autofocus=""
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
            <CredentialPicker projectId={projectId} value={input.credentialId} label="Endpoint credential" disabled={saving||discovering} onChange={(credential)=>onChange({...input,credentialId:credential.id,baseUrl:credential.baseUrl})} onUnavailable={()=>onChange({...input,credentialId:"",baseUrl:""})}/>
            <div className="min-w-0">
              <NumberInput
                label="Timeout (seconds)"
                value={input.requestTimeoutSecs}
                onChange={(value) => {
                  setTimeoutRawValid(true);
                  set("requestTimeoutSecs", value);
                }}
                onInput={(event) => {
                  const raw=(event.currentTarget as HTMLInputElement).value.trim();
                  setTimeoutRawValid(raw.length>0&&isValidEndpointRequestTimeout(Number(raw)));
                }}
                onBlur={() => setTimeoutRawValid(timeoutParentValid)}
                min={1}
                max={600}
                isIntegerOnly
                isRequired
                isDisabled={saving}
                {...(!timeoutValid&&{status:{type:"error",message:"Enter a whole number from 1 to 600."} as const})}
                size="lg"
                width="100%"
              />
            </div>
            <div className="grid items-end gap-2 sm:col-span-2 sm:grid-cols-[auto_minmax(0,1fr)]">
              <Button
                type="button"
                variant="ghost"
                size="lg"
                label={discovering ? "Checking" : "Discover models"}
                icon={<RefreshCw size={15} />}
                isLoading={discovering}
                onClick={onDiscoverModels}
                isDisabled={
                  !canSubmit ||
                  !timeoutValid ||
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
                  width="100%"
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
      </div>
      <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:px-6 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal">
        <Button
          type="button"
          variant="ghost"
          size="lg"
          label="Cancel"
          isDisabled={saving || discovering}
          onClick={() => handleOpenChange(false)}
        />
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
            !timeoutValid ||
            saving ||
            discovering ||
            !input.credentialId ||
            input.capabilities.length === 0
          }
          isLoading={saving}
        />
      </div>
    </Dialog>
  );
}
