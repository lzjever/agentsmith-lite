import type { AgentTaskArtifact, AgentTaskEvent, TaskEventKind } from "../../contracts/src/api.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { isSecretLikeText, redactBotifiedPayload, redactSecretLikeText } from "./redaction.js";

export interface BotifiedTimelineEvent {
  cursor?: string;
  seq?: number;
  session_id?: string;
  type?: string;
  payload?: Record<string, unknown>;
  heartbeat?: boolean;
}

export interface BotifiedProjectionResult {
  events: AgentTaskEvent[];
  artifacts: AgentTaskArtifact[];
  nextCursor: string | null;
}

export function projectBotifiedTimelineEvents(
  taskId: string,
  timeline: BotifiedTimelineEvent[],
  alreadyProjectedSeqs = new Set<number>()
): BotifiedProjectionResult {
  const seen = new Set(alreadyProjectedSeqs);
  const events: AgentTaskEvent[] = [];
  const artifacts: AgentTaskArtifact[] = [];
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
    const payload = redactBotifiedPayload(item.payload ?? {});
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
      const rawFileId = String(item.payload?.file_id ?? item.payload?.id ?? `botified-${item.seq}`);
      const fileId = redactSecretLikeText(rawFileId);
      artifacts.push({
        id: newId("art"),
        taskId,
        fileId,
        name: redactSecretLikeText(String(item.payload?.name ?? rawFileId)),
        bytes: typeof item.payload?.bytes === "number" ? item.payload.bytes : 0,
        createdAt: nowIso()
      });
    }
  }

  return { events, artifacts, nextCursor };
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
