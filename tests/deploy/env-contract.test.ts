import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

describe("deploy env contract", () => {
  it("accepts the generated substrates env/secrets shape while exporting only app-consumed keys", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-env-contract-generated-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    writeGeneratedSubstrateFiles(envFile, secretsFile);

    const result = runContract(["export", "--env", envFile, "--secrets", secretsFile]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readAssignments(result.stdout), {
      KUBECONFIG_PATH: "/tmp/agentsmith.kubeconfig",
      KUBE_CONTEXT: "kind-agentsmith",
      KUBE_NAMESPACE: "agentsmith-preview",
      JUICEFS_PVC_NAME: "agentsmith-lite-files",
      APP_PUBLIC_BASE_URL: "https://agentsmith.example.test/app",
      APP_INGRESS_CLASS: "nginx",
      APP_TLS_SECRET_NAME: "agentsmith-lite-tls",
      POSTGRES_APP_URL: "postgresql://app:secret@db/agentsmith",
      APP_SESSION_SECRET: "app-session-secret-at-least-32-chars",
      BUILTIN_ADMIN_INITIAL_PASSWORD: "admin-secret-from-substrate"
    });
    assert.doesNotMatch(result.stdout, /KUBERNETES_SKIP_K3S/);
    assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_PRINT/);
  });

  it("accepts generated OIDC substrate env/secrets while exporting only app-consumed keys", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-env-contract-oidc-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    writeFileSync(
      envFile,
      [
        "KUBE_NAMESPACE=agentsmith-preview",
        "APP_PUBLIC_BASE_URL=https://agentsmith.example.test/app",
        "AUTH_MODE=oidc",
        "OIDC_ISSUER_URL=https://keycloak.example.test/realms/agentsmith",
        "OIDC_BACKCHANNEL_BASE_URL=http://keycloak.keycloak.svc.cluster.local/realms/agentsmith",
        "OIDC_CLIENT_ID=agentsmith-lite",
        "OIDC_BOOTSTRAP_USERNAME=DO_NOT_PRINT_OIDC_BOOTSTRAP_USERNAME",
        "S3_ENDPOINT=DO_NOT_PRINT_S3_ENDPOINT",
        "JUICEFS_SECRET_NAME=DO_NOT_PRINT_JUICEFS_SECRET_NAME",
        "JUICEFS_PVC_NAME=agentsmith-lite-files",
        ""
      ].join("\n")
    );
    writeFileSync(
      secretsFile,
      [
        "POSTGRES_APP_URL=postgresql://app:secret@db/agentsmith",
        "APP_SESSION_SECRET=app-session-secret-at-least-32-chars",
        "OIDC_CLIENT_SECRET=oidc-client-secret",
        "OIDC_BOOTSTRAP_PASSWORD=DO_NOT_PRINT_OIDC_BOOTSTRAP_PASSWORD",
        "S3_SECRET_KEY=DO_NOT_PRINT_S3_SECRET_KEY",
        "JUICEFS_META_URL=DO_NOT_PRINT_JUICEFS_META_URL",
        ""
      ].join("\n")
    );

    const result = runContract(["export", "--env", envFile, "--secrets", secretsFile]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readAssignments(result.stdout), {
      KUBE_NAMESPACE: "agentsmith-preview",
      APP_PUBLIC_BASE_URL: "https://agentsmith.example.test/app",
      AUTH_MODE: "oidc",
      OIDC_ISSUER_URL: "https://keycloak.example.test/realms/agentsmith",
      OIDC_BACKCHANNEL_BASE_URL: "http://keycloak.keycloak.svc.cluster.local/realms/agentsmith",
      OIDC_CLIENT_ID: "agentsmith-lite",
      JUICEFS_PVC_NAME: "agentsmith-lite-files",
      POSTGRES_APP_URL: "postgresql://app:secret@db/agentsmith",
      APP_SESSION_SECRET: "app-session-secret-at-least-32-chars",
      OIDC_CLIENT_SECRET: "oidc-client-secret"
    });
    assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_PRINT/);
  });

  it("rejects malformed auth substrate values without printing their values", () => {
    const cases: Array<{
      name: string;
      envContents?: string;
      secretsContents?: string;
      error: RegExp;
      leakedValue: RegExp;
    }> = [
      {
        name: "non-builtin and non-oidc auth mode",
        envContents: "AUTH_MODE=DO_NOT_PRINT_AUTH_MODE\n",
        error: /AUTH_MODE/,
        leakedValue: /DO_NOT_PRINT_AUTH_MODE/
      },
      {
        name: "builtin with non-empty OIDC issuer URL",
        envContents: "AUTH_MODE=builtin_admin\nOIDC_ISSUER_URL=DO_NOT_PRINT_OIDC_ISSUER_URL\n",
        secretsContents: "OIDC_CLIENT_SECRET=\n",
        error: /OIDC_ISSUER_URL/,
        leakedValue: /DO_NOT_PRINT_OIDC_ISSUER_URL/
      },
      {
        name: "builtin with non-empty OIDC backchannel URL",
        envContents: "AUTH_MODE=builtin_admin\nOIDC_BACKCHANNEL_BASE_URL=DO_NOT_PRINT_OIDC_BACKCHANNEL_BASE_URL\n",
        secretsContents: "OIDC_CLIENT_SECRET=\n",
        error: /OIDC_BACKCHANNEL_BASE_URL/,
        leakedValue: /DO_NOT_PRINT_OIDC_BACKCHANNEL_BASE_URL/
      },
      {
        name: "builtin with non-empty OIDC client ID",
        envContents: "AUTH_MODE=builtin_admin\nOIDC_CLIENT_ID=DO_NOT_PRINT_OIDC_CLIENT_ID\n",
        secretsContents: "OIDC_CLIENT_SECRET=\n",
        error: /OIDC_CLIENT_ID/,
        leakedValue: /DO_NOT_PRINT_OIDC_CLIENT_ID/
      },
      {
        name: "builtin with non-empty OIDC client secret",
        envContents: "AUTH_MODE=builtin_admin\nOIDC_ISSUER_URL=\nOIDC_CLIENT_ID=\n",
        secretsContents: "OIDC_CLIENT_SECRET=DO_NOT_PRINT_OIDC_CLIENT_SECRET\n",
        error: /OIDC_CLIENT_SECRET/,
        leakedValue: /DO_NOT_PRINT_OIDC_CLIENT_SECRET/
      },
      {
        name: "OIDC without issuer URL",
        envContents: "AUTH_MODE=oidc\nOIDC_CLIENT_ID=agentsmith-lite\n",
        secretsContents: "OIDC_CLIENT_SECRET=DO_NOT_PRINT_OIDC_CLIENT_SECRET\n",
        error: /OIDC_ISSUER_URL/,
        leakedValue: /DO_NOT_PRINT_OIDC_CLIENT_SECRET/
      },
      {
        name: "OIDC without client ID",
        envContents: "AUTH_MODE=oidc\nOIDC_ISSUER_URL=https://keycloak.example.test/realms/agentsmith\n",
        secretsContents: "OIDC_CLIENT_SECRET=DO_NOT_PRINT_OIDC_CLIENT_SECRET\n",
        error: /OIDC_CLIENT_ID/,
        leakedValue: /DO_NOT_PRINT_OIDC_CLIENT_SECRET/
      },
      {
        name: "OIDC without client secret",
        envContents: "AUTH_MODE=oidc\nOIDC_ISSUER_URL=https://keycloak.example.test/realms/agentsmith\nOIDC_CLIENT_ID=agentsmith-lite\n",
        secretsContents: "",
        error: /OIDC_CLIENT_SECRET/,
        leakedValue: /agentsmith-lite/
      },
      {
        name: "OIDC secret misplaced in env",
        envContents: "AUTH_MODE=oidc\nOIDC_ISSUER_URL=https://keycloak.example.test/realms/agentsmith\nOIDC_CLIENT_ID=agentsmith-lite\nOIDC_CLIENT_SECRET=DO_NOT_PRINT_OIDC_CLIENT_SECRET\n",
        error: /OIDC_CLIENT_SECRET/,
        leakedValue: /DO_NOT_PRINT_OIDC_CLIENT_SECRET/
      },
      {
        name: "OIDC public metadata misplaced in secrets",
        envContents: "AUTH_MODE=oidc\n",
        secretsContents: "OIDC_ISSUER_URL=DO_NOT_PRINT_OIDC_ISSUER_URL\nOIDC_CLIENT_ID=agentsmith-lite\nOIDC_CLIENT_SECRET=secret\n",
        error: /OIDC_ISSUER_URL/,
        leakedValue: /DO_NOT_PRINT_OIDC_ISSUER_URL/
      },
      {
        name: "OIDC backchannel URL misplaced in secrets",
        envContents: "AUTH_MODE=oidc\nOIDC_ISSUER_URL=https://keycloak.example.test/realms/agentsmith\nOIDC_CLIENT_ID=agentsmith-lite\n",
        secretsContents: "OIDC_BACKCHANNEL_BASE_URL=DO_NOT_PRINT_OIDC_BACKCHANNEL_BASE_URL\nOIDC_CLIENT_SECRET=secret\n",
        error: /OIDC_BACKCHANNEL_BASE_URL/,
        leakedValue: /DO_NOT_PRINT_OIDC_BACKCHANNEL_BASE_URL/
      }
    ];

    for (const candidate of cases) {
      const tempDir = mkdtempSync(path.join(tmpdir(), `agentsmith-lite-env-contract-${candidate.name.replace(/\s+/g, "-")}-`));
      const envFile = path.join(tempDir, "substrate.env");
      const secretsFile = path.join(tempDir, "substrate.secrets.env");
      if (candidate.envContents !== undefined) {
        writeFileSync(envFile, candidate.envContents);
      }
      if (candidate.secretsContents !== undefined) {
        writeFileSync(secretsFile, candidate.secretsContents);
      }

      const result = runContract([
        "export",
        ...(candidate.envContents !== undefined ? ["--env", envFile] : []),
        ...(candidate.secretsContents !== undefined ? ["--secrets", secretsFile] : [])
      ]);

      assert.notEqual(result.status, 0, candidate.name);
      assert.match(result.stderr, candidate.error, candidate.name);
      assert.doesNotMatch(result.stderr + result.stdout, candidate.leakedValue, candidate.name);
    }
  });

  it("rejects app-only keys in substrate env without printing the value", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-env-contract-app-only-substrate-"));
    const envFile = path.join(tempDir, "substrate.env");
    writeFileSync(envFile, "AGENTSMITH_LITE_SANDBOX_MODE=DO_NOT_PRINT_SANDBOX_MODE\n");

    const result = runContract(["export", "--env", envFile]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AGENTSMITH_LITE_SANDBOX_MODE/);
    assert.doesNotMatch(result.stderr + result.stdout, /DO_NOT_PRINT_SANDBOX_MODE/);
  });

  it("exports the substrate intersection plus app env and secret overlays", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-env-contract-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    const appEnvFile = path.join(tempDir, "app.env");
    const appSecretsFile = path.join(tempDir, "app.secrets.env");
    writeFileSync(
      envFile,
      [
        "",
        "# substrate env",
        "export KUBE_NAMESPACE='agentsmith-preview'",
        "APP_PUBLIC_BASE_URL=\"https://agentsmith.example.test/app\"",
        "JUICEFS_PVC_NAME=\"agentsmith-lite-files\"",
        "S3_ACCESS_KEY=DO_NOT_PRINT_S3_ACCESS",
        "JUICEFS_META_URL=DO_NOT_PRINT_JUICEFS_META",
        ""
      ].join("\n")
    );
    writeFileSync(
      secretsFile,
      [
        "# product secrets",
        "POSTGRES_APP_URL='postgresql://app:secret@db/agentsmith'",
        "export APP_SESSION_SECRET=\"app-session-secret-at-least-32-chars\"",
        "S3_SECRET_KEY=DO_NOT_PRINT_S3_SECRET",
        "JUICEFS_ACCESS_KEY=DO_NOT_PRINT_JUICEFS_ACCESS",
        ""
      ].join("\n")
    );
    writeFileSync(
      appEnvFile,
      [
        "# app overlay",
        "BOTIFIED_RUNNER_IMAGE='registry.example.test/agentsmith/botified-runner:release'",
        "AGENTSMITH_LITE_DATA_DIR=\"/agentsmith-lite-data\"",
        "AGENTSMITH_LITE_SANDBOX_MODE=live",
        "AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT=7",
        "AGENTSMITH_LITE_RUNTIME_TICK_MS=1000",
        "AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI='https://models.example.test/v1'",
        ""
      ].join("\n")
    );
    writeFileSync(appSecretsFile, "AGENTSMITH_LITE_MODEL_API_KEY_OPENAI='sk-from-overlay'\n");

    const result = runContract(["export", "--env", envFile, "--secrets", secretsFile, "--app-env", appEnvFile, "--app-secrets", appSecretsFile]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readAssignments(result.stdout), {
      KUBE_NAMESPACE: "agentsmith-preview",
      APP_PUBLIC_BASE_URL: "https://agentsmith.example.test/app",
      JUICEFS_PVC_NAME: "agentsmith-lite-files",
      POSTGRES_APP_URL: "postgresql://app:secret@db/agentsmith",
      APP_SESSION_SECRET: "app-session-secret-at-least-32-chars",
      BOTIFIED_RUNNER_IMAGE: "registry.example.test/agentsmith/botified-runner:release",
      AGENTSMITH_LITE_DATA_DIR: "/agentsmith-lite-data",
      AGENTSMITH_LITE_SANDBOX_MODE: "live",
      AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT: "7",
      AGENTSMITH_LITE_RUNTIME_TICK_MS: "1000",
      AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI: "https://models.example.test/v1",
      AGENTSMITH_LITE_MODEL_API_KEY_OPENAI: "sk-from-overlay"
    });
    assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_PRINT/);
  });

  it("fails closed for unknown overlay keys and misplaced overlay config or secrets", () => {
    const cases: Array<{
      name: string;
      file: "app.env" | "app.secrets.env";
      contents: string;
      error: RegExp;
      leakedValue: RegExp;
    }> = [
      {
        name: "unknown app env",
        file: "app.env",
        contents: "NOT_APP_OVERLAY=DO_NOT_PRINT_UNKNOWN_OVERLAY\n",
        error: /NOT_APP_OVERLAY/,
        leakedValue: /DO_NOT_PRINT_UNKNOWN_OVERLAY/
      },
      {
        name: "secret in app env",
        file: "app.env",
        contents: "AGENTSMITH_LITE_MODEL_API_KEY_OPENAI=DO_NOT_PRINT_MODEL_SECRET\n",
        error: /AGENTSMITH_LITE_MODEL_API_KEY_OPENAI/,
        leakedValue: /DO_NOT_PRINT_MODEL_SECRET/
      },
      {
        name: "config in app secrets",
        file: "app.secrets.env",
        contents: "AGENTSMITH_LITE_SANDBOX_MODE=DO_NOT_PRINT_SANDBOX_CONFIG\n",
        error: /AGENTSMITH_LITE_SANDBOX_MODE/,
        leakedValue: /DO_NOT_PRINT_SANDBOX_CONFIG/
      }
    ];

    for (const candidate of cases) {
      const tempDir = mkdtempSync(path.join(tmpdir(), `agentsmith-lite-env-contract-${candidate.name.replace(/\s+/g, "-")}-`));
      const overlayFile = path.join(tempDir, candidate.file);
      writeFileSync(overlayFile, candidate.contents);

      const result = candidate.file === "app.env"
        ? runContract(["export", "--app-env", overlayFile])
        : runContract(["export", "--app-secrets", overlayFile]);

      assert.notEqual(result.status, 0, candidate.name);
      assert.match(result.stderr, candidate.error, candidate.name);
      assert.doesNotMatch(result.stderr + result.stdout, candidate.leakedValue, candidate.name);
    }
  });

  it("fails closed for unknown env keys without printing the value", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-env-contract-unknown-"));
    const envFile = path.join(tempDir, "substrate.env");
    writeFileSync(envFile, "KUBE_NAMESPCE=DO_NOT_PRINT_NAMESPACE_TYPO\n");

    const result = runContract(["export", "--env", envFile]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /KUBE_NAMESPCE/);
    assert.doesNotMatch(result.stderr + result.stdout, /DO_NOT_PRINT_NAMESPACE_TYPO/);
  });

  it("rejects secrets in env and non-secret app config in secrets", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-env-contract-kind-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    writeFileSync(envFile, "POSTGRES_APP_URL=DO_NOT_PRINT_POSTGRES_URL\n");
    writeFileSync(secretsFile, "APP_PUBLIC_BASE_URL=DO_NOT_PRINT_PUBLIC_URL\n");

    const envResult = runContract(["export", "--env", envFile]);
    const secretsResult = runContract(["export", "--secrets", secretsFile]);

    assert.notEqual(envResult.status, 0);
    assert.match(envResult.stderr, /POSTGRES_APP_URL/);
    assert.doesNotMatch(envResult.stderr + envResult.stdout, /DO_NOT_PRINT_POSTGRES_URL/);
    assert.notEqual(secretsResult.status, 0);
    assert.match(secretsResult.stderr, /APP_PUBLIC_BASE_URL/);
    assert.doesNotMatch(secretsResult.stderr + secretsResult.stdout, /DO_NOT_PRINT_PUBLIC_URL/);
  });

  it("does not execute command substitution, backticks, or PATH overrides while parsing", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-env-contract-malicious-"));
    const envFile = path.join(tempDir, "substrate.env");
    const marker = path.join(tempDir, "marker");
    const backtickMarker = path.join(tempDir, "backtick-marker");
    writeFileSync(
      envFile,
      [
        `APP_PUBLIC_BASE_URL=$(touch ${marker})`,
        `S3_ACCESS_KEY=$(touch ${path.join(tempDir, "substrate-marker")})`,
        "JUICEFS_META_URL=DO_NOT_PRINT_JUICEFS_META",
        ""
      ].join("\n")
    );
    const appEnvFile = path.join(tempDir, "app.env");
    writeFileSync(
      appEnvFile,
      [
        `AGENTSMITH_LITE_DATA_DIR=\`touch ${backtickMarker}\``,
        "PATH=/tmp/should-not-be-accepted",
        ""
      ].join("\n")
    );

    const result = runContract(["export", "--env", envFile, "--app-env", appEnvFile]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PATH/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(backtickMarker), false);
    assert.doesNotMatch(result.stderr + result.stdout, /should-not-be-accepted/);
  });
});

