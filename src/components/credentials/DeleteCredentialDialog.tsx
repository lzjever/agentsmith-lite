import { Banner, Button, Dialog, DialogHeader, Text } from "@astryxdesign/core";
import { useEffect, useId, useState } from "react";
import type { ProjectCredential } from "../../lib/api/client";

export function DeleteCredentialDialog({
  credential,
  deleting,
  canConfirm,
  onOpenChange,
  onConfirm,
}: {
  credential: ProjectCredential | undefined;
  deleting: boolean;
  canConfirm: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [failure, setFailure] = useState("");
  const descriptionId = useId();

  useEffect(() => {
    setFailure("");
  }, [credential?.id]);

  const handleOpenChange = (open: boolean) => {
    if (deleting) return;
    if (!open) setFailure("");
    onOpenChange(open);
  };

  const confirm = async () => {
    if (!credential || !canConfirm || deleting) return;
    setFailure("");
    try {
      await onConfirm();
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('[aria-label="Project credentials"] input')?.focus();
      });
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : "Credential could not be deleted.");
    }
  };

  return (
    <Dialog
      className="[&_button]:min-h-11 [&_button]:min-w-11"
      isOpen={Boolean(credential)}
      onOpenChange={handleOpenChange}
      role="alertdialog"
      purpose={deleting ? "required" : "form"}
      padding={0}
      width="min(32rem, calc(100dvw - 1rem))"
      maxHeight="calc(100dvh - 1rem)"
      aria-label="Delete credential"
      aria-describedby={descriptionId}
    >
      <DialogHeader title="Delete credential" hasDivider />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <Text id={descriptionId} as="p" display="block" color="secondary">
          {credential
            ? `Permanently delete ${credential.name}? Endpoints using this credential must be updated first. This cannot be undone.`
            : ""}
        </Text>
        <div className="mt-4">
          {failure ? (
            <Banner
              status="error"
              title="Credential could not be deleted"
              description={failure}
            />
          ) : null}
        </div>
      </div>
      <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:px-6 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal">
        <Button data-autofocus="" label="Cancel" type="button" variant="ghost" size="lg" isDisabled={deleting} onClick={() => handleOpenChange(false)} />
        <Button label={deleting ? "Deleting" : "Delete credential"} type="button" variant="destructive" size="lg" isDisabled={!canConfirm || deleting} isLoading={deleting} onClick={() => void confirm()} />
      </div>
    </Dialog>
  );
}
