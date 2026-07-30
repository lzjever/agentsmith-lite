import type {
  TaskMessageClientOutcome,
  TaskMessageReceipt
} from "../../lib/api/client.js";
import {
  readTaskCommandMetadata,
  type TaskMessageCommandMetadata
} from "./task-command-storage.js";
import {
  clearTaskMessageCommandAttempt,
  restoreTaskDraft
} from "./task-draft-snapshot.js";

export type RetainedTaskMessageRecovery =
  | { status: "completed"; receipt: TaskMessageReceipt }
  | { status: "storage_unavailable"; receipt: TaskMessageReceipt }
  | {
      status: "unresolved";
      outcome: Exclude<TaskMessageClientOutcome, { outcome: "completed" }>;
    };

export async function replayRetainedTaskMessage({
  storage,
  identity,
  metadata,
  draft,
  send
}: {
  storage: Storage | undefined;
  identity: { userId: string; projectId: string; taskId: string };
  metadata: TaskMessageCommandMetadata;
  draft: string;
  send: (
    taskId: string,
    content: string,
    idempotencyKey: string
  ) => Promise<TaskMessageClientOutcome>;
}): Promise<RetainedTaskMessageRecovery> {
  const outcome = await send(identity.taskId, draft.trim(), metadata.key);
  if (outcome.outcome !== "completed") {
    return { status: "unresolved", outcome };
  }
  if (clearTaskMessageCommandAttempt(
    storage,
    identity,
    metadata,
    draft
  )) {
    return { status: "completed", receipt: outcome };
  }
  const currentMetadata = readTaskCommandMetadata(
    storage,
    "task-message",
    identity
  );
  const currentDraft = restoreTaskDraft(storage, identity);
  return currentMetadata.status === "missing" && currentDraft.status === "empty"
    ? { status: "completed", receipt: outcome }
    : { status: "storage_unavailable", receipt: outcome };
}
