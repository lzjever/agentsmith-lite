export const BOTIFIED_TIMELINE_VERSION = "botified.timeline.v1" as const;

export interface BotifiedTimelineTrace {
  cycle_id: string | null;
}

export interface BotifiedTimelineItem {
  id: string;
  type: string;
  status: string;
}

export interface BotifiedTimelineEvent {
  version: typeof BOTIFIED_TIMELINE_VERSION;
  seq: number;
  cursor: string;
  time: string;
  session_id: string;
  type: string;
  trace: BotifiedTimelineTrace;
  item: BotifiedTimelineItem | null;
  data: Record<string, unknown>;
}

export function parseBotifiedTimelineEvent(value: unknown): BotifiedTimelineEvent | null {
  if (!isRecord(value) || value.version !== BOTIFIED_TIMELINE_VERSION) {
    return null;
  }

  const seq = value.seq;
  const cursor = value.cursor;
  const time = normalizeTimelineTime(value.time);
  const sessionId = value.session_id;
  const eventType = value.type;
  if (
    !isNonNegativeInteger(seq)
    || !isNonEmptyString(cursor)
    || timelineCursorSeq(cursor) !== seq
    || time === null
    || !isNonEmptyString(sessionId)
    || !isNonEmptyString(eventType)
  ) {
    return null;
  }

  const trace = parseTrace(value.trace);
  const item = parseItem(value.item);
  const data = KNOWN_INTERACTION_EVENT_TYPES.has(eventType)
    ? cloneJsonRecord(value.data)
    : {};
  if (!trace || item === undefined || !data) {
    return null;
  }

  return {
    version: BOTIFIED_TIMELINE_VERSION,
    seq,
    cursor,
    time,
    session_id: sessionId,
    type: eventType,
    trace,
    item,
    data
  };
}

export function parseBotifiedTimelineEvents(values: readonly unknown[]): BotifiedTimelineEvent[] {
  const events: BotifiedTimelineEvent[] = [];
  for (const [index, value] of values.entries()) {
    const event = parseBotifiedTimelineEvent(value);
    if (!event) {
      throw new TypeError(`Invalid canonical Botified timeline envelope at index ${index}`);
    }
    events.push(event);
  }
  return events;
}

function parseTrace(value: unknown): BotifiedTimelineTrace | null {
  if (!isRecord(value) || !(value.cycle_id === null || typeof value.cycle_id === "string")) {
    return null;
  }
  return { cycle_id: value.cycle_id };
}

function parseItem(value: unknown): BotifiedTimelineItem | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    !isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.type)
    || !isNonEmptyString(value.status)
  ) {
    return undefined;
  }
  return { id: value.id, type: value.type, status: value.status };
}

function timelineCursorSeq(cursor: string): number | null {
  const match = /^evt_[A-Za-z0-9]+_([0-9]+)$/.exec(cursor);
  if (!match?.[1]) {
    return null;
  }
  const seq = Number(match[1]);
  return isNonNegativeInteger(seq) ? seq : null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeTimelineTime(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const unix = /^unix:(0|[1-9][0-9]*)$/.exec(value);
  if (unix?.[1]) {
    const seconds = Number(unix[1]);
    if (!Number.isSafeInteger(seconds) || seconds > MAX_UNIX_SECONDS) {
      return null;
    }
    return new Date(seconds * 1_000).toISOString();
  }

  const iso = ISO_TIMESTAMP.exec(value);
  if (!iso) {
    return null;
  }
  const year = Number(iso[1]);
  const month = Number(iso[2]);
  const day = Number(iso[3]);
  const hour = Number(iso[4]);
  const minute = Number(iso[5]);
  const second = Number(iso[6]);
  const millisecond = Number((iso[7] ?? "").padEnd(3, "0").slice(0, 3));
  const offsetHour = Number(iso[10] ?? "0");
  const offsetMinute = Number(iso[11] ?? "0");
  if (
    year < 1
    || month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 14 || offsetMinute > 59
    || (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return null;
  }

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  const offsetSign = iso[9] === "-" ? -1 : 1;
  const offsetMillis = offsetSign * (offsetHour * 60 + offsetMinute) * 60_000;
  const instant = local.getTime() - offsetMillis;
  if (!Number.isSafeInteger(instant) || instant < MIN_SUPPORTED_TIME_MS || instant > MAX_SUPPORTED_TIME_MS) {
    return null;
  }
  return new Date(instant).toISOString();
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const cloned = cloneJsonValue(value, 0, { remainingNodes: 4_096, remainingStringBytes: 64 * 1024 });
  return isRecord(cloned) ? cloned : null;
}

function cloneJsonValue(
  value: unknown,
  depth: number,
  budget: { remainingNodes: number; remainingStringBytes: number }
): unknown {
  budget.remainingNodes -= 1;
  if (depth > 32 || budget.remainingNodes < 0) {
    return undefined;
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    budget.remainingStringBytes -= Buffer.byteLength(value, "utf8");
    return budget.remainingStringBytes >= 0 ? value : undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) return undefined;
    const cloned = value.map((entry) => cloneJsonValue(entry, depth + 1, budget));
    return cloned.some((entry) => entry === undefined) ? undefined : cloned;
  }
  if (isRecord(value)) {
    if (Object.keys(value).length > 256) return undefined;
    const entries: Array<[string, unknown]> = [];
    for (const [key, entry] of Object.entries(value)) {
      const clonedEntry = cloneJsonValue(entry, depth + 1, budget);
      if (clonedEntry === undefined) {
        return undefined;
      }
      entries.push([key, clonedEntry]);
    }
    return Object.fromEntries(entries);
  }
  return undefined;
}

const KNOWN_INTERACTION_EVENT_TYPES = new Set([
  "input.accepted",
  "input.queued",
  "input.rejected",
  "assistant_message.completed",
  "command_execution.started",
  "command_execution.completed",
  "command_execution.failed",
  "background_task.started",
  "background_task.completed",
  "background_task.failed",
  "background_task.lost",
  "background_task.cancelled",
  "background_task.timed_out",
  "background_task.callback_pending",
  "background_task.callback_queued",
  "background_task.callback_delivered",
  "background_task.callback_failed",
  "task_ask.requested",
  "task_ask.expired",
  "task_ask.rejected",
  "task_reply.accepted",
  "task_reply.written",
  "task_reply.failed",
  "task_tell.accepted",
  "task_tell.queued",
  "task_tell.rejected",
  "task_tell.sent",
  "subagent.completed",
  "subagent.failed",
  "subagent.cancelled",
  "subagent.callback",
  "subagent.callback_delivered",
  "file.published",
  "cycle.failed",
  "service.error"
]);

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const MIN_SUPPORTED_TIME_MS = -62_135_596_800_000;
const MAX_SUPPORTED_TIME_MS = 253_402_300_799_999;
const MAX_UNIX_SECONDS = Math.floor(MAX_SUPPORTED_TIME_MS / 1_000);
