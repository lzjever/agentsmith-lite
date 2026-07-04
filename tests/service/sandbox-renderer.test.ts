import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KubernetesResource } from "../../packages/contracts/src/api.js";
import { renderSandboxResources } from "../../packages/sandbox-controller/src/manifestRenderer.js";

describe("sandbox manifest renderer", () => {
  it("renders dry-run pod resources with labels, restricted security, and no exec permission", () => {
    const rendered = renderSandboxResources({
      namespace: "agentsmith",
      workspaceId: "w1",
      projectId: "p1",
      taskId: "t1",
      runId: "r1",
      image: "example/botified-runner@sha256:abc",
      pvcName: "agentsmith-lite-files",
      projectSubPath: "workspaces/w1/projects/p1",
      botifiedPort: 3099,
      serviceKeySecretName: "botified-t1",
      cpuRequest: "250m",
      memoryRequest: "512Mi",
      cpuLimit: "1",
      memoryLimit: "1Gi"
    });

    const pod = rendered.resources.find((resource) => resource.kind === "Pod") as PodResource | undefined;
    const serviceAccount = rendered.resources.find((resource) => resource.kind === "ServiceAccount") as
      | ServiceAccountResource
      | undefined;
    const networkPolicy = rendered.resources.find((resource) => resource.kind === "NetworkPolicy");
    const secret = rendered.resources.find((resource) => resource.kind === "Secret") as SecretResource | undefined;

    assert.deepEqual(rendered.resources.map((resource) => resource.kind), [
      "ServiceAccount",
      "Secret",
      "ConfigMap",
      "Pod",
      "Service",
      "NetworkPolicy"
    ]);

    for (const resource of rendered.resources) {
      assert.equal(resource.metadata.labels["agentsmith-lite/managed-by"], "agentsmith-lite");
      assert.equal(resource.metadata.labels["agentsmith-lite/workspace-id"], "w1");
      assert.equal(resource.metadata.labels["agentsmith-lite/project-id"], "p1");
      assert.equal(resource.metadata.labels["agentsmith-lite/task-id"], "t1");
      assert.equal(resource.metadata.labels["agentsmith-lite/run-id"], "r1");
    }

    assert.equal(serviceAccount?.automountServiceAccountToken, false);
    assert.equal(pod?.spec.automountServiceAccountToken, false);
    assert.equal(pod?.spec.hostNetwork, false);
    assert.equal(pod?.spec.securityContext.runAsNonRoot, true);
    const container = pod?.spec.containers[0];
    const projectMount = container?.volumeMounts[0];
    assert.ok(container);
    assert.ok(projectMount);
    assert.deepEqual(container.env, [
      {
        name: "BOTIFIED_SERVICE_KEY",
        valueFrom: {
          secretKeyRef: {
            name: "botified-t1",
            key: "BOTIFIED_SERVICE_KEY"
          }
        }
      },
      {
        name: "MODEL_API_KEY",
        valueFrom: {
          secretKeyRef: {
            name: "botified-t1",
            key: "MODEL_API_KEY"
          }
        }
      }
    ]);
    assert.deepEqual(container.readinessProbe, {
      httpGet: {
        path: "/healthz",
        port: "http"
      }
    });
    assert.equal(container.resources.requests.cpu, "250m");
    assert.equal(container.resources.requests.memory, "512Mi");
    assert.equal(container.resources.limits.cpu, "1");
    assert.equal(container.resources.limits.memory, "1Gi");
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.notEqual(container.securityContext.privileged, true);
    assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
    assert.equal(projectMount.subPath, "workspaces/w1/projects/p1");
    assert.ok(networkPolicy, "NetworkPolicy should be rendered");
    assert.deepEqual(secret?.stringData, {
      BOTIFIED_SERVICE_KEY: "<redacted-generated-per-task>",
      MODEL_API_KEY: "<redacted-model-api-key>"
    });

    const serialized = JSON.stringify(rendered.resources);
    assert.equal(serialized.includes("test-service-key"), false);
    assert.equal(serialized.includes("sk-real-model-key"), false);
    assert.ok(!serialized.includes("pods/exec"));
    assert.ok(!serialized.includes("pods/log"));
    assert.ok(!serialized.includes("pods/attach"));
    assert.ok(!serialized.includes("pods/portforward"));
    assert.ok(!serialized.includes("persistentvolumeclaims"));
    assert.ok(!serialized.includes("persistentvolumes"));
    assert.ok(!serialized.includes("hostPath"));
    assert.ok(!serialized.includes('"privileged":true'));
  });
});

interface PodResource extends KubernetesResource {
  spec: {
    automountServiceAccountToken: boolean;
    hostNetwork: boolean;
    securityContext: { runAsNonRoot: boolean };
    containers: Array<{
      resources: {
        requests: { cpu: string; memory: string };
        limits: { cpu: string; memory: string };
      };
      securityContext: {
        allowPrivilegeEscalation: boolean;
        privileged?: boolean;
        capabilities: { drop: string[] };
      };
      env: unknown[];
      readinessProbe: unknown;
      volumeMounts: Array<{ subPath: string }>;
    }>;
  };
}

interface ServiceAccountResource extends KubernetesResource {
  automountServiceAccountToken: boolean;
}

interface SecretResource extends KubernetesResource {
  stringData: Record<string, string>;
}
