import { readFileSync } from "node:fs";
import https from "node:https";
import type { KubernetesResource } from "../../contracts/src/api.js";
import type { SandboxCoreResourceKind, SandboxReconcileAction } from "./reconciler.js";
import { SANDBOX_LABEL_KEYS, SANDBOX_MANAGED_BY } from "./labels.js";

export interface KubernetesResourceRef {
  kind: SandboxCoreResourceKind;
  namespace: string;
  name: string;
  uid?: string;
  labels?: Record<string, string>;
}

export interface KubernetesTransportRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export interface KubernetesTransportResponse {
  statusCode: number;
  body?: unknown;
}

export interface KubernetesTransport {
  request(request: KubernetesTransportRequest, signal?: AbortSignal): Promise<KubernetesTransportResponse>;
}

export interface SandboxKubernetesMutationPort {
  applyResource(resource: KubernetesResource, expectedLabels: Record<string, string>, signal?:AbortSignal): Promise<"applied" | "fence_mismatch">;
  deleteResource(ref: KubernetesResourceRef, expectedLabels: Record<string, string>): Promise<"deleted" | "not_found" | "fence_mismatch">;
}

export type SandboxResourceInspection =
  | {state:"present";resource:KubernetesResource}
  | "not_found"
  | "fence_mismatch";

export interface SandboxKubernetesInspectionPort {
  inspectResource(
    ref:KubernetesResourceRef,
    expectedLabels:Record<string,string>
  ):Promise<SandboxResourceInspection>;
}

export type PodReadiness =
  | {state:"ready"|"pending"|"failed";podUid:string;podIp?:string}
  | "not_found" | "fence_mismatch";

export type ConfigMapRead =
  | {data:Record<string,string>}
  | "not_found" | "fence_mismatch";

export interface SandboxKubernetesReadinessPort {
  getPodReadiness(namespace: string, name: string, expectedLabels: Record<string, string>, signal?:AbortSignal): Promise<PodReadiness>;
  getConfigMapData(namespace:string,name:string,expectedLabels:Record<string,string>,signal?:AbortSignal):Promise<ConfigMapRead>;
}

const FIELD_MANAGER = "agentsmith-lite-sandbox";
const MANAGED_LABEL_SELECTOR = `${SANDBOX_LABEL_KEYS.managedBy}=${SANDBOX_MANAGED_BY}`;
const KUBERNETES_REQUEST_TIMEOUT_MS = 10_000;

const RESOURCE_MAPPINGS: Record<SandboxCoreResourceKind, { apiPrefix: string; apiVersion: string; plural: string }> = {
  Secret: { apiPrefix: "/api/v1", apiVersion: "v1", plural: "secrets" },
  ConfigMap: { apiPrefix: "/api/v1", apiVersion: "v1", plural: "configmaps" },
  ServiceAccount: { apiPrefix: "/api/v1", apiVersion: "v1", plural: "serviceaccounts" },
  NetworkPolicy: { apiPrefix: "/apis/networking.k8s.io/v1", apiVersion: "networking.k8s.io/v1", plural: "networkpolicies" },
  Service: { apiPrefix: "/api/v1", apiVersion: "v1", plural: "services" },
  Pod: { apiPrefix: "/api/v1", apiVersion: "v1", plural: "pods" }
};

const LIST_ORDER: readonly SandboxCoreResourceKind[] = [
  "Secret",
  "ConfigMap",
  "ServiceAccount",
  "NetworkPolicy",
  "Service",
  "Pod"
];

