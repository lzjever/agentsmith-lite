#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const ADMIN_EMAIL = "admin@agentsmith-lite.local";
const WORKSPACE_NAME_PREFIX = "Deploy Product Workflow";
const PROJECT_NAME_PREFIX = "API Product Workflow";
const ENDPOINT_NAME_PREFIX = "Deploy Product Workflow Endpoint";
const FILE_NAME_PREFIX = "product-workflow-check";
const FILE_CONTENT = "hello from deploy product workflow check\n";
const TASK_ARTIFACT_NAME_PREFIX = "agentsmith-lite-task-workflow";
const TASK_MARKER = "AGENTSMITH_LITE_TASK_WORKFLOW_MARKER";
const TASK_POLL_INTERVAL_MS = 500;
const DEFAULT_TASK_TIMEOUT_SECS = 45;
const TASK_RECLAIM_PROMPT = [
  "Deploy product workflow task reclaim check.",
  "Use bash in the current task home/cwd to run a long sleep, for example: sleep 600.",
  "Do not publish files, do not create artifacts, and do not include credentials or endpoint secret references.",
  "The product workflow harness will cancel this task and then run scoped sandbox reap checks."
].join("\n");
const TERMINAL_EVENT_KINDS = new Set(["turn_completed", "turn_failed", "runtime_error"]);
const SANDBOX_CONTRACT_SCOPE = "product-api-sandbox-render-contract";
const RUNNER_CONTAINER_NAME = "botified-runner";
const PROJECT_FILES_VOLUME_NAME = "project-files";
const PROJECT_FILES_MOUNT_PATH = "/workspace/project";
const DIGEST_PINNED_IMAGE_PATTERN = /@sha256:[0-9a-f]{64}$/i;
const DIGEST_PATTERN = /sha256:[0-9a-f]{64}/i;
const K8S_RUN_ID_LABEL = "agentsmith-lite/run-id";
const K8S_NAME_ONLY_RESOURCE_KINDS = [
  ["Secret", "secrets"],
  ["ConfigMap", "configmaps"],
  ["ServiceAccount", "serviceaccounts"],
  ["Service", "services"],
  ["NetworkPolicy", "networkpolicies"]
];
const FORBIDDEN_KUBECTL_COMMANDS = new Set([
  "exec",
  "logs",
  "attach",
  "port-forward",
  "apply",
  "delete",
  "patch",
  "create"
]);

const sensitiveValues = new Set();

