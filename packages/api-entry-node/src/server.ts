import { mkdir } from "node:fs/promises";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { createInMemoryProductStore } from "../../adapters-postgres/src/inMemoryProductStore.js";
import {
  DEFAULT_SESSION_SECRET,
  createApplicationServices,
  requireLiveSandboxBuiltinAdminPassword,
  requireLiveSandboxSessionSecret
} from "../../application/src/factory.js";
import type { SandboxLifecycleKubernetesPort } from "../../application/src/sandboxLifecycleService.js";
import type { CredentialCrypto } from "../../application/src/credentialCrypto.js";
import type { BotifiedServiceKeyInput, BotifiedTaskAddressInput, ModelCaReference, TaskLiveSandboxConfig } from "../../application/src/taskService.js";
import { PROJECT_AUDIT_ACTIONS, PROJECT_AUDIT_RESOURCE_KINDS, type ChatMessage, type CreateEndpointInput, type DiscoverEndpointModelsInput, type ManagedProjectMembershipRole, type ManagedWorkspaceMembershipRole, type ModelEndpoint, type ProjectContextScope, type PublicModelEndpoint, type TaskListQuery, type UpdateEndpointInput } from "../../contracts/src/api.js";
import type { ContextContentType } from "../../application/src/contextService.js";
import { ProductError } from "../../domain/src/errors.js";
import { MAX_PROJECT_FILE_BYTES } from "../../domain/src/fileDefaults.js";
import { FetchOpenAICompatibleClient, type OpenAICompatibleClient } from "../../openai-compatible-client/src/index.js";
import type { BotifiedRuntimeHttpClient } from "../../ports/src/botified.js";
import type { ProductStore } from "../../ports/src/store.js";
import type { OidcClientAdapter } from "./oidcClient.js";
import { WebSocket, WebSocketServer } from "ws";

interface CommonApiServerOptions {
  port: number;
  host?: string;
  dataRoot: string;
  sessionSecret?: string;
  credentialCrypto?: CredentialCrypto;
  publicBaseUrl?: string;
  publicBasePath?: string;
  oidcClient?: OidcClientAdapter;
  namespace?: string;
  pvcName?: string;
  botifiedRunnerImage?: string;
  botifiedClient?: BotifiedRuntimeHttpClient;
  botifiedServiceKeyFactory?: (input: BotifiedServiceKeyInput) => string | undefined;
  botifiedBaseUrlForTask?: (input: BotifiedTaskAddressInput) => string;
  providerClient?: OpenAICompatibleClient;
  modelCa?: ModelCaReference;
  liveSandbox?: TaskLiveSandboxConfig;
  sandboxLifecyclePort?: SandboxLifecycleKubernetesPort;
  sandboxNamespaceLimit?: number;
  liveSandboxMaxLifetimeMs?: number;
  liveSandboxIdleTimeoutMs?: number;
  taskDeliveryLeaseMs?: number;
  taskMaintenanceLeaseMs?: number;
  taskRetryDelayMs?: number;
  runtimeTickIntervalMs?: number;
  store?: ProductStore;
}

export interface ApiServerOptions extends CommonApiServerOptions {
  oidcClient: OidcClientAdapter;
}

export interface TestApiServerOptions extends CommonApiServerOptions {
  builtinAdminPassword: string;
}

export interface RunningApiServer {
  baseUrl: string;
  listenAddress: string;
  close(): Promise<void>;
}

export async function createApiServer(options: ApiServerOptions): Promise<RunningApiServer> {
  if (!options.oidcClient) {
    throw new Error("OIDC client is required for the production API server");
  }
  return startApiServer({
    ...options,
    authMode: "oidc",
    builtinAdminPassword: ""
  });
}

export async function createTestApiServer(options: TestApiServerOptions): Promise<RunningApiServer> {
  return startApiServer({
    ...options,
    authMode: "builtin_admin"
  });
}

interface ResolvedApiServerOptions extends CommonApiServerOptions {
  authMode: "builtin_admin" | "oidc";
  builtinAdminPassword: string;
  oidcClient?: OidcClientAdapter;
}

