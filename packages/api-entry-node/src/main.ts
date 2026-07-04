import path from "node:path";
import { FetchBotifiedRuntimeHttpClient } from "../../ports/src/botified.js";
import { SandboxKubernetesPort } from "../../sandbox-controller/src/kubernetesPort.js";
import { createApiServer } from "./server.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const dataRoot = process.env.AGENTSMITH_LITE_DATA_DIR ?? path.resolve(".data");
const builtinAdminPassword = process.env.BUILTIN_ADMIN_INITIAL_PASSWORD ?? "admin-password";
const sessionSecret = process.env.APP_SESSION_SECRET ?? "dev-session-secret";
const liveSandboxEnabled = process.env.AGENTSMITH_LITE_SANDBOX_MODE === "live";

const server = await createApiServer({
  port,
  dataRoot,
  builtinAdminPassword,
  sessionSecret,
  namespace: process.env.KUBE_NAMESPACE ?? "agentsmith",
  pvcName: process.env.JUICEFS_PVC_NAME ?? "agentsmith-lite-files",
  botifiedRunnerImage: process.env.BOTIFIED_RUNNER_IMAGE ?? "agentsmith-lite/botified-runner:dev",
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