class UsageError extends Error {}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  requireOption(args.baseUrl, "--base-url");
  const taskArtifactCheck = taskArtifactCheckEnabled(args);
  const taskReclaimCheck = taskReclaimCheckEnabled(args);
  const taskReclaimReapApply = taskReclaimReapApplyEnabled(args);
  const checkK8sRunResources = Boolean(args.checkK8sRunResources);

  if (taskReclaimReapApply && !taskReclaimCheck) {
    throw new UsageError("task reclaim reap apply requires task reclaim check");
  }
  if (checkK8sRunResources && !taskArtifactCheck && !taskReclaimCheck) {
    throw new UsageError("k8s run resource check requires task artifact or task reclaim check");
  }

  const endpointConfig = endpointCheckConfig(args);
  const sessionConfig = explicitSessionConfig(args);
  if (taskArtifactCheck && !endpointConfig.complete) {
    throw new UsageError(
      "task artifact check requires endpoint config: --endpoint-base-url, --endpoint-model, and --endpoint-secret-ref"
    );
  }
  if (taskReclaimCheck && !endpointConfig.complete) {
    throw new UsageError(
      "task reclaim check requires endpoint config: --endpoint-base-url, --endpoint-model, and --endpoint-secret-ref"
    );
  }
  const taskTimeoutSecs = taskArtifactCheck ? taskCheckTimeoutSecs() : DEFAULT_TASK_TIMEOUT_SECS;

  const adminPassword = process.env.BUILTIN_ADMIN_INITIAL_PASSWORD;
  if (!sessionConfig) {
    requireOption(adminPassword, "BUILTIN_ADMIN_INITIAL_PASSWORD");
    sensitiveValues.add(adminPassword);
  } else {
    sensitiveValues.add(sessionConfig.cookie);
    sensitiveValues.add(sessionConfig.csrfToken);
  }

  if (endpointConfig.secretRef) {
    sensitiveValues.add(endpointConfig.secretRef);
  }
  if (endpointConfig.baseUrl) {
    sensitiveValues.add(endpointConfig.baseUrl);
  }
  addSensitiveEnvValues(["BOTIFIED_RUNNER_IMAGE", "JUICEFS_PVC_NAME"]);
  addSensitiveEnvValuesByPrefix(["S3_", "JUICEFS_"]);

  const k8sRunResourceObserver = checkK8sRunResources ? createK8sRunResourceObserver() : undefined;
  const workflowNames = createWorkflowRunNames();

  const workflow = new ProductWorkflowClient(args.baseUrl, sessionConfig);
  const health = await workflow.requestJson("GET", "/api/health");
  if (health.status !== "ok") {
    throw new Error("health check did not return ok");
  }
  if (!sessionConfig) {
    await workflow.requestJson("POST", "/api/auth/bootstrap", {
      body: { password: adminPassword }
    });
    await workflow.login(ADMIN_EMAIL, adminPassword);
  }

  const workspace = await workflow.requestJson("POST", "/api/workspaces", {
    auth: true,
    body: { name: workflowNames.workspaceName }
  });
  const workspaceId = requireString(workspace.id, "workspace id");

  const project = await workflow.requestJson("POST", `/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, {
    auth: true,
    body: { name: workflowNames.projectName }
  });
  const projectId = requireString(project.id, "project id");

  let chat = { status: "skipped" };
  let endpointId;
  if (endpointConfig.complete) {
    const endpoint = await workflow.requestJson("POST", `/api/projects/${encodeURIComponent(projectId)}/endpoints`, {
      auth: true,
      body: {
        name: workflowNames.endpointName,
        protocol: "openai_chat_completions",
        baseUrl: endpointConfig.baseUrl,
        model: endpointConfig.model,
        apiKeySecretRef: endpointConfig.secretRef,
        capabilities: ["text", "tool_calls"],
        requestTimeoutSecs: 30
      }
    });
    endpointId = requireString(endpoint.id, "endpoint id");
    await workflow.requestJson("POST", `/api/projects/${encodeURIComponent(projectId)}/chat`, {
      auth: true,
      body: {
        endpointId,
        messages: [{ role: "user", content: "deploy product workflow" }]
      }
    });
    chat = { status: "completed" };
  }

  await workflow.requestJson("POST", `/api/projects/${encodeURIComponent(projectId)}/files`, {
    auth: true,
    body: {
      path: workflowNames.filePath,
      content: FILE_CONTENT
    }
  });

  const files = await workflow.requestJson("GET", `/api/projects/${encodeURIComponent(projectId)}/files?path=files`, {
    auth: true
  });
  const entries = Array.isArray(files.entries) ? files.entries : [];
  if (!entries.some((entry) => entry && typeof entry === "object" && entry.path === workflowNames.filePath)) {
    throw new Error("uploaded workflow check file was not listed");
  }

  const downloaded = await workflow.requestText(
    "GET",
    `/api/projects/${encodeURIComponent(projectId)}/files/download?path=${encodeURIComponent(workflowNames.filePath)}`,
    { auth: true }
  );
  if (downloaded !== FILE_CONTENT) {
    throw new Error("downloaded workflow check file did not match uploaded content");
  }

  await workflow.requestJson("DELETE", `/api/projects/${encodeURIComponent(projectId)}/files`, {
    auth: true,
    body: { path: workflowNames.filePath }
  });

  await workflow.requestJson("GET", "/api/operator/sandbox/status", {
    auth: true
  });

  let task = { status: "skipped" };
  if (taskArtifactCheck) {
    task = await runTaskArtifactCheck(
      workflow,
      projectId,
      requireString(endpointId, "endpoint id"),
      workflowNames.taskArtifactName,
      taskTimeoutSecs,
      k8sRunResourceObserver
    );
  }

  const result = {
    status: "ok",
    baseUrl: args.baseUrl,
    workspaceId,
    projectId,
    chat,
    task
  };

  if (taskReclaimCheck) {
    result.taskReclaim = await runTaskReclaimCheck(
      workflow,
      projectId,
      requireString(endpointId, "endpoint id"),
      taskReclaimReapApply,
      k8sRunResourceObserver
    );
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function createWorkflowRunNames() {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
  return {
    workspaceName: `${WORKSPACE_NAME_PREFIX} ${suffix}`,
    projectName: `${PROJECT_NAME_PREFIX} ${suffix}`,
    endpointName: `${ENDPOINT_NAME_PREFIX} ${suffix}`,
    filePath: `files/${FILE_NAME_PREFIX}-${suffix}.txt`,
    taskArtifactName: `${TASK_ARTIFACT_NAME_PREFIX}-${suffix}.txt`
  };
}

function taskArtifactPrompt(artifactName) {
  return [
    "Deploy product workflow task artifact check.",
    `Use bash in the current task home/cwd to create ${artifactName}.`,
    `The file content must include this exact marker on its own line: ${TASK_MARKER}.`,
    `Then use the Botified publish_file tool to publish that file with filename ${artifactName}.`,
    "Keep the response brief and do not include credentials or endpoint secret references."
  ].join("\n");
}

async function runTaskArtifactCheck(workflow, projectId, endpointId, artifactName, timeoutSecs, k8sRunResourceObserver) {
  let taskId;
  let createStatus;
  let completed = false;
  try {
    const create = await workflow.fetchJson("POST", `/api/projects/${encodeURIComponent(projectId)}/tasks`, {
      auth: true,
      body: {
        endpointId,
        prompt: taskArtifactPrompt(artifactName)
      }
    });
    taskId = requireString(create.body.id, "task id");
    const runId = requireString(create.body.runId, "task run id");
    createStatus = requireString(create.body.status, "task create status");
    const sandboxContract = summarizeSandboxContract(create.body, "task artifact check");
    const k8sRunResources = k8sRunResourceObserver
      ? await k8sRunResourceObserver.observeRun(runId, "task artifact k8s run resource check", {
          expectedSandboxContract: sandboxContract
        })
      : undefined;

    const verified = await waitForVerifiedTaskArtifact(workflow, taskId, artifactName, timeoutSecs);
    const runScopedStatus = await getRunScopedStatusSummary(workflow, runId, "task artifact check run-scoped status");
    completed = true;
    return {
      status: "completed",
      taskId,
      runId,
      createStatus,
      artifactId: verified.artifactId,
      artifactName: verified.artifactName,
      eventCount: verified.eventCount,
      eventKinds: verified.eventKinds,
      artifactBytes: verified.artifactBytes,
      artifactSha256: verified.artifactSha256,
      markerObserved: verified.markerObserved,
      sandboxContract,
      ...(k8sRunResources ? { k8sRunResources } : {}),
      runScopedStatus
    };
  } catch (error) {
    if (taskId && !completed) {
      try {
        await workflow.fetchJson("POST", `/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
          auth: true
        });
      } catch {
        // Preserve the original task artifact check failure.
      }
    }
    throw error;
  }
}

