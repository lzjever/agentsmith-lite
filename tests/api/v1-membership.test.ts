import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createTestApiServer as createApiServer, type RunningApiServer } from "../../packages/api-entry-node/src/server.js";

describe("v1 project membership API", () => {
  let api: RunningApiServer;
  let dataRoot = "";
  let cookie = "";
  let csrfToken = "";
  let workspaceId = "";
  let projectId = "";
  let ownerUserId = "";
  const memberSession = "member-session";

  before(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-v1-membership-"));
    const store = createLocalInMemoryProductStore();
    const expiresAt = "2999-01-01T00:00:00.000Z";
    await store.createUser({
      id: "user_member",
      email: "member@example.test",
      emailVerified: true,
      passwordHash: "external:oidc",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    });
    await store.upsertUserProfilePreferences({ userId: "user_member", displayName: "Member display", timezone: null, bio: null, jobTitle: null, company: null, greetingPreference: null, interests: [], updatedAt: "2026-07-11T00:00:00.000Z" });
    await store.createUser({
      id: "user_oidc_member",
      email: "oidc-member@example.test",
      oidcIssuer: "https://keycloak.example.test/realms/agentsmith",
      oidcSubject: "member-subject",
      emailVerified: true,
      passwordHash: "external:oidc",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    });
    await store.createSession({
      id: memberSession,
      userId: "user_member",
      csrfToken: "member-csrf-token",
      createdAt: "2026-07-11T00:00:00.000Z",
      expiresAt
    });
    api = await createApiServer({ port: 0, dataRoot, builtinAdminPassword: "admin-password", store });

    await request("POST", "/api/v1/auth/bootstrap", { password: "admin-password" });
    const login = await request("POST", "/api/v1/auth/login", {
      email: "admin@agentsmith-lite.local",
      password: "admin-password"
    });
    cookie = login.response.headers.get("set-cookie")?.split(";")[0] ?? "";
    csrfToken = (login.body as { csrfToken: string }).csrfToken;
    const workspace = await requestJson("POST", "/api/v1/workspaces", { name: "Membership workspace" });
    workspaceId = workspace.id;
    const project = await requestJson("POST", `/api/v1/workspaces/${workspace.id}/projects`, { name: "Membership project" });
    projectId = project.id;
    ownerUserId = project.ownerUserId;
  });

  after(async () => {
    await api.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("uses workspace identity lookup and stable user IDs for project membership", async () => {
    const denied = await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/endpoints`, {
      headers: { cookie: `asl_session=${memberSession}` }
    });
    assert.equal(denied.status, 403, "project membership is required");
    const missingMembershipKey = await fetch(`${api.baseUrl}/api/v1/workspaces/${workspaceId}/members`, { method: "POST", headers: { cookie, "x-csrf-token": csrfToken, "content-type": "application/json" }, body: JSON.stringify({ email: "member@example.test", role: "viewer" }) });
    assert.equal(missingMembershipKey.status, 400);
    assert.deepEqual(await missingMembershipKey.json(), { error: "Idempotency-Key header is required" });
    for (const resource of ["alerts", "audit"]) {
      const response = await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/${resource}`, {
        headers: { cookie: `asl_session=${memberSession}` }
      });
      assert.equal(response.status, 403, `${resource} requires project membership`);
    }

    const outsideWorkspace = await request("POST", `/api/v1/projects/${projectId}/members`, {
      userId: "user_member",
      role: "viewer"
    });
    assert.equal(outsideWorkspace.response.status, 409);

    await requestJson("POST", `/api/v1/workspaces/${workspaceId}/members`, {
      email: "MEMBER@example.test",
      role: "viewer"
    });
    const created = await requestJson("POST", `/api/v1/projects/${projectId}/members`, {
      userId: "user_member",
      role: "viewer"
    });
    assert.deepEqual(created, {
      projectId,
      userId: "user_member",
      role: "viewer",
      displayName: "Member display",
      email: "member@example.test",
      createdAt: created.createdAt,
      updatedAt: created.updatedAt
    });

    const visible = await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/endpoints`, {
      headers: { cookie: `asl_session=${memberSession}` }
    });
    assert.equal(visible.status, 200);
    for (const resource of ["alerts", "audit"]) {
      const response = await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/${resource}`, {
        headers: { cookie: `asl_session=${memberSession}` }
      });
      assert.equal(response.status, 200, `${resource} is visible to a project viewer`);
    }
    const capabilities = await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/capabilities`, {
      headers: { cookie: `asl_session=${memberSession}` }
    });
    assert.deepEqual(await capabilities.json(), { canManageEndpoints: false, canManageMembers: false, canManagePolicy: false, canWriteFiles: false, canCreateTasks: false, canCancelTasks: false, canSendChat: false });
    const fileList = await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/files?path=files`, {
      headers: { cookie: `asl_session=${memberSession}` }
    });
    assert.equal(fileList.status, 200);
    const viewerUpload = await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/files?path=files%2Fviewer.txt`, {
      method: "PUT",
      headers: { cookie: `asl_session=${memberSession}`, "x-csrf-token": "member-csrf-token", "content-type": "application/octet-stream" },
      body: "viewer"
    });
    assert.equal(viewerUpload.status, 403);
    const viewerDelete = await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/files`, {
      method: "DELETE",
      headers: { cookie: `asl_session=${memberSession}`, "x-csrf-token": "member-csrf-token", "content-type": "application/json" },
      body: JSON.stringify({ path: "files/viewer.txt" })
    });
    assert.equal(viewerDelete.status, 403);

    const updated = await requestJson("PATCH", `/api/v1/projects/${projectId}/members`, {
      userId: "user_member",
      role: "member"
    });
    assert.equal(updated.role, "member");
    const memberUpload = await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/files?path=files%2Fmember.txt`, {
      method: "PUT",
      headers: { cookie: `asl_session=${memberSession}`, "x-csrf-token": "member-csrf-token", "content-type": "application/octet-stream" },
      body: "member"
    });
    assert.equal(memberUpload.status, 200);

    const missing = await request("PATCH", `/api/v1/projects/${projectId}/members`, {
      userId: "user_oidc_member",
      role: "viewer"
    });
    assert.equal(missing.response.status, 404);

    await requestJson("POST", `/api/v1/workspaces/${workspaceId}/members`, {
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "member-subject",
      role: "viewer"
    });
    const oidcMember = await requestJson("POST", `/api/v1/projects/${projectId}/members`, {
      userId: "user_oidc_member",
      role: "viewer"
    });
    assert.equal(oidcMember.userId, "user_oidc_member");

    const members = await requestJson("GET", `/api/v1/projects/${projectId}/members`);
    assert.deepEqual(members.map((member: { userId: string; role: string }) => [member.userId, member.role]), [
      [ownerUserId, "owner"],
      ["user_member", "member"],
      ["user_oidc_member", "viewer"]
    ]);
    const displayed = members.find((member: { userId: string }) => member.userId === "user_member");
    assert.deepEqual({ displayName: displayed.displayName, email: displayed.email }, { displayName: "Member display", email: "member@example.test" });
    assert.equal("oidcIssuer" in displayed, false);
    assert.equal("oidcSubject" in displayed, false);
    assert.equal("passwordHash" in displayed, false);

    const deleted = await requestJson("DELETE", `/api/v1/projects/${projectId}/members`, {
      userId: "user_oidc_member"
    });
    assert.deepEqual(deleted, { deleted: true });

    const ownerUpdate = await request("PATCH", `/api/v1/projects/${projectId}/members`, { userId: ownerUserId, role: "admin" });
    assert.equal(ownerUpdate.response.status, 409);
    const ownerDelete = await request("DELETE", `/api/v1/projects/${projectId}/members`, { userId: ownerUserId });
    assert.equal(ownerDelete.response.status, 409);
    const workspaceOwnerDelete = await request("DELETE", `/api/v1/workspaces/${workspaceId}/members`, { userId: ownerUserId });
    assert.equal(workspaceOwnerDelete.response.status, 409);

    await requestJson("DELETE", `/api/v1/workspaces/${workspaceId}/members`, { userId: "user_member" });
    const revoked = await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/endpoints`, {
      headers: { cookie: `asl_session=${memberSession}` }
    });
    assert.equal(revoked.status, 403);

    const missingUserId = await request("POST", `/api/v1/projects/${projectId}/members`, { role: "viewer" });
    assert.equal(missingUserId.response.status, 400);
  });

  async function requestJson(method: string, pathname: string, body?: unknown): Promise<any> {
    const result = await request(method, pathname, body);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    return result.body;
  }

  async function request(method: string, pathname: string, body?: unknown): Promise<{ response: Response; body: any }> {
    const response = await fetch(api.baseUrl + pathname, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...(["POST", "PATCH", "DELETE"].includes(method) && csrfToken ? { "x-csrf-token": csrfToken } : {}),
        ...(method === "POST" && (pathname === "/api/v1/workspaces" || /^\/api\/v1\/workspaces\/[^/]+\/(projects|members)$/.test(pathname) || /^\/api\/v1\/projects\/[^/]+\/(credentials|endpoints|members)$/.test(pathname)) ? { "idempotency-key": crypto.randomUUID() } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { response, body: await response.json() };
  }
});
