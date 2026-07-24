import {
  Banner,
  Button,
  DialogHeader,
  Layout,
  LayoutContent,
  LayoutFooter,
  TextInput,
} from "@astryxdesign/core";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Dialog } from "../ui/Dialog";
import { CredentialSecretField } from "./CredentialSecretField";

export function CredentialDialog({ open, onOpenChange, title, busy, error, onSubmit, submit, includeName = false }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; busy: boolean; error: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; submit: string; includeName?: boolean }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [secret, setSecret] = useState("");
  const formId = useId();
  useEffect(() => {
    if (open) {
      setName("");
      setBaseUrl("");
      setSecret("");
    }
  }, [open]);
  const handleOpenChange = (next: boolean) => {
    if (!busy) onOpenChange(next);
  };
  const baseUrlValid = !includeName || isValidHttpUrl(baseUrl);
  const canSubmit = secret.length > 0 && (!includeName || name.trim().length > 0 && baseUrl.length > 0 && baseUrlValid);
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (busy || !canSubmit) {
      event.preventDefault();
      return;
    }
    onSubmit(event);
  };
  return (
    <Dialog
      isOpen={open}
      onOpenChange={handleOpenChange}
      purpose="form"
      width="min(34rem, calc(100vw - 2rem))"
      aria-label={title}
    >
      <Layout
        height="fill"
        defaultHasDividers
        header={
          <DialogHeader
            title={title}
            subtitle="The secret is sent once and is never displayed again."
            onOpenChange={handleOpenChange}
          />
        }
        content={
          <LayoutContent>
            <form id={formId} onSubmit={handleSubmit}>
              {error ? (
                <Banner
                  className="mb-4"
                  status="error"
                  title="Credential could not be saved"
                  description={error}
                />
              ) : null}
              <div className="grid gap-4">
                {includeName ? (
                  <TextInput
                    label="Name"
                    htmlName="name"
                    value={name}
                    onChange={(value) => setName(value.slice(0, 160))}
                    isRequired
                    hasAutoFocus
                    isDisabled={busy}
                    width="100%"
                  />
                ) : null}
                {includeName ? (
                  <TextInput
                    label="Base URL"
                    htmlName="baseUrl"
                    value={baseUrl}
                    onChange={setBaseUrl}
                    isRequired
                    placeholder="https://api.example.com/v1"
                    isDisabled={busy}
                    {...(baseUrl.length > 0 && !baseUrlValid && {
                      status: {
                        type: "error",
                        message: "Enter a valid HTTP or HTTPS URL.",
                      } as const,
                    })}
                    width="100%"
                  />
                ) : null}
                <CredentialSecretField value={secret} onChange={setSecret} disabled={busy} />
              </div>
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
                onClick={() => handleOpenChange(false)}
                isDisabled={busy}
              />
              <Button
                label={busy ? "Working..." : submit}
                type="submit"
                form={formId}
                variant="primary"
                size="lg"
                isDisabled={busy || !canSubmit}
                isLoading={busy}
              />
            </div>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}
