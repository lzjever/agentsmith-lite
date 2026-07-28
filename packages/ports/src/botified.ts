import { MAX_TASK_ARTIFACT_BYTES } from "../../domain/src/sandboxDefaults.js";

export interface BotifiedRuntimeHttpClient {
  health(baseUrl: string, serviceKey?: string, signal?:AbortSignal): Promise<{ status: "ok" }>;
  readState(baseUrl: string, serviceKey: string, signal?:AbortSignal): Promise<BotifiedRuntimeStateResult>;
  postMessage(baseUrl: string, serviceKey: string, input: BotifiedMessageInput): Promise<BotifiedMessageResult>;
  readTimeline(
    baseUrl: string,
    serviceKey: string,
    cursor?: string,
    options?: BotifiedReadTimelineOptions
  ): Promise<BotifiedTimelineReadResult>;
  uploadFile(baseUrl: string, serviceKey: string, file: BotifiedUploadFileInput): Promise<BotifiedUploadFileResult>;
  downloadFile(baseUrl: string, serviceKey: string, fileId: string): Promise<BotifiedDownloadFileResult>;
  abort(baseUrl: string, serviceKey: string): Promise<BotifiedAbortResult>;
  streamLlmTextPreview?(
    baseUrl: string,
    serviceKey: string,
    options?: BotifiedLlmTextPreviewOptions
  ): AsyncIterable<BotifiedLlmTextPreviewFrame>;
}

export interface BotifiedMessageInput {
  messageId: string;
  text: string;
}

export interface BotifiedOrdinaryMessageResult {
  type: "ordinary";
  kind: "input_accepted" | "input_queued" | "input_duplicate";
  inputId: string;
  messageId: string;
  timelineCursor: string;
  queueLength: number;
  state: "idle" | "running" | "aborting" | "failed";
}

export interface BotifiedSlashMessageResult {
  type: "slash";
  response: unknown;
}

export type BotifiedMessageResult = BotifiedOrdinaryMessageResult | BotifiedSlashMessageResult;
export interface BotifiedRuntimeStateResult {
  snapshot: unknown;
  sessionId?: string;
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

export interface BotifiedLlmTextPreviewOptions {
  providerRequestId?: string;
  cycleId?: string;
  inputId?: string;
  signal?: AbortSignal;
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
  ok: boolean;
  state: "idle" | "running" | "aborting" | "failed";
  queueLength: number;
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

