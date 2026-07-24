import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type { CreateEndpointInput } from "../../packages/contracts/src/api.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import type { OpenAICompatibleClient } from "../../packages/openai-compatible-client/src/index.js";

describe("endpoint deletion", () => {
  it("keeps provider settlements while clearing their deleted endpoint binding", async () => {
    const { services, store, userId, projectId, credentialId } = await setup();
    const endpoint = await services.endpoints.createEndpoint(userId, projectId, endpointInput("Historical", credentialId));
    const timestamp = "2026-07-12T12:00:00.000Z";
    assert.ok(await store.reserveProjectProviderSettlement({
      id: "settlement_endpoint_history",
      projectId,
      taskId: null,
      endpointId: endpoint.id,
      reservedTokens: 0,
      reservedCost: 0,
      reservedAt: timestamp,
      expiresAt: "2026-07-12T12:01:00.000Z"
    }));
    await store.markProjectProviderSettlementDispatched("settlement_endpoint_history", timestamp);
    await store.markProjectProviderSettlementDelivered("settlement_endpoint_history", timestamp);
    await store.settleProjectProviderSettlement("settlement_endpoint_history", { tokens: 7, cost: 0.01 }, timestamp);
    await store.upsertActiveProjectAlert({ id: "alert_endpoint_history_generic", projectId, type: "endpoint_failure", status: "active", deliveryStatus: "not_configured", endpointId: null, createdAt: timestamp, updatedAt: timestamp, resolvedAt: null, dismissedAt: null });
    const scopedRule = await store.createProjectAlertRule({ id: "rule_endpoint_history_scoped", projectId, name: "Endpoint failure", alertType: "endpoint_failure", metric: "failure_count", condition: "greater_than_or_equal", threshold: 1, windowSeconds: 3600, scope: { kind: "endpoint", endpointId: endpoint.id }, enabled: true, createdAt: timestamp, updatedAt: timestamp });
    assert.ok(scopedRule);
    await store.upsertActiveProjectAlert({ id: "alert_endpoint_history_scoped", projectId, type: "endpoint_failure", status: "active", deliveryStatus: "not_configured", ruleId: scopedRule.id, endpointId: endpoint.id, createdAt: timestamp, updatedAt: timestamp, resolvedAt: null, dismissedAt: null });

    await services.endpoints.deleteEndpoint(userId, projectId, endpoint.id);

    assert.equal(await store.findEndpoint(endpoint.id), null);
    assert.equal((await store.listSettledProjectProviderSettlements(projectId, "2026-07-01T00:00:00.000Z")).find((item) => item.id === "settlement_endpoint_history")?.endpointId, null);
    assert.equal((await store.listProjectAlertRules(projectId)).some((rule) => rule.id === scopedRule.id), false);
    const alerts = [...(await store.queryProjectAlerts(projectId,{view:"active",limit:50})).items,...(await store.queryProjectAlerts(projectId,{view:"history",limit:50})).items];
    assert.equal(alerts.find((alert) => alert.id === "alert_endpoint_history_generic")?.status, "active");
    assert.deepEqual(
      alerts.filter((alert) => alert.id === "alert_endpoint_history_scoped").map((alert) => [alert.status, alert.ruleId, alert.endpointId, Boolean(alert.resolvedAt)]),
      [["resolved", null, null, true]]
    );
  });

  it("returns a 409 product conflict without unlinking anything when a task references the endpoint", async () => {
    const { services, store, userId, projectId, credentialId } = await setup();
    const endpoint = await services.endpoints.createEndpoint(userId, projectId, endpointInput("Task endpoint", credentialId));
    const timestamp = "2026-07-12T12:00:00.000Z";
    const task = await services.tasks.createTask(userId, projectId, {
      prompt: "Keep endpoint",
      endpointId: endpoint.id,
      fileLibrary: { mode: "create_new", name: "Endpoint reference" }
    });

    await assert.rejects(
      () => services.endpoints.deleteEndpoint(userId, projectId, endpoint.id),
      (error: unknown) => isConflict(error, "Endpoint cannot be deleted while tasks reference it")
    );

    assert.equal((await store.findEndpoint(endpoint.id))?.id, endpoint.id);

    await services.tasks.deleteTask(userId, task.task.id);
    await services.endpoints.deleteEndpoint(userId, projectId, endpoint.id);
    assert.equal(await store.findEndpoint(endpoint.id), null);
  });

  it("replays a successful deletion without returning not found or duplicating audit", async () => {
    const { services, store, userId, projectId, credentialId } = await setup();
    const endpoint = await services.endpoints.createEndpoint(userId, projectId, endpointInput("Replay deletion", credentialId));

    await services.endpoints.deleteEndpoint(userId, projectId, endpoint.id, "endpoint-delete-key");
    await services.endpoints.deleteEndpoint(userId, projectId, endpoint.id, "endpoint-delete-key");

    assert.equal(await store.findEndpoint(endpoint.id), null);
    assert.equal(((await store.queryProjectAuditEvents(projectId,{limit:100})).items).filter((event) => event.action === "endpoint.delete" && event.resourceId === endpoint.id).length, 1);
  });

  it("retries Task-owned filesystem cleanup before releasing Library and endpoint references",async()=>{
    const dataRoot=await mkdtemp(path.join(tmpdir(),"agentsmith-lite-task-delete-"));
    try{
      const {services,store,userId,projectId,credentialId}=await setup(dataRoot);
      const endpoint=await services.endpoints.createEndpoint(userId,projectId,endpointInput("Retry cleanup",credentialId));
      const created=await services.tasks.createTask(userId,projectId,{
        prompt:"Delete retry",
        endpointId:endpoint.id,
        fileLibrary:{mode:"create_new",name:"Retry files"}
      });
      const project=await store.findProject(projectId);
      const library=await store.findFileLibrary(created.task.fileLibraryId);
      assert.ok(project&&library);
      const artifactPath=path.join(dataRoot,project.rootPath,library.rootSubPath,"workspace",".artifacts",created.task.id);
      const userFile=path.join(dataRoot,project.rootPath,library.rootSubPath,"workspace","keep.txt");
      await mkdir(path.join(artifactPath,"nested"),{recursive:true});
      await writeFile(path.join(artifactPath,"nested","generated.bin"),"remove-these-bytes");
      await writeFile(userFile,"keep");
      await store.setProjectFileBytes(projectId,22,"2026-07-23T00:00:00.000Z");
      const purge=store.purgeDeletedTaskData.bind(store);
      let failPurge=true;
      store.purgeDeletedTaskData=async(...args)=>{
        if(failPurge){failPurge=false;return false;}
        return purge(...args);
      };

      await assert.rejects(()=>services.tasks.deleteTask(userId,created.task.id,"delete-fails"));
      const deleting=await store.findTask(created.task.id);
      assert.equal(deleting?.deletedAt===null,false);
      assert.equal(deleting?.fileLibraryId,library.id);
      assert.equal((await store.findTaskBoundToFileLibrary(library.id)).kind,"bound");
      assert.equal(await store.deleteEndpoint(endpoint.id),"referenced_by_tasks");
      await assert.rejects(access(artifactPath));
      assert.equal(await readFile(userFile,"utf8"),"keep");
      assert.equal((await store.findProjectResourceUsage(projectId))?.projectFileBytes,4);
      await assert.rejects(
        ()=>services.tasks.editTask(userId,created.task.id,"Cannot edit while deleting","edit-deleting"),
        (error:unknown)=>error instanceof ProductError&&error.statusCode===404
      );

      await services.tasks.deleteTask(userId,created.task.id,"delete-retry");
      assert.deepEqual(await services.tasks.deleteTask(userId,created.task.id,"delete-retry"),{deleted:true,taskId:created.task.id});
      assert.equal(await store.findTask(created.task.id),null);
      assert.equal(((await store.queryProjectAuditEvents(projectId,{limit:100})).items).filter((event)=>event.action==="task.delete"&&event.resourceId===created.task.id).length,1);
      assert.equal(await store.deleteFileLibraryIfUnbound(projectId,library.id),"deleted");
      assert.equal(await store.deleteEndpoint(endpoint.id),"deleted");
    }finally{
      await rm(dataRoot,{recursive:true,force:true});
    }
  });

  it("rejects a symlinked Task artifact path without deleting its external target and retries safely",async()=>{
    const dataRoot=await mkdtemp(path.join(tmpdir(),"agentsmith-lite-task-artifact-symlink-"));
    try{
      const {services,store,userId,projectId,credentialId}=await setup(dataRoot);
      const endpoint=await services.endpoints.createEndpoint(userId,projectId,endpointInput("Symlink cleanup",credentialId));
      const created=await services.tasks.createTask(userId,projectId,{
        prompt:"Reject unsafe artifact cleanup",
        endpointId:endpoint.id,
        fileLibrary:{mode:"create_new",name:"Symlink files"}
      });
      const project=await store.findProject(projectId);
      const library=await store.findFileLibrary(created.task.fileLibraryId);
      assert.ok(project&&library);
      const workspace=path.join(dataRoot,project.rootPath,library.rootSubPath,"workspace");
      const artifactsRoot=path.join(workspace,".artifacts");
      const outsideRoot=path.join(dataRoot,"outside-task-artifacts");
      const marker=path.join(outsideRoot,created.task.id,"marker");
      await rm(artifactsRoot,{recursive:true,force:true});
      await mkdir(path.dirname(marker),{recursive:true});
      await writeFile(marker,"must remain");
      await symlink(path.relative(workspace,outsideRoot),artifactsRoot,"dir");

      await assert.rejects(
        ()=>services.tasks.deleteTask(userId,created.task.id,"delete-symlink"),
        (error:unknown)=>error instanceof ProductError&&error.statusCode===409&&error.code==="task_artifact_path_invalid"
      );
      assert.equal(await readFile(marker,"utf8"),"must remain");
      assert.ok((await store.findTask(created.task.id))?.deletedAt);

      await rm(artifactsRoot,{force:true});
      await mkdir(path.join(artifactsRoot,created.task.id),{recursive:true});
      await services.tasks.deleteTask(userId,created.task.id,"delete-symlink-retry");

      assert.equal(await store.findTask(created.task.id),null);
      assert.equal(await readFile(marker,"utf8"),"must remain");
    }finally{
      await rm(dataRoot,{recursive:true,force:true});
    }
  });
});

