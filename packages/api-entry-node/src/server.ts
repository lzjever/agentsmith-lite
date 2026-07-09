import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createHmac, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInMemoryProductStore } from "../../adapters-postgres/src/inMemoryProductStore.js";
import {
  DEFAULT_SESSION_SECRET,
  createApplicationServices,
  requireLiveSandboxBuiltinAdminPassword,
  requireLiveSandboxSessionSecret
} from "../../application/src/factory.js";
import type { SandboxLifecycleKubernetesPort } from "../../application/src/sandboxLifecycleService.js";
import type { BotifiedServiceKeyInput, BotifiedTaskAddressInput, ModelCaReference, TaskLiveSandboxConfig } from "../../application/src/taskService.js";
import type { ChatMessage, CreateEndpointInput, ModelEndpoint, PublicModelEndpoint, UploadProjectFileInput } from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";
import type { ModelCredentialResolver, OpenAICompatibleClient } from "../../openai-compatible-client/src/index.js";
import type { BotifiedRuntimeHttpClient } from "../../ports/src/botified.js";
import type { ProductStore } from "../../ports/src/store.js";
import type { AuthMode } from "./runtimeConfig.js";
import type { OidcClientAdapter } from "./oidcClient.js";

export interface ApiServerOptions {
  port: number;
  dataRoot: string;
  authMode?: AuthMode;
  builtinAdminPassword: string;
  sessionSecret?: string;
  publicBaseUrl?: string;
  oidcClient?: OidcClientAdapter;
  namespace?: string;
  pvcName?: string;
  botifiedRunnerImage?: string;
  botifiedClient?: BotifiedRuntimeHttpClient;
  botifiedServiceKeyFactory?: (input: BotifiedServiceKeyInput) => string | undefined;
  botifiedBaseUrlForTask?: (input: BotifiedTaskAddressInput) => string;
  chatClient?: OpenAICompatibleClient;
  modelCredentialResolver?: ModelCredentialResolver;
  modelCa?: ModelCaReference;
  liveSandbox?: TaskLiveSandboxConfig;
  sandboxLifecyclePort?: SandboxLifecycleKubernetesPort;
  sandboxNamespaceLimit?: number;
  liveSandboxMaxLifetimeMs?: number;
  liveSandboxIdleTimeoutMs?: number;
  runtimeTickIntervalMs?: number;
  store?: ProductStore;
}

