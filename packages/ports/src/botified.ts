import { MAX_TASK_ARTIFACT_BYTES } from "../../domain/src/sandboxDefaults.js";

export interface BotifiedRuntimeHttpClient {
  health(baseUrl: string, serviceKey?: string): Promise<{ status: "ok" }>;
  readState(baseUrl: string, serviceKey: string): Promise<BotifiedRuntimeStateResult>;
  postMessage(baseUrl: string, serviceKey: string, message: string): Promise<BotifiedPostMessageResult>;
  postMessageWithDelivery?(baseUrl: string, serviceKey: string, input: BotifiedDeliveryMessageInput): Promise<BotifiedDeliveryReceipt>;
  queryDeliveryReceipt?(baseUrl: string, serviceKey: string, deliveryKey: string): Promise<BotifiedDeliveryReceipt | null>;
  readTimeline(
    baseUrl: string,
    serviceKey: string,
    cursor?: string,
    options?: BotifiedReadTimelineOptions
  ): Promise<BotifiedTimelineReadResult>;
  uploadFile(baseUrl: string, serviceKey: string, file: BotifiedUploadFileInput): Promise<BotifiedUploadFileResult>;
  downloadFile(baseUrl: string, serviceKey: string, fileId: string): Promise<BotifiedDownloadFileResult>;
  abort(baseUrl: string, serviceKey: string): Promise<BotifiedAbortResult>;
  stopBackgroundTask?(baseUrl: string, serviceKey: string, taskId: string): Promise<BotifiedBackgroundTaskStopResult>;
  streamLlmTextPreview?(
    baseUrl: string,
    serviceKey: string,
    options?: BotifiedLlmTextPreviewOptions
  ): AsyncIterable<BotifiedLlmTextPreviewFrame>;
}

export interface BotifiedPostMessageResult {
  accepted: boolean;
  kind?: string;
  messageId?: string;
  cursor?: string;
}

export interface BotifiedDeliveryMessageInput {
  text: string;
  deliveryKey: string;
  requestHash: string;
}

export interface BotifiedDeliveryReceipt {
  accepted: boolean;
  deliveryKey: string;
  requestHash: string;
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
  direction?: "forward" | "backward" | "history";
  limit?: number;
  follow?: boolean;
}

export type BotifiedTimelineHistoryBoundary = "none" | "start" | "expired";

export type BotifiedTimelineReadResult = BotifiedTimelineOkResult | BotifiedTimelineGapResult;

export interface BotifiedTimelineOkResult {
  status: "ok";
  events: unknown[];
  nextCursor?: string;
  hasMoreAfter?: boolean;
  hasMoreBefore?: boolean;
  pageStartCursor?: string;
  pageEndCursor?: string;
  historyBoundary?: BotifiedTimelineHistoryBoundary;
}

export interface BotifiedTimelineGapResult {
  status: "gap";
  reason: "stale_cursor";
  events: [];
  nextCursor?: string;
  recoveryCursor?: string;
  historyBoundary: "expired";
}

export interface BotifiedBackgroundTaskStopResult {
  taskId: string;
  state: "running" | "cancelling" | "completed" | "failed" | "timed_out" | "cancelled" | "lost";
}

export interface BotifiedLlmTextPreviewOptions {
  providerRequestId?: string;
  cycleId?: string;
  inputId?: string;
}

interface BotifiedLlmTextPreviewFrameBase {
  time: string;
  providerRequestId: string;
  turnId?: string;
  cycleId?: string;
  providerCallIndex: number;
  inputIds: string[];
}

