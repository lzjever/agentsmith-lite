import { Button, Dialog, DialogHeader, TextInput } from "@astryxdesign/core";
import { type FormEvent, useEffect, useState } from "react";
import { CredentialSecretField } from "./CredentialSecretField";

export function CredentialDialog({ open, onOpenChange, title, busy, onSubmit, submit, includeName = false }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; busy: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void; submit: string; includeName?: boolean }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [secret, setSecret] = useState("");
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
  return <Dialog isOpen={open} onOpenChange={handleOpenChange} purpose="form" width="min(34rem, calc(100vw - 2rem))" padding={0} aria-label={title}><form onSubmit={handleSubmit}><DialogHeader title={title} subtitle="The secret is sent once and is never displayed again." onOpenChange={handleOpenChange} hasDivider /><div className="grid gap-4 px-5 py-5">{includeName ? <TextInput label="Name" htmlName="name" value={name} onChange={(value) => setName(value.slice(0, 160))} isRequired hasAutoFocus isDisabled={busy} width="100%" /> : null}{includeName ? <TextInput label="Base URL" htmlName="baseUrl" value={baseUrl} onChange={setBaseUrl} isRequired placeholder="https://api.example.com/v1" isDisabled={busy} {...(baseUrl.length > 0 && !baseUrlValid && { status: { type: "error", message: "Enter a valid HTTP or HTTPS URL." } as const })} width="100%" /> : null}<CredentialSecretField value={secret} onChange={setSecret} disabled={busy} /></div><footer className="flex flex-col-reverse gap-2 border-t border-subtle px-5 py-4 sm:flex-row sm:justify-end md:px-6"><Button label="Cancel" type="button" variant="ghost" size="lg" onClick={() => handleOpenChange(false)} isDisabled={busy} /><Button label={busy ? "Working..." : submit} type="submit" variant="primary" size="lg" isDisabled={busy || !canSubmit} /></footer></form></Dialog>;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}
