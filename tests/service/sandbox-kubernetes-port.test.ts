import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KubernetesResource } from "../../packages/contracts/src/api.js";
import {
  applySandboxReconcileActionsToKubernetes,
  SandboxKubernetesPort,
  type KubernetesTransport,
  type KubernetesTransportRequest,
  type KubernetesTransportResponse,
  type KubernetesResourceRef
} from "../../packages/sandbox-controller/src/kubernetesPort.js";
import type { SandboxReconcileAction } from "../../packages/sandbox-controller/src/reconciler.js";

const identityLabels = {
  "agentsmith-lite/managed-by": "agentsmith-lite",
  "agentsmith-lite/workspace-id": "w1",
  "agentsmith-lite/project-id": "p1",
  "agentsmith-lite/task-id": "t1",
  "agentsmith-lite/run-id": "r1"
};

describe("sandbox Kubernetes port", () => {
  it("lists exactly the six allowed namespaced lifecycle resources with the managed label selector", async () => {
    const transport = recordingTransport(() => ({ statusCode: 200, body: { items: [] } }));
    const port = new SandboxKubernetesPort({ transport });

    assert.deepEqual(await port.listManagedResources("agentsmith"), []);

    assert.deepEqual(transport.requests.map((request) => `${request.method} ${request.path}`), [
      "GET /api/v1/namespaces/agentsmith/secrets?labelSelector=agentsmith-lite%2Fmanaged-by%3Dagentsmith-lite",
      "GET /api/v1/namespaces/agentsmith/configmaps?labelSelector=agentsmith-lite%2Fmanaged-by%3Dagentsmith-lite",
      "GET /api/v1/namespaces/agentsmith/serviceaccounts?labelSelector=agentsmith-lite%2Fmanaged-by%3Dagentsmith-lite",
      "GET /apis/networking.k8s.io/v1/namespaces/agentsmith/networkpolicies?labelSelector=agentsmith-lite%2Fmanaged-by%3Dagentsmith-lite",
      "GET /api/v1/namespaces/agentsmith/services?labelSelector=agentsmith-lite%2Fmanaged-by%3Dagentsmith-lite",
      "GET /api/v1/namespaces/agentsmith/pods?labelSelector=agentsmith-lite%2Fmanaged-by%3Dagentsmith-lite"
    ]);

    const joined = transport.requests.map((request) => request.path).join("\n");
    for (const forbidden of ["pods/exec", "pods/log", "persistentvolumes", "persistentvolumeclaims", "nodes"]) {
      assert.equal(joined.includes(forbidden), false, `${forbidden} must not be requested`);
    }
    assert.equal(transport.requests.some((request) => request.path === "/api/v1/namespaces"), false, "namespaces must not be listed");
  });

  it("normalizes list items without per-item kind or apiVersion from each lifecycle endpoint", async () => {
    const transport = recordingTransport((request) => ({
      statusCode: 200,
      body: {
        items: [{
          metadata: {
            name: `${listResourceName(request.path)}-from-list`,
            namespace: "agentsmith",
            labels: identityLabels
          }
        }]
      }
    }));
    const port = new SandboxKubernetesPort({ transport });

    const resources = await port.listManagedResources("agentsmith");

    assert.deepEqual(resources.map((resource) => `${resource.apiVersion}:${resource.kind}:${resource.metadata.name}`), [
      "v1:Secret:secrets-from-list",
      "v1:ConfigMap:configmaps-from-list",
      "v1:ServiceAccount:serviceaccounts-from-list",
      "networking.k8s.io/v1:NetworkPolicy:networkpolicies-from-list",
      "v1:Service:services-from-list",
      "v1:Pod:pods-from-list"
    ]);
  });

  it("applies resources with server-side apply, converts Secret stringData, and fences existing label mismatches", async () => {
    const transport = recordingTransport((request) => {
      if (request.method === "GET") {
        return { statusCode: 404 };
      }
      return { statusCode: 200, body: resource("Secret", "asl-botified-t1") };
    });
    const port = new SandboxKubernetesPort({ transport });

    assert.equal(
      await port.applyResource(
        {
          ...resource("Secret", "asl-botified-t1"),
          type: "Opaque",
          stringData: { BOTIFIED_SERVICE_KEY: "s3cr3t" }
        },
        identityLabels
      ),
      "applied"
    );

    const patch = transport.requests[1];
    assert.equal(
      `${patch?.method} ${patch?.path}`,
      "PATCH /api/v1/namespaces/agentsmith/secrets/asl-botified-t1?fieldManager=agentsmith-lite-sandbox&force=false"
    );
    assert.equal(patch?.headers["content-type"], "application/apply-patch+yaml");
    const body = JSON.parse(String(patch?.body)) as KubernetesResource;
    assert.deepEqual(body.data, { BOTIFIED_SERVICE_KEY: "czNjcjN0" });
    assert.equal(body.stringData, undefined);

    const mismatched = recordingTransport(() => ({
      statusCode: 200,
      body: resource("Secret", "asl-botified-t1", { ...identityLabels, "agentsmith-lite/run-id": "other" })
    }));
    const fencedPort = new SandboxKubernetesPort({ transport: mismatched });
    assert.equal(await fencedPort.applyResource(resource("Secret", "asl-botified-t1"), identityLabels), "fence_mismatch");
    assert.deepEqual(mismatched.requests.map((request) => request.method), ["GET"]);
  });

  it("does not contact Kubernetes when the apply body is missing expected identity labels", async () => {
    const transport = recordingTransport(() => {
      throw new Error("transport should not be called for malformed apply body labels");
    });
    const port = new SandboxKubernetesPort({ transport });

    assert.equal(
      await port.applyResource(
        resource("Secret", "asl-botified-t1", { ...identityLabels, "agentsmith-lite/run-id": "wrong-run" }),
        identityLabels
      ),
      "fence_mismatch"
    );
    assert.deepEqual(transport.requests, []);
  });

  it("propagates an absolute startup abort through apply to the pending transport request",async()=>{
    const controller=new AbortController();
    let patchSignal:AbortSignal|undefined;
    const transport:KubernetesTransport={
      async request(request,signal){
        if(request.method==="GET")return{statusCode:404};
        patchSignal=signal;
        return new Promise<KubernetesTransportResponse>((_resolve,reject)=>{
          signal?.addEventListener("abort",()=>reject(signal.reason),{once:true});
        });
      }
    };
    const port=new SandboxKubernetesPort({transport});
    const applying=port.applyResource(resource("Secret","asl-botified-t1"),identityLabels,controller.signal);
    await new Promise<void>((resolve)=>setImmediate(resolve));

    controller.abort(new Error("startup action deadline elapsed"));

    await assert.rejects(applying,/startup action deadline elapsed/);
    assert.equal(patchSignal,controller.signal);
    assert.equal(patchSignal?.aborted,true);
  });

  it("deletes with GET label fencing and UID precondition, with idempotent not-found handling", async () => {
    const transport = recordingTransport((request) => {
      if (request.method === "GET") {
        return { statusCode: 200, body: resource("Pod", "asl-task-t1", identityLabels, "uid-1") };
      }
      return { statusCode: 200 };
    });
    const port = new SandboxKubernetesPort({ transport });

    assert.equal(await port.deleteResource({ kind: "Pod", namespace: "agentsmith", name: "asl-task-t1" }, identityLabels), "deleted");
    assert.deepEqual(transport.requests.map((request) => request.method), ["GET", "DELETE"]);
    assert.deepEqual(JSON.parse(String(transport.requests[1]?.body)), {
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid: "uid-1" }
    });

    const notFound = new SandboxKubernetesPort({ transport: recordingTransport(() => ({ statusCode: 404 })) });
    assert.equal(await notFound.deleteResource({ kind: "Pod", namespace: "agentsmith", name: "missing" }, identityLabels), "not_found");

    const mismatched = recordingTransport(() => ({
      statusCode: 200,
      body: resource("Pod", "asl-task-t1", { ...identityLabels, "agentsmith-lite/run-id": "other" })
    }));
    const fencedPort = new SandboxKubernetesPort({ transport: mismatched });
    assert.equal(await fencedPort.deleteResource({ kind: "Pod", namespace: "agentsmith", name: "asl-task-t1" }, identityLabels), "fence_mismatch");
    assert.deepEqual(mismatched.requests.map((request) => request.method), ["GET"]);
  });

  it("deletes an observed Service by UID without re-reading the Service endpoint", async () => {
    const transport = recordingTransport((request) => {
      if (request.method === "GET") {
        return { statusCode: 400, body: { kind: "Status", message: "service get rejected" } };
      }
      const deleteOptions = JSON.parse(String(request.body)) as Record<string, unknown>;
      if (
        deleteOptions.apiVersion !== "v1" ||
        deleteOptions.kind !== "DeleteOptions" ||
        (deleteOptions.preconditions as Record<string, unknown> | undefined)?.uid !== "service-uid-1"
      ) {
        return { statusCode: 400, body: { kind: "Status", message: "invalid delete options" } };
      }
      return { statusCode: 200 };
    });
    const port = new SandboxKubernetesPort({ transport });
    const observedRef = {
      kind: "Service",
      namespace: "agentsmith",
      name: "asl-task-t1",
      uid: "service-uid-1",
      labels: identityLabels
    } as KubernetesResourceRef;

    assert.equal(await port.deleteResource(observedRef, identityLabels), "deleted");

    assert.deepEqual(transport.requests.map((request) => `${request.method} ${request.path}`), [
      "DELETE /api/v1/namespaces/agentsmith/services/asl-task-t1"
    ]);
    assert.deepEqual(JSON.parse(String(transport.requests[0]?.body)), {
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid: "service-uid-1" }
    });
  });

  it("includes sanitized Kubernetes Status details when Service delete returns HTTP 400", async () => {
    const transport = recordingTransport(() => ({
      statusCode: 400,
      body: {
        kind: "Status",
        reason: "BadRequest",
        code: 400,
        message: "invalid delete options for Bearer bsk_runtime_secret and sk-real-model-key",
        details: {
          causes: [{ message: "hidden detail sk-real-detail-key" }]
        }
      }
    }));
    const port = new SandboxKubernetesPort({ transport });

    await assert.rejects(
      port.deleteResource({
        kind: "Service",
        namespace: "agentsmith",
        name: "asl-task-t1",
        uid: "service-uid-1",
        labels: identityLabels
      }, identityLabels),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Kubernetes delete Service\/asl-task-t1 failed with HTTP 400/);
        assert.match(error.message, /kind=Status/);
        assert.match(error.message, /reason=BadRequest/);
        assert.match(error.message, /code=400/);
        assert.match(error.message, /message="invalid delete options for Bearer <redacted> and sk-<redacted>"/);
        assert.doesNotMatch(error.message, /bsk_runtime_secret|sk-real-model-key|hidden detail|sk-real-detail-key|details/);
        return true;
      }
    );
  });

  it("maps pod readiness and enforces identity labels", async () => {
    assert.deepEqual(await readiness(
      podStatus({ phase: "Running", ready: true, podIp:"10.42.0.17" }),
      podIdentity()
    ), {
      state:"ready",
      podUid:"pod-uid-1",
      podIp:"10.42.0.17"
    });
    assert.deepEqual(await readiness(podStatus({ phase: "Running", ready: false }),podIdentity()), {
      state:"pending",podUid:"pod-uid-1"
    });
    assert.deepEqual(await readiness(podStatus({ phase: "Failed", ready: false }),podIdentity()), {
      state:"failed",podUid:"pod-uid-1"
    });
    assert.equal(await readiness(podStatus({phase:"Running",ready:true})),"fence_mismatch");

    const notFound = new SandboxKubernetesPort({ transport: recordingTransport(() => ({ statusCode: 404 })) });
    assert.equal(await notFound.getPodReadiness("agentsmith", "missing", identityLabels), "not_found");

    const mismatched = new SandboxKubernetesPort({
      transport: recordingTransport(() => ({
        statusCode: 200,
        body: { ...resource("Pod", "asl-task-t1", { ...identityLabels, "agentsmith-lite/run-id": "other" }), status: podStatus({ phase: "Running", ready: true }) }
      }))
    });
    assert.equal(await mismatched.getPodReadiness("agentsmith", "asl-task-t1", identityLabels), "fence_mismatch");
  });

  it("reads exact ConfigMap bytes only under the expected identity labels", async () => {
    const transport = recordingTransport(() => ({
      statusCode: 200,
      body: {
        ...resource("ConfigMap", "asl-task-t1-config-4f2acbb10d"),
        data: {
          "runtime.json": "{\"model\":\"test\"}"
        }
      }
    }));
    const port = new SandboxKubernetesPort({ transport });

    assert.deepEqual(
      await port.getConfigMapData(
        "agentsmith",
        "asl-task-t1-config-4f2acbb10d",
        identityLabels
      ),
      {
        data: {
          "runtime.json": "{\"model\":\"test\"}"
        }
      }
    );

    const mismatched = new SandboxKubernetesPort({
      transport: recordingTransport(() => ({
        statusCode: 200,
        body: {
          ...resource("ConfigMap", "asl-task-t1-config-4f2acbb10d", {
            ...identityLabels,
            "agentsmith-lite/run-id": "other"
          }),
          data: {
            "runtime.json": "{\"model\":\"test\"}"
          }
        }
      }))
    });
    assert.equal(
      await mismatched.getConfigMapData(
        "agentsmith",
        "asl-task-t1-config-4f2acbb10d",
        identityLabels
      ),
      "fence_mismatch"
    );
  });

  it("maps reconcile actions to Kubernetes mutations and ignores adopt/store actions", async () => {
    const calls: string[] = [];
    const port = {
      applyResource: async (created: KubernetesResource, expectedLabels: Record<string, string>) => {
        calls.push(`apply:${created.kind}:${created.metadata.name}:${expectedLabels["agentsmith-lite/run-id"]}`);
        return "applied" as const;
      },
      deleteResource: async (ref: KubernetesResourceRef, expectedLabels: Record<string, string>) => {
        calls.push(`delete:${ref.kind}:${ref.name}:${expectedLabels["agentsmith-lite/run-id"]}`);
        return "deleted" as const;
      },
    };

    const actions: SandboxReconcileAction[] = [
      { type: "create_resource", runId: "r1", kind: "Secret", name: "asl-botified-t1", labels: identityLabels, resource: resource("Secret", "asl-botified-t1") },
      { type: "adopt_resource", runId: "r1", kind: "Pod", name: "asl-task-t1", labels: identityLabels, resource: resource("Pod", "asl-task-t1") },
      { type: "delete_resource", runId: "r1", kind: "Pod", name: "asl-task-t1", labels: identityLabels, resource: resource("Pod", "asl-task-t1") },
      { type: "store_run_state", run: { runId: "r1" } as never, reason: "desired_observed" }
    ];

    await applySandboxReconcileActionsToKubernetes(port, actions);

    assert.deepEqual(calls, [
      "apply:Secret:asl-botified-t1:r1",
      "delete:Pod:asl-task-t1:r1"
    ]);
  });

  it("throws when action applier sees applyResource fence_mismatch", async () => {
    await assert.rejects(
      applySandboxReconcileActionsToKubernetes(
        mutationPort({
          applyResource: async () => "fence_mismatch"
        }),
        [
          {
            type: "create_resource",
            runId: "r1",
            kind: "Secret",
            name: "asl-botified-t1",
            labels: identityLabels,
            resource: resource("Secret", "asl-botified-t1")
          }
        ]
      ),
      /Kubernetes apply fence mismatch for create_resource Secret\/asl-botified-t1/
    );
  });

  it("throws when action applier sees deleteResource fence_mismatch", async () => {
    await assert.rejects(
      applySandboxReconcileActionsToKubernetes(
        mutationPort({
          deleteResource: async () => "fence_mismatch"
        }),
        [
          {
            type: "delete_resource",
            runId: "r1",
            kind: "Pod",
            name: "asl-task-t1",
            labels: identityLabels,
            resource: resource("Pod", "asl-task-t1")
          }
        ]
      ),
      /Kubernetes delete fence mismatch for delete_resource Pod\/asl-task-t1/
    );
  });

  it("keeps delete not_found idempotent in the action applier", async () => {
    await applySandboxReconcileActionsToKubernetes(
      mutationPort({
        deleteResource: async () => "not_found"
      }),
      [
        {
          type: "delete_resource",
          runId: "r1",
          kind: "Pod",
          name: "asl-task-t1",
          labels: identityLabels,
          resource: resource("Pod", "asl-task-t1")
        }
      ]
    );
  });
});

