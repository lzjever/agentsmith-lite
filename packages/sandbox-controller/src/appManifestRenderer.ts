import type { KubernetesResource } from "../../contracts/src/api.js";
import { DEFAULT_SANDBOX_NAMESPACE_LIMIT } from "../../domain/src/sandboxDefaults.js";
import type { AppImageRefs } from "./appImageLock.js";

export interface AppManifestInput {
  namespace: string;
  imageTag: string;
  env: Record<string, string>;
  secrets: Record<string, string>;
  imageRefs?: AppImageRefs;
}

export function renderAppManifests(input: AppManifestInput): KubernetesResource[] {
  const publicBaseUrl = input.env.APP_PUBLIC_BASE_URL?.trim() || "http://localhost:3000";
  const appDataRoot = resolveAppDataRoot(input.env);
  const labels = {
    "app.kubernetes.io/name": "agentsmith-lite",
    "app.kubernetes.io/part-of": "agentsmith-lite",
    "app.kubernetes.io/managed-by": "agentsmith-lite",
    "agentsmith-lite/managed-by": "agentsmith-lite"
  };
  const apiLabels = { ...labels, "app.kubernetes.io/component": "api" };
  const modelBaseUrlConfig = Object.fromEntries(
    Object.entries(input.env).filter(([key]) => key.startsWith("AGENTSMITH_LITE_MODEL_BASE_URL_"))
  );
  const appSecretData: Record<string, string> = {};
  const appSecretKeys = Object.keys(input.secrets).filter((key) =>
    ["POSTGRES_APP_URL", "APP_SESSION_SECRET", "BUILTIN_ADMIN_INITIAL_PASSWORD", "OIDC_CLIENT_SECRET"].includes(key) ||
    key.startsWith("AGENTSMITH_LITE_MODEL_API_KEY_")
  );
  for (const key of appSecretKeys) {
    const value = input.secrets[key];
    if (value) {
      appSecretData[key] = value;
    }
  }
  const appImage = input.imageRefs?.app ?? `agentsmith-lite/app:${input.imageTag}`;
  const runnerImage = input.imageRefs?.botifiedRunner ?? input.env.BOTIFIED_RUNNER_IMAGE ?? `agentsmith-lite/botified-runner:${input.imageTag}`;
  const ingress = renderAppIngress(input, publicBaseUrl, apiLabels);

  return [
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "agentsmith-lite-config", namespace: input.namespace, labels },
      data: {
        APP_PUBLIC_BASE_URL: publicBaseUrl,
        AGENTSMITH_LITE_DATA_DIR: appDataRoot,
        JUICEFS_PVC_NAME: input.env.JUICEFS_PVC_NAME ?? "agentsmith-lite-files",
        KUBE_NAMESPACE: input.namespace,
        AGENTSMITH_LITE_SANDBOX_MODE: input.env.AGENTSMITH_LITE_SANDBOX_MODE ?? "dry-run",
        AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT:
          input.env.AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT ?? String(DEFAULT_SANDBOX_NAMESPACE_LIMIT),
        BOTIFIED_RUNNER_IMAGE: runnerImage,
        AUTH_MODE: input.env.AUTH_MODE ?? "builtin_admin",
        ...modelBaseUrlConfig
      }
    },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "agentsmith-lite-app-secrets", namespace: input.namespace, labels },
      type: "Opaque",
      stringData: appSecretData
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "agentsmith-lite-api", namespace: input.namespace, labels: apiLabels },
      spec: {
        replicas: 1,
        selector: { matchLabels: apiLabels },
        template: {
          metadata: { labels: apiLabels },
          spec: {
            serviceAccountName: "agentsmith-lite-api",
            containers: [
              {
                name: "api",
                image: appImage,
                ports: [{ containerPort: 3000 }],
                envFrom: [
                  { configMapRef: { name: "agentsmith-lite-config" } },
                  { secretRef: { name: "agentsmith-lite-app-secrets" } }
                ],
                volumeMounts: [
                  {
                    name: "project-files",
                    mountPath: appDataRoot
                  }
                ]
              }
            ],
            volumes: [
              {
                name: "project-files",
                persistentVolumeClaim: {
                  claimName: input.env.JUICEFS_PVC_NAME ?? "agentsmith-lite-files"
                }
              }
            ]
          }
        }
      }
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "agentsmith-lite-api", namespace: input.namespace, labels: apiLabels },
      spec: {
        selector: apiLabels,
        ports: [{ name: "http", port: 80, targetPort: 3000 }]
      }
    },
    ...(ingress ? [ingress] : []),
    {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: "agentsmith-lite-schema-bootstrap", namespace: input.namespace, labels },
      spec: {
        backoffLimit: 2,
        activeDeadlineSeconds: 300,
        ttlSecondsAfterFinished: 600,
        template: {
          metadata: { labels },
          spec: {
            restartPolicy: "OnFailure",
            containers: [
              {
                name: "schema-bootstrap",
                image: appImage,
                command: ["node", "scripts/db/apply-migrations.mjs"],
                envFrom: [{ secretRef: { name: "agentsmith-lite-app-secrets" } }]
              }
            ]
          }
        }
      }
    },
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "agentsmith-lite-api", namespace: input.namespace, labels }
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: { name: "agentsmith-lite-api-sandbox", namespace: input.namespace, labels },
      rules: [
        {
          apiGroups: [""],
          resources: ["pods", "services", "secrets", "configmaps", "serviceaccounts"],
          verbs: ["create", "get", "list", "delete", "patch"]
        },
        {
          apiGroups: ["networking.k8s.io"],
          resources: ["networkpolicies"],
          verbs: ["create", "get", "list", "delete", "patch"]
        }
      ]
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name: "agentsmith-lite-api-sandbox", namespace: input.namespace, labels },
      subjects: [{ kind: "ServiceAccount", name: "agentsmith-lite-api" }],
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: "agentsmith-lite-api-sandbox"
      }
    },
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: { name: "agentsmith-lite-sandbox-quota", namespace: input.namespace, labels },
      spec: {
        hard: {
          pods: "50",
          "requests.cpu": "20",
          "requests.memory": "80Gi"
        }
      }
    },
    {
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: { name: "agentsmith-lite-sandbox-limits", namespace: input.namespace, labels },
      spec: {
        limits: [
          {
            type: "Container",
            defaultRequest: { cpu: "250m", memory: "512Mi" },
            default: { cpu: "1", memory: "1Gi" }
          }
        ]
      }
    }
  ];
}

