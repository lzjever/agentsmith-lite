export interface BotifiedRuntimeHttpClient {
  health(baseUrl: string, serviceKey?: string): Promise<{ status: "ok" }>;
  readState(baseUrl: string, serviceKey: string): Promise<BotifiedRuntimeStateResult>;
  postMessage(baseUrl: string, serviceKey: string, message: string): Promise<BotifiedPostMessageResult>;
  readTimeline(
    baseUrl: string,
    serviceKey: string,
    cursor?: string,
    options?: BotifiedReadTimelineOptions
  ): Promise<BotifiedTimelineReadResult>;
  uploadFile(baseUrl: string, serviceKey: string, file: BotifiedUploadFileInput): Promise<BotifiedUploadFileResult>;
  downloadFile(baseUrl: string, serviceKey: string, fileId: string): Promise<BotifiedDownloadFileResult>;
  abort(baseUrl: string, serviceKey: string): Promise<BotifiedAbortResult>;
}

export interface BotifiedPostMessageResult {
  accepted: boolean;
  kind?: string;
  messageId?: string;
  cursor?: string;
}

export interface BotifiedRuntimeStateResult {
  snapshot: unknown;
  state?: string;
  timelineCursor?: string;
  activeItems?: unknown[];
}

export interface BotifiedReadTimelineOptions {
  limit?: number;
  follow?: boolean;
}

export type BotifiedTimelineReadResult = BotifiedTimelineOkResult | BotifiedTimelineResetResult;

export interface BotifiedTimelineOkResult {
  status: "ok";
  events: unknown[];
  nextCursor?: string;
  hasMoreAfter?: boolean;
  pageStartCursor?: string;
  pageEndCursor?: string;
  historyBoundary?: string;
}

export interface BotifiedTimelineResetResult {
  status: "reset";
  reason: "stale_cursor";
  events: unknown[];
  nextCursor?: string;
  pageStartCursor?: string;
  pageEndCursor?: string;
  historyBoundary: string;
}

export interface BotifiedUploadFileInput {
  filename: string;
  bytes: Uint8Array | ArrayBuffer | Blob;
  mimeType?: string;
}

export interface BotifiedUploadFileResult {
  files: unknown[];
}

export interface BotifiedDownloadFileResult {
  bytes: Uint8Array;
  filename?: string;
  mimeType?: string;
  sizeBytes: number;
  sha256?: string;
}

export interface BotifiedAbortResult {
  aborted: boolean;
  queueLength?: number;
  state?: unknown;
}

export type BotifiedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class BotifiedHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly responseBody: unknown;
  readonly timelineCursor?: string;
  readonly historyBoundary?: string;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    retryable: boolean;
    responseBody: unknown;
    timelineCursor?: string;
    historyBoundary?: string;
  }) {
    super(input.message);
    this.name = "BotifiedHttpError";
    this.status = input.status;
    this.code = input.code;
    this.retryable = input.retryable;
    this.responseBody = input.responseBody;
    if (input.timelineCursor !== undefined) {
      this.timelineCursor = input.timelineCursor;
    }
    if (input.historyBoundary !== undefined) {
      this.historyBoundary = input.historyBoundary;
    }
  }
}

export class FetchBotifiedRuntimeHttpClient implements BotifiedRuntimeHttpClient {
  readonly #fetchImpl: BotifiedFetch;

  constructor(fetchImpl: BotifiedFetch = (input, init) => fetch(input, init)) {
    this.#fetchImpl = fetchImpl;
  }

  async health(baseUrl: string, _serviceKey?: string): Promise<{ status: "ok" }> {
    const body = await this.requestJson(baseUrl, "/healthz", {
      method: "GET",
      auth: "none"
    });
    const record = asRecord(body);
    if (record?.ok !== true) {
      throw new BotifiedHttpError({
        status: 200,
        code: "invalid_health_response",
        message: "Botified healthz response did not contain ok=true",
        retryable: true,
        responseBody: body
      });
    }
    return { status: "ok" };
  }