async function waitForVerifiedTaskArtifact(workflow, taskId, expectedArtifactName, timeoutSecs) {
  const deadline = Date.now() + (timeoutSecs * 1000);
  const observedEvents = createObservedTaskEventSummary();
  while (Date.now() <= deadline) {
    const encodedTaskId = encodeURIComponent(taskId);
    const events = requireArray(await workflow.requestJson("GET", `/api/tasks/${encodedTaskId}/events`, {
      auth: true
    }), "task events");
    recordObservedTaskEvents(observedEvents, events);
    const artifacts = requireArray(await workflow.requestJson("GET", `/api/tasks/${encodedTaskId}/artifacts`, {
      auth: true
    }), "task artifacts");

    for (const artifact of artifacts) {
      const name = typeof artifact?.name === "string" ? artifact.name : "";
      if (name !== expectedArtifactName) {
        continue;
      }
      const artifactId = requireString(artifact.id, "task artifact id");
      const content = await workflow.requestText(
        "GET",
        `/api/tasks/${encodedTaskId}/artifacts/${encodeURIComponent(artifactId)}/download`,
        { auth: true }
      );
      if (!content.includes(TASK_MARKER)) {
        throw new Error(`artifact ${artifactId} did not contain task workflow marker`);
      }
      const eventSummary = finalizeObservedTaskEventSummary(observedEvents);
      return {
        artifactId,
        artifactName: name,
        eventCount: eventSummary.eventCount,
        eventKinds: eventSummary.eventKinds,
        artifactBytes: Buffer.byteLength(content, "utf8"),
        artifactSha256: sha256Hex(content),
        markerObserved: true
      };
    }

    const terminal = events.find((event) => TERMINAL_EVENT_KINDS.has(event?.kind));
    if (terminal) {
      throw new Error(`task artifact check reached terminal event ${terminal.kind} before verified artifact`);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await sleep(Math.min(TASK_POLL_INTERVAL_MS, remainingMs));
    }
  }
  throw new Error(`task artifact check timed out after ${timeoutSecs} seconds waiting for verified artifact`);
}

async function runTaskReclaimCheck(workflow, projectId, endpointId, reapApply, k8sRunResourceObserver) {
  let taskId;
  let cancelAttempted = false;
  try {
    const create = await workflow.fetchJson("POST", `/api/projects/${encodeURIComponent(projectId)}/tasks`, {
      auth: true,
      body: {
        endpointId,
        prompt: TASK_RECLAIM_PROMPT
      }
    });
    taskId = requireString(create.body.id, "task reclaim task id");
    const runId = requireString(create.body.runId, "task reclaim run id");
    const createStatus = requireString(create.body.status, "task reclaim create status");
    const sandboxContract = summarizeSandboxContract(create.body, "task reclaim");
    const k8sRunResources = k8sRunResourceObserver
      ? {
          beforeReap: await k8sRunResourceObserver.observeRun(runId, "task reclaim before reap k8s run resource check", {
            expectedSandboxContract: sandboxContract
          })
        }
      : undefined;

    cancelAttempted = true;
    const cancel = await workflow.fetchJson("POST", `/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
      auth: true
    });
    const cancelStatus = requireString(cancel.body.status, "task reclaim cancel status");
    const runScopedStatus = await getRunScopedStatusSummary(workflow, runId, "task reclaim run-scoped status");

    const reap = {
      dryRun: await runScopedReap(workflow, runId, false, "task reclaim dry-run reap")
    };
    if (k8sRunResourceObserver) {
      k8sRunResources.afterDryRun = await k8sRunResourceObserver.observeRun(runId, "task reclaim after dry-run k8s run resource check", {
        allowNoPods: true,
        expectedSandboxContract: sandboxContract
      });
    }
    if (reapApply) {
      reap.apply = await runScopedReap(workflow, runId, true, "task reclaim apply reap");
      reap.finalDryRun = await runScopedReap(workflow, runId, false, "task reclaim final dry-run reap");
      if (k8sRunResourceObserver) {
        k8sRunResources.afterApply = await k8sRunResourceObserver.observeRun(runId, "task reclaim after apply k8s run resource check", {
          allowNoPods: true
        });
        k8sRunResources.reclaimScopedResult = summarizeK8sReclaimScopedResult(k8sRunResources.beforeReap, k8sRunResources.afterApply);
      }
    }

    return {
      status: "completed",
      taskId,
      runId,
      createStatus,
      cancelStatus,
      sandboxContract,
      reapScope: {
        scopedToRunId: true,
        applyEnabled: Boolean(reapApply)
      },
      runScopedStatus,
      reap,
      ...(k8sRunResources ? { k8sRunResources } : {})
    };
  } catch (error) {
    if (taskId && !cancelAttempted) {
      try {
        await workflow.fetchJson("POST", `/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
          auth: true
        });
      } catch {
        // Preserve the original task reclaim check failure.
      }
    }
    throw error;
  }
}

