import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appPathForApiBase } from "../../src/lib/navigation/app-path.js";

describe("appPathForApiBase", () => {
  it("preserves the configured application base path for imperative navigation", () => {
    assert.equal(
      appPathForApiBase("/workspaces/workspace_1/projects/project_1/tasks/task_2", "/app/api/v1"),
      "/app/workspaces/workspace_1/projects/project_1/tasks/task_2",
    );
  });

  it("keeps root-mounted application routes unchanged", () => {
    assert.equal(appPathForApiBase("/workspaces/workspace_1", "/api/v1"), "/workspaces/workspace_1");
  });
});
