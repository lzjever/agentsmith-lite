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
} from "../../src/components/tasks/task-draft-snapshot.js";

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

  it("uses the same notice for set/get failures, removes stale data, and recovers later", () => {
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
    assert.equal(storage.value, null);
    storage.failGet = false;
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

    clearTaskDraft(storage, identity);
    assert.equal(readTaskDraft(storage, identity), "");
    assert.equal(readTaskDraft(storage, otherTask), "same user");
    clearTaskDraftsForProject(storage, "user_1", "project_1");
    assert.equal(readTaskDraft(storage, otherTask), "");
    writeTaskDraft(storage, otherTask, "same user again");
    clearTaskDraftsForUser(storage, "user_1");
    assert.equal(readTaskDraft(storage, otherTask), "");
    assert.equal(readTaskDraft(storage, otherUser), "other user");
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
