import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { SandboxLifecycleService, type SandboxLifecycleKubernetesPort } from "../../packages/application/src/sandboxLifecycleService.js";
import type { KubernetesResource, ProjectAuditEvent } from "../../packages/contracts/src/api.js";
import type { OpenAICompatibleClient } from "../../packages/openai-compatible-client/src/index.js";
import type { PersistedAgentTask, PersistedSandboxRunState } from "../../packages/ports/src/store.js";
import type { KubernetesResourceRef } from "../../packages/sandbox-controller/src/kubernetesPort.js";
import { applySandboxReconcileActions, reconcileSandboxRuns, type SandboxRunState } from "../../packages/sandbox-controller/src/reconciler.js";

describe("durable failure alerts", () => {
  it("alerts and notifies on the first endpoint health failure from its safe audit window", async () => {
    const secret = "endpoint-secret-must-not-leak";
    let healthy = true;
    const setup = await projectSetup({
      async completeChat() { throw new Error("not used"); },
      async validateEndpoint() { return healthy ? { status: "healthy" } : { status: "unavailable", errorCategory: "auth" }; }
    });
    const endpoint = await createEndpoint(setup, secret);
    const rule = await setup.services.alertRules.create(setup.userId, setup.projectId, {
      alertType: "endpoint_failure",
      threshold: 1,
      windowSeconds: 3600,
      scope: { kind: "endpoint", endpointId: endpoint.id }
    });

    healthy = false;
    const checked = await setup.services.endpoints.recheckEndpoint(setup.userId, setup.projectId, endpoint.id);

    assert.equal(checked.health?.status, "unavailable");
    const alert = (await setup.store.queryProjectAlerts(setup.projectId,{view:"active",limit:50})).items.find((item) => item.ruleId === rule.id);
    assert.deepEqual([alert?.metricValue, alert?.threshold, alert?.deliveryStatus, alert?.endpointId], [1, 1, "delivered", endpoint.id]);
    assert.equal((await setup.services.notifications.list(setup.userId)).filter((item) => item.type === "project_alert").length, 1);
    const event = ((await setup.store.queryProjectAuditEvents(setup.projectId,{limit:100})).items).find((item) => item.action === "endpoint.health_check");
    assert.deepEqual([event?.status, event?.resourceKind, event?.detail], ["rejected", "endpoint", { endpointId: endpoint.id, healthStatus: "unavailable", errorCategory: "auth" }]);
    assert.doesNotMatch(JSON.stringify((await setup.store.queryProjectAuditEvents(setup.projectId,{limit:100})).items), new RegExp(secret));
  });

  it("does not evaluate an endpoint failure whose audit event was not persisted", async () => {
    let healthy = true;
    const setup = await projectSetup({
      async completeChat() { throw new Error("not used"); },
      async validateEndpoint() { return healthy ? { status: "healthy" } : { status: "unavailable", errorCategory: "network" }; }
    });
    const endpoint = await createEndpoint(setup, "endpoint-write-failure-secret");
    await setup.services.alertRules.create(setup.userId, setup.projectId, { alertType: "endpoint_failure", threshold: 1, windowSeconds: 3600 });
    const measurements = countMeasurements(setup.store);
    failNextAudit(setup.store, (event) => event.action === "endpoint.health_check" && event.status === "rejected");

    healthy = false;
    await assert.rejects(() => setup.services.endpoints.recheckEndpoint(setup.userId, setup.projectId, endpoint.id), /audit append unavailable/);

    assert.equal(measurements(), 0);
    assert.equal((await setup.store.queryProjectAlerts(setup.projectId,{view:"active",limit:50})).items.filter((item) => item.type === "endpoint_failure").length, 0);
    assert.equal((await setup.services.notifications.list(setup.userId)).filter((item) => item.type === "project_alert").length, 0);
  });

  it("alerts and notifies on the first provider failure from its safe audit window", async () => {
    const secret = "provider-secret-must-not-leak";
    const setup = await projectSetup({
      async validateEndpoint() { return { status: "healthy" }; },
      async completeChat() { throw new Error(`provider failed with ${secret}`); }
    });
    const endpoint = await createEndpoint(setup, secret);
    const rule = await setup.services.alertRules.create(setup.userId, setup.projectId, {
      alertType: "provider_failure",
      threshold: 1,
      windowSeconds: 3600,
      scope: { kind: "endpoint", endpointId: endpoint.id }
    });

    await assert.rejects(() => setup.services.providerBroker.completeChat({ endpoint, settlementEndpointId: endpoint.id, apiKey: secret, actorId: setup.userId }, [{ role: "user", content: "hello" }]), /OpenAI-compatible provider request failed/);

    const alert = (await setup.store.queryProjectAlerts(setup.projectId,{view:"active",limit:50})).items.find((item) => item.ruleId === rule.id);
    assert.deepEqual([alert?.metricValue, alert?.threshold, alert?.deliveryStatus, alert?.endpointId], [1, 1, "delivered", endpoint.id]);
    assert.equal((await setup.services.notifications.list(setup.userId)).filter((item) => item.type === "project_alert").length, 1);
    const event = ((await setup.store.queryProjectAuditEvents(setup.projectId,{limit:100})).items).find((item) => item.action === "provider.request" && item.status === "rejected");
    assert.deepEqual([event?.resourceKind, event?.resourceId, event?.detail], ["provider", endpoint.id, { endpointId: endpoint.id, errorCategory: "unknown" }]);
    assert.doesNotMatch(JSON.stringify((await setup.store.queryProjectAuditEvents(setup.projectId,{limit:100})).items), new RegExp(secret));
  });

  it("does not evaluate a provider failure whose audit event was not persisted", async () => {
    const setup = await projectSetup({
      async validateEndpoint() { return { status: "healthy" }; },
      async completeChat() { throw new Error("provider-write-failure-secret"); }
    });
    const endpoint = await createEndpoint(setup, "provider-write-failure-secret");
    await setup.services.alertRules.create(setup.userId, setup.projectId, { alertType: "provider_failure", threshold: 1, windowSeconds: 3600 });
    const measurements = countMeasurements(setup.store);
    failNextAudit(setup.store, (event) => event.action === "provider.request" && event.status === "rejected");

    await assert.rejects(() => setup.services.providerBroker.completeChat({ endpoint, settlementEndpointId: endpoint.id, apiKey: "provider-write-failure-secret", actorId: setup.userId }, [{ role: "user", content: "hello" }]), /audit append unavailable/);

    assert.equal(measurements(), 0);
    assert.equal((await setup.store.queryProjectAlerts(setup.projectId,{view:"active",limit:50})).items.filter((item) => item.type === "provider_failure").length, 0);
    assert.equal((await setup.services.notifications.list(setup.userId)).filter((item) => item.type === "project_alert").length, 0);
  });

  it("alerts and notifies on the first sandbox failure from its safe audit window", async () => {
    const setup = await sandboxSetup("sandbox-secret-must-not-leak");
    const rule = await setup.services.alertRules.create(setup.userId, setup.projectId, { alertType: "sandbox_failure", threshold: 1, windowSeconds: 3600 });

    await setup.lifecycle.reapSandboxRunsOnce({ runId: setup.run.runId, apply: true });

    const alert = (await setup.store.queryProjectAlerts(setup.projectId,{view:"active",limit:50})).items.find((item) => item.ruleId === rule.id);
    assert.deepEqual([alert?.metricValue, alert?.threshold, alert?.deliveryStatus], [1, 1, "delivered"]);
    assert.equal((await setup.services.notifications.list(setup.userId)).filter((item) => item.type === "project_alert").length, 1);
    const event = ((await setup.store.queryProjectAuditEvents(setup.projectId,{limit:100})).items).find((item) => item.action === "sandbox.failed");
    assert.deepEqual([event?.status, event?.resourceKind, event?.resourceId, event?.detail], ["accepted", "sandbox", setup.run.taskId, { endpointId: setup.task.endpointId, taskId: setup.run.taskId, runId:setup.run.runId }]);
    assert.doesNotMatch(JSON.stringify((await setup.store.queryProjectAuditEvents(setup.projectId,{limit:100})).items), /sandbox-secret-must-not-leak/);
  });

  it("does not evaluate a missing sandbox audit event and retries it once through maintenance", async () => {
    const setup = await sandboxSetup("sandbox-write-failure-secret");
    await setup.services.alertRules.create(setup.userId, setup.projectId, { alertType: "sandbox_failure", threshold: 1, windowSeconds: 3600 });
    const measurements = countMeasurements(setup.store);
    failNextSandboxRunFailure(setup.store);

    const failed = await setup.lifecycle.reapSandboxRunsOnce({ runId: setup.run.runId, apply: true });

    assert.match(failed.errors.join("\n"), /audit append unavailable/);
    assert.equal((await setup.store.sandboxRuns.get(setup.run.runId))?.state, "active");
    assert.equal(measurements(), 0);
    assert.equal((await setup.store.queryProjectAlerts(setup.projectId,{view:"active",limit:50})).items.filter((item) => item.type === "sandbox_failure").length, 0);
    assert.equal((await setup.services.notifications.list(setup.userId)).filter((item) => item.type === "project_alert").length, 0);

    await setup.lifecycle.reapSandboxRunsOnce({ runId: setup.run.runId, apply: true });

    const releasedRun = await setup.store.sandboxRuns.get(setup.run.runId);
    assert.deepEqual([releasedRun?.state, releasedRun?.releaseReason, releasedRun?.failureCode], ["released", "failed", "runner_failed"]);
    assert.equal(measurements(), 1);
    assert.equal(((await setup.store.queryProjectAuditEvents(setup.projectId,{limit:100})).items).filter((item) => item.action === "sandbox.failed").length, 1);
    assert.equal((await setup.store.queryProjectAlerts(setup.projectId,{view:"active",limit:50})).items.filter((item) => item.type === "sandbox_failure" && item.metricValue === 1).length, 1);
    assert.equal((await setup.services.notifications.list(setup.userId)).filter((item) => item.type === "project_alert").length, 1);
  });
});

