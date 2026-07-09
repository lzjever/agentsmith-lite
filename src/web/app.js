const state = {
  authMode: "builtin_admin",
  csrfToken: null,
  workspaceId: null,
  projectId: null,
  endpointId: null,
  selectedTaskId: null,
  endpoints: [],
  tasks: [],
  taskEvents: new Map(),
  taskEventErrors: new Map()
};

const cancellableTaskStatuses = new Set(["starting", "running", "stopping"]);

const healthEl = document.querySelector("#health");
const loginEl = document.querySelector("#login");
const dashboardEl = document.querySelector("#dashboard");
const statusMessageEl = document.querySelector("#status-message");
const loginTitleEl = document.querySelector("#login-title");
const loginForm = document.querySelector("#login-form");
const logoutButton = document.querySelector("#logout-button");
const workspaceProjectForm = document.querySelector("#workspace-project-form");
const endpointForm = document.querySelector("#endpoint-form");
const chatForm = document.querySelector("#chat-form");
const taskForm = document.querySelector("#task-form");
const projectFileForm = document.querySelector("#project-file-form");
const chatEndpointSelect = document.querySelector("#chat-endpoint");
const taskEndpointSelect = document.querySelector("#task-endpoint");
const chatReplyEl = document.querySelector("#chat-reply");

await refreshBootstrap();
await refreshHealth();
await refreshDashboard();

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.authMode === "oidc") {
    window.location.href = "/api/auth/oidc/start";
    return;
  }
  const form = new FormData(loginForm);
  try {
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
    setStatus("Signed in.", "success");
    await refreshDashboard();
  } catch (error) {
    setStatus(errorMessage(error), "error");
  }
});

logoutButton.addEventListener("click", async () => {
  try {
    logoutButton.disabled = true;
    await api("/api/auth/logout", {
      method: "POST",
      csrf: state.csrfToken
    });
    clearSessionState();
    chatReplyEl.textContent = "";
    chatReplyEl.classList.add("hidden");
    loginEl.classList.remove("hidden");
    dashboardEl.classList.add("hidden");
    setStatus("Signed out.", "success");
  } catch (error) {
    setStatus(errorMessage(error), "error");
  } finally {
    logoutButton.disabled = false;
  }
});

workspaceProjectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(workspaceProjectForm);
  try {
    setFormDisabled(workspaceProjectForm, true);
    const workspace = await api("/api/workspaces", {
      method: "POST",
      csrf: state.csrfToken,
      body: { name: formString(form, "workspaceName") }
    });
    const project = await api(`/api/workspaces/${workspace.id}/projects`, {
      method: "POST",
      csrf: state.csrfToken,
      body: { name: formString(form, "projectName") }
    });
    state.workspaceId = workspace.id;
    state.projectId = project.id;
    workspaceProjectForm.reset();
    setStatus("Project created.", "success");
    await refreshDashboard();
  } catch (error) {
    setStatus(errorMessage(error), "error");
  } finally {
    setFormDisabled(workspaceProjectForm, false);
  }
});

endpointForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.projectId) {
    setStatus("Create a project first.", "error");
    return;
  }

  const form = new FormData(endpointForm);
  try {
    const endpoint = await api(`/api/projects/${state.projectId}/endpoints`, {
      method: "POST",
      csrf: state.csrfToken,
      body: {
        name: formString(form, "name"),
        protocol: "openai_chat_completions",
        baseUrl: formString(form, "baseUrl"),
        model: formString(form, "model"),
        apiKeySecretRef: formString(form, "secretRef"),
        capabilities: ["text", "tool_calls"],
        requestTimeoutSecs: parseTimeout(form.get("requestTimeoutSecs"))
      }
    });
    state.endpointId = endpoint.id;
    endpointForm.reset();
    setStatus("Endpoint created.", "success");
    await refreshDashboard();
  } catch (error) {
    setStatus(errorMessage(error), "error");
  }
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.projectId) {
    setStatus("Create a project first.", "error");
    return;
  }

  const form = new FormData(chatForm);
  const endpointId = formString(form, "endpointId") || state.endpointId;
  const message = formString(form, "message");
  if (!endpointId || !message) {
    setStatus("Pick an endpoint and enter a message.", "error");
    return;
  }

  try {
    chatReplyEl.classList.remove("hidden");
    chatReplyEl.textContent = "Sending...";
    const chat = await api(`/api/projects/${state.projectId}/chat`, {
      method: "POST",
      csrf: state.csrfToken,
      body: {
        endpointId,
        messages: [{ role: "user", content: message }]
      }
    });
    state.endpointId = endpointId;
    chatReplyEl.textContent = chat.message?.content ?? "";
    chatForm.reset();
    syncEndpointSelects();
    setStatus("Assistant reply received.", "success");
  } catch (error) {
    chatReplyEl.textContent = "";
    chatReplyEl.classList.add("hidden");
    setStatus(errorMessage(error), "error");
  }
});

taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.projectId) {
    setStatus("Create a project first.", "error");
    return;
  }

  const form = new FormData(taskForm);
  const endpointId = formString(form, "endpointId") || state.endpointId;
  const prompt = formString(form, "prompt");
  if (!endpointId || !prompt) {
    setStatus("Pick an endpoint and enter a task prompt.", "error");
    return;
  }

  try {
    const task = await api(`/api/projects/${state.projectId}/tasks`, {
      method: "POST",
      csrf: state.csrfToken,
      body: { prompt, endpointId }
    });
    state.endpointId = endpointId;
    state.selectedTaskId = task.id;
    taskForm.reset();
    syncEndpointSelects();
    setStatus(`Task ${task.status}.`, "success");
    await refreshDashboard();
  } catch (error) {
    setStatus(errorMessage(error), "error");
  }
});

chatEndpointSelect.addEventListener("change", () => {
  state.endpointId = chatEndpointSelect.value || null;
  syncEndpointSelects();
});

taskEndpointSelect.addEventListener("change", () => {
  state.endpointId = taskEndpointSelect.value || null;
  syncEndpointSelects();
});

projectFileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.projectId) {
    setStatus("Create a project first.", "error");
    return;
  }

  const form = new FormData(projectFileForm);
  const path = String(form.get("path") ?? "");
  const content = String(form.get("content") ?? "");
  try {
    await api(`/api/projects/${state.projectId}/files`, {
      method: "POST",
      csrf: state.csrfToken,
      body: { path, content }
    });
    projectFileForm.reset();
    setStatus("Project file uploaded.", "success");
    await refreshProjectFiles();
  } catch (error) {
    setStatus(errorMessage(error), "error");
  }
});

async function refreshHealth() {
  const health = await api("/api/health");
  healthEl.textContent = `${health.status} · v${health.version}`;
}

async function refreshBootstrap() {
  const bootstrap = await api("/api/bootstrap");
  state.authMode = bootstrap.authMode ?? "builtin_admin";
  loginTitleEl.textContent = state.authMode === "oidc" ? "Sign in" : "Admin Login";
  loginForm.querySelector("button").textContent = "Sign in";
  for (const field of loginForm.querySelectorAll("label")) {
    field.classList.toggle("hidden", state.authMode === "oidc");
  }
}

async function refreshDashboard() {
  const response = await fetch("/api/dashboard");
  if (response.status === 401) {
    clearSessionState();
    loginEl.classList.remove("hidden");
    dashboardEl.classList.add("hidden");
    return;
  }
  if (!response.ok) {
    setStatus(await response.text(), "error");
    return;
  }

  const dashboard = await response.json();
  if (!state.csrfToken) {
    const me = await api("/api/me");
    state.csrfToken = me.csrfToken;
  }
  const current = renderDashboard(dashboard);
  loginEl.classList.add("hidden");
  dashboardEl.classList.remove("hidden");

  await Promise.all([
    refreshProjectFiles(),
    refreshTaskEvents(current.tasks),
    refreshTaskArtifacts(current.tasks)
  ]);
}

function clearSessionState() {
  state.csrfToken = null;
  state.workspaceId = null;
  state.projectId = null;
  state.endpointId = null;
  state.selectedTaskId = null;
  state.endpoints = [];
  state.tasks = [];
  state.taskEvents.clear();
  state.taskEventErrors.clear();
}

