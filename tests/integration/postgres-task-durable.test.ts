import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { PostgresProductStore } from "../../packages/adapters-postgres/src/postgresProductStore.js";
import type { AgentTask, ProjectAuditEvent, TaskFollowUp } from "../../packages/contracts/src/api.js";
import type { AtomicTaskCreateInput, PersistedSandboxRunState } from "../../packages/ports/src/store.js";

const postgresUrl = process.env.POSTGRES_APP_URL;
const postgresDescribe = postgresUrl ? describe : describe.skip;

postgresDescribe("postgres durable task store", () => {
  assert.ok(postgresUrl);
  const store = new PostgresProductStore(postgresUrl);
  const timestamp = "2026-07-12T00:00:00.000Z";

  beforeEach(async () => {
    const client = new pg.Client({ connectionString: postgresUrl }); await client.connect();
    try { await client.query("truncate table task_idempotency_records,task_follow_ups,agent_task_artifacts,agent_task_events,agent_tasks,project_audit_events,project_alerts,model_endpoints,projects,workspaces,auth_sessions,users,postgres_json_docs,runtime_leases cascade"); }
    finally { await client.end(); }
    await store.createUser({ id: "user_task", email: "task@example.test", emailVerified: true, passwordHash: "hash", createdAt: timestamp, updatedAt: timestamp });
    await store.createWorkspace({ id: "workspace_task", name: "Workspace", ownerUserId: "user_task", createdAt: timestamp, updatedAt: timestamp });
    await store.createProject({ id: "project_task", workspaceId: "workspace_task", name: "Project", ownerUserId: "user_task", rootPath: "workspaces/workspace_task/projects/project_task", taskConcurrencyLimit: 4, createdAt: timestamp, updatedAt: timestamp });
    await store.createProjectCredential({ id:"credential_task",projectId:"project_task",name:"Credential",type:"api_key",baseUrl:"https://models.example.test/v1",fingerprint:"fingerprint",version:1,keyId:"test",nonce:Buffer.alloc(12),ciphertext:Buffer.from("ciphertext"),authTag:Buffer.alloc(16),createdAt:timestamp,lastRotatedAt:null,updatedAt:timestamp });
    await store.createEndpoint({ id: "endpoint_task", projectId: "project_task", name: "Endpoint", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "model", credentialId: "credential_task", capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30, createdAt: timestamp, updatedAt: timestamp });
  });

  after(async () => { await store.close(); });

  it("atomically creates reservation, start intent, and both runtime documents", async () => {
    const create = liveCreate("task_atomic", "run_atomic");
    const saved = await store.createTaskAtomically(create);
    assert.equal(saved?.activeReservation, true);
    assert.equal(saved?.startIntentStatus, "pending");
    assert.equal((await store.findProjectResourceUsage("project_task"))?.activeTasks, 1);
    assert.deepEqual(await store.jsonDocs.get("sandbox_runtime_state", "task_atomic"), create.runtimeState);
    assert.equal((await store.sandboxRuns.get("run_atomic"))?.taskId, "task_atomic");
  });

  it("claims once, reclaims only an expired lease, and fences receipt persistence", async () => {
    await store.createTaskAtomically(liveCreate("task_claim", "run_claim"));
    const first = await store.claimTaskStart({ id: "task_claim", claimToken: "claim-1", claimedAt: timestamp, leaseExpiresAt: "2026-07-12T00:00:10.000Z" });
    assert.equal(first?.startAttemptCount, 1);
    assert.equal(await store.claimTaskStart({ id: "task_claim", claimToken: "claim-other", claimedAt: timestamp, leaseExpiresAt: "2026-07-12T00:00:10.000Z" }), null);
    await store.deferTaskStart({ id: "task_claim", claimToken: "claim-1", safeError: "retry later", nextRetryAt: "2026-07-12T00:00:15.000Z", updatedAt: "2026-07-12T00:00:01.000Z" });
    assert.equal(await store.reclaimTaskStart({ id: "task_claim", expectedClaimToken: "claim-1", claimToken: "claim-2", claimedAt: "2026-07-12T00:00:09.000Z", leaseExpiresAt: "2026-07-12T00:00:20.000Z" }), null);
    assert.equal(await store.reclaimTaskStart({ id: "task_claim", expectedClaimToken: "claim-1", claimToken: "claim-2", claimedAt: "2026-07-12T00:00:10.000Z", leaseExpiresAt: "2026-07-12T00:00:20.000Z" }), null);
    const reclaimed = await store.reclaimTaskStart({ id: "task_claim", expectedClaimToken: "claim-1", claimToken: "claim-2", claimedAt: "2026-07-12T00:00:15.000Z", leaseExpiresAt: "2026-07-12T00:00:25.000Z" });
    assert.equal(reclaimed?.startAttemptCount, 2);
    const receipt = { accepted: true, deliveryKey: "delivery-task_claim", requestHash: "hash-task_claim", messageId: "message", cursor: "cursor" };
    assert.equal(await store.recordTaskStartReceipt({ id: "task_claim", claimToken: "claim-1", receipt, timelineCursor: "cursor", updatedAt: timestamp }), null);
    const delivered = await store.recordTaskStartReceipt({ id: "task_claim", claimToken: "claim-2", receipt, timelineCursor: "cursor", updatedAt: timestamp });
    assert.equal(delivered?.startIntentStatus, "dispatched");
    assert.equal(delivered?.status, "running");
  });

  it("persists scoped idempotency replay and rejects a canonical hash mismatch", async () => {
    const base = { actorId: "user_task", projectId: "project_task", operation: "create" as const, key: "same-key", requestHash: "hash-one", resourceId: "task-idem", claimToken: "idem-1", now: timestamp, leaseExpiresAt: "2026-07-12T00:01:00.000Z" };
    assert.equal((await store.beginTaskIdempotency(base)).kind, "claimed");
    assert.equal(await store.completeTaskIdempotency({ actorId: base.actorId, projectId: base.projectId, operation: base.operation, key: base.key, requestHash: base.requestHash, claimToken: base.claimToken, responseStatus: 200, responseBody: { id: "task-idem" }, updatedAt: timestamp }), true);
    const replay = await store.beginTaskIdempotency({ ...base, claimToken: "idem-2" });
    assert.deepEqual(replay, { kind: "replay", resourceId: "task-idem", responseStatus: 200, responseBody: { id: "task-idem" } });
    assert.equal((await store.beginTaskIdempotency({ ...base, requestHash: "hash-two", claimToken: "idem-3" })).kind, "hash_mismatch");
    assert.equal((await store.beginTaskIdempotency({ ...base, actorId: "user_task", operation: "duplicate", claimToken: "idem-4" })).kind, "claimed");
  });

  it("keeps terminal reason first-wins and releases active usage exactly once", async () => {
    await store.createTaskAtomically(liveCreate("task_terminal", "run_terminal"));
    const complete = finalizeInput("task_terminal", "completed", "audit-complete", "task.completed");
    const failed = finalizeInput("task_terminal", "failed", "audit-failed", "task.failed");
    await Promise.all([store.finalizeTaskLifecycle(complete), store.finalizeTaskLifecycle(failed)]);
    const task = await store.findTask("task_terminal");
    assert.ok(task?.terminalReason === "completed" || task?.terminalReason === "failed");
    const winner = task!.terminalReason;
    await store.finalizeTaskLifecycle(winner === "failed" ? complete : failed);
    assert.equal((await store.findTask("task_terminal"))?.terminalReason, winner);
    assert.equal((await store.findProjectResourceUsage("project_task"))?.activeTasks, 0);
    assert.equal((await store.listProjectAuditEvents("project_task")).length, 1);
  });

  it("finalizes a task failure without projecting an alert inside the transaction", async () => {
    await store.createProjectAlertRule({ id:"rule_task_failure",projectId:"project_task",name:"Task failure",alertType:"task_failure",metric:"failure_count",condition:"greater_than_or_equal",threshold:1,windowSeconds:null,scope:{kind:"project"},enabled:true,createdAt:timestamp,updatedAt:timestamp });
    await store.createTaskAtomically(liveCreate("task_alert_failure", "run_alert_failure"));
    const input = finalizeInput("task_alert_failure", "failed", "audit-alert-failure", "task.failed");
    const finalized = await store.finalizeTaskLifecycle(input);
    assert.equal(finalized?.applied, true);
    assert.equal((await store.findTask("task_alert_failure"))?.terminalReason, "failed");
    assert.equal((await store.findProjectResourceUsage("project_task"))?.activeTasks, 0);
    assert.deepEqual(await store.listActiveProjectAlerts("project_task"),[]);
    assert.deepEqual((await store.listProjectAuditEvents("project_task")).map((event)=>event.action),["task.failed"]);
  });

  it("linearizes dispatching follow-up terminal races to one accepted or successor outcome", async () => {
    await store.createTaskAtomically(liveCreate("task_source", "run_source"));
    const followUp = pendingFollowUp("follow-accepted", "task_source");
    await store.createPendingTaskFollowUp(followUp);
    await store.claimTaskFollowUp({ id: followUp.id, claimToken: "follow-claim", claimedAt: timestamp, leaseExpiresAt: timestamp });
    await store.finalizeTaskLifecycle(finalizeInput("task_source", "cancelled", "audit-cancel", "task.cancel"));
    assert.equal((await store.findTaskFollowUp(followUp.id))?.deliveryStatus, "terminal_pending");
    const accepted = await store.recordTaskFollowUpReceipt({ id: followUp.id, claimToken: "follow-claim", receipt: { accepted: true, deliveryKey: followUp.deliveryKey!, requestHash: followUp.requestHash!, messageId: "message" }, timelineCursor: null, updatedAt: timestamp });
    assert.equal(accepted?.deliveryStatus, "accepted");
    assert.equal(accepted?.followUpTaskId, null);

    await store.createTaskAtomically(liveCreate("task_source_2", "run_source_2"));
    const absent = pendingFollowUp("follow-successor", "task_source_2");
    await store.createPendingTaskFollowUp(absent);
    await store.claimTaskFollowUp({ id: absent.id, claimToken: "absent-claim", claimedAt: timestamp, leaseExpiresAt: timestamp });
    await store.finalizeTaskLifecycle(finalizeInput("task_source_2", "completed", "audit-source-2", "task.completed"));
    const successor = liveCreate("task_successor", "run_successor");
    successor.task.sourceTaskId = "task_source_2";
    const resolved = await store.resolveTerminalPendingFollowUp({ followUpId: absent.id, expectedClaimToken: "absent-claim", successor, updatedAt: timestamp });
    assert.equal(resolved?.deliveryStatus, "successor_created");
    assert.equal(resolved?.followUpTaskId, "task_successor");
    assert.equal(await store.recordTaskFollowUpReceipt({ id: absent.id, claimToken: "absent-claim", receipt: { accepted: true, deliveryKey: absent.deliveryKey!, requestHash: absent.requestHash! }, timelineCursor: null, updatedAt: timestamp }), null);
  });

  it("fences artifact drain and cleanup completion", async () => {
    await store.createTaskAtomically(liveCreate("task_stage", "run_stage"));
    await store.finalizeTaskLifecycle(finalizeInput("task_stage", "completed", "audit-stage", "task.completed"));
    const projection = await store.claimTaskArtifactProjection({ id: "task_stage", claimToken: "projection-claim", claimedAt: timestamp, leaseExpiresAt: timestamp });
    assert.equal(projection?.artifactProjectionStatus, "draining");
    assert.equal(await store.completeTaskArtifactProjection({ id: "task_stage", claimToken: "wrong", updatedAt: timestamp }), null);
    assert.equal((await store.completeTaskArtifactProjection({ id: "task_stage", claimToken: "projection-claim", updatedAt: timestamp }))?.artifactProjectionStatus, "drained");
    await store.claimTaskCleanup({ id: "task_stage", claimToken: "cleanup-claim", claimedAt: timestamp, leaseExpiresAt: timestamp });
    assert.equal(await store.completeTaskCleanup({ id: "task_stage", claimToken: "wrong", updatedAt: timestamp }), null);
    assert.equal((await store.completeTaskCleanup({ id: "task_stage", claimToken: "cleanup-claim", updatedAt: timestamp }))?.cleanupStatus, "completed");
    assert.equal(await store.jsonDocs.get("sandbox_runtime_state", "task_stage"), null);
  });

  it("atomically persists artifact metadata, byte usage, and audit once", async () => {
    await store.createTaskAtomically(liveCreate("task_artifact", "run_artifact"));
    const artifact = { id: "artifact_atomic", taskId: "task_artifact", fileId: "file_atomic", name: "result.txt", bytes: 4, sha256: "test-sha", mediaType: "text/plain", previewText: "test", createdAt: timestamp };
    const input = { projectId: "project_task", artifact, auditEvent: { id: "audit-artifact-atomic", projectId: "project_task", actorId: null, action: "artifact.project" as const, status: "accepted" as const, resourceKind: "artifact" as const, resourceId: artifact.id, createdAt: timestamp }, updatedAt: timestamp };
    const outcomes = await Promise.all([store.persistTaskArtifactProjection(input), store.persistTaskArtifactProjection(input)]);
    assert.deepEqual(outcomes.sort(), ["created", "existing"]);
    assert.equal((await store.findProjectResourceUsage("project_task"))?.projectFileBytes, 4);
    assert.deepEqual((await store.listTaskArtifacts("task_artifact")).map((item) => item.id), [artifact.id]);
    assert.deepEqual((await store.listProjectAuditEvents("project_task")).map((event) => event.id), [input.auditEvent.id]);
  });

  function liveCreate(taskId: string, runId: string): AtomicTaskCreateInput {
    const task: AgentTask = { id: taskId, workspaceId: "workspace_task", projectId: "project_task", endpointId: "endpoint_task", title: taskId, prompt: taskId, inputPaths: [], status: "starting", runId, sourceTaskId: null, executionMode: "live", sandbox: { namespace: "agentsmith", resources: [] }, terminalReason: null, startDeliveryKey: `delivery-${taskId}`, startRequestHash: `hash-${taskId}`, startClaimToken: null, startIntentStatus: "pending", startAttemptCount: 0, artifactProjectionStatus: "pending", cleanupStatus: "pending", createdAt: timestamp, updatedAt: timestamp };
    const run: PersistedSandboxRunState = { namespace: "agentsmith", workspaceId: task.workspaceId, projectId: task.projectId, taskId, runId, phase: "starting", image: "runner", pvcName: "files", projectSubPath: "workspaces/workspace_task/projects/project_task", botifiedPort: 3099, resourceNames: { pod: `${taskId}-pod`, service: `${taskId}-service`, configMap: `${taskId}-config`, secret: `${taskId}-secret` }, serviceKeySecretRef: { name: `${taskId}-secret`, key: "BOTIFIED_SERVICE_KEY" }, directories: { taskHome: `/tasks/${taskId}/home`, artifacts: `/tasks/${taskId}/artifacts`, botified: `/tasks/${taskId}/botified` }, resourceLimits: { cpuRequest: "1m", memoryRequest: "1Mi", cpuLimit: "1", memoryLimit: "1Gi" }, fencingToken: 1, cleanupStatus: "active", createdAt: timestamp, updatedAt: timestamp };
    return { task, reserveActive: true, runtimeState: { botifiedBaseUrl: `http://${taskId}` }, sandboxRun: run };
  }

  function pendingFollowUp(id: string, taskId: string): TaskFollowUp { return { id, taskId, prompt: id, followUpTaskId: null, deliveryKey: `delivery-${id}`, requestHash: `hash-${id}`, claimToken: null, receipt: null, timelineCursor: null, deliveryStatus: "pending", claimedAt: null, leaseExpiresAt: null, attemptCount: 0, nextRetryAt: null, safeError: null, createdAt: timestamp, updatedAt: timestamp, deletedAt: null }; }
  function finalizeInput(taskId: string, terminalReason: "completed" | "failed" | "cancelled", auditId: string, action: ProjectAuditEvent["action"]) { return { taskId, terminalReason, updatedAt: timestamp, auditEvent: { id: auditId, projectId: "project_task", actorId: null, action, status: "accepted" as const, resourceKind: "task" as const, resourceId: taskId, detail: { endpointId: "endpoint_task" }, createdAt: timestamp }, successors: [] }; }
});
