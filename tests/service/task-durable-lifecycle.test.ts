import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { AgentTask, KubernetesResource, ProjectAuditEvent } from "../../packages/contracts/src/api.js";
import type {
  BotifiedAbortResult,
  BotifiedDeliveryMessageInput,
  BotifiedDeliveryReceipt,
  BotifiedDownloadFileResult,
  BotifiedPostMessageResult,
  BotifiedRuntimeHttpClient,
  BotifiedTimelineReadResult,
  BotifiedUploadFileInput,
  BotifiedUploadFileResult
} from "../../packages/ports/src/botified.js";
import type { KubernetesResourceRef, PodReadiness, SandboxKubernetesMutationPort, SandboxKubernetesReadinessPort } from "../../packages/sandbox-controller/src/kubernetesPort.js";

describe("durable task lifecycle", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("persists scoped idempotency, canonical replay, hash mismatch, and dry-run non-execution", async () => {
    const setup = await createSetup(false);
    const input = { endpointId: setup.endpointId, prompt: "do not execute", title: "Dry run" };
    const first = await setup.services.tasks.createTask(setup.userId, setup.projectId, input, "same-key");
    const replay = await setup.services.tasks.createTask(setup.userId, setup.projectId, { title: "Dry run", prompt: "do not execute", endpointId: setup.endpointId }, "same-key");

    assert.equal(replay.id, first.id);
    assert.equal(first.status, "completed");
    assert.equal(first.terminalReason, "not_executed");
    assert.equal(first.activeReservation, false);
    assert.deepEqual(first.sandbox.resources, []);
    assert.equal((await setup.store.findProjectResourceUsage(setup.projectId))?.activeTasks, 0);
    assert.equal(await setup.store.jsonDocs.get("sandbox_runtime_state", first.id), null);
    await assert.rejects(
      () => setup.services.tasks.createTask(setup.userId, setup.projectId, { ...input, prompt: "different" }, "same-key"),
      (error: unknown) => error instanceof Error && /different request/.test(error.message)
    );

    const duplicate = await setup.services.tasks.duplicateTask(setup.userId, first.id, "same-key");
    assert.notEqual(duplicate.id, first.id, "operation is part of the idempotency scope");

    const member = await setup.services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "member", email: "member@example.test", emailVerified: true });
    const timestamp = new Date().toISOString();
    await setup.store.upsertProjectMembership({ projectId: setup.projectId, userId: member.user.id, role: "member", createdAt: timestamp, updatedAt: timestamp });
    const actorScoped = await setup.services.tasks.createTask(member.user.id, setup.projectId, input, "same-key");
    assert.notEqual(actorScoped.id, first.id, "actor is part of the idempotency scope");

    const otherProject = await setup.services.workspaces.createProject(setup.userId, setup.workspaceId, { name: "Other project" });
    const otherCredential = await setup.services.credentials.create(setup.userId, otherProject.id, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "sk-other" });
    const otherEndpoint = await setup.services.endpoints.createEndpoint(setup.userId, otherProject.id, { name: "Endpoint", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "model", credentialId: otherCredential.id, capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30 });
    const projectScoped = await setup.services.tasks.createTask(setup.userId, otherProject.id, { ...input, endpointId: otherEndpoint.id }, "same-key");
    assert.notEqual(projectScoped.id, first.id, "project is part of the idempotency scope");
  });

  it("atomically persists live reservation, start intent, and runtime metadata", async () => {
    const setup = await createSetup(true);
    const task = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "start later" }, "create-live");
    assert.equal(task.status, "starting");
    assert.equal(task.startIntentStatus, "pending");
    assert.equal(task.startClaimToken, null);
    assert.equal(task.activeReservation, true);
    assert.equal((await setup.store.findProjectResourceUsage(setup.projectId))?.activeTasks, 1);
    assert.ok(await setup.store.jsonDocs.get("sandbox_runtime_state", task.id));
    assert.ok(await setup.store.sandboxRuns.get(task.runId));
    assert.equal(setup.botified.posts.length, 0);
  });

  it("rejects an endpoint missing task capabilities before task persistence", async () => {
    const setup = await createSetup(false);
    const endpoint = await setup.services.endpoints.createEndpoint(setup.userId, setup.projectId, { name: "Text only", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "model", credentialId: setup.credentialId, capabilities: ["text"], requestTimeoutSecs: 30 });
    await assert.rejects(() => setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: endpoint.id, prompt: "cannot run" }, "create-missing-capability"), /tool_calls capability/);
    await setup.store.updateEndpoint({ ...endpoint, capabilities: ["text", "tool_calls"], updatedAt: new Date().toISOString() });
    await assert.rejects(() => setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: endpoint.id, prompt: "cannot run" }, "create-missing-capability"), /tool_calls capability/);
    assert.deepEqual(await setup.store.listTasksForProject(setup.projectId), []);
  });

  it("persists a retry precondition failure across later task state changes", async () => {
    const setup = await createSetup(true);
    const source = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "not terminal" }, "create-retry-source");
    await assert.rejects(() => setup.services.tasks.retryTask(setup.userId, source.id, "retry-before-terminal"), /must be terminal/);
    await setup.services.tasks.cancelTask(setup.userId, source.id, "cancel-retry-source");
    await assert.rejects(() => setup.services.tasks.retryTask(setup.userId, source.id, "retry-before-terminal"), /must be terminal/);
    const retried = await setup.services.tasks.retryTask(setup.userId, source.id, "retry-after-terminal");
    assert.equal(retried.sourceTaskId, source.id);
  });

  it("snapshots only immutable project files selected for a live task", async () => {
    const setup = await createSetup(true);
    const source = path.join(setup.dataRoot, setup.projectRootPath, "files", "input.txt");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "original");
    const task = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "use input", inputPaths: ["files/input.txt"] }, "create-input-snapshot");
    await writeFile(source, "changed");
    assert.equal(await readFile(path.join(setup.dataRoot, setup.projectRootPath, "tasks", task.id, "inputs", "files", "input.txt"), "utf8"), "original");
    const inputs=await setup.services.tasks.listTaskInputs(setup.userId,task.id);
    assert.deepEqual(inputs.map((input)=>({path:input.path,name:input.name,bytes:input.bytes})),[{path:"files/input.txt",name:"input.txt",bytes:8}]);
    assert.equal((await setup.services.tasks.downloadTaskInput(setup.userId,task.id,"files/input.txt")).bytes.toString("utf8"),"original");
    const terminal=await setup.services.tasks.openTaskTerminal(setup.userId,task.id);
    assert.equal(terminal.serviceKey,"service-key");
    assert.match(terminal.baseUrl,/^http:\/\//);
    await assert.rejects(() => setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "escape", inputPaths: ["../outside"] }, "create-invalid-input"), /must stay under files/);
  });

  it("reconciles a crashed accepted start by delivery key without a second post", async () => {
    const setup = await createSetup(true);
    setup.botified.throwAfterAcceptOnce = true;
    const task = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "accept once" }, "create-crash");

    await setup.services.tasks.syncActiveTasksOnce();
    const uncertain = await setup.store.findTask(task.id);
    assert.equal(uncertain?.startIntentStatus, "dispatching");
    assert.equal(setup.botified.posts.length, 1);

    await setup.services.tasks.syncActiveTasksOnce();
    const recovered = await setup.store.findTask(task.id);
    assert.equal(recovered?.startIntentStatus, "dispatched");
    assert.equal(recovered?.status, "running");
    assert.equal(recovered?.startReceipt?.accepted, true);
    assert.equal(recovered?.startTimelineCursor, "cursor-1");
    assert.equal(setup.botified.posts.length, 1);
    await setup.store.jsonDocs.put("sandbox_runtime_state", task.id, { botifiedBaseUrl: "http://task.test" });
    await setup.services.tasks.syncActiveTasksOnce();
    assert.equal(setup.botified.timelineCursors.at(-1), "cursor-1");
  });

  it("reconciles an uncertain accepted start before cancellation cleanup", async () => {
    const setup = await createSetup(true);
    setup.botified.throwAfterAcceptOnce = true;
    const task = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "accept then cancel" }, "create-cancel-uncertain");
    await setup.services.tasks.syncActiveTasksOnce();
    assert.equal((await setup.store.findTask(task.id))?.startIntentStatus, "dispatching");
    await setup.services.tasks.cancelTask(setup.userId, task.id, "cancel-uncertain-start");
    await setup.services.tasks.syncActiveTasksOnce();
    const cancelled = await setup.store.findTask(task.id);
    assert.equal(cancelled?.startIntentStatus, "dispatched");
    assert.equal(cancelled?.terminalReason, "cancelled");
    assert.equal(cancelled?.cleanupStatus, "completed");
    assert.equal(setup.botified.posts.length, 1);
  });

  it("keeps an unreachable receipt query retryable and never resends", async () => {
    const setup = await createSetup(true);
    setup.botified.throwAfterAcceptOnce = true;
    const task = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "uncertain" }, "create-unreachable");
    await setup.services.tasks.syncActiveTasksOnce();
    setup.botified.queryError = new Error("delivery query unreachable");
    await setup.services.tasks.syncActiveTasksOnce();
    assert.equal(setup.botified.posts.length, 1);
    assert.equal((await setup.store.findTask(task.id))?.startIntentStatus, "dispatching");
    setup.botified.queryError = null;
    await setup.services.tasks.syncActiveTasksOnce();
    assert.equal(setup.botified.posts.length, 1);
    assert.equal((await setup.store.findTask(task.id))?.startIntentStatus, "dispatched");
  });

  it("keeps terminal reason first-wins and releases the reservation once", async () => {
    const setup = await createSetup(true);
    const task = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "race" }, "create-race");
    const timestamp = new Date().toISOString();
    const audit = (id: string, action: ProjectAuditEvent["action"]): ProjectAuditEvent => ({ id, projectId: setup.projectId, actorId: null, action, status: "accepted", resourceKind: "task", resourceId: task.id, createdAt: timestamp });
    await Promise.all([
      setup.store.finalizeTaskLifecycle({ taskId: task.id, terminalReason: "completed", updatedAt: timestamp, auditEvent: audit("audit-complete", "task.completed"), successors: [] }),
      setup.store.finalizeTaskLifecycle({ taskId: task.id, terminalReason: "failed", updatedAt: timestamp, auditEvent: audit("audit-failed", "task.failed"), successors: [] })
    ]);
    const winner = await setup.store.findTask(task.id);
    assert.ok(winner?.terminalReason === "completed" || winner?.terminalReason === "failed");
    const originalReason = winner!.terminalReason;
    await setup.store.finalizeTaskLifecycle({ taskId: task.id, terminalReason: originalReason === "failed" ? "completed" : "failed", updatedAt: new Date(Date.now() + 1).toISOString(), auditEvent: audit("audit-late", "task.failed"), successors: [] });
    assert.equal((await setup.store.findTask(task.id))?.terminalReason, originalReason);
    assert.equal((await setup.store.findProjectResourceUsage(setup.projectId))?.activeTasks, 0);
  });

  it("persists task failure before the policy evaluator projects scoped alerts", async () => {
    const setup = await createSetup(true);
    const { store, services } = setup;
    const timestamp = new Date().toISOString();
    const task = await services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "fail with scoped alerts" }, "create-alert");
    await store.createProjectAlertRule({ id: "rule-project", projectId: task.projectId, name: "Project failures", alertType: "task_failure", metric: "failure_count", condition: "greater_than_or_equal", threshold: 1, windowSeconds: 60, scope: { kind: "project" }, enabled: true, createdAt: timestamp, updatedAt: timestamp });
    await store.createProjectAlertRule({ id: "rule-endpoint", projectId: task.projectId, name: "Endpoint failures", alertType: "task_failure", metric: "failure_count", condition: "greater_than_or_equal", threshold: 1, windowSeconds: 60, scope: { kind: "endpoint", endpointId: task.endpointId }, enabled: true, createdAt: timestamp, updatedAt: timestamp });
    await store.createProjectAlertRule({ id: "rule-disabled", projectId: task.projectId, name: "Disabled failures", alertType: "task_failure", metric: "failure_count", condition: "greater_than_or_equal", threshold: 1, windowSeconds: 60, scope: { kind: "project" }, enabled: false, createdAt: timestamp, updatedAt: timestamp });
    await store.upsertActiveProjectAlert({ id: "existing-project-alert", projectId: task.projectId, type: "task_failure", status: "active", deliveryStatus: "delivered", ruleId: "rule-project", metric: "failure_count", metricValue: 0, threshold: 1, endpointId: null, acknowledgedAt: null, acknowledgedBy: null, silencedUntil: null, createdAt: timestamp, updatedAt: timestamp, resolvedAt: null, dismissedAt: null });
    await store.upsertActiveProjectAlert({ id: "disabled-project-alert", projectId: task.projectId, type: "task_failure", status: "active", deliveryStatus: "delivered", ruleId: "rule-disabled", metric: "failure_count", metricValue: 1, threshold: 1, endpointId: null, acknowledgedAt: null, acknowledgedBy: null, silencedUntil: null, createdAt: timestamp, updatedAt: timestamp, resolvedAt: null, dismissedAt: null });

    await store.finalizeTaskLifecycle({ taskId: task.id, terminalReason: "failed", updatedAt: timestamp, auditEvent: { id: "audit-alert", projectId: task.projectId, actorId: null, action: "task.failed", status: "accepted", resourceKind: "task", resourceId: task.id, detail: { endpointId: task.endpointId }, createdAt: timestamp }, successors: [] });

    const finalized = await store.findTask(task.id);
    assert.equal(finalized?.terminalReason, "failed");
    assert.equal(finalized?.artifactProjectionStatus, "draining");
    assert.equal(finalized?.cleanupStatus, "pending");
    assert.deepEqual((await store.listActiveProjectAlerts(task.projectId)).map((alert) => alert.id), ["existing-project-alert", "disabled-project-alert"]);
    await services.tasks.syncActiveTasksOnce();
    assert.deepEqual((await store.listActiveProjectAlerts(task.projectId)).map((alert) => [alert.ruleId, alert.endpointId, alert.metricValue]), [["rule-project", null, 1], ["rule-endpoint", task.endpointId, 1]]);
    assert.equal((await store.listProjectAlerts(task.projectId)).find((alert) => alert.id === "disabled-project-alert")?.status, "resolved");
    await services.policies.evaluateTaskFailure(task.projectId, task.endpointId);
    assert.deepEqual((await services.notifications.list(setup.userId)).map((notification) => notification.type), ["project_alert"]);
    assert.deepEqual((await store.listProjectAuditEvents(task.projectId)).filter((event) => event.action === "task.failed").map((event) => event.action), ["task.failed"]);
  });

  it("linearizes a terminal follow-up race to accepted after remote acceptance", async () => {
    const setup = await createSetup(true);
    const source = await startTask(setup, "source-accepted");
    setup.botified.throwAfterAcceptOnce = true;
    const uncertain = await setup.services.tasks.followUpTask(setup.userId, source.id, "continue accepted", "follow-key");
    assert.equal(uncertain.deliveryStatus, "dispatching");
    await setup.services.tasks.cancelTask(setup.userId, source.id, "cancel-key");
    assert.equal((await setup.store.findTaskFollowUp(uncertain.id))?.deliveryStatus, "terminal_pending");
    await setup.store.deferTaskFollowUp({ id: uncertain.id, claimToken: uncertain.claimToken!, safeError: "wait before reconcile", nextRetryAt: "2999-01-01T00:00:00.000Z", updatedAt: new Date().toISOString() });
    await setup.services.tasks.syncActiveTasksOnce();
    assert.equal((await setup.store.findTask(source.id))?.artifactProjectionStatus, "failed");
    assert.equal((await setup.store.findTask(source.id))?.cleanupStatus, "pending");
    assert.ok(setup.port.resources.length > 0);
    await setup.store.deferTaskFollowUp({ id: uncertain.id, claimToken: uncertain.claimToken!, safeError: "retry now", nextRetryAt: "2000-01-01T00:00:00.000Z", updatedAt: new Date().toISOString() });
    await setup.services.tasks.syncActiveTasksOnce();
    const accepted = await setup.store.findTaskFollowUp(uncertain.id);
    assert.equal(accepted?.deliveryStatus, "accepted");
    assert.equal(accepted?.followUpTaskId, null);
    const replay = await setup.services.tasks.followUpTask(setup.userId, source.id, "continue accepted", "follow-key");
    assert.equal(replay.deliveryStatus, "accepted");
    assert.equal(setup.botified.posts.filter((post) => post.text === "continue accepted").length, 1);
  });

  it("allows only pending follow-ups to be edited and deleted", async () => {
    const setup = await createSetup(true);
    const source = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "source pending" }, "create-pending-source");
    const pending = await setup.services.tasks.followUpTask(setup.userId, source.id, "first prompt", "pending-follow");
    assert.equal(pending.deliveryStatus, "pending");
    const edited = await setup.services.tasks.editTaskFollowUp(setup.userId, source.id, pending.id, "edited prompt", "edit-pending");
    assert.equal(edited.prompt, "edited prompt");
    assert.notEqual(edited.requestHash, pending.requestHash);
    assert.deepEqual(await setup.services.tasks.deleteTaskFollowUp(setup.userId, source.id, pending.id, "delete-pending"), { deleted: true, followUpId: pending.id });
    assert.deepEqual(await setup.services.tasks.listTaskFollowUps(setup.userId, source.id), []);
  });

  it("creates one linked successor when a terminal pending delivery is explicitly absent", async () => {
    const setup = await createSetup(true);
    const source = await startTask(setup, "source-successor");
    setup.botified.throwBeforeAcceptOnce = true;
    const uncertain = await setup.services.tasks.followUpTask(setup.userId, source.id, "continue as successor", "successor-key");
    assert.equal(uncertain.deliveryStatus, "dispatching");
    await setup.services.tasks.cancelTask(setup.userId, source.id, "cancel-successor");
    await setup.services.tasks.syncActiveTasksOnce();
    const resolved = await setup.store.findTaskFollowUp(uncertain.id);
    assert.equal(resolved?.deliveryStatus, "successor_created");
    assert.ok(resolved?.followUpTaskId);
    assert.equal((await setup.store.findTask(resolved!.followUpTaskId!))?.sourceTaskId, source.id);
    assert.equal(resolved?.receipt, null);
  });

  it("drains a late artifact before fenced cleanup completes", async () => {
    const setup = await createSetup(true);
    setup.botified.timelineReads.push(
      { status: "ok", events: [{ cursor: "done", seq: 1, session_id: "s1", type: "cycle.completed", payload: { ok: true } }], nextCursor: "done" },
      { status: "ok", events: [{ cursor: "late", seq: 2, session_id: "s1", type: "file.published", payload: { file_id: "late-file", filename: "late.txt", size_bytes: 4 } }], nextCursor: "late" }
    );
    setup.botified.downloads.set("late-file", new TextEncoder().encode("late"));
    const task = await startTask(setup, "late-artifact");
    await setup.services.tasks.syncActiveTasksOnce();
    const completed = await setup.store.findTask(task.id);
    assert.equal(completed?.terminalReason, "completed");
    assert.equal(completed?.artifactProjectionStatus, "drained");
    assert.equal(completed?.cleanupStatus, "completed");
    assert.deepEqual((await setup.store.listTaskArtifacts(task.id)).map((artifact) => artifact.fileId), ["late-file"]);
    assert.equal((await setup.store.findProjectResourceUsage(setup.projectId))?.projectFileBytes, 4);
    assert.equal((await setup.store.listProjectAuditEvents(setup.projectId)).filter((event) => event.action === "artifact.project").length, 1);
    assert.equal(setup.port.resources.length, 0);
  });

  it("projects files written directly to the shared task artifact directory", async () => {
    const setup = await createSetup(true);
    const inputPath = path.join(setup.dataRoot, setup.projectRootPath, "files", "input.txt");
    await mkdir(path.dirname(inputPath), { recursive: true });
    await writeFile(inputPath, "retained input");
    const created = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "shared-artifact", inputPaths: ["files/input.txt"] }, "create-shared-artifact");
    await setup.services.tasks.syncActiveTasksOnce();
    const task = await setup.store.findTask(created.id);
    assert.ok(task);
    assert.equal(task?.startIntentStatus, "dispatched");
    const artifactPath = path.join(setup.dataRoot, setup.projectRootPath, "tasks", task.id, "artifacts", "result.txt");
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, "sandbox result");
    setup.botified.timelineReads.push(
      { status: "ok", events: [{ cursor: "done", seq: 1, session_id: "s1", type: "cycle.completed", payload: { ok: true } }], nextCursor: "done" },
      { status: "ok", events: [], nextCursor: "done" }
    );

    await setup.services.tasks.syncActiveTasksOnce();

    const completed = await setup.store.findTask(task.id);
    const artifacts = await setup.services.tasks.listTaskArtifacts(setup.userId, task.id);
    assert.equal(completed?.artifactProjectionStatus, "drained");
    assert.deepEqual(artifacts.map((artifact) => [artifact.fileId, artifact.name, artifact.bytes]), [["sandbox:result.txt", "result.txt", 14]]);
    assert.equal((await setup.services.tasks.downloadTaskArtifact(setup.userId, task.id, artifacts[0]!.id)).bytes.toString("utf8"), "sandbox result");
    assert.equal((await setup.services.tasks.downloadTaskInput(setup.userId, task.id, "files/input.txt")).bytes.toString("utf8"), "retained input");
    assert.equal((await setup.store.findProjectResourceUsage(setup.projectId))?.projectFileBytes, 14);
  });

  it("completes terminal drained cleanup when the pod is already absent and repeated ticks are idempotent", async () => {
    const setup = await createSetup(true);
    const task = await startTask(setup, "terminal-pod-absent");
    setup.botified.timelineReads.push(
      { status: "ok", events: [{ cursor: "done", seq: 1, session_id: "s1", type: "cycle.completed", payload: { ok: true } }], nextCursor: "done" },
      { status: "ok", events: [], nextCursor: "done" },
      new Error("Botified is gone with the Pod")
    );
    setup.port.removePodBeforeNextInventory = true;

    const firstTick = await setup.services.tasks.syncActiveTasksOnce();
    const completed = await setup.store.findTask(task.id);
    const completedAt = completed?.cleanupCompletedAt;

    assert.deepEqual(firstTick.failedTaskIds, []);
    assert.equal(completed?.terminalReason, "completed");
    assert.equal(completed?.artifactProjectionStatus, "drained");
    assert.equal(completed?.cleanupStatus, "completed");
    assert.ok(completedAt);
    assert.equal(completed?.cleanupAttemptCount, 1);
    assert.equal(await setup.store.sandboxRuns.get(task.runId), null);
    assert.equal(setup.port.resources.length, 0);
    assert.equal(setup.botified.timelineReads.length, 1, "cleanup must not call an endpoint whose Pod is absent");

    const deleteCalls = setup.port.deleteCalls;
    const timelineCalls = setup.botified.timelineCursors.length;
    await setup.services.tasks.syncActiveTasksOnce();
    const repeated = await setup.store.findTask(task.id);

    assert.equal(repeated?.cleanupStatus, "completed");
    assert.equal(repeated?.cleanupCompletedAt, completedAt);
    assert.equal(repeated?.cleanupAttemptCount, 1);
    assert.equal(setup.port.deleteCalls, deleteCalls);
    assert.equal(setup.botified.timelineCursors.length, timelineCalls);
  });

  it("queries task list server-side and tails the authorized persistent transcript", async () => {
    const setup = await createSetup(false);
    const alpha = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "alpha prompt", title: "Alpha" }, "alpha");
    const beta = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "beta prompt", title: "Beta" }, "beta");
    await setup.services.tasks.archiveTask(setup.userId, beta.id, "archive-beta");
    const page = await setup.services.tasks.listTasks(setup.userId, setup.projectId, { search: "alpha", statuses: ["completed"], archived: "exclude", sort: "title", direction: "asc", limit: 1 });
    assert.deepEqual(page.items.map((task) => task.id), [alpha.id]);
    assert.equal(page.total, 1);
    await setup.store.appendTaskEvents([{ id: "event-user", taskId: alpha.id, kind: "user_input", cursor: "cursor-user", botifiedSeq: 1, botifiedType: "user.message", sessionId: "s1", payload: { text: "hello" }, createdAt: alpha.createdAt }, { id: "event-assistant", taskId: alpha.id, kind: "assistant_message", cursor: "cursor-assistant", botifiedSeq: 2, botifiedType: "assistant.message", sessionId: "s1", payload: { text: "world" }, createdAt: alpha.createdAt }]);
    const transcript = await setup.services.tasks.taskTranscript(setup.userId, alpha.id, { limit: 10 });
    assert.deepEqual(transcript.items.map((item) => [item.role, item.text]), [["user", "hello"], ["assistant", "world"]]);
    assert.equal(transcript.nextCursor, "cursor-assistant");
    assert.deepEqual(await setup.services.tasks.taskTranscript(setup.userId, alpha.id, { cursor: transcript.nextCursor!, limit: 10 }), { items: [], nextCursor: "cursor-assistant" });
    const stranger = await setup.services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "stranger", email: "stranger@example.test", emailVerified: true });
    await assert.rejects(() => setup.services.tasks.taskTranscript(stranger.user.id, alpha.id), /Project access denied/);
  });

  async function createSetup(live: boolean) {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-task-durable-")); roots.push(dataRoot);
    const store = createLocalInMemoryProductStore(); const botified = new DurableBotifiedClient(); const port = new MemorySandboxPort();
    const services = createApplicationServices({ store, dataRoot, builtinAdminPassword: live ? "production-admin-password" : "admin-password", sessionSecret: "production-session-secret-at-least-32-chars", botifiedClient: botified, botifiedServiceKeyFactory: () => "service-key", providerClient: { completeChat: async () => { throw new Error("not used"); }, validateEndpoint: async () => ({ status: "healthy" }) }, taskDeliveryLeaseMs: 0, taskMaintenanceLeaseMs: 0, taskRetryDelayMs: 0, ...(live ? { liveSandbox: { port, readinessTimeoutMs: 10, readinessPollMs: 1, sleep: async () => undefined } } : {}) });
    const { user } = await services.auth.loginAfterBootstrap(live ? "production-admin-password" : "admin-password");
    const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
    const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });
    const credential = await services.credentials.create(user.id, project.id, { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "sk-test" });
    const endpoint = await services.endpoints.createEndpoint(user.id, project.id, { name: "Endpoint", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "model", credentialId: credential.id, capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30 });
    return { services, store, botified, port, dataRoot, userId: user.id, workspaceId: workspace.id, projectId: project.id, projectRootPath: project.rootPath, credentialId: credential.id, endpointId: endpoint.id };
  }

  async function startTask(setup: Awaited<ReturnType<typeof createSetup>>, key: string): Promise<AgentTask> {
    const task = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: key }, `create-${key}`);
    await setup.services.tasks.syncActiveTasksOnce();
    const running = await setup.store.findTask(task.id); assert.equal(running?.startIntentStatus, "dispatched"); return running!;
  }
});

