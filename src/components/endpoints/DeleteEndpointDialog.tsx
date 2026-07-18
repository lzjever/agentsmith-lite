import type { Endpoint } from "../../lib/api/client";
import { ConfirmationDialog } from "../ui/confirmation-dialog";

export function DeleteEndpointDialog({ endpoint, deleting, canConfirm, onOpenChange, onConfirm }: { endpoint: Endpoint | undefined; deleting: boolean; canConfirm: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => Promise<void> }) {
  return <ConfirmationDialog open={Boolean(endpoint)} onOpenChange={onOpenChange} title="Delete endpoint" description={endpoint ? `Remove ${endpoint.name}? This also removes its rolling limits and endpoint alert rules, resolves active endpoint alerts, and disconnects its retained chat history. Tasks that reference it must be deleted first.` : ""} confirmText={deleting ? "Deleting" : "Delete endpoint"} confirmDisabled={!canConfirm || deleting} onConfirm={onConfirm} errorContext="Endpoint could not be deleted" />;
}
