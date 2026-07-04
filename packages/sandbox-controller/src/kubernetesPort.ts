import { readFileSync } from "node:fs";
import https from "node:https";
import type { KubernetesResource } from "../../contracts/src/api.js";
import type { SandboxCoreResourceKind, SandboxReconcileAction } from "./reconciler.js";
import { SANDBOX_CLEANUP_STATUS_LABEL, SANDBOX_LABEL_KEYS, SANDBOX_MANAGED_BY } from "./labels.js";

export interface KubernetesResourceRef {
  kind: SandboxCoreResourceKind;
  namespace: string;
  name: string;
}

export interface KubernetesTransportRequest {
  method: "GET" | "PATCH" | "DELETE";
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export interface KubernetesTransportResponse {
  statusCode: number;
  body?: unknown;
}

export interface KubernetesTransport {
  request(request: KubernetesTransportRequest): Promise<KubernetesTransportResponse>;
}

export interface SandboxKubernetesMutationPort {
  applyResource(resource: KubernetesResource, expectedLabels: Record<string, string>): Promise<"applied" | "fence_mismatch">;
  patchLabels(
    ref: KubernetesResourceRef,
    expectedLabels: Record<string, string>,
    labels: Record<string, string>
  ): Promise<"patched" | "not_found" | "fence_mismatch">;
  deleteResource(ref: KubernetesResourceRef, expectedLabels: Record<string, string>): Promise<"deleted" | "not_found" | "fence_mismatch">;
}

export type PodReadiness = "ready" | "pending" | "failed" | "not_found" | "fence_mismatch";

export interface SandboxKubernetesReadinessPort {
  getPodReadiness(namespace: string, name: string, expectedLabels: Record<string, string>): Promise<PodReadiness>;
}

const FIELD_MANAGER = "agentsmith-lite-sandbox";
const MANAGED_LABEL_SELECTOR = `${SANDBOX_LABEL_KEYS.managedBy}=${SANDBOX_MANAGED_BY}`;

const RESOURCE_MAPPINGS: Record<SandboxCoreResourceKind, { apiPrefix: string; plural: string }> = {
  Secret: { apiPrefix: "/api/v1", plural: "secrets" },
  ConfigMap: { apiPrefix: "/api/v1", plural: "configmaps" },
  ServiceAccount: { apiPrefix: "/api/v1", plural: "serviceaccounts" },
  NetworkPolicy: { apiPrefix: "/apis/networking.k8s.io/v1", plural: "networkpolicies" },
  Service: { apiPrefix: "/api/v1", plural: "services" },
  Pod: { apiPrefix: "/api/v1", plural: "pods" }
};

const LIST_ORDER: readonly SandboxCoreResourceKind[] = [
  "Secret",
  "ConfigMap",
  "ServiceAccount",
  "NetworkPolicy",
  "Service",
  "Pod"
];

export class SandboxKubernetesPort implements SandboxKubernetesMutationPort, SandboxKubernetesReadinessPort {
  private readonly transport: KubernetesTransport;

  constructor(options: { transport?: KubernetesTransport } = {}) {
    this.transport = options.transport ?? new InClusterHttpsKubernetesTransport();
  }

  async listManagedResources(namespace: string): Promise<KubernetesResource[]> {
    const resources: KubernetesResource[] = [];
    for (const kind of LIST_ORDER) {
      const response = await this.transport.request({
        method: "GET",
        path: `${listPath(kind, namespace)}?labelSelector=${encodeURIComponent(MANAGED_LABEL_SELECTOR)}`,
        headers: {}
      });
      if (!isSuccess(response.statusCode)) {
        throw new Error(`Kubernetes list ${kind} failed with HTTP ${response.statusCode}`);
      }
      const items = asResourceList(response.body).items;
      resources.push(...items);
    }
    return resources;
  }

  async applyResource(resource: KubernetesResource, expectedLabels: Record<string, string>): Promise<"applied" | "fence_mismatch"> {
    if (!hasLabels(resource, expectedLabels)) {
      return "fence_mismatch";
    }
    const ref = resourceRef(resource);
    const existing = await this.transport.request({
      method: "GET",
      path: resourcePath(ref),
      headers: {}
    });
    if (isSuccess(existing.statusCode) && !hasLabels(asResource(existing.body), expectedLabels)) {
      return "fence_mismatch";
    }
    if (existing.statusCode !== 404 && !isSuccess(existing.statusCode)) {
      throw new Error(`Kubernetes get before apply ${ref.kind}/${ref.name} failed with HTTP ${existing.statusCode}`);
    }

    const response = await this.transport.request({
      method: "PATCH",
      path: `${resourcePath(ref)}?fieldManager=${encodeURIComponent(FIELD_MANAGER)}&force=false`,
      headers: {
        "content-type": "application/apply-patch+yaml"
      },
      body: JSON.stringify(prepareApplyResource(resource))
    });
    if (!isSuccess(response.statusCode)) {
      throw new Error(`Kubernetes apply ${ref.kind}/${ref.name} failed with HTTP ${response.statusCode}`);
    }
    return "applied";
  }