  async health(baseUrl: string, _serviceKey?: string, signal?:AbortSignal): Promise<{ status: "ok" }> {
    const body = await this.requestJson(baseUrl, "/healthz", {
      method: "GET",
      auth: "none",
      ...(signal?{signal}:{})
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

  async readState(baseUrl: string, serviceKey: string, signal?:AbortSignal): Promise<BotifiedRuntimeStateResult> {
    const body = await this.requestJson(baseUrl, "/v1/state", {
      method: "GET",
      serviceKey,
      ...(signal?{signal}:{})
    });
    const record = asRecord(body);
    const result: BotifiedRuntimeStateResult = {
      snapshot: body
    };
    const sessionId = stringField(record, "session_id");
    const state = stringField(record, "state");
    const timelineCursor = stringField(record, "timeline_cursor");
    const activeItems = arrayFieldOrUndefined(record, "active_items");
    if (sessionId !== undefined) {
      result.sessionId = sessionId;
    }
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

  async postMessage(baseUrl: string, serviceKey: string, input: BotifiedMessageInput): Promise<BotifiedMessageResult> {
    const body = await this.requestJson(baseUrl, "/v1/messages", {
      method: "POST",
      serviceKey,
      body: JSON.stringify({ client_message_id: input.messageId, text: input.text }),
      headers: { "content-type": "application/json" }
    });
    return messageResultFromBody(input, body);
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
    return abortResultFromBody(body);
  }

  async *streamLlmTextPreview(
    baseUrl: string,
    serviceKey: string,
    options: BotifiedLlmTextPreviewOptions = {}
  ): AsyncIterable<BotifiedLlmTextPreviewFrame> {
    const response = await this.#fetchImpl(buildUrl(baseUrl, llmTextPreviewPath(options)), {
      method: "GET",
      headers: authHeaders(serviceKey),
      ...(options.signal ? { signal:options.signal } : {})
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
      signal?:AbortSignal;
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
      signal: input.signal
        ?AbortSignal.any([input.signal,AbortSignal.timeout(this.#requestTimeoutMs)])
        :AbortSignal.timeout(this.#requestTimeoutMs)
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
  async health(_baseUrl?:string,_serviceKey?:string,_signal?:AbortSignal): Promise<{ status: "ok" }> {
    return { status: "ok" };
  }

  async readState(_baseUrl?:string,_serviceKey?:string,_signal?:AbortSignal): Promise<BotifiedRuntimeStateResult> {
    return { snapshot: {}, state: "idle" };
  }

  async postMessage(_baseUrl:string,_serviceKey:string,input:BotifiedMessageInput): Promise<BotifiedMessageResult> {
    return {
      type:"ordinary",
      kind:"input_queued",
      inputId:input.messageId,
      messageId:input.messageId,
      timelineCursor:"dry-run",
      queueLength:1,
      state:"idle"
    };
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

  async abort(_baseUrl:string,_serviceKey:string): Promise<BotifiedAbortResult> {
    return { ok:true,state:"aborting",queueLength:0 };
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

function authHeaders(serviceKey:string,initial?:HeadersInit):Headers {
  const headers = new Headers(initial);
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

function messageResultFromBody(input:BotifiedMessageInput,body:unknown):BotifiedMessageResult {
  if (input.text.trimStart().startsWith("/")) {
    return { type:"slash",response:body };
  }
  const record = asRecord(body);
  if (!record) {
    throw invalidMessageResponse(body);
  }
  const kind=stringField(record,"kind");
  const inputId=requiredStringField(record,"input_id");
  const messageId = requiredStringField(record, "message_id");
  const timelineCursor = requiredStringField(record, "timeline_cursor");
  const queueLength=numberField(record,"queue_length");
  const state=stringField(record,"state");
  if(record?.ok!==true||
    !kind||!["input_accepted","input_queued","input_duplicate"].includes(kind)||
    !inputId||messageId!==input.messageId||!timelineCursor||
    queueLength===undefined||!Number.isInteger(queueLength)||queueLength<0||
    !state||!["idle","running","aborting","failed"].includes(state)){
    throw invalidMessageResponse(body);
  }
  return {
    type:"ordinary",
    kind:kind as BotifiedOrdinaryMessageResult["kind"],
    inputId,
    messageId,
    timelineCursor,
    queueLength,
    state:state as BotifiedOrdinaryMessageResult["state"]
  };
}

function abortResultFromBody(body:unknown):BotifiedAbortResult {
  const record=asRecord(body);
  const state=stringField(record,"state");
  const queueLength=numberField(record,"queue_length");
  if(record?.ok!==true||!state||!["idle","running","aborting","failed"].includes(state)||
    queueLength===undefined||!Number.isInteger(queueLength)||queueLength<0){
    throw new BotifiedHttpError({
      status:200,code:"invalid_abort_response",message:"Botified abort response was invalid",
      retryable:true,responseBody:body
    });
  }
  return{ok:record.ok,state:state as BotifiedAbortResult["state"],queueLength};
}

function invalidMessageResponse(body:unknown):BotifiedHttpError {
  return new BotifiedHttpError({
    status:200,
    code:"invalid_message_response",
    message:"Botified ordinary message response was invalid",
    retryable:true,
    responseBody:body
  });
}

function requiredStringField(record:Record<string,unknown>,key:string):string|undefined {
  const value=record[key];
  return typeof value==="string"&&value.length>0?value:undefined;
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
