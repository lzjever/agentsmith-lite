import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInMemoryProductStore } from "../../adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../application/src/factory.js";
import type { ChatMessage, CreateEndpointInput } from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";

export interface ApiServerOptions {
  port: number;
  dataRoot: string;
  builtinAdminPassword: string;
  sessionSecret?: string;
  namespace?: string;
  pvcName?: string;
  botifiedRunnerImage?: string;
}

export interface RunningApiServer {
  baseUrl: string;
  close(): Promise<void>;
}

export async function createApiServer(options: ApiServerOptions): Promise<RunningApiServer> {
  await mkdir(options.dataRoot, { recursive: true });
  const store = createInMemoryProductStore();
  const serviceOptions = {
    store,
    dataRoot: options.dataRoot,
    builtinAdminPassword: options.builtinAdminPassword,
    ...(options.sessionSecret ? { sessionSecret: options.sessionSecret } : {}),
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.pvcName ? { pvcName: options.pvcName } : {}),
    ...(options.botifiedRunnerImage ? { botifiedRunnerImage: options.botifiedRunnerImage } : {})
  };
  const services = createApplicationServices(serviceOptions);

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      if (requestUrl.pathname.startsWith("/api/")) {
        await routeApi(req, res, requestUrl, services, options.builtinAdminPassword);
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
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

type Services = ReturnType<typeof createApplicationServices>;

async function routeApi(req: IncomingMessage, res: ServerResponse, url: URL, services: Services, bootstrapPassword: string): Promise<void> {
  const method = req.method ?? "GET";
  const segments = url.pathname.split("/").filter(Boolean);

  if (method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { status: "ok", version: "0.1.0" });
  }

  if (method === "GET" && url.pathname === "/api/bootstrap") {
    return sendJson(res, 200, { authMode: "builtin_admin", hasAdmin: true });
  }

  if (method === "POST" && url.pathname === "/api/auth/bootstrap") {
    const body = await readJson(req);
    if (body.password !== bootstrapPassword) {
      throw new ProductError("Bootstrap password does not match configured admin password", 403);
    }
    return sendJson(res, 200, await services.auth.bootstrapBuiltInAdmin());
  }

  if (method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(req);
    const result = await services.auth.login(asString(body.email), asString(body.password));
    res.setHeader("set-cookie", [
      `asl_session=${result.sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`
    ]);
    return sendJson(res, 200, result);
  }

  const sessionId = getCookie(req, "asl_session");
  const user = await services.auth.requireSession(sessionId);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    await services.auth.requireCsrf(sessionId, req.headers["x-csrf-token"]?.toString() ?? null);
  }

  if (method === "GET" && url.pathname === "/api/me") {
    return sendJson(res, 200, { user });
  }

  if (method === "GET" && url.pathname === "/api/dashboard") {
    const dashboard = await services.dashboard(user.id);
    return sendJson(res, 200, {
      health: { status: "ok", version: "0.1.0" },
      user,
      ...dashboard
    });
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
        return sendJson(res, 200, await services.endpoints.listEndpoints(user.id, projectId));
      }
      if (method === "POST") {
        return sendJson(res, 200, await services.endpoints.createEndpoint(user.id, projectId, asEndpointInput(await readJson(req))));
      }
    }
    if (segments[3] === "chat" && method === "POST") {
      const body = await readJson(req);
      return sendJson(res, 200, await services.chat.sendChat(user.id, projectId, asString(body.endpointId), asMessages(body.messages)));
    }
    if (segments[3] === "files" && segments[4] === "validate" && method === "POST") {
      const body = await readJson(req);
      const project = await services.workspaces.requireProjectForUser(user.id, projectId);
      const normalizedPath = services.files.normalizeRelativeProjectPath(asString(body.path));
      const absolutePath = await services.files.resolveSafeProjectPath(services.projectAbsoluteRoot(project.rootPath), normalizedPath);
      return sendJson(res, 200, { normalizedPath, absolutePath });
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
    if (segments[3] === "cancel" && method === "POST") {
      return sendJson(res, 200, await services.tasks.cancelTask(user.id, taskId));
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

function handleError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const statusCode = error instanceof ProductError ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : "Internal server error";
  sendJson(res, statusCode, { error: message });
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
