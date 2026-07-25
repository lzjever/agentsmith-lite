import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalTaskHref,
  filesReturnToAfterNavigation,
  taskViewFromSearch,
  validateTaskReturnTo
} from "../../src/components/tasks/task-peer-navigation.js";

const scope = {
  appBasePath: "",
  workspaceId: "workspace_1",
  projectId: "project_1",
};
const taskScope = { ...scope, taskId: "task_1" };

describe("Task peer navigation", () => {
  it("makes the view query the sole owner of peer selection", () => {
    assert.equal(taskViewFromSearch(""), "conversation");
    assert.equal(taskViewFromSearch("?view=nope"), "conversation");
    assert.equal(taskViewFromSearch("?view=terminal"), "terminal");
    assert.equal(taskViewFromSearch("?view=artifacts"), "artifacts");
    assert.equal(canonicalTaskHref(taskScope, "conversation", "#result"), "/workspaces/workspace_1/projects/project_1/tasks/task_1#result");
    assert.equal(canonicalTaskHref(taskScope, "terminal", "#result"), "/workspaces/workspace_1/projects/project_1/tasks/task_1?view=terminal#result");
  });

  it("accepts only the canonical same-app Task path with optional peer view and hash", () => {
    assert.equal(
      validateTaskReturnTo("/workspaces/workspace_1/projects/project_1/tasks/%74ask_1?v%69ew=%61rtifacts#%61rtifact_2", scope),
      "/workspaces/workspace_1/projects/project_1/tasks/task_1?view=artifacts#artifact_2"
    );
    assert.equal(
      validateTaskReturnTo("/workspaces/workspace_1/projects/project_1/tasks/task_1", scope),
      "/workspaces/workspace_1/projects/project_1/tasks/task_1"
    );
  });

  it("validates a based Task return path and returns a base-neutral Next route", () => {
    const basedScope = { ...scope, appBasePath: "/app" };
    assert.equal(
      validateTaskReturnTo(
        "/app/workspaces/workspace_1/projects/project_1/tasks/task_1?view=artifacts",
        basedScope
      ),
      "/workspaces/workspace_1/projects/project_1/tasks/task_1?view=artifacts"
    );

    const invalid = [
      "/workspaces/workspace_1/projects/project_1/tasks/task_1?view=artifacts",
      "/other/workspaces/workspace_1/projects/project_1/tasks/task_1?view=artifacts",
      "https://example.test/app/workspaces/workspace_1/projects/project_1/tasks/task_1",
      "//example.test/app/workspaces/workspace_1/projects/project_1/tasks/task_1",
      "/app/workspaces/workspace_1/projects/project_1/tasks/../task_1",
      "/app/workspaces/workspace_1/projects/project_1/tasks/%E0%A4%A"
    ];
    for (const value of invalid) {
      assert.equal(validateTaskReturnTo(value, basedScope), null, value);
    }
  });

  it("keeps the first validated returnTo while switching File Libraries", () => {
    const first = validateTaskReturnTo(
      "/workspaces/workspace_1/projects/project_1/tasks/task_1?view=terminal",
      scope
    );
    assert.equal(
      filesReturnToAfterNavigation(
        first,
        "/workspaces/workspace_1/projects/project_1/tasks/task_2",
        scope,
        "library"
      ),
      first
    );
    assert.equal(
      filesReturnToAfterNavigation(first, null, scope, "library"),
      first
    );
  });

  it("rejects absolute, network, backslash, dot-segment, wrong-scope, extra-query, and malformed paths", () => {
    const invalid = [
      "https://example.test/workspaces/workspace_1/projects/project_1/tasks/task_1",
      "//example.test/workspaces/workspace_1/projects/project_1/tasks/task_1",
      "/workspaces/workspace_1\\projects/project_1/tasks/task_1",
      "/workspaces/workspace_1/projects/project_1/tasks/../task_1",
      "/workspaces/workspace_1/projects/project_1/tasks/%2e%2e",
      "/workspaces/workspace_2/projects/project_1/tasks/task_1",
      "/workspaces/workspace_1/projects/project_2/tasks/task_1",
      "/workspaces/workspace_1/projects/project_1/tasks/task_1?view=terminal&extra=1",
      "/workspaces/workspace_1/projects/project_1/tasks/task_1?view=terminal&",
      "/workspaces/workspace_1/projects/project_1/tasks/task_1?",
      "/workspaces/workspace_1/projects/project_1/tasks/task_1?view=conversation",
      "/workspaces/workspace_1/projects/project_1/tasks/task_1?view=terminal&view=artifacts",
      "/workspaces/workspace_1/projects/project_1/tasks/%E0%A4%A"
    ];
    for (const value of invalid) assert.equal(validateTaskReturnTo(value, scope), null, value);
  });
});