async function getRunScopedStatusSummary(workflow, runId, context) {
  const result = await workflow.requestJson(
    "GET",
    `/api/operator/sandbox/status?${new URLSearchParams({ runId }).toString()}`,
    { auth: true }
  );
  return summarizeRunScopedStatus(result, runId, context);
}

function summarizeRunScopedStatus(result, runId, context) {
  return {
    runId,
    activeTaskCount: requireNumber(result?.activeTaskCount, `${context} active task count`),
    runCounts: numberRecord(result?.runCounts, `${context} run counts`),
    observedResourceCounts: numberRecord(result?.observedResourceCounts, `${context} observed resource counts`),
    cleanupTargetCount: requireArray(result?.cleanupPlan?.targets, `${context} cleanup targets`).length,
    errorCount: requireArray(result?.errors, `${context} errors`).length
  };
}

async function runScopedReap(workflow, runId, apply, context) {
  const result = await workflow.requestJson("POST", "/api/operator/sandbox/reap", {
    auth: true,
    body: apply ? { runId, apply: true } : { runId }
  });
  return summarizeReapResult(result, apply ? false : true, context);
}

function summarizeReapResult(result, expectedDryRun, context) {
  const dryRun = requireBoolean(result?.dryRun, `${context} dryRun`);
  if (dryRun !== expectedDryRun) {
    throw new Error(`${context} returned dryRun=${dryRun}, expected ${expectedDryRun}`);
  }
  const errors = requireArray(result?.errors, `${context} errors`);
  if (errors.length > 0) {
    throw new Error(`${context} returned ${errors.length} error(s)`);
  }
  return {
    dryRun,
    actionCount: requireArray(result?.actionSummary, `${context} action summary`).length,
    cleanupTargetCount: requireArray(result?.cleanupPlan?.targets, `${context} cleanup targets`).length,
    errorCount: errors.length,
    storedRunIds: requireArray(result?.storedRunIds, `${context} stored run ids`).map((runId) =>
      requireString(runId, `${context} stored run id`)
    )
  };
}

