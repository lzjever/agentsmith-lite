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
    const nonApiTargets = [...fetchTargets, ...apiTargets]
      .filter(({ target }) => !target.startsWith("/api/"))
      .map(({ call, file, target }) => `${file}: ${call}(${target})`);

    assert.ok(fetchTargets.length > 0);
    assert.ok(apiTargets.length > 0);
    assert.deepEqual(nonApiTargets, []);
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
        route: /\/api\/projects\/\$\{[^}]+}\/files\?path=files/,
        method: /api\(`\/api\/projects\/\$\{[^}]+}\/files\?path=files`\)/
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
      /function\s+selectProject\(projectId,\s*data\)[\s\S]*state\.projectId\s*=\s*projectId[\s\S]*renderDashboard\(data\)/,
      "project selection must update browser state and refresh from existing dashboard-derived data"
    );
    const selectProjectSource = extractFunctionBody(source, "selectProject");
    assert.ok(selectProjectSource, "browser UI must define a project selection helper");
    assert.doesNotMatch(selectProjectSource, /\bfetch\(|\bapi\(/, "project selection must not make extra API calls");
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

function extractFunctionBody(text: string, functionName: string): string {
  const startPattern = new RegExp(`function\\s+${functionName}\\([^)]*\\)\\s*\\{`);
  const match = startPattern.exec(text);
  if (!match || match.index === undefined) {
    return "";
  }
  let depth = 0;
  for (let index = match.index + match[0].length - 1; index < text.length; index += 1) {
    if (text[index] === "{") {
      depth += 1;
    } else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(match.index, index + 1);
      }
    }
  }
  return "";
}
