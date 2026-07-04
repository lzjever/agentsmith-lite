const state = {
  csrfToken: null,
  workspaceId: null,
  projectId: null
};

const healthEl = document.querySelector("#health");
const loginEl = document.querySelector("#login");
const dashboardEl = document.querySelector("#dashboard");
const loginForm = document.querySelector("#login-form");
const seedButton = document.querySelector("#seed");
const uploadFileButton = document.querySelector("#upload-file");

await refreshHealth();
await refreshDashboard();

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(loginForm);
  await api("/api/auth/bootstrap", {
    method: "POST",
    body: {
      password: String(form.get("password"))
    }
  });
  const login = await api("/api/auth/login", {
    method: "POST",
    body: {
      email: String(form.get("email")),
      password: String(form.get("password"))
    }
  });
  state.csrfToken = login.csrfToken;
  await refreshDashboard();
});

seedButton.addEventListener("click", async () => {
  const workspace = await api("/api/workspaces", {
    method: "POST",
    csrf: state.csrfToken,
    body: { name: "Demo Workspace" }
  });
  const project = await api(`/api/workspaces/${workspace.id}/projects`, {
    method: "POST",
    csrf: state.csrfToken,
    body: { name: "Sandbox Project" }
  });
  state.workspaceId = workspace.id;
  state.projectId = project.id;
  await refreshDashboard();
});

uploadFileButton.addEventListener("click", async () => {
  if (!state.projectId) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await api(`/api/projects/${state.projectId}/files`, {
    method: "POST",
    csrf: state.csrfToken,
    body: {
      path: `files/demo-${stamp}.txt`,
      content: `Created ${stamp}`
    }
  });
  await refreshDashboard();
});

async function refreshHealth() {
  const health = await api("/api/health");
  healthEl.textContent = `${health.status} · v${health.version}`;
}

async function refreshDashboard() {
  const response = await fetch("/api/dashboard");
  if (response.status === 401) {
    loginEl.classList.remove("hidden");
    dashboardEl.classList.add("hidden");
    return;
  }
  const dashboard = await response.json();
  loginEl.classList.add("hidden");
  dashboardEl.classList.remove("hidden");
  renderDashboard(dashboard);
  await Promise.all([
    refreshProjectFiles(),
    refreshTaskArtifacts(dashboard.tasks)
  ]);
}

function renderDashboard(data) {
  const workspaces = document.querySelector("#workspaces");
  const endpoints = document.querySelector("#endpoints");
  const tasks = document.querySelector("#tasks");
  const projects = data.workspaces.flatMap((workspace) => workspace.projects);
  if (!state.projectId || !projects.some((project) => project.id === state.projectId)) {
    state.projectId = projects[0]?.id ?? null;
  }
  workspaces.replaceChildren(...data.workspaces.map((workspace) => item(
    workspace.name,
    `${workspace.projects.length} project${workspace.projects.length === 1 ? "" : "s"}`
  )));
  endpoints.replaceChildren(...data.endpoints.map((endpoint) => item(
    endpoint.name,
    `${endpoint.model} · ${endpoint.baseUrl}`
  )));
  tasks.replaceChildren(...data.tasks.map((task) => item(
    task.prompt,
    `${task.status} · ${task.sandbox.resources.length} rendered resources`
  )));
}

async function refreshProjectFiles() {
  const files = document.querySelector("#files");
  const filesCount = document.querySelector("#files-count");
  uploadFileButton.disabled = !state.projectId;
  if (!state.projectId) {
    filesCount.textContent = "0 entries";
    files.replaceChildren(item("No project", "Create a demo project first"));
    return;
  }
  const listed = await api(`/api/projects/${state.projectId}/files?path=files`);
  filesCount.textContent = `${listed.entries.length} entr${listed.entries.length === 1 ? "y" : "ies"}`;
  files.replaceChildren(...(listed.entries.length > 0 ? listed.entries.map((entry) => item(
    entry.path,
    entry.type === "file" ? `${entry.size} bytes` : "directory"
  )) : [item("files/", "0 entries")]));
}

async function refreshTaskArtifacts(tasks) {
  const artifactsEl = document.querySelector("#artifacts");
  const artifactsCount = document.querySelector("#artifacts-count");
  if (tasks.length === 0) {
    artifactsCount.textContent = "0 files";
    artifactsEl.replaceChildren(item("No artifacts", "0 files"));
    return;
  }

  const groups = await Promise.all(tasks.map(async (task) => ({
    task,
    artifacts: await api(`/api/tasks/${task.id}/artifacts`)
  })));
  const rows = groups.flatMap((group) => group.artifacts.map((artifact) => ({
    task: group.task,
    artifact
  })));
  artifactsCount.textContent = `${rows.length} file${rows.length === 1 ? "" : "s"}`;
  artifactsEl.replaceChildren(...(rows.length > 0 ? rows.map(({ task, artifact }) =>
    artifactItem(task, artifact)
  ) : [item("No artifacts", "0 files")]));
}

function item(title, detail) {
  const node = document.createElement("article");
  node.className = "item";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = detail;
  node.append(heading, paragraph);
  return node;
}

function artifactItem(task, artifact) {
  const node = item(artifact.name, `${formatBytes(artifact.bytes)} · ${task.status}`);
  const link = document.createElement("a");
  link.className = "download-link";
  link.href = `/api/tasks/${task.id}/artifacts/${artifact.id}/download`;
  link.download = artifact.name;
  link.textContent = "Download";
  node.append(link);
  return node;
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }
  return `${(kib / 1024).toFixed(1)} MiB`;
}

async function api(path, options = {}) {
  const headers = { "content-type": "application/json" };
  if (options.csrf) {
    headers["x-csrf-token"] = options.csrf;
  }
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}
