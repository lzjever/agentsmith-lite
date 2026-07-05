import type { KubernetesResource, SandboxRenderResult } from "../../contracts/src/api.js";
import { sandboxResourceLabels } from "./labels.js";

export interface SandboxResourceNameOverrides {
  pod?: string;
  service?: string;
  configMap?: string;
  serviceAccount?: string;
  networkPolicy?: string;
}

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
  serviceKeySecretKey?: string;
  modelApiKeySecretKey?: string;
  cpuRequest: string;
  memoryRequest: string;
  cpuLimit: string;
  memoryLimit: string;
  resourceNames?: SandboxResourceNameOverrides;
}

export function renderSandboxResources(input: SandboxRenderInput): SandboxRenderResult {
  const labels = sandboxResourceLabels(input);
  const serviceAccountName = input.resourceNames?.serviceAccount ?? `asl-task-${input.taskId}`;
  const networkPolicyName = input.resourceNames?.networkPolicy ?? `asl-task-${input.taskId}`;
  const configName = input.resourceNames?.configMap ?? `asl-task-${input.taskId}-config`;
  const podName = input.resourceNames?.pod ?? `asl-task-${input.taskId}`;
  const serviceName = input.resourceNames?.service ?? `asl-task-${input.taskId}`;
  const serviceKeySecretKey = input.serviceKeySecretKey ?? "BOTIFIED_SERVICE_KEY";
  const modelApiKeySecretKey = input.modelApiKeySecretKey ?? "MODEL_API_KEY";

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
        [serviceKeySecretKey]: "<redacted-generated-per-task>",
        [modelApiKeySecretKey]: "<redacted-model-api-key>"
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
        name: podName,
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
            readinessProbe: {
              httpGet: {
                path: "/healthz",
                port: "http"
              }
            },
            env: [
              {
                name: "BOTIFIED_SERVICE_KEY",
                valueFrom: {
                  secretKeyRef: {
                    name: input.serviceKeySecretName,
                    key: serviceKeySecretKey
                  }
                }
              },
              {
                name: "MODEL_API_KEY",
                valueFrom: {
                  secretKeyRef: {
                    name: input.serviceKeySecretName,
                    key: modelApiKeySecretKey
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
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: networkPolicyName,
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
              }
            ]
          },
          {
            ports: [
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
