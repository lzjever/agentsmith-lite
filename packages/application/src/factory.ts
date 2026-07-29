import path from "node:path";
import { FetchOpenAICompatibleClient, type OpenAICompatibleClient } from "../../openai-compatible-client/src/index.js";
import { DryRunBotifiedRuntimeHttpClient, type BotifiedRuntimeHttpClient } from "../../ports/src/botified.js";
import type { ProductStore } from "../../ports/src/store.js";
import { AuthService } from "./authService.js";
import { AuthorizationService } from "./authorizationService.js";
import { EndpointService } from "./endpointService.js";
import { FileService } from "./fileService.js";
import { FilePathValidationService } from "./filePathValidationService.js";
import { FileLibraryService } from "./fileLibraryService.js";
import { MembershipService } from "./membershipService.js";
import { RuntimeService } from "./runtimeService.js";
import { SandboxLifecycleService, type SandboxLifecycleKubernetesPort } from "./sandboxLifecycleService.js";
import { TaskService, type BotifiedServiceKeyInput, type BotifiedTaskAddressInput, type ModelCaReference, type TaskLiveSandboxConfig, type TaskTerminalHostInput } from "./taskService.js";
import { WorkspaceService } from "./workspaceService.js";
import { ProjectPolicyService } from "./projectPolicyService.js";
import { ProfileService } from "./profileService.js";
import { SettingsService } from "./settingsService.js";
import { ContextService } from "./contextService.js";
import { NotificationService } from "./notificationService.js";
import { AlertRuleService } from "./alertRuleService.js";
import { CredentialService } from "./credentialService.js";
import { createCredentialCrypto, type CredentialCrypto } from "./credentialCrypto.js";
import { DeletionService } from "./deletionService.js";
import { WorkspaceMembershipService } from "./workspaceMembershipService.js";
import { OpenAIProviderBroker } from "./openAIProviderBroker.js";

export const DEFAULT_SESSION_SECRET = "dev-session-secret";
export const DEFAULT_BUILTIN_ADMIN_PASSWORD = "admin-password";
export const MIN_SESSION_SECRET_LENGTH = 32;

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
  terminalHostForRun?: (input:TaskTerminalHostInput)=>string;
  providerClient?: OpenAICompatibleClient;
  credentialCrypto?: CredentialCrypto;
  modelCa?: ModelCaReference;
  liveSandbox?: TaskLiveSandboxConfig;
  requireBuiltinAdminPasswordForLiveSandbox?: boolean;
  sandboxLifecyclePort?: SandboxLifecycleKubernetesPort;
  sandboxNamespaceLimit?: number;
  taskDeliveryLeaseMs?: number;
  runtimeTickIntervalMs?: number;
}

export function createApplicationServices(input: CreateApplicationServicesInput) {
  const authorization = new AuthorizationService(input.store);
  const policies = new ProjectPolicyService(input.store, authorization);
  const workspaces = new WorkspaceService(input.store, authorization, policies);
  const memberships = new MembershipService(input.store, authorization);
  const workspaceMemberships = new WorkspaceMembershipService(input.store, authorization);
  const files = new FileService(new FilePathValidationService(input.dataRoot));
  const projectAbsoluteRoot=(projectRootPath:string)=>path.resolve(input.dataRoot,projectRootPath);
  const fileLibraries=new FileLibraryService(input.store,authorization,files,projectAbsoluteRoot);
  const builtinAdminPassword = input.liveSandbox && input.requireBuiltinAdminPasswordForLiveSandbox !== false
    ? requireLiveSandboxBuiltinAdminPassword(input.builtinAdminPassword)
    : input.builtinAdminPassword;
  const sessionSecret = input.liveSandbox
    ? requireLiveSandboxSessionSecret(input.sessionSecret)
    : input.sessionSecret ?? DEFAULT_SESSION_SECRET;
  const auth = new AuthService(input.store, builtinAdminPassword, sessionSecret);
  const profile = new ProfileService(input.store);
  const settings = new SettingsService(input.store, authorization);
  const contexts = new ContextService(input.store, workspaces);
  const notifications = new NotificationService(input.store);
  const alertRules = new AlertRuleService(input.store, authorization);
  const credentialCrypto = input.credentialCrypto ?? createCredentialCrypto({ primary: { id: "test", value: Buffer.alloc(32, 1) }, previous: [] });
  const credentials = new CredentialService(input.store, authorization, credentialCrypto);
  const providerClient = input.providerClient ?? new FetchOpenAICompatibleClient();
  const providerBroker = new OpenAIProviderBroker(providerClient, policies);
  const endpoints = new EndpointService(input.store, workspaces, credentials, providerBroker);
  const namespace = input.namespace ?? "agentsmith";
  const sandboxLifecyclePort = input.liveSandbox?.port ?? input.sandboxLifecyclePort;
  let tasks: TaskService;
  const sandboxLifecycle = new SandboxLifecycleService(input.store, {
    namespace,
    ...(sandboxLifecyclePort ? { port: sandboxLifecyclePort } : {}),
    hasLocalStartupOperation:(runId)=>tasks?.hasLocalStartupOperation(runId)??false,
    withProjectFileMeasurement:(projectId,project)=>fileLibraries.reconcileStoredProjectFileBytes(projectId,project),
    refreshProjectFileAlerts:(projectId)=>policies.refreshFileAlerts(projectId)
  });
  const taskConfig = {
    dataRoot: input.dataRoot,
    namespace,
    pvcName: input.pvcName ?? "agentsmith-lite-files",
    botifiedRunnerImage: input.botifiedRunnerImage ?? "agentsmith-lite/botified-runner:dev",
    botifiedServiceKeySecret: sessionSecret,
    credentials,
    sandboxLifecycle,
    ...(input.sandboxNamespaceLimit !== undefined ? { sandboxNamespaceLimit: input.sandboxNamespaceLimit } : {}),
    ...(input.taskDeliveryLeaseMs !== undefined ? { deliveryLeaseMs: input.taskDeliveryLeaseMs } : {}),
    contexts,
    ...(input.liveSandbox ? { liveSandbox: input.liveSandbox } : {}),
    ...(input.botifiedServiceKeyFactory ? { botifiedServiceKeyFactory: input.botifiedServiceKeyFactory } : {}),
    ...(input.botifiedBaseUrlForTask ? { botifiedBaseUrlForTask: input.botifiedBaseUrlForTask } : {}),
    ...(input.terminalHostForRun ? { terminalHostForRun: input.terminalHostForRun } : {})
  };
  tasks = new TaskService(
    input.store,
    workspaces,
    endpoints,
    input.botifiedClient ?? new DryRunBotifiedRuntimeHttpClient(),
    taskConfig,
    policies,
    fileLibraries
  );
  const runtime = new RuntimeService(tasks, sandboxLifecycle, policies, {
    ...(input.runtimeTickIntervalMs !== undefined ? { tickIntervalMs: input.runtimeTickIntervalMs } : {})
  });
  const deletion = new DeletionService(input.store, input.dataRoot);

  return {
    auth,
    profile,
    settings,
    contexts,
    notifications,
    alertRules,
    credentials,
    authorization,
    memberships,
    workspaceMemberships,
    workspaces,
    endpoints,
    providerBroker,
    files,
    fileLibraries,
    policies,
    tasks,
    deletion,
    runtime,
    sandboxLifecycle,
    dataRoot: input.dataRoot,
    projectAbsoluteRoot(projectRootPath: string): string {
      return projectAbsoluteRoot(projectRootPath);
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
