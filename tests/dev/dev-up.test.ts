import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

describe("dev/up.sh", () => {
  it("starts npm dev with local dry-run defaults when no substrate files are provided", () => {
    const fixture = createFixture();

    const result = runDevUp([], fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(fixture.argsFile, "utf8").trim(), "run dev");
    const env = readCapturedEnv(fixture.envFile);
    assert.equal(env.AGENTSMITH_LITE_DATA_DIR, ".data");
    assert.equal(env.BUILTIN_ADMIN_INITIAL_PASSWORD, "admin-password");
    assert.equal(env.APP_SESSION_SECRET, "dev-session-secret");
    assert.equal(env.POSTGRES_APP_URL, undefined);
  });

  it("exports only allowlisted product variables from substrate env and secrets", () => {
    const fixture = createFixture();
    const substrateEnv = path.join(fixture.tempDir, "substrate.env");
    const substrateSecrets = path.join(fixture.tempDir, "substrate.secrets.env");
    writeFileSync(substrateEnv, [
      "APP_PUBLIC_BASE_URL=https://app.example.test",
      "KUBE_NAMESPACE=agentsmith-preview",
      "KUBECONFIG_PATH=/tmp/agentsmith.kubeconfig",
      "KUBE_CONTEXT=kind-agentsmith",
      "AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI=https://models.example.test/v1",
      "AGENTSMITH_LITE_SANDBOX_MODE=live",
      "AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT=7",
      "AGENTSMITH_LITE_RUNTIME_TICK_MS=1000",
      "export S3_ACCESS_KEY=DO_NOT_EXPORT_S3_ACCESS",
      "S3_ENDPOINT=DO_NOT_EXPORT_S3_ENDPOINT",
      "export JUICEFS_META_URL=DO_NOT_EXPORT_JUICEFS_META",
      "JUICEFS_BUCKET=DO_NOT_EXPORT_JUICEFS_BUCKET",
      "JUICEFS_VOLUME_NAME=DO_NOT_EXPORT_JUICEFS_VOLUME_NAME",
      "JUICEFS_SECRET_NAME=DO_NOT_EXPORT_JUICEFS_SECRET_NAME",
      "JUICEFS_CSI_DRIVER=DO_NOT_EXPORT_JUICEFS_CSI_DRIVER",
      "JUICEFS_STORAGE_CLASS=DO_NOT_EXPORT_JUICEFS_STORAGE_CLASS",
      "JUICEFS_MOUNT_ROOT=DO_NOT_EXPORT_JUICEFS_MOUNT_ROOT",
      "JUICEFS_PVC_NAME=custom-files-pvc",
      "UNRELATED_SUBSTRATE_VALUE=DO_NOT_EXPORT_UNRELATED",
      ""
    ].join("\n"));
    writeFileSync(substrateSecrets, [
      "POSTGRES_APP_URL=postgresql://app:secret@db/agentsmith",
      "APP_SESSION_SECRET=session-secret-from-substrate",
      "BUILTIN_ADMIN_INITIAL_PASSWORD=admin-secret-from-substrate",
      "AGENTSMITH_LITE_MODEL_API_KEY_OPENAI=sk-from-substrate",
      "export S3_SECRET_KEY=DO_NOT_EXPORT_S3_SECRET",
      "export JUICEFS_ACCESS_KEY=DO_NOT_EXPORT_JUICEFS_ACCESS",
      ""
    ].join("\n"));

    const result = runDevUp(["--env", substrateEnv, "--secrets", substrateSecrets], fixture);

    assert.equal(result.status, 0, result.stderr);
    const env = readCapturedEnv(fixture.envFile);
    assert.equal(env.POSTGRES_APP_URL, "postgresql://app:secret@db/agentsmith");
    assert.equal(env.APP_SESSION_SECRET, "session-secret-from-substrate");
    assert.equal(env.BUILTIN_ADMIN_INITIAL_PASSWORD, "admin-secret-from-substrate");
    assert.equal(env.APP_PUBLIC_BASE_URL, "https://app.example.test");
    assert.equal(env.KUBE_NAMESPACE, "agentsmith-preview");
    assert.equal(env.KUBECONFIG_PATH, "/tmp/agentsmith.kubeconfig");
    assert.equal(env.KUBE_CONTEXT, "kind-agentsmith");
    assert.equal(env.AGENTSMITH_LITE_MODEL_BASE_URL_OPENAI, "https://models.example.test/v1");
    assert.equal(env.AGENTSMITH_LITE_MODEL_API_KEY_OPENAI, "sk-from-substrate");
    assert.equal(env.AGENTSMITH_LITE_SANDBOX_MODE, "live");
    assert.equal(env.AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT, "7");
    assert.equal(env.AGENTSMITH_LITE_RUNTIME_TICK_MS, "1000");
    assert.equal(env.JUICEFS_PVC_NAME, "custom-files-pvc");
    assert.equal(env.S3_ACCESS_KEY, undefined);
    assert.equal(env.S3_ENDPOINT, undefined);
    assert.equal(env.S3_SECRET_KEY, undefined);
    assert.equal(env.JUICEFS_META_URL, undefined);
    assert.equal(env.JUICEFS_BUCKET, undefined);
    assert.equal(env.JUICEFS_VOLUME_NAME, undefined);
    assert.equal(env.JUICEFS_SECRET_NAME, undefined);
    assert.equal(env.JUICEFS_CSI_DRIVER, undefined);
    assert.equal(env.JUICEFS_STORAGE_CLASS, undefined);
    assert.equal(env.JUICEFS_MOUNT_ROOT, undefined);
    assert.equal(env.JUICEFS_ACCESS_KEY, undefined);
    assert.equal(env.UNRELATED_SUBSTRATE_VALUE, undefined);
  });

  it("fails closed for unknown arguments without printing following secret-looking values", () => {
    const fixture = createFixture();

    const result = runDevUp(["--bogus", "DO_NOT_PRINT_UNKNOWN_ARG_SECRET"], fixture);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown argument: --bogus/);
    assert.doesNotMatch(result.stderr + result.stdout, /DO_NOT_PRINT_UNKNOWN_ARG_SECRET/);
  });

  it("fails closed when a substrate file is missing without sourcing earlier secret values", () => {
    const fixture = createFixture();
    const substrateEnv = path.join(fixture.tempDir, "substrate.env");
    const missingSecrets = path.join(fixture.tempDir, "missing.secrets.env");
    writeFileSync(substrateEnv, [
      "APP_SESSION_SECRET=DO_NOT_PRINT_MISSING_FILE_SECRET",
      "export S3_SECRET_KEY=DO_NOT_PRINT_MISSING_FILE_S3_SECRET",
      ""
    ].join("\n"));

    const result = runDevUp(["--env", substrateEnv, "--secrets", missingSecrets], fixture);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /secrets file not found/);
    assert.doesNotMatch(result.stderr + result.stdout, /DO_NOT_PRINT_MISSING_FILE_SECRET/);
    assert.doesNotMatch(result.stderr + result.stdout, /DO_NOT_PRINT_MISSING_FILE_S3_SECRET/);
  });
});

