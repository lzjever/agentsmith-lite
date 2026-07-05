import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const image = "agentsmith-lite/botified-runner:acceptance-test";
const serviceKey = "DO_NOT_PRINT_IMAGE_SERVICE_KEY";
const modelApiKey = "DO_NOT_PRINT_IMAGE_MODEL_API_KEY";
const botifiedTextApiKey = "DO_NOT_PRINT_IMAGE_BOTIFIED_TEXT_API_KEY";
const configuredModelApiKey = "DO_NOT_PRINT_IMAGE_CONFIGURED_MODEL_API_KEY";
const s3SecretKey = "DO_NOT_PRINT_IMAGE_S3_SECRET_KEY";
const juicefsMetaUrl = "redis://DO_NOT_PRINT_IMAGE_JUICEFS_META_URL";

describe("Botified runner image acceptance", () => {
  it("builds the runner image and observes marker, state, and abort through a fake runtime", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-botified-image-smoke-"));
    const callsFile = path.join(tempDir, "runtime-calls.jsonl");
    const fakeRuntime = writeFakeRuntime(tempDir, callsFile, "success");

    const result = runImageSmoke(fakeRuntime, ["--timeout-secs", "3"], secretEnv());

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      status: string;
      mode: string;
      scope: string;
      notCovered: string[];
      image: string;
      imageId?: string;
      markerObserved: boolean;
      finalState: string;
      abort: { aborted: boolean };
      eventsObserved: number;
    };
    assert.equal(report.status, "ok");
    assert.equal(report.mode, "container-image");
    assert.equal(report.scope, "runner-container-only");
    assert.deepEqual(report.notCovered, ["k8s", "juicefs", "pvc", "product-task-api", "publish_file", "cancel-reap"]);
    assert.equal(report.image, image);
    assert.equal(report.imageId, "sha256:fake-image-id");
    assert.equal(report.markerObserved, true);
    assert.equal(report.finalState, "idle");
    assert.equal(report.abort.aborted, true);
    assert.ok(report.eventsObserved >= 1);

    const calls = readCalls(callsFile);
    const build = findCall(calls, "build");
    assert.equal(argAfter(build.argv, "-f").endsWith("infra/docker/Dockerfile.botified-runner"), true);
    assert.ok(build.argv.includes("-t"));
    assert.equal(argAfter(build.argv, "-t"), image);
    assert.doesNotMatch(build.argv.join(" "), /app/i);

    const run = findCall(calls, "run");
    assert.ok(hasArgPair(run.argv, "-e", "BOTIFIED_SERVICE_KEY"));
    assert.ok(hasArgPair(run.argv, "-e", "BOTIFIED_MOCK_PROVIDER=true"));
    assert.ok(hasArgPair(run.argv, "-e", "BOTIFIED_CONFIG_PATH=/etc/botified/botified-runtime.yaml"));
    assert.ok(run.argv.some((arg) => /^127\.0\.0\.1:\d+:\d+$/.test(arg)));
    assert.ok(run.argv.some((arg) => arg.includes("dst=/etc/botified/botified-runtime.yaml,ro")));
    assert.ok(run.argv.some((arg) => arg.includes("dst=/workspace")));
    assert.equal(run.configHost, "0.0.0.0");
    assert.equal(run.sawMockProvider, true);
    assert.equal(run.sawServiceKeyValueInArgv, false);
    assert.equal(run.sawForbiddenSecretEnv, false);

    findCall(calls, "rm");
    assertNoSecretLeak(result.stdout, result.stderr);
  });

  it("cleans up the container after a health timeout", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-botified-image-timeout-"));
    const callsFile = path.join(tempDir, "runtime-calls.jsonl");
    const fakeRuntime = writeFakeRuntime(tempDir, callsFile, "no-health");

    const result = runImageSmoke(fakeRuntime, ["--skip-build", "--timeout-secs", "0.4"], secretEnv());

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /timed out waiting for Botified health/);
    findCall(readCalls(callsFile), "rm");
    assertNoSecretLeak(result.stdout, result.stderr);
  });

  it("cleans up the container after a runtime start failure without leaking secrets", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-botified-image-start-fail-"));
    const callsFile = path.join(tempDir, "runtime-calls.jsonl");
    const fakeRuntime = writeFakeRuntime(tempDir, callsFile, "start-failure");

    const result = runImageSmoke(fakeRuntime, ["--skip-build", "--timeout-secs", "0.5"], secretEnv());

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /startup failed/);
    findCall(readCalls(callsFile), "rm");
    assertNoSecretLeak(result.stdout, result.stderr);
  });
});

