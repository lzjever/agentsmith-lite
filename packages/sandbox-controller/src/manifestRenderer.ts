import type { KubernetesResource, SandboxRenderResult } from "../../contracts/src/api.js";
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
  botifiedPort: number;
  serviceKeySecretName: string;
  serviceKeySecretKey?: string;
  modelApiKeySecretKey?: string;
  cpuRequest: string;
  memoryRequest: string;
  cpuLimit: string;
  memoryLimit: string;
  modelCa?: SandboxModelCaReference;
  modelEndpointBaseUrl?: string;
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
  const modelApiKeySecretKey = input.modelApiKeySecretKey ?? "MODEL_API_KEY";
  const taskSubPath = `${input.projectSubPath}/tasks/${input.taskId}`;
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
        containers: [
          {
            name: "botified-server",
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
                    name: serviceKeySecretName,
                    key: serviceKeySecretKey
                  }
                }
              },
              {
                name: "MODEL_API_KEY",
                valueFrom: {
                  secretKeyRef: {
                    name: serviceKeySecretName,
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
                subPath: input.projectSubPath,
                readOnly: true
              },
              {
                name: "project-files",
                mountPath: "/workspace/task/home",
                subPath: `${taskSubPath}/home`
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
              ...(modelCaMount ? [modelCaMount] : [])
            ]
          },
          {
            name: "bash-executor",
            image: input.image,
            imagePullPolicy: "IfNotPresent",
            command: ["bash-executor", "--listen", "127.0.0.1:3110"],
            env: [],
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
                mountPath: "/workspace/project",
                subPath: input.projectSubPath,
                readOnly: true
              },
              {
                name: "project-files",
                mountPath: "/workspace/task/home",
                subPath: `${taskSubPath}/home`
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
        egress: renderEgressRules(input.modelEndpointBaseUrl)
      }
    }
  ];

  return {
    dryRun: true,
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

interface ClusterServiceEndpoint {
  serviceName: string;
  namespace: string;
}

function renderEgressRules(modelEndpointBaseUrl: string | undefined): NetworkPolicyEgressRule[] {
  return [dnsEgressRule(), modelEndpointEgressRule(modelEndpointBaseUrl)];
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

function modelEndpointEgressRule(modelEndpointBaseUrl: string | undefined): NetworkPolicyEgressRule {
  const endpoint = parseModelEndpoint(modelEndpointBaseUrl);
  const clusterService = endpoint ? parseClusterServiceEndpoint(endpoint.hostname) : null;
  if (endpoint && clusterService) {
    return {
      to: [
        {
          namespaceSelector: {
            matchLabels: {
              "kubernetes.io/metadata.name": clusterService.namespace
            }
          },
          podSelector: {
            matchLabels: {
              "app.kubernetes.io/name": clusterService.serviceName
            }
          }
        }
      ],
      ports: clusterServiceModelPorts(endpoint.port)
    };
  }
  return {
    ports: [
      {
        protocol: "TCP",
        port: endpoint?.port ?? 443
      }
    ]
  };
}

function parseModelEndpoint(modelEndpointBaseUrl: string | undefined): { hostname: string; port: number } | null {
  if (!modelEndpointBaseUrl) {
    return null;
  }
  try {
    const parsed = new URL(modelEndpointBaseUrl);
    const port = parsed.port ? Number(parsed.port) : 443;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return null;
    }
    return {
      hostname: parsed.hostname.replace(/\.$/, "").toLowerCase(),
      port
    };
  } catch {
    return null;
  }
}

function parseClusterServiceEndpoint(hostname: string): ClusterServiceEndpoint | null {
  const parts = hostname.split(".");
  const serviceName = parts[0];
  const namespace = parts[1];
  const isClusterLocalService =
    parts.length >= 5 && parts[2] === "svc" && parts[3] === "cluster" && parts[4] === "local";
  const isShortService = parts.length === 3 && parts[2] === "svc";
  if (!isClusterLocalService && !isShortService) {
    return null;
  }
  if (!isDnsLabel(serviceName) || !isDnsLabel(namespace)) {
    return null;
  }
  return { serviceName, namespace };
}

function clusterServiceModelPorts(servicePort: number): Array<{ protocol: "TCP"; port: number }> {
  // Local HTTPS services may be evaluated by NetworkPolicy after Service DNAT to the pod targetPort.
  const ports = servicePort === 443 ? [443, 8443] : [servicePort];
  return ports.map((port) => ({ protocol: "TCP", port }));
}

function isDnsLabel(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value) && value.length <= 63;
}