function renderDashboard(data) {
  const projects = data.workspaces.flatMap((workspace) =>
    workspace.projects.map((project) => ({ ...project, workspaceName: workspace.name }))
  );
  if (!state.projectId || !projects.some((project) => project.id === state.projectId)) {
    state.projectId = projects[0]?.id ?? null;
  }
  const currentProject = projects.find((project) => project.id === state.projectId) ?? null;
  state.workspaceId = currentProject?.workspaceId ?? null;
  state.endpoints = data.endpoints.filter((endpoint) => endpoint.projectId === state.projectId);
  state.tasks = data.tasks.filter((task) => task.projectId === state.projectId);

  if (!state.endpointId || !state.endpoints.some((endpoint) => endpoint.id === state.endpointId)) {
    state.endpointId = state.endpoints[0]?.id ?? null;
  }
  if (!state.selectedTaskId || !state.tasks.some((task) => task.id === state.selectedTaskId)) {
    state.selectedTaskId = state.tasks[0]?.id ?? null;
  }

  renderWorkspaces(data.workspaces, currentProject, data);
  renderEndpoints(state.endpoints);
  renderTasks(state.tasks);
  renderTimeline(state.tasks);
  syncEndpointSelects();
  syncWorkflowControls(Boolean(currentProject), state.endpoints.length > 0);

  return { project: currentProject, endpoints: state.endpoints, tasks: state.tasks };
}

function renderWorkspaces(workspaces, currentProject, data) {
  const workspacesEl = document.querySelector("#workspaces");
  const currentProjectEl = document.querySelector("#current-project");
  currentProjectEl.textContent = currentProject
    ? `${currentProject.workspaceName} / ${currentProject.name}`
    : "No project";
  workspacesEl.replaceChildren(...(workspaces.length > 0 ? workspaces.map((workspace) => {
    const node = item(
      workspace.name,
      `${workspace.projects.length} project${workspace.projects.length === 1 ? "" : "s"}`
    );
    if (workspace.projects.length === 0) {
      return node;
    }

    const actions = document.createElement("div");
    actions.className = "item-actions";
    workspace.projects.forEach((project) => {
      const projectButton = document.createElement("button");
      projectButton.type = "button";
      projectButton.className = "secondary-button";
      projectButton.textContent = project.name;
      projectButton.addEventListener("click", () => selectProject(project.id, data));
      if (project.id === currentProject?.id) {
        projectButton.classList.add("selected");
      }
      actions.append(projectButton);
    });
    node.append(actions);
    return node;
  }) : [item("No workspace", "Create a workspace/project")]));
}

async function selectProject(projectId, data) {
  if (state.projectId === projectId) {
    return;
  }

  state.projectId = projectId;
  const current = renderDashboard(data);
  await Promise.all([
    refreshProjectFiles(),
    refreshTaskEvents(current.tasks),
    refreshTaskArtifacts(current.tasks)
  ]);
}

function renderEndpoints(endpoints) {
  const endpointsEl = document.querySelector("#endpoints");
  const endpointCountEl = document.querySelector("#endpoints-count");
  endpointCountEl.textContent = `${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"}`;
  endpointsEl.replaceChildren(...(endpoints.length > 0 ? endpoints.map((endpoint) => {
    const node = item(
      endpoint.name,
      [
        endpoint.model,
        endpoint.baseUrl,
        endpoint.capabilities.join(", "),
        `${endpoint.requestTimeoutSecs}s timeout`
      ].join(" · ")
    );
    if (endpoint.id === state.endpointId) {
      node.classList.add("selected");
    }
    return node;
  }) : [item("No endpoints", "Create an endpoint for this project")]));
}

