import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { ProductError } from "../../packages/domain/src/errors.js";

const issuer = "https://keycloak.example.test/realms/agentsmith";

describe("bounded membership directories", () => {
  it("pages workspace members by immutable key, filters on the server, and binds cursors to the full scope", async () => {
    const fixture = await createFixture();
    const alpha = await fixture.user("alpha", "Alpha.Person@example.test", "Alpha Person");
    const astral = await fixture.userWithId("user_\u{10000}", "astral@example.test", "Astral");
    const highBmp = await fixture.userWithId("user_\uE000", "high-bmp@example.test", "High BMP");
    await fixture.workspaceMember(alpha.id, "admin", "2026-07-20T00:00:01.000Z");
    await fixture.workspaceMember(highBmp.id, "viewer", "2026-07-20T00:00:02.000Z");
    await fixture.workspaceMember(astral.id, "viewer", "2026-07-20T00:00:02.000Z");

    const first = await fixture.services.workspaceMemberships.list(fixture.owner.id, fixture.workspace.id, { limit: 2 });
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    const second = await fixture.services.workspaceMemberships.list(fixture.owner.id, fixture.workspace.id, { cursor: first.nextCursor!, limit: 2 });
    const tied = [astral.id, highBmp.id].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    assert.deepEqual([...first.items, ...second.items].map((member) => member.userId), [
      fixture.owner.id,
      alpha.id,
      ...tied
    ]);

    assert.deepEqual(
      (await fixture.services.workspaceMemberships.list(fixture.owner.id, fixture.workspace.id, { q: "alpha.person", role: "admin" })).items.map((member) => member.userId),
      [alpha.id]
    );
    await assert.rejects(
      () => fixture.services.workspaceMemberships.list(alpha.id, fixture.workspace.id, { cursor: first.nextCursor!, limit: 1 }),
      invalidCursor("Membership directory cursor is invalid")
    );
    await assert.rejects(
      () => fixture.services.workspaceMemberships.list(fixture.owner.id, fixture.workspace.id, { q: "changed", cursor: first.nextCursor! }),
      invalidCursor("Membership directory cursor is invalid")
    );
    await assert.rejects(
      () => fixture.services.workspaceMemberships.list(fixture.owner.id, fixture.workspace.id, { q: "bad\u0007query" }),
      status(400)
    );
    await assert.rejects(
      () => fixture.services.workspaceMemberships.list(fixture.owner.id, fixture.workspace.id, { cursor: "" }),
      invalidCursor("Membership directory cursor is invalid")
    );
  });

  it("returns bounded project candidates from workspace membership minus project membership", async () => {
    const fixture = await createFixture();
    const admin = await fixture.user("admin", "admin@example.test", "Project Admin");
    const existing = await fixture.user("existing", "existing@example.test", "Existing");
    const candidateA = await fixture.user("candidate-a", "candidate-a@example.test", "Candidate A");
    const candidateB = await fixture.user("candidate-b", "candidate-b@example.test", "Candidate B");
    for (const user of [admin, existing, candidateA, candidateB]) await fixture.workspaceMember(user.id, "member");
    await fixture.projectMember(admin.id, "admin");
    await fixture.projectMember(existing.id, "viewer");

    const first = await fixture.services.memberships.listCandidates(fixture.owner.id, fixture.project.id, { limit: 1 });
    assert.deepEqual(first.items.map((candidate) => candidate.userId), [candidateA.id]);
    assert.ok(first.nextCursor);
    assert.deepEqual(
      (await fixture.services.memberships.listCandidates(fixture.owner.id, fixture.project.id, { cursor: first.nextCursor!, limit: 1 })).items.map((candidate) => candidate.userId),
      [candidateB.id]
    );
    assert.deepEqual(
      (await fixture.services.memberships.listCandidates(fixture.owner.id, fixture.project.id, { q: "CANDIDATE-B" })).items.map((candidate) => candidate.userId),
      [candidateB.id]
    );
    await assert.rejects(
      () => fixture.services.memberships.listMembers(fixture.owner.id, fixture.project.id, { cursor: "" }),
      invalidCursor("Membership directory cursor is invalid")
    );
    await assert.rejects(
      () => fixture.services.memberships.listCandidates(fixture.owner.id, fixture.project.id, { cursor: "" }),
      invalidCursor("Membership directory cursor is invalid")
    );
    await assert.rejects(() => fixture.services.memberships.listCandidates(existing.id, fixture.project.id), status(403));
  });

  it("uses exact rich reads for mutation results and does not audit a successful write as rejected when projection fails", async () => {
    const fixture = await createFixture();
    const member = await fixture.user("projection", "projection@example.test", "Projection Member");
    await fixture.workspaceMember(member.id, "member");
    const original = fixture.store.findProjectMembershipView.bind(fixture.store);
    fixture.store.findProjectMembershipView = async () => {
      throw new Error("identity projection failed");
    };

    await assert.rejects(
      () => fixture.services.memberships.addMember(fixture.owner.id, fixture.project.id, member.id, "member"),
      /identity projection failed/
    );
    assert.equal((await fixture.store.findProjectMembership(fixture.project.id, member.id))?.role, "member");
    const events = (await fixture.store.queryProjectAuditEvents(fixture.project.id, { limit: 20 })).items.filter((event) => event.resourceId === member.id);
    assert.deepEqual(events.map((event) => event.status), ["accepted"]);

    fixture.store.findProjectMembershipView = original;
    const view = await fixture.store.findProjectMembershipView(fixture.project.id, member.id);
    assert.deepEqual(view && [view.displayName, view.email], ["Projection Member", "projection@example.test"]);
  });

  it("keeps complete project membership fan-out independent from bounded directories", async () => {
    const fixture = await createFixture();
    for (let index = 0; index < 55; index += 1) {
      const user = await fixture.user(`fanout-${index}`, `fanout-${index}@example.test`, null);
      await fixture.workspaceMember(user.id, "member");
      await fixture.projectMember(user.id, "admin");
    }

    const directory = await fixture.services.memberships.listMembers(fixture.owner.id, fixture.project.id);
    assert.equal(directory.items.length, 20);
    assert.equal((await fixture.store.listProjectMembershipsForFanout(fixture.project.id)).length, 56);
  });
});

