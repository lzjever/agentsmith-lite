import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
      "adapters-cf",
      "product:ready",
      "gate:",
      "release:campaign"
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });

  it("keeps active workspace packages covered by the migration ledger", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      workspaces: string[];
    };
    const ledger = await readFile("docs/migration-from-reference.md", "utf8");

    for (const workspace of pkg.workspaces) {
      assert.match(ledger, new RegExp(`\\b${escapeRegExp(workspace)}\\b`));
    }
  });

  it("keeps active script roots covered by the migration ledger", async () => {
    const trackedScripts = execFileSync("git", ["ls-files", "scripts"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    const activeScriptRoots = [...new Set(trackedScripts.map(scriptLedgerAnchor))].sort();
    const ledger = await readFile("docs/migration-from-reference.md", "utf8");

    assert.deepEqual(activeScriptRoots, [
      "scripts/acceptance",
      "scripts/build-images.sh",
      "scripts/build-offline-bundle.sh",
      "scripts/check-forbidden-surfaces.sh",
      "scripts/copy-web-assets.mjs",
      "scripts/db",
      "scripts/deploy",
      "scripts/dev",
      "scripts/visual"
    ]);

    for (const scriptRoot of activeScriptRoots) {
      assert.match(ledger, new RegExp(`\`${escapeRegExp(scriptRoot)}\``), `${scriptRoot} must be documented in the migration ledger`);
    }
  });

  it("keeps forbidden surface scanning pointed at scripts without scanning generated or vendored trees", async () => {
    const check = await readFile("scripts/check-forbidden-surfaces.sh", "utf8");

    assert.match(check, /paths=\([^)]*\bscripts\b[^)]*\)/s);
    for (const excluded of [
      "--glob '!**/.reference/**'",
      "--glob '!dist/**'",
      "--glob '!out/**'",
      "--glob '!third_party/**'",
      "--glob '!**/third_party/**'"
    ]) {
      assert.ok(check.includes(excluded), `${excluded} must stay excluded from active surface scanning`);
    }
    assert.ok(check.includes("--glob '!scripts/check-forbidden-surfaces.sh'"));
    assert.match(check, /is_allowed_active_hit/);
    assert.match(check, /scripts\/deploy\/doctor\.sh:[\s\S]*pods\/exec/);
  });
});

function scriptLedgerAnchor(scriptPath: string): string {
  const parts = scriptPath.split("/");
  if (parts.length <= 2) {
    return scriptPath;
  }
  return `scripts/${parts[1]}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
