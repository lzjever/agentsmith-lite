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

  it("grants the API only namespace-scoped sandbox lifecycle resources", () => {
    const manifests = renderAppManifests({
      namespace: "agentsmith",
      imageTag: "dev",
      env: {},
      secrets: {}
    });
    const role = manifests.find((manifest) => manifest.kind === "Role" && manifest.metadata.name === "agentsmith-lite-api-sandbox") as
      | RoleResource
      | undefined;

    assert.ok(role, "API sandbox Role should be rendered");
    assert.ok(
      role.rules.some(
        (rule) =>
          rule.apiGroups.length === 1 &&
          rule.apiGroups[0] === "" &&
          ["pods", "services", "secrets", "configmaps", "serviceaccounts"].every((resource) => rule.resources.includes(resource))
      )
    );
    assert.ok(
      role.rules.some(
        (rule) =>
          rule.apiGroups.includes("networking.k8s.io") &&
          rule.resources.includes("networkpolicies") &&
          ["create", "get", "list", "delete", "patch"].every((verb) => rule.verbs.includes(verb))
      )
    );

    const resources = role.rules.flatMap((rule) => rule.resources);
    for (const forbidden of [
      "pods/exec",
      "pods/log",
      "pods/attach",
      "pods/portforward",
      "persistentvolumes",
      "persistentvolumeclaims",
      "storageclasses",
      "nodes",
      "namespaces",
      "clusterroles",
      "clusterrolebindings"
    ]) {
      assert.equal(resources.includes(forbidden), false, `${forbidden} must not be granted`);
    }
  });
});

interface RoleResource {
  kind: "Role";
  metadata: {
    name: string;
  };
  rules: Array<{
    apiGroups: string[];
    resources: string[];
    verbs: string[];
  }>;
}
