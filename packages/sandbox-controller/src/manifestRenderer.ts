import type { KubernetesResource, SandboxRenderResult } from "../../contracts/src/api.js";

export interface SandboxRenderInput {
  namespace: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  runId: string;
  image: string;
  pvcName: string;
  projectSubPath: string;
  botifiedPort: number;
  serviceKeySecretName: string;
  cpuRequest: string;
  memoryRequest: string;
  cpuLimit: string;
  memoryLimit: string;
}

export function renderSandboxResources(input: SandboxRenderInput): SandboxRenderResult {
  const labels = sandboxLabels(input);
  const serviceAccountName = `asl-task-${input.taskId}`;
  const configName = `asl-task-${input.taskId}-config`;
  const serviceName = `asl-task-${input.taskId}`;

  const resources: KubernetesResource[] = [
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: {
        name: serviceAccountName,
        namespace: input.namespace,
        labels
      },
      automountServiceAccountToken: false
    },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: input.serviceKeySecretName,
        namespace: input.namespace,
        labels
      },
      type: "Opaque",
      stringData: {
        BOTIFIED_SERVICE_KEY: "<redacted-generated-per-task>"
      }
    },
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: configName,
        namespace: input.namespace,
        labels
      },
      data: {
        "botified-config.yaml": "<generated-by-api>"
      }
    },
    {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: `asl-task-${input.taskId}`,
        namespace: input.namespace,
        labels
      },
      spec: {
        serviceAccountName,
        automountServiceAccountToken: false,
        restartPolicy: "Never",
        hostNetwork: false,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 10001,
          runAsGroup: 10001,
          fsGroup: 10001,
          seccompProfile: {
            type: "RuntimeDefault"
          }
        },
        containers: [
          {
            name: "botified-runner",
            image: input.image,
            imagePullPolicy: "IfNotPresent",
            command: ["botified", "serve", "--config", "/etc/botified/botified-config.yaml"],
            ports: [{ name: "http", containerPort: input.botifiedPort }],
            env: [
              {
                name: "BOTIFIED_SERVICE_KEY",
                valueFrom: {
                  secretKeyRef: {
                    name: input.serviceKeySecretName,
                    key: "BOTIFIED_SERVICE_KEY"
                  }
                }
              }
            ],
            resources: {
              requests: {
                cpu: input.cpuRequest,
                memory: input.memoryRequest
              },
              limits: {
                cpu: input.cpuLimit,
                memory: input.memoryLimit
              }
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: false,
              capabilities: {
                drop: ["ALL"]
              }
            },
            volumeMounts: [
              {
                name: "project-files",
                mountPath: "/workspace/project",
                subPath: input.projectSubPath
              },
              {
                name: "botified-config",
                mountPath: "/etc/botified",
                readOnly: true
              }
            ]
          }
        ],
        volumes: [
          {
            name: "project-files",
            persistentVolumeClaim: {
              claimName: input.pvcName
            }
          },
          {
            name: "botified-config",
            configMap: {
              name: configName
            }
          }
        ]
      }
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: serviceName,
        namespace: input.namespace,
        labels
      },
      spec: {
        type: "ClusterIP",
        selector: labels,
        ports: [
          {
            name: "http",
            port: input.botifiedPort,
            targetPort: "http"
          }
        ]
      }
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: {
        name: "agentsmith-lite-api-sandbox",
        namespace: input.namespace,
        labels: appLabels()
      },
      rules: [
        {
          apiGroups: [""],
          resources: ["pods", "services", "secrets", "configmaps"],
          verbs: ["create", "get", "list", "watch", "delete", "patch"]
        }
      ]
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: `asl-task-${input.taskId}`,
        namespace: input.namespace,
        labels
      },
      spec: {
        podSelector: {
          matchLabels: labels
        },
        policyTypes: ["Ingress", "Egress"],
        ingress: [
          {
            from: [
              {
                podSelector: {
                  matchLabels: {
                    "app.kubernetes.io/component": "api",
                    "agentsmith-lite/managed-by": "agentsmith-lite"
                  }
                }
              }
            ],
            ports: [
              {
                protocol: "TCP",
                port: input.botifiedPort
              }
            ]
          }
        ],
        egress: [
          {
            to: [
              {
                namespaceSelector: {}
              }
            ],
            ports: [
              {
                protocol: "UDP",
                port: 53
              },
              {
                protocol: "TCP",
                port: 443
              }
            ]
          }
        ]
      }
    }
  ];

  return {
    dryRun: true,
    namespace: input.namespace,
    resources
  };
}

function sandboxLabels(input: Pick<SandboxRenderInput, "workspaceId" | "projectId" | "taskId" | "runId">): Record<string, string> {
  return {
    ...appLabels(),
    "app.kubernetes.io/component": "sandbox",
    "agentsmith-lite/workspace-id": input.workspaceId,
    "agentsmith-lite/project-id": input.projectId,
    "agentsmith-lite/task-id": input.taskId,
    "agentsmith-lite/run-id": input.runId
  };
}

function appLabels(): Record<string, string> {
  return {
    "app.kubernetes.io/name": "agentsmith-lite",
    "app.kubernetes.io/part-of": "agentsmith-lite",
    "app.kubernetes.io/managed-by": "agentsmith-lite",
    "agentsmith-lite/managed-by": "agentsmith-lite"
  };
}

