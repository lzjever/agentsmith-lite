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
        S3_ENDPOINT: "https://s3.example.com",
        S3_BUCKET: "agentsmith-lite-files",
        JUICEFS_SECRET_NAME: "agentsmith-lite-juicefs"
      },
      secrets: {
        POSTGRES_APP_URL: "postgresql://app:secret@db/app",
        APP_SESSION_SECRET: "app-session-secret",
        BUILTIN_ADMIN_INITIAL_PASSWORD: "admin-secret",
        S3_ACCESS_KEY: "raw-access",
        S3_SECRET_KEY: "raw-secret",
        JUICEFS_META_URL: "postgresql://juicefs:secret@db/juicefs"
      }
    });

    const serialized = JSON.stringify(manifests);
    assert.match(serialized, /POSTGRES_APP_URL/);
    assert.match(serialized, /APP_SESSION_SECRET/);
    assert.match(serialized, /BUILTIN_ADMIN_INITIAL_PASSWORD/);
    assert.doesNotMatch(serialized, /S3_ACCESS_KEY/);
    assert.doesNotMatch(serialized, /S3_SECRET_KEY/);
    assert.doesNotMatch(serialized, /JUICEFS_META_URL/);
    assert.doesNotMatch(serialized, /raw-access/);
    assert.doesNotMatch(serialized, /raw-secret/);
  });
});