function renderTasks(tasks) {
  const tasksEl = document.querySelector("#tasks");
  const tasksCountEl = document.querySelector("#tasks-count");
  tasksCountEl.textContent = `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
  tasksEl.replaceChildren(...(tasks.length > 0 ? tasks.map((task) => taskItem(task, tasks)) : [
    item("No tasks", "Create a task from a prompt")
  ]));
}

function taskItem(task, tasks) {
  const events = state.taskEvents.get(task.id) ?? [];
  const lastEvent = events.at(-1);
  const detail = [
    task.status,
    `${events.length} event${events.length === 1 ? "" : "s"}`,
    lastEvent ? `last ${displayKind(lastEvent.kind)}` : "no timeline yet"
  ].join(" · ");
  const node = item(shortText(task.prompt, 96), detail);
  node.classList.add(`status-${task.status}`);
  if (task.id === state.selectedTaskId) {
    node.classList.add("selected");
  }

  const actions = document.createElement("div");
  actions.className = "item-actions";

  const timelineButton = document.createElement("button");
  timelineButton.type = "button";
  timelineButton.className = "secondary-button";
  timelineButton.textContent = "Timeline";
  timelineButton.addEventListener("click", () => {
    state.selectedTaskId = task.id;
    renderTasks(tasks);
    renderTimeline(tasks);
  });
  actions.append(timelineButton);

  if (cancellableTaskStatuses.has(task.status)) {
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "danger-button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => cancelTask(task.id));
    actions.append(cancelButton);
  }

  node.append(actions);
  return node;
}

async function cancelTask(taskId) {
  try {
    const task = await api(`/api/tasks/${taskId}/cancel`, {
      method: "POST",
      csrf: state.csrfToken,
      body: {}
    });
    state.selectedTaskId = task.id;
    setStatus(`Task ${task.status}.`, "success");
    await refreshDashboard();
  } catch (error) {
    setStatus(errorMessage(error), "error");
  }
}

async function refreshTaskEvents(tasks) {
  const timelineCountEl = document.querySelector("#timeline-count");
  if (tasks.length === 0) {
    state.taskEventErrors.clear();
    timelineCountEl.textContent = "0 events";
    renderTimeline(tasks);
    return;
  }

  await Promise.all(tasks.map(async (task) => {
    try {
      const events = await api(`/api/tasks/${task.id}/events`);
      state.taskEvents.set(task.id, Array.isArray(events) ? events : []);
      state.taskEventErrors.delete(task.id);
    } catch (error) {
      state.taskEventErrors.set(task.id, errorMessage(error));
    }
  }));
  renderTasks(tasks);
  renderTimeline(tasks);
}

function renderTimeline(tasks) {
  const timelineEl = document.querySelector("#timeline");
  const timelineCountEl = document.querySelector("#timeline-count");
  const task = tasks.find((candidate) => candidate.id === state.selectedTaskId) ?? tasks[0] ?? null;
  if (!task) {
    timelineCountEl.textContent = "0 events";
    timelineEl.replaceChildren(item("No task selected", "Create a task first"));
    return;
  }

  state.selectedTaskId = task.id;
  const events = state.taskEvents.get(task.id) ?? [];
  const error = state.taskEventErrors.get(task.id);
  timelineCountEl.textContent = `${task.status} · ${events.length} event${events.length === 1 ? "" : "s"}`;
  if (error) {
    timelineEl.replaceChildren(item(shortText(task.prompt, 80), `Timeline unavailable: ${error}`));
    return;
  }
  timelineEl.replaceChildren(...(events.length > 0 ? events.slice(-8).map((event, index) => item(
    `#${index + 1} ${displayKind(event.kind)}`,
    timelineDetail(event)
  )) : [item(shortText(task.prompt, 80), "Waiting for events")]));
}

async function refreshProjectFiles() {
  const files = document.querySelector("#files");
  const filesCount = document.querySelector("#files-count");
  if (!state.projectId) {
    filesCount.textContent = "0 entries";
    files.replaceChildren(item("No project", "Create a project first"));
    return;
  }
  try {
    const listed = await api(`/api/projects/${state.projectId}/files?path=files`);
    filesCount.textContent = `${listed.entries.length} entr${listed.entries.length === 1 ? "y" : "ies"}`;
    files.replaceChildren(...(listed.entries.length > 0 ? listed.entries.map((entry) =>
      projectFileItem(entry)
    ) : [item("files/", "0 entries")]));
  } catch (error) {
    filesCount.textContent = "Unavailable";
    files.replaceChildren(item("Files unavailable", errorMessage(error)));
  }
}

