import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("repo scope", () => {
  it("declares only the Lite workspace packages and no removed runtime packages or commands", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      workspaces: string[];
      scripts: Record<string, string>;
    };

    assert.deepEqual(pkg.workspaces, [
      "packages/contracts",
      "packages/domain",
      "packages/ports",
      "packages/application",
      "packages/adapters-postgres",
      "packages/sandbox-controller",
      "packages/botified-runtime",
      "packages/openai-compatible-client",
      "packages/api-entry-node"
    ]);

    const serialized = JSON.stringify(pkg);
    for (const forbidden of [
      "agent-task-runner",
      "agent-runner-contract",
      "api-entry-cf",
      "adapters-cf"
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });
});
