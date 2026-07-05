import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { renderAppManifests } from "../../packages/sandbox-controller/src/appManifestRenderer.js";

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

  it("keeps deferred OIDC filtered from deploy output and app renderer", async () => {
    const plan = await readFile("docs/agentsmith-lite-product-development-plan.md", "utf8");
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-boundary-auth-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    writeFileSync(
      envFile,
      [
        "KUBE_NAMESPACE=agentsmith",
        "AUTH_MODE=builtin_admin",
        "OIDC_ISSUER_URL=",
        "OIDC_CLIENT_ID=",
        ""
      ].join("\n")
    );
    writeFileSync(secretsFile, "OIDC_CLIENT_SECRET=\n");

    assert.match(plan, /OIDC\/Keycloak、组织级 RBAC \| 内建 admin 先完成私有化闭环。/);
    assert.match(plan, /当前 app 不消费 `OIDC_CLIENT_SECRET`/);
    const generated = runEnvContract(["export", "--env", envFile, "--secrets", secretsFile]);
    assert.equal(generated.status, 0, generated.stderr);
    assert.doesNotMatch(generated.stdout, /AUTH_MODE|OIDC_ISSUER_URL|OIDC_CLIENT_ID|OIDC_CLIENT_SECRET/);

    writeFileSync(envFile, "AUTH_MODE=oidc\n");
    const oidcMode = runEnvContract(["export", "--env", envFile]);
    assert.notEqual(oidcMode.status, 0);
    assert.match(oidcMode.stderr, /AUTH_MODE/);
    assert.doesNotMatch(oidcMode.stderr + oidcMode.stdout, /oidc/);

    writeFileSync(secretsFile, "OIDC_CLIENT_SECRET=DO_NOT_PRINT_OIDC_CLIENT_SECRET\n");
    const oidcSecret = runEnvContract(["export", "--secrets", secretsFile]);
    assert.notEqual(oidcSecret.status, 0);
    assert.match(oidcSecret.stderr, /OIDC_CLIENT_SECRET/);
    assert.doesNotMatch(oidcSecret.stderr + oidcSecret.stdout, /DO_NOT_PRINT_OIDC_CLIENT_SECRET/);

    for (const [key, value] of [
      ["OIDC_ISSUER_URL", "DO_NOT_PRINT_OIDC_ISSUER_URL"],
      ["OIDC_CLIENT_ID", "DO_NOT_PRINT_OIDC_CLIENT_ID"]
    ] as const) {
      writeFileSync(envFile, `${key}=${value}\n`);
      const oidcPublicMetadata = runEnvContract(["export", "--env", envFile]);
      assert.notEqual(oidcPublicMetadata.status, 0, key);
      assert.match(oidcPublicMetadata.stderr, new RegExp(key), key);
      assert.doesNotMatch(oidcPublicMetadata.stderr + oidcPublicMetadata.stdout, new RegExp(value), key);
    }

    assertRendererRejects("AUTH_MODE", "env");
    assertRendererRejects("OIDC_ISSUER_URL", "env");
    assertRendererRejects("OIDC_CLIENT_ID", "secrets");
    assertRendererRejects("OIDC_CLIENT_SECRET", "secrets");
  });
});

function assertRendererRejects(key: string, location: "env" | "secrets"): void {
  const value = `DO_NOT_PRINT_${key}`;
  assert.throws(
    () =>
      renderAppManifests({
        namespace: "agentsmith",
        imageTag: "dev",
        env: location === "env" ? { [key]: value } : {},
        secrets: location === "secrets" ? { [key]: value } : {}
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error, key);
      assert.match(error.message, new RegExp(key), key);
      assert.doesNotMatch(error.message, new RegExp(value), key);
      return true;
    },
    `${key} in ${location}`
  );
}

function runEnvContract(args: string[]) {
  return spawnSync(process.execPath, ["scripts/deploy/env-contract.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}
