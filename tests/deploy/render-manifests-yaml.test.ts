import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

describe("render manifests YAML", () => {
  it("keeps the installer namespace out of app manifests and renders app resources in KUBE_NAMESPACE", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-render-namespace-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    const outDir = path.join(tempDir, "manifests");

    writeFileSync(
      envFile,
      "SUBSTRATE_NAMESPACE=agentsmith-substrates\nKUBE_NAMESPACE=agentsmith-app\nAPP_PUBLIC_BASE_URL=https://agentsmith.example.test/app\nAUTH_MODE=oidc\nOIDC_ISSUER_URL=https://keycloak.example.test/realms/agentsmith\nOIDC_CLIENT_ID=agentsmith-lite\n"
    );
    writeFileSync(secretsFile, "OIDC_CLIENT_SECRET=oidc-client-secret\n");

    const result = spawnSync(
      "bash",
      ["scripts/deploy/render.sh", "--env", envFile, "--secrets", secretsFile, "--out", outDir, "--tag", "dev"],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    assert.equal(result.status, 0, result.stderr);
    const manifest = readFileSync(path.join(outDir, "all.yaml"), "utf8");
    assert.doesNotMatch(manifest, /SUBSTRATE_NAMESPACE|agentsmith-substrates/);
    assert.match(manifest, /kind: "Role"\n\s+metadata:\n\s+name: "agentsmith-lite-api-sandbox"\n\s+namespace: "agentsmith-app"/);
    assert.match(manifest, /kind: "RoleBinding"\n\s+metadata:\n\s+name: "agentsmith-lite-api-sandbox"\n\s+namespace: "agentsmith-app"/);
    assert.deepEqual(
      [...manifest.matchAll(/^\s+namespace: "([^"]+)"$/gm)].map((match) => match[1]).every((namespace) => namespace === "agentsmith-app"),
      true
    );
  });

  it("quotes ConfigMap.data and Secret.stringData strings that look like YAML scalars", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-render-yaml-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    const appEnvFile = path.join(tempDir, "app.env");
    const appSecretsFile = path.join(tempDir, "app.secrets.env");
    const outDir = path.join(tempDir, "manifests");

    writeFileSync(
      envFile,
      "KUBE_NAMESPACE=agentsmith\nAPP_PUBLIC_BASE_URL=https://agentsmith.example.test\nAUTH_MODE=oidc\nOIDC_ISSUER_URL=https://keycloak.example.test/realms/agentsmith\nOIDC_CLIENT_ID=agentsmith-lite\n"
    );
    writeFileSync(secretsFile, "OIDC_CLIENT_SECRET=oidc-client-secret\n");
    writeFileSync(appEnvFile, "AGENTSMITH_LITE_RUNTIME_TICK_MS=1000\nAGENTSMITH_LITE_SANDBOX_MODE=true\n");
    writeFileSync(appSecretsFile, "APP_CREDENTIAL_ENCRYPTION_KEY=1000\n");

    const result = spawnSync(
      "bash",
      [
        "scripts/deploy/render.sh",
        "--env",
        envFile,
        "--secrets",
        secretsFile,
        "--app-env",
        appEnvFile,
        "--app-secrets",
        appSecretsFile,
        "--out",
        outDir,
        "--tag",
        "dev"
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    assert.equal(result.status, 0, result.stderr);
    const manifest = readFileSync(path.join(outDir, "all.yaml"), "utf8");
    assert.match(manifest, /AGENTSMITH_LITE_RUNTIME_TICK_MS: "1000"/);
    assert.match(manifest, /AGENTSMITH_LITE_SANDBOX_MODE: "true"/);
    assert.match(manifest, /APP_CREDENTIAL_ENCRYPTION_KEY: "1000"/);
  });

  it("derives both local image refs from the render tag instead of app overlay input", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-render-image-tag-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    const appEnvFile = path.join(tempDir, "app.env");
    const outDir = path.join(tempDir, "manifests");
    writeFileSync(
      envFile,
      "KUBE_NAMESPACE=agentsmith\nAPP_PUBLIC_BASE_URL=https://agentsmith.example.test\nAUTH_MODE=oidc\nOIDC_ISSUER_URL=https://keycloak.example.test/realms/agentsmith\nOIDC_CLIENT_ID=agentsmith-lite\n"
    );
    writeFileSync(secretsFile, "OIDC_CLIENT_SECRET=oidc-client-secret\n");
    writeFileSync(appEnvFile, "BOTIFIED_RUNNER_IMAGE=agentsmith-lite/botified-runner:stale\n");

    const result = spawnSync(
      "bash",
      [
        "scripts/deploy/render.sh",
        "--env",
        envFile,
        "--secrets",
        secretsFile,
        "--app-env",
        appEnvFile,
        "--out",
        outDir,
        "--tag",
        "local-20260711"
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);
    const manifest = readFileSync(path.join(outDir, "all.yaml"), "utf8");
    assert.match(manifest, /agentsmith-lite\/app:local-20260711/);
    assert.match(manifest, /BOTIFIED_RUNNER_IMAGE: "agentsmith-lite\/botified-runner:local-20260711"/);
    assert.doesNotMatch(manifest, /botified-runner:stale/);
  });

  it("requires the public URL used to build the Next application", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-render-public-url-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    const outDir = path.join(tempDir, "manifests");
    writeFileSync(
      envFile,
      "KUBE_NAMESPACE=agentsmith\nAUTH_MODE=oidc\nOIDC_ISSUER_URL=https://keycloak.example.test/realms/agentsmith\nOIDC_CLIENT_ID=agentsmith-lite\n"
    );
    writeFileSync(secretsFile, "OIDC_CLIENT_SECRET=oidc-client-secret\n");

    const result = spawnSync(
      "bash",
      ["scripts/deploy/render.sh", "--env", envFile, "--secrets", secretsFile, "--out", outDir, "--tag", "dev"],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /APP_PUBLIC_BASE_URL is required/);
  });
});
