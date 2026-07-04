import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderAppManifests } from "../../packages/sandbox-controller/src/appManifestRenderer.js";

describe("app manifest rendering", () => {
  it("renders only app-owned secrets and leaves raw S3/JuiceFS credentials to the substrate", () => {
    const manifests = renderAppManifests({
      namespace: "agentsmith",
      imageTag: "dev",
      env: {
        KUBE_NAMESPACE: "agentsmith",
        JUICEFS_PVC_NAME: "agentsmith-lite-files",
        APP_PUBLIC_BASE_URL: "https://agentsmith.example.com",
        AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI: "https://models.example.com/v1",
        S3_ENDPOINT: "https://s3.example.com",
        S3_BUCKET: "agentsmith-lite-files",
        JUICEFS_SECRET_NAME: "agentsmith-lite-juicefs"
      },
      secrets: {
        POSTGRES_APP_URL: "postgresql://app:secret@db/app",
        APP_SESSION_SECRET: "app-session-secret",
        BUILTIN_ADMIN_INITIAL_PASSWORD: "admin-secret",
        AGENTSMITH_LITE_MODEL_API_KEY_OPENAI: "sk-openai",
        S3_ACCESS_KEY: "raw-access",
        S3_SECRET_KEY: "raw-secret",
        JUICEFS_META_URL: "postgresql://juicefs:secret@db/juicefs"
      }
    });

    const serialized = JSON.stringify(manifests);
    assert.match(serialized, /POSTGRES_APP_URL/);
    assert.match(serialized, /APP_SESSION_SECRET/);
    assert.match(serialized, /BUILTIN_ADMIN_INITIAL_PASSWORD/);
    assert.match(serialized, /AGENTSMITH_LITE_MODEL_API_KEY_OPENAI/);
    assert.match(serialized, /sk-openai/);
    assert.match(serialized, /AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI/);
    assert.match(serialized, /https:\/\/models\.example\.com\/v1/);
    assert.doesNotMatch(serialized, /S3_ACCESS_KEY/);
    assert.doesNotMatch(serialized, /S3_SECRET_KEY/);
    assert.doesNotMatch(serialized, /JUICEFS_META_URL/);
    assert.doesNotMatch(serialized, /raw-access/);
    assert.doesNotMatch(serialized, /raw-secret/);

    const configMap = manifests.find((manifest) => manifest.kind === "ConfigMap" && manifest.metadata.name === "agentsmith-lite-config");
    const secret = manifests.find((manifest) => manifest.kind === "Secret" && manifest.metadata.name === "agentsmith-lite-app-secrets");
    const configMapData = (configMap as { data?: Record<string, string> } | undefined)?.data;
    const secretData = (secret as { stringData?: Record<string, string> } | undefined)?.stringData;
    assert.equal(configMapData?.AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI, "https://models.example.com/v1");
    assert.equal(secretData?.AGENTSMITH_LITE_MODEL_API_KEY_OPENAI, "sk-openai");
    assert.equal(secretData?.AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI, undefined);
  });
});
