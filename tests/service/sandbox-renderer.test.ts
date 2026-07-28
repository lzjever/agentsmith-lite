import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KubernetesResource } from "../../packages/contracts/src/api.js";
import { renderSandboxResources, sandboxRuntimeConfigMapName } from "../../packages/sandbox-controller/src/manifestRenderer.js";
import {
  reconcileSandboxRuns,
  sandboxIdentityLabels,
  type SandboxRunState
} from "../../packages/sandbox-controller/src/reconciler.js";

describe("sandbox manifest renderer", () => {
  it("binds the Pod to the exact content-addressed immutable ConfigMap", () => {
    const configHash="sha256:4f2acbb10d";
    const configMapName=sandboxRuntimeConfigMapName("asl-task-t1-config",configHash);
    const rendered = renderSandboxResources({
      namespace: "agentsmith",
      workspaceId: "w1",
      projectId: "p1",
      taskId: "t1",
      runId: "r1",
      image: "example/botified-runner@sha256:abc",
      pvcName: "agentsmith-lite-files",
      projectSubPath: "workspaces/w1/projects/p1",
      fileLibraryRootSubPath: "libraries/library_one/home",
      botifiedPort: 3099,
      serviceKeySecretName: "botified-t1",
      cpuRequest: "250m",
      memoryRequest: "512Mi",
      cpuLimit: "1",
      memoryLimit: "1Gi",
      resourceNames:{
        configMap:configMapName
      }
    });

    assert.equal(configMapName,"asl-task-t1-config-4f2acbb10d");
    const configMap=rendered.resources.find((candidate)=>candidate.kind==="ConfigMap");
    const pod=rendered.resources.find((candidate)=>candidate.kind==="Pod");
    assert.ok(configMap&&pod);
    assert.equal(configMap.metadata.name,configMapName);
    assert.equal(configMap.metadata.annotations,undefined);
    assert.equal(configMap.immutable,true);
    const volumes=(pod.spec as {volumes:Array<{name:string;configMap?:{name:string}}>}).volumes;
    assert.equal(volumes.find((volume)=>volume.name==="botified-config")?.configMap?.name,configMapName);
    assert.equal((pod.spec as {restartPolicy:string}).restartPolicy,"Never");
  });

  it("fails the recorded Run for cleanup without recreating or adopting a missing or replaced Pod", () => {
    const run=sandboxRun({startupPodUid:"pod-uid-original"});
    const missing=reconcileSandboxRuns({
      namespace:run.namespace,
      desiredRuns:[run],
      observedResources:[],
      now:new Date(run.updatedAt)
    });
    assert.equal(
      missing.actions.some((action)=>action.type==="create_resource"&&action.kind==="Pod"),
      false
    );
    assert.equal(missing.errors.length,0);
    assert.equal(
      missing.actions.some((action)=>
        action.type==="store_run_state"&&action.run.state==="failed"&&
        action.run.releaseReason==="failed"&&action.run.releaseRequestedAt===run.updatedAt
      ),
      true
    );
    const missingFailed=missing.actions.find((action)=>action.type==="store_run_state"&&action.run.state==="failed");
    assert.ok(missingFailed?.type==="store_run_state");
    const missingCleanup=reconcileSandboxRuns({
      namespace:run.namespace,
      desiredRuns:[missingFailed.run],
      observedResources:[],
      now:new Date(run.updatedAt)
    });
    assert.equal(
      missingCleanup.actions.some((action)=>action.type==="store_run_state"&&action.reason==="cleanup_complete"),
      true
    );

    const replacedPod=renderSandboxResources({
      namespace:run.namespace,
      workspaceId:run.workspaceId,
      projectId:run.projectId,
      taskId:run.taskId,
      runId:run.runId,
      image:run.image,
      pvcName:run.pvcName,
      projectSubPath:run.projectSubPath,
      fileLibraryRootSubPath:run.fileLibraryRootSubPath,
      botifiedPort:run.botifiedPort,
      serviceKeySecretName:run.serviceKeySecretRef.name,
      cpuRequest:run.resourceLimits.cpuRequest,
      memoryRequest:run.resourceLimits.memoryRequest,
      cpuLimit:run.resourceLimits.cpuLimit,
      memoryLimit:run.resourceLimits.memoryLimit,
      resourceNames:run.resourceNames
    }).resources.find((resource)=>resource.kind==="Pod");
    assert.ok(replacedPod);
    replacedPod.metadata.uid="pod-uid-replacement";
    replacedPod.metadata.labels=sandboxIdentityLabels(run);

    const replaced=reconcileSandboxRuns({
      namespace:run.namespace,
      desiredRuns:[run],
      observedResources:[replacedPod],
      now:new Date(run.updatedAt)
    });
    assert.equal(
      replaced.actions.some((action)=>
        (action.type==="create_resource"||action.type==="adopt_resource")&&action.kind==="Pod"
      ),
      false
    );
    assert.equal(replaced.errors.length,0);
    assert.equal(
      replaced.actions.some((action)=>
        action.type==="store_run_state"&&action.run.state==="failed"&&
        action.run.releaseReason==="failed"
      ),
      true
    );
    const replacedFailed=replaced.actions.find((action)=>action.type==="store_run_state"&&action.run.state==="failed");
    assert.ok(replacedFailed?.type==="store_run_state");
    const replacementCleanup=reconcileSandboxRuns({
      namespace:run.namespace,
      desiredRuns:[replacedFailed.run],
      observedResources:[replacedPod],
      now:new Date(run.updatedAt)
    });
    assert.equal(
      replacementCleanup.actions.some((action)=>action.type==="delete_resource"&&action.kind==="Pod"),
      true
    );
    assert.equal(
      replacementCleanup.actions.some((action)=>
        (action.type==="create_resource"||action.type==="adopt_resource")&&action.kind==="Pod"
      ),
      false
    );
  });

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
      fileLibraryRootSubPath: "libraries/library-task/home",
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
      fileLibraryRootSubPath: "libraries/library_one/home",
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
    assert.deepEqual(pod?.spec.initContainers, [
      {
        name: "prepare-file-library",
        image: "example/botified-runner@sha256:abc",
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
            subPath: "workspaces/w1/projects/p1/libraries/library_one/home"
          }
        ]
      }
    ]);
    assert.deepEqual(pod?.spec.containers.map((candidate) => candidate.name), ["botified-server", "bash-executor"]);
    const container = pod?.spec.containers.find((candidate) => candidate.name === "botified-server");
    const executor = pod?.spec.containers.find((candidate) => candidate.name === "bash-executor");
    const libraryMount = container?.volumeMounts.find((mount) => mount.mountPath === "/workspace/task/home");
    const botifiedMount = container?.volumeMounts.find((mount) => mount.mountPath === "/workspace/task/botified");
    const instructionsMount = container?.volumeMounts.find((mount) => mount.mountPath === "/workspace/task/home/workspace/AGENTS.md");
    assert.ok(container);
    assert.ok(executor);
    assert.deepEqual(executor.ports, [{ name: "terminal", containerPort: 3110 }]);
    assert.deepEqual(executor.command, ["bash-executor", "--listen", "0.0.0.0:3110"]);
    assert.ok(libraryMount);
    assert.ok(botifiedMount);
    assert.deepEqual(instructionsMount, { name: "botified-instructions", mountPath: "/workspace/task/home/workspace/AGENTS.md", subPath: "AGENTS.md", readOnly: true });
    assert.equal(container.workingDir, "/workspace/task/home/workspace");
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
      },
      {
        name: "AGENTSMITH_LLM_BROKER_KEY",
        valueFrom: {
          secretKeyRef: {
            name: "botified-t1",
            key: "AGENTSMITH_LLM_BROKER_KEY"
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
    assert.equal(libraryMount.subPath, "workspaces/w1/projects/p1/libraries/library_one/home");
    assert.notEqual(libraryMount.readOnly, true);
    assert.equal(botifiedMount.subPath, "workspaces/w1/projects/p1/tasks/t1/botified");
    assert.notEqual(botifiedMount.readOnly, true);
    assert.equal(container.volumeMounts.filter((mount) => mount.name === "project-files").length, 2);
    assert.equal(executor.workingDir, "/workspace/task/home/workspace");
    assert.deepEqual(executor.env, [{ name: "HOME", value: "/workspace/task/home" }]);
    assert.equal(executor.securityContext.runAsUser, 10002);
    assert.deepEqual(executor.volumeMounts, [{ name: "project-files", mountPath: "/workspace/task/home", subPath: "workspaces/w1/projects/p1/libraries/library_one/home" }]);
    assert.equal(executor.volumeMounts.some((mount) => mount.mountPath === "/workspace/task/botified"), false);
    assert.equal(executor.volumeMounts.some((mount) => mount.name === "botified-instructions" || mount.mountPath === "/workspace/task/home/AGENTS.md"), false);
    assert.equal(executor.volumeMounts.some((mount) => mount.name === "botified-config" || mount.name === "model-ca"), false);
    assert.ok(service, "Service should be rendered");
    assert.deepEqual(service.spec.selector, pod?.metadata.labels);
    assert.deepEqual(service.spec.ports, [
      { name: "http", port: 3099, targetPort: "http" },
      { name: "terminal", port: 3110, targetPort: "terminal" }
    ]);
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
        ports: [
          { protocol: "TCP", port: 3099 },
          { protocol: "TCP", port: 3110 }
        ]
      }
    ]);
    const dnsEgress = networkPolicy.spec.egress.find(hasCoreDnsDestination);
    const brokerEgress = networkPolicy.spec.egress.find(hasApiBrokerDestination);
    assert.ok(dnsEgress, "NetworkPolicy should allow only kube-system CoreDNS");
    assert.deepEqual(dnsEgress.ports, [
      { protocol: "UDP", port: 53 },
      { protocol: "TCP", port: 53 }
    ]);
    assert.ok(brokerEgress, "NetworkPolicy should allow only the in-cluster API broker");
    assert.deepEqual(brokerEgress.ports, [{ protocol: "TCP", port: 3000 }]);
    assert.ok(
      networkPolicy.spec.egress.every(
        (rule) =>
          Array.isArray(rule.ports) &&
          rule.ports.length > 0 &&
          rule.ports.every(
            (port) => (
              ((port.protocol === "UDP" || port.protocol === "TCP") && port.port === 53) ||
              (port.protocol === "TCP" && port.port === 3000)
            )
          )
      ),
      "NetworkPolicy egress should stay limited to DNS and API broker TCP/3000"
    );
    assert.deepEqual(secret?.stringData, {
      BOTIFIED_SERVICE_KEY: "<redacted-generated-per-run>",
      AGENTSMITH_LLM_BROKER_KEY: "<redacted-generated-per-run>",
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
      fileLibraryRootSubPath: "libraries/library-t1/home",
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

  it("does not render provider CA material into a Run Pod", () => {
    const rendered = renderSandboxResources({
      namespace: "agentsmith",
      workspaceId: "w1",
      projectId: "p1",
      taskId: "t1",
      runId: "r1",
      image: "example/botified-runner@sha256:abc",
      pvcName: "agentsmith-lite-files",
      projectSubPath: "workspaces/w1/projects/p1",
      fileLibraryRootSubPath: "libraries/library-t1/home",
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
    } as Parameters<typeof renderSandboxResources>[0] & { modelCa: {
      configMapName: string;
      configMapKey: string;
      path: string;
    } });

    const pod = rendered.resources.find((resource) => resource.kind === "Pod") as PodResource | undefined;
    const container = pod?.spec.containers[0];
    assert.ok(container);
    assert.equal(container.volumeMounts.some((mount) => mount.name === "model-ca"), false);
    assert.equal(pod?.spec.volumes.some((volume) => volume.name === "model-ca"), false);

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
            (port) => (
              ((port.protocol === "UDP" || port.protocol === "TCP") && port.port === 53) ||
              (port.protocol === "TCP" && port.port === 3000)
            )
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
    initContainers: Array<{
      name: string;
      image: string;
      imagePullPolicy: string;
      command: string[];
      securityContext: {
        runAsNonRoot: boolean;
        runAsUser: number;
        runAsGroup: number;
        allowPrivilegeEscalation: boolean;
        readOnlyRootFilesystem: boolean;
        capabilities: { drop: string[]; add: string[] };
      };
      volumeMounts: Array<{ name: string; mountPath: string; subPath: string; readOnly?: boolean }>;
    }>;
    containers: Array<{
      name: string;
      workingDir: string;
      command?:string[];
      ports?:Array<{name:string;containerPort:number}>;
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

function hasCoreDnsDestination(rule: NetworkPolicyEgressRule): boolean {
  return (
    rule.to?.some(
      (destination) =>
        JSON.stringify(destination.namespaceSelector) ===
          JSON.stringify({ matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }) &&
        JSON.stringify(destination.podSelector) ===
          JSON.stringify({ matchLabels: { "k8s-app": "kube-dns" } })
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

function sandboxRun(overrides:Partial<SandboxRunState>={}):SandboxRunState{
  return{
    workspaceId:"w1",
    projectId:"p1",
    taskId:"t1",
    runId:"r1",
    namespace:"agentsmith",
    state:"starting",
    image:"example/botified-runner@sha256:abc",
    pvcName:"agentsmith-lite-files",
    projectSubPath:"workspaces/w1/projects/p1",
    fileLibraryRootSubPath:"libraries/library_one/home",
    fileLibraryId:"library_one",
    startedByUserId:"user-1",
    startedAt:null,
    botifiedPort:3099,
    resourceNames:{
      pod:"asl-task-t1",
      service:"asl-task-t1",
      configMap:"asl-task-t1-config-4f2acbb10d",
      secret:"asl-botified-t1",
      serviceAccount:"asl-task-t1",
      networkPolicy:"asl-task-t1"
    },
    serviceKeySecretRef:{name:"asl-botified-t1",key:"BOTIFIED_SERVICE_KEY"},
    directories:{libraryHome:"/workspace/task/home",botified:"/workspace/task/botified"},
    resourceLimits:{cpuRequest:"250m",memoryRequest:"512Mi",cpuLimit:"1",memoryLimit:"1Gi"},
    resourceSnapshot:{
      cpuRequestMillis:"250",
      memoryRequestBytes:"536870912",
      cpuLimitMillis:"1000",
      memoryLimitBytes:"1073741824"
    },
    failureCode:null,
    failureCause:null,
    fencingToken:1,
    cleanupClaimedAt:null,
    cleanupAttempts:0,
    lastCleanupAt:null,
    lastCleanupError:null,
    releaseReason:null,
    releaseRequestedAt:null,
    failedAt:null,
    releasedAt:null,
    createdAt:"2026-07-27T00:00:00.000Z",
    updatedAt:"2026-07-27T00:00:00.000Z",
    ...overrides
  };
}