export type BotifiedLlmTextPreviewFrame =
  | (BotifiedLlmTextPreviewFrameBase & { type: "started" })
  | (BotifiedLlmTextPreviewFrameBase & { type: "text_delta"; delta: string })
  | (BotifiedLlmTextPreviewFrameBase & { type: "finished"; textEmitted: boolean; stopReason: string })
  | (BotifiedLlmTextPreviewFrameBase & { type: "aborted"; reason: string })
  | (BotifiedLlmTextPreviewFrameBase & { type: "error"; code: string; retryable: boolean; providerStatus?: number })
  | (BotifiedLlmTextPreviewFrameBase & { type: "status"; code: string });

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
  readonly #requestTimeoutMs: number;

  constructor(fetchImpl: BotifiedFetch = (input, init) => fetch(input, init), requestTimeoutMs = 10_000) {
    this.#fetchImpl = fetchImpl;
    this.#requestTimeoutMs = requestTimeoutMs;
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

  async postMessageWithDelivery(baseUrl: string, serviceKey: string, input: BotifiedDeliveryMessageInput): Promise<BotifiedDeliveryReceipt> {
    const body = await this.requestJson(baseUrl, "/v1/messages", {
      method: "POST",
      serviceKey,
      body: JSON.stringify({ text: input.text, delivery_key: input.deliveryKey, request_hash: input.requestHash }),
      headers: { "content-type": "application/json" }
    });
    return deliveryReceiptFromBody(body, input);
  }

  async queryDeliveryReceipt(baseUrl: string, serviceKey: string, deliveryKey: string): Promise<BotifiedDeliveryReceipt | null> {
    try {
      const body = await this.requestJson(baseUrl, "/v1/deliveries/" + encodeURIComponent(deliveryKey), {
        method: "GET",
        serviceKey
      });
      const record = asRecord(body);
      if (record?.found === false) return null;
      return deliveryReceiptFromBody(body, { deliveryKey, requestHash: "" });
    } catch (error) {
      if (error instanceof BotifiedHttpError && error.status === 404) return null;
      throw error;
    }
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
      const gap: BotifiedTimelineGapResult = {
        status: "gap",
        reason: "stale_cursor",
        historyBoundary: "expired",
        events: []
      };
      if (error.timelineCursor !== undefined) {
        gap.recoveryCursor = error.timelineCursor;
      }
      return gap;
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

    const bytes = await readArtifactBytes(response);
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

  async stopBackgroundTask(
    baseUrl: string,
    serviceKey: string,
    taskId: string
  ): Promise<BotifiedBackgroundTaskStopResult> {
    const body = await this.requestJson(baseUrl, `/v1/background-tasks/${encodeURIComponent(taskId)}/stop`, {
      method: "POST",
      serviceKey
    });
    const record = asRecord(body);
    const responseTaskId = stringField(record, "task_id");
    const state = backgroundTaskStateField(record, "state");
    if (record?.ok !== true || responseTaskId === undefined || state === undefined) {
      throw new BotifiedHttpError({
        status: 200,
        code: "invalid_background_task_stop_response",
        message: "Botified background task stop response was invalid",
        retryable: true,
        responseBody: body
      });
    }
    return { taskId: responseTaskId, state };
  }

  async *streamLlmTextPreview(
    baseUrl: string,
    serviceKey: string,
    options: BotifiedLlmTextPreviewOptions = {}
  ): AsyncIterable<BotifiedLlmTextPreviewFrame> {
    const response = await this.#fetchImpl(buildUrl(baseUrl, llmTextPreviewPath(options)), {
      method: "GET",
      headers: authHeaders(serviceKey)
    });
    if (!response.ok) {
      throw this.httpError(response, await readJsonBody(response));
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
      throw invalidPreviewStreamError("Botified preview response was not an event stream");
    }
    if (!response.body) {
      throw invalidPreviewStreamError("Botified preview response did not include a stream body");
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let pending = "";
    let completed = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          completed = true;
          break;
        }
        const parsed = splitSseEvents(pending + decoder.decode(chunk.value, { stream: true }));
        pending = parsed.remaining;
        for (const event of parsed.events) {
          yield previewFrameFromSse(event);
        }
      }

      const parsed = splitSseEvents(pending + decoder.decode());
      if (parsed.remaining.trim() !== "") {
        throw invalidPreviewStreamError("Botified preview stream ended with an incomplete event");
      }
      for (const event of parsed.events) {
        yield previewFrameFromSse(event);
      }
    } finally {
      try {
        if (!completed) await reader.cancel();
      } catch {
        // The original stream or parser error remains authoritative.
      } finally {
        reader.releaseLock();
      }
    }
  }

  private async fetchTimeline(baseUrl: string, serviceKey: string, path: string): Promise<Response> {
    return this.#fetchImpl(buildUrl(baseUrl, path), {
      method: "GET",
      headers: authHeaders(serviceKey),
      signal: AbortSignal.timeout(this.#requestTimeoutMs)
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
      headers,
      signal: AbortSignal.timeout(this.#requestTimeoutMs)
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
    const hasMoreBefore = boolHeader(response, "x-botified-has-more-before");
    const pageStartCursor = response.headers.get("x-botified-page-start-cursor") ?? undefined;
    const pageEndCursor = response.headers.get("x-botified-page-end-cursor") ?? undefined;
    const historyBoundary = historyBoundaryHeader(response);
    if (nextCursor !== undefined) {
      result.nextCursor = nextCursor;
    }
    if (hasMoreAfter !== undefined) {
      result.hasMoreAfter = hasMoreAfter;
    }
    if (hasMoreBefore !== undefined) {
      result.hasMoreBefore = hasMoreBefore;
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

  async stopBackgroundTask(_baseUrl: string, _serviceKey: string, taskId: string): Promise<BotifiedBackgroundTaskStopResult> {
    return { taskId, state: "cancelled" };
  }

  async *streamLlmTextPreview(): AsyncIterable<BotifiedLlmTextPreviewFrame> {}
}

function buildUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function timelinePath(cursor: string | undefined, options: BotifiedReadTimelineOptions): string {
  if (options.direction === "backward" && cursor === undefined) {
    throw new Error("Botified backward timeline reads require a cursor");
  }
  if (options.direction === "history" && cursor !== undefined) {
    throw new Error("Botified timeline history reads cannot include a cursor");
  }
  if (options.direction === "history" || cursor === undefined) {
    if (options.follow === true) {
      throw new Error("Botified timeline history reads cannot follow");
    }
    return `/v1/timeline?tail=${options.limit ?? 200}`;
  }
  const params = new URLSearchParams();
  params.set("cursor", cursor);
  if (options.direction === "backward") {
    if (options.follow === true) {
      throw new Error("Botified backward timeline reads cannot follow");
    }
    params.set("direction", "backward");
    params.set("limit", String(options.limit ?? 200));
  } else if (options.follow === true) {
    params.set("follow", "true");
  } else {
    params.set("limit", String(options.limit ?? 200));
  }
  return `/v1/timeline?${params.toString()}`;
}

function llmTextPreviewPath(options: BotifiedLlmTextPreviewOptions): string {
  const params = new URLSearchParams();
  if (options.providerRequestId !== undefined) params.set("provider_request_id", options.providerRequestId);
  if (options.cycleId !== undefined) params.set("cycle_id", options.cycleId);
  if (options.inputId !== undefined) params.set("input_id", options.inputId);
  const query = params.toString();
  return query ? `/v1/llm-text-preview?${query}` : "/v1/llm-text-preview";
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

async function readArtifactBytes(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isSafeInteger(declaredBytes) && declaredBytes > MAX_TASK_ARTIFACT_BYTES) {
      throw artifactTooLargeError();
    }
  }

  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_TASK_ARTIFACT_BYTES) {
        await reader.cancel();
        throw artifactTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function artifactTooLargeError(): BotifiedHttpError {
  return new BotifiedHttpError({
    status: 413,
    code: "artifact_too_large",
    message: `Botified artifact exceeds the ${MAX_TASK_ARTIFACT_BYTES}-byte limit`,
    retryable: false,
    responseBody: {}
  });
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

function historyBoundaryHeader(response: Response): BotifiedTimelineHistoryBoundary | undefined {
  const value = response.headers.get("x-botified-history-boundary");
  if (value === null) return undefined;
  if (value === "none" || value === "start" || value === "expired") return value;
  throw new BotifiedHttpError({
    status: response.status,
    code: "invalid_timeline_history_boundary",
    message: "Botified timeline response contained an invalid history boundary",
    retryable: true,
    responseBody: {}
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function deliveryReceiptFromBody(body: unknown, fallback: Pick<BotifiedDeliveryMessageInput, "deliveryKey" | "requestHash">): BotifiedDeliveryReceipt {
  const record = asRecord(body);
  const deliveryKey = stringField(record, "delivery_key") ?? fallback.deliveryKey;
  const requestHash = stringField(record, "request_hash") ?? fallback.requestHash;
  if (!deliveryKey || !requestHash || record?.ok !== true) {
    throw new BotifiedHttpError({
      status: 200,
      code: "invalid_delivery_receipt",
      message: "Botified delivery response did not contain an accepted receipt",
      retryable: true,
      responseBody: body
    });
  }
  const result: BotifiedDeliveryReceipt = { accepted: true, deliveryKey, requestHash };
  const messageId = stringField(record, "message_id");
  const cursor = stringField(record, "timeline_cursor");
  if (messageId !== undefined) result.messageId = messageId;
  if (cursor !== undefined) result.cursor = cursor;
  return result;
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

function backgroundTaskStateField(
  record: Record<string, unknown> | undefined,
  key: string
): BotifiedBackgroundTaskStopResult["state"] | undefined {
  const value = stringField(record, key);
  return value === "running" || value === "cancelling" || value === "completed" || value === "failed" ||
    value === "timed_out" || value === "cancelled" || value === "lost"
    ? value
    : undefined;
}

function splitSseEvents(value: string): { events: string[]; remaining: string } {
  const events: string[] = [];
  let remaining = value;
  while (true) {
    const match = /\r?\n\r?\n/.exec(remaining);
    if (!match || match.index === undefined) return { events, remaining };
    events.push(remaining.slice(0, match.index));
    remaining = remaining.slice(match.index + match[0].length);
  }
}

function previewFrameFromSse(event: string): BotifiedLlmTextPreviewFrame {
  let eventName: string | undefined;
  const data: string[] = [];
  for (const line of event.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (key === "event") eventName = value;
    if (key === "data") data.push(value);
  }
  if (eventName === undefined || data.length === 0) {
    throw invalidPreviewStreamError("Botified preview event was incomplete");
  }
  let body: unknown;
  try {
    body = JSON.parse(data.join("\n"));
  } catch {
    throw invalidPreviewStreamError("Botified preview event contained invalid JSON");
  }
  return previewFrameFromBody(body, eventName);
}

function previewFrameFromBody(body: unknown, eventName: string): BotifiedLlmTextPreviewFrame {
  const record = asRecord(body);
  const type = stringField(record, "type");
  const base = previewFrameBase(record);
  if (!base || type !== eventName) {
    throw invalidPreviewStreamError("Botified preview event did not match its declared type");
  }
  switch (type) {
    case "started":
      return { type, ...base };
    case "text_delta": {
      const delta = stringField(record, "delta");
      if (delta === undefined) break;
      return { type, ...base, delta };
    }
    case "finished": {
      const textEmitted = boolField(record, "text_emitted");
      const stopReason = stringField(record, "stop_reason");
      if (textEmitted === undefined || stopReason === undefined) break;
      return { type, ...base, textEmitted, stopReason };
    }
    case "aborted": {
      const reason = stringField(record, "reason");
      if (reason === undefined) break;
      return { type, ...base, reason };
    }
    case "error": {
      const code = stringField(record, "code");
      const retryable = boolField(record, "retryable");
      const providerStatus = numberField(record, "provider_status");
      if (code === undefined || retryable === undefined) break;
      return providerStatus === undefined ? { type, ...base, code, retryable } : { type, ...base, code, retryable, providerStatus };
    }
    case "status": {
      const code = stringField(record, "code");
      if (code === undefined) break;
      return { type, ...base, code };
    }
  }
  throw invalidPreviewStreamError("Botified preview event had invalid fields");
}

function previewFrameBase(record: Record<string, unknown> | undefined): BotifiedLlmTextPreviewFrameBase | undefined {
  const time = stringField(record, "time");
  const providerRequestId = stringField(record, "provider_request_id");
  const providerCallIndex = numberField(record, "provider_call_index");
  const inputIds = arrayFieldOrUndefined(record, "input_ids");
  if (time === undefined || providerRequestId === undefined || providerCallIndex === undefined || inputIds === undefined || !inputIds.every((id) => typeof id === "string")) {
    return undefined;
  }
  const result: BotifiedLlmTextPreviewFrameBase = {
    time,
    providerRequestId,
    providerCallIndex,
    inputIds: inputIds as string[]
  };
  const turnId = stringField(record, "turn_id");
  const cycleId = stringField(record, "cycle_id");
  if (turnId !== undefined) result.turnId = turnId;
  if (cycleId !== undefined) result.cycleId = cycleId;
  return result;
}

function invalidPreviewStreamError(message: string): BotifiedHttpError {
  return new BotifiedHttpError({
    status: 502,
    code: "invalid_preview_stream",
    message,
    retryable: true,
    responseBody: {}
  });
}

function arrayField(record: Record<string, unknown> | undefined, key: string): unknown[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

function arrayFieldOrUndefined(record: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  const value = record?.[key];
  return Array.isArray(value) ? value : undefined;
}
