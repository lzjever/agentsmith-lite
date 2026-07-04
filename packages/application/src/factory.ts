import path from "node:path";
import { EnvModelCredentialResolver, FetchOpenAICompatibleClient, type ModelCredentialResolver, type OpenAICompatibleClient } from "../../openai-compatible-client/src/index.js";
import { DryRunBotifiedRuntimeHttpClient, type BotifiedRuntimeHttpClient } from "../../ports/src/botified.js";
import type { ProductStore } from "../../ports/src/store.js";
import { AuthService } from "./authService.js";
import { ChatService } from "./chatService.js";
import { EndpointService } from "./endpointService.js";
import { FileService } from "./fileService.js";
import { TaskService, type BotifiedTaskAddressInput } from "./taskService.js";
import { WorkspaceService } from "./workspaceService.js";

export interface CreateApplicationServicesInput {
  store: ProductStore;
  dataRoot: string;
  builtinAdminPassword: string;
  sessionSecret?: string;
  namespace?: string;
  pvcName?: string;
  botifiedRunnerImage?: string;
  botifiedClient?: BotifiedRuntimeHttpClient;
  botifiedServiceKeyFactory?: () => string | undefined;
  botifiedBaseUrlForTask?: (input: BotifiedTaskAddressInput) => string;
  chatClient?: OpenAICompatibleClient;
  modelCredentialResolver?: ModelCredentialResolver;
}

export function createApplicationServices(input: CreateApplicationServicesInput) {
  const workspaces = new WorkspaceService(input.store);
  const endpoints = new EndpointService(input.store, workspaces);
  const files = new FileService();
  const auth = new AuthService(input.store, input.builtinAdminPassword, input.sessionSecret ?? "dev-session-secret");
  const chat = new ChatService(
    endpoints,
    workspaces,
    input.chatClient ?? new FetchOpenAICompatibleClient(),
    input.modelCredentialResolver ?? new EnvModelCredentialResolver()
  );
  const taskConfig = {
    namespace: input.namespace ?? "agentsmith",
    pvcName: input.pvcName ?? "agentsmith-lite-files",
    botifiedRunnerImage: input.botifiedRunnerImage ?? "agentsmith-lite/botified-runner:dev",
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
