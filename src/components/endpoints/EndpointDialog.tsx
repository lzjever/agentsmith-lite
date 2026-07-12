"use client";

import { RefreshCw, Save, X } from "lucide-react";
import type { FormEvent } from "react";
import type {
  EndpointCapability,
  EndpointInput,
  ProjectCredential,
} from "../../lib/api/client";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { endpointCapabilities } from "./endpoints-page-utils";

export function EndpointDialog({
  open,
  input,
  editing,
  saving,
  discovering,
  models,
  canSubmit,
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit}>
          <DialogHeader
            title={editing ? "Edit endpoint" : "Create endpoint"}
            description="Configure an OpenAI-compatible Chat Completions connection."
          />
          {error ? (
            <div
              className="mx-5 mt-4 flex items-start justify-between gap-3 rounded-sm border border-error/30 bg-error/10 px-3 py-2 text-sm text-error"
              role="alert"
            >
              <span>{error}</span>
              <Button
                type="button"
                variant="quiet"
                size="icon"
                aria-label="Dismiss endpoint error"
                onClick={onDismissError}
              >
                <X size={15} />
              </Button>
            </div>
          ) : null}
          <div className="grid gap-4 px-5 py-5 sm:grid-cols-2">
            <label>
              Name
              <Input
                required
                value={input.name}
                onChange={(event) => set("name", event.target.value)}
              />
            </label>
            <label>
              Model
              <Input
                required
                value={input.model}
                onChange={(event) => set("model", event.target.value)}
              />
            </label>
            <label className="sm:col-span-2">
              Base URL
              <Input
                required
                type="url"
                value={input.baseUrl}
                onChange={(event) => set("baseUrl", event.target.value)}
              />
            </label>
            <div className="grid gap-2">
              <Label htmlFor="endpoint-credential">Credential</Label>
              <Select
                required
                value={input.credentialId}
                onValueChange={(credentialId) => {
                  const credential = credentials.find(
                    (item) => item.id === credentialId,
                  );
                  onChange({
                    ...input,
                    credentialId,
                    ...(credential ? { baseUrl: credential.baseUrl } : {}),
                  });
                }}
                disabled={saving || discovering}
              >
                <SelectTrigger id="endpoint-credential">
                  <SelectValue placeholder="Select credential" />
                </SelectTrigger>
                <SelectContent>
                  {credentials.map((credential) => (
                    <SelectItem key={credential.id} value={credential.id}>
                      {credential.name} ({credential.fingerprint})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label>
              Timeout
              <Input
                required
                type="number"
                min="1"
                value={input.requestTimeoutSecs}
                onChange={(event) =>
                  set("requestTimeoutSecs", Number(event.target.value))
                }
              />
            </label>
            <div className="flex items-end gap-2 sm:col-span-2">
              <Button
                type="button"
                variant="outline"
                onClick={onDiscoverModels}
                disabled={
                  !canSubmit ||
                  saving ||
                  discovering ||
                  !input.baseUrl ||
                  !input.credentialId
                }
              >
                <RefreshCw
                  className={discovering ? "animate-spin" : ""}
                  size={15}
                />
                {discovering ? "Checking" : "Discover models"}
              </Button>
              {models.length > 0 ? (
                <Select
                  value={models.includes(input.model) ? input.model : ""}
                  onValueChange={(model) => set("model", model)}
                  disabled={saving || discovering}
                >
                  <SelectTrigger
                    aria-label="Discovered models"
                    className="max-w-sm"
                  >
                    <SelectValue placeholder="Choose discovered model" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((model) => (
                      <SelectItem key={model} value={model}>
                        {model}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>
            <fieldset className="grid gap-2 sm:col-span-2">
              <legend className="text-sm text-primary">Capabilities</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {endpointCapabilities.map((capability) => (
                  <label
                    key={capability}
                    className="flex items-center gap-2 text-sm text-secondary"
                  >
                    <Checkbox
                      checked={input.capabilities.includes(capability)}
                      disabled={
                        saving ||
                        (input.capabilities.length === 1 &&
                          input.capabilities.includes(capability))
                      }
                      onChange={() => toggle(capability)}
                    />
                    {capability === "tool_calls"
                      ? "Tool calls"
                      : capability[0]!.toUpperCase() + capability.slice(1)}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="quiet"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !canSubmit ||
                saving ||
                !input.credentialId ||
                input.capabilities.length === 0
              }
            >
              {" "}
              <Save size={15} />
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
