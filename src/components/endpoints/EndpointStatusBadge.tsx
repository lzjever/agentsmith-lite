import { Badge, Text } from "@astryxdesign/core";
import { CheckCircle2, CircleAlert } from "lucide-react";
import type { Endpoint } from "../../lib/api/client";
import { formatLocalDateTime } from "../../lib/format/date";
import { endpointSupportsTasks } from "./endpoints-page-utils";

export function EndpointStatusBadge({ endpoint }: { endpoint: Endpoint }) {
  if (endpoint.health) {
    const healthy = endpoint.health.status === "healthy";
    const unavailable = endpoint.health.status === "unavailable";
    const label = healthy
      ? "Healthy"
      : endpoint.health.status === "unknown"
        ? "Not checked"
        : `Unavailable${endpoint.health.errorCategory ? `: ${endpoint.health.errorCategory}` : ""}`;
    const checkedAt = endpoint.health.checkedAt
      ? formatLocalDateTime(endpoint.health.checkedAt)
      : null;

    return (
      <span className="inline-grid gap-1">
        <Badge
          variant={healthy ? "success" : unavailable ? "error" : "neutral"}
          icon={healthy ? <CheckCircle2 size={13} /> : <CircleAlert size={13} />}
          label={label}
        />
        {checkedAt ? (
          <Text type="supporting" display="block">Last checked {checkedAt}</Text>
        ) : null}
      </span>
    );
  }

  const ready = endpoint.hasCredentialRef && endpointSupportsTasks(endpoint);
  return (
    <Badge
      variant={ready ? "success" : "neutral"}
      icon={ready ? <CheckCircle2 size={13} /> : <CircleAlert size={13} />}
      label={ready ? "Ready" : endpoint.hasCredentialRef ? "Limited" : "Credential needed"}
    />
  );
}
