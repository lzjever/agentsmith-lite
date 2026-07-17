import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskInputsPanel } from "../../src/components/tasks/TaskInputsPanel.js";

describe("task inputs panel", () => {
  it("retains selected paths when no immutable input snapshot is available", () => {
    const html = renderToStaticMarkup(<TaskInputsPanel taskId="task_1" inputs={[]} selectedPaths={["files/brief.md"]} />);

    assert.match(html, /Selected paths/);
    assert.match(html, /files\/brief\.md/);
    assert.match(html, /No immutable input snapshot is available/);
    assert.doesNotMatch(html, /No project files were attached/);
  });
});