  async readState(baseUrl: string, serviceKey: string): Promise<BotifiedRuntimeStateResult> {
    const body = await this.requestJson(baseUrl, "/v1/state", {
      method: "GET",
      serviceKey
    });
    const record = asRecord(body);
    const result: BotifiedRuntimeStateResult = {
      snapshot: body
    };
    const state = stringField(record, "state");
    const timelineCursor = stringField(record, "timeline_cursor");
    const activeItems = arrayFieldOrUndefined(record, "active_items");
    if (state !== undefined) {
      result.state = state;
    }
    if (timelineCursor !== undefined) {
      result.timelineCursor = timelineCursor;
    }
    if (activeItems !== undefined) {
      result.activeItems = activeItems;
    }
    return result;
  }

  async postMessage(baseUrl: string, serviceKey: string, message: string): Promise<BotifiedPostMessageResult> {
    const body = await this.requestJson(baseUrl, "/v1/messages", {
      method: "POST",
      serviceKey,
      body: JSON.stringify({ text: message }),
      headers: {
        "content-type": "application/json"
      }
    });
    const record = asRecord(body);
    const result: BotifiedPostMessageResult = {
      accepted: record?.ok === true
    };
    const kind = stringField(record, "kind");
    const messageId = stringField(record, "message_id");
    const cursor = stringField(record, "timeline_cursor");
    if (kind !== undefined) {
      result.kind = kind;
    }
    if (messageId !== undefined) {
      result.messageId = messageId;
    }
    if (cursor !== undefined) {
      result.cursor = cursor;
    }
    return result;
  }

  async readTimeline(
    baseUrl: string,
    serviceKey: string,
    cursor?: string,
    options: BotifiedReadTimelineOptions = {}
  ): Promise<BotifiedTimelineReadResult> {
    const response = await this.fetchTimeline(baseUrl, serviceKey, timelinePath(cursor, options));
    if (response.status === 410) {
      const body = await readJsonBody(response);
      const error = this.httpError(response, body);
      if (error.code !== "stale_cursor") {
        throw error;
      }
      const tail = await this.readTimelineTail(baseUrl, serviceKey);
      const reset: BotifiedTimelineResetResult = {
        status: "reset",
        reason: "stale_cursor",
        historyBoundary: error.historyBoundary ?? "expired",
        events: tail.events
      };
      copyTimelineHeaders(tail, reset);
      return reset;
    }
    if (!response.ok) {
      throw this.httpError(response, await readJsonBody(response));
    }
    return this.timelineOkResult(response, await response.text());
  }

  async uploadFile(
    baseUrl: string,
    serviceKey: string,
    file: BotifiedUploadFileInput
  ): Promise<BotifiedUploadFileResult> {
    const form = new FormData();
    const blob = fileBlob(file);
    form.append("file", blob, file.filename);
    const body = await this.requestJson(baseUrl, "/v1/files", {
      method: "POST",
      serviceKey,
      body: form
    });
    const record = asRecord(body);
    const files = arrayField(record, "files");
    return { files };
  }

