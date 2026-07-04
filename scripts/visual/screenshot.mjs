import { chromium } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApiServer } from "../../dist/packages/api-entry-node/src/server.js";

const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-visual-"));
const server = await createApiServer({
  port: 0,
  dataRoot,
  builtinAdminPassword: "admin-password",
  sessionSecret: "visual-session-secret"
});

const executablePath = process.env.CHROME_PATH ?? (existsSync("/usr/bin/google-chrome-stable") ? "/usr/bin/google-chrome-stable" : undefined);
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.request.post(server.baseUrl + "/api/auth/bootstrap", { data: { password: "admin-password" } });
  const login = await context.request.post(server.baseUrl + "/api/auth/login", {
    data: { email: "admin@agentsmith-lite.local", password: "admin-password" }
  });
  const csrfToken = (await login.json()).csrfToken;
  const workspace = await (await context.request.post(server.baseUrl + "/api/workspaces", {
    headers: { "x-csrf-token": csrfToken },
    data: { name: "Visual Workspace" }
  })).json();
  const project = await (await context.request.post(server.baseUrl + `/api/workspaces/${workspace.id}/projects`, {
    headers: { "x-csrf-token": csrfToken },
    data: { name: "Visual Project" }
  })).json();
  const endpoint = await (await context.request.post(server.baseUrl + `/api/projects/${project.id}/endpoints`, {
    headers: { "x-csrf-token": csrfToken },
    data: {
      name: "Visual Endpoint",
      protocol: "openai_chat_completions",
      baseUrl: "https://models.example.com/v1",
      model: "gpt-compatible",
      apiKeySecretRef: "secret/visual",
      capabilities: ["text"],
      requestTimeoutSecs: 30
    }
  })).json();
  await context.request.post(server.baseUrl + `/api/projects/${project.id}/tasks`, {
    headers: { "x-csrf-token": csrfToken },
    data: { endpointId: endpoint.id, prompt: "Visual task" }
  });
  const page = await context.newPage();
  await page.goto(server.baseUrl + "/", { waitUntil: "networkidle" });
  await mkdir("out/visual", { recursive: true });
  await page.screenshot({ path: "out/visual/agentsmith-lite-dashboard.png", fullPage: true });
  console.log("Screenshot: out/visual/agentsmith-lite-dashboard.png");
} finally {
  await browser.close();
  await server.close();
  await rm(dataRoot, { recursive: true, force: true });
}

