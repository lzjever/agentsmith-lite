import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const appSmokeNotCovered = [
  "external-k8s-observation",
  "sandbox-pod-pvc-volume-mount-spec-observed",
  "juicefs-backend",
  "runner-image-digest",
  "independent-k8s-resource-deletion-observation",
  "full-external-evidence"
];
const appSmokeSandboxCoverage = "task-api-sandbox-render-pvc-runner-image-contract";
const appSmokeSandboxContractScope = "product-api-sandbox-render-contract";
const defaultSandboxRunnerImage = "registry.example.test/agentsmith/botified-runner@sha256:1111111111111111111111111111111111111111111111111111111111111111";
const defaultSandboxPvcClaimName = "agentsmith-lite-files";

describe("deploy app smoke", () => {
  it("smoke.sh dispatches to the API-only app smoke with env base URL and contract admin secret", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-smoke-sh-"));
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
      "SMOKE_ENDPOINT_BASE_URL=https://models.env.test/v1",
      "SMOKE_ENDPOINT_MODEL=env-model",
      "SMOKE_ENDPOINT_SECRET_REF=secret/env",
      "SMOKE_TASK=true",
      "SMOKE_TASK_RECLAIM=true",
      "SMOKE_TASK_RECLAIM_REAP_APPLY=true",
      "SMOKE_TASK_TIMEOUT_SECS=12"
    ].join("\n"));
    writeFileSync(secretsFile, [`BUILTIN_ADMIN_INITIAL_PASSWORD=${adminPassword}`, "OIDC_CLIENT_SECRET=", `S3_SECRET_KEY=$(touch ${secretMarker})`, ""].join("\n"));
    writeFileSync(fakeNode, `#!/usr/bin/env bash
{
  printf 'args=%s\\n' "$*"
  printf 'admin_password=%s\\n' "$BUILTIN_ADMIN_INITIAL_PASSWORD"
  printf 'endpoint_base_url=%s\\n' "$SMOKE_ENDPOINT_BASE_URL"
  printf 'task_smoke=%s\\n' "$SMOKE_TASK"
  printf 'task_reclaim_smoke=%s\\n' "$SMOKE_TASK_RECLAIM"
  printf 'task_reclaim_reap_apply=%s\\n' "$SMOKE_TASK_RECLAIM_REAP_APPLY"
  printf 'task_timeout=%s\\n' "$SMOKE_TASK_TIMEOUT_SECS"
} > "$FAKE_NODE_CALLS"
printf '{"status":"ok","profile":"light","baseUrl":"http://deploy.example.test","workspaceId":"workspace_1","projectId":"project_1","chat":{"status":"skipped"},"task":{"status":"skipped"}}\\n'
`);
    chmodSync(fakeNode, 0o755);

    const result = spawnSync("bash", [
      "scripts/deploy/smoke.sh",
      "--env",
      envFile,
      "--secrets",
      secretsFile,
      "--app-env",
      appEnvFile,
      "--task-reclaim-smoke",
      "--task-reclaim-reap-apply"
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
    assert.match(call, /args=scripts\/deploy\/app-smoke\.mjs --base-url http:\/\/deploy\.example\.test --report out\/smoke-report\.json --task-reclaim-smoke --task-reclaim-reap-apply/);
    assert.doesNotMatch(call, /e2e\/smoke\/lite-smoke\.mjs/);
    assert.match(call, new RegExp(`admin_password=${escapeRegExp(adminPassword)}`));
    assert.match(call, /endpoint_base_url=https:\/\/models\.env\.test\/v1/);
    assert.match(call, /task_smoke=true/);
    assert.match(call, /task_reclaim_smoke=true/);
    assert.match(call, /task_reclaim_reap_apply=true/);
    assert.match(call, /task_timeout=12/);
    assert.doesNotMatch(call, /--k8s-evidence/);
    assert.doesNotMatch(result.stdout, new RegExp(escapeRegExp(adminPassword)));
    assert.doesNotMatch(result.stderr, new RegExp(escapeRegExp(adminPassword)));
  });

  it("smoke.sh forwards explicit k8s evidence without making it default", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-smoke-sh-k8s-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    const fakeNode = path.join(tempDir, "node");
    const callsFile = path.join(tempDir, "node-calls.txt");

    writeFileSync(envFile, "APP_PUBLIC_BASE_URL=http://deploy.example.test\nAUTH_MODE=builtin_admin\nOIDC_ISSUER_URL=\nOIDC_CLIENT_ID=\n");
    writeFileSync(secretsFile, "BUILTIN_ADMIN_INITIAL_PASSWORD=admin-secret-from-file\nOIDC_CLIENT_SECRET=\n");
    writeFileSync(fakeNode, `#!/usr/bin/env bash
printf 'args=%s\\n' "$*" > "$FAKE_NODE_CALLS"
printf '{"status":"ok","profile":"full","baseUrl":"http://deploy.example.test","workspaceId":"workspace_1","projectId":"project_1","chat":{"status":"skipped"},"task":{"status":"skipped"}}\\n'
`);
    chmodSync(fakeNode, 0o755);

    const withoutFlag = spawnSync("bash", [
      "scripts/deploy/smoke.sh",
      "--env",
      envFile,
      "--secrets",
      secretsFile,
      "--task-smoke"
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
    assert.equal(withoutFlag.status, 0, withoutFlag.stderr);
    assert.doesNotMatch(readFileSync(callsFile, "utf8"), /--k8s-evidence/);

    const withFlag = spawnSync("bash", [
      "scripts/deploy/smoke.sh",
      "--env",
      envFile,
      "--secrets",
      secretsFile,
      "--task-smoke",
      "--k8s-evidence"
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

    assert.equal(withFlag.status, 0, withFlag.stderr);
    assert.match(readFileSync(callsFile, "utf8"), /--task-smoke --k8s-evidence/);
  });

  it("smoke.sh forwards a report path override to app-smoke", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-smoke-sh-report-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    const fakeNode = path.join(tempDir, "node");
    const callsFile = path.join(tempDir, "node-calls.txt");
    const reportPath = path.join(tempDir, "reports", "custom-smoke-report.json");

    writeFileSync(envFile, "APP_PUBLIC_BASE_URL=http://deploy.example.test\nAUTH_MODE=builtin_admin\nOIDC_ISSUER_URL=\nOIDC_CLIENT_ID=\n");
    writeFileSync(secretsFile, "BUILTIN_ADMIN_INITIAL_PASSWORD=admin-secret-from-file\nOIDC_CLIENT_SECRET=\n");
    writeFileSync(fakeNode, `#!/usr/bin/env bash
printf 'args=%s\\n' "$*" > "$FAKE_NODE_CALLS"
printf '{"status":"ok","profile":"light","baseUrl":"http://deploy.example.test","workspaceId":"workspace_1","projectId":"project_1","chat":{"status":"skipped"},"task":{"status":"skipped"}}\\n'
`);
    chmodSync(fakeNode, 0o755);

    const result = spawnSync("bash", [
      "scripts/deploy/smoke.sh",
      "--env",
      envFile,
      "--secrets",
      secretsFile,
      "--report",
      reportPath
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
    assert.match(call, new RegExp(`--report ${escapeRegExp(reportPath)}`));
    assert.doesNotMatch(call, /--report out\/smoke-report\.json/);
  });

  it("smoke.sh rejects SMOKE_* keys in substrate env without printing their values", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-smoke-sh-substrate-smoke-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    writeFileSync(envFile, "APP_PUBLIC_BASE_URL=http://deploy.example.test\nAUTH_MODE=builtin_admin\nOIDC_ISSUER_URL=\nOIDC_CLIENT_ID=\nSMOKE_TASK=DO_NOT_PRINT_SMOKE_TASK\n");
    writeFileSync(secretsFile, "BUILTIN_ADMIN_INITIAL_PASSWORD=admin-secret-from-file\nOIDC_CLIENT_SECRET=\n");

    const result = spawnSync("bash", ["scripts/deploy/smoke.sh", "--env", envFile, "--secrets", secretsFile], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        AGENTSMITH_LITE_ENV_CONTRACT_NODE: process.execPath
      }
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SMOKE_TASK/);
    assert.doesNotMatch(result.stderr + result.stdout, /DO_NOT_PRINT_SMOKE_TASK/);
  });

  it("app-smoke.mjs exercises remote API smoke with cookie, CSRF, endpoint, chat, files, and operator status", async () => {
    const adminPassword = "remote-admin-secret";
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-app-smoke-report-"));
    const reportPath = path.join(tempDir, "nested", "smoke-report.json");
    const requests: SmokeRequest[] = [];
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
        assert.deepEqual(parsedBody, { password: adminPassword });
        res.end(JSON.stringify({ created: true }));
      } else if (req.method === "POST" && req.url === "/api/auth/login") {
        assert.deepEqual(parsedBody, {
          email: "admin@agentsmith-lite.local",
          password: adminPassword
        });
        res.setHeader("set-cookie", "asl_session=smoke-session; HttpOnly; Path=/");
        res.end(JSON.stringify({ csrfToken: "csrf-smoke" }));
      } else if (req.method === "POST" && req.url === "/api/workspaces") {
        assert.deepEqual(parsedBody, { name: "Deploy Smoke" });
        res.end(JSON.stringify({ id: "workspace_1", name: "Deploy Smoke" }));
      } else if (req.method === "POST" && req.url === "/api/workspaces/workspace_1/projects") {
        assert.deepEqual(parsedBody, { name: "API Smoke" });
        res.end(JSON.stringify({ id: "project_1", workspaceId: "workspace_1", name: "API Smoke" }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_1/endpoints") {
        assert.deepEqual(parsedBody, {
          name: "Deploy Smoke Endpoint",
          protocol: "openai_chat_completions",
          baseUrl: "https://models.remote.test/v1",
          model: "remote-model",
          apiKeySecretRef: "secret/remote-smoke",
          capabilities: ["text"],
          requestTimeoutSecs: 30
        });
        res.end(JSON.stringify({
          id: "endpoint_1",
          projectId: "project_1",
          baseUrl: "https://models.remote.test/v1",
          model: "remote-model",
          protocol: "openai_chat_completions",
          hasCredentialRef: true
        }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_1/chat") {
        assert.deepEqual(parsedBody, {
          endpointId: "endpoint_1",
          messages: [{ role: "user", content: "deploy smoke" }]
        });
        res.end(JSON.stringify({
          message: { role: "assistant", content: "ok" },
          endpointSnapshot: {
            id: "endpoint_1",
            baseUrl: "https://models.remote.test/v1",
            model: "remote-model",
            protocol: "openai_chat_completions"
          }
        }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_1/files") {
        assert.deepEqual(parsedBody, {
          path: "files/deploy-smoke.txt",
          content: "hello from deploy smoke\n"
        });
        res.end(JSON.stringify({ path: "files/deploy-smoke.txt", bytes: 24 }));
      } else if (req.method === "GET" && req.url === "/api/projects/project_1/files?path=files") {
        res.end(JSON.stringify({ entries: [{ path: "files/deploy-smoke.txt", type: "file" }] }));
      } else if (req.method === "GET" && req.url === "/api/projects/project_1/files/download?path=files%2Fdeploy-smoke.txt") {
        res.end(JSON.stringify({ path: "files/deploy-smoke.txt", content: "hello from deploy smoke\n" }));
      } else if (req.method === "DELETE" && req.url === "/api/projects/project_1/files") {
        assert.deepEqual(parsedBody, { path: "files/deploy-smoke.txt" });
        res.end(JSON.stringify({ deleted: true }));
      } else if (req.method === "GET" && req.url === "/api/operator/sandbox/status") {
        res.end(JSON.stringify({ namespace: "agentsmith", activeTaskCount: 0, runCounts: {}, observedResourceCounts: {} }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `unexpected ${req.method} ${req.url}` }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const result = await runNode([
        "scripts/deploy/app-smoke.mjs",
        "--base-url",
        baseUrl,
        "--endpoint-base-url",
        "https://models.remote.test/v1",
        "--endpoint-model",
        "remote-model",
        "--endpoint-secret-ref",
        "secret/remote-smoke",
        "--report",
        reportPath
      ], {
        BUILTIN_ADMIN_INITIAL_PASSWORD: adminPassword
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout) as {
        status: string;
        profile: string;
        baseUrl: string;
        workspaceId: string;
        projectId: string;
        evidenceScope: EvidenceScope;
        chat: { status: string };
        task: { status: string };
      };
      assert.deepEqual(report, {
        status: "ok",
        profile: "light",
        baseUrl,
        workspaceId: "workspace_1",
        projectId: "project_1",
        evidenceScope: {
          scope: "product-api-only",
          covered: [
            "product-api-health",
            "builtin-admin-auth",
            "workspace-project-api",
            "project-file-api-crud",
            "operator-sandbox-status-api",
            "endpoint-chat-api"
          ],
          notCovered: appSmokeNotCovered
        },
        chat: { status: "completed" },
        task: { status: "skipped" }
      });
      assert.equal(readFileSync(reportPath, "utf8"), result.stdout);
      assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), report);
      assert.doesNotMatch(result.stdout, new RegExp(escapeRegExp(adminPassword)));
      assert.doesNotMatch(result.stdout, /secret\/remote-smoke/);
      assert.doesNotMatch(readFileSync(reportPath, "utf8"), new RegExp(escapeRegExp(adminPassword)));
      assert.doesNotMatch(readFileSync(reportPath, "utf8"), /secret\/remote-smoke/);
      assert.doesNotMatch(result.stderr, new RegExp(escapeRegExp(adminPassword)));
      assertLightEvidenceDoesNotClaimExternal(report.evidenceScope);

      assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
        "GET /api/health",
        "POST /api/auth/bootstrap",
        "POST /api/auth/login",
        "POST /api/workspaces",
        "POST /api/workspaces/workspace_1/projects",
        "POST /api/projects/project_1/endpoints",
        "POST /api/projects/project_1/chat",
        "POST /api/projects/project_1/files",
        "GET /api/projects/project_1/files?path=files",
        "GET /api/projects/project_1/files/download?path=files%2Fdeploy-smoke.txt",
        "DELETE /api/projects/project_1/files",
        "GET /api/operator/sandbox/status"
      ]);
      assert.equal(requests.some((request) => request.url?.includes("/tasks")), false);
      for (const request of requests.slice(3)) {
        assert.equal(request.cookie, "asl_session=smoke-session", `${request.method} ${request.url} missing session cookie`);
        assert.equal(request.csrf, "csrf-smoke", `${request.method} ${request.url} missing csrf token`);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("app-smoke.mjs skips endpoint and chat when endpoint smoke config is absent", async () => {
    const adminPassword = "skip-admin-secret";
    const requests: SmokeRequest[] = [];
    const server = createServer(async (req, res) => {
      requests.push({
        method: req.method,
        url: req.url,
        cookie: req.headers.cookie,
        csrf: req.headers["x-csrf-token"]?.toString(),
        body: await readRequestBody(req)
      });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/api/health") {
        res.end(JSON.stringify({ status: "ok" }));
      } else if (req.method === "POST" && req.url === "/api/auth/bootstrap") {
        res.end(JSON.stringify({ created: true }));
      } else if (req.method === "POST" && req.url === "/api/auth/login") {
        res.setHeader("set-cookie", "asl_session=skip-session; Path=/");
        res.end(JSON.stringify({ csrfToken: "csrf-skip" }));
      } else if (req.method === "POST" && req.url === "/api/workspaces") {
        res.end(JSON.stringify({ id: "workspace_skip" }));
      } else if (req.method === "POST" && req.url === "/api/workspaces/workspace_skip/projects") {
        res.end(JSON.stringify({ id: "project_skip" }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_skip/files") {
        res.end(JSON.stringify({ path: "files/deploy-smoke.txt", bytes: 24 }));
      } else if (req.method === "GET" && req.url === "/api/projects/project_skip/files?path=files") {
        res.end(JSON.stringify({ entries: [{ path: "files/deploy-smoke.txt", type: "file" }] }));
      } else if (req.method === "GET" && req.url === "/api/projects/project_skip/files/download?path=files%2Fdeploy-smoke.txt") {
        res.end(JSON.stringify({ path: "files/deploy-smoke.txt", content: "hello from deploy smoke\n" }));
      } else if (req.method === "DELETE" && req.url === "/api/projects/project_skip/files") {
        res.end(JSON.stringify({ deleted: true }));
      } else if (req.method === "GET" && req.url === "/api/operator/sandbox/status") {
        res.end(JSON.stringify({ namespace: "agentsmith", activeTaskCount: 0 }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `unexpected ${req.method} ${req.url}` }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const result = await runNode([
        "scripts/deploy/app-smoke.mjs",
        "--base-url",
        baseUrl
      ], {
        BUILTIN_ADMIN_INITIAL_PASSWORD: adminPassword
      });

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        status: "ok",
        profile: "light",
        baseUrl,
        workspaceId: "workspace_skip",
        projectId: "project_skip",
        evidenceScope: {
          scope: "product-api-only",
          covered: [
            "product-api-health",
            "builtin-admin-auth",
            "workspace-project-api",
            "project-file-api-crud",
            "operator-sandbox-status-api"
          ],
          notCovered: appSmokeNotCovered
        },
        chat: { status: "skipped" },
        task: { status: "skipped" }
      });
      assertLightEvidenceDoesNotClaimExternal(JSON.parse(result.stdout).evidenceScope);
      assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
        "GET /api/health",
        "POST /api/auth/bootstrap",
        "POST /api/auth/login",
        "POST /api/workspaces",
        "POST /api/workspaces/workspace_skip/projects",
        "POST /api/projects/project_skip/files",
        "GET /api/projects/project_skip/files?path=files",
        "GET /api/projects/project_skip/files/download?path=files%2Fdeploy-smoke.txt",
        "DELETE /api/projects/project_skip/files",
        "GET /api/operator/sandbox/status"
      ]);
      assert.equal(requests.some((request) => request.url?.includes("/tasks")), false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("app-smoke.mjs runs task smoke through events, artifacts, and verified download without canceling success", async () => {
    const adminPassword = "task-admin-secret";
    const requests: SmokeRequest[] = [];
    let eventPolls = 0;
    let artifactPolls = 0;
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
        assert.deepEqual(parsedBody, { password: adminPassword });
        res.end(JSON.stringify({ created: true }));
      } else if (req.method === "POST" && req.url === "/api/auth/login") {
        assert.deepEqual(parsedBody, {
          email: "admin@agentsmith-lite.local",
          password: adminPassword
        });
        res.setHeader("set-cookie", "asl_session=task-session; HttpOnly; Path=/");
        res.end(JSON.stringify({ csrfToken: "csrf-task" }));
      } else if (req.method === "POST" && req.url === "/api/workspaces") {
        assert.deepEqual(parsedBody, { name: "Deploy Smoke" });
        res.end(JSON.stringify({ id: "workspace_task", name: "Deploy Smoke" }));
      } else if (req.method === "POST" && req.url === "/api/workspaces/workspace_task/projects") {
        assert.deepEqual(parsedBody, { name: "API Smoke" });
        res.end(JSON.stringify({ id: "project_task", workspaceId: "workspace_task", name: "API Smoke" }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_task/endpoints") {
        assert.deepEqual(parsedBody, {
          name: "Deploy Smoke Endpoint",
          protocol: "openai_chat_completions",
          baseUrl: "https://models.task.test/v1",
          model: "task-model",
          apiKeySecretRef: "secret/task-smoke",
          capabilities: ["text"],
          requestTimeoutSecs: 30
        });
        res.end(JSON.stringify({
          id: "endpoint_task",
          projectId: "project_task",
          baseUrl: "https://models.task.test/v1",
          model: "task-model",
          protocol: "openai_chat_completions",
          hasCredentialRef: true
        }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_task/chat") {
        assert.deepEqual(parsedBody, {
          endpointId: "endpoint_task",
          messages: [{ role: "user", content: "deploy smoke" }]
        });
        res.end(JSON.stringify({
          message: { role: "assistant", content: "ok" },
          endpointSnapshot: {
            id: "endpoint_task",
            baseUrl: "https://models.task.test/v1",
            model: "task-model",
            protocol: "openai_chat_completions"
          }
        }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_task/files") {
        assert.deepEqual(parsedBody, {
          path: "files/deploy-smoke.txt",
          content: "hello from deploy smoke\n"
        });
        res.end(JSON.stringify({ path: "files/deploy-smoke.txt", bytes: 24 }));
      } else if (req.method === "GET" && req.url === "/api/projects/project_task/files?path=files") {
        res.end(JSON.stringify({ entries: [{ path: "files/deploy-smoke.txt", type: "file" }] }));
      } else if (req.method === "GET" && req.url === "/api/projects/project_task/files/download?path=files%2Fdeploy-smoke.txt") {
        res.end(JSON.stringify({ path: "files/deploy-smoke.txt", content: "hello from deploy smoke\n" }));
      } else if (req.method === "DELETE" && req.url === "/api/projects/project_task/files") {
        assert.deepEqual(parsedBody, { path: "files/deploy-smoke.txt" });
        res.end(JSON.stringify({ deleted: true }));
      } else if (req.method === "GET" && req.url === "/api/operator/sandbox/status") {
        res.end(JSON.stringify({ namespace: "agentsmith", activeTaskCount: 0, runCounts: {}, observedResourceCounts: {} }));
      } else if (req.method === "GET" && req.url === "/api/operator/sandbox/status?runId=run_task_smoke") {
        res.end(JSON.stringify(statusResponse("run_task_smoke", {
          activeTaskCount: 1,
          runCounts: { total: 1, active: 1, running: 1 },
          observedResourceCounts: { Pod: 1, Secret: 1 },
          cleanupTargetCount: 2
        })));
      } else if (req.method === "POST" && req.url === "/api/projects/project_task/tasks") {
        assert.equal(parsedBody.endpointId, "endpoint_task");
        assert.equal(typeof parsedBody.prompt, "string");
        assert.match(parsedBody.prompt as string, /bash/i);
        assert.match(parsedBody.prompt as string, /publish_file/);
        assert.match(parsedBody.prompt as string, /agentsmith-lite-task-smoke\.txt/);
        assert.match(parsedBody.prompt as string, /AGENTSMITH_LITE_TASK_SMOKE_MARKER/);
        assert.doesNotMatch(parsedBody.prompt as string, /\.\.\/artifacts/);
        assert.equal(JSON.stringify(parsedBody).includes("secret/task-smoke"), false);
        res.end(JSON.stringify({
          id: "task_smoke",
          runId: "run_task_smoke",
          status: "running",
          endpointId: "endpoint_task",
          sandbox: {
            resources: sandboxResources({
              taskId: "task_smoke",
              runId: "run_task_smoke",
              subPath: "workspaces/workspace_task/projects/project_task"
            })
          }
        }));
      } else if (req.method === "GET" && req.url === "/api/tasks/task_smoke/events") {
        eventPolls += 1;
        res.end(JSON.stringify(eventPolls === 1 ? [{
          id: "event_started",
          taskId: "task_smoke",
          kind: "turn_started",
          cursor: "c1",
          botifiedSeq: 1,
          botifiedType: "cycle.started",
          sessionId: "session_1",
          payload: {},
          createdAt: "2026-01-01T00:00:00.000Z"
        }] : [{
          id: "event_completed",
          taskId: "task_smoke",
          kind: "turn_completed",
          cursor: "c2",
          botifiedSeq: 2,
          botifiedType: "cycle.completed",
          sessionId: "session_1",
          payload: {},
          createdAt: "2026-01-01T00:00:01.000Z"
        }]));
      } else if (req.method === "GET" && req.url === "/api/tasks/task_smoke/artifacts") {
        artifactPolls += 1;
        res.end(JSON.stringify(artifactPolls === 1 ? [] : [{
          id: "artifact_task_smoke",
          taskId: "task_smoke",
          fileId: "file_task_smoke",
          name: "agentsmith-lite-task-smoke.txt",
          bytes: 49,
          createdAt: "2026-01-01T00:00:01.000Z"
        }]));
      } else if (req.method === "GET" && req.url === "/api/tasks/task_smoke/artifacts/artifact_task_smoke/download") {
        res.setHeader("content-type", "application/octet-stream");
        res.end("runtime accepted\nAGENTSMITH_LITE_TASK_SMOKE_MARKER\n");
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `unexpected ${req.method} ${req.url}` }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const result = await runNode([
        "scripts/deploy/app-smoke.mjs",
        "--base-url",
        baseUrl,
        "--endpoint-base-url",
        "https://models.task.test/v1",
        "--endpoint-model",
        "task-model",
        "--endpoint-secret-ref",
        "secret/task-smoke"
      ], {
        BUILTIN_ADMIN_INITIAL_PASSWORD: adminPassword,
        SMOKE_TASK: "true",
        BOTIFIED_RUNNER_IMAGE: defaultSandboxRunnerImage,
        JUICEFS_PVC_NAME: defaultSandboxPvcClaimName,
        AGENTSMITH_LITE_SANDBOX_MODE: "live"
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report, {
        status: "ok",
        profile: "full",
        baseUrl,
        workspaceId: "workspace_task",
        projectId: "project_task",
        evidenceScope: {
          scope: "product-api-only",
          covered: [
            "product-api-health",
            "builtin-admin-auth",
            "workspace-project-api",
            "project-file-api-crud",
            "operator-sandbox-status-api",
            "endpoint-chat-api",
            "task-api-create-events-artifact-download-marker",
            appSmokeSandboxCoverage
          ],
          notCovered: appSmokeNotCovered
        },
        chat: { status: "completed" },
        task: {
          status: "completed",
          taskId: "task_smoke",
          runId: "run_task_smoke",
          createStatus: "running",
          artifactId: "artifact_task_smoke",
          artifactName: "agentsmith-lite-task-smoke.txt",
          eventCount: 2,
          eventKinds: ["turn_started", "turn_completed"],
          artifactBytes: 51,
          artifactSha256: "5dd3c17fbeb5a93a5f89f4b32eb096f443a8ce3ad643c18d4ea0bba65ac8f9a1",
          markerObserved: true,
          sandboxContract: sandboxContractSummary({
            taskId: "task_smoke",
            subPath: "workspaces/workspace_task/projects/project_task"
          }),
          runScopedStatus: {
            runId: "run_task_smoke",
            activeTaskCount: 1,
            runCounts: { total: 1, active: 1, running: 1 },
            observedResourceCounts: { Pod: 1, Secret: 1 },
            cleanupTargetCount: 2,
            errorCount: 0
          }
        }
      });
      assert.notEqual(report.task.createStatus, 200);
      assert.doesNotMatch(result.stdout, new RegExp(escapeRegExp(adminPassword)));
      assert.doesNotMatch(result.stdout, /secret\/task-smoke/);
      assert.doesNotMatch(result.stdout, /BOTIFIED_SERVICE_KEY|task-service-key-secret/);
      assert.doesNotMatch(result.stdout, /runtime accepted/);
      assert.doesNotMatch(result.stdout, /AGENTSMITH_LITE_TASK_SMOKE_MARKER/);
      assert.doesNotMatch(result.stderr, new RegExp(escapeRegExp(adminPassword)));

      assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
        "GET /api/health",
        "POST /api/auth/bootstrap",
        "POST /api/auth/login",
        "POST /api/workspaces",
        "POST /api/workspaces/workspace_task/projects",
        "POST /api/projects/project_task/endpoints",
        "POST /api/projects/project_task/chat",
        "POST /api/projects/project_task/files",
        "GET /api/projects/project_task/files?path=files",
        "GET /api/projects/project_task/files/download?path=files%2Fdeploy-smoke.txt",
        "DELETE /api/projects/project_task/files",
        "GET /api/operator/sandbox/status",
        "POST /api/projects/project_task/tasks",
        "GET /api/tasks/task_smoke/events",
        "GET /api/tasks/task_smoke/artifacts",
        "GET /api/tasks/task_smoke/events",
        "GET /api/tasks/task_smoke/artifacts",
        "GET /api/tasks/task_smoke/artifacts/artifact_task_smoke/download",
        "GET /api/operator/sandbox/status?runId=run_task_smoke"
      ]);
      const taskCreate = requests.find((request) => request.url === "/api/projects/project_task/tasks");
      assert.ok(taskCreate);
      assert.equal(taskCreate.cookie, "asl_session=task-session");
      assert.equal(taskCreate.csrf, "csrf-task");
      assert.equal(requests.some((request) => request.url === "/api/tasks/task_smoke/cancel"), false);
      for (const request of requests.filter((candidate) => candidate.url?.startsWith("/api/tasks/"))) {
        assert.equal(request.cookie, "asl_session=task-session", `${request.method} ${request.url} missing session cookie`);
        assert.equal(request.csrf, "csrf-task", `${request.method} ${request.url} missing csrf token`);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("app-smoke.mjs appends scoped read-only k8s evidence for all six lifecycle resources to task smoke", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-k8s-evidence-"));
    const reportPath = path.join(tempDir, "reports", "smoke-report.json");
    const kubectlCalls = path.join(tempDir, "kubectl-calls.txt");
    const fakeKubectl = writeFakeKubectl(tempDir, {
      runId: "run_k8s_task",
      podName: "asl-task-k8s",
      resourcePrefix: "asl-k8s"
    });
    const server = await startTaskSmokeServer({
      adminPassword: "k8s-admin-secret",
      endpointBaseUrl: "https://models.k8s.test/v1",
      endpointModel: "k8s-model",
      endpointSecretRef: "secret/k8s-smoke",
      workspaceId: "workspace_k8s",
      projectId: "project_k8s",
      endpointId: "endpoint_k8s",
      taskId: "task_k8s",
      runId: "run_k8s_task",
      subPath: "workspaces/workspace_k8s/projects/project_k8s"
    });

    try {
      const result = await runNode([
        "scripts/deploy/app-smoke.mjs",
        "--base-url",
        server.baseUrl,
        "--endpoint-base-url",
        "https://models.k8s.test/v1",
        "--endpoint-model",
        "k8s-model",
        "--endpoint-secret-ref",
        "secret/k8s-smoke",
        "--task-smoke",
        "--k8s-evidence",
        "--report",
        reportPath
      ], {
        BUILTIN_ADMIN_INITIAL_PASSWORD: "k8s-admin-secret",
        KUBECTL_BIN: fakeKubectl,
        FAKE_KUBECTL_CALLS: kubectlCalls,
        KUBECONFIG_PATH: "/tmp/k8s-evidence.kubeconfig",
        KUBE_CONTEXT: "kind-agentsmith",
        KUBE_NAMESPACE: "agentsmith-preview",
        S3_SECRET_KEY: "s3-raw-secret-value",
        JUICEFS_SECRET_KEY: "juicefs-raw-secret-value"
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout);
      assert.equal(readFileSync(reportPath, "utf8"), result.stdout);
      assert.equal(report.evidenceScope.scope, "product-api-plus-k8s-readonly");
      assert.equal(report.evidenceScope.covered.includes("external-k8s-observation"), true);
      assert.equal(report.evidenceScope.covered.includes("sandbox-pod-pvc-volume-mount-spec-observed"), true);
      assert.equal(report.evidenceScope.covered.includes("sandbox-pod-pvc-mount"), false);
      assert.equal(report.evidenceScope.covered.includes("runner-image-digest"), true);
      assert.equal(report.evidenceScope.notCovered.includes("external-k8s-observation"), false);
      assert.equal(report.evidenceScope.notCovered.includes("sandbox-pod-pvc-volume-mount-spec-observed"), false);
      assert.equal(report.evidenceScope.notCovered.includes("sandbox-pod-pvc-mount"), false);
      assert.equal(report.evidenceScope.notCovered.includes("runner-image-digest"), false);
      assert.equal(report.evidenceScope.notCovered.includes("juicefs-backend"), true);
      assert.equal(report.evidenceScope.notCovered.includes("full-external-evidence"), true);
      assert.deepEqual(report.task.k8sEvidence, {
        status: "observed",
        runId: "run_k8s_task",
        namespace: "agentsmith-preview",
        pods: [{
          name: "asl-task-k8s",
          phase: "Running",
          ready: true,
          runnerImage: defaultSandboxRunnerImage,
          runnerImageID: "docker-pullable://registry.example.test/agentsmith/botified-runner@sha256:1111111111111111111111111111111111111111111111111111111111111111",
          pvcClaimName: defaultSandboxPvcClaimName,
          mountPath: "/workspace/project",
          subPath: "workspaces/workspace_k8s/projects/project_k8s"
        }],
        resources: {
          Pod: { count: 1, names: ["asl-task-k8s"] },
          Secret: { count: 1, names: ["secret/asl-k8s-secret"] },
          ConfigMap: { count: 1, names: ["configmap/asl-k8s-config"] },
          ServiceAccount: { count: 1, names: ["serviceaccount/asl-k8s-service-account"] },
          Service: { count: 1, names: ["service/asl-k8s-service"] },
          NetworkPolicy: { count: 1, names: ["networkpolicy/asl-k8s-network"] }
        }
      });

      const calls = readFileSync(kubectlCalls, "utf8").trim().split("\n");
      assert.equal(calls.length, 6);
      for (const call of calls) {
        assert.match(call, /^--kubeconfig \/tmp\/k8s-evidence\.kubeconfig --context kind-agentsmith get /);
        assert.match(call, / -n agentsmith-preview /);
        assert.match(call, / -l agentsmith-lite\/run-id=run_k8s_task /);
        assert.doesNotMatch(call, /\b(exec|logs|attach|port-forward|apply|delete|patch|create)\b/);
        assert.doesNotMatch(call, /secret\/k8s-smoke|k8s-admin-secret|s3-raw-secret-value|juicefs-raw-secret-value/);
      }
      assert.match(calls[0] ?? "", / get pods .* -o json$/);
      assert.equal(calls.some((call) => / get serviceaccounts .* -o name$/.test(call)), true);
      for (const call of calls.slice(1)) {
        assert.match(call, / -o name$/);
      }
      assert.doesNotMatch(result.stdout + readFileSync(reportPath, "utf8") + result.stderr, /secret\/k8s-smoke|k8s-admin-secret|s3-raw-secret-value|juicefs-raw-secret-value/);
      assert.doesNotMatch(result.stdout + readFileSync(reportPath, "utf8"), /runtime accepted|AGENTSMITH_LITE_TASK_SMOKE_MARKER/);
      assert.equal(server.requests.some((request) => request.url === "/api/tasks/task_k8s/cancel"), false);
    } finally {
      await server.close();
    }
  });

  it("app-smoke.mjs fails usage for k8s evidence without a task run to observe", async () => {
    let requestCount = 0;
    const server = createServer((_req, res) => {
      requestCount += 1;
      res.statusCode = 500;
      res.end("unexpected request");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const result = await runNode([
        "scripts/deploy/app-smoke.mjs",
        "--base-url",
        baseUrl,
        "--k8s-evidence"
      ], {
        BUILTIN_ADMIN_INITIAL_PASSWORD: "admin-secret",
        KUBE_NAMESPACE: "agentsmith-preview"
      });

      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /k8s evidence requires task smoke or task reclaim smoke/);
      assert.equal(requestCount, 0);

      const missingNamespace = await runNode([
        "scripts/deploy/app-smoke.mjs",
        "--base-url",
        baseUrl,
        "--endpoint-base-url",
        "https://models.k8s-missing-namespace.test/v1",
        "--endpoint-model",
        "missing-namespace-model",
        "--endpoint-secret-ref",
        "secret/missing-namespace-smoke",
        "--task-smoke",
        "--k8s-evidence"
      ], {
        BUILTIN_ADMIN_INITIAL_PASSWORD: "admin-secret"
      });
      assert.equal(missingNamespace.status, 2);
      assert.equal(missingNamespace.stdout, "");
      assert.match(missingNamespace.stderr, /KUBE_NAMESPACE is required/);
      assert.doesNotMatch(missingNamespace.stderr, /secret\/missing-namespace-smoke/);
      assert.equal(requestCount, 0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("app-smoke.mjs fails closed when k8s evidence observes unsafe task pod state", async () => {
    const cases: Array<{
      name: string;
      fakeKubectl: FakeKubectlOptions;
      expectedMessage: RegExp;
      leakPatterns: RegExp[];
    }> = [
      {
        name: "non-digest-runner",
        fakeKubectl: {
          runId: "run_k8s_bad_image",
          podName: "asl-task-bad-image",
          resourcePrefix: "asl-bad-image",
          runnerImage: "agentsmith-lite/botified-runner:dev",
          runnerImageID: "docker://runner-without-digest"
        },
        expectedMessage: /k8s evidence observed botified-runner image must be digest pinned/,
        leakPatterns: [/bad-image-admin-secret/, /secret\/bad-image-smoke/, /bad-image-s3-secret/, /bad-image-juicefs-secret/]
      },
      {
        name: "run-id-label-mismatch",
        fakeKubectl: {
          runId: "run_k8s_label",
          podName: "asl-task-label",
          resourcePrefix: "asl-label",
          observedRunId: "run_other"
        },
        expectedMessage: /k8s evidence pod asl-task-label run-id label mismatch/,
        leakPatterns: [/label-admin-secret/, /secret\/label-smoke/, /label-s3-secret/, /label-juicefs-secret/]
      },
      {
        name: "pvc-claim-drift",
        fakeKubectl: {
          runId: "run_k8s_pvc",
          podName: "asl-task-pvc",
          resourcePrefix: "asl-pvc",
          pvcClaimName: "agentsmith-lite-drift-files"
        },
        expectedMessage: /k8s evidence pod asl-task-pvc project-files PVC claimName does not match sandbox contract/,
        leakPatterns: [
          /pvc-admin-secret/,
          /secret\/pvc-smoke/,
          /pvc-s3-secret/,
          /pvc-juicefs-secret/,
          /runtime accepted/,
          /AGENTSMITH_LITE_TASK_SMOKE_MARKER/
        ]
      },
      {
        name: "mount-path-drift",
        fakeKubectl: {
          runId: "run_k8s_mount",
          podName: "asl-task-mount",
          resourcePrefix: "asl-mount",
          mountPath: "/workspace/other"
        },
        expectedMessage: /k8s evidence pod asl-task-mount project-files mountPath does not match sandbox contract/,
        leakPatterns: [
          /mount-admin-secret/,
          /secret\/mount-smoke/,
          /mount-s3-secret/,
          /mount-juicefs-secret/,
          /runtime accepted/,
          /AGENTSMITH_LITE_TASK_SMOKE_MARKER/
        ]
      },
      {
        name: "subpath-drift",
        fakeKubectl: {
          runId: "run_k8s_subpath",
          podName: "asl-task-subpath",
          resourcePrefix: "asl-subpath",
          subPath: "workspaces/workspace_subpath_drift/projects/project_subpath_drift/other"
        },
        expectedMessage: /k8s evidence pod asl-task-subpath project-files subPath does not match sandbox contract/,
        leakPatterns: [
          /subpath-admin-secret/,
          /secret\/subpath-smoke/,
          /subpath-s3-secret/,
          /subpath-juicefs-secret/,
          /runtime accepted/,
          /AGENTSMITH_LITE_TASK_SMOKE_MARKER/
        ]
      }
    ];

    for (const testCase of cases) {
      const leakSlug = k8sDriftSecretSlug(testCase.name);
      const tempDir = mkdtempSync(path.join(tmpdir(), `agentsmith-lite-k8s-${testCase.name}-`));
      const kubectlCalls = path.join(tempDir, "kubectl-calls.txt");
      const fakeKubectl = writeFakeKubectl(tempDir, testCase.fakeKubectl);
      const server = await startTaskSmokeServer({
        adminPassword: `${leakSlug}-admin-secret`,
        endpointBaseUrl: `https://models.${testCase.name}.test/v1`,
        endpointModel: `${testCase.name}-model`,
        endpointSecretRef: `secret/${leakSlug}-smoke`,
        workspaceId: `workspace_${testCase.name.replaceAll("-", "_")}`,
        projectId: `project_${testCase.name.replaceAll("-", "_")}`,
        endpointId: `endpoint_${testCase.name.replaceAll("-", "_")}`,
        taskId: `task_${testCase.name.replaceAll("-", "_")}`,
        runId: testCase.fakeKubectl.runId,
        subPath: `workspaces/workspace_${testCase.name.replaceAll("-", "_")}/projects/project_${testCase.name.replaceAll("-", "_")}`
      });

      try {
        const result = await runNode([
          "scripts/deploy/app-smoke.mjs",
          "--base-url",
          server.baseUrl,
          "--endpoint-base-url",
          `https://models.${testCase.name}.test/v1`,
          "--endpoint-model",
          `${testCase.name}-model`,
          "--endpoint-secret-ref",
          `secret/${leakSlug}-smoke`,
          "--task-smoke",
          "--k8s-evidence"
        ], {
          BUILTIN_ADMIN_INITIAL_PASSWORD: `${leakSlug}-admin-secret`,
          KUBECTL_BIN: fakeKubectl,
          FAKE_KUBECTL_CALLS: kubectlCalls,
          KUBE_NAMESPACE: "agentsmith-preview",
          S3_SECRET_KEY: `${leakSlug}-s3-secret`,
          JUICEFS_SECRET_KEY: `${leakSlug}-juicefs-secret`
        });

        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, testCase.expectedMessage);
        for (const pattern of testCase.leakPatterns) {
          assert.doesNotMatch(result.stderr, pattern);
        }
        assert.doesNotMatch(result.stderr, /runtime accepted|AGENTSMITH_LITE_TASK_SMOKE_MARKER/);
      } finally {
        await server.close();
      }
    }
  });

  it("app-smoke.mjs appends task reclaim smoke as a separate task with scoped dry-run reap", async () => {
    const adminPassword = "reclaim-admin-secret";
    const requests: SmokeRequest[] = [];
    let taskCreates = 0;
    let eventPolls = 0;
    let artifactPolls = 0;
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
        assert.deepEqual(parsedBody, { password: adminPassword });
        res.end(JSON.stringify({ created: true }));
      } else if (req.method === "POST" && req.url === "/api/auth/login") {
        assert.deepEqual(parsedBody, {
          email: "admin@agentsmith-lite.local",
          password: adminPassword
        });
        res.setHeader("set-cookie", "asl_session=reclaim-session; HttpOnly; Path=/");
        res.end(JSON.stringify({ csrfToken: "csrf-reclaim" }));
      } else if (req.method === "POST" && req.url === "/api/workspaces") {
        assert.deepEqual(parsedBody, { name: "Deploy Smoke" });
        res.end(JSON.stringify({ id: "workspace_reclaim", name: "Deploy Smoke" }));
      } else if (req.method === "POST" && req.url === "/api/workspaces/workspace_reclaim/projects") {
        assert.deepEqual(parsedBody, { name: "API Smoke" });
        res.end(JSON.stringify({ id: "project_reclaim", workspaceId: "workspace_reclaim", name: "API Smoke" }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_reclaim/endpoints") {
        assert.deepEqual(parsedBody, {
          name: "Deploy Smoke Endpoint",
          protocol: "openai_chat_completions",
          baseUrl: "https://models.reclaim.test/v1",
          model: "reclaim-model",
          apiKeySecretRef: "secret/reclaim-smoke",
          capabilities: ["text"],
          requestTimeoutSecs: 30
        });
        res.end(JSON.stringify({ id: "endpoint_reclaim" }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_reclaim/chat") {
        assert.deepEqual(parsedBody, {
          endpointId: "endpoint_reclaim",
          messages: [{ role: "user", content: "deploy smoke" }]
        });
        res.end(JSON.stringify({ message: { role: "assistant", content: "ok" } }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_reclaim/files") {
        assert.deepEqual(parsedBody, {
          path: "files/deploy-smoke.txt",
          content: "hello from deploy smoke\n"
        });
        res.end(JSON.stringify({ path: "files/deploy-smoke.txt", bytes: 24 }));
      } else if (req.method === "GET" && req.url === "/api/projects/project_reclaim/files?path=files") {
        res.end(JSON.stringify({ entries: [{ path: "files/deploy-smoke.txt", type: "file" }] }));
      } else if (req.method === "GET" && req.url === "/api/projects/project_reclaim/files/download?path=files%2Fdeploy-smoke.txt") {
        res.end(JSON.stringify({ path: "files/deploy-smoke.txt", content: "hello from deploy smoke\n" }));
      } else if (req.method === "DELETE" && req.url === "/api/projects/project_reclaim/files") {
        assert.deepEqual(parsedBody, { path: "files/deploy-smoke.txt" });
        res.end(JSON.stringify({ deleted: true }));
      } else if (req.method === "GET" && req.url === "/api/operator/sandbox/status") {
        res.end(JSON.stringify({ namespace: "agentsmith", activeTaskCount: 0, runCounts: {}, observedResourceCounts: {} }));
      } else if (req.method === "GET" && req.url === "/api/operator/sandbox/status?runId=run_reclaim") {
        res.end(JSON.stringify(statusResponse("run_reclaim", {
          activeTaskCount: 1,
          runCounts: { total: 1, cleanupRequested: 1, stopping: 1 },
          observedResourceCounts: { Pod: 1, Secret: 1 },
          cleanupTargetCount: 2
        })));
      } else if (req.method === "GET" && req.url === "/api/operator/sandbox/status?runId=run_smoke_reclaim_case") {
        res.end(JSON.stringify(statusResponse("run_smoke_reclaim_case", {
          activeTaskCount: 1,
          runCounts: { total: 1, active: 1, running: 1 },
          observedResourceCounts: { Pod: 1 },
          cleanupTargetCount: 1
        })));
      } else if (req.method === "POST" && req.url === "/api/projects/project_reclaim/tasks") {
        taskCreates += 1;
        assert.equal(parsedBody.endpointId, "endpoint_reclaim");
        assert.equal(typeof parsedBody.prompt, "string");
        assert.equal(JSON.stringify(parsedBody).includes("secret/reclaim-smoke"), false);
        if (taskCreates === 1) {
          assert.match(parsedBody.prompt as string, /publish_file/);
          assert.match(parsedBody.prompt as string, /AGENTSMITH_LITE_TASK_SMOKE_MARKER/);
          res.end(JSON.stringify({
            id: "task_smoke_reclaim_case",
            runId: "run_smoke_reclaim_case",
            status: "running",
            endpointId: "endpoint_reclaim",
            sandbox: {
              resources: sandboxResources({
                taskId: "task_smoke_reclaim_case",
                runId: "run_smoke_reclaim_case",
                subPath: "workspaces/workspace_reclaim/projects/project_reclaim"
              })
            }
          }));
        } else {
          assert.match(parsedBody.prompt as string, /reclaim/i);
          assert.doesNotMatch(parsedBody.prompt as string, /publish_file/);
          res.end(JSON.stringify({
            id: "task_reclaim",
            runId: "run_reclaim",
            status: "running",
            endpointId: "endpoint_reclaim",
            sandbox: {
              resources: sandboxResources({
                taskId: "task_reclaim",
                runId: "run_reclaim",
                subPath: "workspaces/workspace_reclaim/projects/project_reclaim"
              })
            }
          }));
        }
      } else if (req.method === "GET" && req.url === "/api/tasks/task_smoke_reclaim_case/events") {
        eventPolls += 1;
        res.end(JSON.stringify(eventPolls === 1 ? [{
          id: "event_started",
          taskId: "task_smoke_reclaim_case",
          kind: "turn_started",
          cursor: "c1",
          botifiedSeq: 1,
          botifiedType: "cycle.started",
          sessionId: "session_1",
          payload: {},
          createdAt: "2026-01-01T00:00:00.000Z"
        }] : [{
          id: "event_completed",
          taskId: "task_smoke_reclaim_case",
          kind: "turn_completed",
          cursor: "c2",
          botifiedSeq: 2,
          botifiedType: "cycle.completed",
          sessionId: "session_1",
          payload: {},
          createdAt: "2026-01-01T00:00:01.000Z"
        }]));
      } else if (req.method === "GET" && req.url === "/api/tasks/task_smoke_reclaim_case/artifacts") {
        artifactPolls += 1;
        res.end(JSON.stringify(artifactPolls === 1 ? [] : [{
          id: "artifact_task_smoke_reclaim_case",
          taskId: "task_smoke_reclaim_case",
          fileId: "file_task_smoke_reclaim_case",
          name: "agentsmith-lite-task-smoke.txt",
          bytes: 49,
          createdAt: "2026-01-01T00:00:01.000Z"
        }]));
      } else if (req.method === "GET" && req.url === "/api/tasks/task_smoke_reclaim_case/artifacts/artifact_task_smoke_reclaim_case/download") {
        res.setHeader("content-type", "application/octet-stream");
        res.end("runtime accepted\nAGENTSMITH_LITE_TASK_SMOKE_MARKER\n");
      } else if (req.method === "POST" && req.url === "/api/tasks/task_reclaim/cancel") {
        assert.equal(body, "");
        res.end(JSON.stringify({ id: "task_reclaim", runId: "run_reclaim", status: "stopping" }));
      } else if (req.method === "POST" && req.url === "/api/operator/sandbox/reap") {
        assert.deepEqual(parsedBody, { runId: "run_reclaim" });
        res.end(JSON.stringify({
          namespace: "agentsmith",
          activeTaskCount: 1,
          runCounts: {},
          observedResourceCounts: { Pod: 1, Secret: 1 },
          cleanupPlan: {
            targets: [
              { type: "delete_resource", source: "kubernetes", runId: "run_reclaim", kind: "Pod", name: "asl-task-task_reclaim" },
              { type: "store_run_state", source: "store", runId: "run_reclaim", reason: "cleanup_complete", phase: "stopping", cleanupStatus: "cleaned" }
            ],
            recentFailures: []
          },
          recentCleanupFailures: [],
          actionSummary: [
            { type: "delete_resource", runId: "run_reclaim", kind: "Pod", name: "asl-task-task_reclaim" },
            { type: "store_run_state", runId: "run_reclaim", reason: "cleanup_complete" }
          ],
          errors: [],
          dryRun: true,
          storedRunIds: []
        }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `unexpected ${req.method} ${req.url}` }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const result = await runNode([
        "scripts/deploy/app-smoke.mjs",
        "--base-url",
        baseUrl,
        "--endpoint-base-url",
        "https://models.reclaim.test/v1",
        "--endpoint-model",
        "reclaim-model",
        "--endpoint-secret-ref",
        "secret/reclaim-smoke",
        "--task-smoke",
        "--task-reclaim-smoke"
      ], {
        BUILTIN_ADMIN_INITIAL_PASSWORD: adminPassword
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report, {
        status: "ok",
        profile: "full",
        baseUrl,
        workspaceId: "workspace_reclaim",
        projectId: "project_reclaim",
        evidenceScope: {
          scope: "product-api-only",
          covered: [
            "product-api-health",
            "builtin-admin-auth",
            "workspace-project-api",
            "project-file-api-crud",
            "operator-sandbox-status-api",
            "endpoint-chat-api",
            "task-api-create-events-artifact-download-marker",
            appSmokeSandboxCoverage,
            "task-api-cancel-scoped-reap-dry-run"
          ],
          notCovered: appSmokeNotCovered
        },
        chat: { status: "completed" },
        task: {
          status: "completed",
          taskId: "task_smoke_reclaim_case",
          runId: "run_smoke_reclaim_case",
          createStatus: "running",
          artifactId: "artifact_task_smoke_reclaim_case",
          artifactName: "agentsmith-lite-task-smoke.txt",
          eventCount: 2,
          eventKinds: ["turn_started", "turn_completed"],
          artifactBytes: 51,
          artifactSha256: "5dd3c17fbeb5a93a5f89f4b32eb096f443a8ce3ad643c18d4ea0bba65ac8f9a1",
          markerObserved: true,
          sandboxContract: sandboxContractSummary({
            taskId: "task_smoke_reclaim_case",
            subPath: "workspaces/workspace_reclaim/projects/project_reclaim"
          }),
          runScopedStatus: {
            runId: "run_smoke_reclaim_case",
            activeTaskCount: 1,
            runCounts: { total: 1, active: 1, running: 1 },
            observedResourceCounts: { Pod: 1 },
            cleanupTargetCount: 1,
            errorCount: 0
          }
        },
        taskReclaim: {
          status: "completed",
          taskId: "task_reclaim",
          runId: "run_reclaim",
          createStatus: "running",
          cancelStatus: "stopping",
          sandboxContract: sandboxContractSummary({
            taskId: "task_reclaim",
            subPath: "workspaces/workspace_reclaim/projects/project_reclaim"
          }),
          reapScope: {
            scopedToRunId: true,
            applyEnabled: false
          },
          runScopedStatus: {
            runId: "run_reclaim",
            activeTaskCount: 1,
            runCounts: { total: 1, cleanupRequested: 1, stopping: 1 },
            observedResourceCounts: { Pod: 1, Secret: 1 },
            cleanupTargetCount: 2,
            errorCount: 0
          },
          reap: {
            dryRun: {
              dryRun: true,
              actionCount: 2,
              cleanupTargetCount: 2,
              errorCount: 0,
              storedRunIds: []
            }
          }
        }
      });
      assert.doesNotMatch(result.stdout, new RegExp(escapeRegExp(adminPassword)));
      assert.doesNotMatch(result.stdout, /secret\/reclaim-smoke/);
      assert.doesNotMatch(result.stdout, /BOTIFIED_SERVICE_KEY|reclaim-service-key-secret/);
      assert.doesNotMatch(result.stdout, /runtime accepted/);
      assert.doesNotMatch(result.stdout, /AGENTSMITH_LITE_TASK_SMOKE_MARKER/);
      assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
        "GET /api/health",
        "POST /api/auth/bootstrap",
        "POST /api/auth/login",
        "POST /api/workspaces",
        "POST /api/workspaces/workspace_reclaim/projects",
        "POST /api/projects/project_reclaim/endpoints",
        "POST /api/projects/project_reclaim/chat",
        "POST /api/projects/project_reclaim/files",
        "GET /api/projects/project_reclaim/files?path=files",
        "GET /api/projects/project_reclaim/files/download?path=files%2Fdeploy-smoke.txt",
        "DELETE /api/projects/project_reclaim/files",
        "GET /api/operator/sandbox/status",
        "POST /api/projects/project_reclaim/tasks",
        "GET /api/tasks/task_smoke_reclaim_case/events",
        "GET /api/tasks/task_smoke_reclaim_case/artifacts",
        "GET /api/tasks/task_smoke_reclaim_case/events",
        "GET /api/tasks/task_smoke_reclaim_case/artifacts",
        "GET /api/tasks/task_smoke_reclaim_case/artifacts/artifact_task_smoke_reclaim_case/download",
        "GET /api/operator/sandbox/status?runId=run_smoke_reclaim_case",
        "POST /api/projects/project_reclaim/tasks",
        "POST /api/tasks/task_reclaim/cancel",
        "GET /api/operator/sandbox/status?runId=run_reclaim",
        "POST /api/operator/sandbox/reap"
      ]);
      assert.equal(taskCreates, 2);
      const reapRequests = requests.filter((request) => request.url === "/api/operator/sandbox/reap");
      assert.equal(reapRequests.length, 1);
      const reapRequest = reapRequests[0];
      assert.ok(reapRequest);
      assert.deepEqual(JSON.parse(reapRequest.body), { runId: "run_reclaim" });
      for (const request of requests.filter((candidate) => candidate.url?.startsWith("/api/tasks/") || candidate.url === "/api/operator/sandbox/reap")) {
        assert.equal(request.cookie, "asl_session=reclaim-session", `${request.method} ${request.url} missing session cookie`);
        assert.equal(request.csrf, "csrf-reclaim", `${request.method} ${request.url} missing csrf token`);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("app-smoke.mjs can opt in to scoped reclaim reap apply without any unscoped apply", async () => {
    const adminPassword = "apply-admin-secret";
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-app-smoke-reclaim-report-"));
    const reportPath = path.join(tempDir, "reports", "smoke-report.json");
    const requests: SmokeRequest[] = [];
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
        res.end(JSON.stringify({ created: true }));
      } else if (req.method === "POST" && req.url === "/api/auth/login") {
        res.setHeader("set-cookie", "asl_session=apply-session; HttpOnly; Path=/");
        res.end(JSON.stringify({ csrfToken: "csrf-apply" }));
      } else if (req.method === "POST" && req.url === "/api/workspaces") {
        res.end(JSON.stringify({ id: "workspace_apply", name: "Deploy Smoke" }));
      } else if (req.method === "POST" && req.url === "/api/workspaces/workspace_apply/projects") {
        res.end(JSON.stringify({ id: "project_apply", workspaceId: "workspace_apply", name: "API Smoke" }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_apply/endpoints") {
        assert.deepEqual(parsedBody, {
          name: "Deploy Smoke Endpoint",
          protocol: "openai_chat_completions",
          baseUrl: "https://models.apply.test/v1",
          model: "apply-model",
          apiKeySecretRef: "secret/apply-smoke",
          capabilities: ["text"],
          requestTimeoutSecs: 30
        });
        res.end(JSON.stringify({ id: "endpoint_apply" }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_apply/chat") {
        res.end(JSON.stringify({ message: { role: "assistant", content: "ok" } }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_apply/files") {
        res.end(JSON.stringify({ path: "files/deploy-smoke.txt", bytes: 24 }));
      } else if (req.method === "GET" && req.url === "/api/projects/project_apply/files?path=files") {
        res.end(JSON.stringify({ entries: [{ path: "files/deploy-smoke.txt", type: "file" }] }));
      } else if (req.method === "GET" && req.url === "/api/projects/project_apply/files/download?path=files%2Fdeploy-smoke.txt") {
        res.end(JSON.stringify({ path: "files/deploy-smoke.txt", content: "hello from deploy smoke\n" }));
      } else if (req.method === "DELETE" && req.url === "/api/projects/project_apply/files") {
        res.end(JSON.stringify({ deleted: true }));
      } else if (req.method === "GET" && req.url === "/api/operator/sandbox/status") {
        res.end(JSON.stringify({ namespace: "agentsmith", activeTaskCount: 0, runCounts: {}, observedResourceCounts: {} }));
      } else if (req.method === "GET" && req.url === "/api/operator/sandbox/status?runId=run_reclaim_apply") {
        res.end(JSON.stringify(statusResponse("run_reclaim_apply", {
          activeTaskCount: 1,
          runCounts: { total: 1, cleanupRequested: 1, stopping: 1 },
          observedResourceCounts: { Pod: 1, ConfigMap: 1 },
          cleanupTargetCount: 3
        })));
      } else if (req.method === "POST" && req.url === "/api/projects/project_apply/tasks") {
        assert.equal(parsedBody.endpointId, "endpoint_apply");
        res.end(JSON.stringify({
          id: "task_reclaim_apply",
          runId: "run_reclaim_apply",
          status: "running",
          endpointId: "endpoint_apply",
          sandbox: {
            resources: sandboxResources({
              taskId: "task_reclaim_apply",
              runId: "run_reclaim_apply",
              subPath: "workspaces/workspace_apply/projects/project_apply"
            })
          }
        }));
      } else if (req.method === "POST" && req.url === "/api/tasks/task_reclaim_apply/cancel") {
        assert.equal(body, "");
        res.end(JSON.stringify({ id: "task_reclaim_apply", runId: "run_reclaim_apply", status: "stopping" }));
      } else if (req.method === "POST" && req.url === "/api/operator/sandbox/reap") {
        reapCalls += 1;
        if (reapCalls === 1) {
          assert.deepEqual(parsedBody, { runId: "run_reclaim_apply" });
          res.end(JSON.stringify(reapResponse(true, 2, 2, [])));
        } else if (reapCalls === 2) {
          assert.deepEqual(parsedBody, { runId: "run_reclaim_apply", apply: true });
          res.end(JSON.stringify(reapResponse(false, 3, 1, ["run_reclaim_apply"])));
        } else {
          assert.deepEqual(parsedBody, { runId: "run_reclaim_apply" });
          res.end(JSON.stringify(reapResponse(true, 0, 0, [])));
        }
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `unexpected ${req.method} ${req.url}` }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const result = await runNode([
        "scripts/deploy/app-smoke.mjs",
        "--base-url",
        baseUrl,
        "--endpoint-base-url",
        "https://models.apply.test/v1",
        "--endpoint-model",
        "apply-model",
        "--endpoint-secret-ref",
        "secret/apply-smoke",
        "--task-reclaim-smoke",
        "--task-reclaim-reap-apply",
        "--report",
        reportPath
      ], {
        BUILTIN_ADMIN_INITIAL_PASSWORD: adminPassword
      });

      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report, {
        status: "ok",
        profile: "full",
        baseUrl,
        workspaceId: "workspace_apply",
        projectId: "project_apply",
        evidenceScope: {
          scope: "product-api-only",
          covered: [
            "product-api-health",
            "builtin-admin-auth",
            "workspace-project-api",
            "project-file-api-crud",
            "operator-sandbox-status-api",
            "endpoint-chat-api",
            appSmokeSandboxCoverage,
            "task-api-cancel-scoped-reap-dry-run",
            "task-api-cancel-scoped-reap-apply",
            "task-api-cancel-scoped-reap-final-dry-run"
          ],
          notCovered: appSmokeNotCovered
        },
        chat: { status: "completed" },
        task: { status: "skipped" },
        taskReclaim: {
          status: "completed",
          taskId: "task_reclaim_apply",
          runId: "run_reclaim_apply",
          createStatus: "running",
          cancelStatus: "stopping",
          sandboxContract: sandboxContractSummary({
            taskId: "task_reclaim_apply",
            subPath: "workspaces/workspace_apply/projects/project_apply"
          }),
          reapScope: {
            scopedToRunId: true,
            applyEnabled: true
          },
          runScopedStatus: {
            runId: "run_reclaim_apply",
            activeTaskCount: 1,
            runCounts: { total: 1, cleanupRequested: 1, stopping: 1 },
            observedResourceCounts: { Pod: 1, ConfigMap: 1 },
            cleanupTargetCount: 3,
            errorCount: 0
          },
          reap: {
            dryRun: {
              dryRun: true,
              actionCount: 2,
              cleanupTargetCount: 2,
              errorCount: 0,
              storedRunIds: []
            },
            apply: {
              dryRun: false,
              actionCount: 3,
              cleanupTargetCount: 1,
              errorCount: 0,
              storedRunIds: ["run_reclaim_apply"]
            },
            finalDryRun: {
              dryRun: true,
              actionCount: 0,
              cleanupTargetCount: 0,
              errorCount: 0,
              storedRunIds: []
            }
          }
        }
      });
      assert.equal(readFileSync(reportPath, "utf8"), result.stdout);
      assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), report);
      assert.doesNotMatch(result.stdout, new RegExp(escapeRegExp(adminPassword)));
      assert.doesNotMatch(result.stdout, /secret\/apply-smoke/);
      assert.doesNotMatch(readFileSync(reportPath, "utf8"), new RegExp(escapeRegExp(adminPassword)));
      assert.doesNotMatch(readFileSync(reportPath, "utf8"), /secret\/apply-smoke/);
      assert.equal(reapCalls, 3);
      assert.deepEqual(requests.filter((request) => request.url === "/api/operator/sandbox/reap").map((request) => JSON.parse(request.body)), [
        { runId: "run_reclaim_apply" },
        { runId: "run_reclaim_apply", apply: true },
        { runId: "run_reclaim_apply" }
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("app-smoke.mjs rejects task sandbox contract gaps and env drift without leaking response secrets", async () => {
    const cases: Array<{
      name: string;
      expectedMessage: RegExp;
      env?: Record<string, string>;
      resources: (ids: { taskId: string; runId: string; projectId: string; workspaceId: string }) => unknown[];
      leakPatterns: RegExp[];
    }> = [
      {
        name: "missing-pod",
        expectedMessage: /task smoke sandbox\.resources must contain exactly one Pod/,
        resources: () => [
          {
            kind: "Secret",
            metadata: {
              name: "asl-botified-missing-pod",
              annotations: {
                endpoint: "https://leaky.missing-pod.test/v1"
              }
            },
            stringData: {
              BOTIFIED_SERVICE_KEY: "missing-pod-service-key-secret",
              MODEL_API_KEY: "sk-missing-pod-model-key"
            }
          }
        ],
        leakPatterns: [
          /missing-pod-admin-secret/,
          /secret\/missing-pod-smoke/,
          /missing-pod-service-key-secret/,
          /sk-missing-pod-model-key/,
          /https:\/\/models\.missing-pod\.test\/v1/,
          /https:\/\/leaky\.missing-pod\.test\/v1/
        ]
      },
      {
        name: "image-drift",
        expectedMessage: /task smoke botified-runner image does not match BOTIFIED_RUNNER_IMAGE/,
        env: {
          BOTIFIED_RUNNER_IMAGE: "registry.example.test/agentsmith/botified-runner@sha256:2222222222222222222222222222222222222222222222222222222222222222"
        },
        resources: ({ taskId, runId, projectId, workspaceId }) => sandboxResources({
          taskId,
          runId,
          subPath: `workspaces/${workspaceId}/projects/${projectId}`,
          runnerImage: "registry.example.test/agentsmith/botified-runner@sha256:3333333333333333333333333333333333333333333333333333333333333333",
          serviceKey: "image-drift-service-key-secret",
          modelKey: "sk-image-drift-model-key"
        }),
        leakPatterns: [
          /image-drift-admin-secret/,
          /secret\/image-drift-smoke/,
          /image-drift-service-key-secret/,
          /sk-image-drift-model-key/,
          /https:\/\/models\.image-drift\.test\/v1/,
          /sha256:2222222222222222222222222222222222222222222222222222222222222222/,
          /sha256:3333333333333333333333333333333333333333333333333333333333333333/
        ]
      },
      {
        name: "pvc-drift",
        expectedMessage: /task smoke project-files PVC claimName does not match JUICEFS_PVC_NAME/,
        env: {
          JUICEFS_PVC_NAME: "agentsmith-lite-prod-files"
        },
        resources: ({ taskId, runId, projectId, workspaceId }) => sandboxResources({
          taskId,
          runId,
          subPath: `workspaces/${workspaceId}/projects/${projectId}`,
          pvcClaimName: "agentsmith-lite-other-files",
          serviceKey: "pvc-drift-service-key-secret",
          modelKey: "sk-pvc-drift-model-key"
        }),
        leakPatterns: [
          /pvc-drift-admin-secret/,
          /secret\/pvc-drift-smoke/,
          /pvc-drift-service-key-secret/,
          /sk-pvc-drift-model-key/,
          /https:\/\/models\.pvc-drift\.test\/v1/,
          /agentsmith-lite-prod-files/,
          /agentsmith-lite-other-files/
        ]
      },
      {
        name: "live-tag",
        expectedMessage: /task smoke live sandbox botified-runner image must be digest pinned/,
        env: {
          AGENTSMITH_LITE_SANDBOX_MODE: "live"
        },
        resources: ({ taskId, runId, projectId, workspaceId }) => sandboxResources({
          taskId,
          runId,
          subPath: `workspaces/${workspaceId}/projects/${projectId}`,
          runnerImage: "agentsmith-lite/botified-runner:dev",
          serviceKey: "live-tag-service-key-secret",
          modelKey: "sk-live-tag-model-key"
        }),
        leakPatterns: [
          /live-tag-admin-secret/,
          /secret\/live-tag-smoke/,
          /live-tag-service-key-secret/,
          /sk-live-tag-model-key/,
          /https:\/\/models\.live-tag\.test\/v1/,
          /agentsmith-lite\/botified-runner:dev/
        ]
      }
    ];

    for (const testCase of cases) {
      const slug = testCase.name.replaceAll("-", "_");
      const adminPassword = `${testCase.name}-admin-secret`;
      const workspaceId = `workspace_${slug}`;
      const projectId = `project_${slug}`;
      const endpointId = `endpoint_${slug}`;
      const taskId = `task_${slug}`;
      const runId = `run_${slug}`;
      const requests: SmokeRequest[] = [];
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
          assert.deepEqual(parsedBody, { password: adminPassword });
          res.end(JSON.stringify({ created: true }));
        } else if (req.method === "POST" && req.url === "/api/auth/login") {
          res.setHeader("set-cookie", `asl_session=${slug}-session; HttpOnly; Path=/`);
          res.end(JSON.stringify({ csrfToken: `csrf-${slug}` }));
        } else if (req.method === "POST" && req.url === "/api/workspaces") {
          res.end(JSON.stringify({ id: workspaceId, name: "Deploy Smoke" }));
        } else if (req.method === "POST" && req.url === `/api/workspaces/${workspaceId}/projects`) {
          res.end(JSON.stringify({ id: projectId, workspaceId, name: "API Smoke" }));
        } else if (req.method === "POST" && req.url === `/api/projects/${projectId}/endpoints`) {
          assert.deepEqual(parsedBody, {
            name: "Deploy Smoke Endpoint",
            protocol: "openai_chat_completions",
            baseUrl: `https://models.${testCase.name}.test/v1`,
            model: `${testCase.name}-model`,
            apiKeySecretRef: `secret/${testCase.name}-smoke`,
            capabilities: ["text"],
            requestTimeoutSecs: 30
          });
          res.end(JSON.stringify({ id: endpointId }));
        } else if (req.method === "POST" && req.url === `/api/projects/${projectId}/chat`) {
          res.end(JSON.stringify({ message: { role: "assistant", content: "ok" } }));
        } else if (req.method === "POST" && req.url === `/api/projects/${projectId}/files`) {
          res.end(JSON.stringify({ path: "files/deploy-smoke.txt", bytes: 24 }));
        } else if (req.method === "GET" && req.url === `/api/projects/${projectId}/files?path=files`) {
          res.end(JSON.stringify({ entries: [{ path: "files/deploy-smoke.txt", type: "file" }] }));
        } else if (req.method === "GET" && req.url === `/api/projects/${projectId}/files/download?path=files%2Fdeploy-smoke.txt`) {
          res.end(JSON.stringify({ path: "files/deploy-smoke.txt", content: "hello from deploy smoke\n" }));
        } else if (req.method === "DELETE" && req.url === `/api/projects/${projectId}/files`) {
          res.end(JSON.stringify({ deleted: true }));
        } else if (req.method === "GET" && req.url === "/api/operator/sandbox/status") {
          res.end(JSON.stringify({ namespace: "agentsmith", activeTaskCount: 0 }));
        } else if (req.method === "GET" && req.url === `/api/operator/sandbox/status?runId=${runId}`) {
          res.end(JSON.stringify(statusResponse(runId, {
            activeTaskCount: 1,
            runCounts: { total: 1, active: 1, running: 1 },
            observedResourceCounts: { Pod: 1 },
            cleanupTargetCount: 1
          })));
        } else if (req.method === "POST" && req.url === `/api/projects/${projectId}/tasks`) {
          assert.equal(parsedBody.endpointId, endpointId);
          res.end(JSON.stringify({
            id: taskId,
            runId,
            status: "running",
            sandbox: {
              resources: testCase.resources({ taskId, runId, projectId, workspaceId })
            }
          }));
        } else if (req.method === "GET" && req.url === `/api/tasks/${taskId}/events`) {
          res.end(JSON.stringify([]));
        } else if (req.method === "GET" && req.url === `/api/tasks/${taskId}/artifacts`) {
          res.end(JSON.stringify([{
            id: `artifact_${slug}`,
            taskId,
            fileId: `file_${slug}`,
            name: "agentsmith-lite-task-smoke.txt",
            bytes: 51,
            createdAt: "2026-01-01T00:00:01.000Z"
          }]));
        } else if (req.method === "GET" && req.url === `/api/tasks/${taskId}/artifacts/artifact_${slug}/download`) {
          res.setHeader("content-type", "application/octet-stream");
          res.end("runtime accepted\nAGENTSMITH_LITE_TASK_SMOKE_MARKER\n");
        } else if (req.method === "POST" && req.url === `/api/tasks/${taskId}/cancel`) {
          assert.equal(body, "");
          res.end(JSON.stringify({ id: taskId, runId, status: "stopping" }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: `unexpected ${req.method} ${req.url}` }));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      try {
        const result = await runNode([
          "scripts/deploy/app-smoke.mjs",
          "--base-url",
          baseUrl,
          "--endpoint-base-url",
          `https://models.${testCase.name}.test/v1`,
          "--endpoint-model",
          `${testCase.name}-model`,
          "--endpoint-secret-ref",
          `secret/${testCase.name}-smoke`,
          "--task-smoke"
        ], {
          BUILTIN_ADMIN_INITIAL_PASSWORD: adminPassword,
          ...(testCase.env ?? {})
        });

        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, testCase.expectedMessage);
        for (const pattern of testCase.leakPatterns) {
          assert.doesNotMatch(result.stderr, pattern);
        }
        assert.doesNotMatch(result.stderr, /runtime accepted|AGENTSMITH_LITE_TASK_SMOKE_MARKER/);
        assert.deepEqual(requests.filter((request) => (
          request.url === `/api/projects/${projectId}/tasks` ||
          request.url?.startsWith(`/api/tasks/${taskId}`)
        )).map((request) => `${request.method} ${request.url}`), [
          `POST /api/projects/${projectId}/tasks`,
          `POST /api/tasks/${taskId}/cancel`
        ]);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    }
  });

  it("app-smoke.mjs cancels best-effort when task artifact verification fails without leaking secrets", async () => {
    const adminPassword = "mismatch-admin-secret";
    const requests: SmokeRequest[] = [];
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
        assert.deepEqual(parsedBody, { password: adminPassword });
        res.end(JSON.stringify({ created: true }));
      } else if (req.method === "POST" && req.url === "/api/auth/login") {
        res.setHeader("set-cookie", "asl_session=mismatch-session; HttpOnly; Path=/");
        res.end(JSON.stringify({ csrfToken: "csrf-mismatch" }));
      } else if (req.method === "POST" && req.url === "/api/workspaces") {
        res.end(JSON.stringify({ id: "workspace_mismatch", name: "Deploy Smoke" }));
      } else if (req.method === "POST" && req.url === "/api/workspaces/workspace_mismatch/projects") {
        res.end(JSON.stringify({ id: "project_mismatch", workspaceId: "workspace_mismatch", name: "API Smoke" }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_mismatch/endpoints") {
        assert.deepEqual(parsedBody, {
          name: "Deploy Smoke Endpoint",
          protocol: "openai_chat_completions",
          baseUrl: "https://models.mismatch.test/v1",
          model: "mismatch-model",
          apiKeySecretRef: "secret/mismatch-smoke",
          capabilities: ["text"],
          requestTimeoutSecs: 30
        });
        res.end(JSON.stringify({ id: "endpoint_mismatch" }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_mismatch/chat") {
        res.end(JSON.stringify({ message: { role: "assistant", content: "ok" } }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_mismatch/files") {
        res.end(JSON.stringify({ path: "files/deploy-smoke.txt", bytes: 24 }));
      } else if (req.method === "GET" && req.url === "/api/projects/project_mismatch/files?path=files") {
        res.end(JSON.stringify({ entries: [{ path: "files/deploy-smoke.txt", type: "file" }] }));
      } else if (req.method === "GET" && req.url === "/api/projects/project_mismatch/files/download?path=files%2Fdeploy-smoke.txt") {
        res.end(JSON.stringify({ path: "files/deploy-smoke.txt", content: "hello from deploy smoke\n" }));
      } else if (req.method === "DELETE" && req.url === "/api/projects/project_mismatch/files") {
        res.end(JSON.stringify({ deleted: true }));
      } else if (req.method === "GET" && req.url === "/api/operator/sandbox/status") {
        res.end(JSON.stringify({ namespace: "agentsmith", activeTaskCount: 0 }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_mismatch/tasks") {
        assert.equal(JSON.stringify(parsedBody).includes("secret/mismatch-smoke"), false);
        res.end(JSON.stringify({
          id: "task_mismatch",
          runId: "run_mismatch",
          status: "running",
          sandbox: {
            resources: sandboxResources({
              taskId: "task_mismatch",
              runId: "run_mismatch",
              subPath: "workspaces/workspace_mismatch/projects/project_mismatch",
              serviceKey: "mismatch-service-key-secret"
            })
          }
        }));
      } else if (req.method === "GET" && req.url === "/api/tasks/task_mismatch/events") {
        res.end(JSON.stringify([]));
      } else if (req.method === "GET" && req.url === "/api/tasks/task_mismatch/artifacts") {
        res.end(JSON.stringify([{
          id: "artifact_mismatch",
          taskId: "task_mismatch",
          fileId: "file_mismatch",
          name: "agentsmith-lite-task-smoke.txt",
          bytes: 13,
          createdAt: "2026-01-01T00:00:01.000Z"
        }]));
      } else if (req.method === "GET" && req.url === "/api/tasks/task_mismatch/artifacts/artifact_mismatch/download") {
        res.setHeader("content-type", "application/octet-stream");
        res.end("wrong content\n");
      } else if (req.method === "POST" && req.url === "/api/tasks/task_mismatch/cancel") {
        assert.equal(body, "");
        res.end(JSON.stringify({ id: "task_mismatch", status: "stopping" }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `unexpected ${req.method} ${req.url}` }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const result = await runNode([
        "scripts/deploy/app-smoke.mjs",
        "--base-url",
        baseUrl,
        "--endpoint-base-url",
        "https://models.mismatch.test/v1",
        "--endpoint-model",
        "mismatch-model",
        "--endpoint-secret-ref",
        "secret/mismatch-smoke",
        "--task-smoke"
      ], {
        BUILTIN_ADMIN_INITIAL_PASSWORD: adminPassword
      });

      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /artifact artifact_mismatch did not contain task smoke marker/);
      assert.doesNotMatch(result.stderr, new RegExp(escapeRegExp(adminPassword)));
      assert.doesNotMatch(result.stderr, /secret\/mismatch-smoke/);
      assert.doesNotMatch(result.stderr, /BOTIFIED_SERVICE_KEY|mismatch-service-key-secret/);
      assert.deepEqual(requests.filter((request) => request.url?.startsWith("/api/tasks/")).map((request) => `${request.method} ${request.url}`), [
        "GET /api/tasks/task_mismatch/events",
        "GET /api/tasks/task_mismatch/artifacts",
        "GET /api/tasks/task_mismatch/artifacts/artifact_mismatch/download",
        "POST /api/tasks/task_mismatch/cancel"
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("app-smoke.mjs rejects task smoke without runId and cancels without leaking secrets or artifacts", async () => {
    const adminPassword = "missing-run-admin-secret";
    const requests: SmokeRequest[] = [];
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
        assert.deepEqual(parsedBody, { password: adminPassword });
        res.end(JSON.stringify({ created: true }));
      } else if (req.method === "POST" && req.url === "/api/auth/login") {
        res.setHeader("set-cookie", "asl_session=missing-run-session; HttpOnly; Path=/");
        res.end(JSON.stringify({ csrfToken: "csrf-missing-run" }));
      } else if (req.method === "POST" && req.url === "/api/workspaces") {
        res.end(JSON.stringify({ id: "workspace_missing_run", name: "Deploy Smoke" }));
      } else if (req.method === "POST" && req.url === "/api/workspaces/workspace_missing_run/projects") {
        res.end(JSON.stringify({ id: "project_missing_run", workspaceId: "workspace_missing_run", name: "API Smoke" }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_missing_run/endpoints") {
        assert.deepEqual(parsedBody, {
          name: "Deploy Smoke Endpoint",
          protocol: "openai_chat_completions",
          baseUrl: "https://models.missing-run.test/v1",
          model: "missing-run-model",
          apiKeySecretRef: "secret/missing-run-smoke",
          capabilities: ["text"],
          requestTimeoutSecs: 30
        });
        res.end(JSON.stringify({ id: "endpoint_missing_run" }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_missing_run/chat") {
        res.end(JSON.stringify({ message: { role: "assistant", content: "ok" } }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_missing_run/files") {
        res.end(JSON.stringify({ path: "files/deploy-smoke.txt", bytes: 24 }));
      } else if (req.method === "GET" && req.url === "/api/projects/project_missing_run/files?path=files") {
        res.end(JSON.stringify({ entries: [{ path: "files/deploy-smoke.txt", type: "file" }] }));
      } else if (req.method === "GET" && req.url === "/api/projects/project_missing_run/files/download?path=files%2Fdeploy-smoke.txt") {
        res.end(JSON.stringify({ path: "files/deploy-smoke.txt", content: "hello from deploy smoke\n" }));
      } else if (req.method === "DELETE" && req.url === "/api/projects/project_missing_run/files") {
        res.end(JSON.stringify({ deleted: true }));
      } else if (req.method === "GET" && req.url === "/api/operator/sandbox/status") {
        res.end(JSON.stringify({ namespace: "agentsmith", activeTaskCount: 0 }));
      } else if (req.method === "POST" && req.url === "/api/projects/project_missing_run/tasks") {
        assert.equal(JSON.stringify(parsedBody).includes("secret/missing-run-smoke"), false);
        res.end(JSON.stringify({
          id: "task_missing_run",
          status: "running",
          sandbox: {
            resources: [
              { kind: "Secret", stringData: { BOTIFIED_SERVICE_KEY: "missing-run-service-key-secret" } }
            ]
          }
        }));
      } else if (req.method === "GET" && req.url === "/api/tasks/task_missing_run/events") {
        res.end(JSON.stringify([{ id: "event_missing_run", kind: "turn_completed" }]));
      } else if (req.method === "GET" && req.url === "/api/tasks/task_missing_run/artifacts") {
        res.end(JSON.stringify([{
          id: "artifact_missing_run",
          taskId: "task_missing_run",
          fileId: "file_missing_run",
          name: "agentsmith-lite-task-smoke.txt",
          bytes: 51,
          createdAt: "2026-01-01T00:00:01.000Z"
        }]));
      } else if (req.method === "GET" && req.url === "/api/tasks/task_missing_run/artifacts/artifact_missing_run/download") {
        res.setHeader("content-type", "application/octet-stream");
        res.end("runtime accepted\nAGENTSMITH_LITE_TASK_SMOKE_MARKER\n");
      } else if (req.method === "POST" && req.url === "/api/tasks/task_missing_run/cancel") {
        assert.equal(body, "");
        res.end(JSON.stringify({ id: "task_missing_run", status: "stopping" }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `unexpected ${req.method} ${req.url}` }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const result = await runNode([
        "scripts/deploy/app-smoke.mjs",
        "--base-url",
        baseUrl,
        "--endpoint-base-url",
        "https://models.missing-run.test/v1",
        "--endpoint-model",
        "missing-run-model",
        "--endpoint-secret-ref",
        "secret/missing-run-smoke",
        "--task-smoke"
      ], {
        BUILTIN_ADMIN_INITIAL_PASSWORD: adminPassword
      });

      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /task run id missing from API response/);
      assert.doesNotMatch(result.stderr, new RegExp(escapeRegExp(adminPassword)));
      assert.doesNotMatch(result.stderr, /secret\/missing-run-smoke/);
      assert.doesNotMatch(result.stderr, /BOTIFIED_SERVICE_KEY|missing-run-service-key-secret/);
      assert.doesNotMatch(result.stderr, /runtime accepted|AGENTSMITH_LITE_TASK_SMOKE_MARKER/);
      assert.deepEqual(requests.filter((request) => (
        request.url === "/api/projects/project_missing_run/tasks" ||
        request.url?.startsWith("/api/tasks/task_missing_run")
      )).map((request) => `${request.method} ${request.url}`), [
        "POST /api/projects/project_missing_run/tasks",
        "POST /api/tasks/task_missing_run/cancel"
      ]);
      assert.equal(requests.some((request) => request.url?.startsWith("/api/operator/sandbox/status?runId=")), false);
      const cancel = requests.find((request) => request.url === "/api/tasks/task_missing_run/cancel");
      assert.ok(cancel);
      assert.equal(cancel.cookie, "asl_session=missing-run-session");
      assert.equal(cancel.csrf, "csrf-missing-run");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("app-smoke.mjs rejects task smoke before HTTP when endpoint config is incomplete", async () => {
    let requestCount = 0;
    const server = createServer((_req, res) => {
      requestCount += 1;
      res.statusCode = 500;
      res.end("unexpected request");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const result = await runNode([
        "scripts/deploy/app-smoke.mjs",
        "--base-url",
        baseUrl,
        "--task-smoke"
      ], {
        BUILTIN_ADMIN_INITIAL_PASSWORD: "admin-secret"
      });

      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /task smoke requires endpoint smoke config/i);
      assert.equal(requestCount, 0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("app-smoke.mjs strictly parses SMOKE_TASK before HTTP", async () => {
    let requestCount = 0;
    const server = createServer((_req, res) => {
      requestCount += 1;
      res.statusCode = 500;
      res.end("unexpected request");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const result = await runNode([
        "scripts/deploy/app-smoke.mjs",
        "--base-url",
        baseUrl,
        "--task-smoke"
      ], {
        BUILTIN_ADMIN_INITIAL_PASSWORD: "admin-secret",
        SMOKE_TASK: "yes"
      });

      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /SMOKE_TASK must be true, false, empty, or unset/);
      assert.equal(requestCount, 0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("app-smoke.mjs strictly parses SMOKE_TASK_TIMEOUT_SECS before HTTP", async () => {
    let requestCount = 0;
    const server = createServer((_req, res) => {
      requestCount += 1;
      res.statusCode = 500;
      res.end("unexpected request");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const result = await runNode([
        "scripts/deploy/app-smoke.mjs",
        "--base-url",
        baseUrl,
        "--endpoint-base-url",
        "https://models.timeout.test/v1",
        "--endpoint-model",
        "timeout-model",
        "--endpoint-secret-ref",
        "secret/timeout-smoke",
        "--task-smoke"
      ], {
        BUILTIN_ADMIN_INITIAL_PASSWORD: "admin-secret",
        SMOKE_TASK_TIMEOUT_SECS: "0"
      });

      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /SMOKE_TASK_TIMEOUT_SECS must be a positive integer/);
      assert.doesNotMatch(result.stderr, /secret\/timeout-smoke/);
      assert.equal(requestCount, 0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("app-smoke.mjs validates task reclaim smoke options before HTTP", async () => {
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
          env: { SMOKE_TASK_RECLAIM: "yes" },
          message: /SMOKE_TASK_RECLAIM must be true, false, empty, or unset/
        },
        {
          env: { SMOKE_TASK_RECLAIM_REAP_APPLY: "yes" },
          message: /SMOKE_TASK_RECLAIM_REAP_APPLY must be true, false, empty, or unset/
        },
        {
          env: { SMOKE_TASK_RECLAIM_REAP_APPLY: "true" },
          message: /task reclaim reap apply requires task reclaim smoke/
        },
        {
          args: ["--task-reclaim-reap-apply"],
          message: /task reclaim reap apply requires task reclaim smoke/
        },
        {
          args: ["--task-reclaim-smoke"],
          message: /task reclaim smoke requires endpoint smoke config/
        }
      ];
      for (const testCase of cases) {
        const result = await runNode([
          "scripts/deploy/app-smoke.mjs",
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

interface SmokeRequest {
  method: string | undefined;
  url: string | undefined;
  cookie: string | undefined;
  csrf: string | undefined;
  body: string;
}

interface EvidenceScope {
  scope: string;
  covered: string[];
  notCovered: string[];
}

interface FakeKubectlOptions {
  runId: string;
  podName: string;
  resourcePrefix: string;
  observedRunId?: string;
  runnerImage?: string;
  runnerImageID?: string;
  pvcClaimName?: string;
  mountPath?: string;
  subPath?: string;
}

function assertLightEvidenceDoesNotClaimExternal(evidenceScope: EvidenceScope): void {
  assert.equal(evidenceScope.scope, "product-api-only");
  assert.deepEqual(evidenceScope.notCovered, appSmokeNotCovered);
  assert.equal(
    evidenceScope.covered.some((item) => /k8s|juicefs|full-external|external-evidence/i.test(item)),
    false
  );
}

function runNode(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SMOKE_TASK: "",
        SMOKE_TASK_RECLAIM: "",
        SMOKE_TASK_RECLAIM_REAP_APPLY: "",
        SMOKE_ENDPOINT_BASE_URL: "",
        SMOKE_ENDPOINT_MODEL: "",
        SMOKE_ENDPOINT_SECRET_REF: "",
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

function k8sDriftSecretSlug(name: string): string {
  if (name === "non-digest-runner") {
    return "bad-image";
  }
  if (name === "run-id-label-mismatch") {
    return "label";
  }
  if (name === "pvc-claim-drift") {
    return "pvc";
  }
  if (name === "mount-path-drift") {
    return "mount";
  }
  if (name === "subpath-drift") {
    return "subpath";
  }
  return name;
}

function writeFakeKubectl(tempDir: string, options: FakeKubectlOptions): string {
  const fakeKubectl = path.join(tempDir, "kubectl");
  const runnerImage = options.runnerImage ?? defaultSandboxRunnerImage;
  const runnerImageID = options.runnerImageID ?? "docker-pullable://registry.example.test/agentsmith/botified-runner@sha256:1111111111111111111111111111111111111111111111111111111111111111";
  const observedRunId = options.observedRunId ?? options.runId;
  const pvcClaimName = options.pvcClaimName ?? defaultSandboxPvcClaimName;
  const mountPath = options.mountPath ?? "/workspace/project";
  const subPath = options.subPath ?? "workspaces/workspace_k8s/projects/project_k8s";
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
has_namespace=false
has_label=false
has_output=false
output_value=
previous=
for arg in "$@"; do
  if [ "$previous" = "-n" ] && [ "$arg" = "agentsmith-preview" ]; then
    has_namespace=true
  fi
  if [ "$previous" = "-l" ] && [ "$arg" = "agentsmith-lite/run-id=${options.runId}" ]; then
    has_label=true
  fi
  if [ "$previous" = "-o" ]; then
    has_output=true
    output_value="$arg"
  fi
  previous="$arg"
done
if [ "$has_namespace" != true ] || [ "$has_label" != true ] || [ "$has_output" != true ]; then
  exit 64
fi
case "$resource:$output_value" in
  pods:json|pod:json)
    cat <<'JSON'
{"items":[{"metadata":{"name":"${options.podName}","labels":{"agentsmith-lite/run-id":"${observedRunId}"}},"status":{"phase":"Running","containerStatuses":[{"name":"botified-runner","ready":true,"image":"${runnerImage}","imageID":"${runnerImageID}"}]},"spec":{"containers":[{"name":"botified-runner","image":"${runnerImage}","volumeMounts":[{"name":"project-files","mountPath":"${mountPath}","subPath":"${subPath}"},{"name":"botified-config","mountPath":"/etc/botified","readOnly":true}]}],"volumes":[{"name":"project-files","persistentVolumeClaim":{"claimName":"${pvcClaimName}"}},{"name":"botified-config","configMap":{"name":"${options.resourcePrefix}-config"}}]}}]}
JSON
    ;;
  secrets:name|secret:name)
    printf 'secret/${options.resourcePrefix}-secret\\n'
    ;;
  configmaps:name|configmap:name)
    printf 'configmap/${options.resourcePrefix}-config\\n'
    ;;
  serviceaccounts:name|serviceaccount:name)
    printf 'serviceaccount/${options.resourcePrefix}-service-account\\n'
    ;;
  services:name|service:name)
    printf 'service/${options.resourcePrefix}-service\\n'
    ;;
  networkpolicies:name|networkpolicy:name)
    printf 'networkpolicy/${options.resourcePrefix}-network\\n'
    ;;
  *)
    exit 65
    ;;
esac
`);
  chmodSync(fakeKubectl, 0o755);
  return fakeKubectl;
}

async function startTaskSmokeServer(options: {
  adminPassword: string;
  endpointBaseUrl: string;
  endpointModel: string;
  endpointSecretRef: string;
  workspaceId: string;
  projectId: string;
  endpointId: string;
  taskId: string;
  runId: string;
  subPath: string;
}): Promise<{
  baseUrl: string;
  requests: SmokeRequest[];
  close: () => Promise<void>;
}> {
  const requests: SmokeRequest[] = [];
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
      res.setHeader("set-cookie", "asl_session=k8s-session; HttpOnly; Path=/");
      res.end(JSON.stringify({ csrfToken: "csrf-k8s" }));
    } else if (req.method === "POST" && req.url === "/api/workspaces") {
      res.end(JSON.stringify({ id: options.workspaceId, name: "Deploy Smoke" }));
    } else if (req.method === "POST" && req.url === `/api/workspaces/${options.workspaceId}/projects`) {
      res.end(JSON.stringify({ id: options.projectId, workspaceId: options.workspaceId, name: "API Smoke" }));
    } else if (req.method === "POST" && req.url === `/api/projects/${options.projectId}/endpoints`) {
      assert.deepEqual(parsedBody, {
        name: "Deploy Smoke Endpoint",
        protocol: "openai_chat_completions",
        baseUrl: options.endpointBaseUrl,
        model: options.endpointModel,
        apiKeySecretRef: options.endpointSecretRef,
        capabilities: ["text"],
        requestTimeoutSecs: 30
      });
      res.end(JSON.stringify({ id: options.endpointId }));
    } else if (req.method === "POST" && req.url === `/api/projects/${options.projectId}/chat`) {
      res.end(JSON.stringify({ message: { role: "assistant", content: "ok" } }));
    } else if (req.method === "POST" && req.url === `/api/projects/${options.projectId}/files`) {
      res.end(JSON.stringify({ path: "files/deploy-smoke.txt", bytes: 24 }));
    } else if (req.method === "GET" && req.url === `/api/projects/${options.projectId}/files?path=files`) {
      res.end(JSON.stringify({ entries: [{ path: "files/deploy-smoke.txt", type: "file" }] }));
    } else if (req.method === "GET" && req.url === `/api/projects/${options.projectId}/files/download?path=files%2Fdeploy-smoke.txt`) {
      res.end(JSON.stringify({ path: "files/deploy-smoke.txt", content: "hello from deploy smoke\n" }));
    } else if (req.method === "DELETE" && req.url === `/api/projects/${options.projectId}/files`) {
      res.end(JSON.stringify({ deleted: true }));
    } else if (req.method === "GET" && req.url === "/api/operator/sandbox/status") {
      res.end(JSON.stringify({ namespace: "agentsmith", activeTaskCount: 0, runCounts: {}, observedResourceCounts: {} }));
    } else if (req.method === "GET" && req.url === `/api/operator/sandbox/status?runId=${options.runId}`) {
      res.end(JSON.stringify(statusResponse(options.runId, {
        activeTaskCount: 1,
        runCounts: { total: 1, active: 1, running: 1 },
        observedResourceCounts: { Pod: 1, Secret: 1 },
        cleanupTargetCount: 2
      })));
    } else if (req.method === "POST" && req.url === `/api/projects/${options.projectId}/tasks`) {
      assert.equal(parsedBody.endpointId, options.endpointId);
      assert.equal(JSON.stringify(parsedBody).includes(options.endpointSecretRef), false);
      res.end(JSON.stringify({
        id: options.taskId,
        runId: options.runId,
        status: "running",
        endpointId: options.endpointId,
        sandbox: {
          resources: sandboxResources({
            taskId: options.taskId,
            runId: options.runId,
            subPath: options.subPath
          })
        }
      }));
    } else if (req.method === "GET" && req.url === `/api/tasks/${options.taskId}/events`) {
      res.end(JSON.stringify([{ id: `event_${options.taskId}`, taskId: options.taskId, kind: "turn_completed" }]));
    } else if (req.method === "GET" && req.url === `/api/tasks/${options.taskId}/artifacts`) {
      res.end(JSON.stringify([{
        id: `artifact_${options.taskId}`,
        taskId: options.taskId,
        fileId: `file_${options.taskId}`,
        name: "agentsmith-lite-task-smoke.txt",
        bytes: 51,
        createdAt: "2026-01-01T00:00:01.000Z"
      }]));
    } else if (req.method === "GET" && req.url === `/api/tasks/${options.taskId}/artifacts/artifact_${options.taskId}/download`) {
      res.setHeader("content-type", "application/octet-stream");
      res.end("runtime accepted\nAGENTSMITH_LITE_TASK_SMOKE_MARKER\n");
    } else if (req.method === "POST" && req.url === `/api/tasks/${options.taskId}/cancel`) {
      res.end(JSON.stringify({ id: options.taskId, runId: options.runId, status: "stopping" }));
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

interface SandboxResourceOptions {
  taskId: string;
  runId: string;
  subPath: string;
  runnerImage?: string;
  pvcClaimName?: string;
  serviceKey?: string;
  modelKey?: string;
}

interface SandboxContractSummaryOptions {
  taskId: string;
  subPath: string;
  runnerImage?: string;
  pvcClaimName?: string;
}

function sandboxResources(options: SandboxResourceOptions): unknown[] {
  const runnerImage = options.runnerImage ?? defaultSandboxRunnerImage;
  const pvcClaimName = options.pvcClaimName ?? defaultSandboxPvcClaimName;
  return [
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: `asl-botified-${options.taskId}` },
      stringData: {
        BOTIFIED_SERVICE_KEY: options.serviceKey ?? `${options.taskId}-service-key-secret`,
        MODEL_API_KEY: options.modelKey ?? `sk-${options.taskId}-model-key`
      }
    },
    {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: `asl-task-${options.taskId}`,
        namespace: "agentsmith",
        labels: {
          "agentsmith-lite/run-id": options.runId
        }
      },
      spec: {
        containers: [
          {
            name: "botified-runner",
            image: runnerImage,
            volumeMounts: [
              {
                name: "project-files",
                mountPath: "/workspace/project",
                subPath: options.subPath
              },
              {
                name: "botified-config",
                mountPath: "/etc/botified",
                readOnly: true
              }
            ]
          }
        ],
        volumes: [
          {
            name: "project-files",
            persistentVolumeClaim: {
              claimName: pvcClaimName
            }
          },
          {
            name: "botified-config",
            configMap: {
              name: `botified-${options.taskId}`
            }
          }
        ]
      }
    }
  ];
}

function sandboxContractSummary(options: SandboxContractSummaryOptions) {
  return {
    scope: appSmokeSandboxContractScope,
    podName: `asl-task-${options.taskId}`,
    runnerContainer: "botified-runner",
    runnerImage: options.runnerImage ?? defaultSandboxRunnerImage,
    pvcClaimName: options.pvcClaimName ?? defaultSandboxPvcClaimName,
    mountPath: "/workspace/project",
    subPath: options.subPath
  };
}

function reapResponse(dryRun: boolean, actionCount: number, cleanupTargetCount: number, storedRunIds: string[]) {
  return {
    namespace: "agentsmith",
    activeTaskCount: 1,
    runCounts: {},
    observedResourceCounts: {},
    cleanupPlan: {
      targets: Array.from({ length: cleanupTargetCount }, (_value, index) => ({
        type: "store_run_state",
        source: "store",
        runId: "run_reclaim_apply",
        reason: `reason_${index}`,
        phase: "stopping",
        cleanupStatus: "cleaned"
      })),
      recentFailures: []
    },
    recentCleanupFailures: [],
    actionSummary: Array.from({ length: actionCount }, (_value, index) => ({
      type: "store_run_state",
      runId: "run_reclaim_apply",
      reason: `reason_${index}`
    })),
    errors: [],
    dryRun,
    storedRunIds
  };
}

function statusResponse(
  runId: string,
  input: {
    activeTaskCount: number;
    runCounts: Record<string, number>;
    observedResourceCounts: Record<string, number>;
    cleanupTargetCount: number;
    errorCount?: number;
  }
) {
  return {
    namespace: "agentsmith",
    activeTaskCount: input.activeTaskCount,
    runCounts: input.runCounts,
    observedResourceCounts: input.observedResourceCounts,
    cleanupPlan: {
      targets: Array.from({ length: input.cleanupTargetCount }, (_value, index) => ({
        type: "store_run_state",
        source: "store",
        runId,
        reason: `status_reason_${index}`,
        phase: "stopping",
        cleanupStatus: "cleaned"
      })),
      recentFailures: []
    },
    recentCleanupFailures: [],
    actionSummary: [],
    errors: Array.from({ length: input.errorCount ?? 0 }, (_value, index) => `status error ${index}`)
  };
}