export class SandboxKubernetesPort implements SandboxKubernetesMutationPort, SandboxKubernetesInspectionPort, SandboxKubernetesReadinessPort {
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
        throw kubernetesHttpError(`Kubernetes list ${kind} failed with HTTP ${response.statusCode}`, response);
      }
      const items = asResourceList(response.body, { apiVersion: RESOURCE_MAPPINGS[kind].apiVersion, kind }).items;
      resources.push(...items);
    }
    return resources;
  }

  async applyResource(resource: KubernetesResource, expectedLabels: Record<string, string>, signal?:AbortSignal): Promise<"applied" | "fence_mismatch"> {
    if (!hasLabels(resource, expectedLabels)) {
      return "fence_mismatch";
    }
    const ref = resourceRef(resource);
    const existing = await this.transport.request({
      method: "GET",
      path: resourcePath(ref),
      headers: {}
    },signal);
    if (existing.statusCode !== 404 && !isSuccess(existing.statusCode)) {
      throw kubernetesHttpError(`Kubernetes get before apply ${ref.kind}/${ref.name} failed with HTTP ${existing.statusCode}`, existing);
    }

    const body=prepareApplyResource(resource);
    const response = existing.statusCode===404
      ? await this.transport.request({
          method:"POST",
          path:`${listPath(ref.kind,ref.namespace)}?fieldManager=${encodeURIComponent(FIELD_MANAGER)}`,
          headers:{"content-type":"application/json"},
          body:JSON.stringify(body)
        },signal)
      : await this.applyExistingResource(ref,body,existing,expectedLabels,signal);
    if(response==="fence_mismatch")return response;
    if (response.statusCode === 409) {
      return "fence_mismatch";
    }
    if (!isSuccess(response.statusCode)) {
      const operation=existing.statusCode===404?"create":"apply";
      throw kubernetesHttpError(`Kubernetes ${operation} ${ref.kind}/${ref.name} failed with HTTP ${response.statusCode}`, response);
    }
    return "applied";
  }

  private async applyExistingResource(
    ref:KubernetesResourceRef,
    body:KubernetesResource,
    existing:KubernetesTransportResponse,
    expectedLabels:Record<string,string>,
    signal?:AbortSignal
  ):Promise<KubernetesTransportResponse|"fence_mismatch">{
    const observed=parseExactResource(existing.body,ref);
    if(!hasLabels(observed,expectedLabels))return"fence_mismatch";
    const resourceVersion=observed.metadata.resourceVersion;
    if(typeof resourceVersion!=="string"||resourceVersion.length===0)return"fence_mismatch";
    body.metadata.resourceVersion=resourceVersion;
    return this.transport.request({
      method:"PATCH",
      path:`${resourcePath(ref)}?fieldManager=${encodeURIComponent(FIELD_MANAGER)}&force=false`,
      headers:{"content-type":"application/apply-patch+yaml"},
      body:JSON.stringify(body)
    },signal);
  }

  async deleteResource(ref: KubernetesResourceRef, expectedLabels: Record<string, string>): Promise<"deleted" | "not_found" | "fence_mismatch"> {
    if (ref.uid && ref.labels) {
      if (!hasLabelValues(ref.labels, expectedLabels)) {
        return "fence_mismatch";
      }
      return this.deleteResourceByRef(ref, ref.uid);
    }

    const existing = await this.transport.request({
      method: "GET",
      path: resourcePath(ref),
      headers: {}
    });
    if (existing.statusCode === 404) {
      return "not_found";
    }
    if (!isSuccess(existing.statusCode)) {
      throw kubernetesHttpError(`Kubernetes get before delete ${ref.kind}/${ref.name} failed with HTTP ${existing.statusCode}`, existing);
    }
    const resource = asResource(existing.body);
    if (!hasLabels(resource, expectedLabels)) {
      return "fence_mismatch";
    }

    const uid = typeof resource.metadata.uid === "string" ? resource.metadata.uid : null;
    return this.deleteResourceByRef(ref, uid);
  }

  async inspectResource(
    ref:KubernetesResourceRef,
    expectedLabels:Record<string,string>
  ):Promise<SandboxResourceInspection>{
    const response=await this.transport.request({
      method:"GET",
      path:resourcePath(ref),
      headers:{}
    });
    if(response.statusCode===404)return"not_found";
    if(!isSuccess(response.statusCode)){
      throw kubernetesHttpError(`Kubernetes inspect ${ref.kind}/${ref.name} failed with HTTP ${response.statusCode}`,response);
    }
    const resource=parseExactResource(response.body,ref);
    const uid=resourceUid(resource);
    if(!hasLabels(resource,expectedLabels)||!uid||ref.uid!==undefined&&uid!==ref.uid)return"fence_mismatch";
    return{state:"present",resource};
  }

  private async deleteResourceByRef(ref: KubernetesResourceRef, uid: string | null): Promise<"deleted" | "not_found" | "fence_mismatch"> {
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
      throw kubernetesHttpError(`Kubernetes delete ${ref.kind}/${ref.name} failed with HTTP ${response.statusCode}`, response);
    }
    return "deleted";
  }

  async getPodReadiness(namespace: string, name: string, expectedLabels: Record<string, string>, signal?:AbortSignal): Promise<PodReadiness> {
    const response = await this.transport.request({
      method: "GET",
      path: resourcePath({ kind: "Pod", namespace, name }),
      headers: {}
    },signal);
    if (response.statusCode === 404) {
      return "not_found";
    }
    if (!isSuccess(response.statusCode)) {
      throw kubernetesHttpError(`Kubernetes get pod readiness ${name} failed with HTTP ${response.statusCode}`, response);
    }
    const pod = asResource(response.body);
    if (!hasLabels(pod, expectedLabels)) {
      return "fence_mismatch";
    }

    const uid=typeof pod.metadata.uid==="string"?pod.metadata.uid:"";
    if(!uid)return"fence_mismatch";
    const status = asRecord(pod.status);
    const conditions = Array.isArray(status.conditions) ? status.conditions : [];
    const ready = conditions.some((condition) => {
      const record = asRecord(condition);
      return record.type === "Ready" && record.status === "True";
    });
    return{
      state:status.phase==="Failed"?"failed":ready?"ready":"pending",
      podUid:uid,
      ...(typeof status.podIP==="string"&&status.podIP?{podIp:status.podIP}:{})
    };
  }

  async getConfigMapData(namespace:string,name:string,expectedLabels:Record<string,string>,signal?:AbortSignal):Promise<ConfigMapRead>{
    const response=await this.transport.request({
      method:"GET",
      path:resourcePath({kind:"ConfigMap",namespace,name}),
      headers:{}
    },signal);
    if(response.statusCode===404)return"not_found";
    if(!isSuccess(response.statusCode)){
      throw kubernetesHttpError(`Kubernetes get ConfigMap ${name} failed with HTTP ${response.statusCode}`,response);
    }
    const resource=asResource(response.body);
    if(!hasLabels(resource,expectedLabels))return"fence_mismatch";
    const data=asRecord(resource.data);
    const entries=Object.entries(data);
    if(entries.some(([,value])=>typeof value!=="string"))return"fence_mismatch";
    return{data:Object.fromEntries(entries) as Record<string,string>};
  }
}

