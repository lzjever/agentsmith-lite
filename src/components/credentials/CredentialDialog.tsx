import {
  Banner,
  Button,
  Dialog,
  DialogHeader,
  TextInput,
} from "@astryxdesign/core";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { CredentialSecretField } from "./CredentialSecretField";

export function CredentialDialog({ open, onOpenChange, title, busy, error, onSubmit, submit, includeName = false }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; busy: boolean; error: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; submit: string; includeName?: boolean }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [secret, setSecret] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formId = useId();
  useEffect(() => {
    if (open) {
      setName("");
      setBaseUrl("");
      setSecret("");
    }
  }, [open]);
  useEffect(() => {
    if (!open || includeName) return;
    const frame = requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('input[name="secret"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [includeName, open]);
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
      className="[&_button]:min-h-11 [&_button]:min-w-11"
      ref={dialogRef}
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
        subtitle="The secret is sent once and is never displayed again."
        hasDivider
        {...(!busy ? { onOpenChange: handleOpenChange } : {})}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
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
                data-autofocus=""
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
            <CredentialSecretField value={secret} onChange={setSecret} disabled={busy} hasAutoFocus={!includeName} />
          </div>
        </form>
      </div>
      <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:px-6 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal">
        <Button
          label="Cancel"
          type="button"
          variant="ghost"
          size="lg"
          isDisabled={busy}
          onClick={() => handleOpenChange(false)}
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