export interface RunningApiServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function createApiServer(options: ApiServerOptions): Promise<RunningApiServer> {
  const authMode = options.authMode ?? "builtin_admin";
  if (authMode === "oidc" && !options.oidcClient) {
    throw new Error("OIDC client is required when AUTH_MODE=oidc");
  }
  if (options.liveSandbox && !process.env.POSTGRES_APP_URL?.trim()) {
    throw new Error("POSTGRES_APP_URL is required when AGENTSMITH_LITE_SANDBOX_MODE=live");
  }
  if (options.liveSandbox) {
    if (authMode === "builtin_admin") {
      requireLiveSandboxBuiltinAdminPassword(options.builtinAdminPassword);
    }
    requireLiveSandboxSessionSecret(options.sessionSecret);
  }
  await mkdir(options.dataRoot, { recursive: true });
  const store = options.store ?? createInMemoryProductStore();
  const effectiveSessionSecret = options.sessionSecret ?? DEFAULT_SESSION_SECRET;
  const serviceOptions = {
    store,
    dataRoot: options.dataRoot,
    builtinAdminPassword: options.builtinAdminPassword,
    sessionSecret: effectiveSessionSecret,
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.pvcName ? { pvcName: options.pvcName } : {}),
    ...(options.botifiedRunnerImage ? { botifiedRunnerImage: options.botifiedRunnerImage } : {}),
    ...(options.botifiedClient ? { botifiedClient: options.botifiedClient } : {}),
    ...(options.botifiedServiceKeyFactory ? { botifiedServiceKeyFactory: options.botifiedServiceKeyFactory } : {}),
    ...(options.botifiedBaseUrlForTask ? { botifiedBaseUrlForTask: options.botifiedBaseUrlForTask } : {}),
    ...(options.chatClient ? { chatClient: options.chatClient } : {}),
    ...(options.modelCredentialResolver ? { modelCredentialResolver: options.modelCredentialResolver } : {}),
    ...(options.modelCa ? { modelCa: options.modelCa } : {}),
    ...(options.sandboxLifecyclePort ? { sandboxLifecyclePort: options.sandboxLifecyclePort } : {}),
    ...(options.liveSandboxMaxLifetimeMs !== undefined ? { liveSandboxMaxLifetimeMs: options.liveSandboxMaxLifetimeMs } : {}),
    ...(options.liveSandboxIdleTimeoutMs !== undefined ? { liveSandboxIdleTimeoutMs: options.liveSandboxIdleTimeoutMs } : {}),
    ...(options.sandboxNamespaceLimit !== undefined ? { sandboxNamespaceLimit: options.sandboxNamespaceLimit } : {}),
    ...(options.runtimeTickIntervalMs !== undefined ? { runtimeTickIntervalMs: options.runtimeTickIntervalMs } : {}),
    requireBuiltinAdminPasswordForLiveSandbox: authMode === "builtin_admin",
    ...(options.liveSandbox ? { liveSandbox: options.liveSandbox } : {})
  };
  const services = createApplicationServices(serviceOptions);

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      if (requestUrl.pathname.startsWith("/api/")) {
        await routeApi(req, res, requestUrl, services, {
          authMode,
          bootstrapPassword: options.builtinAdminPassword,
          sessionSecret: effectiveSessionSecret,
          ...(options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {}),
          ...(options.oidcClient ? { oidcClient: options.oidcClient } : {})
        });
      } else {
        await serveWeb(req, res, requestUrl);
      }
    } catch (error) {
      handleError(res, error);
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("API server did not expose a TCP address");
  }
  if (options.liveSandbox) {
    services.runtime.startLoop();
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      services.runtime.stopLoop();
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

type Services = ReturnType<typeof createApplicationServices>;

interface AuthRouteContext {
  authMode: AuthMode;
  bootstrapPassword: string;
  sessionSecret: string;
  publicBaseUrl?: string;
  oidcClient?: OidcClientAdapter;
}

async function routeApi(req: IncomingMessage, res: ServerResponse, url: URL, services: Services, auth: AuthRouteContext): Promise<void> {
  const method = req.method ?? "GET";
  const segments = url.pathname.split("/").filter(Boolean);

  if (method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { status: "ok", version: "0.1.0" });
  }

  if (method === "GET" && url.pathname === "/api/bootstrap") {
    return sendJson(res, 200, { authMode: auth.authMode, hasAdmin: await services.auth.hasAnyUser() });
  }

  if (method === "POST" && url.pathname === "/api/auth/bootstrap") {
    if (auth.authMode !== "builtin_admin") {
      throw new ProductError("Route not found", 404);
    }
    const body = await readJson(req);
    if (body.password !== auth.bootstrapPassword) {
      throw new ProductError("Bootstrap password does not match configured admin password", 403);
    }
    return sendJson(res, 200, await services.auth.bootstrapBuiltInAdmin());
  }

  if (method === "POST" && url.pathname === "/api/auth/login") {
    if (auth.authMode !== "builtin_admin") {
      throw new ProductError("Route not found", 404);
    }
    const body = await readJson(req);
    const result = await services.auth.login(asString(body.email), asString(body.password));
    res.setHeader("set-cookie", [
      `asl_session=${result.sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`
    ]);
    return sendJson(res, 200, result);
  }

  if (method === "GET" && url.pathname === "/api/auth/oidc/start") {
    if (auth.authMode !== "oidc" || !auth.oidcClient) {
      throw new ProductError("Route not found", 404);
    }
    const redirectUri = oidcRedirectUri(req, auth.publicBaseUrl);
    const authorization = await auth.oidcClient.createAuthorizationRequest({ redirectUri });
    res.setHeader("set-cookie", [
      `asl_oidc_tx=${encodeOidcTransaction({
        state: authorization.state,
        codeVerifier: authorization.codeVerifier,
        nonce: authorization.nonce,
        redirectUri,
        createdAt: Date.now()
      }, auth.sessionSecret)}; HttpOnly; SameSite=Lax; Path=/api/auth/oidc; Max-Age=600`
    ]);
    return sendRedirect(res, 302, authorization.authorizationUrl);
  }

  if (method === "GET" && url.pathname === "/api/auth/oidc/callback") {
    if (auth.authMode !== "oidc" || !auth.oidcClient) {
      throw new ProductError("Route not found", 404);
    }
    const transaction = decodeOidcTransaction(getCookie(req, "asl_oidc_tx"), auth.sessionSecret);
    const result = await services.auth.loginExternalPrincipal(await auth.oidcClient.completeAuthorizationCallback({
      callbackUrl: `${transaction.redirectUri}${url.search}`,
      redirectUri: transaction.redirectUri,
      state: transaction.state,
      codeVerifier: transaction.codeVerifier,
      nonce: transaction.nonce
    }));
    res.setHeader("set-cookie", [
      `asl_session=${result.sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`,
      "asl_oidc_tx=; HttpOnly; SameSite=Lax; Path=/api/auth/oidc; Max-Age=0"
    ]);
    return sendRedirect(res, 302, "/");
  }

  const sessionId = getCookie(req, "asl_session");
  const sessionPrincipal = await services.auth.requireSessionPrincipal(sessionId);
  const user = sessionPrincipal.user;
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    await services.auth.requireCsrf(sessionId, req.headers["x-csrf-token"]?.toString() ?? null);
  }

  if (method === "GET" && url.pathname === "/api/me") {
    return sendJson(res, 200, { user, csrfToken: sessionPrincipal.csrfToken });
  }

  if (method === "POST" && url.pathname === "/api/auth/logout") {
    res.setHeader("set-cookie", [
      "asl_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    ]);
    return sendJson(res, 200, { loggedOut: true });
  }

  if (method === "GET" && url.pathname === "/api/dashboard") {
    const dashboard = await services.dashboard(user.id);
    return sendJson(res, 200, {
      health: { status: "ok", version: "0.1.0" },
      user,
      ...dashboard,
      endpoints: dashboard.endpoints.map(toPublicEndpoint)
    });
  }

  if (segments[0] === "api" && segments[1] === "operator" && segments[2] === "sandbox") {
    requireAdmin(user);
    if (segments[3] === "status" && method === "GET") {
      const runId = url.searchParams.get("runId");
      return sendJson(res, 200, await services.sandboxLifecycle.getSandboxStatus(runId ? { runId } : {}));
    }
    if (segments[3] === "reap" && method === "POST") {
      const body = await readJson(req);
      return sendJson(res, 200, await services.sandboxLifecycle.reapSandboxRunsOnce({
        ...(typeof body.runId === "string" ? { runId: body.runId } : {}),
        apply: body.apply === true,
        dryRun: body.apply !== true
      }));
    }
  }

  if (method === "GET" && url.pathname === "/api/workspaces") {
    return sendJson(res, 200, await services.workspaces.listWorkspaces(user.id));
  }

  if (method === "POST" && url.pathname === "/api/workspaces") {
    const body = await readJson(req);
    return sendJson(res, 200, await services.workspaces.createWorkspace(user.id, { name: asString(body.name) }));
  }

  if (segments[0] === "api" && segments[1] === "workspaces" && segments[2] && segments[3] === "projects") {
    const workspaceId = segments[2];
    if (method === "POST") {
      const body = await readJson(req);
      return sendJson(res, 200, await services.workspaces.createProject(user.id, workspaceId, {
        name: asString(body.name),
        ...(typeof body.taskConcurrencyLimit === "number" ? { taskConcurrencyLimit: body.taskConcurrencyLimit } : {})
      }));
    }
  }

  if (segments[0] === "api" && segments[1] === "projects" && segments[2]) {
    const projectId = segments[2];
    if (segments[3] === "endpoints") {
      if (method === "GET") {
        const endpoints = await services.endpoints.listEndpoints(user.id, projectId);
        return sendJson(res, 200, endpoints.map(toPublicEndpoint));
      }
      if (method === "POST") {
        const endpoint = await services.endpoints.createEndpoint(user.id, projectId, asEndpointInput(await readJson(req)));
        return sendJson(res, 200, toPublicEndpoint(endpoint));
      }
    }
    if (segments[3] === "chat" && method === "POST") {
      const body = await readJson(req);
      return sendJson(res, 200, await services.chat.sendChat(user.id, projectId, asString(body.endpointId), asMessages(body.messages)));
    }
    if (segments[3] === "files") {
      const project = await services.workspaces.requireProjectForUser(user.id, projectId);
      const projectRoot = services.projectAbsoluteRoot(project.rootPath);

      if (segments[4] === "validate" && method === "POST") {
        const body = await readJson(req);
        const resolved = await services.files.resolveProjectFilesPath(projectRoot, asString(body.path), { allowFilesRoot: true });
        return sendJson(res, 200, { normalizedPath: resolved.normalizedPath, absolutePath: resolved.absolutePath });
      }
      if (!segments[4] && method === "GET") {
        return sendJson(res, 200, await services.files.listFiles(projectRoot, url.searchParams.get("path") ?? "files"));
      }
      if (!segments[4] && method === "POST") {
        return sendJson(res, 200, await services.files.uploadTextFile(projectRoot, asUploadProjectFileInput(await readJson(req))));
      }
      if (!segments[4] && method === "DELETE") {
        const body = await readJson(req);
        return sendJson(res, 200, await services.files.deleteFile(projectRoot, asString(body.path)));
      }
      if (segments[4] === "download" && method === "GET") {
        return sendJson(res, 200, await services.files.downloadTextFile(projectRoot, requiredSearchParam(url, "path")));
      }
    }
    if (segments[3] === "tasks") {
      if (method === "GET") {
        return sendJson(res, 200, await services.tasks.listTasks(user.id, projectId));
      }
      if (method === "POST") {
        const body = await readJson(req);
        return sendJson(res, 200, await services.tasks.createTask(user.id, projectId, {
          prompt: asString(body.prompt),
          endpointId: asString(body.endpointId)
        }));
      }
    }
  }

  if (segments[0] === "api" && segments[1] === "tasks" && segments[2]) {
    const taskId = segments[2];
    if (segments[3] === "events" && method === "GET") {
      try {
        return sendJson(res, 200, await services.tasks.listTaskEvents(user.id, taskId));
      } catch (error) {
        return handleTaskRouteError(res, error);
      }
    }
    if (segments[3] === "artifacts" && segments[4] && segments[5] === "download" && method === "GET") {
      try {
        return sendArtifactDownload(res, await services.tasks.downloadTaskArtifact(user.id, taskId, segments[4]));
      } catch (error) {
        return handleTaskRouteError(res, error);
      }
    }
    if (segments[3] === "artifacts" && !segments[4] && method === "GET") {
      try {
        return sendJson(res, 200, await services.tasks.listTaskArtifacts(user.id, taskId));
      } catch (error) {
        return handleTaskRouteError(res, error);
      }
    }
    if (segments[3] === "cancel" && method === "POST") {
      try {
        return sendJson(res, 200, await services.tasks.cancelTask(user.id, taskId));
      } catch (error) {
        return handleTaskRouteError(res, error);
      }
    }
  }

  throw new ProductError("Route not found", 404);
}

async function serveWeb(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const webRoot = findWebRoot();
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const safe = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(webRoot, safe);
  const contentType = contentTypeFor(filePath);
  res.writeHead(200, { "content-type": contentType });
  await new Promise<void>((resolve, reject) => {
    createReadStream(filePath)
      .on("error", reject)
      .on("end", resolve)
      .pipe(res);
  });
}

function findWebRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "dist/src/web"),
    path.resolve(process.cwd(), "src/web"),
    path.resolve(here, "../../../src/web")
  ];
  return candidates.find((candidate) => candidate && candidate.length > 0) ?? path.resolve("src/web");
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/html; charset=utf-8";
}

