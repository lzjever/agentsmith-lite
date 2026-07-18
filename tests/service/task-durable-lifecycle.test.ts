import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { TaskAssistantPreviewUpdate } from "../../packages/application/src/taskService.js";
import { projectTaskInteraction } from "../../packages/application/src/taskInteractionProjector.js";
import type { BotifiedTimelineEvent } from "../../packages/botified-runtime/src/projection.js";
import type { AgentTask, KubernetesResource, ProjectAuditEvent } from "../../packages/contracts/src/api.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import type {
  BotifiedAbortResult,
  BotifiedDeliveryMessageInput,
  BotifiedDeliveryReceipt,
  BotifiedDownloadFileResult,
  BotifiedLlmTextPreviewFrame,
  BotifiedPostMessageResult,
  BotifiedRuntimeHttpClient,
  BotifiedRuntimeStateResult,
  BotifiedTimelineReadResult,
  BotifiedUploadFileInput,
  BotifiedUploadFileResult
} from "../../packages/ports/src/botified.js";
import type { KubernetesResourceRef, PodReadiness, SandboxKubernetesMutationPort, SandboxKubernetesReadinessPort } from "../../packages/sandbox-controller/src/kubernetesPort.js";
import type { TaskInteractionChangeInput } from "../../packages/ports/src/store.js";

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
    assert.deepEqual(first.sandbox, { namespace: "agentsmith" });
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
    const persistedTask = await setup.store.findTask(task.id);
    assert.ok(persistedTask);
    assert.ok(persistedTask.sandbox.resources.length > 0);
    assert.deepEqual(task.sandbox, { namespace: "agentsmith" });
    assert.equal(task.status, "starting");
    assert.equal(task.startIntentStatus, "pending");
    assert.equal(persistedTask.startClaimToken, null);
    assert.equal(task.activeReservation, true);
    assert.equal((await setup.store.findProjectResourceUsage(setup.projectId))?.activeTasks, 1);
    assert.ok(await setup.store.jsonDocs.get("sandbox_runtime_state", task.id));
    assert.ok(await setup.store.sandboxRuns.get(task.runId));
    assert.equal(setup.botified.posts.length, 0);
    const detail = await setup.services.tasks.getTaskDetail(setup.userId, task.id);
    assert.equal(detail.task.id, task.id);
    assert.deepEqual(detail.task.sandbox, { namespace: "agentsmith" });
    assert.equal(detail.capabilities.cancelTask, true);
  });

  it("settles an unclaimed initial prompt when the task is cancelled before delivery", async () => {
    const setup = await createSetup(true);
    const task = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "cancel before delivery" }, "create-cancel-before-delivery");
    assert.equal((await setup.store.findTask(task.id))?.startIntentStatus, "pending");

    await setup.services.tasks.cancelTask(setup.userId, task.id, "cancel-before-delivery");
    const cancelled = await setup.store.findTask(task.id);
    assert.equal(cancelled?.terminalReason, "cancelled");
    assert.equal(cancelled?.startIntentStatus, "failed");

    await setup.store.updateTask({ ...cancelled!, startIntentStatus:"pending", startSafeError:null, updatedAt:new Date(Date.parse(cancelled!.updatedAt) + 1_000).toISOString() });
    const interactions = await setup.services.tasks.taskInteractions(setup.userId, task.id);
    const initial = interactions.items.find((item) => item.kind === "user_message");

    assert.equal(initial?.kind, "user_message");
    assert.equal(initial?.status, "failed");
    assert.equal(setup.botified.posts.length, 0);
  });

  it("attributes task provider usage to the task creator", async () => {
    const setup = await createSetup(true);
    const task = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "attribute usage" }, "create-attributed-task");

    assert.equal((await setup.store.findTask(task.id))?.createdByUserId, setup.userId);
    assert.equal((await setup.services.tasks.authorizeBotifiedChatCompletion(task.id, task.runId, "service-key")).actorId, setup.userId);
  });

  it("stops task interactions and provider authorization after credential rotation", async () => {
    const setup = await createSetup(true);
    const task = await startTask(setup, "credential-rotation");

    await setup.services.credentials.rotate(setup.userId, setup.projectId, setup.credentialId, { secret: "rotated-secret" });

    const interactions = await setup.services.tasks.taskInteractions(setup.userId, task.id);
    assert.equal(interactions.capabilities.sendMessage, false);
    assert.equal(interactions.capabilities.openTerminal, false);
    await assert.rejects(
      () => setup.services.tasks.authorizeBotifiedChatCompletion(task.id, task.runId, "service-key"),
      /Endpoint is unavailable/
    );
  });

  it("attributes a terminal successor to the member who sent its message", async () => {
    const setup = await createSetup(false);
    const source = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "finished source" }, "create-terminal-source");
    const member = await setup.services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "successor-member", email: "successor-member@example.test", emailVerified: true });
    const timestamp = new Date().toISOString();
    await setup.store.upsertProjectMembership({ projectId: setup.projectId, userId: member.user.id, role: "member", createdAt: timestamp, updatedAt: timestamp });

    const receipt = await setup.services.tasks.sendTaskMessage(member.user.id, source.id, "continue as member", "member-successor");
    const message = await setup.store.findTaskMessage(receipt.messageId);
    const successor = await setup.store.findTask(receipt.targetTaskId);

    assert.equal(message?.actorId, member.user.id);
    assert.equal(successor?.createdByUserId, member.user.id);
  });

  it("rejects an endpoint missing task capabilities before task persistence", async () => {
    const setup = await createSetup(false);
    const endpoint = await setup.services.endpoints.createEndpoint(setup.userId, setup.projectId, { name: "Text only", protocol: "openai_chat_completions", baseUrl: "https://models.example.test/v1", model: "model", credentialId: setup.credentialId, capabilities: ["text"], requestTimeoutSecs: 30 });
    await assert.rejects(() => setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: endpoint.id, prompt: "cannot run" }, "create-missing-capability"), /tool_calls capability/);
    await setup.store.updateEndpoint({ ...endpoint, capabilities: ["text", "tool_calls"], updatedAt: new Date().toISOString() });
    await assert.rejects(() => setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: endpoint.id, prompt: "cannot run" }, "create-missing-capability"), /tool_calls capability/);
    assert.deepEqual(await setup.store.listTasksForProject(setup.projectId), []);
  });

  it("rejects a missing endpoint credential before task persistence", async () => {
    const setup = await createSetup(false);
    const configured = await setup.store.findEndpoint(setup.endpointId);
    assert.ok(configured);
    const endpoint = await setup.store.createEndpoint({ ...configured, id: "endpoint_missing_credential", name: "Missing credential endpoint", credentialId: "", updatedAt: new Date().toISOString() });

    await assert.rejects(
      () => setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: endpoint.id, prompt: "must fail before creating a task" }, "create-missing-credential"),
      (error: unknown) => error instanceof Error && /Credential not found/.test(error.message)
    );
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
    const snapshotPath = path.join(setup.dataRoot, setup.projectRootPath, "tasks", task.id, "inputs", "files", "input.txt");
    assert.equal(await readFile(snapshotPath, "utf8"), "original");
    const inputs=await setup.services.tasks.listTaskInputs(setup.userId,task.id);
    assert.deepEqual(inputs.map((input)=>({path:input.path,name:input.name,bytes:input.bytes})),[{path:"files/input.txt",name:"input.txt",bytes:8}]);
    assert.equal((await setup.services.tasks.downloadTaskInput(setup.userId,task.id,"files/input.txt")).bytes.toString("utf8"),"original");
    await writeFile(snapshotPath, "tampered");
    await assert.rejects(() => setup.services.tasks.downloadTaskInput(setup.userId,task.id,"files/input.txt"), /no longer matches its manifest/);
    const terminal=await setup.services.tasks.openTaskTerminal(setup.userId,task.id);
    assert.equal(terminal.serviceKey,"service-key");
    assert.match(terminal.baseUrl,/^http:\/\//);
    setup.services.tasks.closeTaskTerminal(task.id);
    await assert.rejects(() => setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "escape", inputPaths: ["../outside"] }, "create-invalid-input"), /must stay under files/);
  });

  it("removes unpersisted task data when an input snapshot cannot be created", async () => {
    const setup = await createSetup(true);
    await assert.rejects(
      () => setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "missing input", inputPaths: ["files/missing.txt"] }, "create-missing-input"),
      (error: unknown) => error instanceof ProductError && error.statusCode === 404
    );

    assert.deepEqual(await readdir(path.join(setup.dataRoot, setup.projectRootPath, "tasks")), []);
    assert.deepEqual(await setup.store.listTasksForProject(setup.projectId), []);
  });

  it("removes a completed input snapshot when task persistence is rejected", async () => {
    const setup = await createSetup(true);
    const source = path.join(setup.dataRoot, setup.projectRootPath, "files", "input.txt");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, "input");
    setup.store.createTaskAtomically = async () => null;

    await assert.rejects(
      () => setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "rejected after snapshot", inputPaths: ["files/input.txt"] }, "create-rejected-after-snapshot"),
      (error: unknown) => error instanceof ProductError && error.code === "active_tasks_limit_reached"
    );

    assert.deepEqual(await readdir(path.join(setup.dataRoot, setup.projectRootPath, "tasks")), []);
    assert.deepEqual(await setup.store.listTasksForProject(setup.projectId), []);
  });

  it("copies retained source inputs when retrying or duplicating a task", async () => {
    const setup = await createSetup(true);
    const sourcePath = path.join(setup.dataRoot, setup.projectRootPath, "files", "retained.txt");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "retained original");
    const source = await setup.services.tasks.createTask(setup.userId, setup.projectId, {
      endpointId: setup.endpointId,
      prompt: "use retained input",
      inputPaths: ["files/retained.txt"]
    }, "create-retained-source");
    await setup.services.tasks.cancelTask(setup.userId, source.id, "cancel-retained-source");
    await rm(sourcePath);

    const retried = await setup.services.tasks.retryTask(setup.userId, source.id, "retry-retained-source");
    const duplicated = await setup.services.tasks.duplicateTask(setup.userId, source.id, "duplicate-retained-source");

    for (const derived of [retried, duplicated]) {
      const input = await setup.services.tasks.downloadTaskInput(setup.userId, derived.id, "files/retained.txt");
      assert.equal(input.bytes.toString("utf8"), "retained original");
      assert.equal(derived.sourceTaskId, source.id);
    }
  });

  it("removes successor linkage when its source task is deleted", async () => {
    const setup = await createSetup(false);
    const source = await setup.services.tasks.createTask(setup.userId, setup.projectId, {
      endpointId: setup.endpointId,
      prompt: "source to delete"
    }, "create-deleted-source");
    const successor = await setup.services.tasks.duplicateTask(setup.userId, source.id, "duplicate-deleted-source");

    assert.equal(successor.sourceTaskId, source.id);
    await setup.services.tasks.deleteTask(setup.userId, source.id, "delete-source-with-successor");

    assert.equal((await setup.services.tasks.getTaskDetail(setup.userId, successor.id)).task.sourceTaskId, null);
  });

  it("does not create a successor when its source is deleted concurrently", async () => {
    const setup = await createSetup(false);
    const source = await setup.services.tasks.createTask(setup.userId, setup.projectId, {
      endpointId: setup.endpointId,
      prompt: "source deleted during duplicate"
    }, "create-concurrent-delete-source");
    const createTaskAtomically = setup.store.createTaskAtomically.bind(setup.store);
    setup.store.createTaskAtomically = async (input) => {
      if (input.task.sourceTaskId === source.id) {
        await setup.store.deleteTaskData(source.id, new Date().toISOString());
      }
      return createTaskAtomically(input);
    };

    await assert.rejects(
      () => setup.services.tasks.duplicateTask(setup.userId, source.id, "duplicate-concurrently-deleted-source"),
      /Source task not found/
    );
    assert.deepEqual((await setup.store.listTasksForProject(setup.projectId)).filter((task) => !task.deletedAt), []);
  });

  it("snapshots effective context into the Botified task workspace", async () => {
    const setup = await createSetup(true);
    await setup.services.contexts.upsert(setup.userId, { workspaceId: setup.workspaceId, projectId: setup.projectId, scope: "project_personal", contextKey: "task.style", content: "Use terse task updates.", contentType: "text" });
    const task = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "use context" }, "create-context-snapshot");
    await setup.services.contexts.upsert(setup.userId, { workspaceId: setup.workspaceId, projectId: setup.projectId, scope: "project_personal", contextKey: "task.style", content: "This later edit must not replace the task snapshot.", contentType: "text", expectedVersion: 1 });

    await setup.services.tasks.syncActiveTasksOnce();

    const shellInstructions = await readFile(path.join(setup.dataRoot, setup.projectRootPath, "tasks", task.id, "home", "AGENTS.md"), "utf8");
    const taskSecret = setup.port.resources.find((resource) => resource.kind === "Secret" && resource.metadata.labels["agentsmith-lite/task-id"] === task.id) as (KubernetesResource & { stringData?: Record<string, string> }) | undefined;
    const instructions = taskSecret?.stringData?.["AGENTS.md"] ?? "";
    assert.doesNotMatch(shellInstructions, /task\.style|Use terse task updates/);
    assert.match(instructions, /task\.style[\s\S]*Use terse task updates/);
    assert.doesNotMatch(instructions, /later edit/);
  });

  it("holds editable messages in the AgentSmith queue until the active Botified turn is idle", async () => {
    const setup = await createSetup(true);
    const task = await startTask(setup, "queue-during-active-turn");
    const initialPostCount = setup.botified.posts.length;

    const queued = await setup.services.tasks.sendTaskMessage(setup.userId, task.id, "first version", "queue-active-message");

    assert.equal(queued.disposition, "queued_for_active_run");
    assert.deepEqual(queued.queuedMessage && {
      content: queued.queuedMessage.content,
      deliveryStatus: queued.queuedMessage.deliveryStatus,
      editable: queued.queuedMessage.editable,
      deletable: queued.queuedMessage.deletable
    }, { content: "first version", deliveryStatus: "pending", editable: true, deletable: true });
    assert.equal(setup.botified.posts.length, initialPostCount);

    await setup.services.tasks.editTaskMessage(setup.userId, task.id, queued.messageId, "edited before dispatch", "edit-active-message");
    const removable = await setup.services.tasks.sendTaskMessage(setup.userId, task.id, "remove before dispatch", "queue-removable-message");
    assert.equal(removable.queuedMessage?.deletable, true);
    await setup.services.tasks.deleteTaskMessage(setup.userId, task.id, removable.messageId, "delete-active-message");
    setup.botified.state = "idle";
    await setup.services.tasks.syncActiveTasksOnce();

    assert.equal((await setup.store.findTaskMessage(queued.messageId))?.deliveryStatus, "accepted");
    assert.ok((await setup.store.findTaskMessage(removable.messageId))?.deletedAt);
    assert.deepEqual(setup.botified.posts.slice(initialPostCount).map((post) => post.text), ["edited before dispatch"]);
  });

  it("keeps a cancelled Botified cycle non-terminal and dispatches the next message on the same task", async () => {
    const setup = await createSetup(true);
    const task = await startTask(setup, "abort-cycle-continues");

    const aborted = await setup.services.tasks.abortTaskTurn(setup.userId, task.id, "abort-current-turn");
    assert.equal(aborted.aborted, true);
    assert.equal((await setup.services.tasks.abortTaskTurn(setup.userId, task.id, "abort-current-turn")).aborted, true);
    const abortChanges = await setup.store.listTaskInteractionChanges(task.id, 0, 100);
    assert.deepEqual(
      abortChanges.filter((change) => change.sourceId === "turn:cycle-current:abort").map((change) => [change.sourceRevision, change.interaction.kind, change.interaction.body]),
      [[1, "assistant_message", "Current turn stopped."]]
    );
    assert.equal(setup.botified.abortCalls, 1);
    const queued = await setup.services.tasks.sendTaskMessage(setup.userId, task.id, "continue after abort", "message-after-abort");
    assert.equal(queued.disposition, "queued_for_active_run");
    assert.equal(queued.queuedMessage?.deliveryStatus, "pending");

    setup.botified.timelineReads.push({
      status: "ok",
      events: [timelineEvent(1, "cycle.failed", {
        cycle_id: "cycle-1",
        input_ids: ["message-1"],
        queue_length: 0,
        error: { code: "cancelled", message: "agent run cancelled", retryable: true },
        retryable: true
      }, { id:"cycle-1", type:"cycle", status:"failed" })],
      nextCursor: "evt_test_1",
      historyBoundary: "start"
    });
    setup.botified.state = "idle";

    await setup.services.tasks.syncActiveTasksOnce();

    const persistedTask = await setup.store.findTask(task.id);
    const delivered = await setup.store.findTaskMessage(queued.messageId);
    const interactions = await setup.services.tasks.taskInteractions(setup.userId, task.id);
    assert.equal(persistedTask?.status, "running");
    assert.equal(persistedTask?.terminalReason, null);
    assert.equal(delivered?.deliveryStatus, "accepted");
    assert.equal(delivered?.targetTaskId, null);
    assert.equal(interactions.items.some((item) => item.kind === "system_error"), false);
    assert.deepEqual((await setup.store.listTasksForProject(setup.projectId)).map((candidate) => candidate.id), [task.id]);
    assert.equal(setup.botified.posts.filter((post) => post.text === "continue after abort").length, 1);
  });

  it("projects background stop once without cancelling the task or restoring canStop", async () => {
    const setup = await createSetup(true);
    const task = await startTask(setup, "background-stop-product-source");
    setup.botified.timelineReads.push({
      status: "ok",
      events: [timelineEvent(1, "background_task.started", {
        task_id: "work-stop-1",
        tool_call_id: "call-stop-1",
        state: "running",
        work_summary: "Compile release"
      }, { id:"task_work-stop-1", type:"background_task", status:"running" })],
      nextCursor: "evt_test_1",
      historyBoundary: "start"
    });
    await setup.services.tasks.syncActiveTasksOnce();
    const before = await setup.services.tasks.taskInteractions(setup.userId, task.id);
    const work = before.items.find((item) => item.kind === "background_task");
    assert.ok(work && work.kind === "background_task");
    assert.equal(work.canStop, true);

    const stopped = await setup.services.tasks.stopTaskBackgroundWork(setup.userId, task.id, work.id, "stop-background-once");
    const replay = await setup.services.tasks.stopTaskBackgroundWork(setup.userId, task.id, work.id, "stop-background-once");
    assert.equal(stopped.state, "cancelling");
    assert.deepEqual(replay, stopped);
    assert.deepEqual(setup.botified.stopCalls, ["work-stop-1"]);

    const stopChanges = (await setup.store.listTaskInteractionChanges(task.id, 0, 100))
      .filter((change) => change.sourceId === "background-work:work-stop-1:stop");
    assert.equal(stopChanges.length, 1);
    assert.equal(stopChanges[0]?.sourceRevision, 2);
    assert.equal(stopChanges[0]?.interaction.kind, "background_task");
    assert.equal(stopChanges[0]?.interaction.body, "Compile release");
    assert.equal(stopChanges[0]?.interaction.kind === "background_task" && stopChanges[0].interaction.canStop, false);
    assert.equal((await setup.store.findTask(task.id))?.terminalReason, null);

    setup.botified.timelineReads.push({
      status: "ok",
      events: [timelineEvent(2, "background_task.started", {
        task_id: "work-stop-1",
        tool_call_id: "call-stop-1",
        state: "running",
        work_summary: "stale running update"
      }, { id:"task_work-stop-1", type:"background_task", status:"running" })],
      nextCursor: "evt_test_2"
    });
    await setup.services.tasks.syncActiveTasksOnce();
    const latest = await setup.store.findLatestTaskInteractionChange(task.id, work.id);
    assert.equal(latest?.interaction.kind === "background_task" && latest.interaction.canStop, false);
    assert.equal((await setup.store.findTask(task.id))?.terminalReason, null);
  });

  it("terminalizes active interactions when their task is cancelled", async () => {
    const setup = await createSetup(true);
    const task = await startTask(setup, "cancel-running-command");
    setup.botified.timelineReads.push({
      status: "ok",
      events: [
        timelineEvent(1, "command_execution.started", {
          tool_call_id: "call-cancelled",
          command: "sleep 30",
          output_tail: "",
          exit_code: null,
          status: "in_progress"
        }, { id:"cmd_call-cancelled", type:"command_execution", status:"running" }),
        timelineEvent(2, "background_task.started", {
          task_id: "work-cancelled",
          tool_call_id: "call-background",
          state: "running",
          work_summary: "Wait in background"
        }, { id:"task_work-cancelled", type:"background_task", status:"running" }),
        timelineEvent(3, "task_ask.requested", {
          task_id: "work-question",
          ask_id: "ask-cancelled",
          question: "Continue?"
        }, { id:"ask_ask-cancelled", type:"task_ask", status:"waiting" })
      ],
      nextCursor: "evt_test_3",
      historyBoundary: "start"
    });
    await setup.services.tasks.syncActiveTasksOnce();
    const active = (await setup.services.tasks.taskInteractions(setup.userId, task.id)).items;
    assert.equal(active.find((item) => item.kind === "tool")?.executionStatus, "running");
    assert.equal(active.find((item) => item.kind === "background_task")?.executionStatus, "running");
    assert.equal(active.find((item) => item.kind === "task_question")?.status, "waiting");

    await setup.services.tasks.cancelTask(setup.userId, task.id, "cancel-running-command");

    const terminal = (await setup.services.tasks.taskInteractions(setup.userId, task.id)).items;
    const tool = terminal.find((item) => item.kind === "tool");
    assert.equal(tool?.kind, "tool");
    assert.equal(tool?.executionStatus, "cancelled");
    assert.equal(terminal.find((item) => item.kind === "background_task")?.executionStatus, "cancelled");
    assert.equal(terminal.find((item) => item.kind === "task_question")?.status, "expired");
  });

  it("serializes runtime ticks and interaction reads for the same task", async () => {
    const setup = await createSetup(true);
    const task = await startTask(setup, "concurrent-timeline-sync");
    setup.botified.timelineReadDelayMs = 10;
    setup.botified.timelineReads.push({
      status: "ok",
      events: [timelineEvent(1, "assistant_message.completed", { assistant_message_id:"assistant-concurrent", text:"serialized" }, { id:"assistant-concurrent", type:"assistant_message", status:"completed" })],
      nextCursor: "evt_test_1",
      historyBoundary: "start"
    });

    const [, interactions] = await Promise.all([
      setup.services.tasks.syncActiveTasksOnce(),
      setup.services.tasks.taskInteractions(setup.userId, task.id)
    ]);

    assert.equal(interactions.items.some((item) => item.kind === "assistant_message" && item.body === "serialized"), true);
    assert.equal((await setup.store.readTaskInteractionSnapshot(task.id, null, 10))?.sourceCursor, "evt_test_1");
  });

  it("terminalizes a genuine canonical cycle failure", async () => {
    const setup = await createSetup(true);
    const task = await startTask(setup, "provider-cycle-failure");
    setup.botified.timelineReads.push({
      status: "ok",
      events: [timelineEvent(1, "command_execution.started", {
        tool_call_id: "call-provider-failure",
        command: "long-running-command",
        status: "in_progress"
      }, { id:"cmd_call-provider-failure", type:"command_execution", status:"running" })],
      nextCursor: "evt_test_1",
      historyBoundary: "start"
    });
    await setup.services.tasks.syncActiveTasksOnce();
    setup.botified.timelineReads.push({
      status: "ok",
      events: [timelineEvent(2, "cycle.failed", {
        cycle_id: "cycle-1",
        input_ids: ["message-1"],
        queue_length: 0,
        error: { code: "provider_error", message: "provider request failed", retryable: false },
        retryable: false
      }, { id:"cycle-1", type:"cycle", status:"failed" })],
      nextCursor: "evt_test_2"
    });

    await setup.services.tasks.syncActiveTasksOnce();

    const failed = await setup.store.findTask(task.id);
    const interactions = await setup.services.tasks.taskInteractions(setup.userId, task.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.terminalReason, "failed");
    assert.equal(interactions.items.find((item) => item.kind === "tool")?.executionStatus, "failed");
    assert.equal(interactions.items.some((item) => item.kind === "system_error"), true);
  });

  it("emits a typed preview clear when Botified finishes, aborts, or errors without a durable assistant message", async () => {
    const setup = await createSetup(true);
    const task = await startTask(setup, "preview-clear");
    setup.botified.previewFrames.push(
      previewFrame({ type:"text_delta", delta:"Finished preview" }, "provider-finished"),
      previewFrame({ type:"finished", textEmitted:true, stopReason:"stop" }, "provider-finished"),
      previewFrame({ type:"text_delta", delta:"Aborted preview" }, "provider-aborted"),
      previewFrame({ type:"aborted", reason:"cancelled" }, "provider-aborted"),
      previewFrame({ type:"text_delta", delta:"Error preview" }, "provider-error"),
      previewFrame({ type:"error", code:"provider_error", retryable:false }, "provider-error")
    );

    const updates: TaskAssistantPreviewUpdate[] = [];
    for await (const update of setup.services.tasks.streamTaskAssistantPreviews(setup.userId, task.id)) updates.push(update);

    assert.deepEqual(updates.map((update) => update.type), ["upsert", "clear", "upsert", "clear", "upsert", "clear"]);
    assert.deepEqual([0,2,4].map((index) => [updates[index]?.interactionId, updates[index+1]?.interactionId]), [
      [updates[0]?.interactionId, updates[0]?.interactionId],
      [updates[2]?.interactionId, updates[2]?.interactionId],
      [updates[4]?.interactionId, updates[4]?.interactionId]
    ]);
    assert.deepEqual(updates.filter((update) => update.type === "upsert").map((update) => update.body), ["Finished preview", "Aborted preview", "Error preview"]);
    assert.equal((await setup.services.tasks.taskInteractions(setup.userId, task.id)).items.some((item) => item.kind === "assistant_message"), false);
  });

  it("owns interactive terminal occupancy and capabilities in the task service", async () => {
    const setup = await createSetup(true);
    const task = await startTask(setup, "terminal-occupancy");
    const run = await setup.store.sandboxRuns.get(task.runId); assert.ok(run);
    const staleIdleDeadline = "2000-01-01T00:00:00.000Z";
    await setup.store.sandboxRuns.updateWithFencing(run.runId, run.fencingToken, {
      ...run,
      idleExpiresAt: staleIdleDeadline,
      fencingToken: run.fencingToken + 1,
      updatedAt: staleIdleDeadline
    });
    assert.equal((await setup.services.tasks.taskInteractions(setup.userId, task.id)).capabilities.openTerminal, true);

    await setup.services.tasks.openTaskTerminal(setup.userId, task.id);

    assert.ok(Date.parse((await setup.store.sandboxRuns.get(task.runId))?.idleExpiresAt ?? staleIdleDeadline) > Date.now());
    assert.equal((await setup.services.tasks.taskInteractions(setup.userId, task.id)).capabilities.openTerminal, false);
    await assert.rejects(() => setup.services.tasks.openTaskTerminal(setup.userId, task.id), /already open/);
    setup.services.tasks.closeTaskTerminal(task.id);
    assert.equal((await setup.services.tasks.taskInteractions(setup.userId, task.id)).capabilities.openTerminal, true);
  });

  it("makes retained task history read-only when its workspace is archived", async () => {
    const setup = await createSetup(true);
    const task = await startTask(setup, "archived-workspace-capabilities");

    await setup.store.setWorkspaceLifecycleStatus(setup.workspaceId, "archived", new Date().toISOString());

    const snapshot = await setup.services.tasks.taskInteractions(setup.userId, task.id);
    assert.deepEqual(snapshot.capabilities, {
      sendMessage: false,
      editQueuedMessage: false,
      abortTurn: false,
      cancelTask: false,
      openTerminal: false,
      editTask: false,
      retryTask: false,
      duplicateTask: false,
      archiveTask: false,
      deleteTask: false
    });
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
    assert.equal(recovered?.startReceipt?.cursor, "cursor-1");
    assert.equal(recovered?.startTimelineCursor, null);
    assert.equal(setup.botified.posts.length, 1);
    await setup.store.jsonDocs.put("sandbox_runtime_state", task.id, { botifiedBaseUrl: "http://task.test" });
    setup.botified.timelineReads.push({ status:"ok", events:[timelineEvent(1,"input.accepted",{source:"user",input_id:recovered?.startReceipt?.messageId,text:"accept once"})], nextCursor:"evt_test_1", historyBoundary:"start" });
    await setup.services.tasks.syncActiveTasksOnce();
    assert.equal(setup.botified.timelineCursors.at(-1), undefined, "delivery receipt cursor must not become the ingestion cursor");
    const interactions = await setup.services.tasks.taskInteractions(setup.userId, task.id);
    assert.equal(interactions.items.filter((item) => item.kind === "user_message").length, 1);
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

  it("finishes cancelled cleanup after bounded uncertain start reconciliation", async () => {
    const setup = await createSetup(true);
    setup.botified.throwAfterAcceptOnce = true;
    const task = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "cancel uncertain start" }, "create-cancelled-uncertain");
    await setup.services.tasks.syncActiveTasksOnce();
    assert.equal((await setup.store.findTask(task.id))?.startIntentStatus, "dispatching");
    await setup.services.tasks.finalizeTaskForRunCleanup(task.id, "cancelled");
    setup.botified.queryError = new Error("delivery query remains unreachable");

    await setup.services.tasks.syncActiveTasksOnce();
    await setup.services.tasks.syncActiveTasksOnce();
    assert.equal((await setup.store.findTask(task.id))?.cleanupStatus, "pending");
    await setup.services.tasks.syncActiveTasksOnce();

    const settled = await setup.store.findTask(task.id);
    const interactions = await setup.services.tasks.taskInteractions(setup.userId, task.id);
    assert.equal(settled?.terminalReason, "cancelled");
    assert.equal(settled?.artifactProjectionStatus, "drained");
    assert.equal(settled?.cleanupStatus, "completed");
    assert.equal(settled?.artifactProjectionAttemptCount, 3);
    assert.equal(settled?.startIntentStatus, "failed");
    assert.equal(interactions.historyStatus, "gap");
    assert.equal(interactions.runState, "terminal");
    const initial = interactions.items.find((item) => item.kind === "user_message");
    assert.equal(initial?.kind, "user_message");
    assert.equal(initial?.status, "failed");
    assert.equal(setup.botified.posts.length, 1);
    assert.equal(setup.port.resources.length, 0);
  });

  it("finishes expired cleanup after bounded final timeline failures", async () => {
    const setup = await createSetup(true);
    const task = await startTask(setup, "expire-final-timeline");
    setup.botified.timelineReads.push({
      status: "ok",
      events: [timelineEvent(1, "assistant_message.completed", { assistant_message_id: "assistant-before-expiry", text: "saved before expiry" }, { id: "assistant-before-expiry", type: "assistant_message", status: "completed" })],
      nextCursor: "evt_test_1",
      historyBoundary: "start"
    });
    await setup.services.tasks.syncActiveTasksOnce();
    assert.equal((await setup.services.tasks.taskInteractions(setup.userId, task.id)).historyStatus, "complete");
    await setup.services.tasks.finalizeTaskForRunCleanup(task.id, "expired");
    setup.botified.timelineReads.push(
      new Error("final timeline unavailable"),
      new Error("final timeline unavailable"),
      new Error("final timeline unavailable")
    );

    await setup.services.tasks.syncActiveTasksOnce();
    await setup.services.tasks.syncActiveTasksOnce();
    assert.equal((await setup.store.findTask(task.id))?.cleanupStatus, "pending");
    await setup.services.tasks.syncActiveTasksOnce();

    const settled = await setup.store.findTask(task.id);
    const interactions = await setup.services.tasks.taskInteractions(setup.userId, task.id);
    assert.equal(settled?.artifactProjectionStatus, "drained");
    assert.equal(settled?.cleanupStatus, "completed");
    assert.equal(settled?.artifactProjectionAttemptCount, 3);
    assert.equal(interactions.historyStatus, "gap");
    assert.equal(interactions.runState, "terminal");
    assert.equal(setup.port.resources.length, 0);
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

  it("linearizes a terminal message race to accepted after remote acceptance", async () => {
    const setup = await createSetup(true);
    const source = await startTask(setup, "source-accepted");
    setup.botified.state = "idle";
    setup.botified.throwAfterAcceptOnce = true;
    const uncertain = await setup.services.tasks.sendTaskMessage(setup.userId, source.id, "continue accepted", "message-key");
    assert.equal(uncertain.disposition, "queued_for_active_run");
    const storedUncertain = await setup.store.findTaskMessage(uncertain.messageId);
    assert.equal(storedUncertain?.deliveryStatus, "dispatching");
    await setup.services.tasks.cancelTask(setup.userId, source.id, "cancel-key");
    assert.equal((await setup.store.findTaskMessage(uncertain.messageId))?.deliveryStatus, "terminal_pending");
    const pendingReplay = await setup.services.tasks.sendTaskMessage(setup.userId, source.id, "continue accepted", "message-key");
    assert.equal(pendingReplay.disposition, "successor_pending");
    assert.equal(pendingReplay.duplicate, true);
    await setup.store.deferTaskMessage({ id: uncertain.messageId, claimToken: storedUncertain!.claimToken!, safeError: "wait before reconcile", nextRetryAt: "2999-01-01T00:00:00.000Z", updatedAt: new Date().toISOString() });
    await setup.services.tasks.syncActiveTasksOnce();
    assert.equal((await setup.store.findTask(source.id))?.artifactProjectionStatus, "failed");
    assert.equal((await setup.store.findTask(source.id))?.cleanupStatus, "pending");
    assert.ok(setup.port.resources.length > 0);
    await setup.store.deferTaskMessage({ id: uncertain.messageId, claimToken: storedUncertain!.claimToken!, safeError: "retry now", nextRetryAt: "2000-01-01T00:00:00.000Z", updatedAt: new Date().toISOString() });
    await setup.services.tasks.syncActiveTasksOnce();
    const accepted = await setup.store.findTaskMessage(uncertain.messageId);
    assert.equal(accepted?.deliveryStatus, "accepted");
    assert.equal(accepted?.targetTaskId, null);
    const replay = await setup.services.tasks.sendTaskMessage(setup.userId, source.id, "continue accepted", "message-key");
    assert.equal(replay.disposition, "accepted_by_active_run");
    assert.equal(replay.duplicate, true);
    assert.equal(setup.botified.posts.filter((post) => post.text === "continue accepted").length, 1);
  });

  it("allows only pending messages to be edited and deleted", async () => {
    const setup = await createSetup(true);
    const source = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "source pending" }, "create-pending-source");
    const pending = await setup.services.tasks.sendTaskMessage(setup.userId, source.id, "first prompt", "pending-message");
    assert.equal(pending.queuedMessage?.deliveryStatus, "pending");
    const queuedReplay = await setup.services.tasks.sendTaskMessage(setup.userId, source.id, "first prompt", "pending-message");
    assert.equal(queuedReplay.disposition, "queued_for_active_run");
    assert.equal(queuedReplay.messageId, pending.messageId);
    assert.equal(queuedReplay.duplicate, true);
    const originalHash = (await setup.store.findTaskMessage(pending.messageId))?.requestHash;
    const edited = await setup.services.tasks.editTaskMessage(setup.userId, source.id, pending.messageId, "edited prompt", "edit-pending");
    assert.equal(edited.queuedMessage?.content, "edited prompt");
    assert.equal((await setup.services.tasks.editTaskMessage(setup.userId, source.id, pending.messageId, "edited prompt", "edit-pending")).duplicate, true);
    assert.notEqual((await setup.store.findTaskMessage(pending.messageId))?.requestHash, originalHash);
    const other = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "other pending" }, "create-other-pending");
    await assert.rejects(() => setup.services.tasks.editTaskMessage(setup.userId, other.id, pending.messageId, "wrong task", "edit-wrong-task"), /Task message not found/);
    const deleted = await setup.services.tasks.deleteTaskMessage(setup.userId, source.id, pending.messageId, "delete-pending");
    assert.equal(deleted.messageId, pending.messageId);
    assert.equal(deleted.queuedMessage, null);
    assert.equal((await setup.services.tasks.deleteTaskMessage(setup.userId, source.id, pending.messageId, "delete-pending")).duplicate, true);
    const interactions = await setup.services.tasks.taskInteractions(setup.userId, source.id);
    assert.deepEqual(interactions.queuedMessages, []);
    assert.equal(interactions.items.some((item) => item.body === "edited prompt"), false);
    assert.equal(interactions.items.some((item) => item.kind === "user_message" && item.body === ""), false);
    assert.equal(interactions.items.some((item) => item.kind === "user_message" && item.status === "rejected"), false);
    await assert.rejects(() => setup.services.tasks.editTaskMessage(setup.userId, source.id, pending.messageId, "too late", "edit-deleted"), /Only a pending message can be edited/);
  });

  it("paginates backward recovery and marks an expired history boundary as a gap", async () => {
    const setup = await createSetup(true);
    setup.botified.timelineReads.push(
      { status:"ok", events:[timelineEvent(3,"service.error",{code:"service_unavailable",message:"latest"})], nextCursor:"evt_test_3", pageStartCursor:"evt_test_3", pageEndCursor:"evt_test_3", hasMoreBefore:true, historyBoundary:"expired" },
      { status:"ok", events:[timelineEvent(1,"service.error",{code:"service_unavailable",message:"oldest available"})], nextCursor:"evt_test_1", pageStartCursor:"evt_test_1", pageEndCursor:"evt_test_1", hasMoreBefore:false, historyBoundary:"expired" }
    );
    const task = await startTask(setup, "history-gap");
    const snapshot = await setup.store.readTaskInteractionSnapshot(task.id, null, 20);
    assert.equal(snapshot?.historyStatus, "gap");
    assert.deepEqual(snapshot?.items.filter((item)=>item.kind==="system_error").map((item)=>item.body), ["oldest available","latest"]);
    assert.deepEqual(setup.botified.timelineCursors.slice(-2), [undefined,"evt_test_3"]);
  });

  it("applies a delayed lifecycle update to an interaction older than the latest 1000", async () => {
    const setup=await createSetup(true);
    const task=await startTask(setup,"delayed-interaction");
    const firstEvent=timelineEvent(1,"assistant_message.completed",{assistant_message_id:"assistant-old",text:"old"},{id:"assistant-old",type:"assistant_message",status:"completed"});
    const first=projectTaskInteraction({sourceKind:"botified",taskId:task.id,event:firstEvent},null,{knownSecrets:new Set()}).interaction!;
    const changes:TaskInteractionChangeInput[]=[{sourceKind:"botified",sourceId:"seed-old",sourceRevision:0,interaction:first}];
    for(let index=0;index<1001;index+=1)changes.push({sourceKind:"botified",sourceId:`filler-${index}`,sourceRevision:0,interaction:{...first,id:`filler-${index}`,position:first.position+index+1}});
    await setup.store.persistTaskInteractionMutation({taskId:task.id,changes});
    setup.botified.timelineReads.push({status:"ok",events:[timelineEvent(2,"assistant_message.completed",{assistant_message_id:"assistant-old",text:"updated"},{id:"assistant-old",type:"assistant_message",status:"completed"})],nextCursor:"evt_test_2",historyBoundary:"start"});

    await setup.services.tasks.syncActiveTasksOnce();

    const updated=await setup.store.findLatestTaskInteractionChange(task.id,first.id);
    assert.equal(updated?.interaction.revision,2);
    assert.equal(updated?.interaction.body,"updated");
  });

  it("keeps a task active across a detached callback and completes after the callback cycle", async () => {
    const setup = await createSetup(true);
    const task = await startTask(setup, "detached-callback-lifecycle");
    setup.botified.timelineReads.push({
      status:"ok",
      events:[
        timelineEvent(1,"background_task.started",{task_id:"work-1",tool_call_id:"tool-1"},{id:"task_work-1",type:"background_task",status:"running"}),
        timelineEvent(2,"assistant_message.completed",{assistant_message_id:"assistant-1",text:"background running"},{id:"assistant-1",type:"assistant_message",status:"completed"}),
        timelineEvent(3,"cycle.completed",{ok:true})
      ],
      nextCursor:"evt_test_3",
      historyBoundary:"start"
    });
    setup.botified.stateReads.push(botifiedRuntimeState("idle", { running:1 }, [
      { id:"task_work-1", type:"background_task", status:"running" }
    ]));

    await setup.services.tasks.syncActiveTasksOnce();

    const waiting = await setup.store.findTask(task.id);
    assert.equal(waiting?.status, "running");
    assert.equal(waiting?.terminalReason, null);
    assert.equal(waiting?.cleanupStatus, "pending");
    assert.ok(await setup.store.sandboxRuns.get(task.runId));

    setup.botified.timelineReads.push({
      status:"ok",
      events:[
        timelineEvent(4,"background_task.completed",{task_id:"work-1",tool_call_id:"tool-1",result_text:"BACKGROUND_FINISHED"},{id:"task_work-1",type:"background_task",status:"completed"}),
        timelineEvent(5,"background_task.callback_queued",{task_id:"work-1",tool_call_id:"tool-1",callback_id:"callback-1",callback_status:"queued",result_text:"BACKGROUND_FINISHED"},{id:"task_work-1",type:"background_task",status:"completed"}),
        timelineEvent(6,"input.queued",{input_id:"callback-1",source:"task_callback",text:"BACKGROUND_FINISHED"},{id:"input_callback-1",type:"input",status:"queued"}),
        timelineEvent(7,"cycle.started",{queue_length:0}),
        timelineEvent(8,"assistant_message.completed",{assistant_message_id:"assistant-2",text:"BACKGROUND_FINISHED"},{id:"assistant-2",type:"assistant_message",status:"completed"}),
        timelineEvent(9,"cycle.completed",{ok:true})
      ],
      nextCursor:"evt_test_9"
    });
    setup.botified.stateReads.push(botifiedRuntimeState("idle"));

    await setup.services.tasks.syncActiveTasksOnce();

    const completed = await setup.store.findTask(task.id);
    const interactions = await setup.services.tasks.taskInteractions(setup.userId, task.id);
    assert.equal(completed?.terminalReason, "completed");
    assert.equal(interactions.items.some((item) => item.kind === "assistant_message" && item.body === "BACKGROUND_FINISHED"), true);
  });

  it("completes an ordinary single cycle when the Botified session is quiescent", async () => {
    const setup = await createSetup(true);
    const task = await startTask(setup, "single-cycle-completion");
    setup.botified.timelineReads.push({ status:"ok", events:[timelineEvent(1,"cycle.completed",{ok:true})], nextCursor:"evt_test_1", historyBoundary:"start" });
    setup.botified.state = "idle";

    await setup.services.tasks.syncActiveTasksOnce();

    assert.equal((await setup.store.findTask(task.id))?.terminalReason, "completed");
  });

  it("waits for timeline catch-up when a quiescent state snapshot is ahead", async () => {
    const setup = await createSetup(true);
    const task = await startTask(setup, "state-cursor-fence");
    setup.botified.timelineReads.push({ status:"ok", events:[timelineEvent(1,"cycle.completed",{ok:true})], nextCursor:"evt_test_1", historyBoundary:"start" });
    setup.botified.stateReads.push({ ...botifiedRuntimeState("idle"), timelineCursor:"evt_test_3" });

    await setup.services.tasks.syncActiveTasksOnce();

    assert.equal((await setup.store.findTask(task.id))?.status, "running");
    setup.botified.timelineReads.push({
      status:"ok",
      events:[
        timelineEvent(2,"assistant_message.completed",{assistant_message_id:"assistant-late",text:"BACKGROUND_FINISHED"},{id:"assistant-late",type:"assistant_message",status:"completed"}),
        timelineEvent(3,"cycle.completed",{ok:true})
      ],
      nextCursor:"evt_test_3"
    });
    setup.botified.stateReads.push({ ...botifiedRuntimeState("idle"), timelineCursor:"evt_test_3" });

    await setup.services.tasks.syncActiveTasksOnce();

    const interactions = await setup.services.tasks.taskInteractions(setup.userId, task.id);
    assert.equal((await setup.store.findTask(task.id))?.terminalReason, "completed");
    assert.equal(interactions.items.some((item) => item.kind === "assistant_message" && item.body === "BACKGROUND_FINISHED"), true);
  });

  it("does not complete while an AgentSmith message is still queued", async () => {
    const setup = await createSetup(true);
    const task = await startTask(setup, "queued-message-completion");
    const queued = await setup.services.tasks.sendTaskMessage(setup.userId, task.id, "continue after this turn", "queued-before-completion");
    assert.equal(queued.queuedMessage?.deliveryStatus, "pending");
    setup.botified.timelineReads.push({ status:"ok", events:[timelineEvent(1,"cycle.completed",{ok:true})], nextCursor:"evt_test_1", historyBoundary:"start" });
    setup.botified.stateReads.push(botifiedRuntimeState("running"), botifiedRuntimeState("idle"));

    await setup.services.tasks.syncActiveTasksOnce();

    assert.equal((await setup.store.findTask(task.id))?.status, "running");
    assert.equal((await setup.store.findTask(task.id))?.terminalReason, null);
    assert.equal((await setup.store.findTaskMessage(queued.messageId))?.deliveryStatus, "pending");
  });

  it("creates one linked successor when a terminal pending delivery is explicitly absent", async () => {
    const setup = await createSetup(true);
    const source = await startTask(setup, "source-successor");
    setup.botified.state = "idle";
    setup.botified.throwBeforeAcceptOnce = true;
    const uncertain = await setup.services.tasks.sendTaskMessage(setup.userId, source.id, "continue as successor", "successor-key");
    assert.equal(uncertain.disposition, "queued_for_active_run");
    await setup.services.tasks.cancelTask(setup.userId, source.id, "cancel-successor");
    await setup.services.tasks.syncActiveTasksOnce();
    const resolved = await setup.store.findTaskMessage(uncertain.messageId);
    assert.equal(resolved?.deliveryStatus, "successor_created");
    assert.ok(resolved?.targetTaskId);
    assert.equal((await setup.store.findTask(resolved!.targetTaskId!))?.sourceTaskId, source.id);
    assert.equal(resolved?.receipt, null);
  });

  it("drains a late artifact before fenced cleanup completes", async () => {
    const setup = await createSetup(true);
    setup.botified.timelineReads.push(
      { status: "ok", events: [timelineEvent(1,"cycle.completed",{ok:true})], nextCursor: "evt_test_1", historyBoundary:"start" },
      { status: "ok", events: [timelineEvent(2,"file.published",{file_id:"late-file",filename:"late.txt",size_bytes:4},{id:"late-file",type:"file",status:"available"})], nextCursor: "evt_test_2" }
    );
    setup.botified.stateReads.push(botifiedRuntimeState("idle"));
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
      { status: "ok", events: [timelineEvent(1,"cycle.completed",{ok:true})], nextCursor: "evt_test_1", historyBoundary:"start" },
      { status: "ok", events: [], nextCursor: "done" }
    );
    setup.botified.state = "idle";

    await setup.services.tasks.syncActiveTasksOnce();

    const completed = await setup.store.findTask(task.id);
    const artifacts = await setup.services.tasks.listTaskArtifacts(setup.userId, task.id);
    assert.equal(completed?.artifactProjectionStatus, "drained");
    assert.deepEqual(artifacts.map((artifact) => [artifact.name, artifact.bytes]), [["result.txt", 14]]);
    assert.equal("fileId" in artifacts[0]!, false);
    await writeFile(artifactPath, "tampered after projection");
    assert.equal((await setup.services.tasks.downloadTaskArtifact(setup.userId, task.id, artifacts[0]!.id)).bytes.toString("utf8"), "sandbox result");
    assert.equal((await setup.services.tasks.downloadTaskInput(setup.userId, task.id, "files/input.txt")).bytes.toString("utf8"), "retained input");
    assert.equal((await setup.store.findProjectResourceUsage(setup.projectId))?.projectFileBytes, 14);

    const outside = path.join(setup.dataRoot, setup.projectRootPath, "api-private.txt");
    const legacyPath = path.join(path.dirname(artifactPath), "legacy-link.txt");
    await writeFile(outside, "must not be disclosed");
    await symlink(outside, legacyPath);
    await setup.store.appendTaskArtifacts([{ id:"artifact_legacy_symlink",taskId:task.id,fileId:"sandbox:legacy-link.txt",name:"legacy-link.txt",bytes:20,sha256:"unused",mediaType:"text/plain",previewText:null,createdAt:new Date().toISOString() }]);
    await assert.rejects(
      () => setup.services.tasks.downloadTaskArtifact(setup.userId, task.id, "artifact_legacy_symlink"),
      /symlink/
    );

    await setup.services.tasks.deleteTask(setup.userId, task.id, "delete-shared-artifact-task");
    assert.equal((await setup.store.findProjectResourceUsage(setup.projectId))?.projectFileBytes, 0);
    assert.deepEqual(await setup.store.listTaskArtifacts(task.id), []);
    await assert.rejects(() => readFile(path.join(setup.dataRoot, setup.projectRootPath, "tasks", task.id, "inputs", "manifest.json")), { code: "ENOENT" });
    assert.deepEqual((await setup.store.listProjectAuditEvents(setup.projectId)).filter((event) => event.action === "task.delete").map((event) => event.resourceId), [task.id]);
  });

  it("completes terminal drained cleanup when the pod is already absent and repeated ticks are idempotent", async () => {
    const setup = await createSetup(true);
    const task = await startTask(setup, "terminal-pod-absent");
    setup.botified.timelineReads.push(
      { status: "ok", events: [timelineEvent(1,"cycle.completed",{ok:true})], nextCursor: "evt_test_1", historyBoundary:"start" },
      { status: "ok", events: [], nextCursor: "done" },
      new Error("Botified is gone with the Pod")
    );
    setup.botified.state = "idle";
    setup.port.removePodBeforeNextInventory = true;

    const firstTick = await setup.services.tasks.syncActiveTasksOnce();
    const completed = await setup.store.findTask(task.id);
    const completedAt = completed?.cleanupCompletedAt;

    assert.deepEqual(firstTick.failedTaskIds, []);
    assert.equal((await setup.store.listActiveTasks()).length, 0);
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

  it("queries task list server-side and reads the authorized interaction snapshot", async () => {
    const setup = await createSetup(false);
    const alpha = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "alpha prompt", title: "Alpha" }, "alpha");
    const beta = await setup.services.tasks.createTask(setup.userId, setup.projectId, { endpointId: setup.endpointId, prompt: "beta prompt", title: "Beta" }, "beta");
    await setup.services.tasks.archiveTask(setup.userId, beta.id, "archive-beta");
    const page = await setup.services.tasks.listTasks(setup.userId, setup.projectId, { search: "alpha", statuses: ["completed"], archived: "exclude", sort: "title", direction: "asc", limit: 1 });
    assert.deepEqual(page.items.map((task) => task.id), [alpha.id]);
    assert.equal(page.total, 1);
    const interactions = await setup.services.tasks.taskInteractions(setup.userId, alpha.id, { limit: 10 });
    assert.deepEqual(interactions.items.map((item) => [item.kind, item.body]), [["user_message", "alpha prompt"]]);
    assert.equal(typeof interactions.streamCursor, "string");
    const stranger = await setup.services.auth.loginExternalPrincipal({ issuer: "https://idp.test", subject: "stranger", email: "stranger@example.test", emailVerified: true });
    await assert.rejects(() => setup.services.tasks.taskInteractions(stranger.user.id, alpha.id), /Project access denied/);
  });

  it("cleans a terminal live sandbox before deleting its project", async () => {
    const setup = await createSetup(true);
    const task = await startTask(setup, "delete-terminal-sandbox");
    await setup.services.tasks.cancelTask(setup.userId, task.id, "cancel-before-project-delete");

    const cancelled = await setup.store.findTask(task.id);
    assert.equal(cancelled?.terminalReason, "cancelled");
    assert.notEqual(cancelled?.cleanupStatus, "completed");
    assert.ok(setup.port.resources.length > 0);

    await setup.services.deletion.deleteProject(setup.userId, setup.projectId);

    assert.equal(await setup.store.findProject(setup.projectId), null);
    assert.equal(await setup.store.sandboxRuns.get(task.runId), null);
    assert.equal(setup.port.resources.length, 0);
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
  readonly previewFrames: BotifiedLlmTextPreviewFrame[] = [];
  readonly stateReads: BotifiedRuntimeStateResult[] = [];
  readonly stopCalls: string[] = [];
  timelineCursor: string | undefined;
  state = "running";
  abortCalls = 0;
  throwAfterAcceptOnce = false;
  throwBeforeAcceptOnce = false;
  queryError: Error | null = null;
  timelineReadDelayMs = 0;
  async health() { return { status: "ok" as const }; }
  async readState() {
    const result = this.stateReads.shift() ?? botifiedRuntimeState(this.state);
    return result.timelineCursor || !this.timelineCursor ? result : { ...result, timelineCursor:this.timelineCursor };
  }
  async postMessage(_baseUrl: string, _serviceKey: string, message: string): Promise<BotifiedPostMessageResult> { return { accepted: true, messageId: message, cursor: "cursor" }; }
  async postMessageWithDelivery(_baseUrl: string, _serviceKey: string, input: BotifiedDeliveryMessageInput): Promise<BotifiedDeliveryReceipt> {
    this.posts.push({ text: input.text, deliveryKey: input.deliveryKey, requestHash: input.requestHash });
    if (this.throwBeforeAcceptOnce) { this.throwBeforeAcceptOnce = false; throw new Error("post failed before acceptance"); }
    this.state = "running";
    const receipt: BotifiedDeliveryReceipt = { accepted: true, deliveryKey: input.deliveryKey, requestHash: input.requestHash, messageId: `message-${this.posts.length}`, cursor: `cursor-${this.posts.length}` };
    this.receipts.set(input.deliveryKey, receipt);
    if (this.throwAfterAcceptOnce) { this.throwAfterAcceptOnce = false; throw new Error("crash after remote acceptance"); }
    return receipt;
  }
  async queryDeliveryReceipt(_baseUrl: string, _serviceKey: string, deliveryKey: string) { if (this.queryError) throw this.queryError; return this.receipts.get(deliveryKey) ?? null; }
  async readTimeline(_baseUrl: string, _serviceKey: string, cursor?: string): Promise<BotifiedTimelineReadResult> {
    if (this.timelineReadDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.timelineReadDelayMs));
    this.timelineCursors.push(cursor);
    const next = this.timelineReads.shift();
    if (next instanceof Error) throw next;
    const result = next ?? { status:"ok" as const, events:[], ...(cursor ? { nextCursor:cursor } : {}) };
    if (result.nextCursor) this.timelineCursor = result.nextCursor;
    return result;
  }
  async uploadFile(_baseUrl: string, _serviceKey: string, _file: BotifiedUploadFileInput): Promise<BotifiedUploadFileResult> { return { files: [] }; }
  async downloadFile(_baseUrl: string, _serviceKey: string, fileId: string): Promise<BotifiedDownloadFileResult> { const bytes = this.downloads.get(fileId) ?? new Uint8Array(); return { bytes, sizeBytes: bytes.byteLength, filename: fileId }; }
  async abort(): Promise<BotifiedAbortResult> { this.abortCalls += 1; return { aborted: true }; }
  async stopBackgroundTask(_baseUrl: string, _serviceKey: string, taskId: string) { this.stopCalls.push(taskId); return { taskId, state:"cancelling" as const }; }
  async *streamLlmTextPreview(): AsyncIterable<BotifiedLlmTextPreviewFrame> { for (const frame of this.previewFrames) yield frame; }
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

function botifiedRuntimeState(
  state: string,
  tasks: Partial<Record<"running" | "cancelling" | "pending_callbacks" | "pending_asks", number>> = {},
  workItems: Array<{ id: string; type: string; status: string }> = []
): BotifiedRuntimeStateResult {
  const activeItems = [
    { id:"service", type:"service_status", status:state },
    { id:"queue", type:"queue_state", status:"ready" },
    ...(state === "running" ? [{ id:"cycle-current", type:"cycle", status:"running" }] : []),
    ...workItems
  ];
  const snapshot = {
    state,
    queue_length:0,
    tasks:{ running:0, cancelling:0, pending_callbacks:0, pending_asks:0, ...tasks },
    active_items:activeItems
  };
  return { snapshot, state, activeItems };
}

function timelineEvent(seq:number,type:string,data:Record<string,unknown>,item:null|{id:string;type:string;status:string}=null):BotifiedTimelineEvent{
  return{version:"botified.timeline.v1",seq,cursor:`evt_test_${seq}`,time:`2026-07-11T00:00:0${seq}.000Z`,session_id:"s1",type,trace:{cycle_id:"cycle-1"},item,data};
}

type PreviewFrameInput = BotifiedLlmTextPreviewFrame extends infer Frame
  ? Frame extends BotifiedLlmTextPreviewFrame
    ? Omit<Frame, "time" | "providerRequestId" | "providerCallIndex" | "inputIds">
    : never
  : never;

function previewFrame(frame: PreviewFrameInput, providerRequestId = "provider-request-1"): BotifiedLlmTextPreviewFrame {
  return { time:"2026-07-11T00:00:01.000Z", providerRequestId, providerCallIndex:0, inputIds:["input-1"], ...frame } as BotifiedLlmTextPreviewFrame;
}
