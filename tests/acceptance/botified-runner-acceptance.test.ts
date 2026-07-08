import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const serviceKey = "DO_NOT_PRINT_BOTIFIED_SERVICE_KEY";
const modelApiKey = "DO_NOT_PRINT_MODEL_API_KEY";
const botifiedTextApiKey = "DO_NOT_PRINT_BOTIFIED_TEXT_API_KEY";
const configuredModelApiKey = "DO_NOT_PRINT_CONFIGURED_MODEL_API_KEY";
const s3SecretKey = "DO_NOT_PRINT_S3_SECRET_KEY";
const juicefsMetaUrl = "redis://DO_NOT_PRINT_JUICEFS_META_URL";
const downloadToken = "DO_NOT_PRINT_DOWNLOAD_TOKEN";
const artifactFilename = "botified-release-check.txt";
const artifactContent = "BOTIFIED_RELEASE_CHECK_OUTPUT\n";
const artifactSha256 = createHash("sha256").update(artifactContent).digest("hex");

describe("Botified runner local acceptance", () => {
  it("entrypoint keeps production args by default", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-botified-entrypoint-"));
    const fakeBinary = path.join(tempDir, "botified");
    const callsFile = path.join(tempDir, "calls.txt");
    writeFileSync(fakeBinary, `#!/usr/bin/env bash
printf '%s\\n' "$*" > "$BOTIFIED_CALLS_FILE"
`);
    chmodSync(fakeBinary, 0o755);

    const result = spawnSync("bash", ["infra/docker/botified-runner-entrypoint.sh"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        BOTIFIED_BINARY_PATH: fakeBinary,
        BOTIFIED_CONFIG_PATH: "/tmp/runtime.yaml",
        BOTIFIED_CALLS_FILE: callsFile
      }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(callsFile, "utf8").trim(), "serve --config /tmp/runtime.yaml");
  });

  it("entrypoint appends mock-provider only when the explicit test switch is set", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-botified-entrypoint-mock-"));
    const fakeBinary = path.join(tempDir, "botified");
    const callsFile = path.join(tempDir, "calls.txt");
    writeFileSync(fakeBinary, `#!/usr/bin/env bash
printf '%s\\n' "$*" > "$BOTIFIED_CALLS_FILE"
`);
    chmodSync(fakeBinary, 0o755);

    const result = spawnSync("bash", ["infra/docker/botified-runner-entrypoint.sh"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        BOTIFIED_BINARY_PATH: fakeBinary,
        BOTIFIED_CONFIG_PATH: "/tmp/runtime.yaml",
        BOTIFIED_MOCK_PROVIDER: "true",
        BOTIFIED_CALLS_FILE: callsFile
      }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(callsFile, "utf8").trim(), "serve --config /tmp/runtime.yaml --mock-provider");
  });

  it("acceptance script observes mock bash output, published artifact download, state, and abort without leaking secrets", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-botified-acceptance-"));
    const fakeBinary = writeFakeBotifiedBinary(tempDir);

    const result = runAcceptance(fakeBinary, ["--timeout-secs", "3"], {
      BOTIFIED_SERVICE_KEY: serviceKey,
      MODEL_API_KEY: modelApiKey,
      BOTIFIED_TEXT_API_KEY: botifiedTextApiKey,
      AGENTSMITH_LITE_MODEL_API_KEY_OPENAI: configuredModelApiKey,
      S3_SECRET_KEY: s3SecretKey,
      JUICEFS_META_URL: juicefsMetaUrl
    });

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout) as {
      status: string;
      mode: string;
      markerObserved: boolean;
      publishedArtifact: {
        eventObserved: boolean;
        fileId: string;
        filename: string;
        bytes: number;
        sha256: string;
        markerMatched: boolean;
        downloadedBytes: number;
        downloadedSha256: string;
        downloadedFilename: string;
      };
      finalState: string;
      abort: { aborted: boolean };
      eventsObserved: number;
    };
    assert.equal(summary.status, "ok");
    assert.equal(summary.mode, "local-process");
    assert.equal(summary.markerObserved, true);
    assert.equal(summary.publishedArtifact.eventObserved, true);
    assert.equal(summary.publishedArtifact.fileId, "file_acceptance_artifact");
    assert.equal(summary.publishedArtifact.filename, artifactFilename);
    assert.equal(summary.publishedArtifact.bytes, Buffer.byteLength(artifactContent));
    assert.equal(summary.publishedArtifact.sha256, artifactSha256);
    assert.equal(summary.publishedArtifact.markerMatched, true);
    assert.equal(summary.publishedArtifact.downloadedBytes, Buffer.byteLength(artifactContent));
    assert.equal(summary.publishedArtifact.downloadedSha256, artifactSha256);
    assert.equal(summary.publishedArtifact.downloadedFilename, artifactFilename);
    assert.equal(summary.finalState, "idle");
    assert.equal(summary.abort.aborted, true);
    assert.ok(summary.eventsObserved >= 1);
    assertNoSecretLeak(result.stdout, result.stderr);
  });

  it("acceptance script shows startup failure without leaking secrets", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-botified-acceptance-fail-"));
    const fakeBinary = path.join(tempDir, "botified-fail");
    writeFileSync(fakeBinary, `#!/usr/bin/env bash
printf 'startup failed with %s %s %s %s %s %s\\n' "$BOTIFIED_SERVICE_KEY" "$MODEL_API_KEY" "$BOTIFIED_TEXT_API_KEY" "$AGENTSMITH_LITE_MODEL_API_KEY_OPENAI" "$S3_SECRET_KEY" "$JUICEFS_META_URL" >&2
exit 42
`);
    chmodSync(fakeBinary, 0o755);

    const result = runAcceptance(fakeBinary, ["--timeout-secs", "0.5"], {
      BOTIFIED_SERVICE_KEY: serviceKey,
      MODEL_API_KEY: modelApiKey,
      BOTIFIED_TEXT_API_KEY: botifiedTextApiKey,
      AGENTSMITH_LITE_MODEL_API_KEY_OPENAI: configuredModelApiKey,
      S3_SECRET_KEY: s3SecretKey,
      JUICEFS_META_URL: juicefsMetaUrl
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /startup failed/);
    assertNoSecretLeak(result.stdout, result.stderr);
  });
});