  async downloadFile(baseUrl: string, serviceKey: string, fileId: string): Promise<BotifiedDownloadFileResult> {
    const response = await this.#fetchImpl(buildUrl(baseUrl, `/v1/files/${encodeURIComponent(fileId)}`), {
      method: "GET",
      headers: authHeaders(serviceKey)
    });
    if (!response.ok) {
      throw this.httpError(response, await readJsonBody(response));
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const result: BotifiedDownloadFileResult = {
      bytes,
      sizeBytes: bytes.byteLength
    };
    const filename = filenameFromContentDisposition(response.headers.get("content-disposition"));
    const mimeType = response.headers.get("content-type") ?? undefined;
    const sha256 = response.headers.get("x-botified-sha256") ?? undefined;
    if (filename !== undefined) {
      result.filename = filename;
    }
    if (mimeType !== undefined) {
      result.mimeType = mimeType;
    }
    if (sha256 !== undefined) {
      result.sha256 = sha256;
    }
    return result;
  }

  async abort(baseUrl: string, serviceKey: string): Promise<BotifiedAbortResult> {
    const body = await this.requestJson(baseUrl, "/v1/abort", {
      method: "POST",
      serviceKey
    });
    const record = asRecord(body);
    const result: BotifiedAbortResult = {
      aborted: record?.ok === true
    };
    const queueLength = numberField(record, "queue_length");
    if (queueLength !== undefined) {
      result.queueLength = queueLength;
    }
    if (record !== undefined && "state" in record) {
      result.state = record.state;
    }
    return result;
  }

  private async readTimelineTail(baseUrl: string, serviceKey: string): Promise<BotifiedTimelineOkResult> {
    const response = await this.fetchTimeline(baseUrl, serviceKey, "/v1/timeline?tail=1");
    if (!response.ok) {
      throw this.httpError(response, await readJsonBody(response));
    }
    return this.timelineOkResult(response, await response.text());
  }

  private async fetchTimeline(baseUrl: string, serviceKey: string, path: string): Promise<Response> {
    return this.#fetchImpl(buildUrl(baseUrl, path), {
      method: "GET",
      headers: authHeaders(serviceKey)
    });
  }

  private async requestJson(
    baseUrl: string,
    path: string,
    input: {
      method: string;
      auth?: "none";
      serviceKey?: string;
      headers?: HeadersInit;
      body?: BodyInit;
    }
  ): Promise<unknown> {
    const headers = new Headers(input.headers);
    if (input.auth !== "none") {
      if (input.serviceKey === undefined) {
        throw new Error("Botified service key is required for this request");
      }
      headers.set("authorization", `Bearer ${input.serviceKey}`);
    }
    const requestInit: RequestInit = {
      method: input.method,
      headers
    };
    if (input.body !== undefined) {
      requestInit.body = input.body;
    }
    const response = await this.#fetchImpl(buildUrl(baseUrl, path), requestInit);
    const body = await readJsonBody(response);
    if (!response.ok) {
      throw this.httpError(response, body);
    }
    return body;
  }

  private timelineOkResult(response: Response, text: string): BotifiedTimelineOkResult {
    const result: BotifiedTimelineOkResult = {
      status: "ok",
      events: parseNdjson(text, response.status)
    };
    const nextCursor = response.headers.get("x-botified-next-cursor") ?? undefined;
    const hasMoreAfter = boolHeader(response, "x-botified-has-more-after");
    const pageStartCursor = response.headers.get("x-botified-page-start-cursor") ?? undefined;
    const pageEndCursor = response.headers.get("x-botified-page-end-cursor") ?? undefined;
    const historyBoundary = response.headers.get("x-botified-history-boundary") ?? undefined;
    if (nextCursor !== undefined) {
      result.nextCursor = nextCursor;
    }
    if (hasMoreAfter !== undefined) {
      result.hasMoreAfter = hasMoreAfter;
    }
    if (pageStartCursor !== undefined) {
      result.pageStartCursor = pageStartCursor;
    }
    if (pageEndCursor !== undefined) {
      result.pageEndCursor = pageEndCursor;
    }
    if (historyBoundary !== undefined) {
      result.historyBoundary = historyBoundary;
    }
    return result;
  }

  private httpError(response: Response, body: unknown): BotifiedHttpError {
    const record = asRecord(body);
    const error = asRecord(record?.error);
    const code = stringField(error, "code") ?? `http_${response.status}`;
    const message = stringField(error, "message") ?? (response.statusText || `Botified HTTP ${response.status}`);
    const retryable = boolField(error, "retryable") ?? response.status >= 500;
    const timelineCursor = stringField(record, "timeline_cursor");
    const historyBoundary =
      stringField(error, "history_boundary") ?? response.headers.get("x-botified-history-boundary") ?? undefined;
    const details: {
      status: number;
      code: string;
      message: string;
      retryable: boolean;
      responseBody: unknown;
      timelineCursor?: string;
      historyBoundary?: string;
    } = {
      status: response.status,
      code,
      message,
      retryable,
      responseBody: body
    };
    if (timelineCursor !== undefined) {
      details.timelineCursor = timelineCursor;
    }
    if (historyBoundary !== undefined) {
      details.historyBoundary = historyBoundary;
    }
    return new BotifiedHttpError(details);
  }
}

