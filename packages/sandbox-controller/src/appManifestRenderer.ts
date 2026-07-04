import type { KubernetesResource } from "../../contracts/src/api.js";

export interface AppManifestInput {
  namespace: string;
  imageTag: string;
  env: Record<string, string>;
  secrets: Record<string, string>;
}

export function renderAppManifests(input: AppManifestInput): KubernetesResource[] {
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

  return [
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "agentsmith-lite-config", namespace: input.namespace, labels },
      data: {
        APP_PUBLIC_BASE_URL: input.env.APP_PUBLIC_BASE_URL ?? "http://localhost:3000",
        JUICEFS_PVC_NAME: input.env.JUICEFS_PVC_NAME ?? "agentsmith-lite-files",
        KUBE_NAMESPACE: input.namespace,
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
                image: `agentsmith-lite/app:${input.imageTag}`,
                ports: [{ containerPort: 3000 }],
                envFrom: [
                  { configMapRef: { name: "agentsmith-lite-config" } },
                  { secretRef: { name: "agentsmith-lite-app-secrets" } }
                ],
                volumeMounts: [
                  {
                    name: "project-files",
                    mountPath: "/agentsmith-lite"
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
    {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: "agentsmith-lite-schema-bootstrap", namespace: input.namespace, labels },
      spec: {
        template: {
          metadata: { labels },
          spec: {
            restartPolicy: "OnFailure",
            containers: [
              {
                name: "schema-bootstrap",
                image: `agentsmith-lite/app:${input.imageTag}`,
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
          resources: ["pods", "services", "secrets", "configmaps"],
          verbs: ["create", "get", "list", "watch", "delete", "patch"]
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