async function startApiServer(options: ResolvedApiServerOptions): Promise<RunningApiServer> {
  const authMode = options.authMode;
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
  const providerClient = options.providerClient ?? new FetchOpenAICompatibleClient();
  const effectiveSessionSecret = options.sessionSecret ?? DEFAULT_SESSION_SECRET;
  const serviceOptions = {
    store,
    dataRoot: options.dataRoot,
    builtinAdminPassword: options.builtinAdminPassword,
    sessionSecret: effectiveSessionSecret,
    ...(options.credentialCrypto ? { credentialCrypto: options.credentialCrypto } : {}),
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.pvcName ? { pvcName: options.pvcName } : {}),
    ...(options.botifiedRunnerImage ? { botifiedRunnerImage: options.botifiedRunnerImage } : {}),
    ...(options.botifiedClient ? { botifiedClient: options.botifiedClient } : {}),
    ...(options.botifiedServiceKeyFactory ? { botifiedServiceKeyFactory: options.botifiedServiceKeyFactory } : {}),
    ...(options.botifiedBaseUrlForTask ? { botifiedBaseUrlForTask: options.botifiedBaseUrlForTask } : {}),
    providerClient,
    ...(options.modelCa ? { modelCa: options.modelCa } : {}),
    ...(options.sandboxLifecyclePort ? { sandboxLifecyclePort: options.sandboxLifecyclePort } : {}),
    ...(options.liveSandboxMaxLifetimeMs !== undefined ? { liveSandboxMaxLifetimeMs: options.liveSandboxMaxLifetimeMs } : {}),
    ...(options.liveSandboxIdleTimeoutMs !== undefined ? { liveSandboxIdleTimeoutMs: options.liveSandboxIdleTimeoutMs } : {}),
    ...(options.taskDeliveryLeaseMs !== undefined ? { taskDeliveryLeaseMs: options.taskDeliveryLeaseMs } : {}),
    ...(options.taskMaintenanceLeaseMs !== undefined ? { taskMaintenanceLeaseMs: options.taskMaintenanceLeaseMs } : {}),
    ...(options.taskRetryDelayMs !== undefined ? { taskRetryDelayMs: options.taskRetryDelayMs } : {}),
    ...(options.sandboxNamespaceLimit !== undefined ? { sandboxNamespaceLimit: options.sandboxNamespaceLimit } : {}),
    ...(options.runtimeTickIntervalMs !== undefined ? { runtimeTickIntervalMs: options.runtimeTickIntervalMs } : {}),
    requireBuiltinAdminPasswordForLiveSandbox: authMode === "builtin_admin",
    ...(options.liveSandbox ? { liveSandbox: options.liveSandbox } : {})
  };
  const services = createApplicationServices(serviceOptions);
  await services.credentials.importLegacyAliasesFromEnvironment(process.env);
  const appBasePath = appBasePathFromOptions(options.publicBaseUrl, options.publicBasePath);

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      // Sandboxes call this internal route through the ClusterIP Service. It must not
      // inherit a public ingress mount path such as /app.
      const routedUrl = brokerRouteFor(requestUrl.pathname)
        ? requestUrl
        : routeUrlForAppBasePath(requestUrl, appBasePath);
      if (!routedUrl) {
        throw new ProductError("Route not found", 404);
      }
      if (routedUrl.pathname === "/api" || routedUrl.pathname.startsWith("/api/")) {
        await routeApi(req, res, routedUrl, services, {
          authMode,
          bootstrapPassword: options.builtinAdminPassword,
          sessionSecret: effectiveSessionSecret,
          appBasePath,
          secureCookies: publicBaseUrlUsesHttps(options.publicBaseUrl),
          ...(options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {}),
          ...(options.oidcClient ? { oidcClient: options.oidcClient } : {})
        });
      } else {
        throw new ProductError("Route not found", 404);
      }
    } catch (error) {
      handleError(res, error);
    }
  });
  const terminalSockets=new WebSocketServer({noServer:true});
  server.on("upgrade",(req,socket,head)=>{
    void (async()=>{
      let terminalTaskId:string|null=null;
      let terminalAcquired=false;
      try{
        const requestUrl=new URL(req.url??"/","http://localhost");
        const routed=routeUrlForAppBasePath(requestUrl,appBasePath);
        const match=routed?.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/terminal\/ws$/);
        if(!match)throw new ProductError("Route not found",404);
        if(options.publicBaseUrl&&req.headers.origin&&new URL(req.headers.origin).origin!==new URL(options.publicBaseUrl).origin)throw new ProductError("Terminal origin is not allowed",403);
        const principal=await services.auth.requireSessionPrincipal(getCookie(req,"asl_session"));
        terminalTaskId=decodeURIComponent(match[1]!);
        const target=await services.tasks.openTaskTerminal(principal.user.id,terminalTaskId);
        terminalAcquired=true;
        terminalSockets.handleUpgrade(req,socket,head,(client)=>{
          let released=false;
          const release=()=>{if(released)return;released=true;services.tasks.closeTaskTerminal(terminalTaskId!);};
          const upstreamUrl=new URL("/v1/terminal/ws",target.baseUrl.replace(/^http/,"ws"));
          const upstream=new WebSocket(upstreamUrl,{headers:{authorization:`Bearer ${target.serviceKey}`}});
          upstream.on("message",(data,isBinary)=>{if(client.readyState===WebSocket.OPEN)client.send(data,{binary:isBinary});});
          client.on("message",(data,isBinary)=>{if(upstream.readyState===WebSocket.OPEN)upstream.send(data,{binary:isBinary});});
          upstream.on("close",()=>{release();client.close();});
          client.on("close",()=>{release();upstream.close();});
          client.on("error",()=>{release();upstream.close();client.close();});
          upstream.on("error",()=>{release();if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify({op:"error",message:"Task terminal connection failed"}));client.close();});
        });
      }catch{if(terminalAcquired&&terminalTaskId)services.tasks.closeTaskTerminal(terminalTaskId);socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");socket.destroy();}
    })();
  });

  await new Promise<void>((resolve) => server.listen({ port: options.port, host: options.host }, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("API server did not expose a TCP address");
  }
  services.runtime.startLoop();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    listenAddress: address.address,
    close: () => new Promise((resolve, reject) => {
      services.runtime.stopLoop();
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

type Services = ReturnType<typeof createApplicationServices>;

interface AuthRouteContext {
  authMode: "builtin_admin" | "oidc";
  bootstrapPassword: string;
  sessionSecret: string;
  appBasePath: string;
  secureCookies: boolean;
  publicBaseUrl?: string;
  oidcClient?: OidcClientAdapter;
}

async function routeApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  services: Services,
  auth: AuthRouteContext
): Promise<void> {
  const method = req.method ?? "GET";
  const segments = url.pathname.split("/").filter(Boolean);

  const brokerRoute = brokerRouteFor(url.pathname);
  if (brokerRoute && method === "POST") {
    return forwardBotifiedChatCompletion(req, res, services, brokerRoute);
  }

  if (url.pathname === "/api" || !url.pathname.startsWith("/api/v1/")) {
    throw new ProductError("Route not found", 404);
  }

  if (method === "GET" && url.pathname === "/api/v1/health") {
    return sendJson(res, 200, { status: "ok", version: "0.1.0" });
  }

  if (method === "GET" && url.pathname === "/api/v1/bootstrap") {
    return sendJson(res, 200, { authMode: auth.authMode, hasAdmin: await services.auth.hasAnyUser() });
  }

  if (method === "POST" && url.pathname === "/api/v1/auth/bootstrap") {
    if (auth.authMode !== "builtin_admin") {
      throw new ProductError("Route not found", 404);
    }
    const body = await readJson(req);
    if (body.password !== auth.bootstrapPassword) {
      throw new ProductError("Bootstrap password does not match configured admin password", 403);
    }
    return sendJson(res, 200, await services.auth.bootstrapBuiltInAdmin());
  }

  if (method === "POST" && url.pathname === "/api/v1/auth/login") {
    if (auth.authMode !== "builtin_admin") {
      throw new ProductError("Route not found", 404);
    }
    const body = await readJson(req);
    const result = await services.auth.login(asString(body.email), asString(body.password));
    res.setHeader("set-cookie", [serializeAuthCookie("asl_session", result.sessionId, sessionCookiePath(auth.appBasePath), 43200, auth.secureCookies)]);
    return sendJson(res, 200, result);
  }

  if (method === "GET" && url.pathname === "/api/v1/auth/oidc/start") {
    if (auth.authMode !== "oidc" || !auth.oidcClient) {
      throw new ProductError("Route not found", 404);
    }
    const redirectUri = oidcRedirectUri(req, auth.publicBaseUrl, auth.appBasePath);
    const returnTo = oidcReturnTo(url.searchParams.get("returnTo"), auth.appBasePath);
    const authorization = await auth.oidcClient.createAuthorizationRequest({ redirectUri });
    res.setHeader("set-cookie", [serializeAuthCookie("asl_oidc_tx", encodeOidcTransaction({
        state: authorization.state,
        codeVerifier: authorization.codeVerifier,
        nonce: authorization.nonce,
        redirectUri,
        returnTo,
        createdAt: Date.now()
      }, auth.sessionSecret), oidcTransactionCookiePath(auth.appBasePath), 600, auth.secureCookies)]);
    return sendRedirect(res, 302, authorization.authorizationUrl);
  }

  if (method === "GET" && url.pathname === "/api/v1/auth/oidc/callback") {
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
      serializeAuthCookie("asl_session", result.sessionId, sessionCookiePath(auth.appBasePath), 43200, auth.secureCookies),
      serializeAuthCookie("asl_oidc_tx", "", oidcTransactionCookiePath(auth.appBasePath), 0, auth.secureCookies)
    ]);
    return sendRedirect(res, 302, transaction.returnTo ?? appHomePath(auth.appBasePath));
  }

  if (!isKnownApiRoutePath(url.pathname)) {
    throw new ProductError("Route not found", 404);
  }

  const sessionId = getCookie(req, "asl_session");
  const sessionPrincipal = await services.auth.requireSessionPrincipal(sessionId);
  const user = sessionPrincipal.user;
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    await services.auth.requireCsrf(sessionId, req.headers["x-csrf-token"]?.toString() ?? null);
  }

  if (method === "GET" && url.pathname === "/api/v1/me") {
    return sendJson(res, 200, { user, csrfToken: sessionPrincipal.csrfToken });
  }
  if (url.pathname === "/api/v1/me/profile") {
    if (method === "GET") return sendJson(res, 200, await services.profile.getProfile(user.id));
    if (method === "PATCH") return sendJson(res, 200, await services.profile.updateProfile(user.id, await readJson(req)));
  }
  if (url.pathname === "/api/v1/notifications" && method === "GET") return sendJson(res, 200, await services.notifications.list(user.id, url.searchParams.get("unread") === "true"));
  if (url.pathname === "/api/v1/notifications/read" && method === "PATCH") return sendJson(res, 200, await services.notifications.markAllRead(user.id));
  if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "notifications" && segments[3]) {
    if (segments[4] === "read" && method === "PATCH") return sendJson(res, 200, await services.notifications.markRead(user.id, segments[3]));
    if (method === "DELETE") return sendJson(res, 200, await services.notifications.dismiss(user.id, segments[3]));
  }

  if (method === "POST" && url.pathname === "/api/v1/auth/logout") {
    await services.auth.logout(sessionId);
    res.setHeader("set-cookie", [serializeAuthCookie("asl_session", "", sessionCookiePath(auth.appBasePath), 0, auth.secureCookies)]);
    return sendJson(res, 200, { loggedOut: true });
  }

  if (method === "GET" && url.pathname === "/api/v1/dashboard") {
    const dashboard = await services.dashboard(user.id);
    return sendJson(res, 200, {
      health: { status: "ok", version: "0.1.0" },
      user,
      ...dashboard,
      endpoints: dashboard.endpoints.map(toPublicEndpoint)
    });
  }

  if (method === "GET" && url.pathname === "/api/v1/workspaces") {
    return sendJson(res, 200, await services.workspaces.listWorkspaces(user.id));
  }

  if (method === "GET" && url.pathname === "/api/v1/projects") {
    const workspaces = await services.workspaces.listWorkspaces(user.id);
    return sendJson(res, 200, workspaces.flatMap((workspace) => workspace.projects));
  }

  if (url.pathname === "/api/v1/context") {
    if (method === "GET") {
      return sendJson(res, 200, await services.contexts.list(user.id, contextTargetFromQuery(url)));
    }
    if (method === "PUT") {
      const body = await readJson(req);
      return sendJson(res, 200, await services.contexts.upsert(user.id, {
        ...contextTargetFromBody(body),
        contextKey: asString(body.contextKey),
        ...(body.previousContextKey === undefined ? {} : { previousContextKey: asString(body.previousContextKey) }),
        ...(body.expectedVersion === undefined ? {} : { expectedVersion: asPositiveInteger(body.expectedVersion, "expectedVersion") }),
        content: asString(body.content),
        contentType: asContextContentType(body.contentType)
      }));
    }
    if (method === "DELETE") {
      const body = await readJson(req);
      await services.contexts.delete(user.id, { ...contextTargetFromBody(body), contextKey: asString(body.contextKey) });
      return sendJson(res, 200, { deleted: true });
    }
  }

  if (method === "POST" && url.pathname === "/api/v1/workspaces") {
    const body = await readJson(req);
    const created = await services.workspaces.createWorkspace(user.id, { name: asString(body.name) });
    const workspace = (await services.workspaces.listWorkspaces(user.id)).find((candidate) => candidate.id === created.id);
    if (!workspace) {
      throw new ProductError("Created workspace could not be loaded", 500);
    }
    return sendJson(res, 200, workspace);
  }

  if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "workspaces" && segments[3] && segments.length === 4 && method === "DELETE") {
    const workspaceId=segments[3];const result=await services.settings.runIdempotentMutation(user.id,workspaceId,"workspace.delete",requireIdempotencyKey(req),{workspaceId},workspaceId,async()=>{await services.deletion.deleteWorkspace(user.id,workspaceId);return{deleted:true as const}});
    return sendJson(res, 200, result);
  }

  if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "workspaces" && segments[3] && segments[4] === "projects") {
    const workspaceId = segments[3];
    if (method === "POST") {
      const body = await readJson(req);
      return sendJson(res, 200, await services.workspaces.createProject(user.id, workspaceId, {
        name: asString(body.name),
        ...(typeof body.taskConcurrencyLimit === "number" ? { taskConcurrencyLimit: body.taskConcurrencyLimit } : {})
      }));
    }
  }
  if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "workspaces" && segments[3] && segments[4] === "members") {
    const workspaceId = segments[3];
    if (segments[5] === "transfer-owner" && method === "POST") { const body=await readJson(req);const target=asUserId(body.userId);return sendJson(res,200,await services.settings.runIdempotentMutation(user.id,workspaceId,"workspace.owner.transfer",requireIdempotencyKey(req),{workspaceId,userId:target},workspaceId,async()=>{await services.workspaceMemberships.transferOwner(user.id,workspaceId,target);return{transferred:true as const}})); }
    if (!segments[5] && method === "GET") return sendJson(res, 200, await services.workspaceMemberships.list(user.id, workspaceId));
    if (!segments[5] && method === "POST") { const body = await readJson(req); return sendJson(res, 200, await services.workspaceMemberships.add(user.id, workspaceId, asWorkspaceMemberIdentity(body), asWorkspaceMembershipRole(body.role))); }
    if (method === "PATCH") { const body = await readJson(req); return sendJson(res, 200, await services.workspaceMemberships.change(user.id, workspaceId, asUserId(body.userId), asWorkspaceMembershipRole(body.role))); }
    if (method === "DELETE") { const body = await readJson(req); await services.workspaceMemberships.remove(user.id, workspaceId, asUserId(body.userId)); return sendJson(res, 200, { deleted: true }); }
  }
  if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "workspaces" && segments[3] && segments[4] === "settings") {
    const workspaceId = segments[3];
    if (method === "GET") return sendJson(res, 200, await services.settings.workspace(user.id, workspaceId));
    if (method === "PATCH") {const body=await readJson(req);return sendJson(res,200,await services.settings.runIdempotentMutation(user.id,workspaceId,"workspace.settings.update",requireIdempotencyKey(req),body,workspaceId,()=>services.settings.updateWorkspace(user.id,workspaceId,body)));}
    if (segments[5] === "archive" && method === "POST") return sendJson(res,200,await services.settings.runIdempotentMutation(user.id,workspaceId,"workspace.archive",requireIdempotencyKey(req),{workspaceId},workspaceId,()=>services.settings.archiveWorkspace(user.id,workspaceId)));
    if (segments[5] === "unarchive" && method === "POST") return sendJson(res,200,await services.settings.runIdempotentMutation(user.id,workspaceId,"workspace.unarchive",requireIdempotencyKey(req),{workspaceId},workspaceId,()=>services.settings.unarchiveWorkspace(user.id,workspaceId)));
  }

  if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "projects" && segments[3]) {
    const projectId = segments[3];
    if (segments.length === 4 && method === "DELETE") {
      const result=await services.settings.runIdempotentProjectDeletion(user.id,projectId,requireIdempotencyKey(req),()=>services.deletion.deleteProject(user.id,projectId));
      return sendJson(res, 200, result);
    }
    if (segments[4] === "capabilities" && method === "GET") {
      return sendJson(res, 200, await services.workspaces.projectCapabilities(user.id, projectId));
    }
    if (segments[4] === "settings") {
      if (method === "GET") return sendJson(res, 200, await services.settings.project(user.id, projectId));
      if (method === "PATCH") {const body=await readJson(req);assertOnlyKeys(body,["name"]);return sendJson(res,200,await services.settings.runIdempotentMutation(user.id,projectId,"project.settings.update",requireIdempotencyKey(req),body,projectId,async()=>{const result=await services.settings.updateProject(user.id,projectId,body);await services.settings.auditProjectLifecycle(projectId,user.id,"project.settings.update");return result}));}
      if (segments[5] === "archive" && method === "POST") return sendJson(res,200,await services.settings.runIdempotentProjectLifecycleMutation(user.id,projectId,"project.archive",requireIdempotencyKey(req),"project.archive",()=>services.settings.archiveProject(user.id,projectId)));
      if (segments[5] === "unarchive" && method === "POST") return sendJson(res,200,await services.settings.runIdempotentProjectLifecycleMutation(user.id,projectId,"project.unarchive",requireIdempotencyKey(req),"project.unarchive",()=>services.settings.unarchiveProject(user.id,projectId)));
    }
    if (segments[4] === "members") {
      if (segments[5] === "transfer-owner" && method === "POST") { const body=await readJson(req);const target=asUserId(body.userId);return sendJson(res,200,await services.settings.runIdempotentMutation(user.id,projectId,"project.owner.transfer",requireIdempotencyKey(req),{projectId,userId:target},projectId,async()=>{await services.memberships.transferOwner(user.id,projectId,target);await services.settings.auditProjectLifecycle(projectId,user.id,"project.owner.transfer");return{transferred:true as const}})); }
      if (method === "GET") {
        return sendJson(res, 200, await services.memberships.listMembers(user.id, projectId));
      }
      if (method === "POST") {
        const body = await readJson(req);
        return sendJson(res, 200, await services.memberships.addMember(
          user.id,
          projectId,
          asUserId(body.userId),
          asProjectMembershipRole(body.role)
        ));
      }
      if (method === "PATCH") {
        const body = await readJson(req);
        return sendJson(res, 200, await services.memberships.changeMember(
          user.id,
          projectId,
          asUserId(body.userId),
          asProjectMembershipRole(body.role)
        ));
      }
      if (method === "DELETE") {
        const body = await readJson(req);
        await services.memberships.removeMember(user.id, projectId, asUserId(body.userId));
        return sendJson(res, 200, { deleted: true });
      }
    }
    if (segments[4] === "credentials") {
      if (!segments[5] && method === "GET") return sendJson(res, 200, await services.credentials.list(user.id, projectId));
      if (!segments[5] && method === "POST") return sendJson(res, 200, await services.credentials.create(user.id, projectId, asCredentialCreateInput(await readJson(req))));
      if (segments[5] && segments[6] === "rotate" && method === "POST") return sendJson(res, 200, await services.credentials.rotate(user.id, projectId, segments[5], asCredentialRotateInput(await readJson(req))));
      if (segments[5] && method === "DELETE") { await services.credentials.remove(user.id, projectId, segments[5]); return sendJson(res, 200, { deleted: true }); }
    }
    if (segments[4] === "endpoints") {
      if (segments[5] === "models" && method === "POST") {
        return sendJson(res, 200, await services.endpoints.discoverModels(user.id, projectId, asEndpointModelDiscoveryInput(await readJson(req))));
      }
      if (segments[5] && segments[6] === "health" && method === "POST") {
        return sendJson(res, 200, toPublicEndpoint(await services.endpoints.recheckEndpoint(user.id, projectId, segments[5])));
      }
      if (!segments[5] && method === "GET") {
        const endpoints = await services.endpoints.listEndpoints(user.id, projectId);
        return sendJson(res, 200, endpoints.map(toPublicEndpoint));
      }
      if (method === "POST") {
        const endpoint = await services.endpoints.createEndpoint(user.id, projectId, asEndpointInput(await readJson(req)));
        return sendJson(res, 200, toPublicEndpoint(endpoint));
      }
      if (segments[5] && method === "PATCH") {
        const endpoint = await services.endpoints.updateEndpoint(user.id, projectId, segments[5], asEndpointUpdateInput(await readJson(req)));
        return sendJson(res, 200, toPublicEndpoint(endpoint));
      }
      if (segments[5] && method === "DELETE") {
        await services.endpoints.deleteEndpoint(user.id, projectId, segments[5]);
        return sendJson(res, 200, { deleted: true });
      }
    }
    if (segments[4] === "chat" && segments[5] === "threads") {
      if (!segments[6] && method === "GET") {
        const query = url.searchParams.get("query")?.trim();
        return sendJson(res, 200, query ? await services.chat.searchThreads(user.id, projectId, query) : await services.chat.listThreads(user.id, projectId));
      }
      if (!segments[6] && method === "POST") {
        const body = await readJson(req);
        assertOnlyKeys(body,["endpointId"]);
        return sendJson(res, 200, await services.chat.createThread(user.id, projectId, asString(body.endpointId)));
      }
      if (segments[6] && !segments[7] && method === "PATCH") { const body=await readJson(req);assertOnlyKeys(body,["title","pinned","starred"]); return sendJson(res,200,await services.chat.updateThreadMetadata(user.id,projectId,segments[6],{...(Object.hasOwn(body,"title")?{title:body.title===null?null:asString(body.title)}:{}),...(Object.hasOwn(body,"pinned")?{pinned:asBoolean(body.pinned,"pinned")}:{}) ,...(Object.hasOwn(body,"starred")?{starred:asBoolean(body.starred,"starred")}:{})})); }
      if (segments[6] && !segments[7] && method === "DELETE") { await services.chat.deleteThread(user.id,projectId,segments[6]); return sendJson(res,200,{deleted:true}); }
      if (segments[6] && segments[7] === "messages") {
        const threadId=segments[6];const messageId=segments[8];const action=segments[9];
        if(messageId&&!action&&method==="PATCH"){const body=await readJson(req);assertOnlyKeys(body,["content","expectedVersion"]);return sendJson(res,200,await services.chat.editMessage(user.id,projectId,threadId,messageId,asPositiveInteger(body.expectedVersion,"expectedVersion"),asString(body.content)));}
        if(messageId&&!action&&method==="DELETE"){const body=await readJson(req);assertOnlyKeys(body,["expectedVersion"]);await services.chat.deleteMessage(user.id,projectId,threadId,messageId,asPositiveInteger(body.expectedVersion,"expectedVersion"));return sendJson(res,200,{deleted:true});}
        if(messageId&&action==="branch"&&method==="POST"){const body=await readJson(req);assertOnlyKeys(body,["expectedVersion"]);return sendJson(res,200,await services.chat.branchMessage(user.id,projectId,threadId,messageId,asPositiveInteger(body.expectedVersion,"expectedVersion")));}
        if(messageId&&action==="retry"&&method==="POST"){const body=await readJson(req);assertOnlyKeys(body,["expectedVersion"]);return sendChatRetryStream(req,res,services,user.id,projectId,threadId,messageId,asPositiveInteger(body.expectedVersion,"expectedVersion"));}
        if(!messageId&&method==="GET")return sendJson(res,200,await services.chat.listMessages(user.id,projectId,threadId));
        if(!messageId&&method==="POST"){const body=await readJson(req);assertOnlyKeys(body,["content","afterMessageId"]);return sendChatStream(req,res,services,user.id,projectId,threadId,asString(body.content),body.afterMessageId===null?null:asString(body.afterMessageId));}
      }
    }
    if (segments[4] === "policy") {
      if (method === "GET") return sendJson(res, 200, await services.policies.getPolicy(user.id, projectId));
      if (method === "PATCH") return sendJson(res, 200, await services.policies.updatePolicy(user.id, projectId, asPolicyInput(await readJson(req))));
    }
    if (segments[4] === "usage" && method === "GET") return sendJson(res, 200, await services.policies.getUsageOverview(user.id, projectId, url.searchParams.get("endpointId") ?? undefined));
    if (segments[4] === "alerts") {
      if (!segments[5] && method === "GET") return sendJson(res, 200, await services.policies.alerts(user.id, projectId));
      if (segments[5] && segments[6] === "acknowledge" && method === "POST") return sendJson(res,200,await services.alertRules.acknowledge(user.id,projectId,segments[5]));
      if (segments[5] && segments[6] === "silence" && method === "POST") return sendJson(res,200,await services.alertRules.silence(user.id,projectId,segments[5],(await readJson(req)).silencedUntil));
      if (segments[5] && method === "PATCH") return sendJson(res, 200, await services.policies.transitionAlert(user.id, projectId, segments[5], asProjectAlertTransition(await readJson(req))));
    }
    if (segments[4] === "alert-rules") {
      if (!segments[5] && method === "GET") return sendJson(res, 200, await services.alertRules.list(user.id, projectId));
      if (!segments[5] && method === "POST") return sendJson(res, 200, await services.alertRules.create(user.id, projectId, asAlertRuleCreateInput(await readJson(req))));
      if (segments[5] && segments[6] === "test" && method === "POST") return sendJson(res,200,await services.alertRules.test(user.id,projectId,segments[5]));
      if (segments[5] && method === "PATCH") return sendJson(res, 200, await services.alertRules.update(user.id, projectId, segments[5], asAlertRuleUpdateInput(await readJson(req))));
      if (segments[5] && method === "DELETE") return sendJson(res, 200, await services.alertRules.remove(user.id, projectId, segments[5]));
    }
    if (segments[4] === "audit" && method === "GET") return sendJson(res, 200, await services.policies.audit(user.id, projectId, asAuditQuery(url.searchParams)));
    if (segments[4] === "files") {
      if (segments[5] === "url-note" && method === "POST") {
        const project = await services.workspaces.requireProjectForUser(user.id, projectId, "write");
        const projectRoot = services.projectAbsoluteRoot(project.rootPath);
        const body = await readJson(req);
        assertOnlyKeys(body,["url"]);
        const inputUrl = normalizeTaskInputUrl(asString(body.url));
        const host = inputUrl.hostname.toLowerCase().replace(/[^a-z0-9.-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,80) || "link";
        const filePath = `files/url-inputs/${host}-${randomUUID()}.md`;
        const bytes = Buffer.from(`# URL input\n\n${inputUrl.href}\n`,"utf8");
        const written = await services.files.uploadFileWithAccounting(projectRoot,{path:filePath,bytes},{record:(path,delta)=>services.policies.recordFileBytes(projectId,user.id,path,delta)});
        await services.policies.recordOperation(projectId,user.id,"file.upload","accepted",written.path,"file",{filePath:written.path,bytes:written.bytes,mediaType:written.mediaType});
        return sendJson(res,200,written);
      }
      if (!segments[5] && method === "GET") {
        const project = await services.workspaces.requireProjectForUser(user.id, projectId, "view");
        const projectRoot = services.projectAbsoluteRoot(project.rootPath);
        return sendJson(res, 200, await services.files.listFiles(projectRoot, url.searchParams.get("path") ?? "files"));
      }
      if (!segments[5] && method === "PUT") {
        const project = await services.workspaces.requireProjectForUser(user.id, projectId, "write");
        const projectRoot = services.projectAbsoluteRoot(project.rootPath);
        const filePath = requiredSearchParam(url, "path");
        const overwrite = optionalBooleanSearchParam(url, "overwrite");
        const bytes = await readRawProjectFileBytes(req);
        const written = await services.files.uploadFileWithAccounting(projectRoot, {
          path: filePath, bytes, overwrite
        }, {
          record: (path, delta) => services.policies.recordFileBytes(projectId, user.id, path, delta)
        });
        await services.policies.recordOperation(projectId, user.id, "file.upload", "accepted", written.path, "file", {
          filePath: written.path,
          bytes: written.bytes,
          mediaType: written.mediaType
        });
        return sendJson(res, 200, written);
      }
      if (!segments[5] && method === "DELETE") {
        const project = await services.workspaces.requireProjectForUser(user.id, projectId, "write");
        const projectRoot = services.projectAbsoluteRoot(project.rootPath);
        const body = await readJson(req);
        const filePath = asString(body.path);
        const deleted = await services.files.deleteFileWithAccounting(projectRoot, filePath, {
          record: (path, delta) => services.policies.recordFileBytes(projectId, user.id, path, delta)
        });
        await services.policies.recordOperation(projectId, user.id, "file.delete", "accepted", filePath, "file", {
          filePath,
          bytes: deleted.bytes,
          mediaType: deleted.mediaType
        });
        return sendJson(res, 200, deleted.response);
      }
      if (segments[5] === "download" && method === "GET") {
        const project = await services.workspaces.requireProjectForUser(user.id, projectId, "view");
        const projectRoot = services.projectAbsoluteRoot(project.rootPath);
        return sendProjectFileDownload(res, await services.files.downloadFile(projectRoot, requiredSearchParam(url, "path")));
      }
    }
    if (segments[4] === "tasks") {
      if (segments[5] === "summaries" && method === "GET") return sendJson(res,200,await services.tasks.listTaskSummaries(user.id,projectId));
      if (method === "GET") {
        return sendJson(res, 200, await services.tasks.listTasks(user.id, projectId, asTaskListQuery(url.searchParams)));
      }
      if (method === "POST") {
        const body = await readJson(req);
        assertOnlyKeys(body,["prompt","endpointId","title","inputPaths"]);
        return sendJson(res, 200, await services.tasks.createTask(user.id, projectId, {
          prompt: asString(body.prompt),
          endpointId: asString(body.endpointId),
          ...(body.title!==undefined?{title:asString(body.title)}:{}),
          ...(body.inputPaths!==undefined?{inputPaths:asStringArray(body.inputPaths,"inputPaths")}:{})
        },requireIdempotencyKey(req)));
      }
    }
  }

  if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "tasks" && segments[3]) {
    const taskId = segments[3];
    if (!segments[4] && method === "GET") return sendJson(res,200,await services.tasks.getTask(user.id,taskId));
    if (!segments[4] && method === "PATCH") {const body=await readJson(req);assertOnlyKeys(body,["title"]);return sendJson(res,200,await services.tasks.editTask(user.id,taskId,asString(body.title),requireIdempotencyKey(req)));}
    if (!segments[4] && method === "DELETE") return sendJson(res,200,await services.tasks.deleteTask(user.id,taskId,requireIdempotencyKey(req)));
    if (segments[4] === "summary" && method === "GET") return sendJson(res,200,await services.tasks.getTaskSummary(user.id,taskId));
    if (segments[4] === "inputs" && !segments[5] && method === "GET") return sendJson(res,200,await services.tasks.listTaskInputs(user.id,taskId));
    if (segments[4] === "inputs" && segments[5] === "download" && method === "GET") return sendTaskInputDownload(res,await services.tasks.downloadTaskInput(user.id,taskId,requiredSearchParam(url,"path")));
    if (segments[4] === "messages") {
      if(!segments[5]&&method==="POST"){const body=await readJson(req);assertOnlyKeys(body,["content"]);return sendJson(res,200,await services.tasks.sendTaskMessage(user.id,taskId,asString(body.content),requireIdempotencyKey(req)));}
      if(segments[5]&&method==="PATCH"){const body=await readJson(req);assertOnlyKeys(body,["content"]);return sendJson(res,200,await services.tasks.editTaskMessage(user.id,taskId,segments[5],asString(body.content),requireIdempotencyKey(req)));}
      if(segments[5]&&method==="DELETE")return sendJson(res,200,await services.tasks.deleteTaskMessage(user.id,taskId,segments[5],requireIdempotencyKey(req)));
    }
    if (segments[4] === "retry" && method === "POST") return sendJson(res,200,await services.tasks.retryTask(user.id,taskId,requireIdempotencyKey(req)));
    if (segments[4] === "duplicate" && method === "POST") return sendJson(res,200,await services.tasks.duplicateTask(user.id,taskId,requireIdempotencyKey(req)));
    if (segments[4] === "archive" && method === "POST") return sendJson(res,200,await services.tasks.archiveTask(user.id,taskId,requireIdempotencyKey(req)));
    if (segments[4] === "interactions" && !segments[5] && method === "GET") return sendJson(res,200,await services.tasks.taskInteractions(user.id,taskId,{...(url.searchParams.get("cursor")?{cursor:url.searchParams.get("cursor")!}:{}),...(url.searchParams.get("limit")?{limit:asPositiveQueryInteger(url.searchParams.get("limit")!,"limit")}:{})}));
    if (segments[4] === "interactions" && segments[5] === "stream" && method === "GET") return sendTaskInteractionStream(req,res,services,user.id,taskId,url);
    if (segments[4] === "turn" && segments[5] === "abort" && method === "POST") { const body=await readJson(req);assertOnlyKeys(body,[]);return sendJson(res,200,await services.tasks.abortTaskTurn(user.id,taskId,requireIdempotencyKey(req))); }
    if (segments[4] === "work" && segments[5] && segments[6] === "stop" && method === "POST") { const body=await readJson(req);assertOnlyKeys(body,[]);return sendJson(res,200,await services.tasks.stopTaskBackgroundWork(user.id,taskId,segments[5],requireIdempotencyKey(req))); }
    if (segments[4] === "artifacts" && segments[5] && segments[6] === "download" && method === "GET") {
      try {
        return sendArtifactDownload(res, await services.tasks.downloadTaskArtifact(user.id, taskId, segments[5]));
      } catch (error) {
        return handleTaskRouteError(res, error);
      }
    }
    if (segments[4] === "artifacts" && !segments[5] && method === "GET") {
      try {
        return sendJson(res, 200, await services.tasks.listTaskArtifacts(user.id, taskId, { ...(url.searchParams.get("mediaType") ? { mediaType: url.searchParams.get("mediaType")! } : {}), ...(url.searchParams.get("preview") === "true" ? { previewOnly: true } : {}) }));
      } catch (error) {
        return handleTaskRouteError(res, error);
      }
    }
    if (segments[4] === "cancel" && method === "POST") {
      try {
        return sendJson(res, 200, await services.tasks.cancelTask(user.id, taskId,requireIdempotencyKey(req)));
      } catch (error) {
        return handleTaskRouteError(res, error);
      }
    }
  }

  throw new ProductError("Route not found", 404);
}

