import { CheckCircle2, CircleAlert } from "lucide-react";
import type { Endpoint } from "../../lib/api/client";
import { endpointSupportsTasks } from "./endpoints-page-utils";

export function EndpointStatusBadge({ endpoint }: { endpoint: Endpoint }) {
  if (endpoint.health) {
    const healthy = endpoint.health.status === "healthy";
    const label = healthy ? "Healthy" : endpoint.health.status === "unknown" ? "Not checked" : `Unavailable${endpoint.health.errorCategory ? `: ${endpoint.health.errorCategory}` : ""}`;
    const tone = healthy
      ? "border-success/40 bg-success/10 text-success"
      : endpoint.health.status === "unavailable"
        ? "border-error/40 bg-error/10 text-error"
        : "border-border text-secondary";
    const checkedAt = endpoint.health.checkedAt ? new Date(endpoint.health.checkedAt).toLocaleString() : null;
    return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${tone}`} title={checkedAt ? `Last checked ${checkedAt}` : undefined} aria-label={`${label}${checkedAt ? `. Last checked ${checkedAt}` : ""}`}>{healthy ? <CheckCircle2 size={13} /> : <CircleAlert size={13} />}{label}</span>;
  }
  const ready = endpoint.hasCredentialRef && endpointSupportsTasks(endpoint);
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${ready ? "border-success/40 bg-success/10 text-success" : "border-border text-secondary"}`}>
    {ready ? <CheckCircle2 size={13} /> : <CircleAlert size={13} />}{ready ? "Ready" : endpoint.hasCredentialRef ? "Limited" : "Credential needed"}
  </span>;
}
