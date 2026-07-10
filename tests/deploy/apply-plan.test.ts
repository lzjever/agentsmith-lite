import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createAppDeployPlan, formatKubectlCommand } from "../../packages/sandbox-controller/src/appDeployPlan.js";

const appDigestRef = "agentsmith-lite/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const runnerDigestRef = "agentsmith-lite/botified-runner@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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
        "export KUBECONFIG_PATH='/tmp/agentsmith.kubeconfig'",
        "KUBE_CONTEXT=\"kind-agentsmith\"",
        "export KUBE_NAMESPACE='agentsmith'",
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
      "kubectl --kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith rollout restart deploy/agentsmith-lite-api",
      "kubectl --kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith rollout status deploy/agentsmith-lite-api --timeout=45s"
    ]);
  });

  it("restarts and waits for the API deployment after applying app config", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-apply-config-rollout-"));
    const envFile = path.join(tempDir, "deploy.env");
    const callsFile = path.join(tempDir, "kubectl-calls.log");
    writeFileSync(
      envFile,
      [
        "KUBECONFIG_PATH=/tmp/agentsmith.kubeconfig",
        "KUBE_CONTEXT=kind-agentsmith",
        "KUBE_NAMESPACE=agentsmith",
        ""
      ].join("\n")
    );
    writeFakeKubectl(tempDir, callsFile);

    const result = spawnSync("bash", ["scripts/deploy/apply.sh", "--env", envFile, "--out", "out/manifests", "--timeout", "45s"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH ?? ""}`
      }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(callsFile, "utf8").trim().split("\n"), [
      "--kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith delete job/agentsmith-lite-schema-bootstrap --ignore-not-found",
      "--kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith apply -f out/manifests",
      "--kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith wait --for=condition=complete job/agentsmith-lite-schema-bootstrap --timeout=45s",
      "--kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith rollout restart deploy/agentsmith-lite-api",
      "--kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith rollout status deploy/agentsmith-lite-api --timeout=45s"
    ]);
  });

  it("prints the dry-run plan from OIDC substrate env without requiring the secrets file", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-apply-plan-oidc-env-only-"));
    const envFile = path.join(tempDir, "substrate.env");
    writeFileSync(
      envFile,
      [
        "KUBECONFIG_PATH=/tmp/agentsmith.kubeconfig",
        "KUBE_CONTEXT=kind-agentsmith",
        "KUBE_NAMESPACE=agentsmith",
        "APP_PUBLIC_BASE_URL=https://agentsmith.example.test/app",
        "AUTH_MODE=oidc",
        "OIDC_ISSUER_URL=https://keycloak.example.test/realms/agentsmith",
        "OIDC_BACKCHANNEL_BASE_URL=http://keycloak.keycloak.svc.cluster.local/realms/agentsmith",
        "OIDC_CLIENT_ID=agentsmith-lite",
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
      "kubectl --kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith rollout restart deploy/agentsmith-lite-api",
      "kubectl --kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith rollout status deploy/agentsmith-lite-api --timeout=45s"
    ]);
  });

  it("validates --images-lock before dry-run and keeps the apply command order", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-apply-plan-lock-"));
    const envFile = path.join(tempDir, "deploy.env");
    const lockFile = path.join(tempDir, "images.lock");
    const outDir = path.join(tempDir, "manifests");
    mkdirSync(outDir);
    writeFileSync(
      envFile,
      [
        "export KUBECONFIG_PATH='/tmp/agentsmith.kubeconfig'",
        "KUBE_CONTEXT=\"kind-agentsmith\"",
        "export KUBE_NAMESPACE='agentsmith'",
        ""
      ].join("\n")
    );
    writeFileSync(lockFile, `${appDigestRef}\n${runnerDigestRef}\n`);
    writeFileSync(path.join(outDir, "all.yaml"), `image: ${appDigestRef}\nBOTIFIED_RUNNER_IMAGE: ${runnerDigestRef}\n`);
    const fakeKubectl = path.join(tempDir, "kubectl");
    writeFileSync(fakeKubectl, "#!/usr/bin/env bash\necho kubectl should not run >&2\nexit 99\n");
    chmodSync(fakeKubectl, 0o755);

    const result = spawnSync(
      "bash",
      ["scripts/deploy/apply.sh", "--env", envFile, "--out", outDir, "--timeout", "45s", "--images-lock", lockFile, "--dry-run"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${tempDir}:${process.env.PATH ?? ""}`
        }
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.stdout.trim().split("\n"), [
      "kubectl --kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith delete job/agentsmith-lite-schema-bootstrap --ignore-not-found",
      `kubectl --kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith apply -f ${outDir}`,
      "kubectl --kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith wait --for=condition=complete job/agentsmith-lite-schema-bootstrap --timeout=45s",
      "kubectl --kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith rollout restart deploy/agentsmith-lite-api",
      "kubectl --kubeconfig /tmp/agentsmith.kubeconfig --context kind-agentsmith --namespace agentsmith rollout status deploy/agentsmith-lite-api --timeout=45s"
    ]);
  });

  it("fails --images-lock dry-run check before kubectl when manifests do not match the lock", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-apply-plan-lock-mismatch-"));
    const lockFile = path.join(tempDir, "images.lock");
    const outDir = path.join(tempDir, "manifests");
    mkdirSync(outDir);
    writeFileSync(lockFile, `${appDigestRef}\n${runnerDigestRef}\n`);
    writeFileSync(path.join(outDir, "all.yaml"), "image: agentsmith-lite/app:dev\nBOTIFIED_RUNNER_IMAGE: agentsmith-lite/botified-runner:dev\n");
    const fakeKubectl = path.join(tempDir, "kubectl");
    writeFileSync(fakeKubectl, "#!/usr/bin/env bash\necho kubectl should not run >&2\nexit 99\n");
    chmodSync(fakeKubectl, 0o755);

    const result = spawnSync("bash", ["scripts/deploy/apply.sh", "--out", outDir, "--images-lock", lockFile, "--dry-run"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH ?? ""}`
      }
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /images\.lock|manifest.*lock|does not match/i);
    assert.doesNotMatch(result.stderr, /kubectl should not run/);
    assert.equal(result.stdout, "");
  });

  it("apply.sh fails closed on unknown env typos without leaking values", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-apply-plan-env-typo-"));
    const envFile = path.join(tempDir, "deploy.env");
    writeFileSync(envFile, "KUBE_NAMESPCE=DO_NOT_PRINT_NAMESPACE_TYPO\n");

    const result = spawnSync("bash", ["scripts/deploy/apply.sh", "--env", envFile, "--out", "out/manifests", "--dry-run"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /KUBE_NAMESPCE/);
    assert.doesNotMatch(result.stderr + result.stdout, /DO_NOT_PRINT_NAMESPACE_TYPO/);
  });
});

function writeFakeKubectl(tempDir: string, callsFile: string): void {
  const kubectl = path.join(tempDir, "kubectl");
  writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${callsFile}"
`);
  chmodSync(kubectl, 0o755);
}