function recordingTransport(
  handler: (request: KubernetesTransportRequest) => KubernetesTransportResponse | Promise<KubernetesTransportResponse>
): KubernetesTransport & { requests: KubernetesTransportRequest[] } {
  const requests: KubernetesTransportRequest[] = [];
  return {
    requests,
    async request(request: KubernetesTransportRequest): Promise<KubernetesTransportResponse> {
      requests.push(request);
      return handler(request);
    }
  };
}

function listResourceName(path: string): string {
  return path.split("?")[0]?.split("/").at(-1) ?? "unknown";
}

function resource(
  kind: string,
  name: string,
  labels: Record<string, string> = identityLabels,
  uid?: string
): KubernetesResource {
  return {
    apiVersion: kind === "NetworkPolicy" ? "networking.k8s.io/v1" : "v1",
    kind,
    metadata: {
      name,
      namespace: "agentsmith",
      labels,
      ...(uid ? { uid } : {})
    }
  };
}

function podStatus(input: { phase: string; ready: boolean; podIp?:string }): Record<string, unknown> {
  return {
    phase: input.phase,
    conditions: [{ type: "Ready", status: input.ready ? "True" : "False" }],
    ...(input.podIp?{podIP:input.podIp}:{})
  };
}

async function readiness(
  status: Record<string, unknown>,
  metadata:Record<string,unknown>={}
) {
  const port = new SandboxKubernetesPort({
    transport: recordingTransport(() => ({
      statusCode: 200,
      body: {
        ...resource("Pod", "asl-task-t1"),
        metadata:{...resource("Pod", "asl-task-t1").metadata,...metadata},
        status
      }
    }))
  });
  return port.getPodReadiness("agentsmith", "asl-task-t1", identityLabels);
}

function podIdentity():Record<string,unknown>{
  return{uid:"pod-uid-1"};
}

function mutationPort(overrides: {
  applyResource?: (created: KubernetesResource, expectedLabels: Record<string, string>) => Promise<"applied" | "fence_mismatch">;
  deleteResource?: (ref: KubernetesResourceRef, expectedLabels: Record<string, string>) => Promise<"deleted" | "not_found" | "fence_mismatch">;
}) {
  return {
    applyResource: overrides.applyResource ?? (async () => "applied" as const),
    deleteResource: overrides.deleteResource ?? (async () => "deleted" as const)
  };
}