interface Fixture {
  tempDir: string;
  argsFile: string;
  envFile: string;
}

function createFixture(): Fixture {
  const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-dev-up-"));
  const fakeBin = path.join(tempDir, "bin");
  mkdirSync(fakeBin);
  const argsFile = path.join(tempDir, "npm-args.txt");
  const envFile = path.join(tempDir, "child-env.txt");
  const fakeNpm = path.join(fakeBin, "npm");
  writeFileSync(fakeNpm, `#!/usr/bin/env bash
printf '%s\\n' "$*" > "$FAKE_NPM_ARGS_FILE"
env | sort > "$FAKE_NPM_ENV_FILE"
`);
  chmodSync(fakeNpm, 0o755);
  return { tempDir, argsFile, envFile };
}

function runDevUp(args: string[], fixture: Fixture) {
  return spawnSync("bash", ["scripts/dev/up.sh", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      PATH: `${path.join(fixture.tempDir, "bin")}:/usr/bin:/bin`,
      FAKE_NPM_ARGS_FILE: fixture.argsFile,
      FAKE_NPM_ENV_FILE: fixture.envFile
    }
  });
}

function readCapturedEnv(file: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
      const equals = line.indexOf("=");
      return [line.slice(0, equals), line.slice(equals + 1)];
    })
  );
}
