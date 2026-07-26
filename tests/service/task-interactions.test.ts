import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { PersistedAgentTask, PersistedTaskMessage } from "../../packages/ports/src/store.js";

describe("Task interaction changes", () => {
  it("does not advance past a message accepted across the suppression and change read boundary", async () => {
    const setup = await createSetup("snapshot-race");
    const initial = await setup.services.tasks.taskInteractions(setup.userId, setup.task.id);
    const pending = await createPendingMessage(setup, "message_snapshot_race");

    const snapshotRead = setup.store.readTaskInteractionSnapshot.bind(setup.store);
    const changePageRead = setup.store.readTaskInteractionChangePage.bind(setup.store);
    let snapshotCaptured!: () => void;
    let resumeSnapshot!: () => void;
    const captured = new Promise<void>((resolve) => { snapshotCaptured = resolve; });
    const resume = new Promise<void>((resolve) => { resumeSnapshot = resolve; });
    setup.store.readTaskInteractionSnapshot = async (...args) => {
      const snapshot = await snapshotRead(...args);
      snapshotCaptured();
      await resume;
      return snapshot;
    };
    setup.store.readTaskInteractionChangePage = async (...args) => {
      snapshotCaptured();
      await resume;
      return changePageRead(...args);
    };

    const firstRead = setup.services.tasks.taskInteractionChanges(
      setup.userId,
      setup.task.id,
      initial.streamCursor
    );
    await captured;
    await acceptMessage(setup, pending);
    resumeSnapshot();

    const first = await firstRead;
    const second = await setup.services.tasks.taskInteractionChanges(
      setup.userId,
      setup.task.id,
      first.streamCursor
    );
    const acceptedRevisions = [...first.changes, ...second.changes]
      .filter(({ item }) => item.id === interactionId(pending.id) && item.revision === 2);

    assert.equal(acceptedRevisions.length, 1);
  });

  it("advances over suppressed raw changes while retaining queued message state", async () => {
    const setup = await createSetup("suppressed-cursor");
    const initial = await setup.services.tasks.taskInteractions(setup.userId, setup.task.id);
    const pending = await createPendingMessage(setup, "message_suppressed_cursor");

    const suppressed = await setup.services.tasks.taskInteractionChanges(
      setup.userId,
      setup.task.id,
      initial.streamCursor
    );
    assert.deepEqual(suppressed.changes, []);
    assert.deepEqual(suppressed.state.queuedMessages.map((message) => message.id), [pending.id]);
    assert.notEqual(suppressed.streamCursor, initial.streamCursor);

    const drained = await setup.services.tasks.taskInteractionChanges(
      setup.userId,
      setup.task.id,
      suppressed.streamCursor
    );
    assert.deepEqual(drained.changes, []);
    assert.equal(drained.streamCursor, suppressed.streamCursor);

    await acceptMessage(setup, pending);
    const accepted = await setup.services.tasks.taskInteractionChanges(
      setup.userId,
      setup.task.id,
      suppressed.streamCursor
    );
    assert.deepEqual(
      accepted.changes.map(({ item }) => [item.id, item.revision]),
      [[interactionId(pending.id), 2]]
    );
    assert.deepEqual(accepted.state.queuedMessages, []);
  });

  it("keeps bounded change pages ordered and isolated to their Task", async () => {
    const setup = await createSetup("bounded-order");
    const otherTask = await createTask(setup, "bounded-other");
    const initial = await setup.services.tasks.taskInteractions(setup.userId, setup.task.id);
    const otherInitial = await setup.services.tasks.taskInteractions(setup.userId, otherTask.id);
    await appendAssistantChange(setup, setup.task, "first", 1);
    await appendAssistantChange(setup, setup.task, "second", 2);
    await appendAssistantChange(setup, otherTask, "other", 1);
    await appendAssistantChange(setup, setup.task, "third", 3);

    const first = await setup.services.tasks.taskInteractionChanges(
      setup.userId,
      setup.task.id,
      initial.streamCursor,
      2
    );
    assert.deepEqual(first.changes.map(({ item }) => item.id), [
      "interaction_first",
      "interaction_second"
    ]);

    const second = await setup.services.tasks.taskInteractionChanges(
      setup.userId,
      setup.task.id,
      first.streamCursor,
      2
    );
    assert.deepEqual(second.changes.map(({ item }) => item.id), ["interaction_third"]);

    const other = await setup.services.tasks.taskInteractionChanges(
      setup.userId,
      otherTask.id,
      otherInitial.streamCursor,
      2
    );
    assert.deepEqual(other.changes.map(({ item }) => item.id), ["interaction_other"]);
  });
});

async function createSetup(label: string) {
  const store = createLocalInMemoryProductStore();
  const services = createApplicationServices({
    store,
    dataRoot: `/tmp/agentsmith-task-interactions-${label}`,
    builtinAdminPassword: "admin-password"
  });
  const session = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(session.user.id, { name: "Interactions" });
  const project = await services.workspaces.createProject(session.user.id, workspace.id, { name: label });
  const setup = { store, services, userId: session.user.id, workspaceId: workspace.id, projectId: project.id };
  const task = await createTask(setup, label);
  return { ...setup, task };
}

