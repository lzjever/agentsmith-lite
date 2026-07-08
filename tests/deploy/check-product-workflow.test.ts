import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const workflowFilePath = "files/product-workflow-check.txt";
const workflowFileContent = "hello from deploy product workflow check\n";
const taskArtifactName = "agentsmith-lite-task-workflow.txt";
const taskMarker = "AGENTSMITH_LITE_TASK_WORKFLOW_MARKER";
const defaultRunnerImage = "registry.example.test/agentsmith/botified-runner@sha256:1111111111111111111111111111111111111111111111111111111111111111";
const defaultPvcClaimName = "agentsmith-lite-files";

describe("deploy product workflow check", () => {
  it("check-product-workflow.sh dispatches the product workflow check with overlay env", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-workflow-sh-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    const appEnvFile = path.join(tempDir, "app.env");
    const fakeNode = path.join(tempDir, "node");
    const callsFile = path.join(tempDir, "node-calls.txt");
    const adminPassword = "admin-secret-from-file";
    const envMarker = path.join(tempDir, "env-marker");
    const secretMarker = path.join(tempDir, "secret-marker");

    writeFileSync(envFile, [
      "APP_PUBLIC_BASE_URL=http://deploy.example.test",
      "AUTH_MODE=builtin_admin",
      "OIDC_ISSUER_URL=",
      "OIDC_CLIENT_ID=",
      `APP_INGRESS_CLASS=$(touch ${envMarker})`,
      ""
    ].join("\n"));
    writeFileSync(appEnvFile, [
      "PRODUCT_WORKFLOW_ENDPOINT_BASE_URL=https://models.env.test/v1",
      "PRODUCT_WORKFLOW_ENDPOINT_MODEL=env-model",
      "PRODUCT_WORKFLOW_ENDPOINT_SECRET_REF=secret/env",
      "PRODUCT_WORKFLOW_CHECK_TASK_ARTIFACT=true",
      "PRODUCT_WORKFLOW_CHECK_TASK_RECLAIM=true",
      "PRODUCT_WORKFLOW_CHECK_TASK_RECLAIM_REAP_APPLY=true",
      "PRODUCT_WORKFLOW_TASK_TIMEOUT_SECS=12",
      ""
    ].join("\n"));
    writeFileSync(secretsFile, [
      `BUILTIN_ADMIN_INITIAL_PASSWORD=${adminPassword}`,
      "OIDC_CLIENT_SECRET=",
      `S3_SECRET_KEY=$(touch ${secretMarker})`,
      ""
    ].join("\n"));
    writeFileSync(fakeNode, `#!/usr/bin/env bash
{
  printf 'args=%s\\n' "$*"
  printf 'admin_password=%s\\n' "$BUILTIN_ADMIN_INITIAL_PASSWORD"
  printf 'endpoint_base_url=%s\\n' "$PRODUCT_WORKFLOW_ENDPOINT_BASE_URL"
  printf 'task_artifact=%s\\n' "$PRODUCT_WORKFLOW_CHECK_TASK_ARTIFACT"
  printf 'task_reclaim=%s\\n' "$PRODUCT_WORKFLOW_CHECK_TASK_RECLAIM"
  printf 'task_reclaim_reap_apply=%s\\n' "$PRODUCT_WORKFLOW_CHECK_TASK_RECLAIM_REAP_APPLY"
  printf 'task_timeout=%s\\n' "$PRODUCT_WORKFLOW_TASK_TIMEOUT_SECS"
} > "$FAKE_NODE_CALLS"
printf '{"status":"ok"}\\n'
`);
    chmodSync(fakeNode, 0o755);

    const result = spawnSync("bash", [
      "scripts/deploy/check-product-workflow.sh",
      "--env",
      envFile,
      "--secrets",
      secretsFile,
      "--app-env",
      appEnvFile,
      "--check-task-reclaim",
      "--check-task-reclaim-reap-apply"
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
    assert.equal(existsSync(envMarker), false);
    assert.equal(existsSync(secretMarker), false);
    const call = readFileSync(callsFile, "utf8");
    assert.match(call, /args=scripts\/deploy\/check-product-workflow\.mjs --base-url http:\/\/deploy\.example\.test --check-task-reclaim --check-task-reclaim-reap-apply/);
    assert.match(call, new RegExp(`admin_password=${escapeRegExp(adminPassword)}`));
    assert.match(call, /endpoint_base_url=https:\/\/models\.env\.test\/v1/);
    assert.match(call, /task_artifact=true/);
    assert.match(call, /task_reclaim=true/);
    assert.match(call, /task_reclaim_reap_apply=true/);
    assert.match(call, /task_timeout=12/);
    assert.doesNotMatch(call, /--check-k8s-run-resources/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(escapeRegExp(adminPassword)));
  });

  it("check-product-workflow.sh dispatches OIDC workflow checks with explicit session input", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-workflow-sh-oidc-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    const cookieFile = path.join(tempDir, "admin.cookie");
    const fakeNode = path.join(tempDir, "node");
    const callsFile = path.join(tempDir, "node-calls.txt");

    writeFileSync(envFile, [
      "APP_PUBLIC_BASE_URL=http://deploy.example.test",
      "AUTH_MODE=oidc",
      "OIDC_ISSUER_URL=https://keycloak.example.test/realms/agentsmith",
      "OIDC_CLIENT_ID=agentsmith-lite",
      ""
    ].join("\n"));
    writeFileSync(secretsFile, [
      "OIDC_CLIENT_SECRET=oidc-client-secret",
      ""
    ].join("\n"));
    writeFileSync(cookieFile, "asl_session=session-from-oidc\n");
    writeFileSync(fakeNode, `#!/usr/bin/env bash
{
  printf 'args=%s\\n' "$*"
  printf 'admin_password=%s\\n' "\${BUILTIN_ADMIN_INITIAL_PASSWORD:-}"
} > "$FAKE_NODE_CALLS"
printf '{"status":"ok"}\\n'
`);
    chmodSync(fakeNode, 0o755);

    const result = spawnSync("bash", [
      "scripts/deploy/check-product-workflow.sh",
      "--env",
      envFile,
      "--secrets",
      secretsFile,
      "--cookie-file",
      cookieFile,
      "--csrf-token",
      "csrf-from-oidc"
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
    const call = readFileSync(callsFile, "utf8");
    assert.match(call, /args=scripts\/deploy\/check-product-workflow\.mjs --base-url http:\/\/deploy\.example\.test --cookie-file .*admin\.cookie --csrf-token csrf-from-oidc/);
    assert.match(call, /admin_password=\n/);
    assert.doesNotMatch(result.stdout + result.stderr + call, /oidc-client-secret/);
  });

  it("check-product-workflow.sh scrubs parent substrate-only generated secrets before dispatch", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-workflow-sh-parent-env-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    const cookieFile = path.join(tempDir, "admin.cookie");
    const fakeNode = path.join(tempDir, "node");
    const callsFile = path.join(tempDir, "node-calls.txt");

    writeFileSync(envFile, [
      "APP_PUBLIC_BASE_URL=http://deploy.example.test",
      "AUTH_MODE=oidc",
      "OIDC_ISSUER_URL=https://keycloak.example.test/realms/agentsmith",
      "OIDC_CLIENT_ID=agentsmith-lite",
      ""
    ].join("\n"));
    writeFileSync(secretsFile, [
      "OIDC_CLIENT_SECRET=oidc-client-secret-from-file",
      ""
    ].join("\n"));
    writeFileSync(cookieFile, "asl_session=session-from-oidc\n");
    writeFileSync(fakeNode, `#!/usr/bin/env bash
{
  printf 'args=%s\\n' "$*"
  printf 'keycloak_admin_password=%s\\n' "\${KEYCLOAK_ADMIN_PASSWORD:-}"
  printf 'keycloak_db_password=%s\\n' "\${KEYCLOAK_DB_PASSWORD:-}"
  printf 'keycloak_extra_generated_secret=%s\\n' "\${KEYCLOAK_EXTRA_GENERATED_SECRET:-}"
  printf 'oidc_bootstrap_username=%s\\n' "\${OIDC_BOOTSTRAP_USERNAME:-}"
  printf 'oidc_bootstrap_password=%s\\n' "\${OIDC_BOOTSTRAP_PASSWORD:-}"
  printf 'oidc_issuer_url=%s\\n' "\${OIDC_ISSUER_URL:-}"
  printf 'oidc_client_id=%s\\n' "\${OIDC_CLIENT_ID:-}"
  printf 'oidc_client_secret=%s\\n' "\${OIDC_CLIENT_SECRET:-}"
} > "$FAKE_NODE_CALLS"
printf '{"status":"ok"}\\n'
`);
    chmodSync(fakeNode, 0o755);

    const result = spawnSync("bash", [
      "scripts/deploy/check-product-workflow.sh",
      "--env",
      envFile,
      "--secrets",
      secretsFile,
      "--cookie-file",
      cookieFile,
      "--csrf-token",
      "csrf-from-oidc"
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        PATH: `${tempDir}:/usr/bin:/bin`,
        FAKE_NODE_CALLS: callsFile,
        AGENTSMITH_LITE_ENV_CONTRACT_NODE: process.execPath,
        KEYCLOAK_ADMIN_PASSWORD: "DO_NOT_EXPORT_PARENT_KEYCLOAK_ADMIN_PASSWORD",
        KEYCLOAK_DB_PASSWORD: "DO_NOT_EXPORT_PARENT_KEYCLOAK_DB_PASSWORD",
        KEYCLOAK_EXTRA_GENERATED_SECRET: "DO_NOT_EXPORT_PARENT_KEYCLOAK_EXTRA",
        OIDC_BOOTSTRAP_USERNAME: "DO_NOT_EXPORT_PARENT_OIDC_BOOTSTRAP_USERNAME",
        OIDC_BOOTSTRAP_PASSWORD: "DO_NOT_EXPORT_PARENT_OIDC_BOOTSTRAP_PASSWORD"
      }
    });

    assert.equal(result.status, 0, result.stderr);
    const call = readFileSync(callsFile, "utf8");
    assert.match(call, /args=scripts\/deploy\/check-product-workflow\.mjs --base-url http:\/\/deploy\.example\.test --cookie-file .*admin\.cookie --csrf-token csrf-from-oidc/);
    assert.match(call, /keycloak_admin_password=\n/);
    assert.match(call, /keycloak_db_password=\n/);
    assert.match(call, /keycloak_extra_generated_secret=\n/);
    assert.match(call, /oidc_bootstrap_username=\n/);
    assert.match(call, /oidc_bootstrap_password=\n/);
    assert.match(call, /oidc_issuer_url=https:\/\/keycloak\.example\.test\/realms\/agentsmith/);
    assert.match(call, /oidc_client_id=agentsmith-lite/);
    assert.match(call, /oidc_client_secret=oidc-client-secret-from-file/);
    assert.doesNotMatch(result.stdout + result.stderr + call, /DO_NOT_EXPORT_PARENT_/);
  });

  it("check-product-workflow.sh rejects workflow overlay keys in substrate env without printing values", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-workflow-substrate-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    writeFileSync(
      envFile,
      "APP_PUBLIC_BASE_URL=http://deploy.example.test\nAUTH_MODE=builtin_admin\nOIDC_ISSUER_URL=\nOIDC_CLIENT_ID=\nPRODUCT_WORKFLOW_CHECK_TASK_ARTIFACT=DO_NOT_PRINT_WORKFLOW_FLAG\n"
    );
    writeFileSync(secretsFile, "BUILTIN_ADMIN_INITIAL_PASSWORD=admin-secret-from-file\nOIDC_CLIENT_SECRET=\n");

    const result = spawnSync("bash", ["scripts/deploy/check-product-workflow.sh", "--env", envFile, "--secrets", secretsFile], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        AGENTSMITH_LITE_ENV_CONTRACT_NODE: process.execPath
      }
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PRODUCT_WORKFLOW_CHECK_TASK_ARTIFACT/);
    assert.doesNotMatch(result.stderr + result.stdout, /DO_NOT_PRINT_WORKFLOW_FLAG/);
  });

  it("check-product-workflow.mjs exercises health, auth, project, endpoint, chat, files, and sandbox status", async () => {
    const adminPassword = "remote-admin-secret";
    const server = await startWorkflowServer({
      adminPassword,
      workspaceId: "workspace_1",
      projectId: "project_1",
      endpointId: "endpoint_1",
      endpointBaseUrl: "https://models.remote.test/v1",
      endpointModel: "remote-model",
      endpointSecretRef: "secret/remote-workflow"
    });

    try {
      const result = await runNode([
        "scripts/deploy/check-product-workflow.mjs",
        "--base-url",
        server.baseUrl,
        "--endpoint-base-url",
        "https://models.remote.test/v1",
        "--endpoint-model",
        "remote-model",
        "--endpoint-secret-ref",
        "secret/remote-workflow"
      ], {
        BUILTIN_ADMIN_INITIAL_PASSWORD: adminPassword
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const summary = JSON.parse(result.stdout) as ProductWorkflowSummary;
      assert.deepEqual(summary, {
        status: "ok",
        baseUrl: server.baseUrl,
        workspaceId: "workspace_1",
        projectId: "project_1",
        chat: { status: "completed" },
        task: { status: "skipped" }
      });
      assert.doesNotMatch(result.stdout, /secret\/remote-workflow/);
      assert.deepEqual(server.requests.map((request) => `${request.method} ${request.url}`), [
        "GET /api/health",
        "POST /api/auth/bootstrap",
        "POST /api/auth/login",
        "POST /api/workspaces",
        "POST /api/workspaces/workspace_1/projects",
        "POST /api/projects/project_1/endpoints",
        "POST /api/projects/project_1/chat",
        "POST /api/projects/project_1/files",
        "GET /api/projects/project_1/files?path=files",
        "GET /api/projects/project_1/files/download?path=files%2Fproduct-workflow-check.txt",
        "DELETE /api/projects/project_1/files",
        "GET /api/operator/sandbox/status"
      ]);
      for (const request of server.requests.slice(3)) {
        assert.equal(request.cookie, "asl_session=workflow-session", `${request.method} ${request.url} missing session cookie`);
        assert.equal(request.csrf, "csrf-workflow", `${request.method} ${request.url} missing csrf token`);
      }
    } finally {
      await server.close();
    }
  });

  it("check-product-workflow.mjs can use an explicit OIDC session without builtin bootstrap or login", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-workflow-mjs-oidc-"));
    const cookieFile = path.join(tempDir, "admin.cookie");
    writeFileSync(cookieFile, "asl_session=workflow-session\n");
    const server = await startWorkflowServer({
      adminPassword: "unused-admin-secret",
      workspaceId: "workspace_oidc",
      projectId: "project_oidc",
      endpointId: "endpoint_oidc",
      endpointBaseUrl: "https://models.oidc.test/v1",
      endpointModel: "oidc-model",
      endpointSecretRef: "secret/oidc-workflow"
    });

    try {
      const result = await runNode([
        "scripts/deploy/check-product-workflow.mjs",
        "--base-url",
        server.baseUrl,
        "--cookie-file",
        cookieFile,
        "--csrf-token",
        "csrf-workflow",
        "--endpoint-base-url",
        "https://models.oidc.test/v1",
        "--endpoint-model",
        "oidc-model",
        "--endpoint-secret-ref",
        "secret/oidc-workflow"
      ], {
        BUILTIN_ADMIN_INITIAL_PASSWORD: ""
      });

      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout) as ProductWorkflowSummary;
      assert.equal(summary.status, "ok");
      assert.equal(summary.workspaceId, "workspace_oidc");
      assert.deepEqual(server.requests.map((request) => `${request.method} ${request.url}`), [
        "GET /api/health",
        "POST /api/workspaces",
        "POST /api/workspaces/workspace_oidc/projects",
        "POST /api/projects/project_oidc/endpoints",
        "POST /api/projects/project_oidc/chat",
        "POST /api/projects/project_oidc/files",
        "GET /api/projects/project_oidc/files?path=files",
        "GET /api/projects/project_oidc/files/download?path=files%2Fproduct-workflow-check.txt",
        "DELETE /api/projects/project_oidc/files",
        "GET /api/operator/sandbox/status"
      ]);
      for (const request of server.requests.slice(1)) {
        assert.equal(request.cookie, "asl_session=workflow-session", `${request.method} ${request.url} missing session cookie`);
        assert.equal(request.csrf, "csrf-workflow", `${request.method} ${request.url} missing csrf token`);
      }
    } finally {
      await server.close();
    }
  });

  it("check-product-workflow.mjs verifies task artifacts and optional read-only K8s run resources", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-k8s-run-resources-"));
    const kubectlCalls = path.join(tempDir, "kubectl-calls.txt");
    const fakeKubectl = writeFakeKubectl(tempDir);
    const server = await startWorkflowServer({
      adminPassword: "task-admin-secret",
      workspaceId: "workspace_task",
      projectId: "project_task",
      endpointId: "endpoint_task",
      endpointBaseUrl: "https://models.task.test/v1",
      endpointModel: "task-model",
      endpointSecretRef: "secret/task-workflow",
      artifactTask: {
        taskId: "task_artifact",
        runId: "run_artifact",
        subPath: "workspaces/workspace_task/projects/project_task"
      }
    });

    try {
      const result = await runNode([
        "scripts/deploy/check-product-workflow.mjs",
        "--base-url",
        server.baseUrl,
        "--endpoint-base-url",
        "https://models.task.test/v1",
        "--endpoint-model",
        "task-model",
        "--endpoint-secret-ref",
        "secret/task-workflow",
        "--check-task-artifact",
        "--check-k8s-run-resources"
      ], {
        BUILTIN_ADMIN_INITIAL_PASSWORD: "task-admin-secret",
        KUBECTL_BIN: fakeKubectl,
        FAKE_KUBECTL_CALLS: kubectlCalls,
        KUBECONFIG_PATH: "/tmp/k8s-run-resources.kubeconfig",
        KUBE_CONTEXT: "kind-agentsmith",
        KUBE_NAMESPACE: "agentsmith-preview"
      });

      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout) as ProductWorkflowSummary;
      assert.equal(summary.task.status, "completed");
      assert.equal(summary.task.taskId, "task_artifact");
      assert.equal(summary.task.runId, "run_artifact");
      assert.equal(summary.task.artifactName, taskArtifactName);
      assert.equal(summary.task.markerObserved, true);
      assert.equal(summary.task.sandboxContract.runnerContainer, "botified-runner");
      assert.equal(summary.task.runScopedStatus.runId, "run_artifact");
      assert.deepEqual(summary.task.k8sRunResources.resources.Pod.names, ["asl-task-k8s"]);
      assert.doesNotMatch(result.stdout, /secret\/task-workflow|task-admin-secret|runtime accepted|AGENTSMITH_LITE_TASK_WORKFLOW_MARKER/);

      const calls = readFileSync(kubectlCalls, "utf8").trim().split("\n");
      assert.equal(calls.length, 6);
      for (const call of calls) {
        assert.match(call, /^--kubeconfig \/tmp\/k8s-run-resources\.kubeconfig --context kind-agentsmith get /);
        assert.match(call, / -n agentsmith-preview /);
        assert.match(call, / -l agentsmith-lite\/run-id=run_artifact /);
        assert.doesNotMatch(call, /\b(exec|logs|attach|port-forward|apply|delete|patch|create)\b/);
      }
    } finally {
      await server.close();
    }
  });

  it("check-product-workflow.mjs cancels and reaps only the returned run id for task reclaim apply", async () => {
    const server = await startWorkflowServer({
      adminPassword: "reclaim-admin-secret",
      workspaceId: "workspace_reclaim",
      projectId: "project_reclaim",
      endpointId: "endpoint_reclaim",
      endpointBaseUrl: "https://models.reclaim.test/v1",
      endpointModel: "reclaim-model",
      endpointSecretRef: "secret/reclaim-workflow",
      reclaimTask: {
        taskId: "task_reclaim",
        runId: "run_reclaim",
        subPath: "workspaces/workspace_reclaim/projects/project_reclaim"
      }
    });

    try {
      const result = await runNode([
        "scripts/deploy/check-product-workflow.mjs",
        "--base-url",
        server.baseUrl,
        "--endpoint-base-url",
        "https://models.reclaim.test/v1",
        "--endpoint-model",
        "reclaim-model",
        "--endpoint-secret-ref",
        "secret/reclaim-workflow",
        "--check-task-reclaim",
        "--check-task-reclaim-reap-apply"
      ], {
        BUILTIN_ADMIN_INITIAL_PASSWORD: "reclaim-admin-secret"
      });

      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout) as ProductWorkflowSummary;
      assert.equal(summary.task.status, "skipped");
      assert.equal(summary.taskReclaim.status, "completed");
      assert.equal(summary.taskReclaim.taskId, "task_reclaim");
      assert.equal(summary.taskReclaim.runId, "run_reclaim");
      assert.equal(summary.taskReclaim.reapScope.scopedToRunId, true);
      assert.equal(summary.taskReclaim.reapScope.applyEnabled, true);
      assert.deepEqual(server.requests.filter((request) => request.url === "/api/operator/sandbox/reap").map((request) => JSON.parse(request.body)), [
        { runId: "run_reclaim" },
        { runId: "run_reclaim", apply: true },
        { runId: "run_reclaim" }
      ]);
      assert.equal(server.requests.some((request) => request.body.includes('"apply":true') && !request.body.includes("run_reclaim")), false);
    } finally {
      await server.close();
    }
  });

  it("check-product-workflow.mjs validates task and K8s options before HTTP", async () => {
    let requestCount = 0;
    const server = createServer((_req, res) => {
      requestCount += 1;
      res.statusCode = 500;
      res.end("unexpected request");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const cases: Array<{
        args?: string[];
        env?: Record<string, string>;
        message: RegExp;
      }> = [
        {
          args: ["--check-k8s-run-resources"],
          env: { KUBE_NAMESPACE: "agentsmith-preview" },
          message: /k8s run resource check requires task artifact or task reclaim check/
        },
        {
          args: ["--check-task-artifact"],
          message: /task artifact check requires endpoint config/
        },
        {
          env: { PRODUCT_WORKFLOW_CHECK_TASK_ARTIFACT: "yes" },
          message: /PRODUCT_WORKFLOW_CHECK_TASK_ARTIFACT must be true, false, empty, or unset/
        },
        {
          env: { PRODUCT_WORKFLOW_CHECK_TASK_RECLAIM_REAP_APPLY: "true" },
          message: /task reclaim reap apply requires task reclaim check/
        }
      ];

      for (const testCase of cases) {
        const result = await runNode([
          "scripts/deploy/check-product-workflow.mjs",
          "--base-url",
          baseUrl,
          ...(testCase.args ?? [])
        ], {
          BUILTIN_ADMIN_INITIAL_PASSWORD: "admin-secret",
          ...(testCase.env ?? {})
        });

        assert.equal(result.status, 2, result.stderr);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, testCase.message);
      }
      assert.equal(requestCount, 0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

async function startWorkflowServer(options: WorkflowServerOptions): Promise<WorkflowServer> {
  const requests: WorkflowRequest[] = [];
  let reapCalls = 0;
  const server = createServer(async (req, res) => {
    const body = await readRequestBody(req);
    requests.push({
      method: req.method,
      url: req.url,
      cookie: req.headers.cookie,
      csrf: req.headers["x-csrf-token"]?.toString(),
      body
    });
    const parsedBody = body ? JSON.parse(body) as Record<string, unknown> : {};

    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/api/health") {
      res.end(JSON.stringify({ status: "ok", version: "test" }));
    } else if (req.method === "POST" && req.url === "/api/auth/bootstrap") {
      assert.deepEqual(parsedBody, { password: options.adminPassword });
      res.end(JSON.stringify({ created: true }));
    } else if (req.method === "POST" && req.url === "/api/auth/login") {
      assert.deepEqual(parsedBody, {
        email: "admin@agentsmith-lite.local",
        password: options.adminPassword
      });
      res.setHeader("set-cookie", "asl_session=workflow-session; HttpOnly; Path=/");
      res.end(JSON.stringify({ csrfToken: "csrf-workflow" }));
    } else if (req.method === "POST" && req.url === "/api/workspaces") {
      assert.deepEqual(parsedBody, { name: "Deploy Product Workflow" });
      res.end(JSON.stringify({ id: options.workspaceId, name: "Deploy Product Workflow" }));
    } else if (req.method === "POST" && req.url === `/api/workspaces/${options.workspaceId}/projects`) {
      assert.deepEqual(parsedBody, { name: "API Product Workflow" });
      res.end(JSON.stringify({ id: options.projectId, workspaceId: options.workspaceId, name: "API Product Workflow" }));
    } else if (req.method === "POST" && req.url === `/api/projects/${options.projectId}/endpoints`) {
      assert.deepEqual(parsedBody, {
        name: "Deploy Product Workflow Endpoint",
        protocol: "openai_chat_completions",
        baseUrl: options.endpointBaseUrl,
        model: options.endpointModel,
        apiKeySecretRef: options.endpointSecretRef,
        capabilities: ["text"],
        requestTimeoutSecs: 30
      });
      res.end(JSON.stringify({ id: options.endpointId }));
    } else if (req.method === "POST" && req.url === `/api/projects/${options.projectId}/chat`) {
      assert.deepEqual(parsedBody, {
        endpointId: options.endpointId,
        messages: [{ role: "user", content: "deploy product workflow" }]
      });
      res.end(JSON.stringify({ message: { role: "assistant", content: "ok" } }));
    } else if (req.method === "POST" && req.url === `/api/projects/${options.projectId}/files`) {
      assert.deepEqual(parsedBody, {
        path: workflowFilePath,
        content: workflowFileContent
      });
      res.end(JSON.stringify({ path: workflowFilePath, bytes: Buffer.byteLength(workflowFileContent) }));
    } else if (req.method === "GET" && req.url === `/api/projects/${options.projectId}/files?path=files`) {
      res.end(JSON.stringify({ entries: [{ path: workflowFilePath, type: "file" }] }));
    } else if (req.method === "GET" && req.url === `/api/projects/${options.projectId}/files/download?path=files%2Fproduct-workflow-check.txt`) {
      res.end(JSON.stringify({ path: workflowFilePath, content: workflowFileContent }));
    } else if (req.method === "DELETE" && req.url === `/api/projects/${options.projectId}/files`) {
      assert.deepEqual(parsedBody, { path: workflowFilePath });
      res.end(JSON.stringify({ deleted: true }));
    } else if (req.method === "GET" && req.url === "/api/operator/sandbox/status") {
      res.end(JSON.stringify({ namespace: "agentsmith", activeTaskCount: 0, runCounts: {}, observedResourceCounts: {} }));
    } else if (options.artifactTask && req.method === "GET" && req.url === `/api/operator/sandbox/status?runId=${options.artifactTask.runId}`) {
      res.end(JSON.stringify(statusResponse(options.artifactTask.runId, { activeTaskCount: 1, observedResourceCounts: { Pod: 1, Secret: 1 }, cleanupTargetCount: 2 })));
    } else if (options.reclaimTask && req.method === "GET" && req.url === `/api/operator/sandbox/status?runId=${options.reclaimTask.runId}`) {
      res.end(JSON.stringify(statusResponse(options.reclaimTask.runId, { activeTaskCount: 1, runCounts: { stopping: 1 }, observedResourceCounts: { Pod: 1 }, cleanupTargetCount: 1 })));
    } else if (req.method === "POST" && req.url === `/api/projects/${options.projectId}/tasks`) {
      assert.equal(parsedBody.endpointId, options.endpointId);
      assert.equal(typeof parsedBody.prompt, "string");
      assert.equal(JSON.stringify(parsedBody).includes(options.endpointSecretRef), false);
      if (options.artifactTask && (parsedBody.prompt as string).includes("publish_file")) {
        res.end(JSON.stringify(taskCreateResponse(options.artifactTask)));
      } else if (options.reclaimTask) {
        res.end(JSON.stringify(taskCreateResponse(options.reclaimTask)));
      } else {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "unexpected task create" }));
      }
    } else if (options.artifactTask && req.method === "GET" && req.url === `/api/tasks/${options.artifactTask.taskId}/events`) {
      res.end(JSON.stringify([{ id: "event_completed", taskId: options.artifactTask.taskId, kind: "turn_completed" }]));
    } else if (options.artifactTask && req.method === "GET" && req.url === `/api/tasks/${options.artifactTask.taskId}/artifacts`) {
      res.end(JSON.stringify([{ id: "artifact_task", taskId: options.artifactTask.taskId, fileId: "file_task", name: taskArtifactName, bytes: 51 }]));
    } else if (options.artifactTask && req.method === "GET" && req.url === `/api/tasks/${options.artifactTask.taskId}/artifacts/artifact_task/download`) {
      res.setHeader("content-type", "application/octet-stream");
      res.end(`runtime accepted\n${taskMarker}\n`);
    } else if (options.reclaimTask && req.method === "POST" && req.url === `/api/tasks/${options.reclaimTask.taskId}/cancel`) {
      assert.equal(body, "");
      res.end(JSON.stringify({ id: options.reclaimTask.taskId, runId: options.reclaimTask.runId, status: "stopping" }));
    } else if (req.method === "POST" && req.url === "/api/operator/sandbox/reap") {
      reapCalls += 1;
      assert.ok(options.reclaimTask, "reap should only run for reclaim task tests");
      if (reapCalls === 1) {
        assert.deepEqual(parsedBody, { runId: options.reclaimTask.runId });
        res.end(JSON.stringify(reapResponse(true, 2, 2, [])));
      } else if (reapCalls === 2) {
        assert.deepEqual(parsedBody, { runId: options.reclaimTask.runId, apply: true });
        res.end(JSON.stringify(reapResponse(false, 1, 1, [options.reclaimTask.runId])));
      } else {
        assert.deepEqual(parsedBody, { runId: options.reclaimTask.runId });
        res.end(JSON.stringify(reapResponse(true, 0, 0, [])));
      }
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `unexpected ${req.method} ${req.url}` }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function taskCreateResponse(task: WorkflowTaskFixture): unknown {
  return {
    id: task.taskId,
    runId: task.runId,
    status: "running",
    endpointId: "endpoint",
    sandbox: {
      resources: sandboxResources(task)
    }
  };
}

function sandboxResources(task: WorkflowTaskFixture): unknown[] {
  return [{
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: `asl-task-${task.taskId}`,
      labels: { "agentsmith-lite/run-id": task.runId }
    },
    spec: {
      containers: [{
        name: "botified-runner",
        image: defaultRunnerImage,
        volumeMounts: [{
          name: "project-files",
          mountPath: "/workspace/project",
          subPath: task.subPath
        }]
      }],
      volumes: [{
        name: "project-files",
        persistentVolumeClaim: { claimName: defaultPvcClaimName }
      }]
    }
  }];
}

function statusResponse(runId: string, overrides: Partial<{
  activeTaskCount: number;
  runCounts: Record<string, number>;
  observedResourceCounts: Record<string, number>;
  cleanupTargetCount: number;
}> = {}): unknown {
  return {
    namespace: "agentsmith",
    activeTaskCount: overrides.activeTaskCount ?? 0,
    runCounts: overrides.runCounts ?? { total: 1 },
    observedResourceCounts: overrides.observedResourceCounts ?? {},
    cleanupPlan: {
      targets: Array.from({ length: overrides.cleanupTargetCount ?? 0 }, (_, index) => ({
        type: "delete_resource",
        source: "kubernetes",
        runId,
        kind: "Pod",
        name: `asl-task-${index}`
      }))
    },
    errors: []
  };
}

function reapResponse(dryRun: boolean, actionCount: number, cleanupTargetCount: number, storedRunIds: string[]): unknown {
  return {
    namespace: "agentsmith",
    activeTaskCount: 1,
    runCounts: {},
    observedResourceCounts: {},
    cleanupPlan: {
      targets: Array.from({ length: cleanupTargetCount }, (_, index) => ({
        type: "delete_resource",
        source: "kubernetes",
        runId: "run_reclaim",
        kind: "Pod",
        name: `asl-task-${index}`
      }))
    },
    actionSummary: Array.from({ length: actionCount }, (_, index) => ({ type: "delete_resource", runId: "run_reclaim", name: `asl-task-${index}` })),
    errors: [],
    dryRun,
    storedRunIds
  };
}

function writeFakeKubectl(tempDir: string): string {
  const fakeKubectl = path.join(tempDir, "kubectl");
  writeFileSync(fakeKubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_KUBECTL_CALLS"
for arg in "$@"; do
  case "$arg" in
    exec|logs|attach|port-forward|apply|delete|patch|create)
      exit 88
      ;;
  esac
done
resource=
previous=
for arg in "$@"; do
  if [ "$previous" = "get" ]; then
    resource="$arg"
    break
  fi
  previous="$arg"
done
case "$resource" in
  pods)
    cat <<'JSON'
{"items":[{"metadata":{"name":"asl-task-k8s","labels":{"agentsmith-lite/run-id":"run_artifact"}},"status":{"phase":"Running","containerStatuses":[{"name":"botified-runner","ready":true,"image":"registry.example.test/agentsmith/botified-runner@sha256:1111111111111111111111111111111111111111111111111111111111111111","imageID":"docker-pullable://registry.example.test/agentsmith/botified-runner@sha256:1111111111111111111111111111111111111111111111111111111111111111"}]},"spec":{"containers":[{"name":"botified-runner","image":"registry.example.test/agentsmith/botified-runner@sha256:1111111111111111111111111111111111111111111111111111111111111111","volumeMounts":[{"name":"project-files","mountPath":"/workspace/project","subPath":"workspaces/workspace_task/projects/project_task"}]}],"volumes":[{"name":"project-files","persistentVolumeClaim":{"claimName":"agentsmith-lite-files"}}]}}]}
JSON
    ;;
  secrets) printf 'secret/asl-task-secret\\n' ;;
  configmaps) printf 'configmap/asl-task-config\\n' ;;
  serviceaccounts) printf 'serviceaccount/asl-task-service-account\\n' ;;
  services) printf 'service/asl-task-service\\n' ;;
  networkpolicies) printf 'networkpolicy/asl-task-network\\n' ;;
  *) exit 65 ;;
