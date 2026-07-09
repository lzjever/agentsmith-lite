import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

describe("web ui client boundary", () => {
  it("keeps the browser client as an AgentSmith Lite API consumer only", async () => {
    const files = await listFiles(path.resolve("src/web"));
    const checked = await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const));
    const forbidden = [
      "openai.chat",
      "api.openai.com",
      "botified",
      "kubernetes",
      "k8s",
      "pg.",
      "postgres",
      "juicefs",
      "fs.",
      "/v1/messages",
      "/v1/timeline",
      "chat/completions",
      "authorization: bearer",
      "authorization",
      "bearer ",
      "secret/"
    ];

    const hits = checked.flatMap(([file, text]) =>
      forbidden.filter((needle) => text.toLowerCase().includes(needle)).map((needle) => `${file}: ${needle}`)
    );
    assert.deepEqual(hits, []);

    const fetchTargets = checked.flatMap(([file, text]) =>
      extractFirstArgTargets(text, "fetch").map((target) => ({ call: "fetch", file, target }))
    );
    const apiTargets = checked.flatMap(([file, text]) =>
      extractFirstArgTargets(text, "api").map((target) => ({ call: "api", file, target }))
    );
    const hrefTargets = checked.flatMap(([file, text]) =>
      extractAssignedTargets(text, "href").map((target) => ({ call: "href", file, target }))
    );
    const nonApiTargets = [...fetchTargets, ...apiTargets]
      .filter(({ target }) => !target.startsWith("/api/"))
      .map(({ call, file, target }) => `${file}: ${call}(${target})`);
    const operatorTargets = [...fetchTargets, ...apiTargets, ...hrefTargets]
      .filter(({ target }) => target.startsWith("/api/operator/"))
      .map(({ call, file, target }) => `${file}: ${call}(${target})`);
    const nonProductApiTargets = [...fetchTargets, ...apiTargets, ...hrefTargets]
      .filter(({ target }) => target.startsWith("/api/") && !isProductApiTarget(target))
      .map(({ call, file, target }) => `${file}: ${call}(${target})`);

    assert.ok(fetchTargets.length > 0);
    assert.ok(apiTargets.length > 0);
    assert.deepEqual(nonApiTargets, []);
    assert.deepEqual(operatorTargets, [], "browser UI must not call or link to operator APIs");
    assert.deepEqual(nonProductApiTargets, [], "browser UI /api/ targets must stay on product API routes");
    assert.ok(
      checked.some(([, text]) => text.includes("/api/tasks/") && text.includes("/artifacts")),
      "browser UI must load task artifacts through the AgentSmith Lite API"
    );
    assert.ok(
      checked.some(([, text]) => text.includes("/download") && text.includes("download")),
      "browser UI must expose product artifact download links"
    );

    const source = checked.map(([, text]) => text).join("\n");
    assert.doesNotMatch(source, /Create Demo|Demo Workspace|Sandbox Project/, "browser UI must not hard-code demo workspace/project creation");
    assert.match(source, /<form id="workspace-project-form"[\s\S]*name="workspaceName"[\s\S]*name="projectName"/);
    assert.match(source, /const\s+workspaceProjectForm\s*=\s*document\.querySelector\("#workspace-project-form"\)/);
    assert.match(
      source,
      /workspaceProjectForm\.addEventListener\("submit",\s*async\s*\(event\)\s*=>\s*\{[\s\S]*?const\s+form\s*=\s*new FormData\(workspaceProjectForm\)[\s\S]*?name:\s*formString\(form,\s*"workspaceName"\)[\s\S]*?name:\s*formString\(form,\s*"projectName"\)[\s\S]*?state\.workspaceId\s*=\s*workspace\.id[\s\S]*?state\.projectId\s*=\s*project\.id[\s\S]*?refreshDashboard\(\)/,
      "browser UI must create workspace/project from user-entered form values and refresh the dashboard"
    );
    assert.match(source, /<h2 id="login-title">Sign in<\/h2>/, "OIDC login page must not default to Admin Login");
    assert.match(
      source,
      /loginTitleEl\.textContent\s*=\s*state\.authMode\s*===\s*"oidc"\s*\?\s*"Sign in"\s*:\s*"Admin Login"/,
      "browser UI must use product login language for OIDC and admin language only for built-in auth"
    );
    assert.match(source, /id="logout-button"[\s\S]*>\s*(Sign out|Logout)\s*<\/button>/, "dashboard must expose a clear logout control");
    assert.match(
      source,
      /logoutButton\.addEventListener\("click",\s*async\s*\(\)\s*=>\s*\{[\s\S]*?api\("\/api\/auth\/logout",[\s\S]*?method:\s*"POST"[\s\S]*?csrf:\s*state\.csrfToken[\s\S]*?clearSessionState\(\)[\s\S]*?loginEl\.classList\.remove\("hidden"\)[\s\S]*?dashboardEl\.classList\.add\("hidden"\)/,
      "logout must call the product logout API with CSRF, clear browser session state, and return to login"
    );
    assert.match(
      source,
      /function\s+clearSessionState\(\)[\s\S]*?state\.csrfToken\s*=\s*null[\s\S]*?state\.workspaceId\s*=\s*null[\s\S]*?state\.projectId\s*=\s*null[\s\S]*?state\.endpointId\s*=\s*null[\s\S]*?state\.selectedTaskId\s*=\s*null[\s\S]*?state\.endpoints\s*=\s*\[][\s\S]*?state\.tasks\s*=\s*\[][\s\S]*?state\.taskEvents\.clear\(\)[\s\S]*?state\.taskEventErrors\.clear\(\)/,
      "logout must clear CSRF and dashboard-derived browser state"
    );
    const requiredWorkflowRoutes = [
      {
        name: "workspace create",
        route: /\/api\/workspaces/,
        method: /api\("\/api\/workspaces",[\s\S]*?method:\s*"POST"[\s\S]*?csrf:\s*state\.csrfToken/
      },
      {
        name: "project create",
        route: /\/api\/workspaces\/\$\{[^}]+}\/projects/,
        method: /api\(`\/api\/workspaces\/\$\{[^}]+}\/projects`,[\s\S]*?method:\s*"POST"[\s\S]*?csrf:\s*state\.csrfToken/
      },
      {
        name: "endpoint create",
        route: /\/api\/projects\/\$\{[^}]+}\/endpoints/,
        method: /api\(`\/api\/projects\/\$\{[^}]+}\/endpoints`,[\s\S]*?method:\s*"POST"/
      },
      {
        name: "chat",
        route: /\/api\/projects\/\$\{[^}]+}\/chat/,
        method: /api\(`\/api\/projects\/\$\{[^}]+}\/chat`,[\s\S]*?method:\s*"POST"/
      },
      {
        name: "task create",
        route: /\/api\/projects\/\$\{[^}]+}\/tasks/,
        method: /api\(`\/api\/projects\/\$\{[^}]+}\/tasks`,[\s\S]*?method:\s*"POST"/
      },
      {
        name: "task cancel",
        route: /\/api\/tasks\/\$\{[^}]+}\/cancel/,
        method: /api\(`\/api\/tasks\/\$\{[^}]+}\/cancel`,[\s\S]*?method:\s*"POST"/
      },
      {
        name: "task events",
        route: /\/api\/tasks\/\$\{[^}]+}\/events/,
        method: /api\(`\/api\/tasks\/\$\{[^}]+}\/events`\)/
      },
      {
        name: "artifact list",
        route: /\/api\/tasks\/\$\{[^}]+}\/artifacts/,
        method: /api\(`\/api\/tasks\/\$\{[^}]+}\/artifacts`\)/
      },
      {
        name: "artifact download",
        route: /\/api\/tasks\/\$\{[^}]+}\/artifacts\/\$\{[^}]+}\/download/,
        method: /href\s*=\s*`\/api\/tasks\/\$\{[^}]+}\/artifacts\/\$\{[^}]+}\/download`/
      },
      {
        name: "project file list",
        route: /\/api\/projects\/\$\{[^}]+}\/files\?path=\$\{encodeURIComponent\(state\.projectFilesPath\)}/,
        method: /api\(`\/api\/projects\/\$\{[^}]+}\/files\?path=\$\{encodeURIComponent\(state\.projectFilesPath\)}`\)/
      },
      {
        name: "project file download",
        route: /\/api\/projects\/\$\{[^}]+}\/files\/download\?path=\$\{encodeURIComponent\([^)]*entry\.path[^)]*\)}/,
        method: /href\s*=\s*`\/api\/projects\/\$\{[^}]+}\/files\/download\?path=\$\{encodeURIComponent\([^)]*entry\.path[^)]*\)}[^`]*`/
      },
      {
        name: "project file upload",
        route: /\/api\/projects\/\$\{[^}]+}\/files/,
        method: /const\s+form\s*=\s*new FormData\(projectFileForm\)[\s\S]*?const\s+path\s*=\s*String\(form\.get\("path"\)\s*\?\?\s*""\)[\s\S]*?const\s+content\s*=\s*String\(form\.get\("content"\)\s*\?\?\s*""\)[\s\S]*?api\(`\/api\/projects\/\$\{[^}]+}\/files`,[\s\S]*?method:\s*"POST"[\s\S]*?csrf:\s*state\.csrfToken[\s\S]*?body:\s*\{[\s\S]*?path[\s\S]*?content[\s\S]*?}/
      },
      {
        name: "project file delete",
        route: /\/api\/projects\/\$\{[^}]+}\/files/,
        method: /api\(`\/api\/projects\/\$\{[^}]+}\/files`,[\s\S]*?method:\s*"DELETE"[\s\S]*?csrf:\s*state\.csrfToken[\s\S]*?body:\s*\{[\s\S]*?path[\s\S]*?}/
      }
    ];

    for (const required of requiredWorkflowRoutes) {
      assert.match(source, required.route, `browser UI must include ${required.name} product API route`);
      assert.match(source, required.method, `browser UI must call ${required.name} through the expected workflow`);
    }
    assert.match(
      source,
      /capabilities:\s*\[\s*"text"\s*,\s*"tool_calls"\s*]/,
      "browser UI must create task-ready endpoints with tool_calls capability"
    );
    assert.match(
      source,
      /deleteProjectFile\(entry\.path\)/,
      "browser UI must delete the current project file entry path"
    );
    assert.match(
      source,
      /function\s+renderWorkspaces\(workspaces,\s*currentProject,\s*data\)[\s\S]*workspace\.projects\.forEach\(\(project\)[\s\S]*document\.createElement\("button"\)/,
      "browser UI must render project selection controls from workspace.projects"
    );
    assert.match(
      source,
      /projectButton\.addEventListener\("click",\s*\(\)\s*=>\s*selectProject\(project\.id,\s*data\)\)/,
      "project selection must route clicks to the selected project id and current dashboard data"
    );
    assert.match(
      source,
      /function\s+selectProject\(projectId,\s*data\)[\s\S]*state\.projectId\s*=\s*projectId[\s\S]*renderDashboard\(data\)[\s\S]*refreshTaskResults\(current\.tasks\)/,
      "project selection must update browser state and refresh from existing dashboard-derived data"
    );
    assert.match(
      source,
      /async\s+function\s+refreshTaskResults\(tasks\)[\s\S]*await\s+refreshTaskEvents\(tasks\)[\s\S]*await\s+refreshTaskArtifacts\(tasks\)/,
      "browser UI must refresh task events before artifacts through one task-result helper"
    );
    assert.match(
      source,
      /async\s+function\s+refreshDashboard\(\)[\s\S]*refreshTaskResults\(current\.tasks\)/,
      "dashboard refresh must use the shared task-result helper"
    );
  });
});

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const next = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(next) : [next];
  }));
  return files.flat();
}

function extractFirstArgTargets(text: string, callName: "api" | "fetch"): string[] {
  const pattern = new RegExp(`\\b${callName}\\(\\s*(["'\`])`, "g");
  const targets: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const quote = match[1];
    if (!quote) {
      continue;
    }
    const start = (match.index ?? 0) + match[0].length;
    const end = text.indexOf(quote, start);
    if (end !== -1) {
      targets.push(text.slice(start, end));
    }
  }
  return targets;
}

function extractAssignedTargets(text: string, propertyName: string): string[] {
  const pattern = new RegExp(`\\b${propertyName}\\s*=\\s*(["'\`])`, "g");
  const targets: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const quote = match[1];
    if (!quote) {
      continue;
    }
    const start = (match.index ?? 0) + match[0].length;
    const end = text.indexOf(quote, start);
    if (end !== -1) {
      targets.push(text.slice(start, end));
    }
  }
  return targets;
}

