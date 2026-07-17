import { RotateCw, Trash2 } from "lucide-react";
import type { ProjectCredential } from "../../lib/api/client";
import { Button } from "../ui/button";

export function CredentialRow({
  credential,
  canManage,
  busy,
  onRotate,
  onDelete,
}: {
  credential: ProjectCredential;
  canManage: boolean;
  busy: boolean;
  onRotate: () => void;
  onDelete: () => void;
}) {
  return <article className="flex flex-wrap items-center justify-between gap-3 py-4">
    <div className="min-w-0">
      <p className="font-medium text-foreground">{credential.name}</p>
      <p className="mt-1 break-all text-sm text-secondary">{credential.baseUrl} <code className="ml-2">{credential.fingerprint}</code></p>
      <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-tertiary">
        <span>{credentialTypeLabel(credential.type)}</span>
        <span>Version {credential.version}</span>
        <span>{credential.lastRotatedAt ? `Rotated ${formatCredentialDate(credential.lastRotatedAt)}` : "Never rotated"}</span>
      </p>
    </div>
    {canManage ? <div className="flex gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={onRotate}><RotateCw size={15} />Rotate</Button>
      <Button size="icon" variant="danger" aria-label={`Delete ${credential.name}`} disabled={busy} onClick={onDelete}><Trash2 size={15} /></Button>
    </div> : null}
  </article>;
}

function credentialTypeLabel(type: ProjectCredential["type"]): string {
  return type === "api_key" ? "API key" : type;
}

function formatCredentialDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
