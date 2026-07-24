import {
  Banner,
  Button,
  DialogHeader,
  Layout,
  LayoutContent,
  Text,
} from "@astryxdesign/core";
import { useEffect, useId, useState } from "react";
import type { ProjectCredential } from "../../lib/api/client";
import { Dialog, DialogFooter } from "../ui/Dialog";

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
  const titleId = useId();
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
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : "Credential could not be deleted.");
    }
  };

  return (
    <Dialog
      isOpen={Boolean(credential)}
      onOpenChange={handleOpenChange}
      purpose="form"
      role="alertdialog"
      width="min(32rem, calc(100vw - 2rem))"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <Layout
        defaultHasDividers
        header={<DialogHeader id={titleId} title="Delete credential" />}
        content={
          <LayoutContent>
            <div className="grid gap-4">
              <Text id={descriptionId} as="p" display="block" color="secondary">
                {credential
                  ? `Delete ${credential.name}? This cannot be undone. Endpoints using this credential must be updated first.`
                  : ""}
              </Text>
              {failure ? (
                <Banner
                  status="error"
                  title="Credential could not be deleted"
                  description={failure}
                />
              ) : null}
            </div>
          </LayoutContent>
        }
        footer={
          <DialogFooter
            secondaryAction={
              <Button
                label="Cancel"
                type="button"
                variant="ghost"
                size="lg"
                isDisabled={deleting}
                onClick={() => handleOpenChange(false)}
              />
            }
            primaryAction={
              <Button
                label={deleting ? "Deleting" : "Delete credential"}
                type="button"
                variant="destructive"
                size="lg"
                isDisabled={!canConfirm || deleting}
                isLoading={deleting}
                onClick={() => void confirm()}
              />
            }
          />
        }
      />
    </Dialog>
  );
}