function runImageSmoke(
  runtimePath: string,
  args: string[],
  env: Record<string, string>
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync("node", [
    "scripts/acceptance/botified-runner-smoke.mjs",
    "--container-image", image,
    "--runtime", runtimePath,
    ...args
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  });
}

function writeFakeRuntime(tempDir: string, callsFile: string, mode: "success" | "no-health" | "start-failure"): string {
  const runtimePath = path.join(tempDir, "fake-docker");
  writeFileSync(runtimePath, `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");

const callsFile = ${JSON.stringify(callsFile)};
const mode = ${JSON.stringify(mode)};
const forbiddenSecretKeys = [
  "MODEL_API_KEY",
  "BOTIFIED_TEXT_API_KEY",
  "AGENTSMITH_LITE_MODEL_API_KEY_OPENAI",
  "S3_SECRET_KEY",
  "JUICEFS_META_URL"
];
const argv = process.argv.slice(2);
const command = argv[0];
const sawForbiddenSecretEnv = forbiddenSecretKeys.some((key) => Boolean(process.env[key]));

function record(extra = {}) {
  fs.appendFileSync(callsFile, JSON.stringify({
    command,
    argv,
    sawForbiddenSecretEnv,
    envKeys: Object.keys(process.env).sort(),
    ...extra
  }) + "\\n");
}

if (sawForbiddenSecretEnv) {
  record();
  console.error("forbidden runtime env " + forbiddenSecretKeys
    .filter((key) => Boolean(process.env[key]))
    .map((key) => key + "=" + process.env[key])
    .join(" "));
  process.exit(70);
}

if (command === "build") {
  const dockerfile = argv[argv.indexOf("-f") + 1] || "";
  record({ dockerfile });
  if (!dockerfile.endsWith("infra/docker/Dockerfile.botified-runner")) {
    console.error("unexpected dockerfile " + dockerfile);
    process.exit(71);
  }
  process.exit(0);
}

if (command === "image" && argv[1] === "inspect") {
  record();
  process.stdout.write("sha256:fake-image-id\\nagentsmith-lite/botified-runner@sha256:fake-digest\\n");
  process.exit(0);
}

if (command === "rm") {
  record();
  process.exit(0);
}

if (command !== "run") {
  record();
  console.error("unexpected runtime command " + argv.join(" "));
  process.exit(72);
}

const portArg = argv[argv.indexOf("-p") + 1] || "";
const portMatch = portArg.match(/^127\\.0\\.0\\.1:(\\d+):(\\d+)$/);
const hostPort = Number(portMatch?.[1]);
const containerPort = Number(portMatch?.[2]);
const mountArgs = argv.flatMap((arg, index) => arg === "--mount" ? [argv[index + 1] || ""] : []);
const configMount = mountArgs.find((arg) => arg.includes("dst=/etc/botified/botified-runtime.yaml")) || "";
const configPath = configMount.match(/(?:^|,)src=([^,]+),dst=\\/etc\\/botified\\/botified-runtime\\.yaml/)?.[1];
const rawConfig = configPath ? fs.readFileSync(configPath, "utf8") : "";
const configHost = rawConfig.match(/\\n  host: ([^\\n]+)\\n/)?.[1];
const configPort = Number(rawConfig.match(/\\n  port: (\\d+)\\n/)?.[1]);
const sawMockProvider = argv.some((arg, index) => arg === "-e" && argv[index + 1] === "BOTIFIED_MOCK_PROVIDER=true");
const sawServiceKeyValueInArgv = argv.some((arg) => arg.includes("BOTIFIED_SERVICE_KEY="));
record({ configHost, configPort, containerPort, sawMockProvider, sawServiceKeyValueInArgv });

if (!hostPort || configPort !== containerPort || !sawMockProvider || sawServiceKeyValueInArgv) {
  console.error("unexpected run args " + argv.join(" "));
  process.exit(73);
}

if (mode === "start-failure") {
  console.error("startup failed " + process.env.BOTIFIED_SERVICE_KEY);
  process.exit(42);
}

if (mode === "no-health") {
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
  return;
}

const serviceKey = process.env.BOTIFIED_SERVICE_KEY;
let messageAccepted = false;
let outputReady = false;

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
      if (!body.includes("BOTIFIED_RELEASE_SMOKE_BASH")) {
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
        { type: "tool_call", tool: "bash", id: "release_smoke_bash" },
        { type: "tool_output", text: "BOTIFIED_RELEASE_SMOKE_OUTPUT" }
      ]
      : [];
    res.setHeader("content-type", "application/x-ndjson");
    res.setHeader("x-botified-next-cursor", outputReady ? "cursor-2" : "cursor-1");
    res.end(events.map((event) => JSON.stringify(event)).join("\\n") + (events.length > 0 ? "\\n" : ""));
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

server.listen(hostPort, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`);
  chmodSync(runtimePath, 0o755);
  return runtimePath;
}

