#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const releaseSmokeTrigger = "BOTIFIED_RELEASE_SMOKE_BASH";
const releaseSmokeMarker = "BOTIFIED_RELEASE_SMOKE_OUTPUT";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const defaultBinary = path.join(repoRoot, "third_party/botified/target/release/botified");
const distClientPath = path.join(repoRoot, "dist/packages/ports/src/botified.js");

class Redactor {
  #values = [];

  constructor(values) {
    for (const value of values) {
      this.add(value);
    }
  }

  add(value) {
    if (typeof value === "string" && value.length > 0 && !this.#values.includes(value)) {
      this.#values.push(value);
    }
  }

  redact(input) {
    let output = String(input);
    for (const value of this.#values) {
      output = output.split(value).join("<redacted>");
    }
    return output;
  }
}

const activeRedactor = new Redactor(collectSensitiveEnvValues(process.env));

main().catch((error) => {
  console.error(activeRedactor.redact(formatError(error)));
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  await requireReadableBuildOutput();
  await requireExecutable(options.binaryPath);

  const { FetchBotifiedRuntimeHttpClient } = await import(pathToFileURL(distClientPath).href);
  const client = new FetchBotifiedRuntimeHttpClient();
  const tempDir = await mkdtemp(path.join(tmpdir(), "agentsmith-lite-botified-runner-"));
  const serviceKey = process.env.BOTIFIED_SERVICE_KEY || `asl-smoke-${randomBytes(18).toString("hex")}`;
  activeRedactor.add(serviceKey);

  const startedAt = Date.now();
  let childHandle;
  try {
    const port = await allocatePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const configPath = path.join(tempDir, "botified-runtime.yaml");
    const workDir = path.join(tempDir, "workspace");
    await mkdir(workDir, { recursive: true });
    await writeFile(configPath, runtimeConfigYaml({ port, workDir, dataDir: path.join(tempDir, "state") }));

    childHandle = startBotified({
      binaryPath: options.binaryPath,
      configPath,
      workDir,
      serviceKey,
      redactor: activeRedactor
    });

    const deadline = Date.now() + options.timeoutMs;
    await waitForHealth({ client, baseUrl, serviceKey, childHandle, deadline });

    const posted = await client.postMessage(
      baseUrl,
      serviceKey,
      `Run the local Botified release smoke: ${releaseSmokeTrigger}`
    );
    if (posted.accepted !== true) {
      throw new Error("Botified did not accept the smoke message");
    }

    const observed = await waitForReleaseSmoke({ client, baseUrl, serviceKey, childHandle, deadline, cursor: posted.cursor });
    const abort = await client.abort(baseUrl, serviceKey);
    const finalState = await client.readState(baseUrl, serviceKey);

    console.log(JSON.stringify({
      status: "ok",
      mode: "local-process",
      binary: path.relative(repoRoot, options.binaryPath) || path.basename(options.binaryPath),
      baseUrl,
      messageAccepted: posted.accepted,
      markerObserved: observed.markerObserved,
      finalState: finalState.state ?? observed.finalState ?? "unknown",
      activeItemCount: Array.isArray(finalState.activeItems) ? finalState.activeItems.length : observed.activeItemCount,
      eventsObserved: observed.eventsObserved,
      abort: {
        aborted: abort.aborted,
        queueLength: abort.queueLength
      },
      durationMs: Date.now() - startedAt
    }, null, 2));
  } finally {
    if (childHandle) {
      await stopChild(childHandle);
    }
    if (!options.keepTemp) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

function parseArgs(argv) {
  const options = {
    binaryPath: defaultBinary,
    timeoutMs: 20_000,
    keepTemp: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--binary":
        options.binaryPath = resolveCliPath(nextValue(argv, ++index, "--binary"));
        break;
      case "--timeout-secs": {
        const raw = nextValue(argv, ++index, "--timeout-secs");
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error("--timeout-secs must be a positive number");
        }
        options.timeoutMs = Math.ceil(parsed * 1000);
        break;
      }
      case "--keep-temp":
        options.keepTemp = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}\n${usage()}`);
    }
  }

  return options;
}

function nextValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function resolveCliPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function usage() {
  return [
    "usage: node scripts/acceptance/botified-runner-smoke.mjs [--binary PATH] [--timeout-secs N] [--keep-temp]",
    "",
    "Runs local Botified runner process acceptance with the vendored binary and --mock-provider."
  ].join("\n");
}

async function requireReadableBuildOutput() {
  try {
    await access(distClientPath, fsConstants.R_OK);
  } catch {
    throw new Error("missing build output for FetchBotifiedRuntimeHttpClient; run npm run build first");
  }
}

async function requireExecutable(binaryPath) {
  try {
    await access(binaryPath, fsConstants.X_OK);
  } catch {
    throw new Error(`missing executable Botified binary at ${binaryPath}; build the pinned vendor binary first`);
  }
}

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      server.close((error) => {
        if (error) {
          reject(error);
        } else if (port === undefined) {
          reject(new Error("failed to allocate a loopback port"));
        } else {
          resolve(port);
        }
      });
    });
  });
}

function startBotified({ binaryPath, configPath, workDir, serviceKey, redactor }) {
  const child = spawn(binaryPath, ["serve", "--config", configPath, "--mock-provider"], {
    cwd: workDir,
    env: botifiedChildEnv(serviceKey),
    stdio: ["ignore", "pipe", "pipe"]
  });

  const handle = {
    child,
    stdout: "",
    stderr: "",
    exit: undefined,
    spawnError: undefined,
    exitPromise: undefined
  };

  child.stdout.on("data", (chunk) => {
    handle.stdout = appendBounded(handle.stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    handle.stderr = appendBounded(handle.stderr, chunk);
  });
  child.once("error", (error) => {
    handle.spawnError = error;
  });
  handle.exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      handle.exit = { code, signal };
      resolve(handle.exit);
    });
  });
  handle.redactedOutput = () => [
    handle.stdout ? `stdout: ${redactor.redact(handle.stdout.trim())}` : "",
    handle.stderr ? `stderr: ${redactor.redact(handle.stderr.trim())}` : ""
  ].filter(Boolean).join("\n");

  return handle;
}

function botifiedChildEnv(serviceKey, parentEnv = process.env) {
  const env = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]) {
    if (typeof parentEnv[key] === "string" && parentEnv[key].length > 0) {
      env[key] = parentEnv[key];
    }
  }
  env.BOTIFIED_SERVICE_KEY = serviceKey;
  return env;
}

function appendBounded(current, chunk) {
  const next = current + chunk.toString("utf8");
  return next.length > 65_536 ? next.slice(next.length - 65_536) : next;
}

async function waitForHealth({ client, baseUrl, serviceKey, childHandle, deadline }) {
  let lastError;
  while (Date.now() < deadline) {
    assertChildStillRunning(childHandle, "before health");
    try {
      await client.health(baseUrl, serviceKey);
      return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }

  throw new Error([
    `timed out waiting for Botified health: ${lastError ? errorMessage(lastError) : "no response"}`,
    childHandle.redactedOutput()
  ].filter(Boolean).join("\n"));
}

async function waitForReleaseSmoke({ client, baseUrl, serviceKey, childHandle, deadline, cursor }) {
  let timelineCursor = cursor;
  let markerObserved = false;
  let eventsObserved = 0;
  let finalState = "unknown";
  let activeItemCount = 0;

  while (Date.now() < deadline) {
    assertChildStillRunning(childHandle, "during release smoke");

    const [state, timeline] = await Promise.all([
      client.readState(baseUrl, serviceKey),
      client.readTimeline(baseUrl, serviceKey, timelineCursor, { limit: 200 })
    ]);

    finalState = state.state ?? finalState;
    activeItemCount = Array.isArray(state.activeItems) ? state.activeItems.length : activeItemCount;
    eventsObserved += timeline.events.length;
    markerObserved ||= timeline.events.some((event) => JSON.stringify(event).includes(releaseSmokeMarker));
    timelineCursor = timeline.nextCursor ?? timelineCursor;

    if (markerObserved && hasIdleEvidence(state)) {
      return { markerObserved, eventsObserved, finalState, activeItemCount };
    }

    await sleep(150);
  }

  throw new Error([
    `timed out waiting for ${releaseSmokeMarker}; markerObserved=${markerObserved} finalState=${finalState} activeItemCount=${activeItemCount}`,
    childHandle.redactedOutput()
  ].filter(Boolean).join("\n"));
}

function hasIdleEvidence(state) {
  if (state.state === "idle" || state.state === "completed") {
    return true;
  }
  return Array.isArray(state.activeItems) && state.activeItems.length === 0 && state.state !== "running";
}

function assertChildStillRunning(childHandle, phase) {
  if (childHandle.spawnError) {
    throw new Error(`Botified runner failed to start ${phase}: ${errorMessage(childHandle.spawnError)}`);
  }
  if (!childHandle.exit) {
    return;
  }
  throw new Error([
    `Botified runner exited ${phase} (${formatExit(childHandle.exit)})`,
    childHandle.redactedOutput()
  ].filter(Boolean).join("\n"));
}

async function stopChild(childHandle) {
  if (childHandle.exit) {
    return;
  }
  childHandle.child.kill("SIGTERM");
  const timeout = sleep(2_000).then(() => "timeout");
  const result = await Promise.race([childHandle.exitPromise, timeout]);
  if (result === "timeout" && !childHandle.exit) {
    childHandle.child.kill("SIGKILL");
    await childHandle.exitPromise;
  }
}

function runtimeConfigYaml({ port, workDir, dataDir }) {
  return `version: 1

providers:
  - name: text-main
    base_url: https://mock-provider.invalid/v1
    model: mock-tool-model
    api_key_env: BOTIFIED_TEXT_API_KEY
    request_timeout_secs: 10
    priority: 10
    capabilities: [text, tool_calls]
    thinking:
      format: none
      level: off
      level_map: {}
      budget_tokens: null

tools:
  enabled: [bash]

service:
  host: 127.0.0.1
  port: ${port}
  service_key_env: BOTIFIED_SERVICE_KEY
  max_queue_messages: 8
  max_queue_bytes: 1048576

registry:
  enabled: false

runtime:
  cwd: ${yamlString(workDir)}
  data_dir: ${yamlString(dataDir)}
  session: null

skills:
  default_discovery: false
  explicit: []

context_files:
  enabled: false
  max_total_bytes: 1024

compact:
  enabled: false
  threshold_tokens: 1000000
  keep_recent_tokens: 32000

llm_text_preview:
  enabled: false
`;
}

function yamlString(value) {
  return JSON.stringify(value);
}

function formatExit(exit) {
  if (exit.signal) {
    return `signal ${exit.signal}`;
  }
  return `exit ${exit.code}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function collectSensitiveEnvValues(env) {
  return Object.entries(env)
    .filter(([key, value]) => isSensitiveEnvKey(key) && typeof value === "string" && value.length > 0)
    .map(([, value]) => value);
}

function isSensitiveEnvKey(key) {
  const upper = key.toUpperCase();
  return (
    upper === "BOTIFIED_SERVICE_KEY" ||
    upper === "MODEL_API_KEY" ||
    upper === "BOTIFIED_TEXT_API_KEY" ||
    upper.startsWith("AGENTSMITH_LITE_MODEL_API_KEY_") ||
    upper.startsWith("S3_") ||
    upper.startsWith("JUICEFS_") ||
    upper.includes("OPENAI_API_KEY") ||
    upper.includes("SECRET") ||
    upper.includes("TOKEN") ||
    upper.includes("PASSWORD") ||
    upper.endsWith("_API_KEY") ||
    upper.endsWith("_ACCESS_KEY") ||
    upper.endsWith("_PRIVATE_KEY")
  );
}
