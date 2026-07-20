import type { KubernetesResource, SandboxRenderResult } from "../../contracts/src/api.js";
import { APP_KUBERNETES_CONTAINER_PORT } from "./appManifestRenderer.js";
import { sandboxResourceLabels } from "./labels.js";
import { kubernetesDnsLabelName, sandboxResourceNamesForTask } from "./resourceNames.js";

export interface SandboxResourceNameOverrides {
  pod?: string;
  service?: string;
  configMap?: string;
  serviceAccount?: string;
  networkPolicy?: string;
}

export interface SandboxModelCaReference {
  configMapName: string;
  configMapKey: string;
  path: string;
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
  fileLibraryRootSubPath: string;
  botifiedPort: number;
  serviceKeySecretName: string;
  serviceKeySecretKey?: string;
  cpuRequest: string;
  memoryRequest: string;
  cpuLimit: string;
  memoryLimit: string;
  modelCa?: SandboxModelCaReference;
  resourceNames?: SandboxResourceNameOverrides;
}

export function renderSandboxResources(input: SandboxRenderInput): SandboxRenderResult {
  const labels = sandboxResourceLabels(input);
  const generatedNames = sandboxResourceNamesForTask(input.taskId);
  const serviceAccountName = kubernetesDnsLabelName(input.resourceNames?.serviceAccount ?? generatedNames.serviceAccount);
  const networkPolicyName = kubernetesDnsLabelName(input.resourceNames?.networkPolicy ?? generatedNames.networkPolicy);
  const configName = kubernetesDnsLabelName(input.resourceNames?.configMap ?? generatedNames.configMap);
  const podName = kubernetesDnsLabelName(input.resourceNames?.pod ?? generatedNames.pod);
  const serviceName = kubernetesDnsLabelName(input.resourceNames?.service ?? generatedNames.service);
  const serviceKeySecretName = kubernetesDnsLabelName(input.serviceKeySecretName);
  const serviceKeySecretKey = input.serviceKeySecretKey ?? "BOTIFIED_SERVICE_KEY";
  const taskSubPath = `${input.projectSubPath}/tasks/${input.taskId}`;
  const librarySubPath=`${input.projectSubPath}/${input.fileLibraryRootSubPath}`;
  const modelCaVolume = input.modelCa
    ? {
        name: "model-ca",
        configMap: {
          name: input.modelCa.configMapName,
          items: [
            {
              key: input.modelCa.configMapKey,
              path: modelCaFilename(input.modelCa.path)
            }
          ]
        }
      }
    : undefined;
  const modelCaMount = input.modelCa
    ? {
        name: "model-ca",
        mountPath: input.modelCa.path,
        subPath: modelCaFilename(input.modelCa.path),
        readOnly: true
      }
    : undefined;

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
        name: serviceKeySecretName,
        namespace: input.namespace,
        labels
      },
      type: "Opaque",
      stringData: {
        [serviceKeySecretKey]: "<redacted-generated-per-task>",
        "AGENTS.md": "<generated-by-api>"
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
        shareProcessNamespace: false,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 10001,
          runAsGroup: 10001,
          fsGroup: 10001,
          seccompProfile: {
            type: "RuntimeDefault"
          }
        },
        initContainers: [
          {
            name: "prepare-file-library",
            image: input.image,
            imagePullPolicy: "IfNotPresent",
            command: [
              "sh",
              "-c",
              "chgrp -R 10001 /workspace/file-library && chmod -R g+rwX /workspace/file-library"
            ],
            securityContext: {
              runAsNonRoot: false,
              runAsUser: 0,
              runAsGroup: 0,
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: {
                drop: ["ALL"],
                add: ["CHOWN", "DAC_OVERRIDE", "FOWNER"]
              }
            },
            volumeMounts: [
              {
                name: "project-files",
                mountPath: "/workspace/file-library",
                subPath: librarySubPath
              }
            ]
          }
        ],
        containers: [
          {
            name: "botified-server",
            image: input.image,
            imagePullPolicy: "IfNotPresent",
            workingDir: "/workspace/task/home/workspace",
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
                name: "HOME",
                value: "/workspace/task/home"
              },
              {
                name: "BOTIFIED_SERVICE_KEY",
                valueFrom: {
                  secretKeyRef: {
                    name: serviceKeySecretName,
                    key: serviceKeySecretKey
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
                mountPath: "/workspace/task/home",
                subPath: librarySubPath
              },
              {
                name: "project-files",
                mountPath: "/workspace/task/botified",
                subPath: `${taskSubPath}/botified`
              },
              {
                name: "botified-config",
                mountPath: "/etc/botified",
                readOnly: true
              },
              {
                name: "botified-instructions",
                mountPath: "/workspace/task/home/workspace/AGENTS.md",
                subPath: "AGENTS.md",
                readOnly: true
              },
              ...(modelCaMount ? [modelCaMount] : [])
            ]
          },
          {
            name: "bash-executor",
            image: input.image,
            imagePullPolicy: "IfNotPresent",
            workingDir: "/workspace/task/home/workspace",
            command: ["bash-executor", "--listen", "127.0.0.1:3110"],
            readinessProbe: {
              exec: {
                command: ["bash", "-c", "</dev/tcp/127.0.0.1/3110"]
              }
            },
            env: [
              {
                name: "HOME",
                value: "/workspace/task/home"
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
              runAsUser: 10002,
              runAsGroup: 10001,
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: false,
              capabilities: {
                drop: ["ALL"]
              }
            },
            volumeMounts: [
              {
                name: "project-files",
                mountPath: "/workspace/task/home",
                subPath: librarySubPath
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
          },
          {
            name: "botified-instructions",
            secret: {
              secretName: serviceKeySecretName,
              items: [{ key: "AGENTS.md", path: "AGENTS.md" }]
            }
          },
          ...(modelCaVolume ? [modelCaVolume] : [])
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
        egress: renderEgressRules()
      }
    }
  ];

  return {
    namespace: input.namespace,
    resources
  };
}

function modelCaFilename(caPath: string): string {
  const parts = caPath.split("/");
  return parts[parts.length - 1] || "ca.crt";
}

interface NetworkPolicyEgressRule {
  to?: Array<{
    namespaceSelector?: Record<string, unknown>;
    podSelector?: Record<string, unknown>;
  }>;
  ports: Array<{ protocol: "TCP" | "UDP"; port: number }>;
}

function renderEgressRules(): NetworkPolicyEgressRule[] {
  return [dnsEgressRule(), brokerEgressRule()];
}

function dnsEgressRule(): NetworkPolicyEgressRule {
  return {
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
  };
}

function brokerEgressRule(): NetworkPolicyEgressRule {
  return {
    to: [{ podSelector: { matchLabels: {
      "app.kubernetes.io/component": "api",
      "agentsmith-lite/managed-by": "agentsmith-lite"
    } } }],
    ports: [
      {
        protocol: "TCP",
        port: APP_KUBERNETES_CONTAINER_PORT
      }
    ]
  };
}
