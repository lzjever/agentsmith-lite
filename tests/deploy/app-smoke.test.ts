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
      "SMOKE_ENDPOINT_SECRET_REF=secret/env"
    ].join("\n"));
    writeFileSync(secretsFile, `BUILTIN_ADMIN_INITIAL_PASSWORD=${adminPassword}\n`);
    writeFileSync(fakeNode, `#!/usr/bin/env bash
{
  printf 'args=%s\\n' "$*"
  printf 'admin_password=%s\\n' "$BUILTIN_ADMIN_INITIAL_PASSWORD"
  printf 'endpoint_base_url=%s\\n' "$SMOKE_ENDPOINT_BASE_URL"
} > "$FAKE_NODE_CALLS"
printf '{"status":"ok","baseUrl":"http://deploy.example.test","workspaceId":"workspace_1","projectId":"project_1","chat":{"status":"skipped"}}\\n'
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
      };
      assert.deepEqual(report, {
        status: "ok",
        baseUrl,
        workspaceId: "workspace_1",
        projectId: "project_1",
        chat: { status: "completed" }
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
        chat: { status: "skipped" }
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