function runContract(args: string[]) {
  return spawnSync(process.execPath, ["scripts/deploy/env-contract.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

function readAssignments(output: string): Record<string, string> {
  return Object.fromEntries(
    output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const equals = line.indexOf("=");
      return [line.slice(0, equals), line.slice(equals + 1)];
    })
  );
}

function writeGeneratedSubstrateFiles(envFile: string, secretsFile: string): void {
  writeFileSync(
    envFile,
    [
      "SUBSTRATE_SCHEMA_VERSION=DO_NOT_PRINT_SCHEMA_VERSION_ENV",
      "KUBECONFIG_PATH=/tmp/agentsmith.kubeconfig",
      "KUBE_CONTEXT=kind-agentsmith",
      "KUBE_NAMESPACE=agentsmith-preview",
      "KUBERNETES_SKIP_K3S=true",
      "S3_ENDPOINT=DO_NOT_PRINT_S3_ENDPOINT",
      "S3_REGION=DO_NOT_PRINT_S3_REGION",
      "S3_BUCKET=DO_NOT_PRINT_S3_BUCKET",
      "S3_FORCE_PATH_STYLE=DO_NOT_PRINT_S3_FORCE_PATH_STYLE",
      "AUTH_MODE=builtin_admin",
      "OIDC_ISSUER_URL=",
      "OIDC_CLIENT_ID=",
      "JUICEFS_VOLUME_NAME=DO_NOT_PRINT_JUICEFS_VOLUME_NAME",
      "JUICEFS_BUCKET=DO_NOT_PRINT_JUICEFS_BUCKET",
      "JUICEFS_SECRET_NAME=DO_NOT_PRINT_JUICEFS_SECRET_NAME",
      "JUICEFS_CSI_DRIVER=DO_NOT_PRINT_JUICEFS_CSI_DRIVER",
      "JUICEFS_STORAGE_CLASS=DO_NOT_PRINT_JUICEFS_STORAGE_CLASS",
      "JUICEFS_PVC_NAME=agentsmith-lite-files",
      "JUICEFS_MOUNT_ROOT=DO_NOT_PRINT_JUICEFS_MOUNT_ROOT",
      "APP_PUBLIC_BASE_URL=https://agentsmith.example.test/app",
      "APP_INGRESS_CLASS=nginx",
      "APP_TLS_SECRET_NAME=agentsmith-lite-tls",
      "REGISTRY_URL=DO_NOT_PRINT_REGISTRY_URL",
      "IMAGE_PULL_SECRET_NAME=DO_NOT_PRINT_IMAGE_PULL_SECRET_NAME",
      ""
    ].join("\n")
  );
  writeFileSync(
    secretsFile,
    [
      "SUBSTRATE_SCHEMA_VERSION=DO_NOT_PRINT_SCHEMA_VERSION_SECRETS",
      "POSTGRES_APP_URL=postgresql://app:secret@db/agentsmith",
      "APP_SESSION_SECRET=app-session-secret-at-least-32-chars",
      "S3_ACCESS_KEY=DO_NOT_PRINT_S3_ACCESS_KEY",
      "S3_SECRET_KEY=DO_NOT_PRINT_S3_SECRET_KEY",
      "JUICEFS_META_URL=DO_NOT_PRINT_JUICEFS_META_URL",
      "BUILTIN_ADMIN_INITIAL_PASSWORD=admin-secret-from-substrate",
      "OIDC_CLIENT_SECRET=",
      ""
    ].join("\n")
  );
}
