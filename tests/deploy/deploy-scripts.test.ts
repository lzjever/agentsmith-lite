import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

describe("deploy status/down scripts", () => {
  it("operator-sandbox.mjs sends API auth and formats cleanup plan targets", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-helper-api-"));
    const cookieFile = path.join(tempDir, "cookie.txt");
    writeFileSync(cookieFile, "asl_session=test-session\n");
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      cookie: string | undefined;
      csrf: string | undefined;
      body: string;
    }> = [];
    const server = createServer(async (req, res) => {
      const body = await readRequestBody(req);
      requests.push({
        method: req.method,
        url: req.url,
        cookie: req.headers.cookie,
        csrf: req.headers["x-csrf-token"]?.toString(),
        body
      });
      res.setHeader("content-type", "application/json");
      const applyCleanup = body ? JSON.parse(body).apply === true : false;
      res.end(JSON.stringify(operatorSandboxResponse(req.url === "/api/operator/sandbox/reap" && !applyCleanup)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const status = await runNode([
        "scripts/deploy/operator-sandbox.mjs",
        "status",
        "--base-url",
        baseUrl,
        "--cookie-file",
        cookieFile
      ]);
      assert.equal(status.status, 0, status.stderr);
      assert.match(status.stdout, /Active task count: 1/);
      assert.match(status.stdout, /would delete Pod\/asl-task-1/);
      assert.match(status.stdout, /would delete runtime dir home for run1/);
      assert.match(status.stdout, /Recent cleanup failures:/);
      assert.match(status.stdout, /previous cleanup failed/);

      const scopedStatus = await runNode([
        "scripts/deploy/operator-sandbox.mjs",
        "status",
        "--base-url",
        baseUrl,
        "--cookie-file",
        cookieFile,
        "--run-id",
        "run1"
      ]);
      assert.equal(scopedStatus.status, 0, scopedStatus.stderr);
      assert.match(scopedStatus.stdout, /Sandbox operator status/);
      assert.match(scopedStatus.stdout, /Active task count: 1/);
      assert.match(scopedStatus.stdout, /would store run run1/);

      const defaultReap = await runNode([
        "scripts/deploy/operator-sandbox.mjs",
        "reap",
        "--base-url",
        baseUrl,
        "--cookie-file",
        cookieFile,
        "--csrf-token",
        "csrf-default"
      ]);
      assert.equal(defaultReap.status, 0, defaultReap.stderr);
      assert.match(defaultReap.stdout, /Sandbox cleanup dry-run/);
      assert.match(defaultReap.stdout, /Dry-run: true/);

      const reap = await runNode([
        "scripts/deploy/operator-sandbox.mjs",
        "reap",
        "--dry-run",
        "--base-url",
        baseUrl,
        "--cookie-file",
        cookieFile,
        "--csrf-token",
        "csrf-test",
        "--run-id",
        "run1"
      ]);
      assert.equal(reap.status, 0, reap.stderr);
      assert.match(reap.stdout, /Sandbox cleanup dry-run/);
      assert.match(reap.stdout, /Dry-run: true/);
      assert.match(reap.stdout, /would store run run1/);
      assert.match(reap.stdout, /would retain artifacts for run1/);

      const apply = await runNode([
        "scripts/deploy/operator-sandbox.mjs",
        "reap",
        "--apply",
        "--base-url",
        baseUrl,
        "--cookie-file",
        cookieFile,
        "--csrf-token",
        "csrf-apply",
        "--run-id",
        "run1"
      ]);
      assert.equal(apply.status, 0, apply.stderr);
      assert.match(apply.stdout, /Sandbox cleanup apply/);
      assert.match(apply.stdout, /Dry-run: false/);
      assert.match(apply.stdout, /would store run run1/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    assert.deepEqual(requests.map((request) => [request.method, request.url]), [
      ["GET", "/api/operator/sandbox/status"],
      ["GET", "/api/operator/sandbox/status?runId=run1"],
      ["POST", "/api/operator/sandbox/reap"],
      ["POST", "/api/operator/sandbox/reap"],
      ["POST", "/api/operator/sandbox/reap"]
    ]);
    assert.equal(requests[0]?.cookie, "asl_session=test-session");
    assert.equal(requests[0]?.body, "");
    assert.equal(requests[1]?.cookie, "asl_session=test-session");
    assert.equal(requests[1]?.body, "");
    assert.equal(requests[2]?.cookie, "asl_session=test-session");
    assert.equal(requests[2]?.csrf, "csrf-default");
    assert.deepEqual(JSON.parse(requests[2]?.body ?? ""), {});
    assert.equal(requests[3]?.cookie, "asl_session=test-session");
    assert.equal(requests[3]?.csrf, "csrf-test");
    assert.deepEqual(JSON.parse(requests[3]?.body ?? ""), { runId: "run1" });
    assert.equal(requests[4]?.cookie, "asl_session=test-session");
    assert.equal(requests[4]?.csrf, "csrf-apply");
    assert.deepEqual(JSON.parse(requests[4]?.body ?? ""), { apply: true, runId: "run1" });
  });

  it("operator-sandbox.mjs rejects reap dry-run and apply together", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-helper-flags-"));
    const cookieFile = path.join(tempDir, "cookie.txt");
    writeFileSync(cookieFile, "asl_session=test-session\n");

    const result = await runNode([
      "scripts/deploy/operator-sandbox.mjs",
      "reap",
      "--dry-run",
      "--apply",
      "--base-url",
      "http://127.0.0.1:1",
      "--cookie-file",
      cookieFile,
      "--csrf-token",
      "csrf-test"
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--dry-run and --apply cannot be used together/);
  });

  it("status.sh --resources requires API auth instead of falling back to kubectl-only status", () => {
    const result = spawnSync("bash", ["scripts/deploy/status.sh", "--resources", "--base-url", "http://127.0.0.1:3000"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--cookie-file/);
    assert.match(result.stderr, /operator sandbox API auth/);
  });

  it("status.sh rejects --run-id without a value", () => {
    const cases = [
      ["--resources", "--run-id"],
      ["--resources", "--run-id", "--csrf-token", "csrf-test"]
    ];

    for (const args of cases) {
      const result = spawnSync("bash", ["scripts/deploy/status.sh", ...args], {
        cwd: process.cwd(),
        encoding: "utf8"
      });

      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /--run-id requires a value/);
      assert.doesNotMatch(result.stderr, /unbound variable|unknown argument/);
    }
  });

  it("status.sh --resources calls the operator sandbox API helper with env base URL and auth", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-status-api-"));
    const envFile = path.join(tempDir, "deploy.env");
    const cookieFile = path.join(tempDir, "cookie.txt");
    const fakeNode = path.join(tempDir, "node");
    const callsFile = path.join(tempDir, "node-calls.txt");
    writeFileSync(envFile, "APP_PUBLIC_BASE_URL=http://operator.example.test\nKUBE_NAMESPACE=agentsmith-preview\n");
    writeFileSync(cookieFile, "asl_session=test-session\n");
    writeFileSync(fakeNode, `#!/usr/bin/env bash
printf '%s\\n' "$*" > "$FAKE_NODE_CALLS"
cat <<'OUT'
Sandbox operator status
Active task count: 1
Run counts:
Observed resource counts:
Cleanup targets:
- would delete Pod/asl-task-1
Runtime directories:
- would delete runtime dir home for run1
Recent cleanup failures:
- run1 runtime_directory:home previous cleanup failed
OUT
`);
    chmodSync(fakeNode, 0o755);

    const result = spawnSync("bash", [
      "scripts/deploy/status.sh",
      "--env",
      envFile,
      "--resources",
      "--cookie-file",
      cookieFile,
      "--csrf-token",
      "csrf-test",
      "--run-id",
      "run1"
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        FAKE_NODE_CALLS: callsFile,
        AGENTSMITH_LITE_ENV_CONTRACT_NODE: process.execPath
      }
    });

    assert.equal(result.status, 0, result.stderr);
    const helperArgs = readFileSync(callsFile, "utf8");
    assert.match(helperArgs, /scripts\/deploy\/operator-sandbox\.mjs status/);
    assert.match(helperArgs, /--base-url http:\/\/operator\.example\.test/);
    assert.match(helperArgs, new RegExp(`--cookie-file ${escapeRegExp(cookieFile)}`));
    assert.match(helperArgs, /--csrf-token csrf-test/);
    assert.match(helperArgs, /--run-id run1/);
    assert.match(result.stdout, /Active task count: 1/);
    assert.match(result.stdout, /Cleanup targets:/);
    assert.match(result.stdout, /Runtime directories:/);
    assert.match(result.stdout, /Recent cleanup failures:/);
  });

  it("status.sh queries Ingress with the app-owned label scope", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-status-"));
    const envFile = path.join(tempDir, "deploy.env");
    const fakeKubectl = path.join(tempDir, "kubectl");
    writeFileSync(envFile, [
      "KUBECONFIG_PATH=/tmp/agentsmith.kubeconfig",
      "KUBE_CONTEXT=kind-agentsmith",
      "KUBE_NAMESPACE=agentsmith-preview",
      ""
    ].join("\n"));
    writeFileSync(fakeKubectl, "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\"\n");
    chmodSync(fakeKubectl, 0o755);

    const result = spawnSync("bash", ["scripts/deploy/status.sh", "--env", envFile], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH ?? ""}`
      }
    });

    assert.equal(result.status, 0, result.stderr);
    const args = result.stdout.trim().split("\n");
    assert.deepEqual(args.slice(0, 4), ["--kubeconfig", "/tmp/agentsmith.kubeconfig", "--context", "kind-agentsmith"]);
    const getIndex = args.indexOf("get");
    assert.notEqual(getIndex, -1, result.stdout);
    assert.equal(args[getIndex + 1]?.includes("ingress"), true, result.stdout);
    assert.equal(args.includes("-n"), true, result.stdout);
    assert.equal(args.includes("agentsmith-preview"), true, result.stdout);
    assert.equal(args.includes("-l"), true, result.stdout);
    assert.equal(args.includes("agentsmith-lite/managed-by=agentsmith-lite"), true, result.stdout);
  });

  it("cleanup-stuck-tasks.sh --dry-run calls the operator sandbox API helper without kubectl delete", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-cleanup-api-"));
    const envFile = path.join(tempDir, "deploy.env");
    const cookieFile = path.join(tempDir, "cookie.txt");
    const fakeNode = path.join(tempDir, "node");
    const fakeKubectl = path.join(tempDir, "kubectl");
    const callsFile = path.join(tempDir, "node-calls.txt");
    const kubectlCalls = path.join(tempDir, "kubectl-calls.txt");
    writeFileSync(envFile, "APP_PUBLIC_BASE_URL=http://operator.example.test\n");
    writeFileSync(cookieFile, "asl_session=test-session\n");
    writeFileSync(fakeNode, `#!/usr/bin/env bash
printf '%s\\n' "$*" > "$FAKE_NODE_CALLS"
cat <<'OUT'
Sandbox cleanup dry-run
Cleanup targets:
- would delete Pod/asl-task-1
- would mark Service/asl-task-1 cleanup pending
- would store run run1 as cleaned
Runtime directories:
- would delete runtime dir home for run1
- would retain artifacts for run1
OUT
`);
    writeFileSync(fakeKubectl, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_KUBECTL_CALLS"
if [ "$1" = "delete" ]; then exit 19; fi
`);
    chmodSync(fakeNode, 0o755);
    chmodSync(fakeKubectl, 0o755);

    const result = spawnSync("bash", [
      "scripts/deploy/cleanup-stuck-tasks.sh",
      "--env",
      envFile,
      "--dry-run",
      "--cookie-file",
      cookieFile,
      "--csrf-token",
      "csrf-test",
      "--run-id",
      "run1"
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        FAKE_NODE_CALLS: callsFile,
        FAKE_KUBECTL_CALLS: kubectlCalls,
        AGENTSMITH_LITE_ENV_CONTRACT_NODE: process.execPath
      }
    });

    assert.equal(result.status, 0, result.stderr);
    const helperArgs = readFileSync(callsFile, "utf8");
    assert.match(helperArgs, /scripts\/deploy\/operator-sandbox\.mjs reap/);
    assert.match(helperArgs, /--dry-run/);
    assert.match(helperArgs, /--run-id run1/);
    assert.match(result.stdout, /Sandbox cleanup dry-run/);
    assert.match(result.stdout, /would delete Pod\/asl-task-1/);
    assert.match(result.stdout, /would retain artifacts/);
    assert.throws(() => readFileSync(kubectlCalls, "utf8"), /ENOENT/);
  });

  it("cleanup-stuck-tasks.sh --apply calls the operator sandbox API helper without kubectl delete", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-cleanup-apply-api-"));
    const envFile = path.join(tempDir, "deploy.env");
    const cookieFile = path.join(tempDir, "cookie.txt");
    const fakeNode = path.join(tempDir, "node");
    const fakeKubectl = path.join(tempDir, "kubectl");
    const callsFile = path.join(tempDir, "node-calls.txt");
    const kubectlCalls = path.join(tempDir, "kubectl-calls.txt");
    writeFileSync(envFile, "APP_PUBLIC_BASE_URL=http://operator.example.test\n");
    writeFileSync(cookieFile, "asl_session=test-session\n");
    writeFileSync(fakeNode, `#!/usr/bin/env bash
printf '%s\\n' "$*" > "$FAKE_NODE_CALLS"
cat <<'OUT'
Sandbox cleanup apply
Dry-run: false
Cleanup targets:
- would delete Pod/asl-task-1
- would store run run1 as cleaned
Runtime directories:
- would delete runtime dir home for run1
OUT
`);
    writeFileSync(fakeKubectl, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_KUBECTL_CALLS"
if [ "$1" = "delete" ]; then exit 19; fi
`);
    chmodSync(fakeNode, 0o755);
    chmodSync(fakeKubectl, 0o755);

    const result = spawnSync("bash", [
      "scripts/deploy/cleanup-stuck-tasks.sh",
      "--env",
      envFile,
      "--apply",
      "--cookie-file",
      cookieFile,
      "--csrf-token",
      "csrf-test",
      "--run-id",
      "run1"
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        FAKE_NODE_CALLS: callsFile,
        FAKE_KUBECTL_CALLS: kubectlCalls,
        AGENTSMITH_LITE_ENV_CONTRACT_NODE: process.execPath
      }
    });

    assert.equal(result.status, 0, result.stderr);
    const helperArgs = readFileSync(callsFile, "utf8");
    assert.match(helperArgs, /scripts\/deploy\/operator-sandbox\.mjs reap/);
    assert.match(helperArgs, /--apply/);
    assert.doesNotMatch(helperArgs, /--dry-run/);
    assert.match(helperArgs, /--run-id run1/);
    assert.match(result.stdout, /Sandbox cleanup apply/);
    assert.match(result.stdout, /would delete Pod\/asl-task-1/);
    assert.throws(() => readFileSync(kubectlCalls, "utf8"), /ENOENT/);
  });

  it("down.sh dry-run deletes Ingress with the app-owned label scope", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-down-"));
    const envFile = path.join(tempDir, "deploy.env");
    writeFileSync(envFile, [
      "KUBECONFIG_PATH=/tmp/agentsmith.kubeconfig",
      "KUBE_CONTEXT=kind-agentsmith",
      "KUBE_NAMESPACE=agentsmith-preview",
      ""
    ].join("\n"));

    const result = spawnSync("bash", ["scripts/deploy/down.sh", "--env", envFile, "--dry-run"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /kubectl --kubeconfig \/tmp\/agentsmith\.kubeconfig --context kind-agentsmith/);
    assert.match(result.stdout, /agentsmith-preview/);
    assert.match(result.stdout, /delete/);
    assert.match(result.stdout, /ingress/);
    assert.match(result.stdout, /-l agentsmith-lite\/managed-by=agentsmith-lite/);
  });

  it("status.sh, cleanup-stuck-tasks.sh, and down.sh do not execute env file commands", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-deploy-no-source-"));
    const cookieFile = path.join(tempDir, "cookie.txt");
    const fakeKubectl = path.join(tempDir, "kubectl");
    const fakeNode = path.join(tempDir, "node");
    const nodeCalls = path.join(tempDir, "node-calls.txt");
    writeFileSync(cookieFile, "asl_session=test-session\n");
    writeFileSync(fakeKubectl, "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\"\n");
    writeFileSync(fakeNode, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_NODE_CALLS"
printf 'ok\\n'
`);
    chmodSync(fakeKubectl, 0o755);
    chmodSync(fakeNode, 0o755);

    const statusMarker = path.join(tempDir, "status-marker");
    const statusEnv = writeMaliciousEnv(tempDir, "status.env", statusMarker, "APP_PUBLIC_BASE_URL=http://operator.example.test");
    const status = spawnSync("bash", ["scripts/deploy/status.sh", "--env", statusEnv], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        AGENTSMITH_LITE_ENV_CONTRACT_NODE: process.execPath
      }
    });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(existsSync(statusMarker), false);

    const cleanupMarker = path.join(tempDir, "cleanup-marker");
    const cleanupEnv = writeMaliciousEnv(tempDir, "cleanup.env", cleanupMarker, "APP_PUBLIC_BASE_URL=http://operator.example.test");
    const cleanup = spawnSync("bash", [
      "scripts/deploy/cleanup-stuck-tasks.sh",
      "--env",
      cleanupEnv,
      "--dry-run",
      "--cookie-file",
      cookieFile,
      "--csrf-token",
      "csrf-test"
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        FAKE_NODE_CALLS: nodeCalls,
        AGENTSMITH_LITE_ENV_CONTRACT_NODE: process.execPath
      }
    });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(existsSync(cleanupMarker), false);

    const downMarker = path.join(tempDir, "down-marker");
    const downEnv = writeMaliciousEnv(tempDir, "down.env", downMarker, "KUBE_NAMESPACE=agentsmith-preview");
    const down = spawnSync("bash", ["scripts/deploy/down.sh", "--env", downEnv, "--dry-run"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        AGENTSMITH_LITE_ENV_CONTRACT_NODE: process.execPath
      }
    });
    assert.equal(down.status, 0, down.stderr);
    assert.equal(existsSync(downMarker), false);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeMaliciousEnv(tempDir: string, name: string, marker: string, extraLine: string): string {
  const envFile = path.join(tempDir, name);
  writeFileSync(envFile, [extraLine, `APP_INGRESS_CLASS=$(touch ${marker})`, ""].join("\n"));
  return envFile;
}

