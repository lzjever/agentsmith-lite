import path from "node:path";
import { EnvModelCredentialResolver, FetchOpenAICompatibleClient, type ModelCredentialResolver, type OpenAICompatibleClient } from "../../openai-compatible-client/src/index.js";
import { DryRunBotifiedRuntimeHttpClient, type BotifiedRuntimeHttpClient } from "../../ports/src/botified.js";
import type { ProductStore } from "../../ports/src/store.js";
import { AuthService } from "./authService.js";
import { ChatService } from "./chatService.js";
import { EndpointService } from "./endpointService.js";
import { FileService } from "./fileService.js";
import { SandboxLifecycleService } from "./sandboxLifecycleService.js";
import { TaskService, type BotifiedServiceKeyInput, type BotifiedTaskAddressInput, type TaskLiveSandboxConfig } from "./taskService.js";
import { WorkspaceService } from "./workspaceService.js";

export const DEFAULT_SESSION_SECRET = "dev-session-secret";

export interface CreateApplicationServicesInput {
  store: ProductStore;
  dataRoot: string;
  builtinAdminPassword: string;
  sessionSecret?: string;
  namespace?: string;
  pvcName?: string;
  botifiedRunnerImage?: string;
  botifiedClient?: BotifiedRuntimeHttpClient;
  botifiedServiceKeyFactory?: (input: BotifiedServiceKeyInput) => string | undefined;
  botifiedBaseUrlForTask?: (input: BotifiedTaskAddressInput) => string;
  chatClient?: OpenAICompatibleClient;
  modelCredentialResolver?: ModelCredentialResolver;
  liveSandbox?: TaskLiveSandboxConfig;
  liveSandboxMaxLifetimeMs?: number;
  liveSandboxIdleTimeoutMs?: number;
}

export function createApplicationServices(input: CreateApplicationServicesInput) {
  const workspaces = new WorkspaceService(input.store);
  const endpoints = new EndpointService(input.store, workspaces);
  const files = new FileService();
  const sessionSecret = input.liveSandbox
    ? requireLiveSandboxSessionSecret(input.sessionSecret)
    : input.sessionSecret ?? DEFAULT_SESSION_SECRET;
  const auth = new AuthService(input.store, input.builtinAdminPassword, sessionSecret);
  const modelCredentialResolver = input.modelCredentialResolver ?? new EnvModelCredentialResolver();
  const chat = new ChatService(
    endpoints,
    workspaces,
    input.chatClient ?? new FetchOpenAICompatibleClient(),
    modelCredentialResolver
  );
  const namespace = input.namespace ?? "agentsmith";
  const sandboxLifecycle = new SandboxLifecycleService(input.store, {
    namespace,
    ...(input.liveSandbox ? { port: input.liveSandbox.port } : {})
  });
  const taskConfig = {
    dataRoot: input.dataRoot,
    namespace,
    pvcName: input.pvcName ?? "agentsmith-lite-files",
    botifiedRunnerImage: input.botifiedRunnerImage ?? "agentsmith-lite/botified-runner:dev",
    botifiedServiceKeySecret: sessionSecret,
    modelCredentialResolver,
    sandboxLifecycle,
    ...(input.liveSandboxMaxLifetimeMs !== undefined ? { liveSandboxMaxLifetimeMs: input.liveSandboxMaxLifetimeMs } : {}),
    ...(input.liveSandboxIdleTimeoutMs !== undefined ? { liveSandboxIdleTimeoutMs: input.liveSandboxIdleTimeoutMs } : {}),
    ...(input.liveSandbox ? { liveSandbox: input.liveSandbox } : {}),
    ...(input.botifiedServiceKeyFactory ? { botifiedServiceKeyFactory: input.botifiedServiceKeyFactory } : {}),
    ...(input.botifiedBaseUrlForTask ? { botifiedBaseUrlForTask: input.botifiedBaseUrlForTask } : {})
  };
  const tasks = new TaskService(
    input.store,
    workspaces,
    endpoints,
    input.botifiedClient ?? new DryRunBotifiedRuntimeHttpClient(),
    taskConfig
  );

  return {
    auth,
    workspaces,
    endpoints,
    chat,
    files,
    tasks,
    sandboxLifecycle,
    dataRoot: input.dataRoot,
    projectAbsoluteRoot(projectRootPath: string): string {
      return path.resolve(input.dataRoot, projectRootPath);
    },
    async dashboard(userId: string) {
      const workspaceList = await workspaces.listWorkspaces(userId);
      const projectIds = workspaceList.flatMap((workspace) => workspace.projects.map((project) => project.id));
      const endpointGroups = await Promise.all(projectIds.map((projectId) => input.store.listEndpointsForProject(projectId)));
      const taskGroups = await Promise.all(projectIds.map((projectId) => input.store.listTasksForProject(projectId)));
      return {
        workspaces: workspaceList,
        endpoints: endpointGroups.flat(),
        tasks: taskGroups.flat()
      };
    }
  };
}

export function requireLiveSandboxSessionSecret(sessionSecret: string | undefined): string {
  const trimmed = sessionSecret?.trim();
  if (!trimmed || trimmed === DEFAULT_SESSION_SECRET) {
    throw new Error("APP_SESSION_SECRET must be set to a non-default value when AGENTSMITH_LITE_SANDBOX_MODE=live");
  }
  return trimmed;
}
