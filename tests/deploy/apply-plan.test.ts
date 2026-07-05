import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createAppDeployPlan, formatKubectlCommand } from "../../packages/sandbox-controller/src/appDeployPlan.js";

describe("deploy apply plan", () => {
  it("uses kubeconfig, context, and namespace env values in the readiness sequence", () => {
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
          "out/manifests"
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
          "rollout",
          "status",
          "deploy/agentsmith-lite-api",
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
        ["kubectl", "--namespace", "agentsmith", "apply", "-f", "out/manifests"],
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
          "kubectl",
          "--namespace",
          "agentsmith",
          "rollout",
          "status",
          "deploy/agentsmith-lite-api",
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

  it("prints the plan without executing kubectl during dry-run", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-apply-plan-"));
    const envFile = path.join(tempDir, "deploy.env");
    writeFileSync(
      envFile,
      [
        "KUBECONFIG_PATH=/tmp/agentsmith.kubeconfig",
        "KUBE_CONTEXT=kind-agentsmith",
        "KUBE_NAMESPACE=agentsmith",
        ""
      ].join("\n")
    );
    const fakeKubectl = path.join(tempDir, "kubectl");
    writeFileSync(fakeKubectl, "#!/usr/bin/env bash\necho kubectl should not run >&2\nexit 99\n");
    chmodSync(fakeKubectl, 0o755);

    const result = spawnSync("bash", ["scripts/deploy/apply.sh", "--env", envFile, "--out", "out/manifests", "--timeout", "45s", "--dry-run"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH ?? ""}`
      }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.stdout.trim().split("\n"), [
      "kubectl --kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith delete job/agentsmith-lite-schema-bootstrap --ignore-not-found",
      "kubectl --kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith apply -f out/manifests",
      "kubectl --kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith wait --for=condition=complete job/agentsmith-lite-schema-bootstrap --timeout=45s",
      "kubectl --kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith rollout status deploy/agentsmith-lite-api --timeout=45s"
    ]);
  });
});