function readCalls(callsFile: string): Array<{
  command: string;
  argv: string[];
  configHost?: string;
  sawMockProvider?: boolean;
  sawServiceKeyValueInArgv?: boolean;
  sawForbiddenSecretEnv?: boolean;
}> {
  return readFileSync(callsFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as {
      command: string;
      argv: string[];
      configHost?: string;
      sawMockProvider?: boolean;
      sawServiceKeyValueInArgv?: boolean;
      sawForbiddenSecretEnv?: boolean;
    });
}

function findCall(calls: Array<{ command: string; argv: string[] }>, command: string): { command: string; argv: string[]; [key: string]: unknown } {
  const call = calls.find((candidate) => candidate.command === command);
  assert.ok(call, `missing ${command} call in ${JSON.stringify(calls)}`);
  return call;
}

function hasArgPair(argv: string[], flag: string, value: string): boolean {
  return argv.some((arg, index) => arg === flag && argv[index + 1] === value);
}

function argAfter(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag} in ${argv.join(" ")}`);
  const value = argv[index + 1];
  if (typeof value !== "string") {
    throw new Error(`missing value for ${flag} in ${argv.join(" ")}`);
  }
  return value;
}

function secretEnv(): Record<string, string> {
  return {
    BOTIFIED_SERVICE_KEY: serviceKey,
    MODEL_API_KEY: modelApiKey,
    BOTIFIED_TEXT_API_KEY: botifiedTextApiKey,
    AGENTSMITH_LITE_MODEL_API_KEY_OPENAI: configuredModelApiKey,
    S3_SECRET_KEY: s3SecretKey,
    JUICEFS_META_URL: juicefsMetaUrl
  };
}

function assertNoSecretLeak(stdout: string, stderr: string): void {
  const text = `${stdout}\n${stderr}`;
  assert.doesNotMatch(text, new RegExp(serviceKey));
  assert.doesNotMatch(text, new RegExp(modelApiKey));
  assert.doesNotMatch(text, new RegExp(botifiedTextApiKey));
  assert.doesNotMatch(text, new RegExp(configuredModelApiKey));
  assert.doesNotMatch(text, new RegExp(s3SecretKey));
  assert.doesNotMatch(text, new RegExp(escapeRegExp(juicefsMetaUrl)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
