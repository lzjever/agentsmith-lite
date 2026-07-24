"use client";

import {
  Button,
  Selector,
  Text,
  TextInput,
} from "@astryxdesign/core";
import {
  type FormEvent,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  apiClient,
  type ProjectAuditIdentity,
  type ProjectAuditIdentityQuery,
} from "../../lib/api/client";
import {
  auditIdentityHydratedIdentity,
  auditIdentityHydrationQuery,
  auditIdentityListPaging,
  auditIdentityListQuery,
  createAuditIdentityPickerState,
  formatAuditIdentityLabel,
  reduceAuditIdentityPickerState,
  type AuditIdentityPresentation,
} from "./auditIdentityPickerState";

export function AuditIdentityPicker({
  projectId,
  role,
  label,
  value,
  onChange,
  onIdentityResolved,
}: {
  projectId: string;
  role: ProjectAuditIdentityQuery["role"];
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  onIdentityResolved: (presentation: AuditIdentityPresentation) => void;
}) {
  const [draft, setDraft] = useState("");
  const [state, dispatch] = useReducer(
    reduceAuditIdentityPickerState,
    createAuditIdentityPickerState(projectId, role),
  );
  const listRequestSequence = useRef(0);
  const hydrationRequestSequence = useRef(0);
  const startedListAttempt = useRef("");
  const startedHydrationAttempt = useRef("");

  useEffect(() => {
    dispatch({ type: "context_changed", projectId, role });
  }, [projectId, role]);

  useEffect(() => {
    dispatch({ type: "hydration_candidate_changed", value });
  }, [projectId, role, value]);

  useEffect(() => {
    const { candidate, attempt, pending } = state.list;
    if (
      !pending ||
      candidate.projectId !== projectId ||
      candidate.role !== role
    ) {
      return;
    }
    const attemptKey = `${candidate.projectId}\u0000${candidate.role}\u0000${attempt}`;
    if (startedListAttempt.current === attemptKey) return;
    startedListAttempt.current = attemptKey;
    const requestId = `audit-identity-list-${++listRequestSequence.current}`;
    dispatch({ type: "list_request_started", requestId });
    void apiClient
      .auditIdentities(candidate.projectId, auditIdentityListQuery(candidate))
      .then((page) => {
        dispatch({
          type: "list_request_succeeded",
          requestId,
          items: page.items,
          nextCursor: page.nextCursor,
        });
      })
      .catch(() => {
        dispatch({
          type: "list_request_failed",
          requestId,
          message: "Identity results could not be loaded.",
        });
      })
      .finally(() => {
        dispatch({ type: "list_request_finished", requestId });
      });
  }, [
    projectId,
    role,
    state.list.attempt,
    state.list.candidate,
    state.list.pending,
  ]);

  useEffect(() => {
    const { candidate, attempt, pending } = state.hydration;
    if (
      !pending ||
      !candidate ||
      candidate.projectId !== projectId ||
      candidate.role !== role
    ) {
      return;
    }
    const attemptKey = `${candidate.projectId}\u0000${candidate.role}\u0000${candidate.value}\u0000${attempt}`;
    if (startedHydrationAttempt.current === attemptKey) return;
    startedHydrationAttempt.current = attemptKey;
    const requestId = `audit-identity-hydration-${++hydrationRequestSequence.current}`;
    dispatch({ type: "hydration_request_started", requestId });
    void apiClient
      .auditIdentities(
        candidate.projectId,
        auditIdentityHydrationQuery(candidate),
      )
      .then((page) => {
        dispatch({
          type: "hydration_request_succeeded",
          requestId,
          identity:
            page.items.find((identity) => identity.id === candidate.value) ??
            null,
        });
      })
      .catch(() => {
        dispatch({
          type: "hydration_request_failed",
          requestId,
          message: "Selected identity details could not be loaded.",
        });
      })
      .finally(() => {
        dispatch({ type: "hydration_request_finished", requestId });
      });
  }, [
    projectId,
    role,
    state.hydration.attempt,
    state.hydration.candidate,
    state.hydration.pending,
  ]);

  const contextMatches =
    state.list.candidate.projectId === projectId &&
    state.list.candidate.role === role;
  const hydrationMatches =
    value && value !== "system"
      ? state.hydration.candidate?.projectId === projectId &&
        state.hydration.candidate.role === role &&
        state.hydration.candidate.value === value
      : state.hydration.candidate === null;
  const items = contextMatches ? state.list.page?.items ?? [] : [];
  const selectedIdentity =
    contextMatches && hydrationMatches
      ? auditIdentityHydratedIdentity(state)
      : null;
  const paging = contextMatches
    ? auditIdentityListPaging(state)
    : { pageNumber: 1, canPrevious: false, nextCursor: null };
  const listLoading =
    !contextMatches || state.list.pending || Boolean(state.list.request);
  const hydrationLoading =
    hydrationMatches &&
    (state.hydration.pending || Boolean(state.hydration.request));
  const listError = contextMatches ? state.list.error : null;
  const hydrationError = hydrationMatches
    ? state.hydration.error
    : null;
  const resolvedIdentity =
    value && value !== "system"
      ? items.find((identity) => identity.id === value) ??
        (selectedIdentity?.id === value ? selectedIdentity : null)
      : null;

  useEffect(() => {
    if (!value || !resolvedIdentity) return;
    onIdentityResolved({ key: value, identity: resolvedIdentity });
  }, [onIdentityResolved, resolvedIdentity, value]);

  const options = useMemo(() => {
    const identities = new Map<string, ProjectAuditIdentity>();
    if (selectedIdentity && selectedIdentity.id !== "system") {
      identities.set(selectedIdentity.id, selectedIdentity);
    }
    for (const identity of items) {
      if (identity.id !== "system") identities.set(identity.id, identity);
    }
    if (value && value !== "system" && !identities.has(value)) {
      identities.set(value, {
        id: value,
        displayName: null,
        email: null,
      });
    }
    return [
      { value: "", label: role === "actor" ? "All actors" : "All sandbox users" },
      ...(role === "actor" ? [{ value: "system", label: "System" }] : []),
      ...[...identities.values()].map((identity) => ({
        value: identity.id,
        label: formatAuditIdentityLabel(
          identity.id,
          identity.displayName,
          identity.email,
        ),
      })),
    ];
  }, [items, role, selectedIdentity, value]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    dispatch({ type: "search_committed", query: draft });
  }

  return (
    <div className="grid gap-2">
      <Text type="label" color="secondary">
        {label}
      </Text>
      <Selector
        label={label}
        isLabelHidden
        options={options}
        value={value ?? ""}
        onChange={(next) => onChange(next || null)}
        size="lg"
      />
      <form
        className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"
        onSubmit={submitSearch}
      >
        <TextInput
          label={`Search ${label.toLowerCase()}`}
          isLabelHidden
          value={draft}
          onChange={setDraft}
          placeholder={`Search ${label.toLowerCase()}`}
          size="md"
          width="100%"
        />
        <Button
          label="Search"
          type="submit"
          variant="secondary"
          size="md"
          isDisabled={listLoading}
          isLoading={listLoading}
        />
      </form>
      {listLoading ? (
        <Text
          as="p"
          type="supporting"
          color="secondary"
          role="status"
        >
          Loading identity results...
        </Text>
      ) : null}
      {listError ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2"
          role="alert"
        >
          <Text type="supporting" color="secondary">
            {listError.message}
          </Text>
          <Button
            label="Retry identity results"
            variant="ghost"
            size="sm"
            onClick={() => dispatch({ type: "list_retry_requested" })}
          />
        </div>
      ) : null}
      {hydrationLoading ? (
        <Text
          as="p"
          type="supporting"
          color="secondary"
          role="status"
        >
          Loading selected identity...
        </Text>
      ) : null}
      {hydrationError ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2"
          role="alert"
        >
          <Text type="supporting" color="secondary">
            {hydrationError.message}
          </Text>
          <Button
            label="Retry selected identity"
            variant="ghost"
            size="sm"
            onClick={() =>
              dispatch({ type: "hydration_retry_requested" })
            }
          />
        </div>
      ) : null}
      {paging.canPrevious || paging.nextCursor ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Text type="supporting" color="secondary">
            Identity results page {paging.pageNumber}
          </Text>
          <div className="flex items-center justify-end gap-2">
            <Button
              label="Previous identities"
              variant="ghost"
              size="sm"
              isDisabled={listLoading || !paging.canPrevious}
              onClick={() => dispatch({ type: "previous_page_requested" })}
            />
            <Button
              label="Next identities"
              variant="ghost"
              size="sm"
              isDisabled={listLoading || !paging.nextCursor}
              onClick={() => dispatch({ type: "next_page_requested" })}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
