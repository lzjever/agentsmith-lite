export interface AppDeployPlanInput {
  out: string;
  timeout?: string;
  env?: Record<string, string | undefined>;
}

export interface KubectlCommand {
  executable: "kubectl";
  args: string[];
}

export const APP_DEPLOY_SCHEMA_BOOTSTRAP_JOB = "agentsmith-lite-schema-bootstrap";
export const APP_DEPLOY_API_DEPLOYMENT = "agentsmith-lite-api";
export const APP_DEPLOY_WEB_DEPLOYMENT = "agentsmith-lite-web";
export const DEFAULT_APP_DEPLOY_NAMESPACE = "agentsmith";
export const DEFAULT_APP_DEPLOY_TIMEOUT = "300s";
export const APP_DEPLOY_PHASE_LABEL = "agentsmith-lite.io/deploy-phase";

export function createAppDeployPlan(input: AppDeployPlanInput): KubectlCommand[] {
  const timeout = input.timeout ?? DEFAULT_APP_DEPLOY_TIMEOUT;
  const globalArgs = createKubectlGlobalArgs(input.env ?? {});

  return [
    kubectl(globalArgs,["delete",`deployment/${APP_DEPLOY_API_DEPLOYMENT}`,"--ignore-not-found"]),
    kubectl(globalArgs,["delete","pod","--selector=app.kubernetes.io/component=api","--ignore-not-found","--wait=true",`--timeout=${timeout}`]),
    kubectl(globalArgs, ["delete", `job/${APP_DEPLOY_SCHEMA_BOOTSTRAP_JOB}`, "--ignore-not-found"]),
    applyPhase(globalArgs, input.out, "base"),
    applyPhase(globalArgs, input.out, "migration"),
    kubectl(globalArgs, ["wait", "--for=condition=complete", `job/${APP_DEPLOY_SCHEMA_BOOTSTRAP_JOB}`, `--timeout=${timeout}`]),
    applyPhase(globalArgs, input.out, "workload"),
    kubectl(globalArgs, ["rollout", "status", `deploy/${APP_DEPLOY_API_DEPLOYMENT}`, `--timeout=${timeout}`]),
    kubectl(globalArgs, ["rollout", "status", `deploy/${APP_DEPLOY_WEB_DEPLOYMENT}`, `--timeout=${timeout}`])
  ];
}

function applyPhase(globalArgs: string[], out: string, phase: "base" | "migration" | "workload"): KubectlCommand {
  return kubectl(globalArgs, ["apply", "-f", out, "--selector", `${APP_DEPLOY_PHASE_LABEL}=${phase}`]);
}

export function formatKubectlCommand(command: KubectlCommand): string {
  return [command.executable, ...command.args].map(shellQuote).join(" ");
}

function createKubectlGlobalArgs(env: Record<string, string | undefined>): string[] {
  const args: string[] = [];
  appendFlag(args, "--kubeconfig", env.KUBECONFIG_PATH);
  appendFlag(args, "--context", env.KUBE_CONTEXT);
  appendFlag(args, "--namespace", env.KUBE_NAMESPACE?.trim() ? env.KUBE_NAMESPACE : DEFAULT_APP_DEPLOY_NAMESPACE);
  return args;
}

function appendFlag(args: string[], flag: string, value: string | undefined): void {
  if (value && value.trim()) {
    args.push(flag, value);
  }
}

function kubectl(globalArgs: string[], args: string[]): KubectlCommand {
  return { executable: "kubectl", args: [...globalArgs, ...args] };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
