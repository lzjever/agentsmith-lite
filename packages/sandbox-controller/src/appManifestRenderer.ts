import type { KubernetesResource } from "../../contracts/src/api.js";
import { DEFAULT_SANDBOX_NAMESPACE_LIMIT } from "../../domain/src/sandboxDefaults.js";
import type { AppImageRefs } from "./appImageLock.js";

const MODEL_CA_BUNDLE_PATH = "/etc/agentsmith-lite/model-ca/ca.crt";
const DEFAULT_MODEL_CA_CONFIG_KEY = "ca.crt";
const DEPLOY_PHASE_LABEL = "agentsmith-lite.io/deploy-phase";
export const APP_KUBERNETES_SERVICE_NAME = "agentsmith-lite-api";
export const APP_KUBERNETES_SERVICE_PORT = 80;
export const APP_KUBERNETES_CONTAINER_PORT = 3000;
export const WEB_KUBERNETES_SERVICE_NAME = "agentsmith-lite-web";
export const WEB_KUBERNETES_SERVICE_PORT = 80;

export interface AppManifestInput {
  namespace: string;
  imageTag: string;
  env: Record<string, string>;
  secrets: Record<string, string>;
  imageRefs?: AppImageRefs;
}

export function renderAppManifests(input: AppManifestInput): KubernetesResource[] {
  const auth = resolveAuthConfig(input);
  const publicBaseUrl = requirePublicBaseUrl(input.env.APP_PUBLIC_BASE_URL);
  const parsedPublicBaseUrl = parsePublicBaseUrl(publicBaseUrl);
  const publicBasePath = normalizedPublicBasePath(parsedPublicBaseUrl.pathname);
  const apiHealthPath = publicPathFor(publicBasePath, "/api/v1/health");
  const apiReadyPath = publicPathFor(publicBasePath, "/api/v1/ready");
  const webHealthPath = publicPathFor(publicBasePath, "/health");
  const appDataRoot = resolveAppDataRoot(input.env);
  const runtimeTickMs = input.env.AGENTSMITH_LITE_RUNTIME_TICK_MS?.trim();
  const privateProviderHosts = input.env.AGENTSMITH_LITE_PRIVATE_PROVIDER_HOSTS?.trim();
  const modelCa = resolveModelCa(input);
  const labels = {
    "app.kubernetes.io/name": "agentsmith-lite",
    "app.kubernetes.io/part-of": "agentsmith-lite",
    "app.kubernetes.io/managed-by": "agentsmith-lite",
    "agentsmith-lite/managed-by": "agentsmith-lite"
  };
  const apiLabels = { ...labels, "app.kubernetes.io/component": "api" };
  const webLabels = { ...labels, "app.kubernetes.io/component": "web" };
  const appSecretData: Record<string, string> = {};
  const appSecretKeys = Object.keys(input.secrets).filter((key) => auth.secretKeys.has(key) || isAppRuntimeSecretKey(key));
  for (const key of appSecretKeys) {
    const value = input.secrets[key];
    if (value) {
      appSecretData[key] = value;
    }
  }
  const appImage = input.imageRefs?.app ?? `agentsmith-lite/app:${input.imageTag}`;
  const runnerImage = input.imageRefs?.botifiedRunner ?? input.env.BOTIFIED_RUNNER_IMAGE ?? `agentsmith-lite/botified-runner:${input.imageTag}`;
  const ingress = renderAppIngress(input, parsedPublicBaseUrl, publicBasePath, labels);

  const resources: KubernetesResource[] = [
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "agentsmith-lite-config", namespace: input.namespace, labels },
      data: {
        APP_BIND_ADDRESS: "0.0.0.0",
        APP_PUBLIC_BASE_URL: publicBaseUrl,
        AGENTSMITH_LITE_DATA_DIR: appDataRoot,
        JUICEFS_PVC_NAME: input.env.JUICEFS_PVC_NAME ?? "agentsmith-lite-files",
        KUBE_NAMESPACE: input.namespace,
        AGENTSMITH_LITE_SANDBOX_MODE: input.env.AGENTSMITH_LITE_SANDBOX_MODE ?? "dry-run",
        AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT:
          input.env.AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT ?? String(DEFAULT_SANDBOX_NAMESPACE_LIMIT),
        ...(runtimeTickMs ? { AGENTSMITH_LITE_RUNTIME_TICK_MS: runtimeTickMs } : {}),
        ...(privateProviderHosts ? { AGENTSMITH_LITE_PRIVATE_PROVIDER_HOSTS: privateProviderHosts } : {}),
        BOTIFIED_RUNNER_IMAGE: runnerImage,
        ...auth.configMapData,
        ...(modelCa
          ? {
              AGENTSMITH_LITE_MODEL_CA_CONFIG_MAP: modelCa.configMapName,
              AGENTSMITH_LITE_MODEL_CA_CONFIG_KEY: modelCa.configMapKey
            }
          : {})
      }
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: WEB_KUBERNETES_SERVICE_NAME, namespace: input.namespace, labels: webLabels },
      spec: {
        replicas: 1,
        selector: { matchLabels: webLabels },
        template: {
          metadata: { labels: webLabels },
          spec: {
            containers: [
              {
                name: "web",
                image: appImage,
                command: ["node", "scripts/web/start.mjs"],
                ports: [{ containerPort: APP_KUBERNETES_CONTAINER_PORT }],
                readinessProbe: webHealthProbe(webHealthPath),
                livenessProbe: webHealthProbe(webHealthPath),
                startupProbe: webHealthProbe(webHealthPath),
                resources: {
                  requests: { cpu: "50m", memory: "128Mi" },
                  limits: { cpu: "500m", memory: "512Mi" }
                },
                env: [{ name: "APP_PUBLIC_BASE_URL", value: publicBaseUrl }]
              }
            ]
          }
        }
      }
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: WEB_KUBERNETES_SERVICE_NAME, namespace: input.namespace, labels: webLabels },
      spec: {
        selector: webLabels,
        ports: [{ name: "http", port: WEB_KUBERNETES_SERVICE_PORT, targetPort: APP_KUBERNETES_CONTAINER_PORT }]
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
      metadata: { name: APP_KUBERNETES_SERVICE_NAME, namespace: input.namespace, labels: apiLabels },
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
                ports: [{ containerPort: APP_KUBERNETES_CONTAINER_PORT }],
                readinessProbe: apiHealthProbe(apiReadyPath),
                livenessProbe: apiHealthProbe(apiHealthPath),
                startupProbe: apiHealthProbe(apiHealthPath),
                resources: {
                  requests: { cpu: "100m", memory: "256Mi" },
                  limits: { cpu: "1", memory: "1Gi" }
                },
                envFrom: [
                  { configMapRef: { name: "agentsmith-lite-config" } },
                  { secretRef: { name: "agentsmith-lite-app-secrets" } }
                ],
                ...(modelCa
                  ? {
                      env: [
                        {
                          name: "NODE_EXTRA_CA_CERTS",
                          value: MODEL_CA_BUNDLE_PATH
                        }
                      ]
                    }
                  : {}),
                volumeMounts: [
                  {
                    name: "project-files",
                    mountPath: appDataRoot,
                    readOnly: false
                  },
                  ...(modelCa
                    ? [
                        {
                          name: "model-ca",
                          mountPath: MODEL_CA_BUNDLE_PATH,
                          subPath: "ca.crt",
                          readOnly: true
                        }
                      ]
                    : [])
                ]
              }
            ],
            volumes: [
              {
                name: "project-files",
                persistentVolumeClaim: {
                  claimName: input.env.JUICEFS_PVC_NAME ?? "agentsmith-lite-files"
                }
              },
              ...(modelCa
                ? [
                    {
                      name: "model-ca",
                      configMap: {
                        name: modelCa.configMapName,
                        items: [
                          {
                            key: modelCa.configMapKey,
                            path: "ca.crt"
                          }
                        ]
                      }
                    }
                  ]
                : [])
            ]
          }
        }
      }
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: APP_KUBERNETES_SERVICE_NAME, namespace: input.namespace, labels: apiLabels },
      spec: {
        selector: apiLabels,
        ports: [{ name: "http", port: APP_KUBERNETES_SERVICE_PORT, targetPort: APP_KUBERNETES_CONTAINER_PORT }]
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
            serviceAccountName: "agentsmith-lite-api",
            containers: [
              {
                name: "schema-bootstrap",
                image: appImage,
                command: ["node", "scripts/db/apply-migrations.mjs"],
                envFrom: [
                  { configMapRef: { name: "agentsmith-lite-config" } },
                  { secretRef: { name: "agentsmith-lite-app-secrets" } }
                ],
                volumeMounts: [
                  {
                    name: "project-files",
                    mountPath: appDataRoot,
                    readOnly: false
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
  return resources.map((resource) => ({
    ...resource,
    metadata: {
      ...resource.metadata,
      labels: {
        ...resource.metadata.labels,
        [DEPLOY_PHASE_LABEL]: resource.kind === "Job"
          ? "migration"
          : resource.kind === "Deployment" ? "workload" : "base"
      }
    }
  }));
}

function resolveAppDataRoot(env: Record<string, string>): string {
  const dataRoot = env.AGENTSMITH_LITE_DATA_DIR ?? "/agentsmith-lite";
  if (!dataRoot.startsWith("/")) {
    throw new Error("AGENTSMITH_LITE_DATA_DIR must be an absolute path");
  }
  return dataRoot;
}

function resolveModelCa(input: AppManifestInput): { configMapName: string; configMapKey: string } | undefined {
  for (const key of ["AGENTSMITH_LITE_MODEL_CA_CONFIG_MAP", "AGENTSMITH_LITE_MODEL_CA_CONFIG_KEY"]) {
    if (Object.hasOwn(input.secrets, key)) {
      throw new Error(`model CA config key ${key} is not allowed in app Secret`);
    }
  }
  for (const key of Object.keys({ ...input.env, ...input.secrets })) {
    if (key === "AGENTSMITH_LITE_MODEL_CA_PEM" || key === "AGENTSMITH_LITE_MODEL_CA_CERT" || key === "AGENTSMITH_LITE_MODEL_CA_CERTIFICATE") {
      throw new Error(`raw model CA key ${key} is not allowed in app manifests`);
    }
  }

  const configMapName = input.env.AGENTSMITH_LITE_MODEL_CA_CONFIG_MAP?.trim();
  const configuredKey = input.env.AGENTSMITH_LITE_MODEL_CA_CONFIG_KEY?.trim();
  if (!configMapName && configuredKey) {
    throw new Error("AGENTSMITH_LITE_MODEL_CA_CONFIG_MAP is required when AGENTSMITH_LITE_MODEL_CA_CONFIG_KEY is set");
  }
  if (!configMapName) {
    return undefined;
  }
  return {
    configMapName,
    configMapKey: configuredKey || DEFAULT_MODEL_CA_CONFIG_KEY
  };
}

function parsePublicBaseUrl(publicBaseUrl: string): URL {
  try {
    const parsed = new URL(publicBaseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("APP_PUBLIC_BASE_URL must be an http or https URL");
    }
    return parsed;
  } catch {
    throw new Error("APP_PUBLIC_BASE_URL must be an http or https URL");
  }
}

function requirePublicBaseUrl(value: string | undefined): string {
  const publicBaseUrl = value?.trim();
  if (!publicBaseUrl) {
    throw new Error("APP_PUBLIC_BASE_URL is required");
  }
  return publicBaseUrl;
}

function normalizedPublicBasePath(publicPathname: string): string {
  return publicPathname.replace(/\/+$/, "") || "/";
}

function publicPathFor(publicBasePath: string, routePath: string): string {
  return publicBasePath === "/" ? routePath : `${publicBasePath}${routePath}`;
}

function apiHealthProbe(path: string): { httpGet: { path: string; port: number } } {
  return {
    httpGet: {
      path,
      port: 3000
    }
  };
}

function webHealthProbe(path: string): { httpGet: { path: string; port: number } } {
  return { httpGet: { path, port: APP_KUBERNETES_CONTAINER_PORT } };
}

function renderAppIngress(input: AppManifestInput, parsed: URL, publicBasePath: string, labels: Record<string, string>): KubernetesResource | undefined {
  const host = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return undefined;
  }

  const ingressClassName = input.env.APP_INGRESS_CLASS?.trim();
  const tlsSecretName = input.env.APP_TLS_SECRET_NAME?.trim();
  const traefikEntrypoints = input.env.APP_INGRESS_TRAEFIK_ENTRYPOINTS?.trim();
  const spec: Record<string, unknown> = {
    rules: [
      {
        host: parsed.hostname,
        http: {
          paths: [
            {
              path: publicPathFor(publicBasePath, "/api/v1"),
              pathType: "Prefix",
              backend: {
                service: {
                  name: APP_KUBERNETES_SERVICE_NAME,
                  port: { name: "http" }
                }
              }
            },
            {
              path: publicBasePath,
              pathType: "Prefix",
              backend: {
                service: {
                  name: WEB_KUBERNETES_SERVICE_NAME,
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
    metadata: {
      name: "agentsmith-lite-api",
      namespace: input.namespace,
      labels,
      ...(ingressClassName === "traefik" && traefikEntrypoints === "websecure"
        ? { annotations: { "traefik.ingress.kubernetes.io/router.entrypoints": "websecure" } }
        : {})
    },
    spec
  };
}

function resolveAuthConfig(input: AppManifestInput): {
  configMapData: Record<string, string>;
  secretKeys: Set<string>;
} {
  const oidcConfigKeys = [
    "OIDC_ISSUER_URL",
    "OIDC_BACKCHANNEL_BASE_URL",
    "OIDC_CLIENT_ID"
  ];
  for (const key of ["AUTH_MODE", ...oidcConfigKeys]) {
    if (Object.hasOwn(input.secrets, key)) {
      throw new Error(`auth config key ${key} is not allowed in app Secret`);
    }
  }
  if (Object.hasOwn(input.env, "OIDC_CLIENT_SECRET")) {
    throw new Error("secret key OIDC_CLIENT_SECRET is not allowed in app ConfigMap");
  }

  const authMode = input.env.AUTH_MODE?.trim();
  if (authMode !== "oidc") {
    throw new Error("AUTH_MODE must be explicitly set to oidc in app manifests");
  }

  const baseSecretKeys = new Set(["POSTGRES_APP_URL", "APP_SESSION_SECRET"]);
  const issuerUrl = requireAuthConfig(input.env.OIDC_ISSUER_URL, "OIDC_ISSUER_URL");
  const backchannelBaseUrl = optionalAuthConfig(input.env.OIDC_BACKCHANNEL_BASE_URL);
  const clientId = requireAuthConfig(input.env.OIDC_CLIENT_ID, "OIDC_CLIENT_ID");
  requireAuthConfig(input.secrets.OIDC_CLIENT_SECRET, "OIDC_CLIENT_SECRET");
  baseSecretKeys.add("OIDC_CLIENT_SECRET");
  return {
    configMapData: {
      AUTH_MODE: "oidc",
      OIDC_ISSUER_URL: issuerUrl,
      ...(backchannelBaseUrl ? { OIDC_BACKCHANNEL_BASE_URL: backchannelBaseUrl } : {}),
      OIDC_CLIENT_ID: clientId
    },
    secretKeys: baseSecretKeys
  };
}

function isAppRuntimeSecretKey(key: string): boolean {
  return key === "APP_CREDENTIAL_ENCRYPTION_KEY"
    || key === "APP_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS";
}

function requireAuthConfig(value: string | undefined, key: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${key} is required when AUTH_MODE=oidc`);
  }
  return trimmed;
}

function optionalAuthConfig(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