async function createFixture() {
  const store = createInMemoryProductStore();
  const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
  const owner = (await services.auth.loginExternalPrincipal({ issuer, subject: "owner", email: "owner@example.test", emailVerified: true })).user;
  const workspace = await services.workspaces.createWorkspace(owner.id, { name: "Workspace" });
  const project = await services.workspaces.createProject(owner.id, workspace.id, { name: "Project" });
  await store.upsertWorkspaceMembership({ workspaceId: workspace.id, userId: owner.id, role: "owner", createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z" });
  let sequence = 10;
  const timestamp = () => new Date(Date.parse("2026-07-20T00:01:00.000Z") + sequence++ * 1_000).toISOString();
  return {
    store,
    services,
    owner,
    workspace,
    project,
    async user(subject: string, email: string, displayName: string | null) {
      const user = (await services.auth.loginExternalPrincipal({ issuer, subject, email, emailVerified: true })).user;
      await store.upsertUserProfilePreferences({ userId: user.id, displayName, timezone: null, bio: null, jobTitle: null, company: null, greetingPreference: null, interests: [], updatedAt: "2026-07-20T00:00:00.000Z" }, null);
      return user;
    },
    async userWithId(id: string, email: string, displayName: string | null) {
      const createdAt="2026-07-20T00:00:00.000Z";
      const user=await store.createUser({id,email,emailVerified:true,passwordHash:"test-only",createdAt,updatedAt:createdAt});
      await store.upsertUserProfilePreferences({userId:id,displayName,timezone:null,bio:null,jobTitle:null,company:null,greetingPreference:null,interests:[],updatedAt:createdAt},null);
      return user;
    },
    async workspaceMember(userId: string, role: "admin" | "member" | "viewer", createdAt?: string) {
      const at = createdAt ?? timestamp();
      await store.upsertWorkspaceMembership({ workspaceId: workspace.id, userId, role, createdAt: at, updatedAt: at });
    },
    async projectMember(userId: string, role: "admin" | "member" | "viewer") {
      const at = timestamp();
      await store.upsertProjectMembership({ projectId: project.id, userId, role, createdAt: at, updatedAt: at });
    }
  };
}

function status(code: number) {
  return (error: unknown) => error instanceof ProductError && error.statusCode === code;
}

function invalidCursor(message: string) {
  return (error: unknown) => error instanceof ProductError && error.statusCode === 400 && error.message === message;
}
