import type { KubernetesResource } from "../../contracts/src/api.js";
import { DEFAULT_SANDBOX_NAMESPACE_LIMIT } from "../../domain/src/sandboxDefaults.js";
import type { AppImageRefs } from "./appImageLock.js";

const MODEL_CA_BUNDLE_PATH = "/etc/agentsmith-lite/model-ca/ca.crt";
const DEFAULT_MODEL_CA_CONFIG_KEY = "ca.crt";

export interface AppManifestInput {
  namespace: string;
  imageTag: string;
  env: Record<string, string>;
  secrets: Record<string, string>;
  imageRefs?: AppImageRefs;
}

export function renderAppManifests(input: AppManifestInput): KubernetesResource[] {
  const auth = resolveAuthConfig(input);
  const publicBaseUrl = input.env.APP_PUBLIC_BASE_URL?.trim() || "http://localhost:3000";
  const parsedPublicBaseUrl = parsePublicBaseUrl(publicBaseUrl);
  const publicBasePath = normalizedPublicBasePath(parsedPublicBaseUrl.pathname);
  const apiHealthPath = publicPathFor(publicBasePath, "/api/health");
  const appDataRoot = resolveAppDataRoot(input.env);
  const runtimeTickMs = input.env.AGENTSMITH_LITE_RUNTIME_TICK_MS?.trim();
  const modelCa = resolveModelCa(input);
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
  const appSecretKeys = Object.keys(input.secrets).filter((key) => auth.secretKeys.has(key) || key.startsWith("AGENTSMITH_LITE_MODEL_API_KEY_"));
  for (const key of appSecretKeys) {
    const value = input.secrets[key];
    if (value) {
      appSecretData[key] = value;
    }
  }
  const appImage = input.imageRefs?.app ?? `agentsmith-lite/app:${input.imageTag}`;
  const runnerImage = input.imageRefs?.botifiedRunner ?? input.env.BOTIFIED_RUNNER_IMAGE ?? `agentsmith-lite/botified-runner:${input.imageTag}`;
  const ingress = renderAppIngress(input, parsedPublicBaseUrl, publicBasePath, apiLabels);

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
        ...(runtimeTickMs ? { AGENTSMITH_LITE_RUNTIME_TICK_MS: runtimeTickMs } : {}),
        BOTIFIED_RUNNER_IMAGE: runnerImage,
        ...auth.configMapData,
        ...modelBaseUrlConfig,
        ...(modelCa
          ? {
              AGENTSMITH_LITE_MODEL_CA_CONFIG_MAP: modelCa.configMapName,
              AGENTSMITH_LITE_MODEL_CA_CONFIG_KEY: modelCa.configMapKey
            }
          : {})
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
                readinessProbe: apiHealthProbe(apiHealthPath),
                livenessProbe: apiHealthProbe(apiHealthPath),
                startupProbe: apiHealthProbe(apiHealthPath),
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
                    mountPath: appDataRoot
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
              path: publicBasePath,
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
    "OIDC_CLIENT_ID",
    "OIDC_ADMIN_EMAILS",
    "OIDC_ADMIN_SUBJECTS"
  ];
  for (const key of ["AUTH_MODE", ...oidcConfigKeys]) {
    if (Object.hasOwn(input.secrets, key)) {
      throw new Error(`auth config key ${key} is not allowed in app Secret`);
    }
  }
  if (Object.hasOwn(input.env, "OIDC_CLIENT_SECRET")) {
    throw new Error("secret key OIDC_CLIENT_SECRET is not allowed in app ConfigMap");
  }

  const authMode = input.env.AUTH_MODE?.trim() || "builtin_admin";
  if (authMode !== "builtin_admin" && authMode !== "oidc") {
    throw new Error("AUTH_MODE must be builtin_admin or oidc in app manifests");
  }

  const baseSecretKeys = new Set(["POSTGRES_APP_URL", "APP_SESSION_SECRET"]);
  if (authMode === "builtin_admin") {
    for (const key of oidcConfigKeys) {
      if (input.env[key]?.trim()) {
        throw new Error(`${key} must be empty when AUTH_MODE=builtin_admin`);
      }
    }
    if (input.secrets.OIDC_CLIENT_SECRET?.trim()) {
      throw new Error("OIDC_CLIENT_SECRET must be empty when AUTH_MODE=builtin_admin");
    }
    baseSecretKeys.add("BUILTIN_ADMIN_INITIAL_PASSWORD");
    return { configMapData: {}, secretKeys: baseSecretKeys };
  }

  const issuerUrl = requireAuthConfig(input.env.OIDC_ISSUER_URL, "OIDC_ISSUER_URL");
  const backchannelBaseUrl = optionalAuthConfig(input.env.OIDC_BACKCHANNEL_BASE_URL);
  const clientId = requireAuthConfig(input.env.OIDC_CLIENT_ID, "OIDC_CLIENT_ID");
  const adminEmails = optionalAuthConfig(input.env.OIDC_ADMIN_EMAILS);
  const adminSubjects = optionalAuthConfig(input.env.OIDC_ADMIN_SUBJECTS);
  requireAuthConfig(input.secrets.OIDC_CLIENT_SECRET, "OIDC_CLIENT_SECRET");
  baseSecretKeys.add("OIDC_CLIENT_SECRET");
  return {
    configMapData: {
      AUTH_MODE: "oidc",
      OIDC_ISSUER_URL: issuerUrl,
      ...(backchannelBaseUrl ? { OIDC_BACKCHANNEL_BASE_URL: backchannelBaseUrl } : {}),
      OIDC_CLIENT_ID: clientId,
      ...(adminEmails ? { OIDC_ADMIN_EMAILS: adminEmails } : {}),
      ...(adminSubjects ? { OIDC_ADMIN_SUBJECTS: adminSubjects } : {})
    },
    secretKeys: baseSecretKeys
  };
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
