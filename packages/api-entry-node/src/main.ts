import path from "node:path";
import { FetchBotifiedRuntimeHttpClient } from "../../ports/src/botified.js";
import { SandboxKubernetesPort } from "../../sandbox-controller/src/kubernetesPort.js";
import { optionalRuntimeTickIntervalMs, parseRuntimeAuthConfig, parseSandboxMode, parseSandboxNamespaceLimit } from "./runtimeConfig.js";
import { createOpenIdConnectClient } from "./oidcClient.js";
import { createApiServer } from "./server.js";

const MODEL_CA_BUNDLE_PATH = "/etc/agentsmith-lite/model-ca/ca.crt";
const DEFAULT_MODEL_CA_CONFIG_KEY = "ca.crt";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const dataRoot = process.env.AGENTSMITH_LITE_DATA_DIR ?? path.resolve(".data");
const builtinAdminPassword = process.env.BUILTIN_ADMIN_INITIAL_PASSWORD ?? "admin-password";
const sessionSecret = process.env.APP_SESSION_SECRET ?? "dev-session-secret";
const authConfig = parseRuntimeAuthConfig(process.env);
const sandboxMode = parseSandboxMode(process.env.AGENTSMITH_LITE_SANDBOX_MODE);
const sandboxNamespaceLimit = parseSandboxNamespaceLimit(process.env.AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT);
const liveSandboxEnabled = sandboxMode === "live";
const modelCaConfigMap = process.env.AGENTSMITH_LITE_MODEL_CA_CONFIG_MAP?.trim();
const modelCaConfigKey = process.env.AGENTSMITH_LITE_MODEL_CA_CONFIG_KEY?.trim();
if (!modelCaConfigMap && modelCaConfigKey) {
  throw new Error("AGENTSMITH_LITE_MODEL_CA_CONFIG_MAP is required when AGENTSMITH_LITE_MODEL_CA_CONFIG_KEY is set");
}
const runtimeTickIntervalMs = liveSandboxEnabled
  ? optionalRuntimeTickIntervalMs(process.env.AGENTSMITH_LITE_RUNTIME_TICK_MS)
  : undefined;
const oidcClient = authConfig.mode === "oidc" && authConfig.oidc
  ? await createOpenIdConnectClient(authConfig.oidc)
  : undefined;

const server = await createApiServer({
  port,
  dataRoot,
  authMode: authConfig.mode,
  builtinAdminPassword,
  sessionSecret,
  ...(process.env.APP_PUBLIC_BASE_URL ? { publicBaseUrl: process.env.APP_PUBLIC_BASE_URL } : {}),
  ...(oidcClient ? { oidcClient } : {}),
  namespace: process.env.KUBE_NAMESPACE ?? "agentsmith",
  pvcName: process.env.JUICEFS_PVC_NAME ?? "agentsmith-lite-files",
  botifiedRunnerImage: process.env.BOTIFIED_RUNNER_IMAGE ?? "agentsmith-lite/botified-runner:dev",
  sandboxNamespaceLimit,
  ...(modelCaConfigMap
    ? {
        modelCa: {
          configMapName: modelCaConfigMap,
          configMapKey: modelCaConfigKey || DEFAULT_MODEL_CA_CONFIG_KEY,
          path: MODEL_CA_BUNDLE_PATH
        }
      }
    : {}),
  ...(runtimeTickIntervalMs !== undefined ? { runtimeTickIntervalMs } : {}),
  ...(liveSandboxEnabled
    ? {
        botifiedClient: new FetchBotifiedRuntimeHttpClient(),
        liveSandbox: {
          port: new SandboxKubernetesPort()
        }
      }
    : {})
});

console.log(`AgentSmith Lite API listening on ${server.baseUrl}`);