interface BrokerRoute {
  taskId: string;
  runId: string;
}

const MAX_BOTIFIED_CHAT_COMPLETION_BYTES = 1_048_576;
const MAX_PROVIDER_USAGE_OBSERVER_BYTES = 65_536;
const BOTIFIED_CHAT_COMPLETION_FIELDS = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "stream_options",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "response_format",
  "seed"
]);

function brokerRouteFor(pathname: string): BrokerRoute | null {
  const match = /^\/api\/internal\/tasks\/([^/]+)\/runs\/([^/]+)\/v1\/chat\/completions$/.exec(pathname);
  if (!match) {
    return null;
  }
  try {
    return { taskId: decodeURIComponent(match[1]!), runId: decodeURIComponent(match[2]!) };
  } catch {
    throw new ProductError("Broker route identifiers must be percent-encoded UTF-8", 400);
  }
}

async function forwardBotifiedChatCompletion(
  req: IncomingMessage,
  res: ServerResponse,
  services: Services,
  route: BrokerRoute
): Promise<void> {
  const authorization = req.headers.authorization;
  const serviceKey = typeof authorization === "string" && /^Bearer (.+)$/.test(authorization)
    ? authorization.slice("Bearer ".length)
    : "";
  if (!serviceKey) {
    throw new ProductError("Unauthorized Botified task key", 401);
  }
  const authorized = await services.tasks.authorizeBotifiedChatCompletion(route.taskId, route.runId, serviceKey);
  const request = await readBotifiedChatCompletionRequest(req, authorized.endpoint.model);
  await services.providerBroker.forwardChatCompletion(
    { endpoint: authorized.endpoint, settlementEndpointId: authorized.endpoint.id, apiKey: authorized.apiKey, actorId: authorized.actorId, taskId: route.taskId },
    request,
    brokerRequestHeaders(req),
    async (response) => {
      const usage = await sendProviderResponse(res, response);
      return { value: undefined, ...(usage ? { usage } : {}) };
    }
  );
}

function brokerRequestHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "accept", "openai-beta"]) {
    const value = req.headers[name];
    if (typeof value === "string") {
      headers[name] = value;
    }
  }
  return headers;
}

async function readBotifiedChatCompletionRequest(
  req: IncomingMessage,
  endpointModel: string
): Promise<Record<string, unknown>> {
  const contentType = firstHeaderValue(req.headers["content-type"]);
  if (!contentType || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new ProductError("Botified chat completions require application/json", 415);
  }
  const contentLength = firstHeaderValue(req.headers["content-length"]);
  if (contentLength !== undefined) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw new ProductError("Content-Length must be a non-negative integer");
    }
    if (declaredBytes > MAX_BOTIFIED_CHAT_COMPLETION_BYTES) {
      throw new ProductError("Botified chat completion request exceeds the allowed size", 413);
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_BOTIFIED_CHAT_COMPLETION_BYTES) {
      throw new ProductError("Botified chat completion request exceeds the allowed size", 413);
    }
    chunks.push(bytes);
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8"));
  } catch {
    throw new ProductError("Botified chat completion request must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ProductError("Botified chat completion request must be a JSON object");
  }
  const request = body as Record<string, unknown>;
  for (const field of Object.keys(request)) {
    if (!BOTIFIED_CHAT_COMPLETION_FIELDS.has(field)) {
      throw new ProductError(`Botified chat completion field is not allowed: ${field}`);
    }
  }
  if (request.model !== endpointModel) {
    throw new ProductError("Botified chat completion model must match the task endpoint", 403);
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0 || request.messages.some((message) => !message || typeof message !== "object" || Array.isArray(message))) {
    throw new ProductError("Botified chat completion messages must be a non-empty array of objects");
  }
  if (request.tools !== undefined && !Array.isArray(request.tools)) {
    throw new ProductError("Botified chat completion tools must be an array");
  }
  if (request.stream !== undefined && typeof request.stream !== "boolean") {
    throw new ProductError("Botified chat completion stream must be a boolean");
  }
  return request;
}

