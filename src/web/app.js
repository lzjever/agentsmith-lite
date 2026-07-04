const state = {
  csrfToken: null,
  workspaceId: null,
  projectId: null,
  endpointId: null
};

const healthEl = document.querySelector("#health");
const loginEl = document.querySelector("#login");
const dashboardEl = document.querySelector("#dashboard");
const loginForm = document.querySelector("#login-form");
const seedButton = document.querySelector("#seed");

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
  const endpoint = await api(`/api/projects/${project.id}/endpoints`, {
    method: "POST",
    csrf: state.csrfToken,
    body: {
      name: "Compatible Model",
      protocol: "openai_chat_completions",
      baseUrl: "https://models.example.com/v1",
      model: "gpt-compatible",
      apiKeySecretRef: "secret/demo",
      capabilities: ["text"],
      requestTimeoutSecs: 30
    }
  });
  await api(`/api/projects/${project.id}/tasks`, {
    method: "POST",
    csrf: state.csrfToken,
    body: {
      endpointId: endpoint.id,
      prompt: "Summarize project status"
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
}

function renderDashboard(data) {
  const workspaces = document.querySelector("#workspaces");
  const endpoints = document.querySelector("#endpoints");
  const tasks = document.querySelector("#tasks");
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