export class DryRunBotifiedRuntimeHttpClient implements BotifiedRuntimeHttpClient {
  async health(): Promise<{ status: "ok" }> {
    return { status: "ok" };
  }

  async readState(): Promise<BotifiedRuntimeStateResult> {
    return { snapshot: {}, state: "idle" };
  }

  async postMessage(): Promise<BotifiedPostMessageResult> {
    return { accepted: true, cursor: "dry-run" };
  }

  async readTimeline(): Promise<BotifiedTimelineReadResult> {
    return { status: "ok", events: [] };
  }

  async uploadFile(): Promise<BotifiedUploadFileResult> {
    return { files: [] };
  }

  async downloadFile(): Promise<BotifiedDownloadFileResult> {
    return { bytes: new Uint8Array(), sizeBytes: 0 };
  }

  async abort(): Promise<BotifiedAbortResult> {
    return { aborted: true };
  }
}

function buildUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function timelinePath(cursor: string | undefined, options: BotifiedReadTimelineOptions): string {
  if (cursor === undefined) {
    return "/v1/timeline?tail=1";
  }
  const params = new URLSearchParams();
  params.set("cursor", cursor);
  if (options.follow === true) {
    params.set("follow", "true");
  } else {
    params.set("limit", String(options.limit ?? 200));
  }
  return `/v1/timeline?${params.toString()}`;
}

function authHeaders(serviceKey: string): Headers {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${serviceKey}`);
  return headers;
}

function fileBlob(file: BotifiedUploadFileInput): Blob {
  const options = file.mimeType ? { type: file.mimeType } : undefined;
  if (file.bytes instanceof Blob) {
    return file.bytes;
  }
  if (file.bytes instanceof ArrayBuffer) {
    return new Blob([file.bytes], options);
  }
  const copy = new Uint8Array(file.bytes.byteLength);
  copy.set(file.bytes);
  return new Blob([copy.buffer], options);
}

function filenameFromContentDisposition(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const extended = /(?:^|;)\s*filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (extended) {
    try {
      return decodeURIComponent(extended.trim());
    } catch {
      return extended.trim();
    }
  }
  const quoted = /(?:^|;)\s*filename="([^"]*)"/i.exec(value)?.[1];
  if (quoted !== undefined) {
    return quoted;
  }
  const bare = /(?:^|;)\s*filename=([^;]+)/i.exec(value)?.[1];
  return bare?.trim();
}

async function readJsonBody(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (raw.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new BotifiedHttpError({
      status: response.status,
      code: "invalid_json_response",
      message: "Botified response body was not valid JSON",
      retryable: response.status >= 500,
      responseBody: raw
    });
  }
}

function parseNdjson(text: string, status: number): unknown[] {
  const events: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      throw new BotifiedHttpError({
        status,
        code: "invalid_ndjson_response",
        message: "Botified timeline response contained invalid NDJSON",
        retryable: true,
        responseBody: text
      });
    }
  }
  return events;
}

function copyTimelineHeaders(source: BotifiedTimelineOkResult, target: BotifiedTimelineResetResult): void {
  if (source.nextCursor !== undefined) {
    target.nextCursor = source.nextCursor;
  }
  if (source.pageStartCursor !== undefined) {
    target.pageStartCursor = source.pageStartCursor;
  }
  if (source.pageEndCursor !== undefined) {
    target.pageEndCursor = source.pageEndCursor;
  }
}

function boolHeader(response: Response, name: string): boolean | undefined {
  const value = response.headers.get(name);
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function boolField(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function arrayField(record: Record<string, unknown> | undefined, key: string): unknown[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

function arrayFieldOrUndefined(record: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  const value = record?.[key];
  return Array.isArray(value) ? value : undefined;
}