async function sendProviderResponse(
  res: ServerResponse,
  response: Response
): Promise<import("../../contracts/src/api.js").ProviderUsage | undefined> {
  const headers: Record<string, string> = {};
  // Node's fetch can decode the response body, leaving representation metadata stale.
  for (const name of ["content-type", "cache-control", "x-request-id"]) {
    const value = response.headers.get(name);
    if (value) {
      headers[name] = value;
    }
  }
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return undefined;
  }
  const observer = providerUsageObserver(response.headers.get("content-type"));
  let clientClosed = false;
  res.once("close", () => { clientClosed = true; });
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const usage = observer.observe(value);
    if (!clientClosed && !res.write(Buffer.from(value))) {
      await new Promise<void>((resolve) => { res.once("drain", resolve); res.once("close", resolve); });
    }
  }
  const usage = observer.finish();
  if (!clientClosed) res.end();
  return usage;
}

interface ProviderUsageObserver {
  observe(chunk: Uint8Array): import("../../contracts/src/api.js").ProviderUsage | undefined;
  finish(): import("../../contracts/src/api.js").ProviderUsage | undefined;
}

function providerUsageObserver(contentType: string | null): ProviderUsageObserver {
  return contentType?.toLowerCase().startsWith("text/event-stream")
    ? new SseProviderUsageObserver()
    : new JsonProviderUsageObserver();
}

class SseProviderUsageObserver implements ProviderUsageObserver {
  private readonly decoder = new TextDecoder();
  private pending = "";
  private usage: import("../../contracts/src/api.js").ProviderUsage | undefined;

