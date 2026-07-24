import { Banner, Text } from "@astryxdesign/core";
import { useEffect, useState } from "react";
import type { Endpoint } from "../../lib/api/client";
import { ConfirmationDialog } from "../ui/Dialog";

export function DeleteEndpointDialog({
  endpoint,
  deleting,
  canConfirm,
  onOpenChange,
  onConfirm,
}: {
  endpoint: Endpoint | undefined;
  deleting: boolean;
  canConfirm: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [failure, setFailure] = useState("");

  useEffect(() => {
    setFailure("");
  }, [endpoint?.id]);

  const handleOpenChange = (open: boolean) => {
    if (deleting) return;
    if (!open) setFailure("");
    onOpenChange(open);
  };

  const confirm = async () => {
    if (!endpoint || !canConfirm || deleting) return;
    setFailure("");
    try {
      await onConfirm();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : "Endpoint could not be deleted.");
    }
  };

  return (
    <ConfirmationDialog
      isOpen={Boolean(endpoint)}
      onOpenChange={handleOpenChange}
      title="Delete endpoint"
      description={
        <Text as="p" display="block" color="secondary">
          {endpoint
            ? `Remove ${endpoint.name}? This also removes its rolling limits and endpoint alert rules, and resolves active endpoint alerts. Tasks that reference it must be deleted first.`
            : ""}
        </Text>
      }
      actionLabel={deleting ? "Deleting" : "Delete endpoint"}
      isActionDisabled={!canConfirm}
      busy={deleting}
      onAction={() => void confirm()}
    >
      {failure ? (
        <Banner
          status="error"
          title="Endpoint could not be deleted"
          description={failure}
        />
      ) : null}
    </ConfirmationDialog>
  );
}