  async patchLabels(
    ref: KubernetesResourceRef,
    expectedLabels: Record<string, string>,
    labels: Record<string, string>
  ): Promise<"patched" | "not_found" | "fence_mismatch"> {
    const response = await this.transport.request({
      method: "PATCH",
      path: resourcePath(ref),
      headers: {
        "content-type": "application/json-patch+json"
      },
      body: JSON.stringify([
        ...Object.entries(expectedLabels).map(([key, value]) => ({
          op: "test",
          path: `/metadata/labels/${jsonPointerEscape(key)}`,
          value
        })),
        ...Object.entries(labels).map(([key, value]) => ({
          op: "add",
          path: `/metadata/labels/${jsonPointerEscape(key)}`,
          value
        }))
      ])
    });
    if (response.statusCode === 404) {
      return "not_found";
    }
    if (response.statusCode === 409 || response.statusCode === 422) {
      return "fence_mismatch";
    }
    if (!isSuccess(response.statusCode)) {
      throw new Error(`Kubernetes patch labels ${ref.kind}/${ref.name} failed with HTTP ${response.statusCode}`);
    }
    return "patched";
  }

  async deleteResource(ref: KubernetesResourceRef, expectedLabels: Record<string, string>): Promise<"deleted" | "not_found" | "fence_mismatch"> {
    const existing = await this.transport.request({
      method: "GET",
      path: resourcePath(ref),
      headers: {}
    });
    if (existing.statusCode === 404) {
      return "not_found";
    }
    if (!isSuccess(existing.statusCode)) {
      throw new Error(`Kubernetes get before delete ${ref.kind}/${ref.name} failed with HTTP ${existing.statusCode}`);
    }
    const resource = asResource(existing.body);
    if (!hasLabels(resource, expectedLabels)) {
      return "fence_mismatch";
    }

    const uid = typeof resource.metadata.uid === "string" ? resource.metadata.uid : null;
    const response = await this.transport.request({
      method: "DELETE",
      path: resourcePath(ref),
      headers: uid ? { "content-type": "application/json" } : {},
      ...(uid
        ? {
            body: JSON.stringify({
              apiVersion: "v1",
              kind: "DeleteOptions",
              preconditions: { uid }
            })
          }
        : {})
    });
    if (response.statusCode === 404) {
      return "not_found";
    }
    if (response.statusCode === 409 || response.statusCode === 422) {
      return "fence_mismatch";
    }
    if (!isSuccess(response.statusCode)) {
      throw new Error(`Kubernetes delete ${ref.kind}/${ref.name} failed with HTTP ${response.statusCode}`);
    }
    return "deleted";
  }

  async getPodReadiness(namespace: string, name: string, expectedLabels: Record<string, string>): Promise<PodReadiness> {
    const response = await this.transport.request({
      method: "GET",
      path: resourcePath({ kind: "Pod", namespace, name }),
      headers: {}
    });
    if (response.statusCode === 404) {
      return "not_found";
    }
    if (!isSuccess(response.statusCode)) {
      throw new Error(`Kubernetes get pod readiness ${name} failed with HTTP ${response.statusCode}`);
    }
    const pod = asResource(response.body);
    if (!hasLabels(pod, expectedLabels)) {
      return "fence_mismatch";
    }

    const status = asRecord(pod.status);
    if (status.phase === "Failed") {
      return "failed";
    }
    const conditions = Array.isArray(status.conditions) ? status.conditions : [];
    const ready = conditions.some((condition) => {
      const record = asRecord(condition);
      return record.type === "Ready" && record.status === "True";
    });
    return ready ? "ready" : "pending";
  }
}

export async function applySandboxReconcileActionsToKubernetes(
  port: SandboxKubernetesMutationPort,
  actions: SandboxReconcileAction[]
): Promise<void> {
  for (const action of actions) {
    switch (action.type) {
      case "create_resource": {
        const result = await port.applyResource(action.resource, action.labels);
        if (result === "fence_mismatch") {
          throw new Error(`Kubernetes apply fence mismatch for ${action.type} ${action.kind}/${action.name}`);
        }
        break;
      }
      case "delete_resource": {
        const result = await port.deleteResource(resourceRef(action.resource), action.labels);
        if (result === "fence_mismatch") {
          throw new Error(`Kubernetes delete fence mismatch for ${action.type} ${action.kind}/${action.name}`);
        }
        break;
      }
      case "mark_cleanup": {
        const result = await port.patchLabels(resourceRef(action.resource), action.labels, {
          [SANDBOX_CLEANUP_STATUS_LABEL]: "pending"
        });
        if (result === "fence_mismatch") {
          throw new Error(`Kubernetes patch labels fence mismatch for ${action.type} ${action.kind}/${action.name}`);
        }
        break;
      }
      case "adopt_resource":
      case "store_run_state":
        break;
    }
  }
}

class InClusterHttpsKubernetesTransport implements KubernetesTransport {
  private readonly host: string;
  private readonly port: string;
  private readonly token: string;
  private readonly ca: Buffer;