  observe(chunk: Uint8Array): import("../../contracts/src/api.js").ProviderUsage | undefined {
    const previous = this.usage;
    this.consume(this.decoder.decode(chunk, { stream: true }));
    return this.usage === previous ? undefined : this.usage;
  }

  finish(): import("../../contracts/src/api.js").ProviderUsage | undefined {
    this.consume(this.decoder.decode());
    if (this.pending.length > 0) {
      this.consumeLine(this.pending);
      this.pending = "";
    }
    return this.usage;
  }

  private consume(text: string): void {
    this.pending += text;
    if (this.pending.length > MAX_PROVIDER_USAGE_OBSERVER_BYTES && !this.pending.includes("\n")) {
      this.pending = "";
      return;
    }
    let lineEnd: number;
    while ((lineEnd = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, lineEnd);
      this.pending = this.pending.slice(lineEnd + 1);
      this.consumeLine(line);
    }
    if (this.pending.length > MAX_PROVIDER_USAGE_OBSERVER_BYTES) {
      this.pending = "";
    }
  }

  private consumeLine(line: string): void {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!normalized.startsWith("data:")) {
      return;
    }
    const data = normalized.slice("data:".length).trimStart();
    if (!data || data === "[DONE]") {
      return;
    }
    try {
      const usage = providerUsageFromPayload(JSON.parse(data));
      if (usage) {
        this.usage = usage;
      }
    } catch {
      // Malformed provider event frames must not delay or fail the response stream.
    }
  }
}

class JsonProviderUsageObserver implements ProviderUsageObserver {
  private readonly chunks: Uint8Array[] = [];
  private totalBytes = 0;
  private overflowed = false;

  observe(chunk: Uint8Array): import("../../contracts/src/api.js").ProviderUsage | undefined {
    if (this.overflowed) {
      return undefined;
    }
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes > MAX_PROVIDER_USAGE_OBSERVER_BYTES) {
      this.chunks.length = 0;
      this.overflowed = true;
      return undefined;
    }
    this.chunks.push(chunk);
    return undefined;
  }

  finish(): import("../../contracts/src/api.js").ProviderUsage | undefined {
    if (this.overflowed || this.totalBytes === 0) {
      return undefined;
    }
    try {
      return providerUsageFromPayload(JSON.parse(Buffer.concat(this.chunks, this.totalBytes).toString("utf8")));
    } catch {
      return undefined;
    }
  }
}

function isKnownApiRoutePath(pathname: string): boolean {
  return [
    "/api/v1/me",
    "/api/v1/me/profile",
    "/api/v1/notifications",
    "/api/v1/auth/logout",
    "/api/v1/dashboard",
    "/api/v1/workspaces",
    "/api/v1/projects",
    "/api/v1/context"
  ].includes(pathname) ||
    /^\/api\/v1\/workspaces\/[^/]+(?:\/(?:projects|settings|members)(?:\/(?:archive|unarchive|transfer-owner))?)?$/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+(?:\/(?:capabilities|settings|members|credentials|endpoints|tasks|policy|usage|alerts|audit|alert-rules)(?:\/(?:archive|unarchive|transfer-owner))?)?$/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/credentials\/[^/]+(?:\/rotate)?$/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/alert-rules\/[^/]+(?:\/test)?$/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/alerts\/[^/]+(?:\/(?:acknowledge|silence))?$/.test(pathname) ||
    /^\/api\/v1\/notifications\/[^/]+(?:\/read)?$/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/chat\/threads(?:\/[^/]+(?:\/messages(?:\/[^/]+(?:\/(?:branch|retry))?)?)?)?$/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/tasks\/summaries$/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/endpoints\/(?:models|[^/]+(?:\/health)?)$/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/files(?:\/(?:download|url-note))?$/.test(pathname) ||
    /^\/api\/v1\/tasks\/[^/]+(?:\/(?:artifacts|cancel|summary|inputs(?:\/download)?|retry|duplicate|archive|interactions(?:\/stream)?|messages(?:\/[^/]+)?|turn\/abort|work\/[^/]+\/stop))?$/.test(pathname) ||
    /^\/api\/v1\/tasks\/[^/]+\/artifacts\/[^/]+\/download$/.test(pathname);
}

function appBasePathFromOptions(publicBaseUrl: string | undefined, publicBasePath: string | undefined): string {
  if (publicBasePath !== undefined) {
    return normalizeAppBasePath(publicBasePath);
  }
  return appBasePathFromPublicBaseUrl(publicBaseUrl);
}

function appBasePathFromPublicBaseUrl(publicBaseUrl: string | undefined): string {
  const value = publicBaseUrl?.trim();
  if (!value) {
    return "";
  }
  const parsed = new URL(value);
  return normalizeAppBasePath(parsed.pathname);
}

function normalizeAppBasePath(pathname: string): string {
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, "");
  return withoutTrailingSlash === "" ? "" : withoutTrailingSlash;
}

function routeUrlForAppBasePath(url: URL, appBasePath: string): URL | null {
  if (!appBasePath) {
    return url;
  }
  if (url.pathname !== appBasePath && !url.pathname.startsWith(`${appBasePath}/`)) {
    return null;
  }
  const routed = new URL(url.toString());
  routed.pathname = url.pathname === appBasePath ? "/" : url.pathname.slice(appBasePath.length);
  return routed;
}

function sessionCookiePath(appBasePath: string): string {
  return appBasePath || "/";
}

function publicBaseUrlUsesHttps(publicBaseUrl: string | undefined): boolean {
  return publicBaseUrl !== undefined && new URL(publicBaseUrl).protocol === "https:";
}

function serializeAuthCookie(name: string, value: string, cookiePath: string, maxAge: number, secure: boolean): string {
  return [
    `${name}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    `Path=${cookiePath}`,
    `Max-Age=${maxAge}`,
    ...(secure ? ["Secure"] : [])
  ].join("; ");
}

function oidcTransactionCookiePath(appBasePath: string): string {
  return `${appBasePath}/api/v1/auth/oidc`;
}

function appHomePath(appBasePath: string): string {
  return appBasePath ? `${appBasePath}/` : "/";
}

function contentDispositionFilename(input: string): string {
  const base = path.posix.basename(input.replace(/\\/g, "/"));
  const filename = base.replace(/[\r\n"\\]/g, "_");
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").trim() || "artifact";
  if (!/[^\x20-\x7e]/.test(filename)) {
    return `attachment; filename="${fallback}"`;
  }

  const encodedFilename = Array.from(Buffer.from(filename.trim() || "artifact", "utf8"), (byte) =>
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    "!#$&+-.^_`|~".includes(String.fromCharCode(byte))
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
  ).join("");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodedFilename}`;
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

async function sendChatStream(req: IncomingMessage, res: ServerResponse, services: Services, userId: string, projectId: string, threadId: string, content: string,afterMessageId:string|null): Promise<void> {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  };
  const event = (type: string, value: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
  try {
    const result = await services.chat.streamMessage(userId, projectId, threadId, content,afterMessageId, controller.signal, (delta) => { start(); event("delta", { delta }); });
    start();
    event("done", result);
  } catch (error) {
    if (!started) throw error;
    if (!controller.signal.aborted) event("error", { error: error instanceof Error ? error.message : "Chat request failed" });
  } finally { if (started) res.end(); }
}

async function sendTaskInteractionStream(req:IncomingMessage,res:ServerResponse,services:Services,userId:string,taskId:string,url:URL):Promise<void>{
  const queryCursor=url.searchParams.get("cursor");
  const headerValue=req.headers["last-event-id"];
  const headerCursor=Array.isArray(headerValue)?headerValue[0]:headerValue;
  if(queryCursor&&headerCursor&&queryCursor!==headerCursor)throw new ProductError("Task interaction cursors do not match",400);
  const authoritative=await services.tasks.taskInteractions(userId,taskId,{limit:1});
  let cursor=queryCursor??headerCursor;
  if(!cursor)cursor=authoritative.streamCursor;
  let page=await services.tasks.taskInteractionChanges(userId,taskId,cursor);
  let closed=false;
  res.on("close",()=>{closed=true;});
  res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache","connection":"keep-alive","x-accel-buffering":"no"});
  const event=(type:string,value:unknown,id?:string)=>{if(closed||res.writableEnded)return;res.write(`${id?`id: ${id}\n`:""}event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);};
  let lastState="";
  let lastRunState="";
  let lastConnection="";
  const state=(value:typeof page.state,force=false)=>{
    const payload={queuedMessages:value.queuedMessages,capabilities:value.capabilities};
    const serialized=JSON.stringify(payload);
    if(!force&&serialized===lastState)return;
    lastState=serialized;
    event("state",payload);
  };
  const runState=(value:typeof page.state,force=false)=>{
    const payload={runState:value.runState};
    const serialized=JSON.stringify(payload);
    if(!force&&serialized===lastRunState)return;
    lastRunState=serialized;
    event("run_state",payload);
  };
  const connection=(value:typeof page.state,connectionState:"connected"|"disconnected"|"recovered",message:string|null=null,force=false)=>{
    const payload={connectionState,runtimeReachability:value.runtimeReachability,historyStatus:value.historyStatus,lastSyncedAt:value.lastSyncedAt,message};
    const serialized=JSON.stringify(payload);
    if(!force&&serialized===lastConnection)return;
    lastConnection=serialized;
    event("connection",payload);
  };
  const transientState=(value:typeof page.state,connectionState:"connected"|"disconnected"|"recovered",message:string|null=null,force=false)=>{
    state(value,force);
    runState(value,force);
    connection(value,connectionState,message,force);
  };
  const previewIterator=services.tasks.streamTaskAssistantPreviews(userId,taskId)[Symbol.asyncIterator]();
  let previewNext:ReturnType<typeof previewIterator.next>|null=previewIterator.next();
  let previewUnavailable=false;
  transientState(page.state,"connected",page.state.historyStatus==="gap"?"Some earlier task history is no longer available.":null,true);
  const deadline=Date.now()+30_000;
  let heartbeatAt=Date.now()+5_000;
  try{
    while(!closed&&Date.now()<deadline){
      for(const change of page.changes){event("interaction",change.item,change.cursor);cursor=change.cursor;}
      if(page.done){event("done",{});res.end();return;}
      cursor=page.streamCursor;
      transientState(page.state,previewUnavailable?"disconnected":"connected",previewUnavailable?"Live assistant preview is unavailable.":page.state.historyStatus==="gap"?"Some earlier task history is no longer available.":null);
      if(Date.now()>=heartbeatAt){
        res.write(": heartbeat\n\n");
        heartbeatAt=Date.now()+5_000;
      }
      const preview=previewNext
        ? await Promise.race([sleep(500).then(()=>null),previewNext.then((result)=>({result})).catch(()=>({result:null}))])
        : (await sleep(500),null);
      if(preview){
        if(preview.result===null){
          previewUnavailable=true;
          connection(page.state,"disconnected","Live assistant preview is unavailable.",true);
          previewNext=null;
        }
        else if(preview.result.done)previewNext=null;
        else if(preview.result){
          const update=preview.result.value;
          if(update.type==="upsert")event("assistant_preview",{interactionId:update.interactionId,body:update.body,occurredAt:update.occurredAt});
          else event("assistant_preview_clear",{interactionId:update.interactionId});
          previewNext=previewIterator.next();
        }
      }
      if(closed)break;
      try{page=await services.tasks.taskInteractionChanges(userId,taskId,cursor);}
      catch{connection(page.state,"disconnected","Task interaction authorization or connection changed.",true);res.end();return;}
    }
    if(!closed){event("reconnect",{});res.end();}
  }finally{
    void previewIterator.return?.();
  }
}

