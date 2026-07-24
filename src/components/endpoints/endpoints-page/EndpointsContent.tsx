"use client";

import {
  Badge,
  Divider,
  EmptyState,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  TextInput,
} from "@astryxdesign/core";
import { KeyRound, Pencil, RefreshCw, Search, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import type {
  Endpoint,
  EndpointCapability,
  ProjectCredential,
} from "../../../lib/api/client";
import { EndpointStatusBadge } from "../EndpointStatusBadge";

export function EndpointsContent({
  endpoints,
  credentials,
  focusedEndpointId,
  canManage,
  canEdit,
  busy,
  checkingId,
  onEdit,
  onRecheck,
  onDelete,
}: {
  endpoints: Endpoint[];
  credentials: ProjectCredential[];
  focusedEndpointId: string | null;
  canManage: boolean;
  canEdit: boolean;
  busy: boolean;
  checkingId: string | undefined;
  onEdit: (endpoint: Endpoint) => void;
  onRecheck: (endpoint: Endpoint) => void;
  onDelete: (endpoint: Endpoint) => void;
}) {
  const [query, setQuery] = useState("");
  const [highlightedEndpointId, setHighlightedEndpointId] = useState<
    string | null
  >(null);
  const credentialsById = useMemo(
    () => new Map(credentials.map((credential) => [credential.id, credential])),
    [credentials],
  );
  const filtered = useMemo(
    () => endpoints.filter((endpoint) =>
      `${endpoint.name} ${endpoint.model} ${endpoint.baseUrl}`
        .toLowerCase()
        .includes(query.trim().toLowerCase())),
    [endpoints, query],
  );

  useEffect(() => {
    if (
      focusedEndpointId &&
      endpoints.some((endpoint) => endpoint.id === focusedEndpointId) &&
      !filtered.some((endpoint) => endpoint.id === focusedEndpointId)
    ) {
      setQuery("");
      return;
    }
    if (
      !focusedEndpointId ||
      !filtered.some((endpoint) => endpoint.id === focusedEndpointId)
    ) {
      setHighlightedEndpointId(null);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const targets = [
        document.getElementById(endpointElementId(focusedEndpointId, "table")),
        document.getElementById(endpointElementId(focusedEndpointId, "mobile")),
      ];
      const target =
        targets.find((item) => item && item.getClientRects().length > 0) ??
        targets.find((item) => item !== null);
      target?.scrollIntoView({ block: "center" });
      target?.focus({ preventScroll: true });
      setHighlightedEndpointId(focusedEndpointId);
    });
    const timeout = window.setTimeout(() => {
      setHighlightedEndpointId((current) =>
        current === focusedEndpointId ? null : current
      );
    }, 2500);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [endpoints, filtered, focusedEndpointId]);

  return (
    <section aria-label="Project endpoints" className="space-y-4">
      <TextInput
        label="Search endpoints"
        isLabelHidden
        startIcon={<Search size={16} />}
        value={query}
        onChange={setQuery}
        className="max-w-sm"
        placeholder="Search endpoints"
        size="lg"
      />
      {filtered.length === 0 ? (
        <EmptyState
          isCompact
          title="No endpoints match this search"
          description="Try a different endpoint name, model, or base URL."
        />
      ) : (
        <>
          <div className="hidden overflow-x-auto md:block">
            <Table
              aria-label="Project endpoints"
              data-testid="endpoints-table"
              density="balanced"
              dividers="rows"
              hasHover
              verticalAlign="top"
            >
              <TableHeader>
                <TableRow isHeaderRow>
                  <TableHeaderCell>Endpoint</TableHeaderCell>
                  <TableHeaderCell>Model</TableHeaderCell>
                  <TableHeaderCell>Capabilities</TableHeaderCell>
                  <TableHeaderCell>Credential</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  {canManage ? <TableHeaderCell /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((endpoint) => (
                  <TableRow
                    id={endpointElementId(endpoint.id, "table")}
                    tabIndex={endpoint.id === focusedEndpointId ? -1 : undefined}
                    aria-current={
                      endpoint.id === highlightedEndpointId ? "true" : undefined
                    }
                    key={endpoint.id}
                  >
                    <TableCell>
                      <EndpointName
                        endpoint={endpoint}
                        highlighted={endpoint.id === highlightedEndpointId}
                      />
                    </TableCell>
                    <TableCell>
                      <Text type="code" size="2xs" color="secondary">
                        {endpoint.model}
                      </Text>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {endpoint.capabilities.map((capability: EndpointCapability) => (
                          <Badge
                            key={capability}
                            variant="neutral"
                            label={capability.replace("_", " ")}
                          />
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Credential
                        endpoint={endpoint}
                        credential={credentialsById.get(endpoint.credentialId)}
                      />
                    </TableCell>
                    <TableCell><EndpointStatusBadge endpoint={endpoint} /></TableCell>
                    {canManage ? (
                      <TableCell>
                        <EndpointActions
                          endpoint={endpoint}
                          busy={busy}
                          checking={checkingId === endpoint.id}
                          canEdit={canEdit}
                          onEdit={onEdit}
                          onRecheck={onRecheck}
                          onDelete={onDelete}
                        />
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="md:hidden">
            {filtered.map((endpoint, index) => (
              <Fragment key={endpoint.id}>
                {index > 0 ? <Divider /> : null}
                <EndpointCard
                  endpoint={endpoint}
                  credential={credentialsById.get(endpoint.credentialId)}
                  focused={endpoint.id === focusedEndpointId}
                  highlighted={endpoint.id === highlightedEndpointId}
                  canManage={canManage}
                  canEdit={canEdit}
                  busy={busy}
                  checking={checkingId === endpoint.id}
                  onEdit={onEdit}
                  onRecheck={onRecheck}
                  onDelete={onDelete}
                />
              </Fragment>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function EndpointCard({
  endpoint,
  credential,
  focused,
  highlighted,
  canManage,
  canEdit,
  busy,
  checking,
  onEdit,
  onRecheck,
  onDelete,
}: {
  endpoint: Endpoint;
  credential: ProjectCredential | undefined;
  focused: boolean;
  highlighted: boolean;
  canManage: boolean;
  canEdit: boolean;
  busy: boolean;
  checking: boolean;
  onEdit: (endpoint: Endpoint) => void;
  onRecheck: (endpoint: Endpoint) => void;
  onDelete: (endpoint: Endpoint) => void;
}) {
  return (
    <article
      id={endpointElementId(endpoint.id, "mobile")}
      tabIndex={focused ? -1 : undefined}
      aria-current={highlighted ? "true" : undefined}
      className={`space-y-4 py-4 outline-none ${
        highlighted ? "bg-muted outline outline-2 outline-accent" : ""
      }`}
    >
      <EndpointName endpoint={endpoint} />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <div>
          <dt><Text type="supporting">Model</Text></dt>
          <dd className="mt-1 break-words">
            <Text type="code" size="2xs" color="secondary">{endpoint.model}</Text>
          </dd>
        </div>
        <div>
          <dt><Text type="supporting">Status</Text></dt>
          <dd className="mt-1"><EndpointStatusBadge endpoint={endpoint} /></dd>
        </div>
        <div>
          <dt><Text type="supporting">Capabilities</Text></dt>
          <dd className="mt-1 flex flex-wrap gap-1">
            {endpoint.capabilities.map((capability) => (
              <Badge
                key={capability}
                variant="neutral"
                label={capability.replace("_", " ")}
              />
            ))}
          </dd>
        </div>
        <div>
          <dt><Text type="supporting">Credential</Text></dt>
          <dd className="mt-1">
            <Credential endpoint={endpoint} credential={credential} />
          </dd>
        </div>
      </dl>
      {canManage ? (
        <>
          <Divider />
          <EndpointActions
            endpoint={endpoint}
            busy={busy}
            checking={checking}
            canEdit={canEdit}
            onEdit={onEdit}
            onRecheck={onRecheck}
            onDelete={onDelete}
          />
        </>
      ) : null}
    </article>
  );
}

function endpointElementId(
  endpointId: string,
  surface: "table" | "mobile"
) {
  return `endpoint-${surface}-${endpointId.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`;
}

function EndpointName({
  endpoint,
  highlighted = false
}: {
  endpoint: Endpoint;
  highlighted?: boolean;
}) {
  return (
    <div
      className={`grid gap-1 rounded-sm px-2 py-1 ${
        highlighted ? "bg-muted outline outline-2 outline-accent" : ""
      }`}
    >
      <Text display="block" weight="medium">{endpoint.name}</Text>
      <Text
        type="code"
        size="2xs"
        color="secondary"
        display="block"
        maxLines={1}
        className="max-w-64"
      >
        {endpoint.baseUrl}
      </Text>
    </div>
  );
}

function Credential({
  endpoint,
  credential,
}: {
  endpoint: Endpoint;
  credential: ProjectCredential | undefined;
}) {
  if (credential) {
    return (
      <span className="inline-flex min-w-0 items-start gap-1.5">
        <KeyRound className="mt-0.5 shrink-0" size={14} />
        <span className="grid min-w-0">
          <Text display="block" maxLines={1}>{credential.name}</Text>
          <Text
            type="code"
            size="2xs"
            color="secondary"
            display="block"
            maxLines={1}
          >
            {credential.fingerprint}
          </Text>
        </span>
      </span>
    );
  }
  return endpoint.hasCredentialRef
    ? <Badge variant="warning" label="Credential unavailable" />
    : <Badge variant="neutral" label="Not configured" />;
}

function EndpointActions({
  endpoint,
  busy,
  checking,
  canEdit,
  onEdit,
  onRecheck,
  onDelete,
}: {
  endpoint: Endpoint;
  busy: boolean;
  checking: boolean;
  canEdit: boolean;
  onEdit: (endpoint: Endpoint) => void;
  onRecheck: (endpoint: Endpoint) => void;
  onDelete: (endpoint: Endpoint) => void;
}) {
  return (
    <div className="flex justify-end gap-1">
      <IconButton
        variant="ghost"
        size="md"
        label={`Check health for ${endpoint.name}`}
        tooltip={`Check health for ${endpoint.name}`}
        isDisabled={busy}
        isLoading={checking}
        onClick={() => onRecheck(endpoint)}
        icon={<RefreshCw size={15} />}
      />
      <IconButton
        variant="ghost"
        size="md"
        label={`Edit ${endpoint.name}`}
        tooltip={`Edit ${endpoint.name}`}
        isDisabled={!canEdit || busy}
        onClick={() => onEdit(endpoint)}
        icon={<Pencil size={15} />}
      />
      <IconButton
        variant="destructive"
        size="md"
        label={`Delete ${endpoint.name}`}
        tooltip={`Delete ${endpoint.name}`}
        isDisabled={busy}
        onClick={() => onDelete(endpoint)}
        icon={<Trash2 size={15} />}
      />
    </div>
  );
}