function summarizeSandboxContract(taskCreateBody, context) {
  const resources = requireArray(taskCreateBody?.sandbox?.resources, `${context} sandbox.resources`);
  const pods = resources.filter((resource) => isRecord(resource) && resource.kind === "Pod");
  if (pods.length !== 1) {
    throw new Error(`${context} sandbox.resources must contain exactly one Pod`);
  }

  const pod = pods[0];
  const podName = requireString(pod.metadata?.name, `${context} sandbox Pod name`);
  const containers = requireArray(pod.spec?.containers, `${context} sandbox Pod containers`);
  const runner = containers.find((container) => isRecord(container) && container.name === RUNNER_CONTAINER_NAME);
  if (!runner) {
    throw new Error(`${context} sandbox Pod must include ${RUNNER_CONTAINER_NAME} container`);
  }

  const runnerImage = requireString(runner.image, `${context} ${RUNNER_CONTAINER_NAME} image`);
  const expectedRunnerImage = firstNonEmpty(process.env.BOTIFIED_RUNNER_IMAGE);
  if (expectedRunnerImage && runnerImage !== expectedRunnerImage) {
    throw new Error(`${context} ${RUNNER_CONTAINER_NAME} image does not match BOTIFIED_RUNNER_IMAGE`);
  }
  if (process.env.AGENTSMITH_LITE_SANDBOX_MODE === "live" && !DIGEST_PINNED_IMAGE_PATTERN.test(runnerImage)) {
    throw new Error(`${context} live sandbox ${RUNNER_CONTAINER_NAME} image must be digest pinned`);
  }

  const volumes = requireArray(pod.spec?.volumes, `${context} sandbox Pod volumes`);
  const projectVolume = volumes.find((volume) => isRecord(volume) && volume.name === PROJECT_FILES_VOLUME_NAME);
  if (!projectVolume || !isRecord(projectVolume.persistentVolumeClaim)) {
    throw new Error(`${context} sandbox Pod must include ${PROJECT_FILES_VOLUME_NAME} PVC volume`);
  }
  const pvcClaimName = requireString(
    projectVolume.persistentVolumeClaim.claimName,
    `${context} ${PROJECT_FILES_VOLUME_NAME} PVC claimName`
  );
  const expectedPvcClaimName = firstNonEmpty(process.env.JUICEFS_PVC_NAME);
  if (expectedPvcClaimName && pvcClaimName !== expectedPvcClaimName) {
    throw new Error(`${context} ${PROJECT_FILES_VOLUME_NAME} PVC claimName does not match JUICEFS_PVC_NAME`);
  }

  const volumeMounts = requireArray(runner.volumeMounts, `${context} ${RUNNER_CONTAINER_NAME} volumeMounts`);
  const projectMount = volumeMounts.find((mount) => isRecord(mount) && mount.name === PROJECT_FILES_VOLUME_NAME);
  if (!projectMount) {
    throw new Error(`${context} ${RUNNER_CONTAINER_NAME} must mount ${PROJECT_FILES_VOLUME_NAME}`);
  }
  const mountPath = requireString(projectMount.mountPath, `${context} ${PROJECT_FILES_VOLUME_NAME} mountPath`);
  if (mountPath !== PROJECT_FILES_MOUNT_PATH) {
    throw new Error(`${context} ${PROJECT_FILES_VOLUME_NAME} mountPath must be ${PROJECT_FILES_MOUNT_PATH}`);
  }
  const subPath = requireString(projectMount.subPath, `${context} ${PROJECT_FILES_VOLUME_NAME} subPath`);
  if (!isSafeRelativeSubPath(subPath)) {
    throw new Error(`${context} ${PROJECT_FILES_VOLUME_NAME} subPath must be a non-empty relative path without ..`);
  }

  return {
    scope: SANDBOX_CONTRACT_SCOPE,
    podName,
    runnerContainer: RUNNER_CONTAINER_NAME,
    runnerImage,
    pvcClaimName,
    mountPath,
    subPath
  };
}

function createK8sRunResourceObserver() {
  const namespace = firstNonEmpty(process.env.KUBE_NAMESPACE);
  requireOption(namespace, "KUBE_NAMESPACE");
  const kubectlBin = firstNonEmpty(process.env.KUBECTL_BIN) ?? "kubectl";
  const baseArgs = [];
  const kubeconfig = firstNonEmpty(process.env.KUBECONFIG_PATH);
  if (kubeconfig) {
    baseArgs.push("--kubeconfig", kubeconfig);
  }
  const context = firstNonEmpty(process.env.KUBE_CONTEXT);
  if (context) {
    baseArgs.push("--context", context);
  }
  return new K8sRunResourceObserver({ kubectlBin, baseArgs, namespace });
}

class K8sRunResourceObserver {
  constructor({ kubectlBin, baseArgs, namespace }) {
    this.kubectlBin = kubectlBin;
    this.baseArgs = baseArgs;
    this.namespace = namespace;
  }

  async observeRun(runId, context, options = {}) {
    const selector = `${K8S_RUN_ID_LABEL}=${runId}`;
    const podList = await this.kubectlJson([
      "get",
      "pods",
      "-n",
      this.namespace,
      "-l",
      selector,
      "-o",
      "json"
    ], context);
    const pods = summarizeK8sPods(podList, runId, context, options.expectedSandboxContract);
    if (!options.allowNoPods && pods.length === 0) {
      throw new Error(`${context} did not observe any Pods for runId`);
    }

    const resources = {
      Pod: {
        count: pods.length,
        names: pods.map((pod) => pod.name)
      }
    };
    for (const [kind, resource] of K8S_NAME_ONLY_RESOURCE_KINDS) {
      const names = await this.kubectlNames([
        "get",
        resource,
        "-n",
        this.namespace,
        "-l",
        selector,
        "-o",
        "name"
      ], context);
      resources[kind] = {
        count: names.length,
        names
      };
    }

    return {
      status: "observed",
      runId,
      namespace: this.namespace,
      pods,
      resources
    };
  }

  async kubectlJson(args, context) {
    const stdout = await this.runKubectl(args, context);
    try {
      return JSON.parse(stdout || "{}");
    } catch {
      throw new Error(`${context} returned invalid kubectl JSON`);
    }
  }

  async kubectlNames(args, context) {
    const stdout = await this.runKubectl(args, context);
    return stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  }