async function refreshTaskArtifacts(tasks) {
  const artifactsEl = document.querySelector("#artifacts");
  const artifactsCount = document.querySelector("#artifacts-count");
  if (tasks.length === 0) {
    artifactsCount.textContent = "0 files";
    artifactsEl.replaceChildren(item("No artifacts", "0 files"));
    return;
  }

  const groups = await Promise.all(tasks.map(async (task) => {
    try {
      return {
        task,
        artifacts: await api(`/api/tasks/${task.id}/artifacts`)
      };
    } catch (error) {
      return {
        task,
        artifacts: [],
        error: errorMessage(error)
      };
    }
  }));
  const rows = groups.flatMap((group) => group.artifacts.map((artifact) => ({
    task: group.task,
    artifact
  })));
  artifactsCount.textContent = `${rows.length} file${rows.length === 1 ? "" : "s"}`;
  artifactsEl.replaceChildren(...(rows.length > 0 ? rows.map(({ task, artifact }) =>
    artifactItem(task, artifact)
  ) : [item("No artifacts", "0 files")]));
}

function syncEndpointSelects() {
  const endpointOptions = state.endpoints.map((endpoint) => {
    const option = document.createElement("option");
    option.value = endpoint.id;
    option.textContent = `${endpoint.name} · ${endpoint.model}`;
    return option;
  });
  for (const select of [chatEndpointSelect, taskEndpointSelect]) {
    select.replaceChildren(...endpointOptions.map((option) => option.cloneNode(true)));
    if (state.endpointId) {
      select.value = state.endpointId;
    }
  }
}

function syncWorkflowControls(hasProject, hasEndpoint) {
  setFormDisabled(endpointForm, !hasProject);
  setFormDisabled(chatForm, !hasProject || !hasEndpoint);
  setFormDisabled(taskForm, !hasProject || !hasEndpoint);
  setFormDisabled(projectFileForm, !hasProject);
}

function setFormDisabled(form, disabled) {
  form.querySelectorAll("input, textarea, select, button").forEach((control) => {
    control.disabled = disabled;
  });
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

function projectFileItem(entry) {
  const node = item(entry.path, entry.type === "file" ? `${entry.size} bytes` : "directory");
  if (entry.type !== "file") {
    return node;
  }

  const actions = document.createElement("div");
  actions.className = "item-actions";

  const link = document.createElement("a");
  link.className = "download-link";
  link.href = `/api/projects/${state.projectId}/files/download?path=${encodeURIComponent(entry.path)}`;
  link.download = entry.path.split("/").at(-1) || entry.path;
  link.textContent = "Download";
  actions.append(link);

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "danger-button";
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", () => deleteProjectFile(entry.path));
  actions.append(deleteButton);

  node.append(actions);
  return node;
}

async function deleteProjectFile(path) {
  try {
    await api(`/api/projects/${state.projectId}/files`, {
      method: "DELETE",
      csrf: state.csrfToken,
      body: { path }
    });
    setStatus("Project file deleted.", "success");
    await refreshProjectFiles();
  } catch (error) {
    setStatus(errorMessage(error), "error");
  }
}

function formString(form, name) {
  return String(form.get(name) ?? "").trim();
}

function parseTimeout(input) {
  const timeout = Number(input);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return 30;
  }
  return Math.round(timeout);
}

function timelineDetail(event) {
  const payload = summarizePayload(event.payload);
  return payload || "No payload";
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  for (const key of ["text", "message", "name", "status"]) {
    if (typeof payload[key] === "string" && payload[key].trim()) {
      return shortText(payload[key], 140);
    }
  }
  const json = JSON.stringify(payload);
  return json && json !== "{}" ? shortText(json, 140) : "";
}

function displayKind(kind) {
  return String(kind ?? "event").replaceAll("_", " ");
}

function shortText(input, maxLength) {
  const text = String(input ?? "").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
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

function setStatus(message, tone = "info") {
  statusMessageEl.textContent = message;
  statusMessageEl.dataset.tone = tone;
  statusMessageEl.classList.toggle("hidden", !message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
