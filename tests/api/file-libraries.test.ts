import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createTestApiServer, type RunningApiServer } from "../../packages/api-entry-node/src/server.js";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";

describe("file library API", () => {
  let api: RunningApiServer;
  let dataRoot: string;
  let cookie: string;
  let csrf: string;
  let workspaceId: string;
  let projectId: string;
  const store = createLocalInMemoryProductStore();

  before(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-file-library-api-"));
    api = await createTestApiServer({ port: 0, dataRoot, builtinAdminPassword: "admin-password", store });
    await json("POST", "/api/v1/auth/bootstrap", { password: "admin-password" }, false);
    const login = await raw("POST", "/api/v1/auth/login", { email: "admin@agentsmith-lite.local", password: "admin-password" }, false);
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    csrf = (await login.json()).csrfToken;
    const workspace = (await json("POST", "/api/v1/workspaces", { name: "Files" })).workspace;
    workspaceId = workspace.id;
    projectId = (await json("POST", `/api/v1/workspaces/${workspace.id}/projects`, { name: "Project" })).id;
  });

  after(async () => {
    await api.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("supports CRUD and library-scoped binary file routes", async () => {
    const first = await json("POST", `/api/v1/projects/${projectId}/file-libraries`, { name: "First" });
    const second = await json("POST", `/api/v1/projects/${projectId}/file-libraries`, { name: "Second" });
    assert.deepEqual((await json("GET", `/api/v1/projects/${projectId}/file-libraries`)).map((item: { id: string }) => item.id), [first.id, second.id]);

    const renamed = await json("PATCH", `/api/v1/projects/${projectId}/file-libraries/${first.id}`, { name: "Renamed", expectedUpdatedAt: first.updatedAt });
    assert.equal(renamed.rootSubPath, first.rootSubPath);
    const bytes = Uint8Array.from([0, 255, 65]);
    const upload = await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/file-libraries/${first.id}/files?path=payload.bin`, {
      method: "PUT",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/octet-stream", "idempotency-key": crypto.randomUUID() },
      body: bytes
    });
    assert.equal(upload.status, 200, await upload.text());
    assert.deepEqual((await json("GET", `/api/v1/projects/${projectId}/file-libraries/${first.id}/files`)).entries.map((entry: { path: string }) => entry.path), ["payload.bin"]);
    assert.deepEqual((await json("GET", `/api/v1/projects/${projectId}/file-libraries/${second.id}/files`)).entries, []);
    const download = await raw("GET", `/api/v1/projects/${projectId}/file-libraries/${first.id}/files/download?path=payload.bin`);
    assert.equal(download.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
    const textUpload=await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/file-libraries/${first.id}/files?path=readme.md`,{method:"PUT",headers:{cookie,"x-csrf-token":csrf,"content-type":"application/octet-stream","idempotency-key":crypto.randomUUID()},body:"preview"});
    assert.equal(textUpload.status,200,await textUpload.text());
    const preview=await raw("GET",`/api/v1/projects/${projectId}/file-libraries/${first.id}/files/preview?path=readme.md`);
    assert.equal(preview.headers.get("content-disposition"),"inline");
    assert.equal(await preview.text(),"preview");

    assert.equal((await store.findProjectResourceUsage(projectId))?.projectFileBytes,10);
    const fileAudits=(await store.queryProjectAuditEvents(projectId,{limit:100})).items;
    const uploadAudits=fileAudits.filter((item)=>item.action==="file.upload");
    assert.equal(uploadAudits.length,2);
    assert.equal(uploadAudits.every((item)=>item.detail?.filePath?.startsWith(`libraries/${first.id}/home/`)),true);

    const originalAudit=store.appendProjectAuditEvent.bind(store);
    store.appendProjectAuditEvent=async event=>{if(event.action==="file.upload")throw new Error("audit unavailable");return originalAudit(event)};
    const originalConsoleError=console.error;
    let auditFailureLogged=false;
    console.error=()=>{auditFailureLogged=true};
    const auditKey=crypto.randomUUID();
    const uploadWithAuditFailure=()=>fetch(`${api.baseUrl}/api/v1/projects/${projectId}/file-libraries/${second.id}/files?path=audit.txt`,{method:"PUT",headers:{cookie,"x-csrf-token":csrf,"content-type":"application/octet-stream","idempotency-key":auditKey},body:"actual"});
    try{
      assert.equal((await uploadWithAuditFailure()).status,200);
      assert.equal((await uploadWithAuditFailure()).status,200);
      assert.equal(auditFailureLogged,true);
    }finally{
      console.error=originalConsoleError;
      store.appendProjectAuditEvent=originalAudit;
    }

    assert.equal((await raw("DELETE", `/api/v1/projects/${projectId}/file-libraries/${first.id}`, {})).status, 409);
    await store.patchProjectResourcePolicy(projectId,{projectFileBytesLimit:1},new Date().toISOString());
    await json("DELETE", `/api/v1/projects/${projectId}/file-libraries/${first.id}/files`, { path: "payload.bin" });
    await json("DELETE", `/api/v1/projects/${projectId}/file-libraries/${first.id}/files`, { path: "readme.md" });
    assert.equal((await store.findProjectResourceUsage(projectId))?.projectFileBytes,6);
    assert.deepEqual(await json("DELETE", `/api/v1/projects/${projectId}/file-libraries/${first.id}`, {}), { deleted: true });
  });

  it("enforces reserved paths and performs one idempotent recursive entry deletion", async () => {
    await store.patchProjectResourcePolicy(projectId, { projectFileBytesLimit: null }, new Date().toISOString());
    const library = await json("POST", `/api/v1/projects/${projectId}/file-libraries`, { name: "Recursive files" });
    const project = await store.findProject(projectId);
    assert.ok(project);
    const libraryRoot = path.join(dataRoot, project.rootPath, library.rootSubPath);
    await mkdir(path.join(libraryRoot, "workspace", ".artifacts"), { recursive: true });
    await writeFile(path.join(libraryRoot, "workspace", ".artifacts", "task-owned.txt"), "owned");

    const nestedUpload = async (filePath: string, body: string) => {
      const response = await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/file-libraries/${library.id}/files?path=${encodeURIComponent(filePath)}`, {
        method: "PUT",
        headers: {
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/octet-stream",
          "idempotency-key": crypto.randomUUID()
        },
        body
      });
      assert.equal(response.status, 200, await response.text());
    };
    await nestedUpload("selected/first.txt", "one");
    await nestedUpload("selected/nested/second.txt", "two");
    await nestedUpload("keep.txt", "keep");

    const listed = await json("GET", `/api/v1/projects/${projectId}/file-libraries/${library.id}/files`);
    assert.deepEqual(listed.entries.map((entry: { path: string; capabilities: unknown }) => ({
      path: entry.path,
      capabilities: entry.capabilities
    })), [
      {
        path: "keep.txt",
        capabilities: { canDelete: true, deleteUnavailableReason: null }
      },
      {
        path: "selected",
        capabilities: { canDelete: true, deleteUnavailableReason: null }
      },
      {
        path: "workspace",
        capabilities: { canDelete: false, deleteUnavailableReason: "artifact_namespace_protected" }
      }
    ]);

    const hidden = await json("GET", `/api/v1/projects/${projectId}/file-libraries/${library.id}/files?path=workspace`);
    assert.deepEqual(hidden.entries, []);
    const reserved = await raw("DELETE", `/api/v1/projects/${projectId}/file-libraries/${library.id}/files`, { path: "workspace" });
    assert.equal(reserved.status, 409);
    assert.equal((await reserved.json()).code, "artifact_namespace_protected");

    const missing = await raw("GET", `/api/v1/projects/${projectId}/file-libraries/${library.id}/files?path=removed`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "file_path_not_found");

    const deleteKey = crypto.randomUUID();
    const deleteSelected = () => fetch(`${api.baseUrl}/api/v1/projects/${projectId}/file-libraries/${library.id}/files`, {
      method: "DELETE",
      headers: {
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
        "idempotency-key": deleteKey
      },
      body: JSON.stringify({ path: "selected" })
    });
    assert.equal((await deleteSelected()).status, 200);
    assert.equal((await deleteSelected()).status, 200);
    assert.equal((await store.findProjectResourceUsage(projectId))?.projectFileBytes, 15);

    const deleteAudits = (await store.queryProjectAuditEvents(projectId, { limit: 100 })).items
      .filter((event) => event.action === "file.delete" && event.resourceId === library.id && event.detail?.filePath?.endsWith("/selected"));
    assert.equal(deleteAudits.length, 1);
    assert.deepEqual(deleteAudits[0]?.detail, {
      filePath: `${library.rootSubPath}/selected`,
      bytes: 6,
      entryType: "directory"
    });

    await nestedUpload("selected/recreated.txt", "new");
    assert.equal((await deleteSelected()).status, 200);
    assert.equal(await readFile(path.join(libraryRoot, "selected", "recreated.txt"), "utf8"), "new");
    assert.deepEqual(await json("DELETE", `/api/v1/projects/${projectId}/file-libraries/${library.id}/files`, { path: "selected" }), { deleted: true });
    assert.equal(await readFile(path.join(libraryRoot, "workspace", ".artifacts", "task-owned.txt"), "utf8"), "owned");
  });

  it("projects read-only delete capability and structurally replays a typed DELETE error", async () => {
    const library = await json("POST", `/api/v1/projects/${projectId}/file-libraries`, { name: "Read only files" });
    const upload = await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/file-libraries/${library.id}/files?path=retained.txt`, {
      method: "PUT",
      headers: {
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/octet-stream",
        "idempotency-key": crypto.randomUUID()
      },
      body: "retained"
    });
    assert.equal(upload.status, 200, await upload.text());

    const timestamp = "2026-07-25T12:00:00.000Z";
    await store.createUser({
      id: "file_viewer",
      email: "file-viewer@example.test",
      emailVerified: true,
      passwordHash: "external:oidc",
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await store.createSession({
      id: "file-viewer-session",
      userId: "file_viewer",
      csrfToken: "file-viewer-csrf",
      createdAt: timestamp,
      expiresAt: "2999-01-01T00:00:00.000Z"
    });
    assert.notEqual(await store.createWorkspaceMembership({
      workspaceId,
      userId: "file_viewer",
      role: "viewer",
      createdAt: timestamp,
      updatedAt: timestamp
    }), "already_exists");
    assert.notEqual(await store.createProjectMembershipForWorkspaceMember({
      projectId,
      userId: "file_viewer",
      role: "viewer",
      createdAt: timestamp,
      updatedAt: timestamp
    }), "already_exists");

    const viewerListing = await fetch(
      `${api.baseUrl}/api/v1/projects/${projectId}/file-libraries/${library.id}/files`,
      { headers: { cookie: "asl_session=file-viewer-session" } }
    );
    assert.equal(viewerListing.status, 200);
    assert.deepEqual((await viewerListing.json()).entries.map((entry: { path: string; capabilities: unknown }) => ({
      path: entry.path,
      capabilities: entry.capabilities
    })), [{
      path: "retained.txt",
      capabilities: { canDelete: false, deleteUnavailableReason: "read_only" }
    }]);

    const key = crypto.randomUUID();
    const missingDelete = () => fetch(`${api.baseUrl}/api/v1/projects/${projectId}/file-libraries/${library.id}/files`, {
      method: "DELETE",
      headers: {
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
        "idempotency-key": key
      },
      body: JSON.stringify({ path: "missing.txt" })
    });
    const first = await missingDelete();
    const firstBody = await first.json();
    const replay = await missingDelete();
    assert.equal(first.status, 404);
    assert.equal(replay.status, 404);
    assert.deepEqual(firstBody, {
      error: "File path not found",
      code: "file_path_not_found"
    });
    assert.deepEqual(await replay.json(), firstBody);
  });

  async function json(method: string, pathname: string, body?: unknown, authenticated = true): Promise<any> {
    const response = await raw(method, pathname, body, authenticated);
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload;
  }

  function raw(method: string, pathname: string, body?: unknown, authenticated = true): Promise<Response> {
    const mutation = ["POST", "PATCH", "DELETE"].includes(method);
    return fetch(api.baseUrl + pathname, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(authenticated && cookie ? { cookie } : {}),
        ...(authenticated && mutation && csrf ? { "x-csrf-token": csrf, "idempotency-key": crypto.randomUUID() } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }
});
