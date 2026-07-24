import { RotateCw, Trash2 } from "lucide-react";
import { Button, IconButton, Text } from "@astryxdesign/core";
import type { ProjectCredential } from "../../lib/api/client";
import { formatLocalDateTime } from "../../lib/format/date";

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
      <Text as="p" display="block" weight="medium">{credential.name}</Text>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Text type="supporting" wordBreak="break-all">{credential.baseUrl}</Text>
        <Text type="code" size="2xs">{credential.fingerprint}</Text>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        <Text type="supporting">{credentialTypeLabel(credential.type)}</Text>
        <Text type="supporting">Version {credential.version}</Text>
        <Text type="supporting">{credential.lastRotatedAt ? `Rotated ${formatCredentialDate(credential.lastRotatedAt)}` : "Never rotated"}</Text>
      </div>
    </div>
    {canManage ? <div className="flex gap-2">
      <Button label="Rotate" size="sm" variant="secondary" icon={<RotateCw size={15} />} isDisabled={busy} onClick={onRotate}/>
      <IconButton label={`Delete ${credential.name}`} tooltip={`Delete ${credential.name}`} variant="destructive" icon={<Trash2 size={15} />} isDisabled={busy} onClick={onDelete}/>
    </div> : null}
  </article>;
}

function credentialTypeLabel(type: ProjectCredential["type"]): string {
  return type === "api_key" ? "API key" : type;
}

function formatCredentialDate(value: string): string {
  return formatLocalDateTime(value);
}