function isProductApiTarget(target: string): boolean {
  return [
    /^\/api\/bootstrap$/,
    /^\/api\/health$/,
    /^\/api\/dashboard$/,
    /^\/api\/me$/,
    /^\/api\/auth\/bootstrap$/,
    /^\/api\/auth\/login$/,
    /^\/api\/auth\/logout$/,
    /^\/api\/auth\/oidc\/start$/,
    /^\/api\/workspaces$/,
    /^\/api\/workspaces\/\$\{[^}]+}\/projects$/,
    /^\/api\/projects\/\$\{[^}]+}\/endpoints$/,
    /^\/api\/projects\/\$\{[^}]+}\/chat$/,
    /^\/api\/projects\/\$\{[^}]+}\/tasks$/,
    /^\/api\/projects\/\$\{[^}]+}\/files(?:\?path=(?:files|\$\{encodeURIComponent\(state\.projectFilesPath\)}))?$/,
    /^\/api\/projects\/\$\{[^}]+}\/files\/download\?path=\$\{encodeURIComponent\([^)]*entry\.path[^)]*\)}$/,
    /^\/api\/tasks\/\$\{[^}]+}\/events$/,
    /^\/api\/tasks\/\$\{[^}]+}\/artifacts$/,
    /^\/api\/tasks\/\$\{[^}]+}\/artifacts\/\$\{[^}]+}\/download$/,
    /^\/api\/tasks\/\$\{[^}]+}\/cancel$/
  ].some((pattern) => pattern.test(target));
}