esac
`);
  chmodSync(fakeKubectl, 0o755);
  return fakeKubectl;
}

function runNode(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PRODUCT_WORKFLOW_CHECK_TASK_ARTIFACT: "",
        PRODUCT_WORKFLOW_CHECK_TASK_RECLAIM: "",
        PRODUCT_WORKFLOW_CHECK_TASK_RECLAIM_REAP_APPLY: "",
        PRODUCT_WORKFLOW_ENDPOINT_BASE_URL: "",
        PRODUCT_WORKFLOW_ENDPOINT_MODEL: "",
        PRODUCT_WORKFLOW_ENDPOINT_SECRET_REF: "",
        PRODUCT_WORKFLOW_TASK_TIMEOUT_SECS: "",
        BOTIFIED_RUNNER_IMAGE: "",
        JUICEFS_PVC_NAME: "",
        AGENTSMITH_LITE_SANDBOX_MODE: "",
        KUBECTL_BIN: "",
        KUBECONFIG_PATH: "",
        KUBE_CONTEXT: "",
        KUBE_NAMESPACE: "",
        S3_SECRET_KEY: "",
        JUICEFS_SECRET_KEY: "",
        ...env
      },
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface WorkflowRequest {
  method: string | undefined;
  url: string | undefined;
  cookie: string | undefined;
  csrf: string | undefined;
  body: string;
}

interface WorkflowTaskFixture {
  taskId: string;
  runId: string;
  subPath: string;
}

interface WorkflowServerOptions {
  adminPassword: string;
  workspaceId: string;
  projectId: string;
  endpointId: string;
  endpointBaseUrl: string;
  endpointModel: string;
  endpointSecretRef: string;
  artifactTask?: WorkflowTaskFixture;
  reclaimTask?: WorkflowTaskFixture;
}

interface WorkflowServer {
  baseUrl: string;
  requests: WorkflowRequest[];
  close: () => Promise<void>;
}

interface ProductWorkflowSummary {
  status: string;
  baseUrl: string;
  workspaceId: string;
  projectId: string;
  chat: { status: string };
  task: any;
  taskReclaim?: any;
}
