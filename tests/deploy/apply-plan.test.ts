import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAppDeployPlan, formatKubectlCommand } from "../../packages/sandbox-controller/src/appDeployPlan.js";

describe("deploy apply plan", () => {
  it("completes the schema migration before applying API and web workloads", () => {
    const plan = createAppDeployPlan({
      out: "out/manifests",
      timeout: "180s",
      env: {
        KUBECONFIG_PATH: "/tmp/agentsmith.kubeconfig",
        KUBE_CONTEXT: "kind-agentsmith",
        KUBE_NAMESPACE: "agentsmith"
      }
    });

    assert.deepEqual(
      plan.map((command) => [command.executable, ...command.args]),
      [
        [
          "kubectl",
          "--kubeconfig",
          "/tmp/agentsmith.kubeconfig",
          "--context",
          "kind-agentsmith",
          "--namespace",
          "agentsmith",
          "delete",
          "job/agentsmith-lite-schema-bootstrap",
          "--ignore-not-found"
        ],
        [
          "kubectl",
          "--kubeconfig",
          "/tmp/agentsmith.kubeconfig",
          "--context",
          "kind-agentsmith",
          "--namespace",
          "agentsmith",
          "apply",
          "-f",
          "out/manifests",
          "--selector",
          "agentsmith-lite.io/deploy-phase=base"
        ],
        [
          "kubectl",
          "--kubeconfig",
          "/tmp/agentsmith.kubeconfig",
          "--context",
          "kind-agentsmith",
          "--namespace",
          "agentsmith",
          "apply",
          "-f",
          "out/manifests",
          "--selector",
          "agentsmith-lite.io/deploy-phase=migration"
        ],
        [
          "kubectl",
          "--kubeconfig",
          "/tmp/agentsmith.kubeconfig",
          "--context",
          "kind-agentsmith",
          "--namespace",
          "agentsmith",
          "wait",
          "--for=condition=complete",
          "job/agentsmith-lite-schema-bootstrap",
          "--timeout=180s"
        ],
        [
          "kubectl",
          "--kubeconfig",
          "/tmp/agentsmith.kubeconfig",
          "--context",
          "kind-agentsmith",
          "--namespace",
          "agentsmith",
          "apply",
          "-f",
          "out/manifests",
          "--selector",
          "agentsmith-lite.io/deploy-phase=workload"
        ],
        [
          "kubectl",
          "--kubeconfig",
          "/tmp/agentsmith.kubeconfig",
          "--context",
          "kind-agentsmith",
          "--namespace",
          "agentsmith",
          "rollout",
          "status",
          "deploy/agentsmith-lite-api",
          "--timeout=180s"
        ],
        [
          "kubectl",
          "--kubeconfig",
          "/tmp/agentsmith.kubeconfig",
          "--context",
          "kind-agentsmith",
          "--namespace",
          "agentsmith",
          "rollout",
          "status",
          "deploy/agentsmith-lite-web",
          "--timeout=180s"
        ]
      ]
    );
  });

  it("defaults kubectl commands to the rendered app namespace when KUBE_NAMESPACE is unset", () => {
    const plan = createAppDeployPlan({ out: "out/manifests", env: {} });

    assert.deepEqual(
      plan.map((command) => [command.executable, ...command.args]),
      [
        [
          "kubectl",
          "--namespace",
          "agentsmith",
          "delete",
          "job/agentsmith-lite-schema-bootstrap",
          "--ignore-not-found"
        ],
        [
          "kubectl", "--namespace", "agentsmith", "apply", "-f", "out/manifests",
          "--selector", "agentsmith-lite.io/deploy-phase=base"
        ],
        [
          "kubectl", "--namespace", "agentsmith", "apply", "-f", "out/manifests",
          "--selector", "agentsmith-lite.io/deploy-phase=migration"
        ],
        [
          "kubectl",
          "--namespace",
          "agentsmith",
          "wait",
          "--for=condition=complete",
          "job/agentsmith-lite-schema-bootstrap",
          "--timeout=300s"
        ],
        [
          "kubectl", "--namespace", "agentsmith", "apply", "-f", "out/manifests",
          "--selector", "agentsmith-lite.io/deploy-phase=workload"
        ],
        [
          "kubectl",
          "--namespace",
          "agentsmith",
          "rollout",
          "status",
          "deploy/agentsmith-lite-api",
          "--timeout=300s"
        ],
        [
          "kubectl",
          "--namespace",
          "agentsmith",
          "rollout",
          "status",
          "deploy/agentsmith-lite-web",
          "--timeout=300s"
        ]
      ]
    );
  });

  it("does not include forbidden kubectl surfaces in the apply plan", () => {
    const planText = createAppDeployPlan({
      out: "out/manifests",
      timeout: "120s",
      env: { KUBE_NAMESPACE: "agentsmith" }
    }).map(formatKubectlCommand).join("\n");

    for (const forbidden of [
      "watch",
      "pods/exec",
      "pods/log",
      "persistentvolumes",
      "persistentvolumeclaims",
      "storageclasses",
      "nodes",
      "namespaces",
      "clusterroles",
      "clusterrolebindings",
      "--all-namespaces"
    ]) {
      assert.equal(planText.includes(forbidden), false, `${forbidden} must not appear in deploy apply plan`);
    }
  });

});
