import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearTaskCreateCommandAttempt,
  clearTaskCreateCommandPair,
  clearTaskCommandMetadata,
  clearTaskCommandStorageForProject,
  clearTaskCommandStorageForUser,
  persistTaskCreateCommandAttempt,
  readTaskCommandMetadata,
  retireTaskCommandMetadata,
  restoreTaskCommandMetadata,
  taskRuntimeCommandRemountDecision,
  taskCommandRemountDecision,
  restoreTaskCreateDraft,
  taskCommandMetadataKey,
  taskCreateDraftKey,
  writeTaskCommandMetadata,
  updateTaskCommandAcceptedRun,
  writeTaskCreateDraft
} from "../../src/components/tasks/task-command-storage.ts";
import {
  clearTaskMessageCommandAttempt,
  persistTaskMessageCommandAttempt,
  readTaskDraft,
  taskDraftKey,
  writeTaskDraft
} from "../../src/components/tasks/task-draft-snapshot.ts";
import { createMutationKeyStore } from "../../src/lib/api/use-mutation-keys.ts";

const createIdentity = { userId: "user_1", projectId: "project_1" };
const messageIdentity = { ...createIdentity, taskId: "task_1" };

describe("Task command session storage", () => {
  it("restores exact runtime-control identities only on the same Task route",()=>{
    const storage=new MemoryStorage();
    const terminal={
      ...messageIdentity,key:"terminal-key",fingerprint:"terminal-fingerprint",
      createdAt:"2026-07-26T12:00:00.000Z",
      request:{expectedRunId:"run_a",expectedSandboxState:"released" as const},
      acceptedRunId:null
    };
    const release={
      ...messageIdentity,key:"release-key",fingerprint:"release-fingerprint",
      createdAt:"2026-07-26T12:01:00.000Z",
      request:{expectedRunId:"run_b"}
    };
    assert.equal(writeTaskCommandMetadata(storage,"task-terminal-start",terminal),"saved");
    assert.equal(writeTaskCommandMetadata(storage,"task-sandbox-release",release),"saved");
    assert.deepEqual(
      taskRuntimeCommandRemountDecision(readTaskCommandMetadata(storage,"task-terminal-start",messageIdentity)),
      {status:"restore",metadata:terminal}
    );
    assert.deepEqual(
      taskRuntimeCommandRemountDecision(readTaskCommandMetadata(storage,"task-sandbox-release",messageIdentity)),
      {status:"restore",metadata:release}
    );
    assert.equal(
      readTaskCommandMetadata(storage,"task-terminal-start",{...messageIdentity,taskId:"task_2"}).status,
      "missing"
    );
    assert.equal(updateTaskCommandAcceptedRun(
      storage,"task-terminal-start",messageIdentity,terminal,"run_c"
    ),true);
    assert.equal(
      restoreTaskCommandMetadata(storage,"task-terminal-start",messageIdentity)?.acceptedRunId,
      "run_c"
    );

    const remountedKeys=createMutationKeyStore(()=>"new-key");
    const restored=restoreTaskCommandMetadata(storage,"task-terminal-start",messageIdentity)!;
    remountedKeys.restore("task-terminal-start",messageIdentity.taskId,restored);
    assert.equal(
      remountedKeys.fingerprintKey("task-terminal-start",messageIdentity.taskId,terminal.fingerprint).key,
      terminal.key
    );
    assert.equal(
      retireTaskCommandMetadata(storage,"task-terminal-start",messageIdentity,terminal),
      true
    );
    assert.equal(readTaskCommandMetadata(storage,"task-terminal-start",messageIdentity).status,"missing");
  });

  it("unlocks canonical or superseded remounts while unresolved remounts replay the same key",()=>{
    const absorbedKeys=createMutationKeyStore((operation)=>`new-${operation}`);
    const absorbed={
      key:"restored-terminal-key",fingerprint:"terminal-old-fingerprint"
    };
    absorbedKeys.restore("task-terminal-start",messageIdentity.taskId,absorbed);
    absorbedKeys.canonicalAbsorbed("task-terminal-start",messageIdentity.taskId,absorbed);
    assert.deepEqual(
      absorbedKeys.fingerprintKey("task-terminal-start",messageIdentity.taskId,"terminal-new-fingerprint"),
      {key:"new-task-terminal-start",fingerprint:"terminal-new-fingerprint"}
    );

    const supersededKeys=createMutationKeyStore((operation)=>`new-${operation}`);
    const superseded={
      key:"restored-release-key",fingerprint:"release-old-fingerprint"
    };
    supersededKeys.restore("task-sandbox-release",messageIdentity.taskId,superseded);
    supersededKeys.canonicalAbsorbed("task-sandbox-release",messageIdentity.taskId,superseded);
    assert.deepEqual(
      supersededKeys.fingerprintKey("task-sandbox-release",messageIdentity.taskId,"release-new-fingerprint"),
      {key:"new-task-sandbox-release",fingerprint:"release-new-fingerprint"}
    );

    const unresolvedKeys=createMutationKeyStore(()=>"must-not-rotate");
    unresolvedKeys.restore("task-terminal-start",messageIdentity.taskId,absorbed);
    assert.deepEqual(
      unresolvedKeys.fingerprintKey("task-terminal-start",messageIdentity.taskId,absorbed.fingerprint),
      absorbed
    );
    assert.throws(
      ()=>unresolvedKeys.fingerprintKey("task-terminal-start",messageIdentity.taskId,"terminal-new-fingerprint")
    );
  });

  it("retires a remounted Terminal key after a background failure replay with no presentation",()=>{
    let sequence=0;
    const storage=new MemoryStorage();
    const request={expectedRunId:"run_a",expectedSandboxState:"released" as const};
    const metadata={
      ...messageIdentity,key:"terminal-unresolved",fingerprint:JSON.stringify(request),
      createdAt:"2026-07-26T12:00:00.000Z",request,acceptedRunId:null
    };
    writeTaskCommandMetadata(storage,"task-terminal-start",metadata);

    const firstMount=createMutationKeyStore(()=>`new-key-${++sequence}`);
    firstMount.restore("task-terminal-start",messageIdentity.taskId,metadata);
    firstMount.transition("task-terminal-start",messageIdentity.taskId,metadata,{
      outcome:"outcome_unknown",keyDisposition:"retain"
    });
    assert.deepEqual(
      firstMount.fingerprintKey("task-terminal-start",messageIdentity.taskId,metadata.fingerprint),
      {key:metadata.key,fingerprint:metadata.fingerprint}
    );
    assert.equal(
      restoreTaskCommandMetadata(storage,"task-terminal-start",messageIdentity)?.acceptedRunId,
      null
    );

    const remounted=restoreTaskCommandMetadata(storage,"task-terminal-start",messageIdentity)!;
    const secondMount=createMutationKeyStore(()=>`new-key-${++sequence}`);
    secondMount.restore("task-terminal-start",messageIdentity.taskId,remounted);
    const replayedTerminalOutcome={
      outcome:"completed" as const,keyDisposition:"retire" as const,runId:"run_b",
      error:{
        code:"sandbox_start_failed",message:"Sandbox could not be started",
        retryable:true as const,details:null,presentation:null
      }
    };
    assert.equal(
      secondMount.fingerprintKey("task-terminal-start",messageIdentity.taskId,metadata.fingerprint).key,
      metadata.key
    );
    secondMount.transition("task-terminal-start",messageIdentity.taskId,metadata,replayedTerminalOutcome);
    assert.equal(
      retireTaskCommandMetadata(storage,"task-terminal-start",messageIdentity,metadata),
      true
    );
    secondMount.canonicalAbsorbed("task-terminal-start",messageIdentity.taskId,metadata);

    assert.equal(readTaskCommandMetadata(storage,"task-terminal-start",messageIdentity).status,"missing");
    assert.deepEqual(
      secondMount.fingerprintKey("task-terminal-start",messageIdentity.taskId,"new-terminal-fingerprint"),
      {key:"new-key-1",fingerprint:"new-terminal-fingerprint"}
    );
  });

  it("restores a matching Task create draft and key after remount without duplicating the prompt", () => {
    const storage = new MemoryStorage();
    const draft = {
      title: "Release",
      prompt: "Prepare the release notes",
      endpointId: "endpoint_1",
      fileLibrary: { mode: "create_new" as const, name: "Release files" }
    };
    const metadata = {
      ...createIdentity,
      key: "task-create-key",
      fingerprint: "create-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };

    assert.equal(writeTaskCreateDraft(storage, createIdentity, draft), "saved");
    assert.equal(writeTaskCommandMetadata(storage, "task-create", metadata), "saved");

    const restoredDraft = restoreTaskCreateDraft(storage, createIdentity);
    const restoredMetadata = restoreTaskCommandMetadata(storage, "task-create", createIdentity);
    assert.deepEqual(restoredDraft, draft);
    assert.deepEqual(restoredMetadata, metadata);

    const remountedKeys = createMutationKeyStore(() => "new-key");
    remountedKeys.restore("task-create", createIdentity.projectId, restoredMetadata!);
    assert.equal(
      remountedKeys.fingerprintKey("task-create", createIdentity.projectId, metadata.fingerprint).key,
      metadata.key
    );

    const savedDraft = storage.getItem(taskCreateDraftKey(createIdentity)) ?? "";
    const savedMetadata = storage.getItem(taskCommandMetadataKey("task-create", createIdentity)) ?? "";
    assert.equal((savedDraft + savedMetadata).split(draft.prompt).length - 1, 1);
    assert.equal(savedMetadata.includes("prompt"), false);
    assert.equal(savedMetadata.includes(draft.prompt), false);
  });

  it("treats create and message metadata read failures as locked and recoverable", () => {
    const createStorage = new FailingFirstGetStorage();
    const createDraft = {
      title: "Release",
      prompt: "Prepare the release notes",
      endpointId: "endpoint_1",
      fileLibrary: { mode: "create_new" as const, name: "Release files" }
    };
    const createMetadata = {
      ...createIdentity,
      key: "task-create-key",
      fingerprint: "create-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };
    writeTaskCreateDraft(createStorage, createIdentity, createDraft);
    writeTaskCommandMetadata(createStorage, "task-create", createMetadata);
    const createMetadataKey = taskCommandMetadataKey(
      "task-create",
      createIdentity
    );
    createStorage.failNextGet(createMetadataKey);

    const failedCreateRead = readTaskCommandMetadata(
      createStorage,
      "task-create",
      createIdentity
    );
    assert.deepEqual(failedCreateRead, { status: "unavailable" });
    assert.deepEqual(
      taskCommandRemountDecision(failedCreateRead, "found"),
      { status: "locked_unavailable" }
    );
    assert.equal(createStorage.removedKeys.length, 0);
    assert.notEqual(createStorage.getItem(createMetadataKey), null);
    assert.notEqual(
      createStorage.getItem(taskCreateDraftKey(createIdentity)),
      null
    );
    assert.deepEqual(
      readTaskCommandMetadata(createStorage, "task-create", createIdentity),
      { status: "found", metadata: createMetadata }
    );

    const messageStorage = new FailingFirstGetStorage();
    const messageMetadata = {
      ...messageIdentity,
      key: "task-message-key",
      fingerprint: "message-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };
    writeTaskDraft(messageStorage, messageIdentity, "Continue");
    writeTaskCommandMetadata(messageStorage, "task-message", messageMetadata);
    const messageMetadataKey = taskCommandMetadataKey(
      "task-message",
      messageIdentity
    );
    messageStorage.failNextGet(messageMetadataKey);

    const failedMessageRead = readTaskCommandMetadata(
      messageStorage,
      "task-message",
      messageIdentity
    );
    assert.deepEqual(failedMessageRead, { status: "unavailable" });
    assert.deepEqual(
      taskCommandRemountDecision(failedMessageRead, "found"),
      { status: "locked_unavailable" }
    );
    assert.equal(messageStorage.removedKeys.length, 0);
    assert.notEqual(messageStorage.getItem(messageMetadataKey), null);
    assert.notEqual(messageStorage.getItem(taskDraftKey(messageIdentity)), null);
    assert.deepEqual(
      readTaskCommandMetadata(messageStorage, "task-message", messageIdentity),
      { status: "found", metadata: messageMetadata }
    );
  });

  it("keeps Task message prompt only in the normal user/project/task draft", () => {
    const storage = new MemoryStorage();
    const prompt = "Continue with the release";
    const metadata = {
      ...messageIdentity,
      key: "task-message-key",
      fingerprint: "message-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };

    assert.equal(writeTaskDraft(storage, messageIdentity, prompt), "saved");
    assert.equal(writeTaskCommandMetadata(storage, "task-message", metadata), "saved");
    assert.equal(readTaskDraft(storage, messageIdentity), prompt);
    assert.deepEqual(
      restoreTaskCommandMetadata(storage, "task-message", messageIdentity),
      metadata
    );

    const savedDraft = storage.getItem(taskDraftKey(messageIdentity)) ?? "";
    const savedMetadata = storage.getItem(taskCommandMetadataKey("task-message", messageIdentity)) ?? "";
    assert.equal((savedDraft + savedMetadata).split(prompt).length - 1, 1);
    assert.equal(savedMetadata.includes("content"), false);
    assert.equal(savedMetadata.includes(prompt), false);
  });

  it("isolates create and message records by user, project, and task", () => {
    const storage = new MemoryStorage();
    const createDraft = {
      title: "",
      prompt: "User one",
      endpointId: "endpoint_1",
      fileLibrary: { mode: "create_new" as const, name: "Task File Library" }
    };
    const createMetadata = {
      ...createIdentity,
      key: "create-key",
      fingerprint: "create-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };
    const messageMetadata = {
      ...messageIdentity,
      key: "message-key",
      fingerprint: "message-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };

    writeTaskCreateDraft(storage, createIdentity, createDraft);
    writeTaskCommandMetadata(storage, "task-create", createMetadata);
    writeTaskCommandMetadata(storage, "task-message", messageMetadata);

    assert.deepEqual(
      restoreTaskCommandMetadata(storage, "task-message", messageIdentity),
      messageMetadata
    );
    assert.equal(restoreTaskCreateDraft(storage, { ...createIdentity, userId: "user_2" }), null);
    assert.equal(restoreTaskCreateDraft(storage, { ...createIdentity, projectId: "project_2" }), null);
    assert.equal(
      restoreTaskCommandMetadata(storage, "task-message", { ...messageIdentity, taskId: "task_2" }),
      null
    );
    assert.equal(
      restoreTaskCommandMetadata(storage, "task-message", { ...messageIdentity, projectId: "project_2" }),
      null
    );
  });

  it("cleans corrupt pairs without replacing retained ownership", () => {
    const storage = new MemoryStorage();
    const draftKey = taskCreateDraftKey(createIdentity);
    const metadataKey = taskCommandMetadataKey("task-create", createIdentity);

    storage.setItem(draftKey, "{");
    assert.equal(restoreTaskCreateDraft(storage, createIdentity), null);
    assert.equal(storage.getItem(draftKey), null);

    writeTaskCreateDraft(storage, createIdentity, {
      title: "",
      prompt: "unresolved",
      endpointId: "endpoint_1",
      fileLibrary: { mode: "create_new", name: "Task File Library" }
    });
    storage.setItem(metadataKey, JSON.stringify({ ...createIdentity, key: "missing fields" }));
    const corruptMetadata = readTaskCommandMetadata(
      storage,
      "task-create",
      createIdentity
    );
    assert.deepEqual(corruptMetadata, { status: "corrupt" });
    assert.deepEqual(
      taskCommandRemountDecision(corruptMetadata, "found"),
      { status: "cleanup" }
    );
    assert.equal(restoreTaskCommandMetadata(storage, "task-create", createIdentity), null);
    assert.notEqual(storage.getItem(draftKey), null);
    assert.notEqual(storage.getItem(metadataKey), null);
    assert.equal(clearTaskCreateCommandPair(storage, createIdentity), true);
    assert.equal(storage.getItem(draftKey), null);
    assert.equal(storage.getItem(metadataKey), null);

    writeTaskCreateDraft(storage, createIdentity, {
      title: "",
      prompt: "stale",
      endpointId: "endpoint_1",
      fileLibrary: { mode: "create_new", name: "Task File Library" }
    });
    writeTaskCommandMetadata(storage, "task-create", {
      ...createIdentity,
      key: "stale-key",
      fingerprint: "stale-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    });
    assert.equal(writeTaskCreateDraft(storage, createIdentity, {
      title: "",
      prompt: "x".repeat(32_769),
      endpointId: "endpoint_1",
      fileLibrary: { mode: "create_new", name: "Task File Library" }
    }), "too_large");
    assert.equal(restoreTaskCreateDraft(storage, createIdentity)?.prompt, "stale");
    assert.equal(
      restoreTaskCommandMetadata(storage, "task-create", createIdentity)?.key,
      "stale-key"
    );
  });

  it("does not disturb stale ownership when a replacement write fails", () => {
    const storage = new FailingSetStorage();
    storage.values.set(taskCreateDraftKey(createIdentity), "stale draft");
    storage.values.set(taskCommandMetadataKey("task-create", createIdentity), "stale metadata");
    storage.failSet = true;

    assert.equal(writeTaskCreateDraft(storage, createIdentity, {
      title: "",
      prompt: "new draft",
      endpointId: "endpoint_1",
      fileLibrary: { mode: "create_new", name: "Task File Library" }
    }), "unavailable");
    assert.equal(writeTaskCommandMetadata(storage, "task-create", {
      ...createIdentity,
      key: "new-key",
      fingerprint: "new-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    }), "unavailable");
    assert.equal(storage.getItem(taskCreateDraftKey(createIdentity)), "stale draft");
    assert.equal(
      storage.getItem(taskCommandMetadataKey("task-create", createIdentity)),
      "stale metadata"
    );
  });

  it("does not dispatch create or message when exact attempt storage cannot be verified", async () => {
    const createStorage = new FailingSetStorage();
    const createDraft = {
      title: "Release",
      prompt: "Prepare the release",
      endpointId: "endpoint_1",
      fileLibrary: { mode: "create_new" as const, name: "Release files" }
    };
    writeTaskCreateDraft(createStorage, createIdentity, createDraft);
    createStorage.values.set(
      taskCommandMetadataKey("task-create", createIdentity),
      "stale create metadata"
    );
    createStorage.failSet = true;

    const messageStorage = new DroppingSetStorage();
    writeTaskDraft(messageStorage, messageIdentity, "Continue");
    messageStorage.values.set(
      taskCommandMetadataKey("task-message", messageIdentity),
      "stale message metadata"
    );
    messageStorage.dropSet = true;

    let fetchCalls = 0;
    await assert.rejects(async () => {
      persistTaskCreateCommandAttempt(createStorage, createDraft, {
        ...createIdentity,
        key: "create-key",
        fingerprint: "create-fingerprint",
        createdAt: "2026-07-26T12:00:00.000Z"
      });
      fetchCalls += 1;
    }, { name: "TaskCommandStorageUnavailableError" });
    await assert.rejects(async () => {
      persistTaskMessageCommandAttempt(messageStorage, messageIdentity, "Continue", {
        ...messageIdentity,
        key: "message-key",
        fingerprint: "message-fingerprint",
        createdAt: "2026-07-26T12:00:00.000Z"
      });
      fetchCalls += 1;
    }, { name: "TaskCommandStorageUnavailableError" });

    assert.equal(fetchCalls, 0);
    assert.deepEqual(restoreTaskCreateDraft(createStorage, createIdentity), createDraft);
    assert.equal(readTaskDraft(messageStorage, messageIdentity), "Continue");
    assert.equal(
      createStorage.getItem(taskCommandMetadataKey("task-create", createIdentity)),
      "stale create metadata"
    );
    assert.equal(
      messageStorage.getItem(taskCommandMetadataKey("task-message", messageIdentity)),
      "stale message metadata"
    );
  });

  it("keeps an existing create or message key authoritative when retry writes fail", () => {
    const createStorage = new FailingSetStorage();
    const createDraft = {
      title: "Release",
      prompt: "Prepare the release",
      endpointId: "endpoint_1",
      fileLibrary: { mode: "create_new" as const, name: "Release files" }
    };
    const createMetadata = {
      ...createIdentity,
      key: "create-key",
      fingerprint: "create-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };
    writeTaskCreateDraft(createStorage, createIdentity, createDraft);
    writeTaskCommandMetadata(createStorage, "task-create", createMetadata);
    createStorage.failSet = true;

    assert.equal(
      writeTaskCommandMetadata(createStorage, "task-create", createMetadata),
      "unavailable"
    );
    assert.deepEqual(
      readTaskCommandMetadata(createStorage, "task-create", createIdentity),
      { status: "found", metadata: createMetadata }
    );
    assert.doesNotThrow(() => {
      persistTaskCreateCommandAttempt(
        createStorage,
        createDraft,
        createMetadata
      );
    });
    const createKeys = createMutationKeyStore(() => "create-key-2");
    createKeys.restore("task-create", createIdentity.projectId, createMetadata);
    assert.equal(
      createKeys.fingerprintKey(
        "task-create",
        createIdentity.projectId,
        createMetadata.fingerprint
      ).key,
      createMetadata.key
    );

    const messageStorage = new FailingSetStorage();
    const messageMetadata = {
      ...messageIdentity,
      key: "message-key",
      fingerprint: "message-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };
    writeTaskDraft(messageStorage, messageIdentity, "Continue");
    writeTaskCommandMetadata(messageStorage, "task-message", messageMetadata);
    messageStorage.failSet = true;

    assert.equal(
      writeTaskCommandMetadata(messageStorage, "task-message", messageMetadata),
      "unavailable"
    );
    assert.deepEqual(
      readTaskCommandMetadata(messageStorage, "task-message", messageIdentity),
      { status: "found", metadata: messageMetadata }
    );
    assert.doesNotThrow(() => {
      persistTaskMessageCommandAttempt(
        messageStorage,
        messageIdentity,
        "Continue",
        messageMetadata
      );
    });
    const messageKeys = createMutationKeyStore(() => "message-key-2");
    messageKeys.restore("task-message", messageIdentity.taskId, messageMetadata);
    assert.equal(
      messageKeys.fingerprintKey(
        "task-message",
        messageIdentity.taskId,
        messageMetadata.fingerprint
      ).key,
      messageMetadata.key
    );
  });

  it("reuses the retained create pair when the dialog retries an unchanged draft", () => {
    const storage = new FailingSetStorage();
    const draft = {
      title: "Release",
      prompt: "Prepare the release",
      endpointId: "endpoint_1",
      fileLibrary: { mode: "create_new" as const, name: "Release files" }
    };
    const metadata = {
      ...createIdentity,
      key: "create-key",
      fingerprint: "create-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };
    writeTaskCreateDraft(storage, createIdentity, draft);
    writeTaskCommandMetadata(storage, "task-create", metadata);
    const keys = createMutationKeyStore(() => "create-key-2");
    keys.restore("task-create", createIdentity.projectId, metadata);
    storage.failSet = true;

    assert.equal(
      writeTaskCreateDraft(storage, createIdentity, draft),
      "saved"
    );
    assert.doesNotThrow(() => {
      persistTaskCreateCommandAttempt(storage, draft, metadata);
    });
    assert.deepEqual(restoreTaskCreateDraft(storage, createIdentity), draft);
    assert.deepEqual(
      restoreTaskCommandMetadata(storage, "task-create", createIdentity),
      metadata
    );
    assert.equal(
      keys.fingerprintKey(
        "task-create",
        createIdentity.projectId,
        metadata.fingerprint
      ).key,
      metadata.key
    );
  });

  it("clears only the exact create attempt after its draft removal is verified", () => {
    let keySequence = 0;
    const storage = new FailingDraftRemoveStorage();
    const draft = {
      title: "Release",
      prompt: "Prepare the release",
      endpointId: "endpoint_1",
      fileLibrary: { mode: "create_new" as const, name: "Release files" }
    };
    const metadata = {
      ...createIdentity,
      key: "create-key",
      fingerprint: "create-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };
    writeTaskCreateDraft(storage, createIdentity, draft);
    writeTaskCommandMetadata(storage, "task-create", metadata);

    const keys = createMutationKeyStore(() => `new-key-${++keySequence}`);
    keys.restore("task-create", createIdentity.projectId, metadata);
    keys.transition("task-create", createIdentity.projectId, metadata, {
      outcome: "completed",
      keyDisposition: "retire"
    });

    assert.equal(
      clearTaskCreateCommandAttempt(
        storage,
        createIdentity,
        { key: "stale-key", fingerprint: metadata.fingerprint },
        draft
      ),
      false
    );
    assert.equal(
      clearTaskCreateCommandAttempt(
        storage,
        createIdentity,
        metadata,
        { ...draft, prompt: "Changed draft" }
      ),
      false
    );
    assert.deepEqual(restoreTaskCreateDraft(storage, createIdentity), draft);
    assert.deepEqual(
      restoreTaskCommandMetadata(storage, "task-create", createIdentity),
      metadata
    );

    storage.failedKey = taskCreateDraftKey(createIdentity);
    const removed = clearTaskCreateCommandAttempt(
      storage,
      createIdentity,
      metadata,
      draft
    );
    if (removed) {
      keys.canonicalAbsorbed("task-create", createIdentity.projectId, metadata);
    }
    assert.equal(removed, false);
    assert.deepEqual(restoreTaskCreateDraft(storage, createIdentity), draft);
    assert.deepEqual(
      restoreTaskCommandMetadata(storage, "task-create", createIdentity),
      metadata
    );
    assert.equal(
      keys.fingerprintKey(
        "task-create",
        createIdentity.projectId,
        metadata.fingerprint
      ).key,
      metadata.key
    );

    storage.failedKey = null;
    assert.equal(
      clearTaskCreateCommandAttempt(
        storage,
        createIdentity,
        metadata,
        draft
      ),
      true
    );
    keys.canonicalAbsorbed("task-create", createIdentity.projectId, metadata);
    assert.equal(restoreTaskCreateDraft(storage, createIdentity), null);
    assert.equal(
      restoreTaskCommandMetadata(storage, "task-create", createIdentity),
      null
    );
    assert.equal(
      keys.fingerprintKey(
        "task-create",
        createIdentity.projectId,
        metadata.fingerprint
      ).key,
      "new-key-1"
    );
  });

  it("retires exact create and message metadata only after verified removal", () => {
    const createStorage = new FailingDraftRemoveStorage();
    const createDraft = {
      title: "Release",
      prompt: "Prepare the release",
      endpointId: "endpoint_1",
      fileLibrary: { mode: "create_new" as const, name: "Release files" }
    };
    const createMetadata = {
      ...createIdentity,
      key: "create-key",
      fingerprint: "create-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };
    writeTaskCreateDraft(createStorage, createIdentity, createDraft);
    writeTaskCommandMetadata(createStorage, "task-create", createMetadata);
    const createKeys = createMutationKeyStore(() => "create-key-2");
    createKeys.restore("task-create", createIdentity.projectId, createMetadata);
    createStorage.failedKey = taskCommandMetadataKey(
      "task-create",
      createIdentity
    );

    const createRetired = retireTaskCommandMetadata(
      createStorage,
      "task-create",
      createIdentity,
      createMetadata
    );
    if (createRetired) {
      createKeys.transition(
        "task-create",
        createIdentity.projectId,
        createMetadata,
        { outcome: "rejected_before_acceptance", keyDisposition: "retire" }
      );
    }
    assert.equal(createRetired, false);
    assert.deepEqual(
      restoreTaskCommandMetadata(createStorage, "task-create", createIdentity),
      createMetadata
    );
    assert.deepEqual(
      restoreTaskCreateDraft(createStorage, createIdentity),
      createDraft
    );
    assert.equal(
      createKeys.fingerprintKey(
        "task-create",
        createIdentity.projectId,
        createMetadata.fingerprint
      ).key,
      createMetadata.key
    );

    createStorage.failedKey = null;
    assert.equal(
      retireTaskCommandMetadata(
        createStorage,
        "task-create",
        createIdentity,
        createMetadata
      ),
      true
    );
    createKeys.transition(
      "task-create",
      createIdentity.projectId,
      createMetadata,
      { outcome: "rejected_before_acceptance", keyDisposition: "retire" }
    );
    assert.equal(
      restoreTaskCommandMetadata(createStorage, "task-create", createIdentity),
      null
    );
    assert.deepEqual(
      restoreTaskCreateDraft(createStorage, createIdentity),
      createDraft
    );
    assert.equal(
      createKeys.fingerprintKey(
        "task-create",
        createIdentity.projectId,
        createMetadata.fingerprint
      ).key,
      "create-key-2"
    );

    const messageMetadataKey = taskCommandMetadataKey(
      "task-message",
      messageIdentity
    );
    const messageStorage = new FailingMetadataVerificationStorage(
      messageMetadataKey
    );
    const messageMetadata = {
      ...messageIdentity,
      key: "message-key",
      fingerprint: "message-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };
    writeTaskDraft(messageStorage, messageIdentity, "Continue");
    writeTaskCommandMetadata(messageStorage, "task-message", messageMetadata);
    const messageKeys = createMutationKeyStore(() => "message-key-2");
    messageKeys.restore("task-message", messageIdentity.taskId, messageMetadata);
    messageStorage.failNextMetadataVerification = true;

    const messageRetired = retireTaskCommandMetadata(
      messageStorage,
      "task-message",
      messageIdentity,
      messageMetadata
    );
    if (messageRetired) {
      messageKeys.transition(
        "task-message",
        messageIdentity.taskId,
        messageMetadata,
        { outcome: "rejected_before_acceptance", keyDisposition: "retire" }
      );
    }
    assert.equal(messageRetired, false);
    assert.deepEqual(
      restoreTaskCommandMetadata(messageStorage, "task-message", messageIdentity),
      messageMetadata
    );
    assert.equal(readTaskDraft(messageStorage, messageIdentity), "Continue");
    assert.equal(
      messageKeys.fingerprintKey(
        "task-message",
        messageIdentity.taskId,
        messageMetadata.fingerprint
      ).key,
      messageMetadata.key
    );

    assert.equal(
      retireTaskCommandMetadata(
        messageStorage,
        "task-message",
        messageIdentity,
        messageMetadata
      ),
      true
    );
    messageKeys.transition(
      "task-message",
      messageIdentity.taskId,
      messageMetadata,
      { outcome: "rejected_before_acceptance", keyDisposition: "retire" }
    );
    assert.equal(
      restoreTaskCommandMetadata(messageStorage, "task-message", messageIdentity),
      null
    );
    assert.equal(readTaskDraft(messageStorage, messageIdentity), "Continue");
    assert.equal(
      messageKeys.fingerprintKey(
        "task-message",
        messageIdentity.taskId,
        messageMetadata.fingerprint
      ).key,
      "message-key-2"
    );
  });

  it("keeps create cleanup safe when metadata removal verification fails", () => {
    const metadataKey = taskCommandMetadataKey("task-create", createIdentity);
    const storage = new FailingMetadataVerificationStorage(metadataKey);
    const draft = {
      title: "Release",
      prompt: "Prepare the release",
      endpointId: "endpoint_1",
      fileLibrary: { mode: "create_new" as const, name: "Release files" }
    };
    const metadata = {
      ...createIdentity,
      key: "create-key",
      fingerprint: "create-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };
    writeTaskCreateDraft(storage, createIdentity, draft);
    writeTaskCommandMetadata(storage, "task-create", metadata);
    storage.failNextMetadataVerification = true;

    assert.equal(
      clearTaskCreateCommandAttempt(
        storage,
        createIdentity,
        metadata,
        draft
      ),
      true
    );
    assert.equal(storage.getItem(taskCreateDraftKey(createIdentity)), null);
    assert.equal(storage.getItem(metadataKey), null);
  });

  it("never rolls back to a create draft without its completed metadata", () => {
    const metadataKey = taskCommandMetadataKey("task-create", createIdentity);
    const storage = new FailingMetadataVerificationStorage(metadataKey);
    const draft = {
      title: "Release",
      prompt: "Prepare the release",
      endpointId: "endpoint_1",
      fileLibrary: { mode: "create_new" as const, name: "Release files" }
    };
    const metadata = {
      ...createIdentity,
      key: "create-key",
      fingerprint: "create-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };
    writeTaskCreateDraft(storage, createIdentity, draft);
    writeTaskCommandMetadata(storage, "task-create", metadata);
    storage.failNextMetadataVerification = true;
    storage.failMetadataRestore = true;

    assert.equal(
      clearTaskCreateCommandAttempt(
        storage,
        createIdentity,
        metadata,
        draft
      ),
      true
    );
    const hasDraft = storage.getItem(taskCreateDraftKey(createIdentity)) !== null;
    const hasMetadata = storage.getItem(metadataKey) !== null;
    assert.equal(hasDraft && !hasMetadata, false);
    assert.equal(hasDraft, false);
  });

  it("clears the exact message draft and metadata together after canonical absorption", () => {
    const storage = new FailingDraftRemoveStorage();
    const draft = "  Continue with the exact draft  ";
    const metadata = {
      ...messageIdentity,
      key: "message-key",
      fingerprint: "message-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };
    writeTaskDraft(storage, messageIdentity, draft);
    writeTaskCommandMetadata(storage, "task-message", metadata);

    assert.equal(
      clearTaskMessageCommandAttempt(
        storage,
        messageIdentity,
        { key: "other-key", fingerprint: metadata.fingerprint },
        draft
      ),
      false
    );
    assert.equal(readTaskDraft(storage, messageIdentity), draft);
    assert.deepEqual(
      restoreTaskCommandMetadata(storage, "task-message", messageIdentity),
      metadata
    );

    storage.failedKey = taskDraftKey(messageIdentity);
    assert.equal(
      clearTaskMessageCommandAttempt(
        storage,
        messageIdentity,
        metadata,
        draft
      ),
      false
    );
    assert.equal(readTaskDraft(storage, messageIdentity), draft);
    assert.deepEqual(
      restoreTaskCommandMetadata(storage, "task-message", messageIdentity),
      metadata
    );

    storage.failedKey = null;
    assert.equal(
      clearTaskMessageCommandAttempt(
        storage,
        messageIdentity,
        metadata,
        draft
      ),
      true
    );
    assert.equal(readTaskDraft(storage, messageIdentity), "");
    assert.equal(
      restoreTaskCommandMetadata(storage, "task-message", messageIdentity),
      null
    );
  });

  it("leaves create and message attempts untouched when cleanup metadata reads fail", () => {
    const createStorage = new FailingFirstGetStorage();
    const createDraft = {
      title: "Release",
      prompt: "Prepare the release",
      endpointId: "endpoint_1",
      fileLibrary: { mode: "create_new" as const, name: "Release files" }
    };
    const createMetadata = {
      ...createIdentity,
      key: "create-key",
      fingerprint: "create-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };
    writeTaskCreateDraft(createStorage, createIdentity, createDraft);
    writeTaskCommandMetadata(createStorage, "task-create", createMetadata);
    createStorage.failNextGet(
      taskCommandMetadataKey("task-create", createIdentity)
    );

    assert.equal(
      clearTaskCreateCommandAttempt(
        createStorage,
        createIdentity,
        createMetadata,
        createDraft
      ),
      false
    );
    assert.equal(createStorage.removedKeys.length, 0);
    assert.deepEqual(
      restoreTaskCreateDraft(createStorage, createIdentity),
      createDraft
    );
    assert.deepEqual(
      readTaskCommandMetadata(createStorage, "task-create", createIdentity),
      { status: "found", metadata: createMetadata }
    );

    const messageStorage = new FailingFirstGetStorage();
    const messageMetadata = {
      ...messageIdentity,
      key: "message-key",
      fingerprint: "message-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };
    writeTaskDraft(messageStorage, messageIdentity, "Continue");
    writeTaskCommandMetadata(messageStorage, "task-message", messageMetadata);
    messageStorage.failNextGet(
      taskCommandMetadataKey("task-message", messageIdentity)
    );

    assert.equal(
      clearTaskMessageCommandAttempt(
        messageStorage,
        messageIdentity,
        messageMetadata,
        "Continue"
      ),
      false
    );
    assert.equal(messageStorage.removedKeys.length, 0);
    assert.equal(readTaskDraft(messageStorage, messageIdentity), "Continue");
    assert.deepEqual(
      readTaskCommandMetadata(messageStorage, "task-message", messageIdentity),
      { status: "found", metadata: messageMetadata }
    );
  });

  it("cleans only the selected user or project command storage", () => {
    const storage = new MemoryStorage();
    const otherUser = { ...messageIdentity, userId: "user_2" };
    const otherProject = { ...messageIdentity, projectId: "project_2", taskId: "task_2" };
    for (const identity of [messageIdentity, otherUser, otherProject]) {
      writeTaskCommandMetadata(storage, "task-message", {
        ...identity,
        key: `key-${identity.userId}-${identity.projectId}`,
        fingerprint: "fingerprint",
        createdAt: "2026-07-26T12:00:00.000Z"
      });
    }

    clearTaskCommandStorageForProject(storage, "user_1", "project_1");
    assert.equal(restoreTaskCommandMetadata(storage, "task-message", messageIdentity), null);
    assert.notEqual(restoreTaskCommandMetadata(storage, "task-message", otherProject), null);
    assert.notEqual(restoreTaskCommandMetadata(storage, "task-message", otherUser), null);

    clearTaskCommandStorageForUser(storage, "user_1");
    assert.equal(restoreTaskCommandMetadata(storage, "task-message", otherProject), null);
    assert.notEqual(restoreTaskCommandMetadata(storage, "task-message", otherUser), null);

    clearTaskCommandMetadata(storage, "task-message", otherUser);
    assert.equal(restoreTaskCommandMetadata(storage, "task-message", otherUser), null);
  });

  it("bulk cleanup retains metadata when either create or message draft removal fails", () => {
    const createDraft = {
      title: "Release",
      prompt: "Prepare the release",
      endpointId: "endpoint_1",
      fileLibrary: { mode: "create_new" as const, name: "Release files" }
    };
    const createMetadata = {
      ...createIdentity,
      key: "create-key",
      fingerprint: "create-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };
    const messageMetadata = {
      ...messageIdentity,
      key: "message-key",
      fingerprint: "message-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    };

    const createFailure = new FailingDraftRemoveStorage();
    writeTaskCreateDraft(createFailure, createIdentity, createDraft);
    writeTaskCommandMetadata(createFailure, "task-create", createMetadata);
    writeTaskDraft(createFailure, messageIdentity, "Continue");
    writeTaskCommandMetadata(createFailure, "task-message", messageMetadata);
    createFailure.failedKey = taskCreateDraftKey(createIdentity);

    clearTaskCommandStorageForProject(
      createFailure,
      createIdentity.userId,
      createIdentity.projectId
    );
    assert.deepEqual(
      restoreTaskCreateDraft(createFailure, createIdentity),
      createDraft
    );
    assert.deepEqual(
      restoreTaskCommandMetadata(createFailure, "task-create", createIdentity),
      createMetadata
    );
    assert.equal(readTaskDraft(createFailure, messageIdentity), "");
    assert.equal(
      restoreTaskCommandMetadata(createFailure, "task-message", messageIdentity),
      null
    );

    const messageFailure = new FailingDraftRemoveStorage();
    const otherUser = { ...messageIdentity, userId: "user_2", taskId: "task_2" };
    writeTaskDraft(messageFailure, messageIdentity, "Continue");
    writeTaskCommandMetadata(messageFailure, "task-message", messageMetadata);
    writeTaskDraft(messageFailure, otherUser, "Other user");
    writeTaskCommandMetadata(messageFailure, "task-message", {
      ...otherUser,
      key: "other-key",
      fingerprint: "other-fingerprint",
      createdAt: "2026-07-26T12:00:00.000Z"
    });
    messageFailure.failedKey = taskDraftKey(messageIdentity);

    clearTaskCommandStorageForUser(messageFailure, messageIdentity.userId);
    assert.equal(readTaskDraft(messageFailure, messageIdentity), "Continue");
    assert.deepEqual(
      restoreTaskCommandMetadata(messageFailure, "task-message", messageIdentity),
      messageMetadata
    );
    assert.equal(readTaskDraft(messageFailure, otherUser), "Other user");
    assert.notEqual(
      restoreTaskCommandMetadata(messageFailure, "task-message", otherUser),
      null
    );
  });
});

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

class FailingSetStorage extends MemoryStorage {
  failSet = false;
  override setItem(key: string, value: string) {
    if (this.failSet) throw new Error("write failed");
    super.setItem(key, value);
  }
}

class DroppingSetStorage extends MemoryStorage {
  dropSet = false;
  override setItem(key: string, value: string) {
    if (this.dropSet) return;
    super.setItem(key, value);
  }
}

class FailingDraftRemoveStorage extends MemoryStorage {
  failedKey: string | null = null;
  override removeItem(key: string) {
    if (key === this.failedKey) throw new Error("remove failed");
    super.removeItem(key);
  }
}

class FailingMetadataVerificationStorage extends MemoryStorage {
  failNextMetadataVerification = false;
  failMetadataRestore = false;
  private metadataWasRemoved = false;

  constructor(private readonly metadataKey: string) {
    super();
  }

  override getItem(key: string) {
    if (
      key === this.metadataKey
      && this.metadataWasRemoved
      && this.failNextMetadataVerification
    ) {
      this.failNextMetadataVerification = false;
      throw new Error("metadata verification failed");
    }
    return super.getItem(key);
  }

  override removeItem(key: string) {
    super.removeItem(key);
    if (key === this.metadataKey) this.metadataWasRemoved = true;
  }

  override setItem(key: string, value: string) {
    if (
      key === this.metadataKey
      && this.metadataWasRemoved
      && this.failMetadataRestore
    ) throw new Error("metadata restore failed");
    super.setItem(key, value);
  }
}

class FailingFirstGetStorage extends MemoryStorage {
  readonly removedKeys: string[] = [];
  private failedKey: string | null = null;

  failNextGet(key: string) {
    this.failedKey = key;
  }

  override getItem(key: string) {
    if (key === this.failedKey) {
      this.failedKey = null;
      throw new Error("read failed");
    }
    return super.getItem(key);
  }

  override removeItem(key: string) {
    this.removedKeys.push(key);
    super.removeItem(key);
  }
}