function headerFilename(input: string): string {
  const cleaned = input
    .replace(/[\r\n"\\]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_")
    .trim();
  return cleaned.length > 0 ? cleaned : "artifact";
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProductError("JSON object body is required");
  }
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendRedirect(res: ServerResponse, status: 302, location: string): void {
  res.writeHead(status, { location });
  res.end();
}

function sendArtifactDownload(
  res: ServerResponse,
  download: Awaited<ReturnType<Services["tasks"]["downloadTaskArtifact"]>>
): void {
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(download.bytes.byteLength),
    "content-disposition": `attachment; filename="${headerFilename(download.artifact.name || download.artifact.fileId)}"`,
    "x-content-type-options": "nosniff"
  });
  res.end(download.bytes);
}

function toPublicEndpoint(endpoint: ModelEndpoint): PublicModelEndpoint {
  const { apiKeySecretRef: _apiKeySecretRef, ...publicEndpoint } = endpoint;
  return {
    ...publicEndpoint,
    hasCredentialRef: true
  };
}

function handleError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const statusCode = error instanceof ProductError ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : "Internal server error";
  sendJson(res, statusCode, { error: message });
}

function handleTaskRouteError(res: ServerResponse, error: unknown): void {
  if (isStructuredTaskError(error)) {
    return sendJson(res, error.statusCode, {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...error.details
      }
    });
  }
  return handleError(res, error);
}