async function projectSetup(providerClient?: OpenAICompatibleClient) {
  const store = createLocalInMemoryProductStore();
  const services = createApplicationServices({ store, dataRoot: "/tmp/agentsmith-failure-alerts", builtinAdminPassword: "admin-password", ...(providerClient ? { providerClient } : {}) });
  const { user } = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(user.id, { name: "Failure alerts" });
  const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Failure alerts" });
  return { store, services, userId: user.id, workspaceId: workspace.id, projectId: project.id, project };
}

async function createEndpoint(setup: Awaited<ReturnType<typeof projectSetup>>, secret: string) {
  const credential = await setup.services.credentials.create(setup.userId, setup.projectId, { name: "Provider", baseUrl: "https://provider.example.test/v1", secret });
  return setup.services.endpoints.createEndpoint(setup.userId, setup.projectId, { name: "Provider", protocol: "openai_chat_completions", baseUrl: credential.baseUrl, model: "model", credentialId: credential.id, capabilities: ["text"], requestTimeoutSecs: 30 });
}

async function sandboxSetup(secret: string) {
  const setup = await projectSetup();
  const timestamp = new Date().toISOString();
  const run = {...sandboxRun(setup.workspaceId, setup.projectId, setup.project.rootPath, timestamp),startedByUserId:setup.userId};
  const task: PersistedAgentTask = {
    id: run.taskId,
    workspaceId: setup.workspaceId,
    projectId: setup.projectId,
    endpointId: "endpoint-sandbox-alert",
    fileLibraryId: `library-${run.taskId}`,
    prompt: `sandbox failed with ${secret}`,title:"Sandbox alert",createdByUserId:setup.userId,agentContext:"",
    currentRunId: run.runId,archivedAt:null,deletedAt:null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const created = await setup.store.createTaskAtomically({
    task,
    newFileLibrary: {
      id: task.fileLibraryId!,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      name: "Sandbox alert",
      rootSubPath: run.fileLibraryRootSubPath,
      lifecycleStatus:"active" as const,
      createdByUserId: setup.userId,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    reserveActive: true, admission:{namespace:"agentsmith",namespaceLimit:100},
    idempotency:{actorId:setup.userId,projectId:task.projectId,operation:"create",key:"fixture-failure-alert",requestHash:"fixture-failure-alert-hash",resourceId:task.id,claimToken:"fixture-failure-alert-claim",now:timestamp,leaseExpiresAt:"2099-01-01T00:00:00.000Z"},
    rejectionPresentation:null,
    rejectedAuditEvent:{id:"audit_fixture_failure_alert_rejected",projectId:task.projectId,actorId:setup.userId,action:"task.create",status:"rejected",resourceKind:"task",resourceId:task.id,detail:{taskId:task.id,trigger:"task_create"},createdAt:timestamp},
    sandboxRun:run
  });
  assert.equal(created.kind, "created");
  const resources = resourcesForRun(run);
  const pod = resources.find((resource) => resource.kind === "Pod");
  assert.ok(pod);
  pod.status = { phase: "Failed" };
  const lifecycle = new SandboxLifecycleService(setup.store, {
    namespace: run.namespace,
    port: new FailureLifecyclePort(resources),
    now: () => new Date(timestamp)
  });
  return { ...setup, task, run, lifecycle };
}

function sandboxRun(workspaceId: string, projectId: string, projectSubPath: string, timestamp: string): PersistedSandboxRunState {
  const taskId = "task-sandbox-alert";
  return {
    workspaceId,
    projectId,
    taskId,
    runId: "run-sandbox-alert",
    namespace: "agentsmith",
    state: "active",
    image: "agentsmith-lite/botified-runner:test",
    pvcName: "agentsmith-lite-files",
    projectSubPath,
    fileLibraryRootSubPath: `libraries/library-${taskId}/home`,
    fileLibraryId:`library-${taskId}`,
    startedByUserId:"owner",
    startedAt:timestamp,
    startupReadyAt:timestamp,
    startupActionDeadlineAt:null,
    botifiedPort: 3099,
    resourceNames: { pod: `asl-${taskId}`, service: `asl-${taskId}`, configMap: `asl-${taskId}-config`, secret: `asl-${taskId}-secret`, serviceAccount: `asl-${taskId}`, networkPolicy: `asl-${taskId}` },
    serviceKeySecretRef: { name: `asl-${taskId}-secret`, key: "BOTIFIED_SERVICE_KEY" },
    directories: { libraryHome: `/tmp/agentsmith-failure-alerts/${projectSubPath}/libraries/library-${taskId}/home`, botified: `/tmp/agentsmith-failure-alerts/${projectSubPath}/tasks/${taskId}/botified` },
    resourceLimits: { cpuRequest: "250m", memoryRequest: "512Mi", cpuLimit: "1", memoryLimit: "1Gi" },
    resourceSnapshot:{cpuRequestMillis:"250",memoryRequestBytes:"536870912",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824"},
    failureCode:null,failureCause:null,fencingToken: 1,cleanupClaimedAt:null,cleanupAttempts:0,lastCleanupAt:null,lastCleanupError:null,
    releaseReason:null,releaseRequestedAt:null,failedAt:null,releasedAt:null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function resourcesForRun(run: PersistedSandboxRunState): KubernetesResource[] {
  return applySandboxReconcileActions({
    observedResources: [],
    actions: reconcileSandboxRuns({ namespace: run.namespace, desiredRuns: [run as SandboxRunState], observedResources: [], now: new Date(run.createdAt) }).actions
  }).observedResources;
}

class FailureLifecyclePort implements SandboxLifecycleKubernetesPort {
  private resources: KubernetesResource[];
  constructor(resources: KubernetesResource[]) { this.resources = structuredClone(resources); }
  async listManagedResources(): Promise<KubernetesResource[]> { return structuredClone(this.resources); }
  async applyResource(): Promise<"applied"> { return "applied"; }
  async deleteResource(ref: KubernetesResourceRef): Promise<"deleted" | "not_found"> {
    const before = this.resources.length;
    this.resources = this.resources.filter((resource) => resource.kind !== ref.kind || resource.metadata?.name !== ref.name || resource.metadata?.namespace !== ref.namespace);
    return this.resources.length === before ? "not_found" : "deleted";
  }
}

function failNextAudit(store: ReturnType<typeof createLocalInMemoryProductStore>, predicate: (event: ProjectAuditEvent) => boolean): void {
  const append = store.appendProjectAuditEvent.bind(store);
  let failed = false;
  store.appendProjectAuditEvent = async (event) => {
    if (!failed && predicate(event)) {
      failed = true;
      throw new Error("audit append unavailable");
    }
    await append(event);
  };
}

function failNextSandboxRunFailure(store: ReturnType<typeof createLocalInMemoryProductStore>): void {
  const fail = store.failSandboxRun.bind(store);
  let failed = false;
  store.failSandboxRun = async (input) => {
    if (!failed && input.auditEvent.action === "sandbox.failed") {
      failed = true;
      throw new Error("audit append unavailable");
    }
    return fail(input);
  };
}

function countMeasurements(store: ReturnType<typeof createLocalInMemoryProductStore>): () => number {
  const measure = store.measureProjectAlertRule.bind(store);
  let count = 0;
  store.measureProjectAlertRule = async (input) => {
    count += 1;
    return measure(input);
  };
  return () => count;
}
