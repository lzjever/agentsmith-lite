import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KubernetesResource } from "../../packages/contracts/src/api.js";
import { renderSandboxResources } from "../../packages/sandbox-controller/src/manifestRenderer.js";

describe("sandbox manifest renderer", () => {
  it("renders Kubernetes-safe resource names while preserving original ids in labels", () => {
    const taskId = "task_2323854661afae8194cd";
    const runId = "run_2323854661afae8194cd";
    const workspaceId = "workspace_live_test";
    const projectId = "project_live_test";
    const rendered = renderSandboxResources({
      namespace: "agentsmith",
      workspaceId,
      projectId,
      taskId,
      runId,
      image: "example/botified-runner@sha256:abc",
      pvcName: "agentsmith-lite-files",
      projectSubPath: "workspaces/workspace_live_test/projects/project_live_test",
      botifiedPort: 3099,
      serviceKeySecretName: `asl-botified-${taskId}`,
      cpuRequest: "250m",
      memoryRequest: "512Mi",
      cpuLimit: "1",
      memoryLimit: "1Gi"
    });

    const pod = rendered.resources.find((resource) => resource.kind === "Pod") as PodResource | undefined;
    const secret = rendered.resources.find((resource) => resource.kind === "Secret");
    const configMap = rendered.resources.find((resource) => resource.kind === "ConfigMap");
    const serviceAccount = rendered.resources.find((resource) => resource.kind === "ServiceAccount");
    assert.ok(pod);
    assert.ok(secret);
    assert.ok(configMap);
    assert.ok(serviceAccount);

    for (const resource of rendered.resources) {
      assertDnsLabel(resource.metadata.name);
      assert.equal(resource.metadata.labels["agentsmith-lite/workspace-id"], workspaceId);
      assert.equal(resource.metadata.labels["agentsmith-lite/project-id"], projectId);
      assert.equal(resource.metadata.labels["agentsmith-lite/task-id"], taskId);
      assert.equal(resource.metadata.labels["agentsmith-lite/run-id"], runId);
    }

    assert.equal(pod.spec.serviceAccountName, serviceAccount.metadata.name);
    assertDnsLabel(pod.spec.serviceAccountName);
    for (const container of pod.spec.containers) {
      for (const env of container.env) {
        const secretName = env.valueFrom?.secretKeyRef?.name;
        if (secretName) {
          assert.equal(secretName, secret.metadata.name);
          assertDnsLabel(secretName);
        }
      }
    }
    for (const volume of pod.spec.volumes) {
      if (volume.configMap?.name) {
        assert.equal(volume.configMap.name, configMap.metadata.name);
        assertDnsLabel(volume.configMap.name);
      }
      if (volume.secret?.secretName) {
        assertDnsLabel(volume.secret.secretName);
      }
    }
  });

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
    const networkPolicy = rendered.resources.find((resource) => resource.kind === "NetworkPolicy") as
      | NetworkPolicyResource
      | undefined;
    const service = rendered.resources.find((resource) => resource.kind === "Service") as ServiceResource | undefined;
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
    assert.equal(pod?.spec.securityContext.runAsUser, 10001);
    assert.equal(pod?.spec.securityContext.runAsGroup, 10001);
    assert.equal(pod?.spec.securityContext.fsGroup, 10001);
    assert.equal(pod?.spec.shareProcessNamespace, false);
    assert.deepEqual(pod?.spec.containers.map((candidate) => candidate.name), ["botified-server", "bash-executor"]);
    const container = pod?.spec.containers.find((candidate) => candidate.name === "botified-server");
    const executor = pod?.spec.containers.find((candidate) => candidate.name === "bash-executor");
    const projectMount = container?.volumeMounts.find((mount) => mount.mountPath === "/workspace/project");
    const taskHomeMount = container?.volumeMounts.find((mount) => mount.mountPath === "/workspace/task/home");
    const botifiedMount = container?.volumeMounts.find((mount) => mount.mountPath === "/workspace/task/botified");
    const artifactMount = container?.volumeMounts.find((mount) => mount.mountPath === "/workspace/task/artifacts");
    const instructionsMount = container?.volumeMounts.find((mount) => mount.mountPath === "/workspace/task/home/AGENTS.md");
    assert.ok(container);
    assert.ok(executor);
    assert.ok(projectMount);
    assert.ok(taskHomeMount);
    assert.ok(botifiedMount);
    assert.ok(artifactMount);
    assert.deepEqual(instructionsMount, { name: "botified-instructions", mountPath: "/workspace/task/home/AGENTS.md", subPath: "AGENTS.md", readOnly: true });
    assert.equal(container.workingDir, "/workspace/task/home");
    assert.deepEqual(container.env, [
      {
        name: "HOME",
        value: "/workspace/task/home"
      },
      {
        name: "BOTIFIED_SERVICE_KEY",
        valueFrom: {
          secretKeyRef: {
            name: "botified-t1",
            key: "BOTIFIED_SERVICE_KEY"
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
    assert.deepEqual(executor.readinessProbe, {
      exec: {
        command: ["bash", "-c", "</dev/tcp/127.0.0.1/3110"]
      }
    });
    assert.equal(container.resources.requests.cpu, "250m");
    assert.equal(container.resources.requests.memory, "512Mi");
    assert.equal(container.resources.limits.cpu, "1");
    assert.equal(container.resources.limits.memory, "1Gi");
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.notEqual(container.securityContext.privileged, true);
    assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
    assert.equal(projectMount.mountPath, "/workspace/project");
    assert.equal(projectMount.subPath, "workspaces/w1/projects/p1/tasks/t1/inputs");
    assert.equal(projectMount.readOnly, true);
    assert.equal(taskHomeMount.subPath, "workspaces/w1/projects/p1/tasks/t1/home");
    assert.notEqual(taskHomeMount.readOnly, true);
    assert.equal(botifiedMount.subPath, "workspaces/w1/projects/p1/tasks/t1/botified");
    assert.notEqual(botifiedMount.readOnly, true);
    assert.equal(artifactMount.subPath, "workspaces/w1/projects/p1/tasks/t1/artifacts");
    assert.notEqual(artifactMount.readOnly, true);
    assert.equal(executor.workingDir, "/workspace/task/home");
    assert.deepEqual(executor.env, [{ name: "HOME", value: "/workspace/task/home" }]);
    assert.equal(executor.securityContext.runAsUser, 10002);
    assert.equal(executor.volumeMounts.some((mount) => mount.mountPath === "/workspace/project" && mount.readOnly === true), true);
    assert.equal(executor.volumeMounts.some((mount) => mount.mountPath === "/workspace/task/home" && mount.readOnly !== true), true);
    assert.equal(executor.volumeMounts.some((mount) => mount.mountPath === "/workspace/task/artifacts" && mount.subPath === "workspaces/w1/projects/p1/tasks/t1/artifacts" && mount.readOnly !== true), true);
    assert.equal(executor.volumeMounts.some((mount) => mount.mountPath === "/workspace/task/botified"), false);
    assert.equal(executor.volumeMounts.some((mount) => mount.name === "botified-instructions" || mount.mountPath === "/workspace/task/home/AGENTS.md"), false);
    assert.equal(executor.volumeMounts.some((mount) => mount.name === "botified-config" || mount.name === "model-ca"), false);
    assert.ok(service, "Service should be rendered");
    assert.deepEqual(service.spec.selector, pod?.metadata.labels);
    assert.deepEqual(service.spec.ports, [{ name: "http", port: 3099, targetPort: "http" }]);
    assert.ok(networkPolicy, "NetworkPolicy should be rendered");
    assert.deepEqual(networkPolicy.spec.podSelector, { matchLabels: pod?.metadata.labels });
    assert.deepEqual(networkPolicy.spec.ingress, [
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
        ports: [{ protocol: "TCP", port: 3099 }]
      }
    ]);
    const dnsEgress = networkPolicy.spec.egress.find(
      (rule) => hasNamespaceSelectorDestination(rule) && hasPort(rule, "UDP", 53)
    );
    const brokerEgress = networkPolicy.spec.egress.find(hasApiBrokerDestination);
    assert.ok(dnsEgress, "NetworkPolicy should preserve DNS UDP/53 egress");
    assert.deepEqual(dnsEgress.ports, [{ protocol: "UDP", port: 53 }]);
    assert.ok(brokerEgress, "NetworkPolicy should allow only the in-cluster API broker");
    assert.deepEqual(brokerEgress.ports, [{ protocol: "TCP", port: 3000 }]);
    assert.ok(
      networkPolicy.spec.egress.every(
        (rule) =>
          Array.isArray(rule.ports) &&
          rule.ports.length > 0 &&
          rule.ports.every(
            (port) => (port.protocol === "UDP" && port.port === 53) || (port.protocol === "TCP" && port.port === 3000)
          )
      ),
      "NetworkPolicy egress should stay limited to DNS and API broker TCP/3000"
    );
    assert.deepEqual(secret?.stringData, {
      BOTIFIED_SERVICE_KEY: "<redacted-generated-per-task>",
      "AGENTS.md": "<generated-by-api>"
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

  it("always routes model egress only through the in-cluster API broker", () => {
    const input = {
      namespace: "agentsmith-lite-e2e",
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
    };

    const rendered = renderSandboxResources(input);

    const networkPolicy = rendered.resources.find((resource) => resource.kind === "NetworkPolicy") as
      | NetworkPolicyResource
      | undefined;
    assert.ok(networkPolicy);
    const brokerEgress = networkPolicy.spec.egress.find(hasApiBrokerDestination);
    assert.ok(brokerEgress, "NetworkPolicy should allow API broker pods");
    assert.deepEqual(brokerEgress.ports, [{ protocol: "TCP", port: 3000 }]);
    assert.equal(
      networkPolicy.spec.egress.some((rule) => hasUnscopedDestination(rule) && hasPort(rule, "TCP", 443)),
      false,
      "brokered sandboxes should not keep the unscoped external TCP/443 rule"
    );
  });

  it("mounts an optional model CA ConfigMap read-only without relaxing sandbox egress", () => {
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
      memoryLimit: "1Gi",
      modelCa: {
        configMapName: "local-model-ca",
        configMapKey: "provider-ca.pem",
        path: "/etc/agentsmith-lite/model-ca/ca.crt"
      }
    });

    const pod = rendered.resources.find((resource) => resource.kind === "Pod") as PodResource | undefined;
    const container = pod?.spec.containers[0];
    assert.ok(container);
    assert.ok(
      container.volumeMounts.some(
        (mount) => mount.name === "model-ca" && mount.mountPath === "/etc/agentsmith-lite/model-ca/ca.crt" && mount.subPath === "ca.crt" && mount.readOnly === true
      )
    );
    assert.ok(
      pod?.spec.volumes.some(
        (volume) =>
          volume.name === "model-ca" &&
          volume.configMap?.name === "local-model-ca" &&
          volume.configMap.items?.[0]?.key === "provider-ca.pem" &&
          volume.configMap.items?.[0]?.path === "ca.crt"
      )
    );

    const networkPolicy = rendered.resources.find((resource) => resource.kind === "NetworkPolicy") as
      | NetworkPolicyResource
      | undefined;
    assert.ok(networkPolicy);
    assert.ok(
      networkPolicy.spec.egress.every(
        (rule) =>
          Array.isArray(rule.ports) &&
          rule.ports.length > 0 &&
          rule.ports.every(
            (port) => (port.protocol === "UDP" && port.port === 53) || (port.protocol === "TCP" && port.port === 3000)
          )
      )
    );
    assert.doesNotMatch(JSON.stringify(rendered.resources), /BEGIN CERTIFICATE|sk-real-model-key/);
  });
});

interface PodResource extends KubernetesResource {
  spec: {
    serviceAccountName: string;
    automountServiceAccountToken: boolean;
    hostNetwork: boolean;
    shareProcessNamespace: boolean;
    securityContext: { runAsNonRoot: boolean; runAsUser: number; runAsGroup: number; fsGroup: number };
    containers: Array<{
      name: string;
      workingDir: string;
      resources: {
        requests: { cpu: string; memory: string };
        limits: { cpu: string; memory: string };
      };
      securityContext: {
        allowPrivilegeEscalation: boolean;
        runAsUser?: number;
        privileged?: boolean;
        capabilities: { drop: string[] };
      };
      env: Array<{
        name: string;
        value?: string;
        valueFrom?: {
          secretKeyRef?: {
            name?: string;
          };
        };
      }>;
      readinessProbe: unknown;
      volumeMounts: Array<{ name: string; mountPath: string; subPath: string; readOnly?: boolean }>;
    }>;
    volumes: Array<{
      name: string;
      configMap?: {
        name: string;
        items?: Array<{ key: string; path: string }>;
      };
      secret?: {
        secretName: string;
      };
    }>;
  };
}

interface ServiceAccountResource extends KubernetesResource {
  automountServiceAccountToken: boolean;
}

interface SecretResource extends KubernetesResource {
  stringData: Record<string, string>;
}

interface ServiceResource extends KubernetesResource {
  spec: {
    selector: Record<string, string>;
    ports: Array<{ name: string; port: number; targetPort: string }>;
  };
}

interface NetworkPolicyResource extends KubernetesResource {
  spec: {
    podSelector: { matchLabels: Record<string, string> };
    ingress: NetworkPolicyIngressRule[];
    egress: NetworkPolicyEgressRule[];
  };
}

interface NetworkPolicyIngressRule {
  from?: Array<{
    podSelector?: Record<string, unknown>;
  }>;
  ports?: Array<{ protocol: string; port: number }>;
}

interface NetworkPolicyEgressRule {
  to?: Array<{
    namespaceSelector?: Record<string, unknown>;
    podSelector?: Record<string, unknown>;
    ipBlock?: Record<string, unknown>;
  }>;
  ports?: Array<{ protocol: string; port: number }>;
}

function hasPort(rule: NetworkPolicyEgressRule, protocol: string, port: number): boolean {
  return rule.ports?.some((candidate) => candidate.protocol === protocol && candidate.port === port) ?? false;
}

function hasNamespaceSelectorDestination(rule: NetworkPolicyEgressRule): boolean {
  return (
    rule.to?.some(
      (destination) =>
        destination.namespaceSelector !== undefined && Object.keys(destination.namespaceSelector).length === 0
    ) ?? false
  );
}

function hasUnscopedDestination(rule: NetworkPolicyEgressRule): boolean {
  return rule.to === undefined || rule.to.length === 0;
}

function hasApiBrokerDestination(rule: NetworkPolicyEgressRule): boolean {
  return (
    rule.to?.some(
      (destination) =>
        JSON.stringify(destination.podSelector) ===
          JSON.stringify({ matchLabels: {
            "app.kubernetes.io/component": "api",
            "agentsmith-lite/managed-by": "agentsmith-lite"
          } })
    ) ?? false
  );
}

function assertDnsLabel(name: string): void {
  assert.match(name, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, `${name} should be a DNS label`);
  assert.ok(name.length <= 63, `${name} should fit in a DNS label`);
  assert.equal(name.includes("_"), false, `${name} should not contain underscores`);
}