  async runKubectl(args, context) {
    validateReadOnlyKubectlGetArgs(args, context);
    const fullArgs = [...this.baseArgs, ...args];
    return new Promise((resolve, reject) => {
      const child = spawn(this.kubectlBin, fullArgs, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.on("error", (error) => {
        if (error && error.code === "ENOENT") {
          reject(new Error(`${context} requires kubectl`));
        } else {
          reject(error);
        }
      });
      child.on("close", (status) => {
        const out = Buffer.concat(stdout).toString("utf8");
        const err = Buffer.concat(stderr).toString("utf8");
        if (status !== 0) {
          reject(new Error(`${context} kubectl get failed with exit ${status}: ${redact(err || out)}`));
          return;
        }
        resolve(out);
      });
    });
  }
}

function validateReadOnlyKubectlGetArgs(args, context) {
  if (args[0] !== "get") {
    throw new Error(`${context} attempted non-get kubectl command`);
  }
  for (const arg of args) {
    if (FORBIDDEN_KUBECTL_COMMANDS.has(arg)) {
      throw new Error(`${context} attempted forbidden kubectl command ${arg}`);
    }
  }
}

function summarizeK8sPods(podList, runId, context, expectedSandboxContract) {
  const items = requireArray(podList?.items, `${context} pod list items`);
  return items.map((pod) => summarizeK8sPod(pod, runId, context, expectedSandboxContract));
}

function summarizeK8sPod(pod, runId, context, expectedSandboxContract) {
  const name = requireString(pod?.metadata?.name, `${context} pod name`);
  const observedRunId = requireString(pod?.metadata?.labels?.[K8S_RUN_ID_LABEL], `${context} pod ${name} run-id label`);
  if (observedRunId !== runId) {
    throw new Error(`${context} pod ${name} run-id label mismatch`);
  }

  const specContainers = requireArray(pod?.spec?.containers, `${context} pod ${name} containers`);
  const specRunner = specContainers.find((container) => isRecord(container) && container.name === RUNNER_CONTAINER_NAME);
  if (!specRunner) {
    throw new Error(`${context} pod ${name} missing ${RUNNER_CONTAINER_NAME} container`);
  }
  const statusContainers = Array.isArray(pod?.status?.containerStatuses) ? pod.status.containerStatuses : [];
  const statusRunner = statusContainers.find((container) => isRecord(container) && container.name === RUNNER_CONTAINER_NAME);
  const runnerImage = requireString(
    stringRecordField(specRunner, "image"),
    `${context} pod ${name} ${RUNNER_CONTAINER_NAME} image`
  );
  const runnerImageID = requireString(
    stringRecordField(statusRunner, "imageID"),
    `${context} pod ${name} ${RUNNER_CONTAINER_NAME} imageID`
  );
  if (!DIGEST_PINNED_IMAGE_PATTERN.test(runnerImage)) {
    throw new Error(`${context} declared ${RUNNER_CONTAINER_NAME} image must be digest pinned`);
  }
  if (!DIGEST_PATTERN.test(runnerImageID)) {
    throw new Error(`${context} observed ${RUNNER_CONTAINER_NAME} imageID must include digest`);
  }

  const volumes = requireArray(pod?.spec?.volumes, `${context} pod ${name} volumes`);
  const projectVolume = volumes.find((volume) => isRecord(volume) && volume.name === PROJECT_FILES_VOLUME_NAME);
  if (!projectVolume || !isRecord(projectVolume.persistentVolumeClaim)) {
    throw new Error(`${context} pod ${name} missing ${PROJECT_FILES_VOLUME_NAME} PVC volume`);
  }
  const pvcClaimName = requireString(
    projectVolume.persistentVolumeClaim.claimName,
    `${context} pod ${name} ${PROJECT_FILES_VOLUME_NAME} PVC claimName`
  );
  const volumeMounts = requireArray(specRunner.volumeMounts, `${context} pod ${name} ${RUNNER_CONTAINER_NAME} volumeMounts`);
  const projectMount = volumeMounts.find((mount) => isRecord(mount) && mount.name === PROJECT_FILES_VOLUME_NAME);
  if (!projectMount) {
    throw new Error(`${context} pod ${name} ${RUNNER_CONTAINER_NAME} missing ${PROJECT_FILES_VOLUME_NAME} mount`);
  }
  const mountPath = requireString(projectMount.mountPath, `${context} pod ${name} ${PROJECT_FILES_VOLUME_NAME} mountPath`);
  const subPath = requireString(projectMount.subPath, `${context} pod ${name} ${PROJECT_FILES_VOLUME_NAME} subPath`);

  const summary = {
    name,
    phase: requireString(pod?.status?.phase, `${context} pod ${name} phase`),
    ready: Boolean(statusRunner?.ready),
    runnerImage,
    runnerImageID,
    pvcClaimName,
    mountPath,
    subPath
  };
  if (expectedSandboxContract) {
    assertK8sPodMatchesSandboxContract(summary, expectedSandboxContract, context);
  }
  return summary;
}

function assertK8sPodMatchesSandboxContract(podSummary, expected, context) {
  if (podSummary.runnerImage !== expected.runnerImage) {
    throw new Error(`${context} pod ${podSummary.name} ${RUNNER_CONTAINER_NAME} image does not match sandbox contract`);
  }
  if (podSummary.pvcClaimName !== expected.pvcClaimName) {
    throw new Error(`${context} pod ${podSummary.name} ${PROJECT_FILES_VOLUME_NAME} PVC claimName does not match sandbox contract`);
  }
  if (podSummary.mountPath !== expected.mountPath) {
    throw new Error(`${context} pod ${podSummary.name} ${PROJECT_FILES_VOLUME_NAME} mountPath does not match sandbox contract`);
  }
  if (podSummary.subPath !== expected.subPath) {
    throw new Error(`${context} pod ${podSummary.name} ${PROJECT_FILES_VOLUME_NAME} subPath does not match sandbox contract`);
  }
}

function summarizeK8sReclaimScopedResult(before, after) {
  const beforeCount = totalK8sResourceCount(before);
  const afterCount = totalK8sResourceCount(after);
  return {
    beforeResourceCount: beforeCount,
    afterResourceCount: afterCount,
    resourceCountDelta: afterCount - beforeCount,
    cleared: afterCount === 0,
    reduced: afterCount < beforeCount
  };
}

function totalK8sResourceCount(summary) {
  return Object.values(summary.resources).reduce((total, resource) => total + resource.count, 0);
}

function isSafeRelativeSubPath(value) {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    !value.includes("\\") &&
    !value.includes("..")
  );
}

