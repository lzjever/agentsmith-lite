#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const releaseSmokeTrigger = "BOTIFIED_RELEASE_SMOKE_BASH";
const releaseSmokeMarker = "BOTIFIED_RELEASE_SMOKE_OUTPUT";
const releaseSmokeArtifactFilename = "botified-release-smoke.txt";
const releaseSmokeArtifactSha256 = sha256Text(`${releaseSmokeMarker}\n`);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const defaultBinary = path.join(repoRoot, "third_party/botified/target/release/botified");
const defaultContainerImage = "agentsmith-lite/botified-runner:acceptance";
const botifiedRunnerDockerfile = path.join(repoRoot, "infra/docker/Dockerfile.botified-runner");
const distClientPath = path.join(repoRoot, "dist/packages/ports/src/botified.js");
const containerConfigPath = "/etc/botified/botified-runtime.yaml";
const containerWorkspacePath = "/workspace";
const containerNotCovered = ["k8s", "juicefs", "pvc", "product-task-api", "cancel-reap"];

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
  if (options.mode === "local-process") {
    await requireExecutable(options.binaryPath);
  } else if (!options.skipBuild) {
    buildContainerImage({ runtime: options.runtime, image: options.image, redactor: activeRedactor });
  }

  const { FetchBotifiedRuntimeHttpClient } = await import(pathToFileURL(distClientPath).href);
  const client = new FetchBotifiedRuntimeHttpClient();
  const tempDir = await mkdtemp(path.join(tmpdir(), "agentsmith-lite-botified-runner-"));
  const serviceKey = process.env.BOTIFIED_SERVICE_KEY || `asl-smoke-${randomBytes(18).toString("hex")}`;
  activeRedactor.add(serviceKey);

  const startedAt = Date.now();
  let childHandle;
  let containerName;
  try {
    const port = await allocatePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const configPath = path.join(tempDir, "botified-runtime.yaml");
    const workDir = path.join(tempDir, "workspace");
    const hostDataDir = options.mode === "container-image" ? path.join(workDir, "state") : path.join(tempDir, "state");
    await prepareSmokeWorkspace({ workDir, dataDir: hostDataDir });

    if (options.mode === "local-process") {
      await writeFile(configPath, runtimeConfigYaml({
        host: "127.0.0.1",
        port,
        workDir,
        dataDir: hostDataDir
      }));
      childHandle = startBotified({
        binaryPath: options.binaryPath,
        configPath,
        workDir,
        serviceKey,
        redactor: activeRedactor
      });
    } else {
      await writeFile(configPath, runtimeConfigYaml({
        host: "0.0.0.0",
        port,
        workDir: containerWorkspacePath,
        dataDir: `${containerWorkspacePath}/state`
      }));
      containerName = `agentsmith-lite-botified-runner-${randomBytes(8).toString("hex")}`;
      childHandle = startBotifiedContainer({
        runtime: options.runtime,
        image: options.image,
        containerName,
        port,
        configPath,
        workDir,
        serviceKey,
        redactor: activeRedactor
      });
    }

    const deadline = Date.now() + options.timeoutMs;
    await waitForHealth({ client, baseUrl, serviceKey, childHandle, deadline });

    const posted = await client.postMessage(
      baseUrl,
      serviceKey,
      `Run the local Botified release smoke: ${releaseSmokeTrigger}. Write ${releaseSmokeArtifactFilename} with exactly ${releaseSmokeMarker} on one line, then publish_file it.`
    );
    if (posted.accepted !== true) {
      throw new Error("Botified did not accept the smoke message");
    }

    const observed = await waitForReleaseSmoke({ client, baseUrl, serviceKey, childHandle, deadline, cursor: posted.cursor });
    const abort = await client.abort(baseUrl, serviceKey);
    const finalState = await client.readState(baseUrl, serviceKey);

    const report = {
      status: "ok",
      mode: options.mode,
      scope: options.mode === "container-image" ? "runner-container-only" : "local-runner-process-only",
      notCovered: options.mode === "container-image"
        ? containerNotCovered
        : ["runner-container-image", ...containerNotCovered],
      baseUrl,
      messageAccepted: posted.accepted,
      markerObserved: observed.markerObserved,
      publishedArtifact: observed.publishedArtifact,
      finalState: finalState.state ?? observed.finalState ?? "unknown",
      activeItemCount: Array.isArray(finalState.activeItems) ? finalState.activeItems.length : observed.activeItemCount,
      eventsObserved: observed.eventsObserved,
      abort: {
        aborted: abort.aborted,
        queueLength: abort.queueLength
      },
      durationMs: Date.now() - startedAt
    };
    if (options.mode === "local-process") {
      report.binary = path.relative(repoRoot, options.binaryPath) || path.basename(options.binaryPath);
    } else {
      report.image = options.image;
      report.runtime = options.runtime;
      const imageMetadata = inspectContainerImage({ runtime: options.runtime, image: options.image, redactor: activeRedactor });
      if (imageMetadata.imageId) {
        report.imageId = imageMetadata.imageId;
      }
      if (imageMetadata.repoDigests.length > 0) {
        report.repoDigests = imageMetadata.repoDigests;
      }
    }

    const reportJson = `${JSON.stringify(report, null, 2)}\n`;
    if (options.reportPath) {
      await writeReport(options.reportPath, reportJson);
    }
    process.stdout.write(reportJson);
  } finally {
    if (containerName) {
      cleanupContainer({ runtime: options.runtime, containerName, redactor: activeRedactor });
    }
    if (childHandle) {
      await stopChild(childHandle);
    }
    if (!options.keepTemp) {
      if (options.mode === "container-image") {
        repairContainerTempDirPermissions({
          runtime: options.runtime,
          image: options.image,
          tempDir,
          redactor: activeRedactor
        });
      }
      await cleanupTempDir(tempDir, activeRedactor);
    }
  }
}

