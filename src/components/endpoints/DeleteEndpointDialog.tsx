import {
  Banner,
  Button,
  DialogHeader,
  Layout,
  LayoutContent,
  LayoutFooter,
  Text,
} from "@astryxdesign/core";
import { useEffect, useId, useState } from "react";
import type { Endpoint } from "../../lib/api/client";
import { Dialog } from "../ui/Dialog";

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
  const titleId = useId();
  const descriptionId = useId();

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
    <Dialog
      isOpen={Boolean(endpoint)}
      onOpenChange={handleOpenChange}
      purpose="form"
      role="alertdialog"
      width="min(34rem, calc(100vw - 2rem))"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <Layout
        defaultHasDividers
        header={<DialogHeader id={titleId} title="Delete endpoint" />}
        content={
          <LayoutContent>
            <div className="grid gap-4">
              <Text id={descriptionId} as="p" display="block" color="secondary">
                {endpoint
                  ? `Remove ${endpoint.name}? This also removes its rolling limits and endpoint alert rules, and resolves active endpoint alerts. Tasks that reference it must be deleted first.`
                  : ""}
              </Text>
              {failure ? (
                <Banner
                  status="error"
                  title="Endpoint could not be deleted"
                  description={failure}
                />
              ) : null}
            </div>
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
                isDisabled={deleting}
                onClick={() => handleOpenChange(false)}
              />
              <Button
                label={deleting ? "Deleting" : "Delete endpoint"}
                type="button"
                variant="destructive"
                size="lg"
                isDisabled={!canConfirm || deleting}
                isLoading={deleting}
                onClick={() => void confirm()}
              />
            </div>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
