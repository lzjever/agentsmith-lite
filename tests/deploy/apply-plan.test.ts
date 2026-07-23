import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAppDeployPlan, formatKubectlCommand } from "../../packages/sandbox-controller/src/appDeployPlan.js";

describe("deploy apply plan", () => {
  it("stops API, migrates, then resumes workloads", () => {
    const plan = createAppDeployPlan({
      out: "out/manifests",
      timeout: "180s",
      env: {
        KUBECONFIG_PATH: "/tmp/agentsmith.kubeconfig",
        KUBE_CONTEXT: "kind-agentsmith",
        KUBE_NAMESPACE: "agentsmith"
      }
    });

    const commands=plan.map((command)=>command.args.slice(6));
    assert.deepEqual(commands.slice(0,7),[
      ["delete","deployment/agentsmith-lite-api","--ignore-not-found"],
      ["delete","pod","--selector=app.kubernetes.io/component=api","--ignore-not-found","--wait=true","--timeout=180s"],
      ["delete","job/agentsmith-lite-schema-bootstrap","--ignore-not-found"],
      ["apply","-f","out/manifests","--selector","agentsmith-lite.io/deploy-phase=base"],
      ["apply","-f","out/manifests","--selector","agentsmith-lite.io/deploy-phase=migration"],
      ["wait","--for=condition=complete","job/agentsmith-lite-schema-bootstrap","--timeout=180s"],
      ["apply","-f","out/manifests","--selector","agentsmith-lite.io/deploy-phase=workload"]
    ]);
    assert.deepEqual(commands.slice(-2),[
      ["rollout","status","deploy/agentsmith-lite-api","--timeout=180s"],
      ["rollout","status","deploy/agentsmith-lite-web","--timeout=180s"]
    ]);
    assert.ok(commands.findIndex((command)=>command[0]==="delete"&&command[1]==="deployment/agentsmith-lite-api") < commands.findIndex((command)=>command.some((arg)=>arg.endsWith("agentsmith-lite-schema-bootstrap"))));
  });

  it("uses clean-install-safe waiting deletes for the API Deployment and residual pods",()=>{
    const commands=createAppDeployPlan({out:"out/manifests",env:{}}).map((command)=>command.args.slice(2));
    assert.deepEqual(commands[0],["delete","deployment/agentsmith-lite-api","--ignore-not-found"]);
    assert.deepEqual(commands[1],["delete","pod","--selector=app.kubernetes.io/component=api","--ignore-not-found","--wait=true","--timeout=300s"]);
  });

  it("defaults kubectl commands to the rendered app namespace when KUBE_NAMESPACE is unset", () => {
    const plan = createAppDeployPlan({ out: "out/manifests", env: {} });

    assert.equal(plan.every((command)=>command.args.includes("--namespace")&&command.args.includes("agentsmith")),true);
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