function parseArgs(argv) {
  const options = {
    mode: "local-process",
    binaryPath: defaultBinary,
    image: defaultContainerImage,
    runtime: "docker",
    skipBuild: false,
    timeoutMs: 20_000,
    keepTemp: false,
    reportPath: undefined,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--binary":
        options.binaryPath = resolveCliPath(nextValue(argv, ++index, "--binary"));
        break;
      case "--container-image":
        options.mode = "container-image";
        options.image = nextValue(argv, ++index, "--container-image");
        break;
      case "--mode": {
        const mode = nextValue(argv, ++index, "--mode");
        if (mode !== "local-process" && mode !== "container-image") {
          throw new Error("--mode must be local-process or container-image");
        }
        options.mode = mode;
        break;
      }
      case "--image":
        options.mode = "container-image";
        options.image = nextValue(argv, ++index, "--image");
        break;
      case "--runtime":
        options.runtime = nextValue(argv, ++index, "--runtime");
        break;
      case "--skip-build":
        options.skipBuild = true;
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
      case "--report":
        options.reportPath = resolveCliPath(nextValue(argv, ++index, "--report"));
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
    "usage: node scripts/acceptance/botified-runner-smoke.mjs [--binary PATH] [--timeout-secs N] [--keep-temp] [--report PATH]",
    "       node scripts/acceptance/botified-runner-smoke.mjs --container-image IMAGE [--runtime PATH_OR_NAME] [--skip-build] [--timeout-secs N] [--report PATH]",
    "",
    "Runs Botified runner acceptance with the vendored binary by default, or with a runner image/container when --container-image is provided.",
    "When --report is provided and the smoke succeeds, writes the stdout JSON to that path.",
    "When it succeeds, container mode is runner-container-only evidence; it does not cover Kubernetes, PVC, JuiceFS, product task API, or cancel/reap."
  ].join("\n");
}

async function writeReport(reportPath, reportJson) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, reportJson, "utf8");
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

  return createChildHandle(child, redactor);
}

function startBotifiedContainer({ runtime, image, containerName, port, configPath, workDir, serviceKey, redactor }) {
  const args = [
    "run",
    "--name", containerName,
    "-p", `127.0.0.1:${port}:${port}`,
    "--mount", `type=bind,src=${configPath},dst=${containerConfigPath},ro`,
    "--mount", `type=bind,src=${workDir},dst=${containerWorkspacePath}`,
    "-e", "BOTIFIED_SERVICE_KEY",
    "-e", "BOTIFIED_MOCK_PROVIDER=true",
    "-e", `BOTIFIED_CONFIG_PATH=${containerConfigPath}`,
    image
  ];
  const child = spawn(runtime, args, {
    cwd: repoRoot,
    env: botifiedChildEnv(serviceKey),
    stdio: ["ignore", "pipe", "pipe"]
  });

  return createChildHandle(child, redactor);
}