function runAcceptance(
  binaryPath: string,
  args: string[],
  env: Record<string, string>
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync("node", ["scripts/acceptance/botified-runner-acceptance.mjs", "--binary", binaryPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  });
}

function writeFakeBotifiedBinary(tempDir: string): string {
  const binaryPath = path.join(tempDir, "botified");
  writeFileSync(binaryPath, `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");

const configPath = process.argv[process.argv.indexOf("--config") + 1];
if (!process.argv.includes("serve") || !process.argv.includes("--mock-provider") || !configPath) {
  console.error("unexpected args: " + process.argv.slice(2).join(" "));
  process.exit(64);
}

const forbiddenEnv = [
  "MODEL_API_KEY",
  "BOTIFIED_TEXT_API_KEY",
  "AGENTSMITH_LITE_MODEL_API_KEY_OPENAI",
  "S3_SECRET_KEY",
  "JUICEFS_META_URL"
].filter((key) => process.env[key]);
if (forbiddenEnv.length > 0) {
  console.error("forbidden child env " + forbiddenEnv.map((key) => key + "=" + process.env[key]).join(" "));
  process.exit(66);
}

const rawConfig = fs.readFileSync(configPath, "utf8");
const port = Number(rawConfig.match(/\\n  port: (\\d+)\\n/)?.[1]);
const serviceKey = process.env.BOTIFIED_SERVICE_KEY;
let messageAccepted = false;
let outputReady = false;
const artifactFileId = "file_acceptance_artifact";
const artifactFilename = "botified-release-check.txt";
const artifactContent = "BOTIFIED_RELEASE_CHECK_OUTPUT\\n";
const artifactSha256 = ${JSON.stringify(artifactSha256)};

function authorized(req) {
  return req.headers.authorization === "Bearer " + serviceKey;
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (!authorized(req)) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { code: "unauthorized", message: "unauthorized" } }));
    return;
  }
  if (req.method === "POST" && req.url === "/v1/messages") {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body.includes("BOTIFIED_RELEASE_CHECK_BASH")) {
        res.statusCode = 422;
        res.end(JSON.stringify({ error: { code: "missing_trigger", message: "missing trigger" } }));
        return;
      }
      messageAccepted = true;
      setTimeout(() => {
        outputReady = true;
      }, 50);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, kind: "queued", message_id: "msg_1", timeline_cursor: "cursor-0" }));
    });
    return;
  }
  if (req.method === "GET" && req.url === "/v1/state") {
    const state = outputReady ? "idle" : messageAccepted ? "running" : "idle";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      state,
      timeline_cursor: outputReady ? "cursor-2" : "cursor-1",
      active_items: outputReady ? [] : [{ kind: "bash" }]
    }));
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/v1/timeline")) {
    const events = outputReady
      ? [
        { type: "tool_call", tool: "bash", id: "acceptance_bash" },
        { type: "tool_output", text: "BOTIFIED_RELEASE_CHECK_OUTPUT" },
        {
          type: "file.published",
          data: {
            file_id: artifactFileId,
            filename: artifactFilename,
            mime_type: "text/plain",
            size_bytes: Buffer.byteLength(artifactContent),
            sha256: artifactSha256,
            download_url: "http://127.0.0.1:" + port + "/v1/files/" + artifactFileId + "?token=DO_NOT_PRINT_DOWNLOAD_TOKEN",
            source: "published",
            description: "acceptance artifact"
          }
        }
      ]
      : [];
    res.setHeader("content-type", "application/x-ndjson");
    res.setHeader("x-botified-next-cursor", outputReady ? "cursor-2" : "cursor-1");
    res.end(events.map((event) => JSON.stringify(event)).join("\\n") + (events.length > 0 ? "\\n" : ""));
    return;
  }
  if (req.method === "GET" && req.url === "/v1/files/" + artifactFileId) {
    res.setHeader("content-type", "text/plain");
    res.setHeader("content-disposition", 'attachment; filename="' + artifactFilename + '"');
    res.setHeader("x-botified-sha256", artifactSha256);
    res.end(artifactContent);
    return;
  }
  if (req.method === "POST" && req.url === "/v1/abort") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, queue_length: 0, state: { state: "idle" } }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { code: "not_found", message: req.method + " " + req.url } }));
});

server.listen(port, "127.0.0.1");
`);
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

function assertNoSecretLeak(stdout: string, stderr: string): void {
  const text = `${stdout}\n${stderr}`;
  assert.doesNotMatch(text, new RegExp(serviceKey));
  assert.doesNotMatch(text, new RegExp(modelApiKey));
  assert.doesNotMatch(text, new RegExp(botifiedTextApiKey));
  assert.doesNotMatch(text, new RegExp(configuredModelApiKey));
  assert.doesNotMatch(text, new RegExp(s3SecretKey));
  assert.doesNotMatch(text, new RegExp(escapeRegExp(juicefsMetaUrl)));
  assert.doesNotMatch(text, new RegExp(downloadToken));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