function createObservedTaskEventSummary() {
  return {
    eventKeys: new Set(),
    eventKinds: [],
    eventKindSet: new Set(),
    fallbackIndex: 0
  };
}

function recordObservedTaskEvents(summary, events) {
  for (const event of events) {
    const identity = stringRecordField(event, "id") ?? stringRecordField(event, "cursor");
    const eventKey = identity ?? `fallback:${summary.fallbackIndex}`;
    if (!identity) {
      summary.fallbackIndex += 1;
    }
    if (summary.eventKeys.has(eventKey)) {
      continue;
    }
    summary.eventKeys.add(eventKey);

    const kind = stringRecordField(event, "kind");
    if (kind && !summary.eventKindSet.has(kind)) {
      summary.eventKindSet.add(kind);
      summary.eventKinds.push(kind);
    }
  }
}

function finalizeObservedTaskEventSummary(summary) {
  return {
    eventCount: summary.eventKeys.size,
    eventKinds: [...summary.eventKinds]
  };
}

function stringRecordField(value, field) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const fieldValue = value[field];
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

class ProductWorkflowClient {
  constructor(baseUrl, sessionConfig) {
    this.baseUrl = baseUrl;
    this.cookie = sessionConfig?.cookie ?? "";
    this.csrfToken = sessionConfig?.csrfToken ?? "";
  }

  async login(email, password) {
    const response = await this.fetchJson("POST", "/api/auth/login", {
      body: { email, password }
    });
    this.cookie = cookieFromSetCookie(response.setCookie);
    this.csrfToken = requireString(response.body.csrfToken, "csrf token");
  }

  async requestJson(method, pathname, options = {}) {
    const response = await this.fetchJson(method, pathname, options);
    return response.body;
  }

  async requestText(method, pathname, options = {}) {
    const response = await this.fetchRaw(method, pathname, options);
    return response.text;
  }

  async fetchJson(method, pathname, options = {}) {
    const response = await this.fetchRaw(method, pathname, options);
    return {
      body: parseJsonResponse(response.text, `${method} ${pathname}`),
      setCookie: response.setCookie
    };
  }

