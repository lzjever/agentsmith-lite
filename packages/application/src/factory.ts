import path from "node:path";
import { EnvModelCredentialResolver, FetchOpenAICompatibleClient, type ModelCredentialResolver, type OpenAICompatibleClient } from "../../openai-compatible-client/src/index.js";
import { DryRunBotifiedRuntimeHttpClient, type BotifiedRuntimeHttpClient } from "../../ports/src/botified.js";
import type { ProductStore } from "../../ports/src/store.js";
import { AuthService } from "./authService.js";
import { ChatService } from "./chatService.js";
import { EndpointService } from "./endpointService.js";
import { FileService } from "./fileService.js";
import { RuntimeService } from "./runtimeService.js";
import { SandboxLifecycleService, type SandboxLifecycleKubernetesPort } from "./sandboxLifecycleService.js";
import { TaskService, type BotifiedServiceKeyInput, type BotifiedTaskAddressInput, type ModelCaReference, type TaskLiveSandboxConfig } from "./taskService.js";
import { WorkspaceService } from "./workspaceService.js";

export const DEFAULT_SESSION_SECRET = "dev-session-secret";
export const DEFAULT_BUILTIN_ADMIN_PASSWORD = "admin-password";
export const MIN_SESSION_SECRET_LENGTH = 32;

export interface CreateApplicationServicesInput {
  store: ProductStore;
  dataRoot: string;
  builtinAdminPassword: string;
  sessionSecret?: string;
  oidcAdminEmails?: string[];
  oidcAdminSubjects?: string[];
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
  requireBuiltinAdminPasswordForLiveSandbox?: boolean;
  sandboxLifecyclePort?: SandboxLifecycleKubernetesPort;
  sandboxNamespaceLimit?: number;
  liveSandboxMaxLifetimeMs?: number;
  liveSandboxIdleTimeoutMs?: number;
  runtimeTickIntervalMs?: number;
}

export function createApplicationServices(input: CreateApplicationServicesInput) {
  const workspaces = new WorkspaceService(input.store);
  const endpoints = new EndpointService(input.store, workspaces);
  const files = new FileService();
  const builtinAdminPassword = input.liveSandbox && input.requireBuiltinAdminPasswordForLiveSandbox !== false
    ? requireLiveSandboxBuiltinAdminPassword(input.builtinAdminPassword)
    : input.builtinAdminPassword;
  const sessionSecret = input.liveSandbox
    ? requireLiveSandboxSessionSecret(input.sessionSecret)
    : input.sessionSecret ?? DEFAULT_SESSION_SECRET;
  const auth = new AuthService(input.store, builtinAdminPassword, sessionSecret, {
    emails: input.oidcAdminEmails ?? [],
    subjects: input.oidcAdminSubjects ?? []
  });
  const modelCredentialResolver = input.modelCredentialResolver ?? new EnvModelCredentialResolver();
  const chat = new ChatService(
    endpoints,
    input.chatClient ?? new FetchOpenAICompatibleClient(),
    modelCredentialResolver
  );
  const namespace = input.namespace ?? "agentsmith";
  const sandboxLifecyclePort = input.liveSandbox?.port ?? input.sandboxLifecyclePort;
  let tasks: TaskService;
  const sandboxLifecycle = new SandboxLifecycleService(input.store, {
    dataRoot: input.dataRoot,
    namespace,
    ...(sandboxLifecyclePort ? { port: sandboxLifecyclePort } : {}),
    terminalFailureSync: {
      async syncTerminalFailureRun(runId) {
        return tasks.syncTerminalFailureRun(runId);
      }
    }
  });
  const taskConfig = {
    dataRoot: input.dataRoot,
    namespace,
    pvcName: input.pvcName ?? "agentsmith-lite-files",
    botifiedRunnerImage: input.botifiedRunnerImage ?? "agentsmith-lite/botified-runner:dev",
    botifiedServiceKeySecret: sessionSecret,
    modelCredentialResolver,
    ...(input.modelCa ? { modelCa: input.modelCa } : {}),
    sandboxLifecycle,
    ...(input.sandboxNamespaceLimit !== undefined ? { sandboxNamespaceLimit: input.sandboxNamespaceLimit } : {}),
    ...(input.liveSandboxMaxLifetimeMs !== undefined ? { liveSandboxMaxLifetimeMs: input.liveSandboxMaxLifetimeMs } : {}),
    ...(input.liveSandboxIdleTimeoutMs !== undefined ? { liveSandboxIdleTimeoutMs: input.liveSandboxIdleTimeoutMs } : {}),
    ...(input.liveSandbox ? { liveSandbox: input.liveSandbox } : {}),
    ...(input.botifiedServiceKeyFactory ? { botifiedServiceKeyFactory: input.botifiedServiceKeyFactory } : {}),
    ...(input.botifiedBaseUrlForTask ? { botifiedBaseUrlForTask: input.botifiedBaseUrlForTask } : {})
  };
  tasks = new TaskService(
    input.store,
    workspaces,
    endpoints,
    input.botifiedClient ?? new DryRunBotifiedRuntimeHttpClient(),
    taskConfig
  );
  const runtime = new RuntimeService(tasks, sandboxLifecycle, {
    ...(input.runtimeTickIntervalMs !== undefined ? { tickIntervalMs: input.runtimeTickIntervalMs } : {})
  });

  return {
    auth,
    workspaces,
    endpoints,
    chat,
    files,
    tasks,
    runtime,
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
  if (!trimmed || trimmed === DEFAULT_SESSION_SECRET || trimmed.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `APP_SESSION_SECRET must be set to a non-default value of at least ${MIN_SESSION_SECRET_LENGTH} characters when AGENTSMITH_LITE_SANDBOX_MODE=live`
    );
  }
  return trimmed;
}

export function requireLiveSandboxBuiltinAdminPassword(builtinAdminPassword: string | undefined): string {
  const trimmed = builtinAdminPassword?.trim();
  if (!trimmed || trimmed === DEFAULT_BUILTIN_ADMIN_PASSWORD) {
    throw new Error("BUILTIN_ADMIN_INITIAL_PASSWORD must be set to a non-default value when AGENTSMITH_LITE_SANDBOX_MODE=live");
  }
  return trimmed;
}