async function setup(dataRoot="/tmp/agentsmith-lite-endpoint-deletion") {
  const store = createLocalInMemoryProductStore();
  const services = createApplicationServices({
    store,
    dataRoot,
    builtinAdminPassword: "admin-password",
    providerClient: healthyProvider
  });
  const { user } = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(user.id, { name: "Endpoint deletion" });
  const project = await services.workspaces.createProject(user.id, workspace.id, { name: "History" });
  const credential = await services.credentials.create(user.id, project.id, {
    name: "Provider",
    baseUrl: "https://models.example.test/v1",
    secret: "endpoint-deletion-secret"
  });
  return { services, store, userId: user.id, workspaceId: workspace.id, projectId: project.id, credentialId: credential.id };
}

function endpointInput(name: string, credentialId: string): CreateEndpointInput {
  return {
    name,
    protocol: "openai_chat_completions" as const,
    baseUrl: "https://models.example.test/v1",
    model: "model",
    credentialId,
    capabilities: ["text", "tool_calls"],
    requestTimeoutSecs: 30
  };
}

function isConflict(error: unknown, message: string): boolean {
  return error instanceof ProductError && error.statusCode === 409 && error.message === message;
}

const healthyProvider: OpenAICompatibleClient = {
  async validateEndpoint() {
    return { status: "healthy" };
  },
  async completeChat() {
    throw new Error("not used");
  }
};