export async function applySandboxReconcileActionsToKubernetes(
  port: SandboxKubernetesMutationPort,
  actions: SandboxReconcileAction[],
  signal?:AbortSignal
): Promise<void> {
  for (const action of actions) {
    switch (action.type) {
      case "create_resource": {
        const result = await port.applyResource(action.resource, action.labels,signal);
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

  async request(request: KubernetesTransportRequest,signal?:AbortSignal): Promise<KubernetesTransportResponse> {
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
            signal?.removeEventListener("abort",abortRequest);
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              statusCode: response.statusCode ?? 0,
              ...(text.length > 0 ? { body: parseResponseBody(text) } : {})
            });
          });
        }
      );
      const abortRequest=()=>{
        const reason=signal?.reason instanceof Error?signal.reason:new Error("Kubernetes API request aborted");
        clientRequest.destroy(reason);
      };
      clientRequest.on("error",(error)=>{
        signal?.removeEventListener("abort",abortRequest);
        reject(error);
      });
      signal?.addEventListener("abort",abortRequest,{once:true});
      clientRequest.setTimeout(KUBERNETES_REQUEST_TIMEOUT_MS, () => {
        clientRequest.destroy(new Error("Kubernetes API request timed out"));
      });
      if(signal?.aborted){
        abortRequest();
        return;
      }
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
    name: resource.metadata.name,
    labels: { ...resource.metadata.labels },
    ...(typeof resource.metadata.uid === "string" ? { uid: resource.metadata.uid } : {})
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
  return hasLabelValues(resource.metadata.labels, labels);
}

