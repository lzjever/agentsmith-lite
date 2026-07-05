import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

describe("deploy app smoke", () => {
  it("smoke.sh dispatches to the API-only app smoke with env base URL and sourced admin secret", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-smoke-sh-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    const fakeNode = path.join(tempDir, "node");
    const callsFile = path.join(tempDir, "node-calls.txt");
    const adminPassword = "admin-secret-from-file";

    writeFileSync(envFile, [
      "APP_PUBLIC_BASE_URL=http://deploy.example.test",
      "BUILTIN_ADMIN_INITIAL_PASSWORD=wrong-from-env",
      "SMOKE_ENDPOINT_BASE_URL=https://models.env.test/v1",
      "SMOKE_ENDPOINT_MODEL=env-model",
      "SMOKE_ENDPOINT_SECRET_REF=secret/env",
      "SMOKE_TASK=true",
      "SMOKE_TASK_TIMEOUT_SECS=12"
    ].join("\n"));
    writeFileSync(secretsFile, `BUILTIN_ADMIN_INITIAL_PASSWORD=${adminPassword}\n`);
    writeFileSync(fakeNode, `#!/usr/bin/env bash
{
  printf 'args=%s\\n' "$*"
  printf 'admin_password=%s\\n' "$BUILTIN_ADMIN_INITIAL_PASSWORD"
  printf 'endpoint_base_url=%s\\n' "$SMOKE_ENDPOINT_BASE_URL"
  printf 'task_smoke=%s\\n' "$SMOKE_TASK"
  printf 'task_timeout=%s\\n' "$SMOKE_TASK_TIMEOUT_SECS"
} > "$FAKE_NODE_CALLS"
printf '{"status":"ok","baseUrl":"http://deploy.example.test","workspaceId":"workspace_1","projectId":"project_1","chat":{"status":"skipped"},"task":{"status":"skipped"}}\\n'
`);
    chmodSync(fakeNode, 0o755);

    const result = spawnSync("bash", [
      "scripts/deploy/smoke.sh",
      "--env",
      envFile,
      "--secrets",
      secretsFile
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        FAKE_NODE_CALLS: callsFile
      }
    });

    assert.equal(result.status, 0, result.stderr);
    const call = readFileSync(callsFile, "utf8");
    assert.match(call, /args=scripts\/deploy\/app-smoke\.mjs --base-url http:\/\/deploy\.example\.test/);
    assert.doesNotMatch(call, /e2e\/smoke\/lite-smoke\.mjs/);
    assert.match(call, new RegExp(`admin_password=${escapeRegExp(adminPassword)}`));
    assert.match(call, /endpoint_base_url=https:\/\/models\.env\.test\/v1/);
    assert.match(call, /task_smoke=true/);
    assert.match(call, /task_timeout=12/);
    assert.doesNotMatch(result.stdout, new RegExp(escapeRegExp(adminPassword)));
    assert.doesNotMatch(result.stderr, new RegExp(escapeRegExp(adminPassword)));
  });

  it("app-smoke.mjs exercises remote API smoke with cookie, CSRF, endpoint, chat, files, and operator status", async () => {
    const adminPassword = "remote-admin-secret";
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
        "secret/remote-smoke"
      ], {
        BUILTIN_ADMIN_INITIAL_PASSWORD: adminPassword
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout) as {
        status: string;
        baseUrl: string;
        workspaceId: string;
        projectId: string;
        chat: { status: string };
        task: { status: string };
      };
      assert.deepEqual(report, {
        status: "ok",
        baseUrl,
        workspaceId: "workspace_1",
        projectId: "project_1",
        chat: { status: "completed" },
        task: { status: "skipped" }
      });
      assert.doesNotMatch(result.stdout, new RegExp(escapeRegExp(adminPassword)));
      assert.doesNotMatch(result.stdout, /secret\/remote-smoke/);
      assert.doesNotMatch(result.stderr, new RegExp(escapeRegExp(adminPassword)));

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
        baseUrl,
        workspaceId: "workspace_skip",
        projectId: "project_skip",
        chat: { status: "skipped" },
        task: { status: "skipped" }
      });
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
          status: "running",
          endpointId: "endpoint_task",
          sandbox: {
            resources: [
              { kind: "Secret", metadata: { name: "asl-botified-task-smoke" }, stringData: { BOTIFIED_SERVICE_KEY: "task-service-key-secret" } }
            ]
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
        SMOKE_TASK: "true"
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report, {
        status: "ok",
        baseUrl,
        workspaceId: "workspace_task",
        projectId: "project_task",
        chat: { status: "completed" },
        task: {
          status: "completed",
          taskId: "task_smoke",
          createStatus: "running",
          artifactId: "artifact_task_smoke",
          artifactName: "agentsmith-lite-task-smoke.txt"
        }
      });
      assert.notEqual(report.task.createStatus, 200);
      assert.doesNotMatch(result.stdout, new RegExp(escapeRegExp(adminPassword)));
      assert.doesNotMatch(result.stdout, /secret\/task-smoke/);
      assert.doesNotMatch(result.stdout, /BOTIFIED_SERVICE_KEY|task-service-key-secret/);
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
        "GET /api/tasks/task_smoke/artifacts/artifact_task_smoke/download"
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
          status: "running",
          sandbox: {
            resources: [
              { kind: "Secret", stringData: { BOTIFIED_SERVICE_KEY: "mismatch-service-key-secret" } }
            ]
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
});

interface SmokeRequest {
  method: string | undefined;
  url: string | undefined;
  cookie: string | undefined;
  csrf: string | undefined;
  body: string;
}

function runNode(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SMOKE_TASK: "",
        SMOKE_ENDPOINT_BASE_URL: "",
        SMOKE_ENDPOINT_MODEL: "",
        SMOKE_ENDPOINT_SECRET_REF: "",
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