  async fetchRaw(method, pathname, options = {}) {
    const headers = {
      accept: "application/json"
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (options.auth) {
      requireOption(this.cookie, "session cookie");
      requireOption(this.csrfToken, "CSRF token");
      headers.cookie = this.cookie;
      headers["x-csrf-token"] = this.csrfToken;
    }

    const response = await fetch(joinUrl(this.baseUrl, pathname), {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${pathname} returned ${response.status}: ${redact(text)}`);
    }
    return {
      text,
      setCookie: response.headers.get("set-cookie")
    };
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") {
      parsed.baseUrl = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--endpoint-base-url") {
      parsed.endpointBaseUrl = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--endpoint-model") {
      parsed.endpointModel = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--endpoint-secret-ref") {
      parsed.endpointSecretRef = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--cookie-file") {
      parsed.cookieFile = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--csrf-token") {
      parsed.csrfToken = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--check-task-artifact") {
      parsed.taskArtifactCheck = true;
    } else if (arg === "--check-task-reclaim") {
      parsed.taskReclaimCheck = true;
    } else if (arg === "--check-task-reclaim-reap-apply") {
      parsed.taskReclaimReapApply = true;
    } else if (arg === "--check-k8s-run-resources") {
      parsed.checkK8sRunResources = true;
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function explicitSessionConfig(args) {
  const cookieFile = firstNonEmpty(args.cookieFile, process.env.PRODUCT_WORKFLOW_COOKIE_FILE);
  const csrfToken = firstNonEmpty(args.csrfToken, process.env.PRODUCT_WORKFLOW_CSRF_TOKEN);
  if (!cookieFile && !csrfToken) {
    return undefined;
  }
  requireOption(cookieFile, "--cookie-file or PRODUCT_WORKFLOW_COOKIE_FILE");
  requireOption(csrfToken, "--csrf-token or PRODUCT_WORKFLOW_CSRF_TOKEN");
  return {
    cookie: readSessionCookie(cookieFile),
    csrfToken
  };
}

function readSessionCookie(cookieFile) {
  const text = readFileSync(cookieFile, "utf8");
  const cookie = text.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("asl_session="));
  if (!cookie) {
    throw new UsageError("session cookie file must contain asl_session");
  }
  return cookie.split(";")[0];
}

function endpointCheckConfig(args) {
  const baseUrl = firstNonEmpty(args.endpointBaseUrl, process.env.PRODUCT_WORKFLOW_ENDPOINT_BASE_URL);
  const model = firstNonEmpty(args.endpointModel, process.env.PRODUCT_WORKFLOW_ENDPOINT_MODEL);
  const secretRef = firstNonEmpty(args.endpointSecretRef, process.env.PRODUCT_WORKFLOW_ENDPOINT_SECRET_REF);
  return {
    baseUrl,
    model,
    secretRef,
    complete: Boolean(baseUrl && model && secretRef)
  };
}

function taskArtifactCheckEnabled(args) {
  const envTaskArtifactCheck = parseWorkflowBooleanEnv("PRODUCT_WORKFLOW_CHECK_TASK_ARTIFACT");
  return Boolean(args.taskArtifactCheck || envTaskArtifactCheck);
}

function taskReclaimCheckEnabled(args) {
  const envTaskReclaimCheck = parseWorkflowBooleanEnv("PRODUCT_WORKFLOW_CHECK_TASK_RECLAIM");
  return Boolean(args.taskReclaimCheck || envTaskReclaimCheck);
}

function taskReclaimReapApplyEnabled(args) {
  const envTaskReclaimReapApply = parseWorkflowBooleanEnv("PRODUCT_WORKFLOW_CHECK_TASK_RECLAIM_REAP_APPLY");
  return Boolean(args.taskReclaimReapApply || envTaskReclaimReapApply);
}

function taskCheckTimeoutSecs() {
  return parsePositiveIntegerEnv("PRODUCT_WORKFLOW_TASK_TIMEOUT_SECS", DEFAULT_TASK_TIMEOUT_SECS);
}

function addSensitiveEnvValues(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) {
      sensitiveValues.add(value);
    }
  }
}

function addSensitiveEnvValuesByPrefix(prefixes) {
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    if (prefixes.some((prefix) => name.startsWith(prefix))) {
      sensitiveValues.add(value);
    }
  }
}

function parseWorkflowBooleanEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "" || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new UsageError(`${name} must be true, false, empty, or unset`);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

function requireOption(value, name) {
  if (!value) {
    throw new UsageError(`${name} is required`);
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} missing from API response`);
  }
  return value;
}

function requireNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} missing from API response`);
  }
  return value;
}

function numberRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} missing from API response`);
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => typeof entryValue === "number" && Number.isFinite(entryValue))
  );
}

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} missing from API response`);
  }
  return value;
}

function requireBoolean(value, name) {
  if (typeof value !== "boolean") {
    throw new Error(`${name} missing from API response`);
  }
  return value;
}

function parsePositiveIntegerEnv(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return defaultValue;
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new UsageError(`${name} must be a positive integer`);
  }
  return Number(value);
}

function cookieFromSetCookie(setCookie) {
  if (!setCookie) {
    throw new Error("login response did not set session cookie");
  }
  const cookie = setCookie.split(";")[0]?.trim();
  if (!cookie) {
    throw new Error("login response set an empty session cookie");
  }
  return cookie;
}

function parseJsonResponse(text, context) {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${context} returned invalid JSON`);
  }
}

function joinUrl(baseUrl, pathname) {
  const base = new URL(baseUrl);
  const request = new URL(pathname, "http://agentsmith-lite.local");
  const basePath = base.pathname.replace(/\/+$/, "");
  base.pathname = `${basePath}${request.pathname}`;
  base.search = request.search;
  base.hash = "";
  return base.toString();
}

function redact(value) {
  let redacted = String(value);
  for (const sensitive of sensitiveValues) {
    if (sensitive) {
      redacted = redacted.split(sensitive).join("<redacted>");
    }
  }
  return redacted
    .replace(/https?:\/\/[^\s"'<>]+/g, "<redacted-url>")
    .replace(/\bbsk_[A-Za-z0-9._-]+/g, "bsk_<redacted>")
    .replace(/\bsk-[A-Za-z0-9._-]+/g, "sk-<redacted>")
    .replace(/(BOTIFIED_SERVICE_KEY["'\s:=]+)[^"',\s}]+/g, "$1<redacted>")
    .replace(/(MODEL_API_KEY["'\s:=]+)[^"',\s}]+/g, "$1<redacted>");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  const message = error instanceof UsageError
    ? error.message
    : `product workflow check failed: ${errorMessage(error)}`;
  console.error(redact(message));
  process.exit(error instanceof UsageError ? 2 : 1);
});