function hasLabelValues(actual: Record<string, string>, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function asResourceList(
  body: unknown,
  defaults?: Pick<KubernetesResource, "apiVersion" | "kind">
): { items: KubernetesResource[] } {
  const record = asRecord(body);
  if (!Array.isArray(record.items)) {
    return { items: [] };
  }
  return { items: record.items.map((item) => asResource(item, defaults)) };
}

function asResource(body: unknown, defaults?: Pick<KubernetesResource, "apiVersion" | "kind">): KubernetesResource {
  const record = asRecord(body);
  const metadata = asRecord(record.metadata);
  const namespace = typeof metadata.namespace === "string" ? { namespace: metadata.namespace } : {};
  const apiVersion = typeof record.apiVersion === "string" && record.apiVersion.length > 0
    ? record.apiVersion
    : defaults?.apiVersion ?? "v1";
  const kind = typeof record.kind === "string" && record.kind.length > 0
    ? record.kind
    : defaults?.kind ?? String(record.kind);
  return {
    ...record,
    apiVersion,
    kind,
    metadata: {
      ...metadata,
      name: String(metadata.name),
      ...namespace,
      labels: isStringRecord(metadata.labels) ? metadata.labels : {}
    }
  };
}

function parseExactResource(body:unknown,ref:KubernetesResourceRef):KubernetesResource{
  const record=asRecord(body);
  const metadata=asRecord(record.metadata);
  if(
    record.kind!==ref.kind||
    metadata.name!==ref.name||
    metadata.namespace!==ref.namespace||
    !isStringRecord(metadata.labels)
  )throw new Error(`Kubernetes inspect ${ref.kind}/${ref.name} returned an invalid Kubernetes resource`);
  return asResource(record);
}

function resourceUid(resource:KubernetesResource):string|null{
  const uid=resource.metadata.uid;
  return typeof uid==="string"&&uid.length>0?uid:null;
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

function kubernetesHttpError(message: string, response: KubernetesTransportResponse): Error {
  const status = kubernetesStatusBodySummary(response.body);
  return new Error(status ? `${message}: ${status}` : message);
}

function kubernetesStatusBodySummary(body: unknown): string | null {
  const record = asRecord(body);
  if (record.kind !== "Status") {
    return null;
  }

  const kind = safeStatusField(record.kind);
  const reason = safeStatusField(record.reason);
  const code = safeStatusField(record.code);
  const message = safeStatusField(record.message);
  const fields = [
    kind ? `kind=${kind}` : null,
    reason ? `reason=${reason}` : null,
    code ? `code=${code}` : null,
    message ? `message=${JSON.stringify(message)}` : null
  ].filter((field): field is string => field !== null);

  return fields.length > 0 ? `Kubernetes status ${fields.join(" ")}` : null;
}

function safeStatusField(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return null;
  }
  const text = sanitizeKubernetesStatusText(String(value));
  return text.length > 0 ? text : null;
}

function sanitizeKubernetesStatusText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\bbsk_[A-Za-z0-9_-]+/g, "bsk_<redacted>")
    .replace(/\blbk_[A-Za-z0-9_-]+/g, "lbk_<redacted>")
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]*/g, "sk-<redacted>")
    .replace(/\bMODEL_API_KEY\b/g, "<redacted>")
    .slice(0, 400);
}

function parseResponseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
