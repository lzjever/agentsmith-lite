import type { AgentTaskArtifact, AgentTaskEvent, TaskEventKind } from "../../contracts/src/api.js";
import { newId, nowIso } from "../../domain/src/ids.js";

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
        nextCursor = item.cursor;
      }
      continue;
    }
    if (seen.has(item.seq)) {
      nextCursor = item.cursor;
      continue;
    }
    seen.add(item.seq);
    nextCursor = item.cursor;

    const kind = mapEventKind(item.type);
    const payload = redactPayload(item.payload ?? {});
    events.push({
      id: newId("evt"),
      taskId,
      kind,
      cursor: item.cursor,
      botifiedSeq: item.seq,
      botifiedType: item.type,
      sessionId: item.session_id ?? "unknown",
      payload,
      createdAt: nowIso()
    });

    if (item.type === "file.published") {
      const fileId = String(item.payload?.file_id ?? item.payload?.id ?? `botified-${item.seq}`);
      artifacts.push({
        id: newId("art"),
        taskId,
        fileId,
        name: String(item.payload?.name ?? fileId),
        bytes: typeof item.payload?.bytes === "number" ? item.payload.bytes : 0,
        createdAt: nowIso()
      });
    }
  }

  return { events, artifacts, nextCursor };
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

function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (/secret|token|api[_-]?key|password/i.test(key)) {
      result[key] = "[redacted]";
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redactPayload(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

