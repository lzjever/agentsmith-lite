import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

describe("local DeepSeek overlay", () => it("writes provider and live settings without choosing an image", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-deepseek-overlay-"));
  const script = path.resolve("scripts/deploy/write-local-deepseek-overlay.mjs");
  const result = spawnSync(process.execPath, [script], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_OPENAI_BASE_URL: "https://api.deepseek.example/v1/",
      DEEPSEEK_DEFAULT_MODEL: "deepseek-chat"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const appEnv = readFileSync(path.join(directory, ".dev/app.env"), "utf8");
  assert.match(appEnv, /AGENTSMITH_LITE_SANDBOX_MODE=live/);
  assert.match(appEnv, /AGENTSMITH_LITE_MODEL_BASE_URL_DEEPSEEK=https:\/\/api\.deepseek\.example\/v1/);
  assert.doesNotMatch(appEnv, /BOTIFIED_RUNNER_IMAGE|AGENTSMITH_LITE_LOCAL_IMAGE_TAG/);
  const appSecretsPath = path.join(directory, ".dev/app.secrets.env");
  const appSecrets = readFileSync(appSecretsPath, "utf8");
  assert.match(appSecrets, /^AGENTSMITH_LITE_MODEL_API_KEY_DEEPSEEK=test-key$/m);
  const encryptionKey = /^APP_CREDENTIAL_ENCRYPTION_KEY=(.+)$/m.exec(appSecrets)?.[1];
  assert.match(encryptionKey ?? "", /^[A-Za-z0-9_-]{43}$/);

  const second = spawnSync(process.execPath, [script], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: "replacement-key",
      DEEPSEEK_OPENAI_BASE_URL: "https://api.deepseek.example/v1/",
      DEEPSEEK_DEFAULT_MODEL: "deepseek-chat"
    }
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(readFileSync(appSecretsPath, "utf8"), new RegExp(`APP_CREDENTIAL_ENCRYPTION_KEY=${encryptionKey}`));
}));