function runNode(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function operatorSandboxResponse(dryRun: boolean) {
  return {
    namespace: "agentsmith",
    activeTaskCount: 1,
    runCounts: {
      total: 1,
      active: 0,
      cleanupRequested: 1,
      deleting: 0,
      cleaned: 0,
      starting: 0,
      running: 0,
      stopping: 1,
      expired: 0
    },
    observedResourceCounts: {
      Pod: 1
    },
    cleanupPlan: {
      targets: [
        {
          type: "delete_resource",
          source: "kubernetes",
          runId: "run1",
          kind: "Pod",
          name: "asl-task-1"
        },
        {
          type: "store_run_state",
          source: "store",
          runId: "run1",
          reason: "cleanup_complete",
          phase: "cleaned",
          cleanupStatus: "cleaned"
        },
        {
          type: "runtime_directory",
          source: "runtime",
          runId: "run1",
          directory: "home",
          path: "/tmp/asl/task1/home",
          action: "delete",
          retention: "cleanup_candidate",
          reason: "runtime_cleanup_candidate"
        },
        {
          type: "runtime_directory",
          source: "runtime",
          runId: "run1",
          directory: "artifacts",
          path: "/tmp/asl/task1/artifacts",
          action: "retain",
          retention: "durable",
          reason: "durable_artifacts_retained"
        }
      ],
      recentFailures: [
        {
          runId: "run1",
          at: "2026-07-04T00:00:00.000Z",
          target: "runtime_directory:home",
          message: "previous cleanup failed"
        }
      ]
    },
    recentCleanupFailures: [
      {
        runId: "run1",
        at: "2026-07-04T00:00:00.000Z",
        target: "runtime_directory:home",
        message: "previous cleanup failed"
      }
    ],
    actionSummary: [],
    errors: [],
    dryRun,
    storedRunIds: []
  };
}
