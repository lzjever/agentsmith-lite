import { Banner, Text } from "@astryxdesign/core";
import { useEffect, useState } from "react";
import type { ProjectCredential } from "../../lib/api/client";
import { ConfirmationDialog } from "../ui/Dialog";

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
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : "Credential could not be deleted.");
    }
  };

  return (
    <ConfirmationDialog
      isOpen={Boolean(credential)}
      onOpenChange={handleOpenChange}
      title="Delete credential"
      description={
        <Text as="p" display="block" color="secondary">
          {credential
            ? `Delete ${credential.name}? This cannot be undone. Endpoints using this credential must be updated first.`
            : ""}
        </Text>
      }
      actionLabel={deleting ? "Deleting" : "Delete credential"}
      isActionDisabled={!canConfirm}
      busy={deleting}
      onAction={() => void confirm()}
    >
      {failure ? (
        <Banner
          status="error"
          title="Credential could not be deleted"
          description={failure}
        />
      ) : null}
    </ConfirmationDialog>
  );
}
