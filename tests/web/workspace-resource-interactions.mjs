import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";

const port = 34000 + (process.pid % 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const project = { id: "project_1", workspaceId: "workspace_1", name: "Project", taskConcurrencyLimit: 2, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
let workspaces = [{ id: "workspace_1", name: "Workspace", capabilities: { canCreateProject: true }, createdAt: project.createdAt, updatedAt: project.updatedAt, projects: [project] }];
let workspaceMode = "normal";
let policyMode = "readonly";
let alertsMode = "empty";
let signedOut = false;
let capabilities = { canManageEndpoints: true, canManageMembers: true, canManagePolicy: false, canWriteFiles: true, canCreateTasks: true, canSendChat: true };
const server = spawn(process.execPath, ["./node_modules/next/dist/bin/next", "dev", "--port", String(port)], { cwd: process.cwd(), env: { ...process.env, APP_PUBLIC_BASE_URL: baseUrl }, stdio: ["ignore", "pipe", "pipe"], detached: true });
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

try {
  await waitForServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(); const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/me")) return route.fulfill({ json: { user: { id: "owner_1", email: "owner@example.test" }, csrfToken: "csrf" } });
    if (pathname.endsWith("/auth/logout")) { signedOut = true; return route.fulfill({ json: { loggedOut: true, redirectUrl: "/app/" } }); }
    if (pathname.endsWith("/workspaces")) {
      if (workspaceMode === "error") return route.fulfill({ status: 500, body: "workspace unavailable" });
      if (request.method() === "POST") { const body = request.postDataJSON(); const workspace = { id: "workspace_2", name: body.name, capabilities: { canCreateProject: true }, createdAt: project.createdAt, updatedAt: project.updatedAt, projects: [] }; workspaces = [...workspaces, workspace]; return route.fulfill({ json: workspace }); }
      return route.fulfill({ json: workspaces });
    }
    if (pathname.endsWith("/capabilities")) return route.fulfill({ json: capabilities });
    if (pathname.endsWith("/policy")) {
      if (policyMode === "error") return route.fulfill({ status: 500, body: "policy unavailable" });
      if (request.method() === "PATCH") return route.fulfill({ status: 403, body: "policy denied" });
      return route.fulfill({ json: { projectId: project.id, activeTasksLimit: 2, providerRequestsLimit: null, providerTokensLimit: null, providerCostLimit: null, projectFileBytesLimit: null, createdAt: project.createdAt, updatedAt: project.updatedAt } });
    }
    if (pathname.endsWith("/alerts")) { if (alertsMode === "error") return route.fulfill({ status: 500, body: "alerts unavailable" }); return route.fulfill({ json: [] }); }
    if (pathname.endsWith("/audit")) return route.fulfill({ json: [] });
    if (pathname.endsWith("/usage")) return route.fulfill({ json: { projectId: project.id, activeTasks: 0, providerRequests: 0, providerTokens: 0, providerCost: 0, projectFileBytes: 0, updatedAt: project.updatedAt } });
    if (pathname.endsWith("/endpoints") || pathname.endsWith("/tasks") || pathname.endsWith("/chat/threads") || pathname.endsWith("/members")) return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });

  await page.goto(baseUrl);
  await page.getByRole("button", { name: "New workspace" }).click();
  await page.getByLabel("Name").fill("New workspace");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.getByText("New workspace").waitFor();

  workspaceMode = "error";
  await page.reload();
  await page.getByText("Workspace unavailable").waitFor();
  workspaceMode = "normal";

  workspaces = [{ ...workspaces[0], capabilities: { canCreateProject: false }, projects: [] }];
  await page.goto(`${baseUrl}/workspaces/workspace_1`);
  await page.getByText("No projects yet").waitFor();
  assert.equal(await page.getByRole("button", { name: "New project" }).count(), 0);

  workspaces = [{ ...workspaces[0], capabilities: { canCreateProject: true }, projects: [project] }];
  await page.goto(`${baseUrl}/workspaces/workspace_1/projects/${project.id}/overview`);
  await page.getByRole("link", { name: "Configure an endpoint" }).click();
  await page.waitForURL(/\/endpoints$/);

  await page.goto(`${baseUrl}/workspaces/workspace_1/projects/${project.id}/policy`);
  await page.getByText("Read-only").waitFor();
  capabilities = { ...capabilities, canManagePolicy: true };
  await page.reload();
  await page.getByRole("button", { name: "Save limits" }).click();
  await page.getByText("The server does not allow you to change this policy.").waitFor();
  capabilities = { ...capabilities, canManagePolicy: false };
  policyMode = "error";
  await page.reload();
  await page.getByText("Resource policy unavailable").waitFor();
  policyMode = "readonly";

  await page.goto(`${baseUrl}/workspaces/workspace_1/projects/${project.id}/alerts`);
  await page.getByText("No active alerts").waitFor();
  alertsMode = "error";
  await page.reload();
  await page.getByText("Alerts unavailable").waitFor();
  alertsMode = "empty";
  await page.goto(`${baseUrl}/workspaces/workspace_1/projects/${project.id}/audit`);
  await page.getByText("No audit events").waitFor();

  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Chat" }).click();
  await page.waitForURL(/\/chat$/);
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByText("Sign out").click();
  await page.waitForURL(`${baseUrl}/`);
  assert.equal(signedOut, true);
  await browser.close();
  console.log("workspace-resource interactions: pass");
} finally {
  if (server.exitCode === null) { process.kill(-server.pid, "SIGTERM"); await once(server, "exit"); }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) { if (server.exitCode !== null) throw new Error(output); try { if ((await fetch(baseUrl)).ok) return; } catch {} await delay(125); }
  throw new Error(`Next dev server did not start:\n${output}`);
}