function createChildHandle(child, redactor) {
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

function buildContainerImage({ runtime, image, redactor }) {
  runRuntimeCommand({
    runtime,
    args: ["build", "-f", botifiedRunnerDockerfile, "-t", image, repoRoot],
    env: runtimeToolEnv(),
    redactor,
    description: `build Botified runner image ${image}`
  });
}

function inspectContainerImage({ runtime, image, redactor }) {
  const result = runRuntimeCommand({
    runtime,
    args: ["image", "inspect", image, "--format", "{{.Id}}\n{{range .RepoDigests}}{{.}}\n{{end}}"],
    env: runtimeToolEnv(),
    redactor,
    description: `inspect Botified runner image ${image}`,
    allowFailure: true
  });
  if (result.status !== 0) {
    return { imageId: undefined, repoDigests: [] };
  }
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const imageId = lines[0];
  return { imageId, repoDigests: lines.slice(1) };
}

function cleanupContainer({ runtime, containerName, redactor }) {
  runRuntimeCommand({
    runtime,
    args: ["rm", "-f", containerName],
    env: runtimeToolEnv(),
    redactor,
    description: `cleanup Botified runner container ${containerName}`,
    allowFailure: true
  });
}

async function prepareSmokeWorkspace({ workDir, dataDir }) {
  const writableDirs = [
    dataDir,
    path.join(dataDir, "tasks"),
    path.join(dataDir, "files"),
    path.join(dataDir, "files", "objects"),
    path.join(dataDir, "files", "metadata"),
    path.join(dataDir, "files", "tmp"),
    path.join(dataDir, "files", "corrupt"),
    path.join(dataDir, "timelines"),
    path.join(dataDir, "timelines", "thread_local"),
    path.join(dataDir, "timelines", "thread_local", "segments")
  ];
  await mkdir(workDir, { recursive: true });
  await chmod(workDir, 0o777);
  for (const dir of writableDirs) {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o777);
  }
}

function repairContainerTempDirPermissions({ runtime, image, tempDir, redactor }) {
  runRuntimeCommand({
    runtime,
    args: [
      "run",
      "--rm",
      "--entrypoint", "sh",
      "--user", "0:0",
      "--mount", `type=bind,src=${tempDir},dst=/cleanup`,
      image,
      "-c", containerPermissionRepairCommand()
    ],
    env: runtimeToolEnv(),
    redactor,
    description: `repair temporary workspace permissions ${tempDir}`,
    allowFailure: true
  });
}

async function cleanupTempDir(tempDir, redactor) {
  const firstError = await tryRemoveTempDir(tempDir);
  if (!firstError) {
    return;
  }

  let repairError;
  try {
    await makeTreeRemovable(tempDir);
  } catch (error) {
    repairError = error;
  }

  const secondError = await tryRemoveTempDir(tempDir);
  if (!secondError) {
    return;
  }

  const repairDetail = repairError ? `; permission repair failed: ${errorMessage(repairError)}` : "";
  console.warn(redactor.redact(`warning: failed to remove temporary workspace ${tempDir}: ${errorMessage(secondError)}${repairDetail}`));
}

