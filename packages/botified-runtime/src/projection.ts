import type { AgentTaskArtifact, AgentTaskEvent, TaskEventKind } from "../../contracts/src/api.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { isSecretLikeText, redactBotifiedPayload, redactSecretLikeText } from "./redaction.js";

export interface BotifiedTimelineEvent {
  version?: string;
  cursor?: string;
  seq?: number;
  session_id?: string;
  type?: string;
  data?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  heartbeat?: boolean;
}

export interface BotifiedProjectionResult {
  events: AgentTaskEvent[];
  artifacts: AgentTaskArtifact[];
  artifactDownloads: BotifiedProjectedArtifactDownload[];
  nextCursor: string | null;
}

export interface BotifiedProjectedArtifactDownload {
  artifactId: string;
  fileId: string;
  filename: string;
  sizeBytes: number;
  sha256?: string;
}

export function projectBotifiedTimelineEvents(
  taskId: string,
  timeline: BotifiedTimelineEvent[],
  alreadyProjectedSeqs = new Set<number>()
): BotifiedProjectionResult {
  const seen = new Set(alreadyProjectedSeqs);
  const events: AgentTaskEvent[] = [];
  const artifacts: AgentTaskArtifact[] = [];
  const artifactDownloads: BotifiedProjectedArtifactDownload[] = [];
  let nextCursor: string | null = null;

  for (const item of timeline) {
    if (item.heartbeat || item.seq === undefined || !item.type || !item.cursor) {
      if (item.cursor) {
        nextCursor = safeNextCursor(item.cursor, nextCursor);
      }
      continue;
    }
    if (seen.has(item.seq)) {
      nextCursor = safeNextCursor(item.cursor, nextCursor);
      continue;
    }
    seen.add(item.seq);
    nextCursor = safeNextCursor(item.cursor, nextCursor);

    const kind = mapEventKind(item.type);
    const sourcePayload = timelinePayload(item);
    const payload = item.type === "file.published"
      ? projectedFilePublishedPayload(sourcePayload, item.seq)
      : redactBotifiedPayload(sourcePayload);
    events.push({
      id: newId("evt"),
      taskId,
      kind,
      cursor: redactSecretLikeText(item.cursor),
      botifiedSeq: item.seq,
      botifiedType: redactSecretLikeText(item.type),
      sessionId: redactSecretLikeText(item.session_id ?? "unknown"),
      payload,
      createdAt: nowIso()
    });

    if (item.type === "file.published") {
      const file = projectFileArtifact(sourcePayload, item.seq);
      const artifactId = newId("art");
      const artifact: AgentTaskArtifact = {
        id: artifactId,
        taskId,
        fileId: redactSecretLikeText(file.fileId),
        name: redactSecretLikeText(file.filename),
        bytes: file.sizeBytes,
        createdAt: nowIso()
      };
      if (file.sha256 !== undefined) {
        artifact.sha256 = redactSecretLikeText(file.sha256);
      }
      artifacts.push(artifact);
      artifactDownloads.push({
        artifactId,
        fileId: file.fileId,
        filename: file.filename,
        sizeBytes: file.sizeBytes,
        ...(file.sha256 !== undefined ? { sha256: file.sha256 } : {})
      });
    }
  }

  const result = { events, artifacts, nextCursor } as BotifiedProjectionResult;
  Object.defineProperty(result, "artifactDownloads", {
    value: artifactDownloads,
    enumerable: false
  });
  return result;
}

function timelinePayload(item: BotifiedTimelineEvent): Record<string, unknown> {
  return item.data ?? item.payload ?? {};
}

function projectedFilePublishedPayload(payload: Record<string, unknown>, seq: number): Record<string, unknown> {
  const file = projectFileArtifact(payload, seq);
  const projected: Record<string, unknown> = {
    file_id: redactSecretLikeText(file.fileId),
    filename: redactSecretLikeText(file.filename),
    size_bytes: file.sizeBytes
  };
  const mimeType = stringField(payload, "mime_type");
  const source = stringField(payload, "source");
  const description = payload.description;
  if (mimeType !== undefined) {
    projected.mime_type = redactSecretLikeText(mimeType);
  }
  if (file.sha256 !== undefined) {
    projected.sha256 = redactSecretLikeText(file.sha256);
  }
  if (source !== undefined) {
    projected.source = redactSecretLikeText(source);
  }
  if (description !== undefined) {
    projected.description = redactBotifiedPayload({ description }).description;
  }
  return projected;
}

function projectFileArtifact(payload: Record<string, unknown>, seq: number): {
  fileId: string;
  filename: string;
  sizeBytes: number;
  sha256?: string;
} {
  const fileId = stringField(payload, "file_id") ?? stringField(payload, "id") ?? `botified-${seq}`;
  const filename = stringField(payload, "filename") ?? stringField(payload, "name") ?? fileId;
  const sizeBytes = numberField(payload, "size_bytes") ?? numberField(payload, "bytes") ?? 0;
  const sha256 = stringField(payload, "sha256");
  return {
    fileId,
    filename,
    sizeBytes,
    ...(sha256 !== undefined ? { sha256 } : {})
  };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeNextCursor(cursor: string, current: string | null): string | null {
  return isSecretLikeText(cursor) ? current : cursor;
}

function mapEventKind(type: string): TaskEventKind {
  if (type === "input.accepted" || type === "input.rejected") {
    return "user_input";
  }
  if (type === "cycle.started") {
    return "turn_started";
  }
  if (type === "cycle.completed") {
    return "turn_completed";
  }
  if (type === "cycle.failed") {
    return "turn_failed";
  }
  if (type === "assistant_message.completed") {
    return "assistant_message";
  }
  if (type.startsWith("command_execution.")) {
    return "tool_execution";
  }
  if (type === "file.published") {
    return "artifact";
  }
  if (type === "service.error") {
    return "runtime_error";
  }
  return "diagnostic";
}