  constructor() {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
    if (!host) {
      throw new Error("KUBERNETES_SERVICE_HOST is required for in-cluster Kubernetes transport");
    }
    this.host = host;
    this.port = port;
    this.token = readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8").trim();
    this.ca = readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt");
  }

  async request(request: KubernetesTransportRequest): Promise<KubernetesTransportResponse> {
    return new Promise<KubernetesTransportResponse>((resolve, reject) => {
      const clientRequest = https.request(
        {
          host: this.host,
          port: this.port,
          method: request.method,
          path: request.path,
          ca: this.ca,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: "application/json",
            ...request.headers
          }
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              statusCode: response.statusCode ?? 0,
              ...(text.length > 0 ? { body: parseResponseBody(text) } : {})
            });
          });
        }
      );
      clientRequest.on("error", reject);
      if (request.body) {
        clientRequest.write(request.body);
      }
      clientRequest.end();
    });
  }
}

function listPath(kind: SandboxCoreResourceKind, namespace: string): string {
  const mapping = RESOURCE_MAPPINGS[kind];
  return `${mapping.apiPrefix}/namespaces/${encodeURIComponent(namespace)}/${mapping.plural}`;
}

function resourcePath(ref: KubernetesResourceRef): string {
  const mapping = RESOURCE_MAPPINGS[ref.kind];
  return `${mapping.apiPrefix}/namespaces/${encodeURIComponent(ref.namespace)}/${mapping.plural}/${encodeURIComponent(ref.name)}`;
}

function resourceRef(resource: KubernetesResource): KubernetesResourceRef {
  if (!isCoreKind(resource.kind)) {
    throw new Error(`Unsupported sandbox Kubernetes resource kind: ${resource.kind}`);
  }
  if (!resource.metadata.namespace) {
    throw new Error(`Sandbox Kubernetes resource ${resource.kind}/${resource.metadata.name} must be namespaced`);
  }
  return {
    kind: resource.kind,
    namespace: resource.metadata.namespace,
    name: resource.metadata.name
  };
}

function isCoreKind(kind: string): kind is SandboxCoreResourceKind {
  return Object.hasOwn(RESOURCE_MAPPINGS, kind);
}

function prepareApplyResource(resource: KubernetesResource): KubernetesResource {
  const body = structuredClone(resource);
  if (body.kind === "Secret" && isStringRecord(body.stringData)) {
    const data = isStringRecord(body.data) ? { ...body.data } : {};
    for (const [key, value] of Object.entries(body.stringData)) {
      data[key] = Buffer.from(value, "utf8").toString("base64");
    }
    body.data = data;
    delete body.stringData;
  }
  return body;
}

function hasLabels(resource: KubernetesResource, labels: Record<string, string>): boolean {
  return Object.entries(labels).every(([key, value]) => resource.metadata.labels[key] === value);
}

function asResourceList(body: unknown): { items: KubernetesResource[] } {
  const record = asRecord(body);
  if (!Array.isArray(record.items)) {
    return { items: [] };
  }
  return { items: record.items.map(asResource) };
}

function asResource(body: unknown): KubernetesResource {
  const record = asRecord(body);
  const metadata = asRecord(record.metadata);
  const namespace = typeof metadata.namespace === "string" ? { namespace: metadata.namespace } : {};
  return {
    ...record,
    apiVersion: String(record.apiVersion ?? "v1"),
    kind: String(record.kind),
    metadata: {
      ...metadata,
      name: String(metadata.name),
      ...namespace,
      labels: isStringRecord(metadata.labels) ? metadata.labels : {}
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isSuccess(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

function jsonPointerEscape(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function parseResponseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
