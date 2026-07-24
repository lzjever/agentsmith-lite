import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { apiClient } from "../../src/lib/api/client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("workspace directory API client", () => {
  it("uses bounded directory and authoritative exact-read endpoints", async () => {
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      requests.push(requestUrl(input));
      const path = requests.at(-1)!;
      if (path.startsWith("/api/v1/workspaces?")) return Response.json({ items: [], nextCursor: null });
      if (path.includes("/projects?")) return Response.json({ items: [], nextCursor: null, total: 0 });
      if (path.startsWith("/api/v1/projects/")) return Response.json({ project: project("project_1"), workspace: { id: "workspace_1", name: "Workspace", lifecycleStatus: "active" } });
      return Response.json({ workspace: workspace("workspace_1"), owner: { displayName: null, email: "owner@example.test" }, memberRole: "owner", capabilities: { canCreateProject: true, canManageMembers: true }, projectCount: 0 });
    };

    await apiClient.workspaces({ cursor: "workspace+/=", limit: 20 });
    await apiClient.workspace("workspace/1");
    await apiClient.workspaceProjects("workspace/1", { q: "Alpha beta", cursor: "project+/=", limit: 20 });
    await apiClient.project("project/1");

    assert.deepEqual(requests, [
      "/api/v1/workspaces?cursor=workspace%2B%2F%3D&limit=20",
      "/api/v1/workspaces/workspace%2F1",
      "/api/v1/workspaces/workspace%2F1/projects?q=Alpha+beta&cursor=project%2B%2F%3D&limit=20",
      "/api/v1/projects/project%2F1"
    ]);
  });
});

function workspace(id:string) {
  return { id, name: "Workspace", ownerUserId: "owner", lifecycleStatus: "active", createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z" };
}

function project(id:string) {
  return { id, workspaceId: "workspace_1", name: "Project", ownerUserId: "owner", rootPath: "workspaces/workspace_1/projects/project_1", taskConcurrencyLimit: 2, lifecycleStatus: "active", pinnedAt: null, createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z" };
}

function requestUrl(input:string|URL|Request):string {
  const value=typeof input==="string"?input:input instanceof URL?input.toString():input.url;
  const url=new URL(value,"https://agentsmith.test");
  return `${url.pathname}${url.search}`;
}
