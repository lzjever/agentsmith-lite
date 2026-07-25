"use client";

import {
  Banner,
  Button,
  Divider,
  EmptyState,
  Spinner,
  Text,
  TextInput,
  useToast,
} from "@astryxdesign/core";
import { KeyRound, Plus, Search } from "lucide-react";
import {
  Fragment,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  apiClient,
  isReadOnlyMutationError,
  type ProjectCapabilities,
  type ProjectCredential,
} from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { CredentialDialog } from "./CredentialDialog";
import { CredentialRow } from "./CredentialRow";
import { DeleteCredentialDialog } from "./DeleteCredentialDialog";

export function CredentialsPage({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<ProjectCredential[]>([]);
  const [query,setQuery]=useState(""),[committedQuery,setCommittedQuery]=useState("");
  const [cursor,setCursor]=useState<string|undefined>(),[cursorHistory,setCursorHistory]=useState<Array<string|undefined>>([]);
  const [loadedCursor,setLoadedCursor]=useState<string|undefined>(),[loadedCursorHistory,setLoadedCursorHistory]=useState<Array<string|undefined>>([]);
  const [nextCursor,setNextCursor]=useState<string|null>(null),[refreshing,setRefreshing]=useState(false);
  const [capabilities, setCapabilities] = useState<ProjectCapabilities>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [capabilitiesError, setCapabilitiesError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createProjectId, setCreateProjectId] = useState<string>();
  const [rotate, setRotate] = useState<ProjectCredential>();
  const [remove, setRemove] = useState<ProjectCredential>();
  const [createError, setCreateError] = useState("");
  const [rotateError, setRotateError] = useState("");
  const [busy, setBusy] = useState(false);
  const loadRevision = useRef(0);
  const capabilitiesRevision=useRef(0);
  const hasContent=useRef(false);
  const projectRevision = useRef(0);
  const currentProjectId = useRef(projectId);
  const mutationKeys = useMutationKeys();
  const showToast = useToast();

  if (currentProjectId.current !== projectId) {
    currentProjectId.current = projectId;
    projectRevision.current += 1;
    mutationKeys.clear("credential.create");
    mutationKeys.clear("credential.rotate");
    mutationKeys.clear("credential.delete");
  }

  const canManage = capabilities?.canManageEndpoints === true;
  const load = useCallback(async (): Promise<ProjectCredential[] | null> => {
    const targetProjectId = projectId;
    const revision = ++loadRevision.current;
    hasContent.current?setRefreshing(true):setState("loading");
    try {
      const credentialsResult=await apiClient.credentials(projectId,{q:committedQuery,...(cursor!==undefined?{cursor}:{}),limit:20});
      if (targetProjectId !== currentProjectId.current || revision !== loadRevision.current) return null;
      setItems(credentialsResult.items);setNextCursor(credentialsResult.nextCursor);setLoadedCursor(cursor);setLoadedCursorHistory(cursorHistory);hasContent.current=true;
      setError("");
      setState("ready");
      return credentialsResult.items;
    } catch (reason) {
      if (targetProjectId !== currentProjectId.current || revision !== loadRevision.current) return null;
      setError(reason instanceof ApiError ? reason.message : "Credentials could not be loaded.");
      if(!hasContent.current)setState("error");
      return null;
    }finally{
      if(targetProjectId===currentProjectId.current&&revision===loadRevision.current)setRefreshing(false);
    }
  }, [committedQuery,cursor,cursorHistory,projectId]);

  useEffect(()=>{const timer=window.setTimeout(()=>{setCommittedQuery(query.trim());setCursorHistory([]);setCursor(undefined)},250);return()=>window.clearTimeout(timer)},[query]);

  useEffect(() => {
    setCreateOpen(false);
    setCreateProjectId(undefined);
    setRotate(undefined);
    setRemove(undefined);
    setCreateError("");
    setRotateError("");
    setBusy(false);
    hasContent.current=false;setQuery("");setCommittedQuery("");setCursor(undefined);setCursorHistory([]);setLoadedCursor(undefined);setLoadedCursorHistory([]);
    setCapabilities(undefined);setCapabilitiesError("");
    const targetProjectId=projectId,revision=++capabilitiesRevision.current;
    void apiClient.projectCapabilities(projectId).then((value)=>{
      if(targetProjectId===currentProjectId.current&&revision===capabilitiesRevision.current)setCapabilities(value);
    }).catch(()=>{
      if(targetProjectId===currentProjectId.current&&revision===capabilitiesRevision.current)setCapabilitiesError("Credential permissions could not be loaded. Credentials are read-only until refreshed.");
    });
  }, [projectId]);
  useEffect(()=>{void load()},[load]);

  useEffect(() => {
    if (!rotate) mutationKeys.clear("credential.rotate");
  }, [rotate]);

  function openCreate() {
    if (busy) return;
    mutationKeys.clear("credential.create");
    setCreateError("");
    setCreateProjectId(projectId);
    setCreateOpen(true);
  }

  async function mutationError(reason: unknown, fallback: string) {
    if (isReadOnlyMutationError(reason)) {
      setCreateOpen(false);
      setCreateProjectId(undefined);
      setRotate(undefined);
      setRemove(undefined);
      if (reason.status === 403) {
        setItems([]);
        await resetPage();
      } else {
        setCapabilities((current) => current ? { ...current, canManageEndpoints: false } : current);
        setCapabilitiesError("Credential management access changed. Credentials are now read-only.");
      }
    }
    return reason instanceof ApiError ? reason.message : fallback;
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createProjectId !== projectId) return;
    const revision = projectRevision.current;
    const form = new FormData(event.currentTarget);
    const input = {
      name: String(form.get("name") || ""),
      baseUrl: String(form.get("baseUrl") || ""),
      secret: String(form.get("secret") || ""),
    };
    setCreateError("");
    setBusy(true);
    try {
      const saved = await apiClient.createCredential(
        projectId,
        input,
        mutationKeys.requestKey("credential.create", projectId, input),
      );
      mutationKeys.complete("credential.create", projectId);
      if (revision !== projectRevision.current) return;
      setItems((current) => [...current, saved]);
      setCreateOpen(false);
      setCreateProjectId(undefined);
      showToast({ body: "Credential created." });
      await resetPage();
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("credential.create", projectId);
      if (revision !== projectRevision.current) return;
      setCreateError(await mutationError(reason, "Credential could not be created."));
    } finally {
      if (revision === projectRevision.current) setBusy(false);
    }
  }

  async function rotateCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rotate || rotate.projectId !== projectId) return;
    const revision = projectRevision.current;
    const requestIdentity = rotate.id;
    const secret = String(new FormData(event.currentTarget).get("secret") || "");
    setRotateError("");
    setBusy(true);
    try {
      const saved = await apiClient.rotateCredential(
        projectId,
        rotate.id,
        secret,
        mutationKeys.requestKey("credential.rotate", requestIdentity, { secret }),
      );
      mutationKeys.complete("credential.rotate", requestIdentity);
      if (revision !== projectRevision.current) return;
      setItems((current) => current.map((item) => item.id === saved.id ? saved : item));
      setRotate(undefined);
      showToast({ body: "Credential rotated. Recheck linked endpoints before use." });
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("credential.rotate", requestIdentity);
      if (revision !== projectRevision.current) return;
      if (isCredentialRefreshError(reason)) {
        try{setRotate(await apiClient.credential(projectId,requestIdentity))}catch{setRotate(undefined)}
      }
      setRotateError(await mutationError(reason, "Credential could not be rotated."));
    } finally {
      if (revision === projectRevision.current) setBusy(false);
    }
  }

  async function deleteCredential() {
    if (!remove || remove.projectId !== projectId) return;
    const revision = projectRevision.current;
    const requestIdentity = remove.id;
    setBusy(true);
    try {
      await apiClient.deleteCredential(
        projectId,
        remove.id,
        remove.version,
        mutationKeys.key("credential.delete", requestIdentity),
      );
      mutationKeys.complete("credential.delete", requestIdentity);
      if (revision !== projectRevision.current) return;
      setItems((current) => current.filter((item) => item.id !== remove.id));
      setRemove(undefined);
      showToast({ body: "Credential deleted." });
      await resetPage();
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("credential.delete", requestIdentity);
      if (revision !== projectRevision.current) return;
      if (isCredentialDeleteRefreshError(reason)) {
        try{setRemove(await apiClient.credential(projectId,requestIdentity))}catch{setRemove(undefined);if(reason instanceof ApiError&&reason.status===404)return}
      }
      throw new Error(await mutationError(reason, "Credential is still in use or could not be deleted."));
    } finally {
      if (revision === projectRevision.current) setBusy(false);
    }
  }

  async function resetPage(){setCursorHistory([]);setCursor(undefined);if(cursor===undefined)await load()}
  const visibleItems=dedupeCredentials([rotate,remove,...items].filter((item):item is ProjectCredential=>item!==undefined));

  return (
    <PageLayout
      header={
        <PageHeader
          title="Project credentials"
          subtitle="Provider keys are write-only and never shown again."
          actions={canManage ? (
            <Button
              label="New credential"
              icon={<Plus size={16} />}
              isDisabled={busy}
              onClick={openCreate}
            />
          ) : undefined}
        />
      }
    >
      {capabilitiesError ? (
        <Banner
          className="mb-4"
          status="warning"
          title="Credential permissions unavailable"
          description={capabilitiesError}
        />
      ) : null}
      {state === "loading" ? (
        <div
          className="flex min-h-48 items-center justify-center"
          data-testid="page-state__loading"
          data-page-state="loading"
        >
          <Spinner size="lg" label="Loading credentials..." />
        </div>
      ) : null}
      {state === "error" ? (
        <EmptyState
          data-testid="page-state__error"
          data-page-state="error"
          title="Credentials unavailable"
          description={error}
          actions={<Button label="Try again" onClick={() => void load()} />}
        />
      ) : null}
      {state === "ready" ? (
        <>
          {error ? (
            <Banner
              className="mb-4"
              status="error"
              title="Credentials could not be refreshed"
              description={error}
              endContent={<Button label="Retry" variant="ghost" onClick={() => void load()} />}
            />
          ) : null}
          <Text as="p" display="block" color="secondary" className="mb-5">
            {canManage
              ? "Create, rotate, or remove credentials for this project."
              : "You can view credential metadata, but cannot change credentials."}
          </Text>
          {items.length === 0&&!query ? (
            <EmptyState
              data-testid="page-state__empty"
              data-page-state="empty"
              icon={<KeyRound size={20} />}
              title={canManage ? "No credentials yet" : "No credentials are available"}
              actions={canManage ? (
                <Button label="New credential" isDisabled={busy} onClick={openCreate} />
              ) : undefined}
            />
          ) : (
            <div aria-label="Project credentials" className="space-y-4">
              <TextInput label="Search credentials" isLabelHidden startIcon={<Search size={16}/>} value={query} onChange={(value)=>{loadRevision.current+=1;setQuery(value)}} placeholder="Search credentials" className="max-w-sm" size="lg"/>
              {visibleItems.length===0?<EmptyState isCompact title="No credentials match this search" description="Try a different credential name, URL, or fingerprint."/>:<div>
              {visibleItems.map((item, index) => (
                <Fragment key={item.id}>
                  {index > 0 ? <Divider /> : null}
                  <CredentialRow
                    credential={item}
                    canManage={canManage}
                    busy={busy}
                    onRotate={() => {
                      if (!busy) {
                        setRotateError("");
                        setRotate(item);
                      }
                    }}
                    onDelete={() => {
                      if (!busy) setRemove(item);
                    }}
                  />
                </Fragment>
              ))}</div>}
              {loadedCursorHistory.length>0||nextCursor?<div className="flex items-center justify-end gap-2"><Button label="Previous" variant="secondary" size="sm" isDisabled={refreshing||Boolean(error)||loadedCursorHistory.length===0} onClick={()=>{setCursor(loadedCursorHistory.at(-1));setCursorHistory(loadedCursorHistory.slice(0,-1))}}/><Text type="supporting" color="secondary">Page {loadedCursorHistory.length+1}</Text><Button label="Next" variant="secondary" size="sm" isDisabled={refreshing||Boolean(error)||query.trim()!==committedQuery||!nextCursor} onClick={()=>{if(nextCursor){setCursorHistory([...loadedCursorHistory,loadedCursor]);setCursor(nextCursor)}}}/></div>:null}
            </div>
          )}
        </>
      ) : null}
      <CredentialDialog
        open={createOpen && createProjectId === projectId}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) {
            mutationKeys.clear("credential.create");
            setCreateProjectId(undefined);
            setCreateError("");
          }
        }}
        title="New credential"
        busy={busy}
        error={createError}
        onSubmit={create}
        submit="Create credential"
        includeName
      />
      <CredentialDialog
        open={rotate?.projectId === projectId}
        onOpenChange={(open) => {
          if (!open) {
            setRotate(undefined);
            setRotateError("");
          }
        }}
        title={`Rotate ${rotate?.name ?? "credential"}`}
        busy={busy}
        error={rotateError}
        onSubmit={rotateCredential}
        submit="Rotate credential"
      />
      <DeleteCredentialDialog
        credential={remove?.projectId === projectId ? remove : undefined}
        deleting={busy}
        canConfirm={canManage}
        onOpenChange={(open) => {
          if (!open) setRemove(undefined);
        }}
        onConfirm={deleteCredential}
      />
    </PageLayout>
  );
}

function isCredentialRefreshError(reason: unknown): boolean {
  return reason instanceof ApiError && (
    reason.status === 404 ||
    (reason.status === 409 && reason.message === "Credential was rotated by another request")
  );
}

function isCredentialDeleteRefreshError(reason: unknown): boolean {
  return reason instanceof ApiError && (
    reason.status === 404 ||
    (reason.status === 409 && reason.message === "Credential changed elsewhere. Refresh and try again.")
  );
}

function dedupeCredentials(items:ProjectCredential[]):ProjectCredential[]{
  const byId=new Map<string,ProjectCredential>();
  for(const item of items)if(!byId.has(item.id))byId.set(item.id,item);
  return [...byId.values()];
}
