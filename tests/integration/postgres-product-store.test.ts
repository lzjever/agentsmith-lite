import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, beforeEach, describe, it } from "node:test";
import pg from "pg";
import type { AgentTask, ModelEndpoint, Project, ProjectMembership, StoredUser, TaskAssistantMessageInteraction, Workspace } from "../../packages/contracts/src/api.js";
import type { PersistedTaskArtifact } from "../../packages/ports/src/store.js";
import { PostgresProductStore } from "../../packages/adapters-postgres/src/postgresProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { SandboxRunState } from "../../packages/sandbox-controller/src/reconciler.js";

const postgresUrl = process.env.POSTGRES_APP_URL;
const postgresDescribe = postgresUrl ? describe : describe.skip;

postgresDescribe("postgres product store", () => {
  assert.ok(postgresUrl);
  const store = new PostgresProductStore(postgresUrl);

  beforeEach(async () => {
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      await client.query(`
        truncate table
          agent_task_artifacts,
          task_interaction_changes,
          task_messages,
          agent_tasks,
          model_endpoints,
          projects,
          workspaces,
          auth_sessions,
          users,
          postgres_json_docs,
          runtime_leases
        cascade
      `);
    } finally {
      await client.end();
    }
  });

  after(async () => {
    await store.close();
  });

  it("initializes a new task interaction snapshot with complete history", async () => {
    const timestamp = "2026-07-13T00:00:00.000Z";
    await store.createUser({ id: "user_interaction_sync", email: "interaction-sync@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_interaction_sync", name: "Interaction sync", ownerUserId: "user_interaction_sync", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_interaction_sync", workspaceId: "ws_interaction_sync", name: "Interaction sync", ownerUserId: "user_interaction_sync", rootPath: "workspaces/ws_interaction_sync/projects/proj_interaction_sync", taskConcurrencyLimit: 1, createdAt: timestamp, updatedAt: timestamp });
    await createTestCredential(store, "proj_interaction_sync", "cred_interaction_sync", timestamp);
    await store.createEndpoint(endpointRecord("endpoint_interaction_sync", "proj_interaction_sync", "cred_interaction_sync", timestamp));
    await store.createTask({ id: "task_interaction_sync", workspaceId: "ws_interaction_sync", projectId: "proj_interaction_sync", endpointId: "endpoint_interaction_sync", prompt: "hello", status: "starting", runId: "run_interaction_sync", executionMode: "live", sandbox: { namespace: "agentsmith", resources: [] }, createdAt: timestamp, updatedAt: timestamp });

    const snapshot = await store.readTaskInteractionSnapshot("task_interaction_sync", null, 10);
    assert.equal(snapshot?.sourceCursor, null);
    assert.equal(snapshot?.historyStatus, "complete");
    assert.equal(snapshot?.lastSyncedAt, null);
  });

  it("atomically enforces active task capacity across concurrent store requests", async () => {
    const timestamp = "2026-07-04T00:00:00.000Z";
    await store.createUser({ id: "user_policy", email: "policy@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_policy", name: "Policy", ownerUserId: "user_policy", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_policy", workspaceId: "ws_policy", name: "Policy", ownerUserId: "user_policy", rootPath: "workspaces/ws_policy/projects/proj_policy", taskConcurrencyLimit: 1, createdAt: timestamp, updatedAt: timestamp });
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });

    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
      services.policies.reserveTask("proj_policy", "user_policy", `task-${index}`)
    ));

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await store.findProjectResourceUsage("proj_policy"))?.activeTasks, 1);
  });

  it("atomically enforces the matching active-task and file-byte deltas without blocking releases", async () => {
    const timestamp = "2026-07-12T00:00:00.000Z";
    await store.createUser({ id: "user_quota", email: "quota@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_quota", name: "Quota", ownerUserId: "user_quota", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_quota", workspaceId: "ws_quota", name: "Quota", ownerUserId: "user_quota", rootPath: "workspaces/ws_quota/projects/proj_quota", taskConcurrencyLimit: 1, createdAt: timestamp, updatedAt: timestamp });

    await store.patchProjectResourcePolicy("proj_quota", { projectFileBytesLimit: 0 }, timestamp);
    assert.equal(await adjustFileBytes(store, "proj_quota", 1, timestamp), null);
    assert.equal((await store.findProjectResourceUsage("proj_quota"))?.projectFileBytes, 0);

    await store.patchProjectResourcePolicy("proj_quota", { projectFileBytesLimit: 1 }, timestamp);
    assert.equal((await adjustFileBytes(store, "proj_quota", 1, timestamp))?.projectFileBytes, 1);
    assert.equal(await adjustFileBytes(store, "proj_quota", 1, timestamp), null);
    assert.equal((await store.findProjectResourceUsage("proj_quota"))?.projectFileBytes, 1);
    assert.equal((await adjustFileBytes(store, "proj_quota", -1, timestamp))?.projectFileBytes, 0);

    const concurrent = await Promise.all([adjustFileBytes(store, "proj_quota", 1, timestamp), adjustFileBytes(store, "proj_quota", 1, timestamp)]);
    assert.equal(concurrent.filter(Boolean).length, 1);
    assert.equal((await store.findProjectResourceUsage("proj_quota"))?.projectFileBytes, 1);

    await store.patchProjectResourcePolicy("proj_quota", { activeTasksLimit: 0 }, timestamp);
    assert.equal(await adjustActiveTasks(store, "proj_quota", 1, timestamp), null);
    await store.patchProjectResourcePolicy("proj_quota", { activeTasksLimit: 1 }, timestamp);
    assert.equal((await adjustActiveTasks(store, "proj_quota", 1, timestamp))?.activeTasks, 1);
    await store.patchProjectResourcePolicy("proj_quota", { activeTasksLimit: 0 }, timestamp);
    assert.equal((await adjustActiveTasks(store, "proj_quota", -1, timestamp))?.activeTasks, 0);

    await store.upsertProjectMembership({ projectId: "proj_quota", userId: "user_quota", role: "owner", createdAt: timestamp, updatedAt: timestamp });
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    await services.alertRules.create("user_quota", "proj_quota", { alertType: "project_file_bytes_limit" });
    await services.policies.raiseAlert("proj_quota", "project_file_bytes_limit");
    const [alert] = await services.policies.alerts("user_quota", "proj_quota");
    await services.policies.transitionAlert("user_quota", "proj_quota", alert!.id, "resolved");
    assert.equal((await store.listProjectAuditEvents("proj_quota")).some((event) => event.action === "alert.resolve" && event.resourceKind === "alert"), true);
  });

  it("atomically blocks endpoint deletion for tasks and unlinks retained chat and settlement history", async () => {
    const timestamp = "2026-07-12T00:00:00.000Z";
    await store.createUser({ id: "user_endpoint_delete", email: "endpoint-delete@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_endpoint_delete", name: "Endpoint delete", ownerUserId: "user_endpoint_delete", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_endpoint_delete", workspaceId: "ws_endpoint_delete", name: "Endpoint delete", ownerUserId: "user_endpoint_delete", rootPath: "workspaces/ws_endpoint_delete/projects/proj_endpoint_delete", taskConcurrencyLimit: 2, createdAt: timestamp, updatedAt: timestamp });
    await createTestCredential(store, "proj_endpoint_delete", "cred_endpoint_delete", timestamp);

    const blockedEndpoint = endpointRecord("endpoint_delete_blocked", "proj_endpoint_delete", "cred_endpoint_delete", timestamp);
    await store.createEndpoint(blockedEndpoint);
    const blockedThread = await store.createProjectChatThread({ id: "thread_endpoint_delete_blocked", projectId: blockedEndpoint.projectId, endpointId: blockedEndpoint.id, title: "Blocked history", createdAt: timestamp, updatedAt: timestamp });
    await settleProvider(store, "settlement_endpoint_delete_blocked", blockedEndpoint.projectId, blockedEndpoint.id, timestamp);
    await store.createTask({
      id: "task_endpoint_delete_blocked",
      workspaceId: "ws_endpoint_delete",
      projectId: blockedEndpoint.projectId,
      endpointId: blockedEndpoint.id,
      prompt: "Retain endpoint",
      status: "completed",
      runId: "run_endpoint_delete_blocked",
      executionMode: "dry-run",
      sandbox: { namespace: "agentsmith", resources: [] },
      createdAt: timestamp,
      updatedAt: timestamp
    });

    assert.equal(await store.deleteEndpoint(blockedEndpoint.id), "referenced_by_tasks");
    assert.equal((await store.findEndpoint(blockedEndpoint.id))?.id, blockedEndpoint.id);
    assert.equal((await store.findProjectChatThread(blockedThread.id))?.endpointId, blockedEndpoint.id);
    assert.equal((await store.listSettledProjectProviderSettlements(blockedEndpoint.projectId, "2026-07-01T00:00:00.000Z")).find((item) => item.id === "settlement_endpoint_delete_blocked")?.endpointId, blockedEndpoint.id);

    const deletedEndpoint = endpointRecord("endpoint_delete_history", "proj_endpoint_delete", "cred_endpoint_delete", timestamp);
    await store.createEndpoint(deletedEndpoint);
    const retainedThread = await store.createProjectChatThread({ id: "thread_endpoint_delete_history", projectId: deletedEndpoint.projectId, endpointId: deletedEndpoint.id, title: "Retained history", createdAt: timestamp, updatedAt: timestamp });
    await settleProvider(store, "settlement_endpoint_delete_history", deletedEndpoint.projectId, deletedEndpoint.id, timestamp);

    assert.equal(await store.deleteEndpoint(deletedEndpoint.id), "deleted");
    assert.equal(await store.findEndpoint(deletedEndpoint.id), null);
    assert.equal((await store.findProjectChatThread(retainedThread.id))?.endpointId, null);
    assert.equal((await store.listSettledProjectProviderSettlements(deletedEndpoint.projectId, "2026-07-01T00:00:00.000Z")).find((item) => item.id === "settlement_endpoint_delete_history")?.endpointId, null);
    assert.equal(await store.deleteEndpoint("endpoint_delete_missing"), "not_found");
  });

  it("keeps resolved project alerts as history while allowing one new active event per type", async () => {
    const timestamp = "2026-07-12T00:00:00.000Z";
    await store.createUser({ id: "user_alert_history", email: "alert-history@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_alert_history", name: "Alert history", ownerUserId: "user_alert_history", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_alert_history", workspaceId: "ws_alert_history", name: "Alert history", ownerUserId: "user_alert_history", rootPath: "workspaces/ws_alert_history/projects/proj_alert_history", taskConcurrencyLimit: 1, createdAt: timestamp, updatedAt: timestamp });
    const first = await store.upsertActiveProjectAlert({ id: "alert_history_1", projectId: "proj_alert_history", type: "task_failure", status: "active", deliveryStatus: "pending", createdAt: timestamp, updatedAt: timestamp, resolvedAt: null, dismissedAt: null });
    assert.equal((await store.updateProjectAlertDeliveryStatus(first.projectId, first.id, "delivered", "2026-07-12T00:01:00.000Z"))?.deliveryStatus, "delivered");
    assert.equal((await store.transitionProjectAlert(first.projectId, first.id, "resolved", "2026-07-12T00:02:00.000Z"))?.status, "resolved");
    await store.upsertActiveProjectAlert({ id: "alert_history_2", projectId: first.projectId, type: first.type, status: "active", deliveryStatus: "not_configured", createdAt: "2026-07-12T00:03:00.000Z", updatedAt: "2026-07-12T00:03:00.000Z", resolvedAt: null, dismissedAt: null });
    assert.deepEqual((await store.listProjectAlerts(first.projectId)).map((alert) => [alert.id, alert.status]), [["alert_history_2", "active"], ["alert_history_1", "resolved"]]);
  });

  it("atomically round-trips a terminal message successor and rolls back a duplicate linkage", async () => {
    const timestamp = "2026-07-11T00:00:00.000Z";
    await store.createUser({ id: "user_follow_up", email: "follow-up@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_follow_up", name: "Follow up", ownerUserId: "user_follow_up", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_follow_up", workspaceId: "ws_follow_up", name: "Follow up", ownerUserId: "user_follow_up", rootPath: "workspaces/ws_follow_up/projects/proj_follow_up", taskConcurrencyLimit: 2, createdAt: timestamp, updatedAt: timestamp });
    await store.createProjectCredential({ id: "cred_follow_up", projectId: "proj_follow_up", name: "Provider", type: "api_key", baseUrl: "https://models.example.test/v1", keyId: "test", nonce: Buffer.alloc(12), ciphertext: Buffer.from("ciphertext"), authTag: Buffer.alloc(16), fingerprint: "fingerprint", version: 1, createdAt: timestamp, lastRotatedAt: null, updatedAt: timestamp });
    await store.createEndpoint({ id: "endpoint_follow_up", projectId: "proj_follow_up", name: "Endpoint", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "m", credentialId: "cred_follow_up", capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30, createdAt: timestamp, updatedAt: timestamp });
    const source: AgentTask = { id: "task_follow_source", workspaceId: "ws_follow_up", projectId: "proj_follow_up", endpointId: "endpoint_follow_up", prompt: "source", status: "completed", runId: "run_follow_source", executionMode: "dry-run", sandbox: { namespace: "agentsmith", resources: [] }, createdAt: timestamp, updatedAt: timestamp };
    const successor: AgentTask = { ...source, id: "task_follow_successor", prompt: "continue", status: "starting", runId: "run_follow_successor", sourceTaskId: source.id };
    await store.createTask(source);
    const linked = await store.createTaskWithActiveReservationAndMessage(successor, { id: "message_link", taskId: source.id, content: successor.prompt, targetTaskId: successor.id, deliveryStatus:"successor_created",createdAt: timestamp });
    assert.equal(linked?.id, successor.id);
    assert.equal((await store.findTask(successor.id))?.sourceTaskId, source.id);
    assert.deepEqual((await store.listTaskMessages(source.id)).map((message) => message.targetTaskId), [successor.id]);

    const rejected = { ...successor, id: "task_follow_rollback", runId: "run_follow_rollback" };
    await assert.rejects(() => store.createTaskWithActiveReservationAndMessage(rejected, { id: "message_link", taskId: source.id, content: rejected.prompt, targetTaskId: rejected.id, deliveryStatus:"successor_created",createdAt: timestamp }));
    assert.equal(await store.findTask(rejected.id), null);
  });

  it("imports a legacy endpoint alias into a credential binding and clears the alias", async () => {
    const timestamp = "2026-07-11T00:00:00.000Z";
    await store.createUser({ id: "user_legacy_credential", email: "legacy-credential@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_legacy_credential", name: "Legacy credential", ownerUserId: "user_legacy_credential", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_legacy_credential", workspaceId: "ws_legacy_credential", name: "Legacy credential", ownerUserId: "user_legacy_credential", rootPath: "workspaces/ws_legacy_credential/projects/proj_legacy_credential", taskConcurrencyLimit: 1, createdAt: timestamp, updatedAt: timestamp });

    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      await client.query(
        `insert into model_endpoints (
           id, project_id, name, protocol, base_url, model, api_key_secret_ref,
           capabilities, request_timeout_secs, created_at, updated_at
         ) values ($1, $2, 'Legacy endpoint', 'openai_chat_completions', $3, 'legacy-model', $4, '[]'::jsonb, 30, $5, $5)`,
        ["endpoint_legacy_credential", "proj_legacy_credential", "https://models.example.test/v1", "secret/legacy-model", timestamp]
      );
    } finally {
      await client.end();
    }

    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    await services.credentials.importLegacyAliasesFromEnvironment({
      AGENTSMITH_LITE_MODEL_API_KEY_LEGACY_MODEL: "legacy-provider-secret",
      AGENTSMITH_LITE_MODEL_BASE_URL_LEGACY_MODEL: "https://models.example.test/v1"
    });
    await services.credentials.importLegacyAliasesFromEnvironment({
      AGENTSMITH_LITE_MODEL_API_KEY_LEGACY_MODEL: "legacy-provider-secret",
      AGENTSMITH_LITE_MODEL_BASE_URL_LEGACY_MODEL: "https://models.example.test/v1"
    });

    const endpoint = await store.findEndpoint("endpoint_legacy_credential");
    assert.ok(endpoint?.credentialId);
    assert.equal((await store.listProjectCredentials("proj_legacy_credential")).length, 1);

    const verificationClient = new pg.Client({ connectionString: postgresUrl });
    await verificationClient.connect();
    try {
      const persisted = await verificationClient.query<{ credential_id: string | null; api_key_secret_ref: string | null }>(
        "select credential_id, api_key_secret_ref from model_endpoints where id = $1",
        ["endpoint_legacy_credential"]
      );
      assert.deepEqual(persisted.rows, [{ credential_id: endpoint.credentialId, api_key_secret_ref: null }]);
    } finally {
      await verificationClient.end();
    }
  });

  it("persists profile preferences and lifecycle updates without replacing created timestamps", async () => {
    const timestamp = "2026-07-04T00:00:00.000Z";
    await store.createUser({ id: "user_profile", email: "profile@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_profile", name: "Old", ownerUserId: "user_profile", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_profile", workspaceId: "ws_profile", name: "Old", ownerUserId: "user_profile", rootPath: "workspaces/ws_profile/projects/proj_profile", taskConcurrencyLimit: 1, createdAt: timestamp, updatedAt: timestamp });
    const updatedAt = "2026-07-04T00:01:00.000Z";
    assert.equal((await store.updateWorkspace({ id: "ws_profile", name: "New", ownerUserId: "user_profile", createdAt: "ignored", updatedAt }))?.createdAt, timestamp);
    assert.equal((await store.updateProject({ id: "proj_profile", workspaceId: "ws_profile", name: "New", ownerUserId: "user_profile", rootPath: "workspaces/ws_profile/projects/proj_profile", taskConcurrencyLimit: 2, createdAt: "ignored", updatedAt }))?.createdAt, timestamp);
    await store.upsertUserProfilePreferences({ userId: "user_profile", displayName: "Profile", timezone: "UTC", bio: null, jobTitle: null, company: null, greetingPreference: null, interests: [], updatedAt });
    assert.deepEqual(await store.findUserProfilePreferences("user_profile"), { userId: "user_profile", displayName: "Profile", timezone: "UTC", bio: null, jobTitle: null, company: null, greetingPreference: null, interests: [], updatedAt });
  });

  it("persists at most one concurrent task when its active reservation is limited", async () => {
    const timestamp = "2026-07-04T00:00:00.000Z";
    await store.createUser({ id: "user_task_reservation", email: "task-reservation@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_task_reservation", name: "Tasks", ownerUserId: "user_task_reservation", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_task_reservation", workspaceId: "ws_task_reservation", name: "Tasks", ownerUserId: "user_task_reservation", rootPath: "workspaces/ws_task_reservation/projects/proj_task_reservation", taskConcurrencyLimit: 1, createdAt: timestamp, updatedAt: timestamp });
    await createTestCredential(store, "proj_task_reservation", "cred_test", timestamp);
    await store.createEndpoint({ id: "endpoint_reservation", projectId: "proj_task_reservation", name: "Endpoint", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "m", credentialId: "cred_test", capabilities: ["text"], requestTimeoutSecs: 30, createdAt: timestamp, updatedAt: timestamp });

    const created = await Promise.all(Array.from({ length: 8 }, (_, index) => store.createTaskWithActiveReservation({
      id: `task_reservation_${index}`,
      workspaceId: "ws_task_reservation",
      projectId: "proj_task_reservation",
      endpointId: "endpoint_reservation",
      prompt: "task",
      status: "starting",
      runId: `run_reservation_${index}`,
      executionMode: "dry-run",
      sandbox: { namespace: "agentsmith", resources: [] },
      createdAt: timestamp,
      updatedAt: timestamp
    })));

    assert.equal(created.filter(Boolean).length, 1);
    assert.equal((await store.listTasksForProject("proj_task_reservation")).length, 1);
    assert.equal((await store.findProjectResourceUsage("proj_task_reservation"))?.activeTasks, 1);
  });

  it("creates policy state with the project and atomically reserves provider settlements", async () => {
    const timestamp = "2026-07-04T00:00:00.000Z";
    await store.createUser({ id: "user_provider", email: "provider@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_provider", name: "Provider", ownerUserId: "user_provider", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_provider", workspaceId: "ws_provider", name: "Provider", ownerUserId: "user_provider", rootPath: "workspaces/ws_provider/projects/proj_provider", taskConcurrencyLimit: 2, createdAt: timestamp, updatedAt: timestamp });
    await createTestCredential(store, "proj_provider", "cred_provider", timestamp);
    await store.createEndpoint({ id: "endpoint_provider", projectId: "proj_provider", name: "Provider endpoint", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "m", credentialId: "cred_provider", capabilities: ["text"], requestTimeoutSecs: 30, createdAt: timestamp, updatedAt: timestamp });
    await store.patchProjectResourcePolicy("proj_provider", { providerRequestsLimit: 1 }, "2026-07-04T00:01:00.000Z");

    const reservations = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      store.reserveProjectProviderSettlement({ id: `settlement_${index}`, projectId: "proj_provider", taskId: null, endpointId: "endpoint_provider", actorId: "user_provider", reservedTokens: 4096, reservedCost: 1, reservedAt: "2026-07-04T00:01:01.000Z", expiresAt: "2026-07-04T00:06:01.000Z" })
    ));

    assert.equal((await store.findProjectMembership("proj_provider", "user_provider"))?.role, "owner");
    assert.equal((await store.findProjectResourcePolicy("proj_provider"))?.activeTasksLimit, 2);
    assert.equal((await store.findProjectResourceUsage("proj_provider"))?.providerRequests, 1);
    assert.equal(reservations.filter(Boolean).length, 1);
  });

  it("validates new endpoints with project-scoped settlements and rechecks persisted endpoints with endpoint scope", async () => {
    let available = true;
    let validationCalls = 0;
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password",
      providerClient: {
        async completeChat() { throw new Error("not used"); },
        async validateEndpoint() {
          validationCalls += 1;
          return available ? { status: "healthy" as const } : { status: "unavailable" as const, errorCategory: "auth" as const };
        }
      }
    });
    const { user } = await services.auth.loginAfterBootstrap("admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Endpoint validation" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Endpoint validation" });
    const credential = await services.credentials.create(user.id, project.id, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "provider-secret" });
    const input = { name: "Provider", protocol: "openai_chat_completions" as const, baseUrl: credential.baseUrl, model: "model", credentialId: credential.id, capabilities: ["text" as const], requestTimeoutSecs: 30 };

    const endpoint = await services.endpoints.createEndpoint(user.id, project.id, input);
    available = false;
    await assert.rejects(
      () => services.endpoints.createEndpoint(user.id, project.id, { ...input, name: "Invalid provider" }),
      /Endpoint validation failed: auth/
    );
    assert.deepEqual((await store.listEndpointsForProject(project.id)).map((item) => item.id), [endpoint.id]);

    await services.policies.updatePolicy(user.id, project.id, { endpointWindows: [{ endpointId: endpoint.id, metric: "providerRequests", limit: 1, windowSeconds: 60 }] });
    available = true;
    await services.endpoints.recheckEndpoint(user.id, project.id, endpoint.id);
    await assert.rejects(() => services.endpoints.recheckEndpoint(user.id, project.id, endpoint.id), /Project provider requests limit reached/);

    const settlements = await store.listSettledProjectProviderSettlements(project.id, "1970-01-01T00:00:00.000Z");
    assert.equal(settlements.filter((settlement) => settlement.endpointId === null).length, 2);
    assert.equal(settlements.filter((settlement) => settlement.endpointId === endpoint.id).length, 1);
    assert.equal((await store.findProjectResourceUsage(project.id))?.providerRequests, 3);
    assert.equal(validationCalls, 3);
  });

  it("settles provider token/cost overage and opens the corresponding project alerts", async () => {
    const timestamp = "2026-07-04T00:00:00.000Z";
    await store.createUser({ id: "user_settlement", email: "settlement@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_settlement", name: "Settlement", ownerUserId: "user_settlement", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_settlement", workspaceId: "ws_settlement", name: "Settlement", ownerUserId: "user_settlement", rootPath: "workspaces/ws_settlement/projects/proj_settlement", taskConcurrencyLimit: 2, createdAt: timestamp, updatedAt: timestamp });
    await createTestCredential(store, "proj_settlement", "cred_test", timestamp);
    await store.createEndpoint({ id: "endpoint_settlement", projectId: "proj_settlement", name: "Settlement endpoint", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "m", credentialId: "cred_test", capabilities: ["text"], requestTimeoutSecs: 30, createdAt: timestamp, updatedAt: timestamp });
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });
    await store.patchProjectResourcePolicy("proj_settlement", { providerTokensLimit: 5, providerCostLimit: 1 }, "2026-07-04T00:01:00.000Z");

    const settlement = await services.policies.reserveProvider("proj_settlement", "user_settlement", "endpoint_settlement", null, { tokens: 5, cost: 1 });
    await services.policies.markProviderDispatched(settlement);
    await services.policies.markProviderDelivered(settlement);
    await services.policies.settleProvider(settlement, { tokens: 7, cost: 2 });
    await services.policies.settleProvider(settlement, { tokens: 70, cost: 20 });

    assert.deepEqual((await store.findProjectResourceUsage("proj_settlement")) && {
      tokens: (await store.findProjectResourceUsage("proj_settlement"))?.providerTokens,
      cost: (await store.findProjectResourceUsage("proj_settlement"))?.providerCost
    }, { tokens: 7, cost: 2 });
    assert.deepEqual((await store.listActiveProjectAlerts("proj_settlement")).map((alert) => alert.type).sort(), ["provider_cost_limit", "provider_tokens_limit"]);
  });

  it("expires active settlements atomically and finalizes one pending task intent once", async () => {
    const timestamp = "2026-07-04T00:00:00.000Z";
    await store.createUser({ id: "user_ledger", email: "ledger@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_ledger", name: "Ledger", ownerUserId: "user_ledger", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_ledger", workspaceId: "ws_ledger", name: "Ledger", ownerUserId: "user_ledger", rootPath: "workspaces/ws_ledger/projects/proj_ledger", taskConcurrencyLimit: 2, createdAt: timestamp, updatedAt: timestamp });
    await createTestCredential(store, "proj_ledger", "cred_test", timestamp);
    await store.createEndpoint({ id: "endpoint_ledger", projectId: "proj_ledger", name: "Ledger endpoint", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "m", credentialId: "cred_test", capabilities: ["text"], requestTimeoutSecs: 30, createdAt: timestamp, updatedAt: timestamp });
    await store.reserveProjectProviderSettlement({ id: "settlement_ledger", projectId: "proj_ledger", taskId: null, endpointId: "endpoint_ledger", actorId: "user_ledger", reservedTokens: 4096, reservedCost: 1, reservedAt: timestamp, expiresAt: "2026-07-04T00:00:01.000Z" });
    await store.reserveProjectProviderSettlement({ id: "settlement_dispatched", projectId: "proj_ledger", taskId: null, endpointId: "endpoint_ledger", actorId: "user_ledger", reservedTokens: 2048, reservedCost: 0.5, reservedAt: timestamp, expiresAt: "2026-07-04T00:00:01.000Z" });
    await store.markProjectProviderSettlementDispatched("settlement_dispatched", timestamp);
    await store.reserveProjectProviderSettlement({ id: "settlement_delivered", projectId: "proj_ledger", taskId: null, endpointId: "endpoint_ledger", actorId: "user_ledger", reservedTokens: 1024, reservedCost: 0.25, reservedAt: timestamp, expiresAt: "2026-07-04T00:00:01.000Z" });
    await store.markProjectProviderSettlementDispatched("settlement_delivered", timestamp);
    await store.markProjectProviderSettlementDelivered("settlement_delivered", timestamp);
    await store.reserveProjectProviderSettlement({ id: "settlement_settled", projectId: "proj_ledger", taskId: null, endpointId: "endpoint_ledger", actorId: "user_ledger", reservedTokens: 512, reservedCost: 0.125, reservedAt: timestamp, expiresAt: "2026-07-04T00:00:01.000Z" });
    await store.markProjectProviderSettlementDispatched("settlement_settled", timestamp);
    await store.settleProjectProviderSettlement("settlement_settled", { tokens: 7, cost: 0.01 }, timestamp);
    assert.equal(await store.expireProjectProviderSettlements("2026-07-04T00:00:02.000Z"), 3);
    const usage = await store.findProjectResourceUsage("proj_ledger");
    assert.equal(usage?.providerRequests, 3);
    assert.equal(usage?.providerTokens, 7);
    assert.ok(Math.abs((usage?.providerCost ?? 0) - 0.01) < 1e-9);
    assert.equal(await store.settleProjectProviderSettlement("settlement_dispatched", { tokens: 1 }, timestamp), null);
    assert.equal(await store.settleProjectProviderSettlement("settlement_delivered", { tokens: 1 }, timestamp), null);
    const task: AgentTask = { id: "task_ledger", workspaceId: "ws_ledger", projectId: "proj_ledger", endpointId: "endpoint_ledger", prompt: "task", status: "running", runId: "run_ledger", executionMode: "dry-run", sandbox: { namespace: "agentsmith", resources: [] }, createdAt: timestamp, updatedAt: timestamp };
    await store.createTaskWithActiveReservation(task);
    await Promise.all([store.requestTaskFinalization(task.id, "failed", timestamp), store.requestTaskFinalization(task.id, "completed", timestamp)]);
    await Promise.all([store.finalizeTaskAndReleaseActiveReservation(task.id, "failed", timestamp), store.finalizeTaskAndReleaseActiveReservation(task.id, "completed", timestamp)]);
    assert.equal((await store.findProjectResourceUsage("proj_ledger"))?.activeTasks, 0);
  });

  it("patches nullable project policy limits with column-typed parameters", async () => {
    const timestamp = "2026-07-04T00:00:00.000Z";
    await store.createUser({ id: "user_patch", email: "patch@example.test", emailVerified: false, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "ws_patch", name: "Patch", ownerUserId: "user_patch", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "proj_patch", workspaceId: "ws_patch", name: "Patch", ownerUserId: "user_patch", rootPath: "workspaces/ws_patch/projects/proj_patch", taskConcurrencyLimit: 1, createdAt: timestamp, updatedAt: timestamp });

    const updated = await store.patchProjectResourcePolicy("proj_patch", { providerRequestsLimit: null, providerCostLimit: 3.5 }, "2026-07-04T00:01:00.000Z");

    assert.equal(updated?.providerRequestsLimit, null);
    assert.equal(updated?.providerCostLimit, 3.5);
    assert.equal(updated?.activeTasksLimit, 1);
  });

  it("persists product records with idempotent task event and artifact appends", async () => {
    const user: StoredUser = {
      id: "user_pg",
      email: "User@Example.test",
      emailVerified: false,
      passwordHash: "hash",
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T00:00:00.000Z"
    };
    const workspace: Workspace = {
      id: "ws_pg",
      name: "Ops",
      ownerUserId: user.id,
      lifecycleStatus: "active",
      createdAt: "2026-07-04T00:01:00.000Z",
      updatedAt: "2026-07-04T00:01:00.000Z"
    };
    const project: Project = {
      id: "proj_pg",
      workspaceId: workspace.id,
      name: "Sandbox",
      ownerUserId: user.id,
      rootPath: "workspaces/ws_pg/projects/proj_pg",
      taskConcurrencyLimit: 2,
      lifecycleStatus: "active",
      createdAt: "2026-07-04T00:02:00.000Z",
      updatedAt: "2026-07-04T00:02:00.000Z"
    };
    const membership: ProjectMembership = {
      projectId: project.id,
      userId: user.id,
      role: "member",
      createdAt: "2026-07-04T00:02:30.000Z",
      updatedAt: "2026-07-04T00:02:30.000Z"
    };
    const endpoint: ModelEndpoint = {
      id: "endp_pg",
      projectId: project.id,
      name: "OpenAI compatible",
      protocol: "openai_chat_completions",
      baseUrl: "https://models.example.test/v1",
      model: "gpt-compatible",
      credentialId: "cred_test",
      capabilities: ["text", "tool_calls"],
      requestTimeoutSecs: 30,
      health: { status: "unknown", checkedAt: null, errorCategory: null },
      createdAt: "2026-07-04T00:03:00.000Z",
      updatedAt: "2026-07-04T00:03:00.000Z"
    };
    const task: AgentTask = {
      id: "task_pg",
      workspaceId: workspace.id,
      projectId: project.id,
      endpointId: endpoint.id,
      prompt: "build",
      status: "starting",
      runId: "run_pg",
      executionMode: "live",
      sandbox: { namespace: "agentsmith", resources: [] },
      createdAt: "2026-07-04T00:04:00.000Z",
      updatedAt: "2026-07-04T00:04:00.000Z"
    };
    const interaction: TaskAssistantMessageInteraction = {
      id: "assistant_pg",
      revision: 1,
      taskId: task.id,
      kind: "assistant_message",
      title: "Assistant",
      body: "hello",
      contentMode: "full",
      position: 1,
      status: "generating",
      occurredAt: "2026-07-04T00:05:00.000Z",
      updatedAt: "2026-07-04T00:05:00.000Z"
    };
    const completedInteraction: TaskAssistantMessageInteraction = {
      ...interaction,
      revision: 2,
      status: "completed",
      updatedAt: "2026-07-04T00:05:01.000Z"
    };
    const artifact: PersistedTaskArtifact = {
      id: "art_pg",
      taskId: task.id,
      fileId: "file_pg",
      name: "readme.md",
      bytes: 12,
      mediaType: null,
      previewText: null,
      createdAt: "2026-07-04T00:06:00.000Z"
    };

    assert.equal(await store.countUsers(), 0);
    assert.deepEqual(await store.createUser(user), {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    });
    assert.equal(await store.countUsers(), 1);
    assert.equal((await store.findUserByEmail("user@example.test"))?.id, user.id);
    assert.deepEqual(await store.createSession({
      id: "sess_pg",
      userId: user.id,
      csrfToken: "csrf_pg",
      createdAt: "2026-07-04T00:00:00.000Z",
      expiresAt: "2026-07-04T12:00:00.000Z"
    }), {
      id: "sess_pg",
      userId: user.id,
      csrfToken: "csrf_pg",
      createdAt: "2026-07-04T00:00:00.000Z",
      expiresAt: "2026-07-04T12:00:00.000Z"
    });
    assert.equal((await store.findSession("sess_pg"))?.csrfToken, "csrf_pg");
    assert.equal(await store.deleteSession("sess_pg"), true);
    assert.equal(await store.findSession("sess_pg"), null);
    assert.equal(await store.deleteSession("sess_pg"), false);

    await store.createWorkspace(workspace);
    await store.createProject(project);
    await store.upsertProjectMembership(membership);
    await createTestCredential(store, project.id, endpoint.credentialId, endpoint.createdAt);
    await store.createEndpoint(endpoint);
    await store.createTask(task);
    assert.equal(
      (await store.updateTaskStatusIfStarting(task.id, "running", "2026-07-04T00:07:00.000Z"))?.status,
      "running"
    );
    assert.equal(await store.updateTaskStatusIfStarting(task.id, "running", "2026-07-04T00:07:01.000Z"), null);
    await store.persistTaskInteractionMutation({ taskId:task.id,changes:[{sourceKind:"botified",sourceId:"timeline:1",sourceRevision:0,interaction},{sourceKind:"botified",sourceId:"timeline:1",sourceRevision:0,interaction},{sourceKind:"botified",sourceId:"timeline:2",sourceRevision:0,interaction:completedInteraction}],sourceSync:{expectedSourceCursor:null,sourceCursor:"timeline:2",historyStatus:"complete",lastSyncedAt:completedInteraction.updatedAt} });
    await store.appendTaskArtifacts([artifact, artifact]);
    await assert.rejects(store.persistTaskInteractionMutation({ taskId:task.id,changes:[{sourceKind:"product",sourceId:"conflicting-revision",sourceRevision:1,interaction:completedInteraction}],artifactProjections:[{projectId:project.id,artifact:{...artifact,id:"artifact_rollback",fileId:"file_rollback"},auditEvent:{id:"audit_rollback",projectId:project.id,actorId:null,action:"artifact.project",status:"accepted",resourceKind:"artifact",resourceId:"artifact_rollback",createdAt:"2026-07-04T00:08:00.000Z"},updatedAt:"2026-07-04T00:08:00.000Z"}],lifecycle:{kind:"active",expectedStatus:"running",status:"stopping",updatedAt:"2026-07-04T00:08:00.000Z"},sourceSync:{expectedSourceCursor:"timeline:2",sourceCursor:"timeline:rollback",historyStatus:"gap",lastSyncedAt:"2026-07-04T00:08:00.000Z"} }), /revision is not monotonic/);

    assert.deepEqual(await store.listWorkspacesForUser(user.id), [{ ...workspace, owner: { displayName: null, email: user.email }, memberRole: "owner" }]);
    assert.deepEqual(await store.listProjectsForWorkspace(workspace.id), [project]);
    assert.deepEqual(await store.listProjectsForUser(user.id), [project]);
    const storedMembership = { ...membership, createdAt: project.createdAt };
    assert.deepEqual(await store.findProjectMembership(project.id, user.id), storedMembership);
    assert.deepEqual(await store.listProjectMemberships(project.id), [{ ...storedMembership, displayName: null, email: user.email }]);
    assert.deepEqual(await store.listEndpointsForProject(project.id), [endpoint]);
    const storedTask = await store.findTask(task.id);
    assert.equal(storedTask?.status, "running");
    assert.equal(storedTask?.executionMode, "live");
    assert.deepEqual((await store.listTaskInteractionChanges(task.id,0,10)).map((change)=>[change.changeSeq,change.interaction.revision]), [[1,1],[2,2]]);
    assert.deepEqual((await store.readTaskInteractionSnapshot(task.id,null,10))?.items, [completedInteraction]);
    assert.equal((await store.readTaskInteractionSnapshot(task.id,null,10))?.sourceCursor, "timeline:2");
    assert.deepEqual(await store.listTaskArtifacts(task.id), [artifact]);
  });

  it("round-trips and deduplicates bigint product interaction source revisions", async () => {
    const timestamp = "2026-07-04T00:00:00.000Z";
    await store.createUser({ id:"user_interaction_bigint",email:"interaction-bigint@example.test",emailVerified:false,passwordHash:"hash",createdAt:timestamp,updatedAt:timestamp });
    await store.createWorkspace({ id:"ws_interaction_bigint",name:"Interaction bigint",ownerUserId:"user_interaction_bigint",createdAt:timestamp,updatedAt:timestamp });
    await store.createProject({ id:"proj_interaction_bigint",workspaceId:"ws_interaction_bigint",name:"Interaction bigint",ownerUserId:"user_interaction_bigint",rootPath:"workspaces/ws_interaction_bigint/projects/proj_interaction_bigint",taskConcurrencyLimit:1,createdAt:timestamp,updatedAt:timestamp });
    await createTestCredential(store,"proj_interaction_bigint","cred_interaction_bigint",timestamp);
    await store.createEndpoint(endpointRecord("endpoint_interaction_bigint","proj_interaction_bigint","cred_interaction_bigint",timestamp));
    await store.createTask({ id:"task_interaction_bigint",workspaceId:"ws_interaction_bigint",projectId:"proj_interaction_bigint",endpointId:"endpoint_interaction_bigint",prompt:"hello",status:"running",runId:"run_interaction_bigint",executionMode:"live",sandbox:{namespace:"agentsmith",resources:[]},createdAt:timestamp,updatedAt:timestamp });

    const sourceRevision = 17_840_091_560_973;
    const interaction:TaskAssistantMessageInteraction={ id:"assistant_interaction_bigint",revision:1,taskId:"task_interaction_bigint",kind:"assistant_message",title:"Assistant",body:"hello",contentMode:"full",position:1,status:"completed",occurredAt:timestamp,updatedAt:timestamp };
    const change={ sourceKind:"product" as const,sourceId:"task:task_interaction_bigint:prompt",sourceRevision,interaction };
    const inserted=await store.persistTaskInteractionMutation({ taskId:interaction.taskId,changes:[change] });
    const duplicate=await store.persistTaskInteractionMutation({ taskId:interaction.taskId,changes:[change] });

    assert.equal(sourceRevision>2**31,true);
    assert.deepEqual(inserted.changes.map((item)=>item.sourceRevision),[sourceRevision]);
    assert.deepEqual(duplicate.changes,[]);
    const readback=await store.listTaskInteractionChanges(interaction.taskId,0,10);
    assert.equal(typeof readback[0]?.sourceRevision,"number");
    assert.equal(readback[0]?.sourceRevision,sourceRevision);

    const client=new pg.Client({connectionString:postgresUrl});
    await client.connect();
    try {
      await client.query("update task_interaction_changes set source_revision=$2 where task_id=$1",[interaction.taskId,"9007199254740992"]);
    } finally {
      await client.end();
    }
    await assert.rejects(store.listTaskInteractionChanges(interaction.taskId,0,10),/source revision is invalid/);
  });

  it("atomically binds a legacy OIDC user during concurrent first login", async () => {
    const principal = {
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "legacy-concurrent-user",
      email: "Legacy.Concurrent@Example.Test",
      emailVerified: true
    };
    const userId = oidcUserId(principal.issuer, principal.subject);
    await store.createUser({
      id: userId,
      email: "legacy.concurrent@example.test",
      emailVerified: false,
      passwordHash: "external:oidc",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    });
    const services = createApplicationServices({
      store,
      dataRoot: "/agentsmith-lite",
      builtinAdminPassword: "admin-password"
    });

    const [first, second] = await Promise.all([
      services.auth.loginExternalPrincipal(principal),
      services.auth.loginExternalPrincipal(principal)
    ]);
    const stored = await store.findUserById(userId);

    assert.equal(first.user.id, userId);
    assert.equal(second.user.id, userId);
    assert.equal(await store.countUsers(), 1);
    assert.equal(stored?.oidcIssuer, principal.issuer);
    assert.equal(stored?.oidcSubject, principal.subject);
  });

  it("rejects a legacy OIDC bind when the persisted email differs", async () => {
    const principal = {
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "legacy-email-mismatch",
      email: "login@example.test",
      emailVerified: true
    };
    const userId = oidcUserId(principal.issuer, principal.subject);
    await store.createUser({
      id: userId,
      email: "different@example.test",
      emailVerified: false,
      passwordHash: "external:oidc",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    });
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });

    await assert.rejects(() => services.auth.loginExternalPrincipal(principal), /OIDC identity does not match the existing user/);
    const stored = await store.findUserById(userId);
    assert.equal(stored?.oidcIssuer, undefined);
    assert.equal(stored?.oidcSubject, undefined);
    assert.equal(stored?.email, "different@example.test");
  });

  it("does not overwrite a legacy deterministic ID already bound to another OIDC identity", async () => {
    const principal = {
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "new-subject",
      email: "user@example.test",
      emailVerified: true
    };
    const userId = oidcUserId(principal.issuer, principal.subject);
    await store.createUser({
      id: userId,
      email: principal.email,
      oidcIssuer: principal.issuer,
      oidcSubject: "old-subject",
      emailVerified: true,
      passwordHash: "external:oidc",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    });
    const services = createApplicationServices({ store, dataRoot: "/agentsmith-lite", builtinAdminPassword: "admin-password" });

    await assert.rejects(() => services.auth.loginExternalPrincipal(principal), /OIDC identity does not match the existing user/);
    const stored = await store.findUserById(userId);
    assert.equal(stored?.oidcIssuer, principal.issuer);
    assert.equal(stored?.oidcSubject, "old-subject");
  });

  it("implements JSON documents and fenced lease semantics", async () => {
    await store.jsonDocs.put("project_settings", "proj_pg", { concurrency: 2, flags: ["fast"] });
    assert.deepEqual(await store.jsonDocs.get("project_settings", "proj_pg"), { concurrency: 2, flags: ["fast"] });
    await store.jsonDocs.delete("project_settings", "proj_pg");
    assert.equal(await store.jsonDocs.get("project_settings", "proj_pg"), null);

    const first = await store.leases.acquire({
      name: "sandbox:task_pg",
      holder: "api-1",
      ttlMs: 1000,
      now: new Date("2026-07-04T00:00:00.000Z"),
      metadata: { phase: "starting" }
    });
    assert.equal(first.acquired, true);
    assert.equal(first.lease?.fencingToken, 1);

    const blocked = await store.leases.acquire({
      name: "sandbox:task_pg",
      holder: "api-2",
      ttlMs: 1000,
      now: new Date("2026-07-04T00:00:00.500Z")
    });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.lease?.holder, "api-1");

    assert.equal(await store.leases.compareAndSet("sandbox:task_pg", 0, { phase: "running" }), false);
    assert.equal(await store.leases.compareAndSet("sandbox:task_pg", 1, { phase: "running" }), true);
    assert.equal(await store.leases.renew("sandbox:task_pg", 1, 2000, new Date("2026-07-04T00:00:01.000Z")), true);
    assert.deepEqual(await store.leases.listExpired(new Date("2026-07-04T00:00:02.000Z")), []);

    const second = await store.leases.acquire({
      name: "sandbox:task_pg",
      holder: "api-2",
      ttlMs: 1000,
      now: new Date("2026-07-04T00:00:04.000Z")
    });
    assert.equal(second.acquired, true);
    assert.equal(second.lease?.fencingToken, 2);
    assert.equal(await store.leases.release("sandbox:task_pg", 1), false);
    assert.equal(await store.leases.release("sandbox:task_pg", 2), true);

    const run = sandboxRun();
    await store.sandboxRuns.put(run);
    assert.deepEqual(await store.sandboxRuns.get(run.runId), run);
    assert.deepEqual((await store.sandboxRuns.listActive()).map((item) => item.runId), [run.runId]);
    assert.equal(
      await store.sandboxRuns.updateWithFencing(run.runId, 0, { ...run, phase: "running", fencingToken: 2 }),
      null
    );
    const updated = await store.sandboxRuns.updateWithFencing(run.runId, 1, {
      ...run,
      phase: "running",
      fencingToken: 2
    });
    assert.equal(updated?.phase, "running");
  });
});

function adjustFileBytes(store: PostgresProductStore, projectId: string, delta: number, updatedAt: string) {
  return store.adjustProjectResourceUsage({ projectId, delta: { activeTasks: 0, providerRequests: 0, providerTokens: 0, providerCost: 0, projectFileBytes: delta }, limit: "project_file_bytes_limit", updatedAt });
}

function adjustActiveTasks(store: PostgresProductStore, projectId: string, delta: number, updatedAt: string) {
  return store.adjustProjectResourceUsage({ projectId, delta: { activeTasks: delta, providerRequests: 0, providerTokens: 0, providerCost: 0, projectFileBytes: 0 }, limit: "active_tasks_limit", updatedAt });
}

function createTestCredential(store: PostgresProductStore, projectId: string, id: string, timestamp: string) {
  return store.createProjectCredential({
    id,
    projectId,
    name: "Provider",
    type: "api_key",
    baseUrl: "https://models.example.test/v1",
    keyId: "test",
    nonce: Buffer.alloc(12),
    ciphertext: Buffer.from("ciphertext"),
    authTag: Buffer.alloc(16),
    fingerprint: `fingerprint-${id}`,
    version: 1,
    createdAt: timestamp,
    lastRotatedAt: null,
    updatedAt: timestamp
  });
}

function endpointRecord(id: string, projectId: string, credentialId: string, timestamp: string): ModelEndpoint {
  return {
    id,
    projectId,
    name: id,
    protocol: "openai_chat_completions",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    credentialId,
    capabilities: ["text", "tool_calls"],
    requestTimeoutSecs: 30,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function settleProvider(store: PostgresProductStore, id: string, projectId: string, endpointId: string, timestamp: string): Promise<void> {
  assert.ok(await store.reserveProjectProviderSettlement({ id, projectId, taskId: null, endpointId, reservedTokens: 0, reservedCost: 0, reservedAt: timestamp, expiresAt: "2026-07-12T00:01:00.000Z" }));
  assert.ok(await store.markProjectProviderSettlementDispatched(id, timestamp));
  assert.ok(await store.markProjectProviderSettlementDelivered(id, timestamp));
  assert.ok(await store.settleProjectProviderSettlement(id, { tokens: 1, cost: 0.01 }, timestamp));
}

function oidcUserId(issuer: string, subject: string): string {
  const digest = createHash("sha256").update(`${issuer}\0${subject}`).digest("hex").slice(0, 32);
  return `user_oidc_${digest}`;
}

function sandboxRun(overrides: Partial<SandboxRunState> = {}): SandboxRunState {
  return {
    workspaceId: "ws_pg",
    projectId: "proj_pg",
    taskId: "task_pg",
    runId: "run_pg",
    namespace: "agentsmith",
    phase: "starting",
    image: "agentsmith-lite/botified-runner:test",
    pvcName: "agentsmith-lite-files",
    projectSubPath: "workspaces/ws_pg/projects/proj_pg",
    botifiedPort: 3099,
    resourceNames: {
      pod: "asl-task-task_pg",
      service: "asl-task-task_pg",
      configMap: "asl-task-task_pg-config",
      secret: "asl-botified-task_pg",
      serviceAccount: "asl-task-task_pg",
      networkPolicy: "asl-task-task_pg"
    },
    serviceKeySecretRef: {
      name: "asl-botified-task_pg",
      key: "BOTIFIED_SERVICE_KEY"
    },
    directories: {
      taskHome: "/workspace/project/tasks/task_pg/home",
      artifacts: "/workspace/project/tasks/task_pg/artifacts",
      botified: "/workspace/project/tasks/task_pg/botified"
    },
    resourceLimits: {
      cpuRequest: "250m",
      memoryRequest: "512Mi",
      cpuLimit: "1",
      memoryLimit: "1Gi"
    },
    expiresAt: "2026-07-04T01:00:00.000Z",
    idleExpiresAt: "2026-07-04T00:30:00.000Z",
    fencingToken: 1,
    cleanupStatus: "active",
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    ...overrides
  };
}