class DurableBotifiedClient implements BotifiedRuntimeHttpClient {
  readonly posts: Array<{ text: string; deliveryKey: string; requestHash: string }> = [];
  readonly receipts = new Map<string, BotifiedDeliveryReceipt>();
  readonly timelineReads: Array<BotifiedTimelineReadResult | Error> = [];
  readonly timelineCursors: Array<string | undefined> = [];
  readonly downloads = new Map<string, Uint8Array>();
  throwAfterAcceptOnce = false;
  throwBeforeAcceptOnce = false;
  queryError: Error | null = null;
  async health() { return { status: "ok" as const }; }
  async readState() { return { snapshot: {}, state: "running" }; }
  async postMessage(_baseUrl: string, _serviceKey: string, message: string): Promise<BotifiedPostMessageResult> { return { accepted: true, messageId: message, cursor: "cursor" }; }
  async postMessageWithDelivery(_baseUrl: string, _serviceKey: string, input: BotifiedDeliveryMessageInput): Promise<BotifiedDeliveryReceipt> {
    this.posts.push({ text: input.text, deliveryKey: input.deliveryKey, requestHash: input.requestHash });
    if (this.throwBeforeAcceptOnce) { this.throwBeforeAcceptOnce = false; throw new Error("post failed before acceptance"); }
    const receipt: BotifiedDeliveryReceipt = { accepted: true, deliveryKey: input.deliveryKey, requestHash: input.requestHash, messageId: `message-${this.posts.length}`, cursor: `cursor-${this.posts.length}` };
    this.receipts.set(input.deliveryKey, receipt);
    if (this.throwAfterAcceptOnce) { this.throwAfterAcceptOnce = false; throw new Error("crash after remote acceptance"); }
    return receipt;
  }
  async queryDeliveryReceipt(_baseUrl: string, _serviceKey: string, deliveryKey: string) { if (this.queryError) throw this.queryError; return this.receipts.get(deliveryKey) ?? null; }
  async readTimeline(_baseUrl: string, _serviceKey: string, cursor?: string): Promise<BotifiedTimelineReadResult> { this.timelineCursors.push(cursor); const next = this.timelineReads.shift(); if (next instanceof Error) throw next; return next ?? { status: "ok", events: [], ...(cursor ? { nextCursor: cursor } : {}) }; }
  async uploadFile(_baseUrl: string, _serviceKey: string, _file: BotifiedUploadFileInput): Promise<BotifiedUploadFileResult> { return { files: [] }; }
  async downloadFile(_baseUrl: string, _serviceKey: string, fileId: string): Promise<BotifiedDownloadFileResult> { const bytes = this.downloads.get(fileId) ?? new Uint8Array(); return { bytes, sizeBytes: bytes.byteLength, filename: fileId }; }
  async abort(): Promise<BotifiedAbortResult> { return { aborted: true }; }
}

class MemorySandboxPort implements SandboxKubernetesMutationPort, SandboxKubernetesReadinessPort {
  resources: KubernetesResource[] = [];
  removePodBeforeNextInventory = false;
  deleteCalls = 0;
  async listManagedResources() {
    if (this.removePodBeforeNextInventory) {
      this.resources = this.resources.filter((resource) => resource.kind !== "Pod");
      this.removePodBeforeNextInventory = false;
    }
    return structuredClone(this.resources);
  }
  async applyResource(resource: KubernetesResource) { this.resources = this.resources.filter((item) => item.kind !== resource.kind || item.metadata.name !== resource.metadata.name); this.resources.push(structuredClone(resource)); return "applied" as const; }
  async deleteResource(ref: KubernetesResourceRef) { this.deleteCalls += 1; const before = this.resources.length; this.resources = this.resources.filter((item) => item.kind !== ref.kind || item.metadata.name !== ref.name); return before === this.resources.length ? "not_found" as const : "deleted" as const; }
  async getPodReadiness(): Promise<PodReadiness> { return "ready"; }
}
