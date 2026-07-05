import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("product plan boundary sanity", () => {
  it("keeps project file delete documented as server-side Core while UI delete remains deferred", async () => {
    const [plan, apiServer, fileService, storageDoc, deploySmoke] = await Promise.all([
      readFile("docs/agentsmith-lite-product-development-plan.md", "utf8"),
      readFile("packages/api-entry-node/src/server.ts", "utf8"),
      readFile("packages/application/src/fileService.ts", "utf8"),
      readFile("docs/storage-and-files.md", "utf8"),
      readFile("tests/deploy/app-smoke.test.ts", "utf8")
    ]);

    assert.match(apiServer, /method === "DELETE"[\s\S]*services\.files\.deleteFile/);
    assert.match(fileService, /async deleteFile/);
    assert.match(storageDoc, /DELETE \/api\/projects\/\{projectId\}\/files/);
    assert.match(deploySmoke, /DELETE \/api\/projects\/project_1\/files/);

    assert.match(plan, /project file list\/upload\/download\/delete/);
    assert.match(plan, /server-side file delete API/i);
    assert.match(plan, /Project file delete UI、版本化恢复和回收站 deferred/);
    assert.doesNotMatch(plan, /Project file delete 和版本化恢复 deferred/);
  });

  it("keeps the sandbox data model aligned with postgres_json_docs and runtime_leases", async () => {
    const [plan, migrationSql, sandboxDoc, storePort] = await Promise.all([
      readFile("docs/agentsmith-lite-product-development-plan.md", "utf8"),
      readFile("infra/db/migrations/001_initial_product_schema.sql", "utf8"),
      readFile("docs/sandbox-controller.md", "utf8"),
      readFile("packages/ports/src/store.ts", "utf8")
    ]);

    assert.match(plan, /`postgres_json_docs` collection `sandbox_run_state` \+ `runtime_leases`/);
    assert.doesNotMatch(plan, /\| sandbox \| `sandbox_runs`, `sandbox_leases` \|/);
    assert.match(sandboxDoc, /postgres_json_docs[\s\S]*sandbox_run_state/);
    assert.match(storePort, /"sandbox_run_state"/);

    assert.match(migrationSql, /create table if not exists postgres_json_docs/);
    assert.match(migrationSql, /create table if not exists runtime_leases/);
    assert.doesNotMatch(migrationSql, /create table if not exists sandbox_runs/);
    assert.doesNotMatch(migrationSql, /create table if not exists sandbox_leases/);
  });

  it("keeps app manifest layout documented as renderer output instead of tracked static manifests", async () => {
    const [plan, renderScript, renderer] = await Promise.all([
      readFile("docs/agentsmith-lite-product-development-plan.md", "utf8"),
      readFile("scripts/deploy/render-manifests.mjs", "utf8"),
      readFile("packages/sandbox-controller/src/appManifestRenderer.ts", "utf8")
    ]);
    const trackedStaticManifests = execFileSync("git", ["ls-files", "infra/k8s"], { encoding: "utf8" }).trim();

    assert.equal(trackedStaticManifests, "");
    assert.match(renderScript, /renderAppManifests/);
    assert.match(renderer, /export function renderAppManifests/);
    assert.match(plan, /`out\/manifests\/` \| `scripts\/deploy\/render\.sh` via `packages\/sandbox-controller\/src\/appManifestRenderer\.ts`/);
    assert.doesNotMatch(plan, /`infra\/k8s`|infra\/k8s\//);
  });
});
