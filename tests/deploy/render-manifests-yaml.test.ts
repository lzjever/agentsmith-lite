import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

describe("render manifests YAML", () => {
  it("quotes ConfigMap.data and Secret.stringData strings that look like YAML scalars", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-render-yaml-"));
    const envFile = path.join(tempDir, "substrate.env");
    const appEnvFile = path.join(tempDir, "app.env");
    const appSecretsFile = path.join(tempDir, "app.secrets.env");
    const outDir = path.join(tempDir, "manifests");

    writeFileSync(envFile, "KUBE_NAMESPACE=agentsmith\n");
    writeFileSync(appEnvFile, "AGENTSMITH_LITE_RUNTIME_TICK_MS=1000\nAGENTSMITH_LITE_SANDBOX_MODE=true\n");
    writeFileSync(
      appSecretsFile,
      "AGENTSMITH_LITE_MODEL_API_KEY_NUMERIC=1000\nAGENTSMITH_LITE_MODEL_API_KEY_BOOLEAN=true\n"
    );

    const result = spawnSync(
      "bash",
      ["scripts/deploy/render.sh", "--env", envFile, "--app-env", appEnvFile, "--app-secrets", appSecretsFile, "--out", outDir, "--tag", "dev"],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    assert.equal(result.status, 0, result.stderr);
    const manifest = readFileSync(path.join(outDir, "all.yaml"), "utf8");
    assert.match(manifest, /AGENTSMITH_LITE_RUNTIME_TICK_MS: "1000"/);
    assert.match(manifest, /AGENTSMITH_LITE_SANDBOX_MODE: "true"/);
    assert.match(manifest, /AGENTSMITH_LITE_MODEL_API_KEY_NUMERIC: "1000"/);
    assert.match(manifest, /AGENTSMITH_LITE_MODEL_API_KEY_BOOLEAN: "true"/);
  });
});
