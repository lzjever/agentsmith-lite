import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  TaskMessageClientOutcome,
  TaskMessageReceipt
} from "../../src/lib/api/client.js";
import {
  readTaskCommandMetadata,
  type TaskMessageCommandMetadata
} from "../../src/components/tasks/task-command-storage.js";
import {
  persistTaskMessageCommandAttempt,
  restoreTaskDraft,
  writeTaskDraft
} from "../../src/components/tasks/task-draft-snapshot.js";
import { replayRetainedTaskMessage } from "../../src/components/tasks/task-message-recovery.js";

describe("retained Task message recovery", () => {
  it("replays the original key once and clears only that user's old metadata pair", async () => {
    const storage = new MemoryStorage();
    const first = identity("user_1");
    const second = identity("user_2");
    const draft = "Repeat this exact request";
    const firstMetadata = metadata(first, "retained-key");
    const secondMetadata = metadata(second, "other-user-key");
    persist(storage, first, draft, firstMetadata);
    persist(storage, second, draft, secondMetadata);
    const calls: Array<{ taskId: string; content: string; key: string }> = [];

    const result = await replayRetainedTaskMessage({
      storage,
      identity: first,
      metadata: firstMetadata,
      draft,
      send: async (taskId, content, key) => {
        calls.push({ taskId, content, key });
        return completedReceipt();
      }
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(calls, [{
      taskId: first.taskId,
      content: draft,
      key: firstMetadata.key
    }]);
    assert.equal(restoreTaskDraft(storage, first).status, "empty");
    assert.equal(readTaskCommandMetadata(storage, "task-message", first).status, "missing");
    assert.equal(restoreTaskDraft(storage, second).draft, draft);
    assert.deepEqual(
      readTaskCommandMetadata(storage, "task-message", second),
      { status: "found", metadata: secondMetadata }
    );
  });

  it("keeps the draft and original key while the replay outcome remains unknown", async () => {
    const storage = new MemoryStorage();
    const owner = identity("user_1");
    const draft = "Keep the retained request";
    const retained = metadata(owner, "retained-key");
    persist(storage, owner, draft, retained);

    const result = await replayRetainedTaskMessage({
      storage,
      identity: owner,
      metadata: retained,
      draft,
      send: async () => ({
        outcome: "outcome_unknown",
        keyDisposition: "retain",
        error: new TypeError("response unavailable")
      })
    });

    assert.equal(result.status, "unresolved");
    assert.equal(restoreTaskDraft(storage, owner).draft, draft);
    assert.deepEqual(
      readTaskCommandMetadata(storage, "task-message", owner),
      { status: "found", metadata: retained }
    );
  });

  it("lets concurrent instances recover the same retained key after either one clears the pair", async () => {
    const storage = new MemoryStorage();
    const owner = identity("user_1");
    const draft = "Recover this once";
    const retained = metadata(owner, "shared-retained-key");
    persist(storage, owner, draft, retained);
    const calls: string[] = [];
    const recover = () => replayRetainedTaskMessage({
      storage,
      identity: owner,
      metadata: retained,
      draft,
      send: async (_taskId, _content, key) => {
        calls.push(key);
        return completedReceipt();
      }
    });

    const [first, second] = await Promise.all([recover(), recover()]);

    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    assert.deepEqual(calls, [retained.key, retained.key]);
    assert.equal(restoreTaskDraft(storage, owner).status, "empty");
    assert.equal(readTaskCommandMetadata(storage, "task-message", owner).status, "missing");
  });

  it("keeps a replacement attempt locked when a stale recovery completes", async () => {
    const storage = new MemoryStorage();
    const owner = identity("user_1");
    const staleDraft = "Original retained request";
    const stale = metadata(owner, "stale-key");
    persist(storage, owner, staleDraft, stale);
    const first = await replayRetainedTaskMessage({
      storage,
      identity: owner,
      metadata: stale,
      draft: staleDraft,
      send: async () => completedReceipt()
    });
    assert.equal(first.status, "completed");

    const replacementDraft = "Replacement request";
    const replacement = metadata(owner, "replacement-key");
    persist(storage, owner, replacementDraft, replacement);
    const staleInstance = await replayRetainedTaskMessage({
      storage,
      identity: owner,
      metadata: stale,
      draft: staleDraft,
      send: async () => completedReceipt()
    });

    assert.equal(staleInstance.status, "storage_unavailable");
    assert.equal(restoreTaskDraft(storage, owner).draft, replacementDraft);
    assert.deepEqual(
      readTaskCommandMetadata(storage, "task-message", owner),
      { status: "found", metadata: replacement }
    );
  });
});

function identity(userId: string) {
  return { userId, projectId: "project_1", taskId: "task_1" };
}

function metadata(
  owner: ReturnType<typeof identity>,
  key: string
): TaskMessageCommandMetadata {
  return {
    ...owner,
    key,
    fingerprint: `${key}-fingerprint`,
    createdAt: "2026-07-30T12:00:00.000Z"
  };
}

function persist(
  storage: Storage,
  owner: ReturnType<typeof identity>,
  draft: string,
  command: TaskMessageCommandMetadata
): void {
  assert.equal(writeTaskDraft(storage, owner, draft), "saved");
  persistTaskMessageCommandAttempt(storage, owner, draft, command);
}

function completedReceipt(): TaskMessageClientOutcome {
  const receipt: TaskMessageReceipt = {
    messageId: "message_recovered",
    disposition: "accepted_by_active_run",
    duplicate: true,
    queuedMessage: null,
    interaction: {
      id: "interaction_recovered",
      revision: 2,
      taskId: "task_1",
      kind: "user_message",
      title: "You",
      body: "Repeat this exact request",
      contentMode: "full",
      position: 10,
      occurredAt: "2026-07-30T12:00:01.000Z",
      updatedAt: "2026-07-30T12:00:02.000Z",
      status: "accepted"
    },
    presentation: {} as TaskMessageReceipt["presentation"]
  };
  return { outcome: "completed", keyDisposition: "retire", ...receipt };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