function resolveAppDataRoot(env: Record<string, string>): string {
  const dataRoot = env.AGENTSMITH_LITE_DATA_DIR ?? "/agentsmith-lite";
  if (!dataRoot.startsWith("/")) {
    throw new Error("AGENTSMITH_LITE_DATA_DIR must be an absolute path");
  }
  return dataRoot;
}

function renderAppIngress(input: AppManifestInput, publicBaseUrl: string, labels: Record<string, string>): KubernetesResource | undefined {
  let parsed: URL;
  try {
    parsed = new URL(publicBaseUrl);
  } catch {
    throw new Error("APP_PUBLIC_BASE_URL must be an http or https URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("APP_PUBLIC_BASE_URL must be an http or https URL");
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return undefined;
  }

  const ingressClassName = input.env.APP_INGRESS_CLASS?.trim();
  const tlsSecretName = input.env.APP_TLS_SECRET_NAME?.trim();
  const spec: Record<string, unknown> = {
    rules: [
      {
        host: parsed.hostname,
        http: {
          paths: [
            {
              path: parsed.pathname || "/",
              pathType: "Prefix",
              backend: {
                service: {
                  name: "agentsmith-lite-api",
                  port: {
                    name: "http"
                  }
                }
              }
            }
          ]
        }
      }
    ]
  };

  if (ingressClassName) {
    spec.ingressClassName = ingressClassName;
  }
  if (parsed.protocol === "https:" && tlsSecretName) {
    spec.tls = [{ hosts: [parsed.hostname], secretName: tlsSecretName }];
  }

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: { name: "agentsmith-lite-api", namespace: input.namespace, labels },
    spec
  };
}
