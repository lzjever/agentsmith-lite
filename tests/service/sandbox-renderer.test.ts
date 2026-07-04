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
    const role = rendered.resources.find((resource) => resource.kind === "Role") as RoleResource | undefined;
    const networkPolicy = rendered.resources.find((resource) => resource.kind === "NetworkPolicy");

    assert.equal(pod?.metadata.labels["agentsmith-lite/task-id"], "t1");
    assert.equal(pod?.spec.automountServiceAccountToken, false);
    assert.equal(pod?.spec.hostNetwork, false);
    assert.equal(pod?.spec.securityContext.runAsNonRoot, true);
    const container = pod?.spec.containers[0];
    const projectMount = container?.volumeMounts[0];
    assert.ok(container);
    assert.ok(projectMount);
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
    assert.equal(projectMount.subPath, "workspaces/w1/projects/p1");
    assert.ok(networkPolicy, "NetworkPolicy should be rendered");

    const ruleResources = JSON.stringify(role?.rules ?? []);
    assert.ok(!ruleResources.includes("pods/exec"));
    assert.ok(!ruleResources.includes("persistentvolumes"));
  });
});

interface PodResource extends KubernetesResource {
  spec: {
    automountServiceAccountToken: boolean;
    hostNetwork: boolean;
    securityContext: { runAsNonRoot: boolean };
    containers: Array<{
      securityContext: {
        allowPrivilegeEscalation: boolean;
        capabilities: { drop: string[] };
      };
      volumeMounts: Array<{ subPath: string }>;
    }>;
  };
}

interface RoleResource extends KubernetesResource {
  rules: Array<Record<string, unknown>>;
}
