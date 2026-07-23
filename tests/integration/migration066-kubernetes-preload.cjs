const fs = require("node:fs");
const https = require("node:https");
const { syncBuiltinESMExports } = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const logPath = process.env.AGENTSMITH_LITE_MIGRATION_TEST_KUBERNETES_LOG;
const storageMarker = process.env.AGENTSMITH_LITE_MIGRATION_TEST_STORAGE_MARKER;
if (!logPath || !storageMarker) {
  throw new Error("migration 066 Kubernetes preload requires log and storage marker paths");
}

const originalReadFileSync = fs.readFileSync;
const deletedNames = new Set();
fs.readFileSync = function readFileSync(candidate, ...args) {
  if (candidate === "/var/run/secrets/kubernetes.io/serviceaccount/token") {
    return args[0] === "utf8" ? "migration-test-token" : Buffer.from("migration-test-token");
  }
  if (candidate === "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt") {
    return Buffer.from("migration-test-ca");
  }
  return originalReadFileSync.call(this, candidate, ...args);
};

https.request = function request(options, callback) {
  const request = new EventEmitter();
  const chunks = [];
  request.setTimeout = () => request;
  request.write = (chunk) => {
    chunks.push(Buffer.from(chunk));
    return true;
  };
  request.destroy = (error) => {
    if (error) process.nextTick(() => request.emit("error", error));
  };
  request.end = () => {
    const method = options.method ?? "GET";
    const requestPath = String(options.path);
    const body = Buffer.concat(chunks).toString("utf8");
    if (method === "DELETE") {
      deletedNames.add(decodeURIComponent(requestPath.split("/").at(-1)));
    }
    fs.appendFileSync(logPath, `${JSON.stringify({
      method,
      path: requestPath,
      body,
      storageMarkerExists: fs.existsSync(storageMarker)
    })}\n`);

    const response = new PassThrough();
    response.statusCode = 200;
    callback(response);
    response.end(JSON.stringify(method === "GET" ? listResponse(requestPath) : {}));
  };
  return request;
};

syncBuiltinESMExports();

function listResponse(requestPath) {
  const resource = resourceForListPath(requestPath);
  if (!resource) return { items: [] };
  const items = deletedNames.has(resource.metadata.name) ? [] : [resource];
  if (resource.kind === "Pod") {
    items.push({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: "schema-incomplete-pod",
        namespace: "agentsmith-migration-test",
        uid: "uid-schema-incomplete-pod",
        labels: { "agentsmith-lite/managed-by": "agentsmith-lite" }
      }
    });
  }
  return { items };
}

function resourceForListPath(requestPath) {
  const mappings = [
    ["/secrets?", "v1", "Secret", "schema-owned-secret"],
    ["/configmaps?", "v1", "ConfigMap", "schema-owned-configmap"],
    ["/serviceaccounts?", "v1", "ServiceAccount", "schema-owned-serviceaccount"],
    ["/networkpolicies?", "networking.k8s.io/v1", "NetworkPolicy", "schema-owned-networkpolicy"],
    ["/services?", "v1", "Service", "schema-owned-service"],
    ["/pods?", "v1", "Pod", "schema-owned-pod"]
  ];
  const mapping = mappings.find(([needle]) => requestPath.includes(needle));
  if (!mapping) return null;
  const [, apiVersion, kind, name] = mapping;
  return {
    apiVersion,
    kind,
    metadata: {
      name,
      namespace: "agentsmith-migration-test",
      uid: `uid-${name}`,
      labels: {
        "app.kubernetes.io/name": "agentsmith-lite",
        "app.kubernetes.io/part-of": "agentsmith-lite",
        "app.kubernetes.io/managed-by": "agentsmith-lite",
        "app.kubernetes.io/component": "sandbox",
        "agentsmith-lite/managed-by": "agentsmith-lite",
        "agentsmith-lite/workspace-id": "workspace-cutover",
        "agentsmith-lite/project-id": "project-cutover",
        "agentsmith-lite/task-id": "task-cutover",
        "agentsmith-lite/run-id": "run-cutover"
      }
    }
  };
}
