import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  let projectId: string;
  const store = createLocalInMemoryProductStore();

  before(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-file-library-api-"));
    api = await createTestApiServer({ port: 0, dataRoot, builtinAdminPassword: "admin-password", store });
    await json("POST", "/api/v1/auth/bootstrap", { password: "admin-password" }, false);
    const login = await raw("POST", "/api/v1/auth/login", { email: "admin@agentsmith-lite.local", password: "admin-password" }, false);
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    csrf = (await login.json()).csrfToken;
    const workspace = await json("POST", "/api/v1/workspaces", { name: "Files" });
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
    const fileAudits=await store.listProjectAuditEvents(projectId);
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
    await json("DELETE", `/api/v1/projects/${projectId}/file-libraries/${first.id}/files`, { path: "payload.bin" });
    await json("DELETE", `/api/v1/projects/${projectId}/file-libraries/${first.id}/files`, { path: "readme.md" });
    assert.deepEqual(await json("DELETE", `/api/v1/projects/${projectId}/file-libraries/${first.id}`, {}), { deleted: true });
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