async function createTask(
  setup: {
    store: ReturnType<typeof createLocalInMemoryProductStore>;
    userId: string;
    workspaceId: string;
    projectId: string;
  },
  label: string
): Promise<PersistedAgentTask> {
  const timestamp = "2026-07-26T12:00:00.000Z";
  const task: PersistedAgentTask = {
    id: `task_${label}`,
    workspaceId: setup.workspaceId,
    projectId: setup.projectId,
    endpointId: `endpoint_${label}`,
    fileLibraryId: `library_${label}`,
    createdByUserId: setup.userId,
    title: "Interaction snapshot",
    prompt: "Test interaction changes",
    agentContext: "",
    currentRunId: null,
    archivedAt: null,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const created = await setup.store.createTaskAtomically({
    task,
    reserveActive: false,
    admission: { namespace: "agentsmith", namespaceLimit: 100 },
    newFileLibrary: {
      id: task.fileLibraryId!,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      name: `Library ${label}`,
      rootSubPath: `libraries/${task.fileLibraryId}/home`,
      lifecycleStatus: "active",
      createdByUserId: setup.userId,
      createdAt: timestamp,
      updatedAt: timestamp
    }
  });
  assert.equal(created.kind, "created");
  return task;
}

async function createPendingMessage(
  setup: Awaited<ReturnType<typeof createSetup>>,
  id: string
): Promise<PersistedTaskMessage> {
  const timestamp = "2026-07-26T12:00:01.000Z";
  const message: PersistedTaskMessage = {
    id,
    taskId: setup.task.id,
    actorId: setup.userId,
    content: "Snapshot-bound message",
    deliveryKey: `delivery_${id}`,
    requestHash: `request_${id}`,
    claimToken: null,
    receipt: null,
    timelineCursor: null,
    deliveryStatus: "pending",
    claimedAt: null,
    leaseExpiresAt: null,
    attemptCount: 0,
    nextRetryAt: null,
    safeError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null
  };
  const created = await setup.store.createPendingTaskMessage(message, {
    sourceKind: "product",
    sourceId: `message:${id}`,
    sourceRevision: 0,
    interaction: {
      id: interactionId(id),
      revision: 1,
      taskId: setup.task.id,
      kind: "user_message",
      title: "You",
      body: message.content,
      contentMode: "full",
      position: 0,
      occurredAt: timestamp,
      updatedAt: timestamp,
      actorId: setup.userId,
      status: "pending"
    }
  });
  assert.ok(created);
  return created;
}

async function acceptMessage(
  setup: Awaited<ReturnType<typeof createSetup>>,
  message: PersistedTaskMessage
): Promise<void> {
  const claimedAt = "2026-07-26T12:00:02.000Z";
  const claimToken = `claim_${message.id}`;
  const claimed = await setup.store.claimTaskMessage({
    id: message.id,
    claimToken,
    claimedAt,
    leaseExpiresAt: "2026-07-26T12:01:02.000Z"
  });
  assert.ok(claimed);
  const acceptedAt = "2026-07-26T12:00:03.000Z";
  const accepted = await setup.store.recordTaskMessageReceipt({
    id: message.id,
    claimToken,
    receipt: {
      accepted: true,
      deliveryKey: message.deliveryKey!,
      requestHash: message.requestHash!,
      messageId: message.id,
      cursor: "accepted-cursor"
    },
    timelineCursor: "accepted-cursor",
    updatedAt: acceptedAt
  });
  assert.ok(accepted);
  await setup.store.persistTaskInteractionMutation({
    taskId: message.taskId,
    changes: [{
      sourceKind: "product",
      sourceId: `message:${message.id}`,
      sourceRevision: 1,
      interaction: {
        id: interactionId(message.id),
        revision: 2,
        taskId: message.taskId,
        kind: "user_message",
        title: "You",
        body: message.content,
        contentMode: "full",
        position: 0,
        occurredAt: message.createdAt,
        updatedAt: acceptedAt,
        actorId: message.actorId ?? null,
        status: "accepted"
      }
    }]
  });
}

function interactionId(messageId: string): string {
  return `interaction_${messageId}`;
}

async function appendAssistantChange(
  setup: Awaited<ReturnType<typeof createSetup>>,
  task: PersistedAgentTask,
  sourceId: string,
  position: number
): Promise<void> {
  const timestamp = new Date(Date.parse("2026-07-26T12:01:00.000Z") + position * 1_000).toISOString();
  await setup.store.persistTaskInteractionMutation({
    taskId: task.id,
    changes: [{
      sourceKind: "botified",
      sourceId: `event_${sourceId}`,
      sourceRevision: 0,
      interaction: {
        id: `interaction_${sourceId}`,
        revision: 1,
        taskId: task.id,
        kind: "assistant_message",
        title: "Agent",
        body: sourceId,
        contentMode: "full",
        position,
        occurredAt: timestamp,
        updatedAt: timestamp,
        status: "completed"
      }
    }]
  });
}