function sleep(ms:number):Promise<void>{return new Promise((resolve)=>setTimeout(resolve,ms));}

async function sendChatRetryStream(req:IncomingMessage,res:ServerResponse,services:Services,userId:string,projectId:string,threadId:string,messageId:string,expectedVersion:number):Promise<void>{
  const controller=new AbortController();res.on("close",()=>{if(!res.writableEnded)controller.abort();});let started=false;const start=()=>{if(started)return;started=true;res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache",connection:"keep-alive","x-accel-buffering":"no"});};const event=(type:string,value:unknown)=>res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
  try{const result=await services.chat.retryMessage(userId,projectId,threadId,messageId,expectedVersion,controller.signal,(delta)=>{start();event("delta",{delta});});start();event("done",result);}catch(error){if(!started)throw error;if(!controller.signal.aborted)event("error",{error:error instanceof Error?error.message:"Chat retry failed"});}finally{if(started)res.end();}
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
    "content-type": safeDownloadMediaType(download.artifact.mediaType),
    "content-length": String(download.bytes.byteLength),
    "content-disposition": contentDispositionFilename(download.artifact.name || download.artifact.id),
    "x-content-type-options": "nosniff"
  });
  res.end(download.bytes);
}

function sendTaskInputDownload(res: ServerResponse, download: Awaited<ReturnType<Services["tasks"]["downloadTaskInput"]>>): void {
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(download.bytes.byteLength),
    "content-disposition": contentDispositionFilename(download.input.name),
    "x-content-type-options": "nosniff"
  });
  res.end(download.bytes);
}

function sendProjectFileDownload(
  res: ServerResponse,
  download: Awaited<ReturnType<Services["files"]["downloadFile"]>>
): void {
  const bytes = Buffer.from(download.bytes);
  res.writeHead(200, {
    "content-type": download.mediaType,
    "content-length": String(bytes.byteLength),
    "content-disposition": contentDispositionFilename(download.filename),
    "x-content-type-options": "nosniff"
  });
  res.end(bytes);
}

function safeDownloadMediaType(value: string | null | undefined): string {
  return value && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value)
    ? value
    : "application/octet-stream";
}

function toPublicEndpoint(endpoint: ModelEndpoint): PublicModelEndpoint {
  return {
    id: endpoint.id,
    projectId: endpoint.projectId,
    name: endpoint.name,
    protocol: endpoint.protocol,
    baseUrl: endpoint.baseUrl,
    model: endpoint.model,
    credentialId: endpoint.credentialId,
    capabilities: endpoint.capabilities,
    requestTimeoutSecs: endpoint.requestTimeoutSecs,
    ...(endpoint.health ? { health: endpoint.health } : {}),
    hasCredentialRef: endpoint.credentialId.length > 0,
    taskEligible: endpoint.health?.status === "healthy" && endpoint.capabilities.includes("text") && endpoint.capabilities.includes("tool_calls"),
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt
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

function normalizeTaskInputUrl(value:string):URL{
  const trimmed=value.trim();
  if(!trimmed||trimmed.length>2048)throw new ProductError("URL must be between 1 and 2048 characters",400);
  let parsed:URL;try{parsed=new URL(trimmed);}catch{throw new ProductError("Enter a valid URL",400);}
  if(parsed.protocol!=="http:"&&parsed.protocol!=="https:")throw new ProductError("Only HTTP and HTTPS URLs can be attached",400);
  if(parsed.username||parsed.password)throw new ProductError("URL credentials are not allowed",400);
  return parsed;
}
function asStringArray(value:unknown,field:string):string[]{if(!Array.isArray(value)||value.some((item)=>typeof item!=="string"))throw new ProductError(`${field} must be an array of strings`);return value;}
function asPositiveQueryInteger(value:string,field:string):number{const parsed=Number(value);if(!Number.isInteger(parsed)||parsed<1)throw new ProductError(`${field} must be a positive integer`);return parsed;}
function requireIdempotencyKey(req:IncomingMessage):string{const value=req.headers["idempotency-key"];if(typeof value!=="string"||!value.trim())throw new ProductError("Idempotency-Key header is required",400);if(value.trim().length>200)throw new ProductError("Idempotency-Key must be at most 200 characters",400);return value.trim();}

function asTaskListQuery(params:URLSearchParams):TaskListQuery{
  const query:TaskListQuery={};const search=params.get("search");if(search)query.search=search;
  const status=params.get("status");if(status)query.statuses=status.split(",").filter(Boolean) as NonNullable<TaskListQuery["statuses"]>;
  const archived=params.get("archived");if(archived){if(!["exclude","include","only"].includes(archived))throw new ProductError("Task archived filter is invalid");query.archived=archived as NonNullable<TaskListQuery["archived"]>;}
  const sort=params.get("sort");if(sort){if(!["created_at","updated_at","title","status"].includes(sort))throw new ProductError("Task sort is invalid");query.sort=sort as NonNullable<TaskListQuery["sort"]>;}
  const direction=params.get("direction");if(direction){if(direction!=="asc"&&direction!=="desc")throw new ProductError("Task sort direction is invalid");query.direction=direction;}
  const cursor=params.get("cursor");if(cursor)query.cursor=cursor;const limit=params.get("limit");if(limit)query.limit=asPositiveQueryInteger(limit,"limit");return query;
}
function asBoolean(value: unknown, field: string): boolean { if (typeof value !== "boolean") throw new ProductError(`${field} must be a boolean`); return value; }
function asPositiveInteger(value:unknown,field:string):number{if(typeof value!=="number"||!Number.isInteger(value)||value<1)throw new ProductError(`${field} must be a positive integer`);return value;}
function assertOnlyKeys(value:Record<string,unknown>,allowed:string[]):void{const unexpected=Object.keys(value).find((key)=>!allowed.includes(key));if(unexpected)throw new ProductError(`Unsupported field: ${unexpected}`,400);}

function contextTargetFromQuery(url: URL): { workspaceId: string; projectId?: string; scope: ProjectContextScope } {
  return {
    workspaceId: requiredSearchParam(url, "workspaceId"),
    ...(url.searchParams.has("projectId") ? { projectId: requiredSearchParam(url, "projectId") } : {}),
    scope: asContextScope(requiredSearchParam(url, "scope"))
  };
}

function contextTargetFromBody(body: Record<string, unknown>): { workspaceId: string; projectId?: string; scope: ProjectContextScope } {
  return {
    workspaceId: asString(body.workspaceId),
    ...(body.projectId === undefined || body.projectId === null ? {} : { projectId: asString(body.projectId) }),
    scope: asContextScope(body.scope)
  };
}

function asContextScope(value: unknown): ProjectContextScope {
  if (value === "workspace_shared" || value === "workspace_personal" || value === "project_shared" || value === "project_personal") return value;
  throw new ProductError("Invalid context scope");
}

function asContextContentType(value: unknown): ContextContentType {
  if (value === "text" || value === "json" || value === "markdown" || value === "yaml") return value;
  throw new ProductError("Invalid context content type");
}

function asWorkspaceMemberIdentity(body: Record<string, unknown>): { email?: string; issuer?: string; subject?: string } {
  return {
    ...(typeof body.email === "string" ? { email: body.email } : {}),
    ...(typeof body.issuer === "string" ? { issuer: body.issuer } : {}),
    ...(typeof body.subject === "string" ? { subject: body.subject } : {})
  };
}

function asUserId(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProductError("Expected string field userId");
  }
  return value;
}

function asProjectMembershipRole(value: unknown): ManagedProjectMembershipRole {
  if (value === "admin" || value === "member" || value === "viewer") {
    return value;
  }
  throw new ProductError("Project membership role must be admin, member, or viewer");
}

function asWorkspaceMembershipRole(value: unknown): ManagedWorkspaceMembershipRole {
  if (value === "admin" || value === "member" || value === "viewer") return value;
  throw new ProductError("Workspace member role must be admin, member, or viewer");
}

function requiredSearchParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null) {
    throw new ProductError(`Missing ${name} query parameter`);
  }
  return value;
}