function isStructuredTaskError(error: unknown): error is ProductError & {
  code: string;
  retryable: boolean;
  details: Record<string, unknown>;
} {
  return error instanceof ProductError &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { retryable?: unknown }).retryable === "boolean" &&
    typeof (error as { details?: unknown }).details === "object" &&
    (error as { details?: unknown }).details !== null;
}

function getCookie(req: IncomingMessage, name: string): string | null {
  const cookie = req.headers.cookie;
  if (!cookie) {
    return null;
  }
  for (const part of cookie.split(";")) {
    const [key, value] = part.trim().split("=");
    if (key === name && value) {
      return value;
    }
  }
  return null;
}

function asString(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProductError("Expected string field");
  }
  return value;
}

function requireAdmin(user: { role: string }): void {
  if (user.role !== "admin") {
    throw new ProductError("Admin role is required", 403);
  }
}

function requiredSearchParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null) {
    throw new ProductError(`Missing ${name} query parameter`);
  }
  return value;
}

interface OidcTransaction {
  state: string;
  codeVerifier: string;
  nonce?: string | undefined;
  redirectUri: string;
  createdAt: number;
}

function encodeOidcTransaction(transaction: OidcTransaction, sessionSecret: string): string {
  const payload = Buffer.from(JSON.stringify(transaction), "utf8").toString("base64url");
  return `${payload}.${sign(payload, sessionSecret)}`;
}

