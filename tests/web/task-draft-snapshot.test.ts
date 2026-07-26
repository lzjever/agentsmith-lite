import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearTaskDraft,
  clearTaskDraftsForProject,
  clearTaskDraftsForUser,
  readTaskDraft,
  restoreTaskDraft,
  shouldClearTaskDraftForAccessStatus,
  TASK_DRAFT_STORAGE_NOTICE,
  taskDraftKey,
  writeTaskDraft
} from "../../src/components/tasks/task-draft-snapshot.ts";
import {
  restoreTaskCommandMetadata,
  writeTaskCommandMetadata
} from "../../src/components/tasks/task-command-storage.ts";

const identity = { userId: "user_1", projectId: "project_1", taskId: "task_1" };

describe("task draft snapshots", () => {
  it("scopes snapshots by schema, user, project, and task", () => {
    const storage = new MemoryStorage();
    assert.equal(writeTaskDraft(storage, identity, "恢复内容"), "saved");
    assert.equal(readTaskDraft(storage, identity), "恢复内容");
    assert.equal(readTaskDraft(storage, { ...identity, userId: "user_2" }), "");
    assert.match(taskDraftKey(identity), /v1.*user_1.*project_1.*task_1/);
  });

  it("enforces the 32768 UTF-8 byte ceiling without blocking later edits", () => {
    const storage = new MemoryStorage();
    assert.equal(writeTaskDraft(storage, identity, "previous"), "saved");
    assert.equal(writeTaskDraft(storage, identity, "a".repeat(32_768)), "saved");
    assert.equal(readTaskDraft(storage, identity), "a".repeat(32_768));
    assert.equal(writeTaskDraft(storage, identity, "a".repeat(32_769)), "too_large");
    assert.equal(readTaskDraft(storage, identity), "");
    assert.equal(writeTaskDraft(storage, identity, "smaller again"), "saved");
    assert.equal(readTaskDraft(storage, identity), "smaller again");
  });

  it("treats storage exceptions as non-blocking", () => {
    const storage = new ThrowingStorage();
    assert.equal(writeTaskDraft(storage, identity, "keep editing"), "unavailable");
    assert.equal(readTaskDraft(storage, identity), "");
    assert.doesNotThrow(() => clearTaskDraft(storage, identity));
    assert.doesNotThrow(() => clearTaskDraftsForUser(storage, "user_1"));
    assert.equal(writeTaskDraft(undefined, identity, "keep editing"), "unavailable");
    assert.equal(readTaskDraft(undefined, identity), "");
    assert.equal(TASK_DRAFT_STORAGE_NOTICE, "This draft could not be saved in this browser. You can keep editing and send it.");
  });

  it("uses the same notice for failures and leaves unread drafts recoverable", () => {
    const storage = new FailingStorage();
    storage.value = JSON.stringify({ schema: 1, ...identity, draft: "stale" });
    storage.failSet = true;
    assert.equal(writeTaskDraft(storage, identity, "new draft"), "unavailable");
    assert.equal(storage.value, null);
    storage.failSet = false;
    assert.equal(writeTaskDraft(storage, identity, "fallback"), "saved");
    assert.equal(readTaskDraft(storage, identity), "fallback");

    storage.failGet = true;
    const restored = restoreTaskDraft(storage, identity);
    assert.deepEqual(restored, { draft: "", status: "unavailable" });
    assert.notEqual(storage.value, null);
    storage.failGet = false;
    assert.deepEqual(restoreTaskDraft(storage, identity), {
      draft: "fallback",
      status: "restored"
    });
    assert.equal(writeTaskDraft(storage, identity, "restored later"), "saved");
    assert.deepEqual(restoreTaskDraft(storage, identity), {
      draft: "restored later",
      status: "restored"
    });
  });

  it("clears only the exact accepted draft and supports user-wide logout cleanup", () => {
    const storage = new MemoryStorage();
    const otherTask = { ...identity, taskId: "task_2" };
    const otherUser = { ...identity, userId: "user_2" };
    writeTaskDraft(storage, identity, "accepted");
    writeTaskDraft(storage, otherTask, "same user");
    writeTaskDraft(storage, otherUser, "other user");
    for (const commandIdentity of [identity, otherTask, otherUser]) {
      writeTaskCommandMetadata(storage, "task-message", {
        ...commandIdentity,
        key: `key-${commandIdentity.userId}-${commandIdentity.taskId}`,
        fingerprint: "fingerprint",
        createdAt: "2026-07-26T12:00:00.000Z"
      });
    }

    clearTaskDraft(storage, identity);
    assert.equal(readTaskDraft(storage, identity), "");
    assert.equal(
      restoreTaskCommandMetadata(storage, "task-message", identity),
      null
    );
    assert.equal(readTaskDraft(storage, otherTask), "same user");
    clearTaskDraftsForProject(storage, "user_1", "project_1");
    assert.equal(readTaskDraft(storage, otherTask), "");
    assert.equal(
      restoreTaskCommandMetadata(storage, "task-message", otherTask),
      null
    );
    writeTaskDraft(storage, otherTask, "same user again");
    clearTaskDraftsForUser(storage, "user_1");
    assert.equal(readTaskDraft(storage, otherTask), "");
    assert.equal(readTaskDraft(storage, otherUser), "other user");
    assert.notEqual(
      restoreTaskCommandMetadata(storage, "task-message", otherUser),
      null
    );
  });

  it("bulk cleanup keeps message metadata until draft removal is verified", () => {
    const storage = new FailingRemoveStorage();
    const metadata = {
      ...identity,
      key: "message-key",
      fingerprint: "message-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };
    writeTaskDraft(storage, identity, "Continue");
    writeTaskCommandMetadata(storage, "task-message", metadata);
    storage.failedKey = taskDraftKey(identity);

    clearTaskDraftsForProject(storage, identity.userId, identity.projectId);
    assert.equal(readTaskDraft(storage, identity), "Continue");
    assert.deepEqual(
      restoreTaskCommandMetadata(storage, "task-message", identity),
      metadata
    );

    storage.failedKey = null;
    clearTaskDraftsForProject(storage, identity.userId, identity.projectId);
    assert.equal(readTaskDraft(storage, identity), "");
    assert.equal(
      restoreTaskCommandMetadata(storage, "task-message", identity),
      null
    );
  });

  it("clears denied and missing Task drafts", () => {
    assert.equal(shouldClearTaskDraftForAccessStatus(403), true);
    assert.equal(shouldClearTaskDraftForAccessStatus(404), true);
    assert.equal(shouldClearTaskDraftForAccessStatus(500), false);
  });
});

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

class FailingRemoveStorage extends MemoryStorage {
  failedKey: string | null = null;
  override removeItem(key: string) {
    if (key === this.failedKey) throw new Error("remove blocked");
    super.removeItem(key);
  }
}

class ThrowingStorage implements Storage {
  get length(): number { throw new Error("blocked"); }
  clear(): void { throw new Error("blocked"); }
  getItem(): string | null { throw new Error("blocked"); }
  key(): string | null { throw new Error("blocked"); }
  removeItem(): void { throw new Error("blocked"); }
  setItem(): void { throw new Error("blocked"); }
}

class FailingStorage implements Storage {
  value: string | null = null;
  failGet = false;
  failSet = false;
  get length() { return this.value === null ? 0 : 1; }
  clear() { this.value = null; }
  getItem() { if (this.failGet) throw new Error("get blocked"); return this.value; }
  key(index: number) { return index === 0 && this.value !== null ? taskDraftKey(identity) : null; }
  removeItem() { this.value = null; }
  setItem(_key: string, value: string) { if (this.failSet) throw new Error("set blocked"); this.value = value; }
}