function optionalBooleanSearchParam(url: URL, name: string): boolean {
  const value = url.searchParams.get(name);
  if (value === null || value === "false") return false;
  if (value === "true") return true;
  throw new ProductError(`${name} query parameter must be true or false`);
}

interface OidcTransaction {
  state: string;
  codeVerifier: string;
  nonce?: string | undefined;
  redirectUri: string;
  returnTo?: string;
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
    (candidate.returnTo === undefined || (typeof candidate.returnTo === "string" && candidate.returnTo.startsWith("/"))) &&
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt);
}

function oidcReturnTo(value: string | null, appBasePath: string): string {
  const home = appHomePath(appBasePath);
  if (!value) return home;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return home;
  try {
    const parsed = new URL(value, "https://agentsmith.local");
    if (parsed.origin !== "https://agentsmith.local") return home;
    const pathname = parsed.pathname;
    if (appBasePath && pathname !== appBasePath && !pathname.startsWith(`${appBasePath}/`)) return home;
    if (!appBasePath && !pathname.startsWith("/")) return home;
    return `${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return home;
  }
}

function oidcRedirectUri(req: IncomingMessage, publicBaseUrl: string | undefined, appBasePath: string): string {
  const baseUrl = publicBaseUrl?.trim() || requestOrigin(req);
  const parsed = new URL(baseUrl);
  parsed.pathname = `${appBasePath}/api/v1/auth/oidc/callback`;
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

async function readRawProjectFileBytes(req: IncomingMessage): Promise<Uint8Array> {
  const contentLength = firstHeaderValue(req.headers["content-length"]);
  if (contentLength !== undefined) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw new ProductError("Content-Length must be a non-negative integer");
    }
    if (declaredBytes > MAX_PROJECT_FILE_BYTES) {
      throw new ProductError(`Project file exceeds the ${MAX_PROJECT_FILE_BYTES}-byte limit`, 413);
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_PROJECT_FILE_BYTES) {
      throw new ProductError(`Project file exceeds the ${MAX_PROJECT_FILE_BYTES}-byte limit`, 413);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, totalBytes);
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
    credentialId: asString(body.credentialId),
    capabilities: body.capabilities,
    requestTimeoutSecs: body.requestTimeoutSecs
  };
}

function asCredentialCreateInput(body: Record<string, unknown>): import("../../contracts/src/api.js").CreateProjectCredentialInput {
  return { name: asString(body.name), baseUrl: asString(body.baseUrl), secret: asString(body.secret) };
}

function asCredentialRotateInput(body: Record<string, unknown>): import("../../contracts/src/api.js").RotateProjectCredentialInput {
  return { secret: asString(body.secret) };
}

function asEndpointUpdateInput(body: Record<string, unknown>): UpdateEndpointInput {
  const input = asEndpointInput({
    ...body,
    credentialId: body.credentialId ?? ""
  });
  const { credentialId: _credentialId, ...withoutCredential } = input;
  return {
    ...withoutCredential,
    ...(body.credentialId === undefined ? {} : { credentialId: input.credentialId })
  };
}

function asEndpointModelDiscoveryInput(body: Record<string, unknown>): DiscoverEndpointModelsInput {
  if (typeof body.requestTimeoutSecs !== "number") throw new ProductError("Endpoint requestTimeoutSecs is required");
  return {
    ...(body.endpointId === undefined ? {} : { endpointId: asString(body.endpointId) }),
    baseUrl: asString(body.baseUrl),
    credentialId: asString(body.credentialId),
    requestTimeoutSecs: body.requestTimeoutSecs
  };
}

function asPolicyInput(body: Record<string, unknown>): import("../../contracts/src/api.js").UpdateProjectResourcePolicyInput {
  const fields = ["activeTasksLimit", "providerRequestsLimit", "providerTokensLimit", "providerCostLimit", "projectFileBytesLimit"] as const;
  const input: import("../../contracts/src/api.js").UpdateProjectResourcePolicyInput = {};
  for (const field of fields) {
    const value = body[field];
    if (value === undefined) continue;
    if (field === "activeTasksLimit") {
      if (typeof value !== "number") throw new ProductError("activeTasksLimit must be a number");
      input.activeTasksLimit = value;
      continue;
    }
    if (value !== null && typeof value !== "number") throw new ProductError(`${field} must be a number or null`);
    input[field] = value;
  }
  if(Object.hasOwn(body,"endpointWindows")){if(!Array.isArray(body.endpointWindows))throw new ProductError("endpointWindows must be an array");input.endpointWindows=body.endpointWindows as import("../../contracts/src/api.js").EndpointPolicyWindow[]}
  return input;
}

function asAlertRuleCreateInput(body:Record<string,unknown>){if(!("alertType" in body))throw new ProductError("Alert rule body must contain alertType");return body}

function asAlertRuleUpdateInput(body:Record<string,unknown>){if(Object.keys(body).length===0)throw new ProductError("Alert rule update cannot be empty");return body}

function asAuditQuery(params:URLSearchParams):import("../../contracts/src/api.js").ProjectAuditQuery{const value:import("../../contracts/src/api.js").ProjectAuditQuery={};const limit=params.get("limit");if(limit!==null){const parsed=Number(limit);if(!Number.isInteger(parsed)||parsed<1||parsed>100)throw new ProductError("Audit limit must be between 1 and 100");value.limit=parsed}const cursor=params.get("cursor");if(cursor){const split=cursor.lastIndexOf("|");if(split<1||!Number.isFinite(Date.parse(cursor.slice(0,split)))||!cursor.slice(split+1))throw new ProductError("Audit cursor is invalid");value.cursor=cursor}for(const key of ["from","to"] as const){const item=params.get(key);if(item){if(!Number.isFinite(Date.parse(item)))throw new ProductError(`Audit ${key} timestamp is invalid`);value[key]=new Date(item).toISOString()}}const action=params.get("action");if(action){if(!auditActions.has(action))throw new ProductError("Audit action is invalid");value.action=action as import("../../contracts/src/api.js").ProjectAuditAction}const status=params.get("status");if(status==="accepted"||status==="rejected")value.status=status;else if(status)throw new ProductError("Audit status is invalid");const kind=params.get("resourceKind");if(kind){if(!auditResourceKinds.has(kind))throw new ProductError("Audit resource kind is invalid");value.resourceKind=kind as import("../../contracts/src/api.js").ProjectAuditResourceKind}return value}
const auditActions=new Set<string>(PROJECT_AUDIT_ACTIONS);const auditResourceKinds=new Set<string>(PROJECT_AUDIT_RESOURCE_KINDS);

function asProjectAlertTransition(body: Record<string, unknown>): "resolved" | "dismissed" {
  if (Object.keys(body).length !== 1 || (body.status !== "resolved" && body.status !== "dismissed")) throw new ProductError("Project alert status must be resolved or dismissed");
  return body.status;
}

function providerUsageFromPayload(payload: unknown): import("../../contracts/src/api.js").ProviderUsage | undefined {
  try {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }
    const body = payload as { usage?: Record<string, unknown> };
    const usage = body.usage;
    if (!usage) return undefined;
    const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    const tokens = number(usage.total_tokens) ?? (number(usage.prompt_tokens) !== undefined && number(usage.completion_tokens) !== undefined ? number(usage.prompt_tokens)! + number(usage.completion_tokens)! : undefined);
    const cost = number(usage.cost) ?? number(usage.total_cost);
    return tokens === undefined && cost === undefined ? undefined : { ...(tokens === undefined ? {} : { tokens }), ...(cost === undefined ? {} : { cost }) };
  } catch {
    return undefined;
  }
}
