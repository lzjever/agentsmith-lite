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
  let fileLibraryId="";
  let store:ReturnType<typeof createLocalInMemoryProductStore>;
  const memberSession = "member-session";

  before(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-v1-membership-"));
    store = createLocalInMemoryProductStore();
    const expiresAt = "2999-01-01T00:00:00.000Z";
    await store.createUser({
      id: "user_member",
      email: "member@example.test",
      emailVerified: true,
      passwordHash: "external:oidc",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    });
    await store.upsertUserProfilePreferences({ userId: "user_member", displayName: "Member display", timezone: null, bio: null, jobTitle: null, company: null, greetingPreference: null, interests: [], updatedAt: "2026-07-11T00:00:00.000Z" }, null);
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
    fileLibraryId=(await requestJson("POST",`/api/v1/projects/${projectId}/file-libraries`,{name:"Membership files"})).id;
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
    assert.equal((await fetch(`${api.baseUrl}/api/v1/workspaces/${workspaceId}/members?includePermissions=true`, { headers: { cookie } })).status, 400);
    assert.equal((await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/members?includePermissions=true`, { headers: { cookie } })).status, 400);
    const removedWorkspaceMemberField = await request("POST", `/api/v1/workspaces/${workspaceId}/members`, { email: "member@example.test", role: "viewer", invitationMessage: "legacy" });
    assert.equal(removedWorkspaceMemberField.response.status, 400);
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

    const workspaceMember = await requestJson("POST", `/api/v1/workspaces/${workspaceId}/members`, {
      email: "MEMBER@example.test",
      role: "viewer"
    });
    const updatedWorkspaceMember = await requestJson("PATCH", `/api/v1/workspaces/${workspaceId}/members`, {
      userId: "user_member",
      role: "member",
      expectedUpdatedAt: workspaceMember.updatedAt
    });
    const removedWorkspaceRoleField = await request("PATCH", `/api/v1/workspaces/${workspaceId}/members`, { userId: "user_member", role: "viewer", expectedUpdatedAt: updatedWorkspaceMember.updatedAt, permissions: [] });
    assert.equal(removedWorkspaceRoleField.response.status, 400);
    const staleWorkspaceUpdate = await request("PATCH", `/api/v1/workspaces/${workspaceId}/members`, {
      userId: "user_member",
      role: "admin",
      expectedUpdatedAt: workspaceMember.updatedAt
    });
    assert.equal(staleWorkspaceUpdate.response.status, 409);
    assert.deepEqual(staleWorkspaceUpdate.body, { error: "Workspace membership changed elsewhere. Reload and try again." });
    const staleWorkspaceDelete = await request("DELETE", `/api/v1/workspaces/${workspaceId}/members`, {
      userId: "user_member",
      expectedUpdatedAt: workspaceMember.updatedAt
    });
    assert.equal(staleWorkspaceDelete.response.status, 409);
    const removedProjectMemberField = await request("POST", `/api/v1/projects/${projectId}/members`, { userId: "user_member", role: "viewer", permissions: [] });
    assert.equal(removedProjectMemberField.response.status, 400);
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
    const ownerSelectedUsage=await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/usage?userId=user_member`,{headers:{cookie}});
    assert.equal(ownerSelectedUsage.status,200);assert.deepEqual((await ownerSelectedUsage.json() as {sandbox:unknown}).sandbox,{selectedUserId:"user_member",activeCount:0,launches:0,totalDurationSeconds:"0",cpuRequestSeconds:"0",memoryRequestByteSeconds:"0",rows:[]});
    const memberSelfUsage=await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/usage`,{headers:{cookie:`asl_session=${memberSession}`}});assert.equal(memberSelfUsage.status,200);assert.equal((await memberSelfUsage.json() as {sandbox:{selectedUserId:string}}).sandbox.selectedUserId,"user_member");
    assert.equal((await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/usage?userId=${ownerUserId}`,{headers:{cookie:`asl_session=${memberSession}`}})).status,403);
    assert.equal((await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/usage?userId=missing-user`,{headers:{cookie}})).status,404);
    await store.appendProjectAuditEvent({id:"audit_actor_owner_subject_member",projectId,actorId:ownerUserId,subjectUserId:"user_member",action:"sandbox.release_requested",status:"accepted",resourceKind:"sandbox",resourceId:"task_audit_1",detail:{taskId:"task_audit_1",runId:"run_audit_1"},createdAt:"2026-07-19T00:00:00.000Z"});
    await store.appendProjectAuditEvent({id:"audit_actor_member_subject_owner",projectId,actorId:"user_member",subjectUserId:ownerUserId,action:"sandbox.release_requested",status:"accepted",resourceKind:"sandbox",resourceId:"task_audit_2",detail:{taskId:"task_audit_2",runId:"run_audit_2"},createdAt:"2026-07-19T00:01:00.000Z"});
    const actorAudit=await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/audit?actorId=${ownerUserId}&action=sandbox.release_requested`,{headers:{cookie}});assert.equal(actorAudit.status,200);assert.deepEqual((await actorAudit.json() as {items:Array<{id:string}>}).items.map((item)=>item.id),["audit_actor_owner_subject_member"]);
    const subjectAudit=await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/audit?subjectUserId=user_member&action=sandbox.release_requested`,{headers:{cookie}});assert.equal(subjectAudit.status,200);assert.deepEqual((await subjectAudit.json() as {items:Array<{id:string}>}).items.map((item)=>item.id),["audit_actor_owner_subject_member"]);

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
    assert.deepEqual(await capabilities.json(), { canManageEndpoints: false, canManageMembers: false, canManagePolicy: false, canWriteFiles: false, canCreateTasks: false, canSendChat: false });
    const fileList = await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/file-libraries/${fileLibraryId}/files`, {
      headers: { cookie: `asl_session=${memberSession}` }
    });
    assert.equal(fileList.status, 200);
    const viewerUpload = await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/file-libraries/${fileLibraryId}/files?path=viewer.txt`, {
      method: "PUT",
      headers: { cookie: `asl_session=${memberSession}`, "x-csrf-token": "member-csrf-token", "content-type": "application/octet-stream", "idempotency-key": "viewer-upload" },
      body: "viewer"
    });
    assert.equal(viewerUpload.status, 403);
    const viewerDelete = await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/file-libraries/${fileLibraryId}/files`, {
      method: "DELETE",
      headers: { cookie: `asl_session=${memberSession}`, "x-csrf-token": "member-csrf-token", "content-type": "application/json", "idempotency-key": "viewer-delete" },
      body: JSON.stringify({ path: "viewer.txt" })
    });
    assert.equal(viewerDelete.status, 403);

    const updated = await requestJson("PATCH", `/api/v1/projects/${projectId}/members`, {
      userId: "user_member",
      role: "member",
      expectedUpdatedAt: created.updatedAt
    });
    assert.equal(updated.role, "member");
    const removedProjectRoleField = await request("PATCH", `/api/v1/projects/${projectId}/members`, { userId: "user_member", role: "viewer", expectedUpdatedAt: updated.updatedAt, permissions: [] });
    assert.equal(removedProjectRoleField.response.status, 400);
    const removedProjectDeleteField = await request("DELETE", `/api/v1/projects/${projectId}/members`, { userId: "user_member", expectedUpdatedAt: updated.updatedAt, force: true });
    assert.equal(removedProjectDeleteField.response.status, 400);
    const staleUpdate = await request("PATCH", `/api/v1/projects/${projectId}/members`, {
      userId: "user_member",
      role: "admin",
      expectedUpdatedAt: created.updatedAt
    });
    assert.equal(staleUpdate.response.status, 409);
    const staleDelete = await request("DELETE", `/api/v1/projects/${projectId}/members`, {
      userId: "user_member",
      expectedUpdatedAt: created.updatedAt
    });
    assert.equal(staleDelete.response.status, 409);
    const memberUpload = await fetch(`${api.baseUrl}/api/v1/projects/${projectId}/file-libraries/${fileLibraryId}/files?path=member.txt`, {
      method: "PUT",
      headers: { cookie: `asl_session=${memberSession}`, "x-csrf-token": "member-csrf-token", "content-type": "application/octet-stream", "idempotency-key": "member-upload" },
      body: "member"
    });
    assert.equal(memberUpload.status, 200);

    const missing = await request("PATCH", `/api/v1/projects/${projectId}/members`, {
      userId: "user_oidc_member",
      role: "viewer",
      expectedUpdatedAt: "2026-07-18T00:00:00.000Z"
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
      userId: "user_oidc_member",
      expectedUpdatedAt: oidcMember.updatedAt
    });
    assert.deepEqual(deleted, { deleted: true });

    const ownerMembership = members.find((member: { userId: string }) => member.userId === ownerUserId);
    const ownerUpdate = await request("PATCH", `/api/v1/projects/${projectId}/members`, { userId: ownerUserId, role: "admin", expectedUpdatedAt: ownerMembership.updatedAt });
    assert.equal(ownerUpdate.response.status, 409);
    const ownerDelete = await request("DELETE", `/api/v1/projects/${projectId}/members`, { userId: ownerUserId, expectedUpdatedAt: ownerMembership.updatedAt });
    assert.equal(ownerDelete.response.status, 409);
    const workspaceMembers = await requestJson("GET", `/api/v1/workspaces/${workspaceId}/members`);
    const workspaceOwner = workspaceMembers.find((member: { userId: string }) => member.userId === ownerUserId);
    const workspaceOwnerDelete = await request("DELETE", `/api/v1/workspaces/${workspaceId}/members`, { userId: ownerUserId, expectedUpdatedAt: workspaceOwner.updatedAt });
    assert.equal(workspaceOwnerDelete.response.status, 409);

    await requestJson("DELETE", `/api/v1/workspaces/${workspaceId}/members`, { userId: "user_member", expectedUpdatedAt: updatedWorkspaceMember.updatedAt });
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
        ...((method === "POST" && (pathname === "/api/v1/workspaces" || /^\/api\/v1\/workspaces\/[^/]+\/projects$/.test(pathname) || /^\/api\/v1\/projects\/[^/]+\/(credentials|endpoints|file-libraries)$/.test(pathname))) || (["POST", "PATCH", "DELETE"].includes(method) && /^\/api\/v1\/(workspaces|projects)\/[^/]+\/members$/.test(pathname)) ? { "idempotency-key": crypto.randomUUID() } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { response, body: await response.json() };
  }
});
