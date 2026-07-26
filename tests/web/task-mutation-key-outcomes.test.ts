import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MutationPayloadLockedError,
  createMutationKeyStore
} from "../../src/lib/api/use-mutation-keys.ts";

describe("typed mutation key outcomes", () => {
  it("locks key and explicit fingerprint at send start", () => {
    const keys = createMutationKeyStore(() => "key-1");
    const attempt = keys.fingerprintKey("task-create", "project_1", "fingerprint-1");

    assert.equal(attempt.key, "key-1");
    assert.equal(attempt.fingerprint, "fingerprint-1");
    assert.deepEqual(
      keys.fingerprintKey("task-create", "project_1", "fingerprint-1"),
      attempt
    );
    assert.throws(
      () => keys.fingerprintKey("task-create", "project_1", "fingerprint-2"),
      MutationPayloadLockedError
    );
  });

  it("preserves legacy JSON.stringify request semantics and rotates changed requests", () => {
    const generated = ["key-1", "key-2", "key-3"];
    const keys = createMutationKeyStore(() => generated.shift()!);
    const legacy = keys.requestKey("legacy", "slot", "literal-string");

    assert.equal(legacy, "key-1");
    assert.equal(
      keys.requestKey("legacy", "slot", "literal-string"),
      legacy
    );
    assert.equal(
      keys.requestKey("legacy", "slot", "changed-string"),
      "key-2"
    );
    assert.equal(
      keys.requestKey("legacy", "slot", { content: "changed-string" }),
      "key-3"
    );
  });

  it("conditionally discards only the exact unsent fingerprint attempt", () => {
    const generated = ["key-1", "key-2"];
    const keys = createMutationKeyStore(() => generated.shift()!);
    const failed = keys.fingerprintKey("task-message", "task_1", "fingerprint-1");

    keys.discard("task-message", "task_1", failed);
    const next = keys.fingerprintKey("task-message", "task_1", "fingerprint-2");
    keys.discard("task-message", "task_1", failed);

    assert.equal(next.key, "key-2");
    assert.deepEqual(
      keys.fingerprintKey("task-message", "task_1", "fingerprint-2"),
      next
    );
  });

  it("retains mismatch and unknown commands using only explicit keyDisposition", () => {
    const keys = createMutationKeyStore(() => "key-1");
    const attempt = keys.fingerprintKey("task-message", "task_1", "fingerprint-1");

    keys.transition("task-message", "task_1", attempt, {
      outcome: "rejected_before_acceptance",
      keyDisposition: "retain"
    });
    assert.deepEqual(
      keys.fingerprintKey("task-message", "task_1", "fingerprint-1"),
      attempt
    );
    assert.throws(
      () => keys.fingerprintKey("task-message", "task_1", "fingerprint-2"),
      MutationPayloadLockedError
    );

    keys.transition("task-message", "task_1", attempt, {
      outcome: "outcome_unknown",
      keyDisposition: "retain"
    });
    assert.deepEqual(
      keys.fingerprintKey("task-message", "task_1", "fingerprint-1"),
      attempt
    );
  });

  it("keeps completed identity until canonical state is absorbed", () => {
    const generated = ["key-1", "key-2"];
    const keys = createMutationKeyStore(() => generated.shift()!);
    const attempt = keys.fingerprintKey("task-message", "task_1", "fingerprint-1");

    keys.transition("task-message", "task_1", attempt, {
      outcome: "completed",
      keyDisposition: "retire"
    });
    assert.throws(
      () => keys.fingerprintKey("task-message", "task_1", "fingerprint-2"),
      MutationPayloadLockedError
    );

    keys.canonicalAbsorbed("task-message", "task_1", attempt);
    assert.equal(
      keys.fingerprintKey("task-message", "task_1", "fingerprint-2").key,
      "key-2"
    );
  });

  it("does not let a late outcome for an old request clear a newer record", () => {
    const generated = ["key-1", "key-2"];
    const keys = createMutationKeyStore(() => generated.shift()!);
    const first = keys.fingerprintKey("task-create", "project_1", "fingerprint-1");

    keys.transition("task-create", "project_1", first, {
      outcome: "rejected_before_acceptance",
      keyDisposition: "retire"
    });
    const second = keys.fingerprintKey("task-create", "project_1", "fingerprint-2");

    keys.transition("task-create", "project_1", first, {
      outcome: "rejected_before_acceptance",
      keyDisposition: "retire"
    });
    keys.canonicalAbsorbed("task-create", "project_1", first);
    assert.deepEqual(
      keys.fingerprintKey("task-create", "project_1", "fingerprint-2"),
      second
    );
  });

  it("restores retained identity after remount and never rotates it because time passed", () => {
    const keys = createMutationKeyStore(() => "new-key");
    keys.restore("task-message", "task_1", {
      key: "restored-key",
      fingerprint: "message-fingerprint"
    });
    const before = keys.fingerprintKey("task-message", "task_1", "message-fingerprint");

    const originalNow = Date.now;
    Date.now = () => originalNow() + 365 * 24 * 60 * 60 * 1000;
    try {
      assert.deepEqual(
        keys.fingerprintKey("task-message", "task_1", "message-fingerprint"),
        before
      );
    } finally {
      Date.now = originalNow;
    }
  });
});