async function tryRemoveTempDir(tempDir) {
  try {
    await rm(tempDir, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return error;
  }
}

async function makeTreeRemovable(targetPath) {
  let stat;
  try {
    stat = await lstat(targetPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    return;
  }

  if (!stat.isDirectory()) {
    await chmod(targetPath, 0o600);
    return;
  }

  await chmod(targetPath, 0o700);
  const entries = await readdir(targetPath, { withFileTypes: true });
  await Promise.all(entries.map((entry) => makeTreeRemovable(path.join(targetPath, entry.name))));
  await chmod(targetPath, 0o700);
}

function runRuntimeCommand({ runtime, args, env, redactor, description, allowFailure = false }) {
  const result = spawnSync(runtime, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  const status = result.status ?? 1;
  if (!allowFailure && (result.error || status !== 0)) {
    const output = [
      result.error ? errorMessage(result.error) : "",
      result.stdout ? `stdout: ${redactor.redact(result.stdout.trim())}` : "",
      result.stderr ? `stderr: ${redactor.redact(result.stderr.trim())}` : ""
    ].filter(Boolean).join("\n");
    throw new Error(`failed to ${description} (${formatExit({ code: status, signal: result.signal })})${output ? `\n${output}` : ""}`);
  }
  return {
    status,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

function runtimeToolEnv(parentEnv = process.env) {
  const env = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "DOCKER_HOST", "DOCKER_CONTEXT", "XDG_RUNTIME_DIR"]) {
    if (typeof parentEnv[key] === "string" && parentEnv[key].length > 0) {
      env[key] = parentEnv[key];
    }
  }
  return env;
}

function botifiedChildEnv(serviceKey, parentEnv = process.env) {
  const env = runtimeToolEnv(parentEnv);
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
  let publishedArtifact;
  let eventsObserved = 0;
  let finalState = "unknown";
  let activeItemCount = 0;
  let lastArtifactError;

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
    for (const event of timeline.events) {
      publishedArtifact = extractPublishedArtifact(event) ?? publishedArtifact;
    }
    timelineCursor = timeline.nextCursor ?? timelineCursor;

    if (markerObserved && publishedArtifact && hasIdleEvidence(state)) {
      try {
        const verifiedArtifact = await verifyPublishedArtifact({
          client,
          baseUrl,
          serviceKey,
          artifact: publishedArtifact
        });
        return {
          markerObserved,
          publishedArtifact: verifiedArtifact,
          eventsObserved,
          finalState,
          activeItemCount
        };
      } catch (error) {
        lastArtifactError = error;
      }
    }

    await sleep(150);
  }

  throw new Error([
    `timed out waiting for ${releaseSmokeMarker} and file.published; markerObserved=${markerObserved} filePublishedObserved=${Boolean(publishedArtifact)} finalState=${finalState} activeItemCount=${activeItemCount}`,
    lastArtifactError ? `artifact verification error: ${errorMessage(lastArtifactError)}` : "",
    childHandle.redactedOutput()
  ].filter(Boolean).join("\n"));
}

async function verifyPublishedArtifact({ client, baseUrl, serviceKey, artifact }) {
  if (!artifact.fileId) {
    throw new Error("file.published did not include file_id");
  }
  if (artifact.filename !== releaseSmokeArtifactFilename) {
    throw new Error(`file.published filename mismatch: expected ${releaseSmokeArtifactFilename}, got ${artifact.filename || "<missing>"}`);
  }
  if (artifact.bytes !== Buffer.byteLength(`${releaseSmokeMarker}\n`)) {
    throw new Error(`file.published size mismatch: expected ${Buffer.byteLength(`${releaseSmokeMarker}\n`)}, got ${artifact.bytes}`);
  }
  if (artifact.sha256 !== releaseSmokeArtifactSha256) {
    throw new Error(`file.published sha256 mismatch for ${artifact.fileId}`);
  }

  const downloaded = await client.downloadFile(baseUrl, serviceKey, artifact.fileId);
  const downloadedBytes = downloaded.sizeBytes;
  const downloadedSha256 = downloaded.sha256 ?? sha256Bytes(downloaded.bytes);
  const downloadedFilename = downloaded.filename ?? "";
  const downloadedText = Buffer.from(downloaded.bytes).toString("utf8");
  const markerMatched = downloadedText === `${releaseSmokeMarker}\n`;

  if (!markerMatched) {
    throw new Error(`downloaded artifact content mismatch for ${artifact.fileId}`);
  }
  if (downloadedFilename !== releaseSmokeArtifactFilename) {
    throw new Error(`downloaded artifact filename mismatch: expected ${releaseSmokeArtifactFilename}, got ${downloadedFilename || "<missing>"}`);
  }
  if (downloadedBytes !== artifact.bytes) {
    throw new Error(`downloaded artifact size mismatch: expected ${artifact.bytes}, got ${downloadedBytes}`);
  }
  if (downloadedSha256 !== artifact.sha256) {
    throw new Error(`downloaded artifact sha256 mismatch for ${artifact.fileId}`);
  }

  return {
    eventObserved: true,
    fileId: artifact.fileId,
    filename: artifact.filename,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    markerMatched,
    downloadedBytes,
    downloadedSha256,
    downloadedFilename
  };
}

function extractPublishedArtifact(event) {
  const record = asRecord(event);
  if (!record || record.type !== "file.published") {
    return undefined;
  }

  const payload = asRecord(record.data) ?? asRecord(record.payload) ?? record;
  const fileId = stringField(payload, "file_id") ?? stringField(payload, "id");
  const filename = stringField(payload, "filename") ?? stringField(payload, "name");
  const bytes = numberField(payload, "size_bytes") ?? numberField(payload, "bytes");
  const sha256 = stringField(payload, "sha256");
  return {
    fileId,
    filename,
    bytes,
    sha256
  };
}

function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function stringField(record, key) {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record, key) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
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

function runtimeConfigYaml({ host, port, workDir, dataDir }) {
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
  host: ${host}
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

function isNotFoundError(error) {
  return typeof error === "object" && error !== null && error.code === "ENOENT";
}

function containerPermissionRepairCommand() {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const gid = typeof process.getgid === "function" ? process.getgid() : undefined;
  if (Number.isInteger(uid) && Number.isInteger(gid)) {
    return `if chown -R ${uid}:${gid} /cleanup 2>/dev/null; then chmod -R u+rwX /cleanup; else chmod -R a+rwX /cleanup; fi`;
  }
  return "chmod -R a+rwX /cleanup";
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