function decodeOidcTransaction(value: string | null, sessionSecret: string): OidcTransaction {
  if (!value) {
    throw new ProductError("OIDC login transaction is required", 403);
  }
  const [payload, signature] = value.split(".");
  if (!payload || !signature || !constantTimeEqual(signature, sign(payload, sessionSecret))) {
    throw new ProductError("OIDC login transaction is invalid", 403);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new ProductError("OIDC login transaction is invalid", 403);
  }
  if (!isOidcTransaction(parsed) || Date.now() - parsed.createdAt > 10 * 60 * 1000) {
    throw new ProductError("OIDC login transaction is invalid", 403);
  }
  return parsed;
}

function sign(payload: string, sessionSecret: string): string {
  return createHmac("sha256", sessionSecret).update(payload).digest("base64url");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isOidcTransaction(value: unknown): value is OidcTransaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.state === "string" &&
    candidate.state.length > 0 &&
    typeof candidate.codeVerifier === "string" &&
    candidate.codeVerifier.length > 0 &&
    (candidate.nonce === undefined || typeof candidate.nonce === "string") &&
    typeof candidate.redirectUri === "string" &&
    candidate.redirectUri.length > 0 &&
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt);
}

function oidcRedirectUri(req: IncomingMessage, publicBaseUrl: string | undefined): string {
  const baseUrl = publicBaseUrl?.trim() || requestOrigin(req);
  const parsed = new URL(baseUrl);
  const prefix = parsed.pathname.replace(/\/$/, "");
  parsed.pathname = `${prefix}/api/auth/oidc/callback`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function requestOrigin(req: IncomingMessage): string {
  const protocol = firstHeaderValue(req.headers["x-forwarded-proto"]) ?? "http";
  const host = firstHeaderValue(req.headers["x-forwarded-host"]) ?? req.headers.host;
  if (!host) {
    throw new ProductError("Host header is required");
  }
  return `${protocol}://${host}`;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function asUploadProjectFileInput(body: Record<string, unknown>): UploadProjectFileInput {
  return {
    path: asString(body.path),
    content: asString(body.content)
  };
}

function asMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) {
    throw new ProductError("messages must be an array");
  }
  return value.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new ProductError("message must be an object");
    }
    const candidate = message as Record<string, unknown>;
    const role = asString(candidate.role);
    if (role !== "system" && role !== "user" && role !== "assistant") {
      throw new ProductError("message role is invalid");
    }
    return { role, content: asString(candidate.content) };
  });
}

function asEndpointInput(body: Record<string, unknown>): CreateEndpointInput {
  const protocol = asString(body.protocol);
  if (protocol !== "openai_chat_completions") {
    throw new ProductError("Only openai_chat_completions endpoints are supported");
  }
  if (!Array.isArray(body.capabilities) || !body.capabilities.every((item) => item === "text" || item === "image" || item === "tool_calls")) {
    throw new ProductError("Endpoint capabilities are invalid");
  }
  if (typeof body.requestTimeoutSecs !== "number") {
    throw new ProductError("Endpoint requestTimeoutSecs is required");
  }
  return {
    name: asString(body.name),
    protocol,
    baseUrl: asString(body.baseUrl),
    model: asString(body.model),
    apiKeySecretRef: asString(body.apiKeySecretRef),
    capabilities: body.capabilities,
    requestTimeoutSecs: body.requestTimeoutSecs
  };
}
