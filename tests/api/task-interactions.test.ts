import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createTestApiServer as createRawApiServer, type TestApiServerOptions as ApiServerOptions, type RunningApiServer } from "../../packages/api-entry-node/src/server.js";
import {
  type BotifiedAbortResult,
  type BotifiedMessageInput,
  type BotifiedMessageResult,
  type BotifiedRuntimeHttpClient,
  type BotifiedLlmTextPreviewOptions,
  type BotifiedTimelineReadResult,
  type BotifiedUploadFileInput,
  type BotifiedUploadFileResult
} from "../../packages/ports/src/botified.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { SandboxLifecycleService } from "../../packages/application/src/sandboxLifecycleService.js";
import type { KubernetesResource } from "../../packages/contracts/src/api.js";
import type { KubernetesResourceRef } from "../../packages/sandbox-controller/src/kubernetesPort.js";
import type { PersistedAgentTask, PersistedSandboxRunState } from "../../packages/ports/src/store.js";
import { WebSocket } from "ws";

const validProductionSessionSecret = "production-session-secret-32-chars";
const createApiServer = (options: ApiServerOptions) => createRawApiServer({
  ...options,
  providerClient: {
    async validateEndpoint() { return { status: "healthy" as const }; },
    async completeChat() { throw new Error("not used"); }
  }
});

describe("task interactions API", () => {
  let api: RunningApiServer | undefined;
  let terminalUpstream: net.Server | undefined;
  const terminalUpstreamSockets=new Set<net.Socket>();
  let dataRoot = "";

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-task-api-"));
  });

  afterEach(async () => {
    if (terminalUpstream) {
      for (const client of terminalUpstreamSockets) client.destroy();
      await new Promise<void>((resolve) => terminalUpstream!.close(() => resolve()));
      terminalUpstream = undefined;
      terminalUpstreamSockets.clear();
    }
    await api?.close();
    api = undefined;
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("returns and downloads server-projected artifacts without UI-facing Botified routes or secrets", async () => {
    const store = createLocalInMemoryProductStore();
    const artifactBytes = new TextEncoder().encode("api artifact bytes");
    const botified = new FakeBotifiedClient([
      {
        status: "ok",
        events: [
          {
            version: "botified.timeline.v1",
            cursor: "evt_test_2",
            seq: 2,
            time: "2026-07-11T00:00:00.000Z",
            session_id: "s1",
            type: "file.published",
            trace: { cycle_id: "cycle-1" },
            item: { id: "f1", type: "file", status: "available" },
            data: {
              file_id: "f1",
              filename: "../bad/报告\"\r\n.txt",
              mime_type: "text/markdown",
              size_bytes: artifactBytes.byteLength,
              sha256: "6c839ab9cab51908aff7e97713dfeaf25eec58eb99b3ed52b31dfedf4b0699d3",
              download_url: "http://botified.internal/v1/files/f1?service_key=api-service-key"
            }
          }
        ],
        nextCursor: "evt_test_2",
        historyBoundary: "start"
      }
    ]);
    botified.downloads.f1 = artifactBytes;
    api = await createApiServer({
      port: 0,
      dataRoot,
      builtinAdminPassword: "admin-password", sandboxNamespaceLimit: 100,
      botifiedClient: botified,
      botifiedServiceKeyFactory: ({taskId}) => taskId,
      store
    });
    const auth = await createProjectWithEndpoint(api.baseUrl);

    const createdTask = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, {
      prompt: "make notes",
      endpointId: auth.endpointId,
      fileLibrary:{mode:"create_new",name:"Task files"}
    });
    assert.equal("startDeliveryKey" in createdTask, false);
    assert.equal("startReceipt" in createdTask, false);
    const task=createdTask.task;
    const stored = await store.findTask(task.id as string);
    assert.ok(stored);
    await makeTaskRunActive(store, stored, "http://botified.internal");
    const identityBatches:string[][]=[];
    const findIdentities=store.findProjectMembershipIdentities.bind(store);
    store.findProjectMembershipIdentities=async(projectId,userIds)=>{
      identityBatches.push(userIds);
      return findIdentities(projectId,userIds);
    };
    const interactions = await auth.requestJson("GET", `/api/v1/tasks/${task.id}/interactions`);
    const artifactPage = await auth.requestJson("GET", `/api/v1/tasks/${task.id}/artifacts`);
    const artifacts=artifactPage.items;
    const leakedJson = JSON.stringify({ interactions, artifactPage });

    assert.equal(interactions.items.some((item: { kind:string; artifactId?:string }) => item.kind === "file" && item.artifactId === artifacts[0].id), true);
    assert.equal(task.prompt, "make notes");
    assert.deepEqual(artifacts.map((artifact: { name: string; bytes: number; sha256?: string }) => [
      artifact.name,
      artifact.bytes,
      artifact.sha256
    ]), [["报告\".txt", artifactBytes.byteLength, "6c839ab9cab51908aff7e97713dfeaf25eec58eb99b3ed52b31dfedf4b0699d3"]]);
    assert.equal("fileId" in artifacts[0], false);
    assert.equal(identityBatches.length,1);
    assert.deepEqual(identityBatches[0],[...new Set(identityBatches[0])]);
    assert.ok(identityBatches[0].length>0);
    assert.equal(botified.readTimelineCalls[0]?.serviceKey, task.id);
    assert.equal(botified.downloadFileCalls[0]?.serviceKey, task.id);
    assert.doesNotMatch(leakedJson, /api-service-key|botified\.internal|download_url|\/v1\/files/);

    const anonymousDownload = await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/artifacts/${artifacts[0].id}/download`);
    assert.equal(anonymousDownload.status, 401);

    const download = await auth.request("GET", `/api/v1/tasks/${task.id}/artifacts/${artifacts[0].id}/download`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "text/plain");
    assert.equal(download.headers.get("content-length"), String(artifactBytes.byteLength));
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      download.headers.get("content-disposition"),
      "attachment; filename=\"___.txt\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A_.txt"
    );
    const headerFilename = /^attachment; filename="([^"]+)"(?:; filename\*=UTF-8''[^;]+)?$/.exec(download.headers.get("content-disposition") ?? "")?.[1] ?? "";
    assert.doesNotMatch(headerFilename, /[\r\n\\"/\u0080-\uffff]/);
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), artifactBytes);
    const downloadHeaders: string[] = [];
    download.headers.forEach((value, key) => downloadHeaders.push(`${key}: ${value}`));
    assert.doesNotMatch(JSON.stringify(downloadHeaders), /api-service-key|botified\.internal|download_url|\/v1\/files/);
  });

  it("keeps each Task on its own stable Botified session", async () => {
    const store = createLocalInMemoryProductStore();
    const botified = new FakeBotifiedClient([]);
    api = await createApiServer({
      port: 0,
      dataRoot,
      builtinAdminPassword: "admin-password", sandboxNamespaceLimit: 100,
      botifiedClient: botified,
      botifiedServiceKeyFactory: ({ taskId }) => taskId,
      store
    });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const firstCreated = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, {
      prompt: "first task",
      endpointId: auth.endpointId,
      fileLibrary: { mode: "create_new", name: "First files" }
    });
    const secondCreated = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, {
      prompt: "second task",
      endpointId: auth.endpointId,
      fileLibrary: { mode: "create_new", name: "Second files" }
    });
    const first = await store.findTask(firstCreated.task.id as string);
    const second = await store.findTask(secondCreated.task.id as string);
    assert.ok(first);
    assert.ok(second);
    await makeTaskRunActive(store, first, "http://botified.internal");
    await makeTaskRunActive(store, second, "http://botified.internal");

    await auth.requestJson("GET", `/api/v1/tasks/${first.id}/interactions`);
    await auth.requestJson("GET", `/api/v1/tasks/${second.id}/interactions`);

    assert.deepEqual(botified.readTimelineCalls.map(({ serviceKey }) => serviceKey), [first.id, second.id]);
    assert.notEqual(first.id, second.id);
  });

  it("fails the fenced Run when Botified returns another Task session", async () => {
    const store = createLocalInMemoryProductStore();
    const botified = new FakeBotifiedClient([{
      status: "ok",
      events: [{
        version: "botified.timeline.v1",
        cursor: "evt_wrong_1",
        seq: 1,
        time: "2026-07-23T00:00:00.000Z",
        session_id: "wrong-task",
        type: "assistant_message.completed",
        trace: { cycle_id: "cycle-wrong" },
        item: { id: "assistant-wrong", type: "assistant_message", status: "completed" },
        data: { text: "wrong session" }
      }],
      nextCursor: "evt_wrong_1"
    }]);
    botified.timelineSessionId = "wrong-task";
    api = await createApiServer({
      port: 0,
      dataRoot,
      builtinAdminPassword: "admin-password", sandboxNamespaceLimit: 100,
      botifiedClient: botified,
      botifiedServiceKeyFactory: ({ taskId }) => taskId,
      store
    });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const created = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, {
      prompt: "session fence",
      endpointId: auth.endpointId,
      fileLibrary: { mode: "create_new", name: "Session fence" }
    });
    const task = await store.findTask(created.task.id as string);
    assert.ok(task);
    await makeTaskRunActive(store, task, "http://botified.internal");

    const firstResponse = await auth.request("GET", `/api/v1/tasks/${task.id}/interactions`);
    assert.equal(firstResponse.status, 409);
    assert.deepEqual(await firstResponse.json(), {
      error: "Botified timeline session identity mismatch",
      code: "botified_session_mismatch"
    });

    const run = await store.sandboxRuns.get((await store.findTask(task.id))!.currentRunId!);
    assert.equal(run?.state, "failed");
    assert.equal(run?.releaseReason, "failed");
    assert.equal(run?.failureCode, "runtime_unreachable");
    const failedAudits = ((await store.queryProjectAuditEvents(auth.projectId,{limit:100})).items)
      .filter((event) => event.action === "sandbox.failed");
    assert.equal(failedAudits.length, 1);
    assert.equal(failedAudits[0]?.detail?.taskId, task.id);
    assert.equal(failedAudits[0]?.detail?.runId, run?.runId);

    const detail = await auth.requestJson("GET", `/api/v1/tasks/${task.id}`);
    assert.equal(detail.sandboxState.state, "failed");
    assert.deepEqual(detail.capabilities, {
      sendMessage: false,
      editQueuedMessage: false,
      abortTurn: false,
      openTerminal: false,
      releaseSandbox: true,
      editTask: false,
      archiveTask: false,
      deleteTask: false
    });

    const secondResponse = await auth.request("GET", `/api/v1/tasks/${task.id}/interactions`);
    assert.equal(secondResponse.status, 200);
    const secondSnapshot = await secondResponse.json() as {
      presentation: {
        sandboxState: typeof detail.sandboxState;
        capabilities: typeof detail.capabilities;
      };
    };
    assert.deepEqual(secondSnapshot.presentation.sandboxState, detail.sandboxState);
    assert.deepEqual(secondSnapshot.presentation.capabilities, detail.capabilities);
    assert.equal((await store.sandboxRuns.get(run!.runId))?.state, "failed");
    assert.equal(
      ((await store.queryProjectAuditEvents(auth.projectId,{limit:100})).items)
        .filter((event) => event.action === "sandbox.failed").length,
      1
    );
  });

  it("fails closed when currentRunId cannot be resolved",async()=>{
    const store=createLocalInMemoryProductStore();
    api=await createApiServer({port:0,dataRoot,builtinAdminPassword:"admin-password", sandboxNamespaceLimit:100,botifiedClient:new FakeBotifiedClient([]),store});
    const auth=await createProjectWithEndpoint(api.baseUrl);
    const created=await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{prompt:"missing run",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Missing run"}});
    const task=await store.findTask(created.task.id as string);
    assert.ok(task);
    await store.updateTask({...task,currentRunId:"run_missing"});

    const detail=await auth.requestJson("GET",`/api/v1/tasks/${task.id}`);

    assert.equal(detail.sandboxState.state,"failed");
    assert.equal(detail.sandboxState.runId,"run_missing");
    assert.deepEqual(detail.capabilities,{sendMessage:false,editQueuedMessage:false,abortTurn:false,openTerminal:false,releaseSandbox:false,editTask:false,archiveTask:false,deleteTask:false});
  });

  it("presents an unreachable active runtime as ready while keeping controls closed",async()=>{
    const store=createLocalInMemoryProductStore();
    const botified=new class extends FakeBotifiedClient{
      override async readState():Promise<never>{throw new Error("Botified runtime unavailable");}
    }([]);
    api=await createApiServer({
      port:0,dataRoot,builtinAdminPassword:"admin-password",sandboxNamespaceLimit:100,
      botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,store
    });
    const auth=await createProjectWithEndpoint(api.baseUrl);
    const created=await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
      prompt:"runtime unavailable",endpointId:auth.endpointId,
      fileLibrary:{mode:"create_new",name:"Runtime unavailable"}
    });
    const task=await store.findTask(created.task.id as string);assert.ok(task);
    await makeTaskRunActive(store,task,"http://botified.internal");

    const active=await auth.requestJson("GET",`/api/v1/tasks/${task.id}/interactions`);
    assert.equal(active.presentation.currentTurn.state,"ready");
    assert.equal(active.runtimeReachability,"unreachable");
    assert.equal(active.presentation.capabilities.sendMessage,false);
    assert.equal(active.presentation.capabilities.abortTurn,false);
    assert.equal(active.presentation.capabilities.openTerminal,false);

    const current=await store.findTask(task.id);assert.ok(current?.currentRunId);
    const run=await store.sandboxRuns.get(current.currentRunId);assert.ok(run);
    assert.ok(await store.sandboxRuns.updateWithFencing(run.runId,run.fencingToken,{
      ...run,state:"starting",startupReadyAt:null,fencingToken:run.fencingToken+1,updatedAt:new Date().toISOString()
    }));
    const starting=await auth.requestJson("GET",`/api/v1/tasks/${task.id}/interactions`);
    assert.equal(starting.presentation.currentTurn.state,"starting");
  });

  it("uses a safe download header for persisted artifact names with path and control characters", async () => {
    const artifactBytes = new TextEncoder().encode("persisted artifact bytes");
    const store = createLocalInMemoryProductStore();
    const botified = new FakeBotifiedClient([{ status: "ok", events: [], nextCursor: "c0" }]);
    api = await createApiServer({
      port: 0,
      dataRoot,
      builtinAdminPassword: "admin-password", sandboxNamespaceLimit: 100,
      botifiedClient: botified,
      botifiedServiceKeyFactory: ({taskId}) => taskId,
      store
    });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const createdTask = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, {
      prompt: "download old artifact",
      endpointId: auth.endpointId,
      fileLibrary:{mode:"create_new",name:"Task files"}
    });
    const task=createdTask.task;
    const artifact = {
      id: "art_header",
      taskId: task.id as string,
      fileId: "f1",
      name: "../bad/报告\"\r\n.txt",
      bytes: artifactBytes.byteLength,
      sha256: createHash("sha256").update(artifactBytes).digest("hex"),
      createdAt: new Date(0).toISOString()
    };
    await store.appendTaskArtifacts([artifact]);
    const project = await store.findProject(auth.projectId);
    assert.ok(project);
    const persistedTask=await store.findTask(task.id as string);assert.ok(persistedTask?.fileLibraryId);
    const library=await store.findFileLibrary(persistedTask.fileLibraryId);assert.ok(library);
    const artifactDir=path.resolve(dataRoot,project.rootPath,library.rootSubPath,"workspace",".artifacts",persistedTask.id);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "art_header--.txt"), artifactBytes);

    const download = await auth.request("GET", `/api/v1/tasks/${task.id}/artifacts/${artifact.id}/download`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/octet-stream");
    assert.equal(download.headers.get("content-length"), String(artifactBytes.byteLength));
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      download.headers.get("content-disposition"),
      "attachment; filename=\"_____.txt\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A___.txt"
    );
    const filename = /^attachment; filename="([^"]+)"(?:; filename\*=UTF-8''[^;]+)?$/.exec(download.headers.get("content-disposition") ?? "")?.[1] ?? "";
    assert.doesNotMatch(filename, /[\r\n\\"/\u0080-\uffff]/);
    assert.doesNotMatch(download.headers.get("content-disposition") ?? "", /api-service-key|botified\.internal|download_url|service_key/);
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), artifactBytes);
  });


  it("aborts only the exact active Run with one Botified call and exposes no Stop route",async()=>{
    const store=createLocalInMemoryProductStore();
    const botified=new FakeBotifiedClient([]);
    api=await createApiServer({
      port:0,dataRoot,builtinAdminPassword:"admin-password",sandboxNamespaceLimit:100,
      botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,store
    });
    const auth=await createProjectWithEndpoint(api.baseUrl);
    const created=await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
      prompt:"abort exact run",endpointId:auth.endpointId,
      fileLibrary:{mode:"create_new",name:"Abort files"}
    });
    const task=await store.findTask(created.task.id as string);assert.ok(task);
    await makeTaskRunActive(store,task,"http://botified.internal");
    const current=await store.findTask(task.id);assert.ok(current?.currentRunId);
    const run=await store.sandboxRuns.get(current.currentRunId);assert.ok(run);
    const ownerMessage=await store.createPendingTaskMessage(
      {id:"message_abort_owner",taskId:task.id,actorId:task.createdByUserId??null,content:"still running",deliveryStatus:"pending",createdAt:new Date().toISOString()},
      {sourceKind:"product",sourceId:"message:message_abort_owner",sourceRevision:0,interaction:{id:"interaction_message_abort_owner",revision:1,taskId:task.id,kind:"user_message",title:"You",body:"still running",contentMode:"full",position:Date.now(),occurredAt:new Date().toISOString(),updatedAt:new Date().toISOString(),actorId:task.createdByUserId??null,status:"pending"}}
    );assert.ok(ownerMessage);
    assert.ok(await store.claimTaskMessage({
      id:ownerMessage.id,taskId:task.id,runId:run.runId,expectedFencingToken:run.fencingToken,
      claimToken:"abort-owner",claimedAt:new Date().toISOString(),leaseExpiresAt:new Date(Date.now()+60_000).toISOString()
    }));
    botified.postMessageCalls.push({
      baseUrl:`http://${run.resourceNames.service}.${run.namespace}.svc.cluster.local:${run.botifiedPort}`,
      serviceKey:task.id,
      message:ownerMessage.content
    });
    const presentation=(await auth.requestJson("GET",`/api/v1/tasks/${task.id}/interactions`)).presentation;
    assert.equal(presentation.currentTurn.state,"running");
    assert.equal(Object.hasOwn(presentation.currentTurn,"turnId"),false);
    assert.equal(presentation.capabilities.abortTurn,true);

    const malformed=await auth.request("POST",`/api/v1/tasks/${task.id}/turn/abort`,{
      expectedRunId:""
    });
    assert.equal(malformed.status,400);
    const missing=await auth.request("POST","/api/v1/tasks/task_missing/turn/abort",{
      expectedRunId:current.currentRunId
    });
    assert.equal(missing.status,404);
    await store.createUser({
      id:"abort_outsider",email:"abort-outsider@example.test",emailVerified:true,passwordHash:"external:oidc",
      createdAt:"2026-07-29T00:00:00.000Z",updatedAt:"2026-07-29T00:00:00.000Z"
    });
    await store.createSession({
      id:"abort-outsider-session",userId:"abort_outsider",csrfToken:"abort-outsider-csrf",
      createdAt:"2026-07-29T00:00:00.000Z",expiresAt:"2999-01-01T00:00:00.000Z"
    });
    const forbidden=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/turn/abort`,{
      method:"POST",
      headers:{
        "content-type":"application/json",
        cookie:"asl_session=abort-outsider-session",
        "x-csrf-token":"abort-outsider-csrf"
      },
      body:JSON.stringify({expectedRunId:current.currentRunId})
    });
    assert.equal(forbidden.status,403);
    assert.equal(
      ((await store.queryProjectAuditEvents(auth.projectId,{limit:100})).items)
        .filter((event)=>event.action==="task.turn.abort").length,
      0
    );

    const stale=await auth.request("POST",`/api/v1/tasks/${task.id}/turn/abort`,{
      expectedRunId:"run_stale"
    });
    assert.equal(stale.status,409);
    assert.equal(botified.abortCalls.length,0);

    const response=await auth.request("POST",`/api/v1/tasks/${task.id}/turn/abort`,{
      expectedRunId:current.currentRunId
    });
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{
      taskId:task.id,runId:current.currentRunId,state:"aborting",queueLength:0
    });
    assert.deepEqual(botified.abortCalls,[{
      baseUrl:`http://${run.resourceNames.service}.${run.namespace}.svc.cluster.local:${run.botifiedPort}`,
      serviceKey:task.id
    }]);

    const inactiveRun={...run,state:"failed" as const,failureCode:"runtime_unreachable" as const,failureCause:"test inactive Run",failedAt:new Date().toISOString(),releaseReason:"failed" as const,releaseRequestedAt:new Date().toISOString(),fencingToken:run.fencingToken+1,updatedAt:new Date().toISOString()};
    assert.ok(await store.sandboxRuns.updateWithFencing(run.runId,run.fencingToken,inactiveRun));
    const inactive=await auth.request("POST",`/api/v1/tasks/${task.id}/turn/abort`,{
      expectedRunId:run.runId
    });
    assert.equal(inactive.status,409);
    assert.equal(botified.abortCalls.length,1);
    const abortAudits=((await store.queryProjectAuditEvents(auth.projectId,{limit:100})).items)
      .filter((event)=>event.action==="task.turn.abort");
    assert.equal(abortAudits.length,3);
    assert.deepEqual(
      abortAudits.map((event)=>({
        actorId:event.actorId,
        projectId:event.projectId,
        status:event.status,
        resourceKind:event.resourceKind,
        resourceId:event.resourceId,
        detail:event.detail
      })).sort((left,right)=>String(left.detail?.runId).localeCompare(String(right.detail?.runId))||left.status.localeCompare(right.status)),
      [
        {actorId:task.createdByUserId,projectId:task.projectId,status:"accepted",resourceKind:"task",resourceId:task.id,detail:{taskId:task.id,runId:run.runId}},
        {actorId:task.createdByUserId,projectId:task.projectId,status:"rejected",resourceKind:"task",resourceId:task.id,detail:{taskId:task.id,runId:run.runId}},
        {actorId:task.createdByUserId,projectId:task.projectId,status:"rejected",resourceKind:"task",resourceId:task.id,detail:{taskId:task.id,runId:"run_stale"}}
      ].sort((left,right)=>String(left.detail.runId).localeCompare(String(right.detail.runId))||left.status.localeCompare(right.status))
    );

    const stopped=await auth.request("POST",`/api/v1/tasks/${task.id}/work/interaction_1/stop`,{
      expectedRunId:current.currentRunId,interactionId:"interaction_1"
    });
    assert.equal(stopped.status,404);
  });

  it("returns 503 for an ambiguous Abort without changing Run authority",async()=>{
    const store=createLocalInMemoryProductStore();
    const botified=new FakeBotifiedClient([]);
    botified.abortError=new TypeError("response lost after dispatch");
    api=await createApiServer({
      port:0,dataRoot,builtinAdminPassword:"admin-password",sandboxNamespaceLimit:100,
      botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,store
    });
    const auth=await createProjectWithEndpoint(api.baseUrl);
    const created=await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
      prompt:"ambiguous abort",endpointId:auth.endpointId,
      fileLibrary:{mode:"create_new",name:"Ambiguous abort files"}
    });
    const task=await store.findTask(created.task.id as string);assert.ok(task);
    await makeTaskRunActive(store,task,"http://botified.internal");
    const current=await store.findTask(task.id);assert.ok(current?.currentRunId);
    const run=await store.sandboxRuns.get(current.currentRunId);assert.ok(run);
    const ownerAt=new Date().toISOString();
    const ownerMessage=await store.createPendingTaskMessage(
      {id:"message_ambiguous_abort_owner",taskId:task.id,actorId:task.createdByUserId??null,content:"still running",deliveryStatus:"pending",createdAt:ownerAt},
      {sourceKind:"product",sourceId:"message:message_ambiguous_abort_owner",sourceRevision:0,interaction:{id:"interaction_message_ambiguous_abort_owner",revision:1,taskId:task.id,kind:"user_message",title:"You",body:"still running",contentMode:"full",position:Date.now(),occurredAt:ownerAt,updatedAt:ownerAt,actorId:task.createdByUserId??null,status:"pending"}}
    );assert.ok(ownerMessage);
    assert.ok(await store.claimTaskMessage({
      id:ownerMessage.id,taskId:task.id,runId:run.runId,expectedFencingToken:run.fencingToken,
      claimToken:"ambiguous-abort-owner",claimedAt:new Date().toISOString(),leaseExpiresAt:new Date(Date.now()+60_000).toISOString()
    }));

    const response=await auth.request("POST",`/api/v1/tasks/${task.id}/turn/abort`,{
      expectedRunId:current.currentRunId
    });
    assert.equal(response.status,503);
    assert.equal((await response.json()).code,"botified_abort_outcome_unknown");
    assert.equal(botified.abortCalls.length,1);
    assert.equal((await store.sandboxRuns.get(current.currentRunId))?.state,"active");
    assert.equal((await store.sandboxRuns.get(current.currentRunId))?.currentLlmMessageId,ownerMessage.id);
    const abortAudits=((await store.queryProjectAuditEvents(auth.projectId,{limit:100})).items)
      .filter((event)=>event.action==="task.turn.abort");
    assert.deepEqual(abortAudits.map((event)=>({
      actorId:event.actorId,
      projectId:event.projectId,
      status:event.status,
      resourceKind:event.resourceKind,
      resourceId:event.resourceId,
      detail:event.detail
    })),[{
      actorId:task.createdByUserId,
      projectId:task.projectId,
      status:"accepted",
      resourceKind:"task",
      resourceId:task.id,
      detail:{taskId:task.id,runId:run.runId}
    }]);

    await createApplicationServices({
      store,dataRoot,builtinAdminPassword:"admin-password",sandboxNamespaceLimit:100,
      botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,
      providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}}
    }).tasks.syncActiveTasksOnce();
    assert.equal(botified.abortCalls.length,1);
  });

  it("keeps an ambiguous message owned and never reposts it after restart",async()=>{
    const store=createLocalInMemoryProductStore();
    const botified=new FakeBotifiedClient([]);
    api=await createApiServer({
      port:0,dataRoot,builtinAdminPassword:"admin-password",sandboxNamespaceLimit:100,
      botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,runtimeTickIntervalMs:60_000,store
    });
    const auth=await createProjectWithEndpoint(api.baseUrl);
    const created=await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
      prompt:"message ambiguity",endpointId:auth.endpointId,
      fileLibrary:{mode:"create_new",name:"Message ambiguity files"}
    });
    const task=await store.findTask(created.task.id as string);assert.ok(task);
    await makeTaskRunActive(store,task,"http://botified.internal");
    botified.postMessageCalls.length=0;
    const timestamp=new Date(Date.now()-120_000).toISOString();
    const pending=await store.createPendingTaskMessage(
      {id:"message_ambiguous",taskId:task.id,actorId:task.createdByUserId??null,content:"run once",claimToken:null,deliveryStatus:"pending",claimedAt:null,leaseExpiresAt:null,safeError:null,createdAt:timestamp,updatedAt:timestamp,deletedAt:null},
      {sourceKind:"product",sourceId:"message:message_ambiguous",sourceRevision:0,interaction:{id:"interaction_message_ambiguous",revision:1,taskId:task.id,kind:"user_message",title:"You",body:"run once",contentMode:"full",position:1,occurredAt:timestamp,updatedAt:timestamp,actorId:task.createdByUserId??null,status:"pending"}}
    );
    assert.ok(pending);
    botified.postMessageError=new TypeError("response lost after dispatch");
    const services=()=>createApplicationServices({
      store,dataRoot,builtinAdminPassword:"admin-password",sandboxNamespaceLimit:100,
      taskDeliveryLeaseMs:1,
      botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,
      providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}}
    });

    await services().tasks.syncActiveTasksOnce();
    assert.equal(botified.postMessageCalls.length,1);
    assert.equal((await store.findTaskMessage(pending.id))?.deliveryStatus,"dispatching");
    const ownedTask=await store.findTask(task.id);assert.ok(ownedTask?.currentRunId);
    assert.equal((await store.sandboxRuns.get(ownedTask.currentRunId))?.currentLlmMessageId,pending.id);
    await services().tasks.syncActiveTasksOnce();
    assert.equal(botified.postMessageCalls.length,1);
    await new Promise((resolve)=>setTimeout(resolve,2));
    botified.forceIdle=true;
    await services().tasks.syncActiveTasksOnce();
    assert.equal((await store.findTaskMessage(pending.id))?.deliveryStatus,"failed");
    assert.equal((await store.sandboxRuns.get(ownedTask.currentRunId))?.currentLlmMessageId,null);
    assert.equal(botified.postMessageCalls.length,1);
  });

  it("corrects an ambiguous message from canonical acceptance without reposting",async()=>{
    const store=createLocalInMemoryProductStore();
    const botified=new FakeBotifiedClient([]);
    api=await createApiServer({
      port:0,dataRoot,builtinAdminPassword:"admin-password",sandboxNamespaceLimit:100,
      botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,runtimeTickIntervalMs:60_000,store
    });
    const auth=await createProjectWithEndpoint(api.baseUrl);
    const created=await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
      prompt:"canonical ambiguity",endpointId:auth.endpointId,
      fileLibrary:{mode:"create_new",name:"Canonical ambiguity files"}
    });
    const task=await store.findTask(created.task.id as string);assert.ok(task);
    await makeTaskRunActive(store,task,"http://botified.internal");
    botified.postMessageCalls.length=0;
    const timestamp=new Date(Date.now()-120_000).toISOString();
    const pending=await store.createPendingTaskMessage(
      {id:"message_canonical_ambiguous",taskId:task.id,actorId:task.createdByUserId??null,content:"run once",claimToken:null,deliveryStatus:"pending",claimedAt:null,leaseExpiresAt:null,safeError:null,createdAt:timestamp,updatedAt:timestamp,deletedAt:null},
      {sourceKind:"product",sourceId:"message:message_canonical_ambiguous",sourceRevision:0,interaction:{id:"interaction_message_canonical_ambiguous",revision:1,taskId:task.id,kind:"user_message",title:"You",body:"run once",contentMode:"full",position:1,occurredAt:timestamp,updatedAt:timestamp,actorId:task.createdByUserId??null,status:"pending"}}
    );assert.ok(pending);
    botified.postMessageError=new TypeError("response lost after dispatch");
    const services=createApplicationServices({
      store,dataRoot,builtinAdminPassword:"admin-password",sandboxNamespaceLimit:100,
      botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,
      providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}}
    });
    await services.tasks.syncActiveTasksOnce();
    botified.forceIdle=true;
    botified.runtimeTimelineCursor="evt_proc1_1";
    botified.enqueueTimeline({status:"ok",events:[{
      version:"botified.timeline.v1",cursor:"evt_proc1_1",seq:1,time:new Date().toISOString(),
      session_id:task.id,type:"input.accepted",trace:{cycle_id:"cycle-1"},item:{id:pending.id,type:"input",status:"accepted"},
      data:{input_id:pending.id,source:"user",text:pending.content}
    }],nextCursor:"evt_proc1_1"});
    await services.tasks.syncActiveTasksOnce();
    assert.equal((await store.findTaskMessage(pending.id))?.deliveryStatus,"accepted");
    const active=await store.findTask(task.id);assert.ok(active?.currentRunId);
    assert.equal((await store.sandboxRuns.get(active.currentRunId))?.currentLlmMessageId,null);
    assert.equal(botified.postMessageCalls.length,1);
  });

  it("rejects a second interactive terminal and releases occupancy after an abnormal close", async () => {
    let resolveRevocationCancel!:()=>void;
    const revocationCancel=new Promise<void>((resolve)=>{resolveRevocationCancel=resolve;});
    terminalUpstream = await listenTerminalTcpServer(terminalUpstreamSockets,(socket)=>{
      let input="";
      socket.on("data",(data)=>{
        input+=data.toString("utf8");
        if(input.includes('{"op":"open"}\n'))socket.write('{"op":"ready"}\n');
        if(input.includes('{"op":"cancel"}\n')){
          resolveRevocationCancel();
          socket.end();
        }
      });
    });

    const store = createLocalInMemoryProductStore();
    const botified = new FakeBotifiedClient([]);
    api = await createApiServer({ port:0, dataRoot, publicBaseUrl:"http://agentsmith.test", builtinAdminPassword:"admin-password", sandboxNamespaceLimit:100, botifiedClient:botified, botifiedServiceKeyFactory:({taskId})=>taskId, terminalHostForRun:()=>"127.0.0.1", terminalAccessRecheckMs:20, store });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const created = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, { prompt:"terminal occupancy", endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Task files"} });
    const task = await store.findTask(created.task.id as string); assert.ok(task);
    await makeTaskRunActive(store, task, "http://botified.internal");
    const terminalRunId=(await store.findTask(task.id))?.currentRunId;
    assert.ok(terminalRunId);
    const persistedTerminalRun=await store.sandboxRuns.get(terminalRunId);
    assert.ok(persistedTerminalRun);
    const terminalUrl = `${api.baseUrl.replace(/^http/, "ws")}/api/v1/tasks/${task.id}/terminal/ws?expectedRunId=${encodeURIComponent(terminalRunId)}`;
    const project=await store.findProject(task.projectId);
    assert.ok(project);
    const directServices=createApplicationServices({
      store,dataRoot,builtinAdminPassword:"admin-password",sandboxNamespaceLimit:100,
      botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,
      botifiedBaseUrlForTask:()=>`http://botified-override.invalid:3099`,
      terminalHostForRun:({runId,namespace,serviceName})=>{
        assert.deepEqual({runId,namespace,serviceName},{
          runId:terminalRunId,
          namespace:persistedTerminalRun.namespace,
          serviceName:persistedTerminalRun.resourceNames.service
        });
        return "127.0.0.1";
      },
      providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}}
    });
    const terminalBotifiedStateReads=botified.readStateCalls.length;
    const directFirst=await directServices.tasks.openTaskTerminal(project.ownerUserId,task.id,terminalRunId);
    assert.deepEqual(
      {runId:directFirst.runId,host:directFirst.host,port:directFirst.port,fields:Object.keys(directFirst).sort()},
      {runId:terminalRunId,host:"127.0.0.1",port:3110,fields:["host","occupancyToken","port","runId"]}
    );
    directServices.tasks.closeTaskTerminal(task.id,directFirst.occupancyToken);
    const directReplacement=await directServices.tasks.openTaskTerminal(project.ownerUserId,task.id,terminalRunId);
    directServices.tasks.closeTaskTerminal(task.id,directFirst.occupancyToken);
    await assert.rejects(
      directServices.tasks.openTaskTerminal(project.ownerUserId,task.id,terminalRunId),
      /Task terminal is already open/
    );
    directServices.tasks.closeTaskTerminal(task.id,directReplacement.occupancyToken);
    assert.equal(botified.readStateCalls.length,terminalBotifiedStateReads);
    const exactServices=createApplicationServices({
      store,dataRoot,builtinAdminPassword:"admin-password",sandboxNamespaceLimit:100,
      botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,
      botifiedBaseUrlForTask:()=>`http://botified-override.invalid:3099`,
      providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}}
    });
    const exactTarget=await exactServices.tasks.openTaskTerminal(project.ownerUserId,task.id,terminalRunId);
    const exactRun=await store.sandboxRuns.get(terminalRunId);
    assert.ok(exactRun);
    assert.equal(exactTarget.host,`${exactRun.resourceNames.service}.${exactRun.namespace}.svc.cluster.local`);
    assert.equal(exactTarget.port,3110);
    exactServices.tasks.closeTaskTerminal(task.id,exactTarget.occupancyToken);
    assert.equal(botified.readStateCalls.length,terminalBotifiedStateReads);

    assert.equal((await auth.requestJson("GET", `/api/v1/tasks/${task.id}/interactions`)).presentation.capabilities.openTerminal, true);
    assert.equal(await rejectedWebSocketStatus(terminalUrl,auth.cookie),403);
    const terminalHeaders={cookie:auth.cookie,origin:"http://agentsmith.test"};
    const first = new WebSocket(terminalUrl, { headers:terminalHeaders });
    await once(first, "open");
    assert.equal((await auth.requestJson("GET", `/api/v1/tasks/${task.id}/interactions`)).presentation.capabilities.openTerminal, true);

    const secondStatus = await rejectedWebSocketStatus(terminalUrl, auth.cookie,"http://agentsmith.test");
    assert.equal(secondStatus, 403);
    assert.equal(first.readyState, WebSocket.OPEN);

    const revoked = once(first, "close");
    await store.setWorkspaceLifecycleStatus(auth.workspaceId, "archived", new Date().toISOString());
    const [code, reason] = await within(revoked, 500, "Terminal stayed open after workspace access changed");
    assert.equal(code, 1008);
    assert.equal(String(reason), "Task terminal access changed");
    await within(revocationCancel,500,"Terminal revocation did not cancel the executor session");
    assert.equal((await auth.requestJson("GET", `/api/v1/tasks/${task.id}/interactions`)).presentation.capabilities.openTerminal, false);

    await store.setWorkspaceLifecycleStatus(auth.workspaceId, "active", new Date().toISOString());
    await waitForTerminalCapability(auth, task.id, true);

    const replacement = new WebSocket(terminalUrl, { headers:terminalHeaders });
    await once(replacement, "open");
    const replacementClosed = once(replacement, "close");
    replacement.close();
    await replacementClosed;
  });

  it("bounds executor TCP connect and ready deadlines", async () => {
    {
    const upstreams:DeferredDestroySocket[]=[];
    const store=createLocalInMemoryProductStore();
    api=await createApiServer({
      port:0,
      dataRoot,
      builtinAdminPassword:"admin-password",
      sandboxNamespaceLimit:100,
      botifiedClient:new FakeBotifiedClient([]),
      botifiedServiceKeyFactory:({taskId})=>taskId,
      terminalHostForRun:()=>"executor.invalid",
      terminalSocketFactory:()=>{
        const socket=new DeferredDestroySocket();
        upstreams.push(socket);
        return socket;
      },
      terminalTcpConnectTimeoutMs:20,
      terminalExecutorReadyTimeoutMs:100,
      store
    });
    const auth=await createProjectWithEndpoint(api.baseUrl);
    const created=await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
      prompt:"terminal connect deadline",
      endpointId:auth.endpointId,
      fileLibrary:{mode:"create_new",name:"Connect deadline files"}
    });
    const task=await store.findTask(created.task.id as string);
    assert.ok(task);
    await makeTaskRunActive(store,task,"http://botified.internal");
    const runId=(await store.findTask(task.id))?.currentRunId;
    assert.ok(runId);
    const terminalUrl=`${api.baseUrl.replace(/^http/,"ws")}/api/v1/tasks/${task.id}/terminal/ws?expectedRunId=${encodeURIComponent(runId)}`;
    const client=new WebSocket(terminalUrl,{headers:{cookie:auth.cookie}});
    const messages:string[]=[];
    client.on("message",(data)=>messages.push(String(data)));
    const closed=once(client,"close");
    await within(once(client,"open"),500,"Terminal browser did not open for connect deadline");

    const [code,reason]=await within(closed,500,"Terminal TCP connect deadline did not close the browser");
    assert.equal(code,1011);
    assert.equal(String(reason),"Task terminal connection timed out");
    assert.deepEqual(messages,[JSON.stringify({op:"error",message:"Task terminal upstream connection timed out"})]);
    assert.equal(upstreams.length,1);
    assert.equal(upstreams[0]!.destroyed,true);
    assert.equal(await rejectedWebSocketStatus(terminalUrl,auth.cookie),403);

    const upstreamClosed=once(upstreams[0]!,"close");
    upstreams[0]!.completeDestroy();
    await within(upstreamClosed,500,"Timed-out upstream did not finish closing");
    const replacement=new WebSocket(terminalUrl,{headers:{cookie:auth.cookie}});
    await within(once(replacement,"open"),500,"Replacement was not admitted after timed-out upstream closed");
    assert.equal(upstreams.length,2);
    const replacementClosed=once(replacement,"close");
    replacement.close();
    await within(replacementClosed,500,"Replacement browser did not close");
    const replacementUpstreamClosed=once(upstreams[1]!,"close");
    upstreams[1]!.completeDestroy();
    await within(replacementUpstreamClosed,500,"Replacement upstream did not finish closing");
    await api.close();
    api=undefined;
    }

    {
    let resolveOpenFrame!:(frame:string)=>void;
    const openFrame=new Promise<string>((resolve)=>{resolveOpenFrame=resolve;});
    terminalUpstream=await listenTerminalTcpServer(terminalUpstreamSockets,(socket)=>{
      socket.once("data",(data)=>resolveOpenFrame(data.toString("utf8")));
    });
    const store=createLocalInMemoryProductStore();
    api=await createApiServer({
      port:0,
      dataRoot,
      builtinAdminPassword:"admin-password",
      sandboxNamespaceLimit:100,
      botifiedClient:new FakeBotifiedClient([]),
      botifiedServiceKeyFactory:({taskId})=>taskId,
      terminalHostForRun:()=>"127.0.0.1",
      terminalTcpConnectTimeoutMs:100,
      terminalExecutorReadyTimeoutMs:20,
      store
    });
    const auth=await createProjectWithEndpoint(api.baseUrl);
    const created=await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
      prompt:"terminal ready deadline",
      endpointId:auth.endpointId,
      fileLibrary:{mode:"create_new",name:"Ready deadline files"}
    });
    const task=await store.findTask(created.task.id as string);
    assert.ok(task);
    await makeTaskRunActive(store,task,"http://botified.internal");
    const runId=(await store.findTask(task.id))?.currentRunId;
    assert.ok(runId);
    const client=new WebSocket(
      `${api.baseUrl.replace(/^http/,"ws")}/api/v1/tasks/${task.id}/terminal/ws?expectedRunId=${encodeURIComponent(runId)}`,
      {headers:{cookie:auth.cookie}}
    );
    const messages:string[]=[];
    client.on("message",(data)=>messages.push(String(data)));
    const closed=once(client,"close");
    await once(client,"open");

    assert.equal(await within(openFrame,500,"Executor did not receive the open frame"),'{"op":"open"}\n');
    const [code,reason]=await within(closed,500,"Executor ready deadline did not close the browser");
    assert.equal(code,1011);
    assert.equal(String(reason),"Task terminal executor was not ready");
    assert.deepEqual(messages,[JSON.stringify({op:"error",message:"Task terminal executor ready timed out"})]);
    await within(
      Promise.all([...terminalUpstreamSockets].map((socket)=>once(socket,"close"))),
      500,
      "Executor TCP connection stayed open after its ready deadline"
    );
    }
  });

  it("destroys a pre-connect upstream without queued cancel and fences replacement until close", async () => {
    const upstreams:DeferredDestroySocket[]=[];
    const store=createLocalInMemoryProductStore();
    api=await createApiServer({
      port:0,
      dataRoot,
      builtinAdminPassword:"admin-password",
      sandboxNamespaceLimit:100,
      botifiedClient:new FakeBotifiedClient([]),
      botifiedServiceKeyFactory:({taskId})=>taskId,
      terminalHostForRun:()=>"executor.invalid",
      terminalSocketFactory:()=>{
        const socket=new DeferredDestroySocket();
        upstreams.push(socket);
        return socket;
      },
      terminalTcpConnectTimeoutMs:500,
      terminalExecutorReadyTimeoutMs:500,
      store
    });
    const auth=await createProjectWithEndpoint(api.baseUrl);
    const created=await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
      prompt:"terminal stale connect",
      endpointId:auth.endpointId,
      fileLibrary:{mode:"create_new",name:"Stale connect files"}
    });
    const task=await store.findTask(created.task.id as string);
    assert.ok(task);
    await makeTaskRunActive(store,task,"http://botified.internal");
    const runId=(await store.findTask(task.id))?.currentRunId;
    assert.ok(runId);
    const terminalUrl=`${api.baseUrl.replace(/^http/,"ws")}/api/v1/tasks/${task.id}/terminal/ws?expectedRunId=${encodeURIComponent(runId)}`;
    const client=new WebSocket(terminalUrl,{headers:{cookie:auth.cookie}});
    await within(once(client,"open"),500,"Terminal browser did not open before pre-connect close");
    assert.equal(upstreams.length,1);
    const browserClosed=once(client,"close");
    client.close();
    await within(browserClosed,500,"Terminal browser did not close before upstream connect");

    assert.equal(upstreams[0]!.destroyed,true);
    assert.deepEqual(upstreams[0]!.writes,[]);
    assert.equal(await rejectedWebSocketStatus(terminalUrl,auth.cookie),403);
    const upstreamClosed=once(upstreams[0]!,"close");
    upstreams[0]!.completeDestroy();
    await within(upstreamClosed,500,"Pre-connect upstream did not finish closing");

    const replacement=new WebSocket(terminalUrl,{headers:{cookie:auth.cookie}});
    await within(once(replacement,"open"),500,"Replacement was not admitted after pre-connect upstream closed");
    assert.equal(upstreams.length,2);
    const replacementClosed=once(replacement,"close");
    replacement.close();
    await within(replacementClosed,500,"Replacement browser did not close");
    const replacementUpstreamClosed=once(upstreams[1]!,"close");
    upstreams[1]!.completeDestroy();
    await within(replacementUpstreamClosed,500,"Replacement upstream did not finish closing");
  });

  it("rejects exact terminal Run ownership mismatch before deriving its host", async () => {
    const store=createLocalInMemoryProductStore();
    const bootstrap=await createApiServer({
      port:0,
      dataRoot,
      builtinAdminPassword:"admin-password",
      sandboxNamespaceLimit:100,
      botifiedClient:new FakeBotifiedClient([]),
      botifiedServiceKeyFactory:({taskId})=>taskId,
      store
    });
    api=bootstrap;
    const auth=await createProjectWithEndpoint(api.baseUrl);
    const created=await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
      prompt:"terminal exact ownership",
      endpointId:auth.endpointId,
      fileLibrary:{mode:"create_new",name:"Exact ownership files"}
    });
    const task=await store.findTask(created.task.id as string);
    assert.ok(task);
    await makeTaskRunActive(store,task,"http://botified.internal");
    const runId=(await store.findTask(task.id))?.currentRunId;
    assert.ok(runId);
    const getRun=store.sandboxRuns.get.bind(store.sandboxRuns);
    store.sandboxRuns.get=async(candidateRunId)=>{
      const run=await getRun(candidateRunId);
      return run?{...run,workspaceId:"workspace_mismatched"}:null;
    };
    let hostDerived=false;
    const services=createApplicationServices({
      store,
      dataRoot,
      builtinAdminPassword:"admin-password",
      sandboxNamespaceLimit:100,
      botifiedClient:new FakeBotifiedClient([]),
      botifiedServiceKeyFactory:({taskId})=>taskId,
      terminalHostForRun:()=>{
        hostDerived=true;
        return "127.0.0.1";
      },
      providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}}
    });

    await assert.rejects(
      services.tasks.openTaskTerminal(task.createdByUserId!,task.id,runId),
      /Task Sandbox Run changed/
    );
    assert.equal(hostDerived,false);
  });

  it("closes a terminal connection when the canonical Task changes to another active Run", async () => {
    terminalUpstream = await listenTerminalTcpServer(terminalUpstreamSockets,(socket)=>{
      socket.once("data",()=>socket.write('{"op":"ready"}\n'));
    });

    const store = createLocalInMemoryProductStore();
    api = await createApiServer({
      port:0,
      dataRoot,
      builtinAdminPassword:"admin-password",
      sandboxNamespaceLimit:100,
      botifiedClient:new FakeBotifiedClient([]),
      botifiedServiceKeyFactory:({taskId})=>taskId,
      terminalHostForRun:()=>"127.0.0.1",
      terminalAccessRecheckMs:200,
      store
    });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const created = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, {
      prompt:"exact terminal Run",
      endpointId:auth.endpointId,
      fileLibrary:{mode:"create_new",name:"Exact terminal files"}
    });
    const task = await store.findTask(created.task.id as string);
    assert.ok(task);
    const upstreamBaseUrl="http://botified.internal";
    await makeTaskRunActive(store, task, upstreamBaseUrl);
    const runA=(await store.findTask(task.id))?.currentRunId;
    assert.ok(runA);
    assert.equal(
      await rejectedWebSocketStatus(
        `${api.baseUrl.replace(/^http/,"ws")}/api/v1/tasks/${task.id}/terminal/ws?expectedRunId=run_stale`,
        auth.cookie
      ),
      403
    );

    const client = new WebSocket(
      `${api.baseUrl.replace(/^http/, "ws")}/api/v1/tasks/${task.id}/terminal/ws?expectedRunId=${encodeURIComponent(runA)}`,
      { headers:{ cookie:auth.cookie } }
    );
    await once(client, "open");
    const closed=once(client,"close");

    const activeA=await store.findTask(task.id);
    assert.ok(activeA);
    await releaseTaskRunFixture(store,activeA);
    const releasedA=await store.findTask(task.id);
    assert.ok(releasedA);
    const runB=`run_fixture_replacement_${task.id}`;
    await makeTaskRunActive(store,releasedA,upstreamBaseUrl,runB);
    assert.deepEqual(
      {currentRunId:(await store.findTask(task.id))?.currentRunId,state:(await store.sandboxRuns.get(runB))?.state},
      {currentRunId:runB,state:"active"}
    );

    const [code,reason]=await within(closed,1_000,"Terminal stayed open after its exact Run changed");
    assert.equal(code,1008);
    assert.equal(String(reason),"Task terminal access changed");
  });

  it("advertises the terminal start command for a released Task while WebSocket remains transport-only",async()=>{
    const store=createLocalInMemoryProductStore();
    api=await createApiServer({port:0,dataRoot,builtinAdminPassword:"admin-password",sandboxNamespaceLimit:100,botifiedClient:new FakeBotifiedClient([]),botifiedServiceKeyFactory:({taskId})=>taskId,store});
    const auth=await createProjectWithEndpoint(api.baseUrl);
    const created=await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{prompt:"released terminal",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Released terminal files"}});
    const task=await store.findTask(created.task.id as string);
    assert.ok(task);
    assert.equal(task.currentRunId,null);
    assert.equal((await auth.requestJson("GET",`/api/v1/tasks/${task.id}/detail`)).capabilities.openTerminal,true);
    assert.equal(await rejectedWebSocketStatus(`${api.baseUrl.replace(/^http/,"ws")}/api/v1/tasks/${task.id}/terminal/ws`,auth.cookie),403);
    assert.equal((await store.sandboxRuns.list()).some((run)=>run.taskId===task.id),false);
  });

  it("opens the exact Run executor over TCP and forwards only normalized terminal NDJSON", async () => {
    let resolveFrames!:(frames:string[])=>void;
    const received=new Promise<string[]>((resolve)=>{resolveFrames=resolve;});
    terminalUpstream = await listenTerminalTcpServer(terminalUpstreamSockets,(socket)=>{
      let buffered="";
      const receivedFrames:string[]=[];
      let responseStarted=false;
      socket.on("data",(data)=>{
        buffered+=data.toString("utf8");
        const frames=buffered.split("\n");
        buffered=frames.pop()??"";
        receivedFrames.push(...frames);
        if(!responseStarted&&receivedFrames[0]===JSON.stringify({op:"open"})){
          responseStarted=true;
          socket.write('{"op":');
        }
        if(receivedFrames.length>=2){
          socket.write('"ready"}\n');
          resolveFrames(receivedFrames);
        }
      });
    });

    const store = createLocalInMemoryProductStore();
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", sandboxNamespaceLimit:100, botifiedClient:new FakeBotifiedClient([]), botifiedServiceKeyFactory:({taskId})=>taskId, terminalHostForRun:()=>"127.0.0.1", store });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const created = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, { prompt:"terminal input", endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Task files"} });
    const task = await store.findTask(created.task.id as string); assert.ok(task);
    await makeTaskRunActive(store, task, "http://botified.internal");

    const runId=(await store.findTask(task.id))?.currentRunId;
    assert.ok(runId);
    const client = new WebSocket(`${api.baseUrl.replace(/^http/, "ws")}/api/v1/tasks/${task.id}/terminal/ws?expectedRunId=${encodeURIComponent(runId)}`, { headers:{ cookie:auth.cookie } });
    await once(client, "open");
    const readyOrClose=Promise.race([
      once(client,"message").then((event)=>({kind:"message" as const,event})),
      once(client,"close").then((event)=>({kind:"close" as const,event}))
    ]);
    const frame = JSON.stringify({ data:"ZWNobyByZWFkeQo=", op:"stdin" });
    client.send(frame);
    assert.deepEqual(await within(received,1_000,"Terminal frames were not forwarded"),[
      JSON.stringify({op:"open"}),
      JSON.stringify({op:"stdin",data:"ZWNobyByZWFkeQo="})
    ]);
    const ready=await within(readyOrClose,1_000,"Incremental Terminal ready frame was not forwarded");
    assert.deepEqual(ready.kind==="message"
      ?{kind:ready.kind,frame:String(ready.event[0])}
      :{kind:ready.kind,code:ready.event[0],reason:String(ready.event[1])},
      {kind:"message",frame:JSON.stringify({op:"ready"})}
    );
    const closed = once(client, "close");
    client.close();
    await within(closed,1_000,"Terminal client did not close");
  });

  it("rejects binary terminal browser frames and cancels the executor TCP session", async () => {
    let resolveCancelled!:()=>void;
    const cancelled=new Promise<void>((resolve)=>{resolveCancelled=resolve;});
    terminalUpstream = await listenTerminalTcpServer(terminalUpstreamSockets,(socket)=>{
      let input="";
      socket.on("data",(data)=>{
        input+=data.toString("utf8");
        if(input.includes('{"op":"open"}\n'))socket.write('{"op":"ready"}\n');
        if(input.includes('{"op":"cancel"}\n'))resolveCancelled();
      });
    });

    const store = createLocalInMemoryProductStore();
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", sandboxNamespaceLimit:100, botifiedClient:new FakeBotifiedClient([]), botifiedServiceKeyFactory:({taskId})=>taskId, terminalHostForRun:()=>"127.0.0.1", store });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const created = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, { prompt:"terminal oversized input", endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Task files"} });
    const task = await store.findTask(created.task.id as string); assert.ok(task);
    await makeTaskRunActive(store, task, "http://botified.internal");

    const runId=(await store.findTask(task.id))?.currentRunId;
    assert.ok(runId);
    const client = new WebSocket(`${api.baseUrl.replace(/^http/, "ws")}/api/v1/tasks/${task.id}/terminal/ws?expectedRunId=${encodeURIComponent(runId)}`, { headers:{ cookie:auth.cookie } });
    const readyFramePromise=once(client,"message");
    await once(client, "open");
    const [readyFrame]=await within(readyFramePromise,1_000,"Terminal executor did not become ready");
    assert.equal(String(readyFrame),JSON.stringify({op:"ready"}));
    const closeCode = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Binary terminal input did not close the proxy connection")), 1_000);
      client.once("close", (code) => { clearTimeout(timeout); resolve(code); });
    });
    client.send(Buffer.from("not NDJSON"));
    assert.equal(await closeCode, 1003);
    await within(cancelled,1_000,"Terminal cancel was not sent before TCP disconnect");
  });

  it("closes a terminal connection when one executor NDJSON frame exceeds the proxy buffer", async () => {
    terminalUpstream = await listenTerminalTcpServer(terminalUpstreamSockets,(socket)=>{
      socket.once("data",()=>socket.write(`{"op":"output","data":"${"A".repeat(300*1024)}"}\n`));
    });

    const store = createLocalInMemoryProductStore();
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", sandboxNamespaceLimit:100, botifiedClient:new FakeBotifiedClient([]), botifiedServiceKeyFactory:({taskId})=>taskId, terminalHostForRun:()=>"127.0.0.1", store });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const created = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, { prompt:"terminal output", endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Task files"} });
    const task = await store.findTask(created.task.id as string); assert.ok(task);
    await makeTaskRunActive(store, task, "http://botified.internal");

    const runId=(await store.findTask(task.id))?.currentRunId;
    assert.ok(runId);
    const client = new WebSocket(`${api.baseUrl.replace(/^http/, "ws")}/api/v1/tasks/${task.id}/terminal/ws?expectedRunId=${encodeURIComponent(runId)}`, { headers:{ cookie:auth.cookie } });
    const closeCode = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Oversized terminal output did not close the proxy connection")), 1_000);
      client.once("close", (code) => { clearTimeout(timeout); resolve(code); });
    });
    await once(client, "open");
    assert.equal(await closeCode, 1009);
  });

  it("rejects invalid UTF-8 in executor NDJSON output", async () => {
    terminalUpstream = await listenTerminalTcpServer(terminalUpstreamSockets,(socket)=>{
      socket.once("data",()=>socket.write(Buffer.concat([
        Buffer.from('{"op":"error","message":"'),
        Buffer.from([0xc3,0x28]),
        Buffer.from('"}\n')
      ])));
    });

    const store = createLocalInMemoryProductStore();
    api = await createApiServer({
      port:0,
      dataRoot,
      builtinAdminPassword:"admin-password",
      sandboxNamespaceLimit:100,
      botifiedClient:new FakeBotifiedClient([]),
      botifiedServiceKeyFactory:({taskId})=>taskId,
      terminalHostForRun:()=>"127.0.0.1",
      store
    });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const created = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, {
      prompt:"terminal invalid UTF-8",
      endpointId:auth.endpointId,
      fileLibrary:{mode:"create_new",name:"Task files"}
    });
    const task = await store.findTask(created.task.id as string);
    assert.ok(task);
    await makeTaskRunActive(store,task,"http://botified.internal");
    const runId=(await store.findTask(task.id))?.currentRunId;
    assert.ok(runId);

    const client = new WebSocket(
      `${api.baseUrl.replace(/^http/,"ws")}/api/v1/tasks/${task.id}/terminal/ws?expectedRunId=${encodeURIComponent(runId)}`,
      {headers:{cookie:auth.cookie}}
    );
    const closed=once(client,"close");
    await once(client,"open");
    const [code,reason]=await within(closed,1_000,"Invalid UTF-8 output did not close the Terminal");
    assert.equal(code,1008);
    assert.equal(String(reason),"Invalid terminal output");
  });

  it("retains history while current endpoint, credential, and membership eligibility disable capabilities", async () => {
    const store = createLocalInMemoryProductStore();
    const botified = new FakeBotifiedClient([]);
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", sandboxNamespaceLimit:100, botifiedClient:botified, botifiedServiceKeyFactory:({taskId})=>taskId, store });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const created = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, { prompt:"retained task history", endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Task files"} });
    const task = await store.findTask(created.task.id as string); assert.ok(task);
    await makeTaskRunActive(store, task, "http://botified.internal");

    const initial = await auth.requestJson("GET",`/api/v1/tasks/${task.id}/interactions`);
    assert.equal(initial.presentation.capabilities.sendMessage,true);
    assert.equal(initial.presentation.capabilities.openTerminal,true);
    assert.equal(initial.items.some((item:{body:string|null})=>item.body==="retained task history"),true);

    const endpoint = await store.findEndpoint(task.endpointId); assert.ok(endpoint);
    await store.updateEndpoint({...endpoint,capabilities:["text"],updatedAt:new Date(Date.parse(endpoint.updatedAt)+1_000).toISOString()});
    const endpointDisabled = await auth.requestJson("GET",`/api/v1/tasks/${task.id}/interactions`);
    assert.equal(endpointDisabled.items.length,initial.items.length);
    assert.deepEqual(endpointDisabled.presentation.capabilities,{sendMessage:false,editQueuedMessage:false,abortTurn:true,openTerminal:true,releaseSandbox:true,editTask:true,archiveTask:false,deleteTask:false});

    await store.updateEndpoint(endpoint);
    const project=await store.findProject(task.projectId);assert.ok(project);const owner=await store.findProjectMembership(task.projectId,project.ownerUserId);assert.ok(owner);
    await store.updateProjectMembership({...owner,role:"viewer",updatedAt:new Date(Date.parse(owner.updatedAt)+1_000).toISOString()});
    const viewer = await auth.requestJson("GET",`/api/v1/tasks/${task.id}/interactions`);
    assert.equal(viewer.items.length,initial.items.length);
    assert.deepEqual(viewer.presentation.capabilities,{sendMessage:false,editQueuedMessage:false,abortTurn:false,openTerminal:false,releaseSandbox:false,editTask:false,archiveTask:false,deleteTask:false});

    await store.updateProjectMembership(owner);
    const findCredential = store.findStoredProjectCredential.bind(store);
    store.findStoredProjectCredential = async (projectId,id) => id === endpoint.credentialId ? null : findCredential(projectId,id);
    const credentialDisabled = await auth.requestJson("GET",`/api/v1/tasks/${task.id}/interactions`);
    assert.equal(credentialDisabled.items.length,initial.items.length);
    assert.equal(credentialDisabled.presentation.capabilities.sendMessage,false);
    assert.equal(credentialDisabled.presentation.capabilities.openTerminal,true);
    assert.equal(credentialDisabled.presentation.capabilities.abortTurn,true);
  });


  it("leaves a pending message unclaimed while its current Run is not startup-ready",async()=>{
    const store=createLocalInMemoryProductStore();
    api=await createApiServer({port:0,dataRoot,builtinAdminPassword:"admin-password",sandboxNamespaceLimit:100,store});
    const auth=await createProjectWithEndpoint(api.baseUrl);
    const created=await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{prompt:"readiness gate",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Readiness files"}});
    const task=await store.findTask(created.task.id as string);assert.ok(task);
    await makeTaskRunActive(store,task,"http://botified.internal");
    const current=await store.findTask(task.id);assert.ok(current?.currentRunId);
    const run=await store.sandboxRuns.get(current.currentRunId);assert.ok(run);
    assert.ok(await store.sandboxRuns.updateWithFencing(run.runId,run.fencingToken,{...run,state:"starting",startupReadyAt:null,fencingToken:run.fencingToken+1,updatedAt:new Date().toISOString()}));
    const project=await store.findProject(task.projectId);assert.ok(project);
    await rm(path.join(dataRoot,project.rootPath,"tasks",task.id,".agentsmith-preparation.json"));
    const timestamp=new Date().toISOString();
    const message=await store.createPendingTaskMessage(
      {id:"message_not_ready_tick",taskId:task.id,actorId:task.createdByUserId??null,content:"wait for readiness",claimToken:null,deliveryStatus:"pending",claimedAt:null,leaseExpiresAt:null,safeError:null,createdAt:timestamp,updatedAt:timestamp,deletedAt:null},
      {sourceKind:"product",sourceId:"message:message_not_ready_tick",sourceRevision:0,interaction:{id:"interaction_message_not_ready_tick",revision:1,taskId:task.id,kind:"user_message",title:"You",body:"wait for readiness",contentMode:"full",position:0,occurredAt:timestamp,updatedAt:timestamp,actorId:task.createdByUserId??null,status:"pending"}}
    );
    assert.ok(message);
    let claims=0;
    const claim=store.claimTaskMessage.bind(store);
    store.claimTaskMessage=async(input)=>{claims+=1;return claim(input);};
    const background=createApplicationServices({store,dataRoot,builtinAdminPassword:"admin-password",sandboxNamespaceLimit:100,providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}}});

    await background.tasks.syncActiveTasksOnce();
    assert.equal(claims,0);
    assert.equal((await store.findTaskMessage(message.id))?.deliveryStatus,"pending");
    assert.equal((await store.findTaskMessage(message.id))?.claimToken,null);
  });

  it("streams independent typed state and connection changes without a duplicate Run event", async () => {
    const store = createLocalInMemoryProductStore();
    const botified = new FakeBotifiedClient([]);
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", sandboxNamespaceLimit:100, botifiedClient:botified, botifiedServiceKeyFactory:({taskId})=>taskId, store });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const created = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, { prompt:"state stream", endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Task files"} });
    const task = await store.findTask(created.task.id as string); assert.ok(task);
    await makeTaskRunActive(store, task, "http://botified.internal");

    const response=await auth.request("GET",`/api/v1/tasks/${task.id}/interactions/stream`);assert.equal(response.status,200);
    const reader=response.body?.getReader();assert.ok(reader);const decoder=new TextDecoder();let stream="";
    while(!stream.includes('"sendMessage":true')){const chunk=await reader.read();if(chunk.done)break;stream+=decoder.decode(chunk.value,{stream:true});}
    const endpoint=await store.findEndpoint(task.endpointId);assert.ok(endpoint);
    await store.updateEndpoint({...endpoint,capabilities:["text"],updatedAt:new Date(Date.parse(endpoint.updatedAt)+1_000).toISOString()});
    while(!stream.includes('"sendMessage":false')){const chunk=await reader.read();if(chunk.done)break;stream+=decoder.decode(chunk.value,{stream:true});}
    await reader.cancel();

    assert.match(stream,/event: state/);
    assert.match(stream,/event: connection\ndata: \{"connectionState":"connected","runtimeReachability":"reachable","historyStatus":"complete","lastSyncedAt":"[^"]+","message":null\}/);
    assert.doesNotMatch(stream,/event: run_state|runState/);
    assert.match(stream,/"runtimeReachability":"reachable"/);
    assert.match(stream,/"historyStatus":"complete"/);
    assert.match(stream,/"lastSyncedAt":"[^"]+"/);
    assert.match(stream,/"sendMessage":false/);
    assert.doesNotMatch(stream,/event: state\ndata: [^\n]*(?:runState|runtimeReachability|historyStatus|lastSyncedAt|connectionState)/);
  });

  it("reports an unavailable preview source without marking interaction updates disconnected", async () => {
    const store = createLocalInMemoryProductStore();
    const botified = new FakeBotifiedClient([]);
    botified.previewFailure = new Error("Botified service key api-service-key failed");
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", sandboxNamespaceLimit:100, botifiedClient:botified, botifiedServiceKeyFactory:({taskId})=>taskId, store });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const created = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, { prompt:"preview failure", endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Task files"} });
    const task = await store.findTask(created.task.id as string); assert.ok(task);
    await makeTaskRunActive(store, task, "http://botified.internal");

    const response = await auth.request("GET", `/api/v1/tasks/${task.id}/interactions/stream`);
    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let stream = "";
    while (!stream.includes("Live assistant preview is unavailable.")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stream += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();

    assert.match(stream, /event: connection\ndata: \{"connectionState":"connected","runtimeReachability":"reachable","historyStatus":"complete","lastSyncedAt":"[^"]+","message":null\}/);
    assert.match(stream, /event: preview_status\ndata: \{"previewStatus":"unavailable","message":"Live assistant preview is unavailable\. Final responses and conversation updates remain available\."\}/);
    assert.doesNotMatch(stream, /"connectionState":"disconnected"/);
    assert.doesNotMatch(stream, /api-service-key|Botified service key/);
  });

  it("aborts an active Botified preview when the interaction stream client disconnects", async () => {
    const store = createLocalInMemoryProductStore();
    const botified = new FakeBotifiedClient([]);
    botified.previewWaitForAbort = true;
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", sandboxNamespaceLimit:100, botifiedClient:botified, botifiedServiceKeyFactory:({taskId})=>taskId, store });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const created = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, { prompt:"preview disconnect", endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Task files"} });
    const task = await store.findTask(created.task.id as string); assert.ok(task);
    await makeTaskRunActive(store, task, "http://botified.internal");

    const response = await auth.request("GET", `/api/v1/tasks/${task.id}/interactions/stream`);
    assert.equal(response.status, 200);
    const reader = response.body?.getReader(); assert.ok(reader);
    await reader.read();
    await reader.cancel();
    for (let attempt = 0; attempt < 20 && !botified.previewSignal?.aborted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(botified.previewSignal?.aborted, true);
    assert.equal((await auth.request("GET", `/api/v1/tasks/${task.id}/interactions`)).status, 200);
  });

  it("fails fast when live sandbox mode has no persistent product store", async () => {
    const previousPostgresUrl = process.env.POSTGRES_APP_URL;
    delete process.env.POSTGRES_APP_URL;
    try {
      await assert.rejects(
        () =>
          createApiServer({
            port: 0,
            dataRoot,
            builtinAdminPassword: "admin-password", sandboxNamespaceLimit: 100,
            liveSandbox: {
              port: {
                applyResource: async () => "applied" as const,
                deleteResource: async () => "deleted" as const,
                getPodReadiness: async () => "not_found" as const,
                getConfigMapData:async()=> "not_found" as const,
                listManagedResources: async () => [],
                async inspectResource(){return"not_found" as const;}
              }
            }
          }),
        /POSTGRES_APP_URL is required/
      );
    } finally {
      if (previousPostgresUrl === undefined) {
        delete process.env.POSTGRES_APP_URL;
      } else {
        process.env.POSTGRES_APP_URL = previousPostgresUrl;
      }
    }
  });

  it("fails fast when live sandbox mode would use a missing, default, or weak session secret", async () => {
    const previousPostgresUrl = process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL = "postgresql://app:secret@db/app";
    const liveSandbox = {
      port: {
        applyResource: async () => "applied" as const,
        deleteResource: async () => "deleted" as const,
        getPodReadiness: async () => "not_found" as const,
        getConfigMapData:async()=> "not_found" as const,
        listManagedResources: async () => [],
        async inspectResource(){return"not_found" as const;}
      }
    };

    try {
      for (const sessionSecret of [undefined, "", "dev-session-secret", " dev-session-secret ", "short-production-secret"]) {
        await assert.rejects(
          () =>
            createApiServer({
              port: 0,
              dataRoot,
              builtinAdminPassword: "production-admin-password",
              ...(sessionSecret !== undefined ? { sessionSecret } : {}),
              liveSandbox
            }),
          /APP_SESSION_SECRET must be set to a non-default value of at least 32 characters/
        );
      }

      api = await createApiServer({
        port: 0,
        dataRoot,
        builtinAdminPassword: "production-admin-password",
        sessionSecret: validProductionSessionSecret,
        liveSandbox,
        store: createLocalInMemoryProductStore()
      });
      assert.match(api.baseUrl, /^http:\/\/127\.0\.0\.1:/);
    } finally {
      if (previousPostgresUrl === undefined) {
        delete process.env.POSTGRES_APP_URL;
      } else {
        process.env.POSTGRES_APP_URL = previousPostgresUrl;
      }
    }
  });

  it("fails fast when live sandbox mode would use the default admin password", async () => {
    const previousPostgresUrl = process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL = "postgresql://app:secret@db/app";
    const liveSandbox = {
      port: {
        applyResource: async () => "applied" as const,
        deleteResource: async () => "deleted" as const,
        getPodReadiness: async () => "not_found" as const,
        getConfigMapData:async()=> "not_found" as const,
        listManagedResources: async () => [],
        async inspectResource(){return"not_found" as const;}
      }
    };

    try {
      for (const builtinAdminPassword of ["", "admin-password", " admin-password "]) {
        await assert.rejects(
          () =>
            createApiServer({
              port: 0,
              dataRoot,
              builtinAdminPassword,
              sessionSecret: validProductionSessionSecret,
              liveSandbox
            }),
          /BUILTIN_ADMIN_INITIAL_PASSWORD must be set to a non-default value/
        );
      }
    } finally {
      if (previousPostgresUrl === undefined) {
        delete process.env.POSTGRES_APP_URL;
      } else {
        process.env.POSTGRES_APP_URL = previousPostgresUrl;
      }
    }
  });

  it("requires an authorized idempotent direct sandbox release request",async()=>{
    const previousPostgresUrl=process.env.POSTGRES_APP_URL;process.env.POSTGRES_APP_URL="postgresql://app:secret@db/app";
    const resources:import("../../packages/contracts/src/api.js").KubernetesResource[]=[];
    const store=createLocalInMemoryProductStore();
    try{
      api=await createApiServer({port:0,dataRoot,builtinAdminPassword:"production-admin-password",sessionSecret:validProductionSessionSecret,sandboxNamespaceLimit:100,store,botifiedClient:new FakeBotifiedClient([]),botifiedServiceKeyFactory:({taskId})=>taskId,liveSandbox:{port:{async applyResource(resource){resources.push(withFixtureUid(resource));return"applied" as const;},async deleteResource(){return"deleted" as const;},async getPodReadiness(){return"not_found" as const;},async getConfigMapData(){return"not_found" as const;},async listManagedResources(){return structuredClone(resources);},async inspectResource(ref,labels){return inspectFixtureResource(resources,ref,labels);}}}});
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const task=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{prompt:"release through API",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Task files"}})).task;
      assert.equal((await auth.requestJson("GET",`/api/v1/tasks/${task.id}/detail`)).capabilities.releaseSandbox,true);
      assert.equal((await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/sandbox/release`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status,401);
      const baseHeaders={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf};
      const body=await exactReleaseBody(store,task.id);
      assert.equal((await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/sandbox/release`,{method:"POST",headers:baseHeaders,body})).status,400);
      const headers={...baseHeaders,"idempotency-key":"release-api-key"};
      const first=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/sandbox/release`,{method:"POST",headers,body});const firstBody=await first.json();
      const replay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/sandbox/release`,{method:"POST",headers,body});const replayBody=await replay.json();
      assert.equal(first.status,202);assert.equal(replay.status,202);assert.deepEqual(replayBody,firstBody);
      assert.deepEqual(firstBody,{outcome:"accepted_in_progress",keyDisposition:"retain",taskId:task.id,runId:JSON.parse(body).expectedRunId});
      const releasing=await auth.requestJson("GET",`/api/v1/tasks/${task.id}/detail`);
      assert.equal(releasing.sandboxState.state,"release_requested");
      assert.equal(releasing.sandboxState.cause,null);
      assert.equal(releasing.capabilities.releaseSandbox,false);
      const requested=await store.sandboxRuns.get(JSON.parse(body).expectedRunId);assert.ok(requested);
      const releasedAt=new Date(Date.parse(requested.updatedAt)+1).toISOString();
      const released={...requested,state:"released" as const,releasedAt,startupActionDeadlineAt:null,cleanupClaimedAt:null,fencingToken:requested.fencingToken+1,updatedAt:releasedAt};
      const finalReceipt={outcome:"completed",keyDisposition:"retire",taskId:requested.taskId,runId:requested.runId};
      assert.equal(await store.completeSandboxRunRelease({
        runId:requested.runId,expectedFencingToken:requested.fencingToken,run:released,
        settlement:{
          runId:requested.runId,workspaceId:requested.workspaceId,projectId:requested.projectId,
          taskId:requested.taskId,fileLibraryId:requested.fileLibraryId,startedByUserId:requested.startedByUserId,
          startedAt:requested.startedAt,releasedAt,
          durationSeconds:requested.startedAt===null?0:(Date.parse(releasedAt)-Date.parse(requested.startedAt))/1000,
          resources:requested.resourceSnapshot,releaseReason:requested.releaseReason!
        },
        auditEvent:{
          id:"audit_release_api_final",projectId:requested.projectId,actorId:null,
          subjectUserId:requested.startedByUserId,action:"sandbox.released",status:"accepted",
          resourceKind:"sandbox",resourceId:requested.taskId,
          detail:{taskId:requested.taskId,runId:requested.runId,releaseReason:requested.releaseReason!},
          createdAt:releasedAt
        },
        releaseReceipt:{responseStatus:200,responseBody:finalReceipt,updatedAt:releasedAt}
      }),"applied");
      const final=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/sandbox/release`,{method:"POST",headers,body});
      assert.equal(final.status,200);
      assert.deepEqual(await final.json(),finalReceipt);
      const releasedHeaders={...baseHeaders,"idempotency-key":"release-api-after-final"};
      const releasedFirst=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/sandbox/release`,{method:"POST",headers:releasedHeaders,body});
      const releasedReplay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/sandbox/release`,{method:"POST",headers:releasedHeaders,body});
      assert.equal(releasedFirst.status,200);
      assert.deepEqual(await releasedFirst.json(),finalReceipt);
      assert.equal(releasedReplay.status,200);
      assert.deepEqual(await releasedReplay.json(),finalReceipt);
    }finally{if(previousPostgresUrl===undefined)delete process.env.POSTGRES_APP_URL;else process.env.POSTGRES_APP_URL=previousPostgresUrl;}
  });

  it("requires Release to target the exact canonical Run",async()=>{
    const store=createLocalInMemoryProductStore();
    api=await createApiServer({
      port:0,dataRoot,builtinAdminPassword:"admin-password",sandboxNamespaceLimit:100,
      store,botifiedClient:new FakeBotifiedClient([]),botifiedServiceKeyFactory:({taskId})=>taskId
    });
    const auth=await createProjectWithEndpoint(api.baseUrl);
    const created=await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
      prompt:"exact release target",endpointId:auth.endpointId,
      fileLibrary:{mode:"create_new",name:"Exact release files"}
    });
    const initialTask=await store.findTask(created.task.id as string);assert.ok(initialTask);
    await makeTaskRunActive(store,initialTask,"http://botified.internal");
    const task=await store.findTask(initialTask.id);assert.ok(task?.currentRunId);
    const run=await store.sandboxRuns.get(task.currentRunId);assert.ok(run);
    const headers={
      "content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,
      "idempotency-key":"exact-release"
    };

    const stale=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/sandbox/release`,{
      method:"POST",headers,body:JSON.stringify({expectedRunId:"run_stale"})
    });
    const staleBody=await stale.json() as {outcome:string;keyDisposition:string;code?:string};

    assert.equal(stale.status,409);
    assert.equal(staleBody.outcome,"rejected_before_acceptance");
    assert.equal(staleBody.keyDisposition,"retire");
    assert.equal(staleBody.code,"task_run_target_conflict");
    assert.equal((await store.sandboxRuns.get(run.runId))?.state,run.state);
  });

  it("settles a pending Terminal Start through Release before accepting a new key",async()=>{
    const previousPostgresUrl=process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL="postgresql://app:secret@db/app";
    const store=createLocalInMemoryProductStore();
    const resources:import("../../packages/contracts/src/api.js").KubernetesResource[]=[];
    try{
      api=await createApiServer({
        port:0,dataRoot,builtinAdminPassword:"production-admin-password",
        sessionSecret:validProductionSessionSecret,sandboxNamespaceLimit:100,
        runtimeTickIntervalMs:60_000,store,botifiedClient:new FakeBotifiedClient([]),
        botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{port:{
          async applyResource(resource){resources.push(structuredClone(resource));return"applied" as const;},
          async deleteResource(){return"deleted" as const;},
          async getPodReadiness(){return"not_found" as const;},
          async getConfigMapData(){return"not_found" as const;},
          async listManagedResources(){return structuredClone(resources);},
          async inspectResource(ref,labels){return inspectFixtureResource(resources,ref,labels);}
        }}
      });
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const created=await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
        prompt:"release pending terminal",endpointId:auth.endpointId,
        fileLibrary:{mode:"create_new",name:"Release pending terminal files"}
      });
      const task=await store.findTask(created.task.id as string);assert.ok(task?.currentRunId);
      const run=await store.sandboxRuns.get(task.currentRunId);assert.ok(run);
      const baseHeaders={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf};
      const terminalBody=JSON.stringify({expectedRunId:run.runId,expectedSandboxState:run.state});
      const first=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{
        method:"POST",headers:{...baseHeaders,"idempotency-key":"terminal-before-release"},body:terminalBody
      });
      assert.equal(first.status,202);

      const release=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/sandbox/release`,{
        method:"POST",headers:{...baseHeaders,"idempotency-key":"release-pending-terminal"},
        body:JSON.stringify({expectedRunId:run.runId})
      });
      assert.equal(release.status,202);
      const requested=await store.sandboxRuns.get(run.runId);assert.equal(requested?.state,"release_requested");
      assert.ok(requested);
      const releasedAt=new Date(Date.parse(requested.updatedAt)+1).toISOString();
      const released={...requested,state:"released" as const,releasedAt,startupActionDeadlineAt:null,cleanupClaimedAt:null,fencingToken:requested.fencingToken+1,updatedAt:releasedAt};
      assert.equal(await store.completeSandboxRunRelease({
        runId:requested.runId,expectedFencingToken:requested.fencingToken,run:released,
        settlement:{
          runId:requested.runId,workspaceId:requested.workspaceId,projectId:requested.projectId,
          taskId:requested.taskId,fileLibraryId:requested.fileLibraryId,startedByUserId:requested.startedByUserId,
          startedAt:requested.startedAt,releasedAt,durationSeconds:0,resources:requested.resourceSnapshot,
          releaseReason:requested.releaseReason!
        },
        auditEvent:{
          id:"audit_api_pending_terminal_released",projectId:requested.projectId,actorId:null,
          subjectUserId:requested.startedByUserId,action:"sandbox.released",status:"accepted",
          resourceKind:"sandbox",resourceId:requested.taskId,
          detail:{taskId:requested.taskId,runId:requested.runId,releaseReason:requested.releaseReason!},
          createdAt:releasedAt
        },
        releaseReceipt:{
          responseStatus:200,
          responseBody:{outcome:"completed",keyDisposition:"retire",taskId:task.id,runId:run.runId},
          updatedAt:releasedAt
        }
      }),"applied");
      const releaseReplay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/sandbox/release`,{
        method:"POST",headers:{...baseHeaders,"idempotency-key":"release-pending-terminal"},
        body:JSON.stringify({expectedRunId:run.runId})
      });
      assert.equal(releaseReplay.status,200);
      assert.deepEqual(await releaseReplay.json(),{
        outcome:"completed",keyDisposition:"retire",taskId:task.id,runId:run.runId
      });

      const next=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{
        method:"POST",headers:{...baseHeaders,"idempotency-key":"terminal-after-release"},
        body:JSON.stringify({expectedRunId:run.runId,expectedSandboxState:"released"})
      });
      const nextBody=await next.json() as {outcome:string;runId:string};
      assert.equal(next.status,202);
      assert.equal(nextBody.outcome,"accepted_in_progress");
      assert.notEqual(nextBody.runId,run.runId);

      const oldReplay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{
        method:"POST",headers:{...baseHeaders,"idempotency-key":"terminal-before-release"},body:terminalBody
      });
      const oldReplayBody=await oldReplay.json() as {outcome:string;runId:string;error:{code:string}};
      assert.equal(oldReplay.status,502);
      assert.equal(oldReplayBody.outcome,"completed");
      assert.equal(oldReplayBody.runId,run.runId);
      assert.equal(oldReplayBody.error.code,"sandbox_start_failed");
    }finally{
      if(previousPostgresUrl===undefined)delete process.env.POSTGRES_APP_URL;else process.env.POSTGRES_APP_URL=previousPostgresUrl;
    }
  });

  it("returns Terminal Start after reservation and leaves startup to syncActiveTasksOnce",async()=>{
    const previousPostgresUrl=process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL="postgresql://app:secret@db/app";
    const store=createLocalInMemoryProductStore();
    const resources:import("../../packages/contracts/src/api.js").KubernetesResource[]=[];
    let applyCalls=0;
    let startupEntered!:()=>void,continueStartup!:()=>void;
    const entered=new Promise<void>((resolve)=>{startupEntered=resolve;});
    const startupGate=new Promise<void>((resolve)=>{continueStartup=resolve;});
    try{
      api=await createApiServer({
        port:0,dataRoot,builtinAdminPassword:"production-admin-password",
        sessionSecret:validProductionSessionSecret,sandboxNamespaceLimit:100,
        runtimeTickIntervalMs:60_000,store,botifiedClient:new FakeBotifiedClient([]),
        botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{port:{
          async applyResource(resource){
            applyCalls+=1;
            const next=structuredClone(resource);
            if(next.kind==="Pod")next.metadata.uid="pod-uid-terminal-start";
            resources.push(next);
            return"applied" as const;
          },
          async deleteResource(){return"deleted" as const;},
          async getPodReadiness(_namespace,name){
            const pod=resources.find((resource)=>resource.kind==="Pod"&&resource.metadata.name===name);
            return pod?{state:"ready" as const,podUid:String(pod.metadata.uid),podIp:"10.42.0.31"}:"not_found" as const;
          },
          async getConfigMapData(_namespace,name){
            const config=resources.find((resource)=>resource.kind==="ConfigMap"&&resource.metadata.name===name);
            return config?{data:structuredClone(config.data as Record<string,string>)}:"not_found" as const;
          },
          async listManagedResources(){return structuredClone(resources);},
          async inspectResource(ref,labels){return inspectFixtureResource(resources,ref,labels);}
        }}
      });
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const created=await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
        prompt:"reconciler-owned terminal",endpointId:auth.endpointId,
        fileLibrary:{mode:"create_new",name:"Reconciler terminal files"}
      });
      const task=await store.findTask(created.task.id as string);assert.ok(task?.currentRunId);
      const run=await store.sandboxRuns.get(task.currentRunId);assert.ok(run);
      const requestHeaders={
        "content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf
      };
      const stale=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{
        method:"POST",
        headers:{...requestHeaders,"idempotency-key":"reconciler-stale-terminal"},
        body:JSON.stringify({expectedRunId:"run_stale",expectedSandboxState:run.state})
      });
      const staleBody=await stale.json() as {outcome:string;keyDisposition:string;code?:string};
      assert.equal(stale.status,409);
      assert.deepEqual(
        {outcome:staleBody.outcome,keyDisposition:staleBody.keyDisposition,code:staleBody.code},
        {outcome:"rejected_before_acceptance",keyDisposition:"retire",code:"task_run_target_conflict"}
      );
      assert.equal((await store.findTask(task.id))?.currentRunId,run.runId);
      assert.equal(applyCalls,0);
      const response=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{
        method:"POST",
        headers:{...requestHeaders,"idempotency-key":"reconciler-owned-terminal"},
        body:JSON.stringify({expectedRunId:run.runId,expectedSandboxState:run.state})
      });
      const receipt=await response.json() as {outcome:string;keyDisposition:string;runId:string};
      assert.equal(response.status,202);
      assert.deepEqual(receipt,{
        outcome:"accepted_in_progress",keyDisposition:"retain",runId:run.runId
      });
      assert.equal(applyCalls,0);

      const background=createApplicationServices({
        store,dataRoot,builtinAdminPassword:"production-admin-password",
        sessionSecret:validProductionSessionSecret,sandboxNamespaceLimit:100,
        botifiedClient:new FakeBotifiedClient([]),botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{port:{
          async applyResource(resource){
            applyCalls+=1;
            const next=structuredClone(resource);
            if(next.kind==="Pod")next.metadata.uid="pod-uid-terminal-start";
            resources.push(next);
            if(applyCalls===1){startupEntered();await startupGate;}
            return"applied" as const;
          },
          async deleteResource(){return"deleted" as const;},
          async getPodReadiness(_namespace,name){
            const pod=resources.find((resource)=>resource.kind==="Pod"&&resource.metadata.name===name);
            return pod?{state:"ready" as const,podUid:String(pod.metadata.uid),podIp:"10.42.0.31"}:"not_found" as const;
          },
          async getConfigMapData(_namespace,name){
            const config=resources.find((resource)=>resource.kind==="ConfigMap"&&resource.metadata.name===name);
            return config?{data:structuredClone(config.data as Record<string,string>)}:"not_found" as const;
          },
          async listManagedResources(){return structuredClone(resources);},
          async inspectResource(ref,labels){return inspectFixtureResource(resources,ref,labels);}
        }},
        providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}}
      });
      const firstSync=background.tasks.syncActiveTasksOnce();
      await within(entered,500,"Terminal startup did not begin");
      const overlappingSync=background.tasks.syncActiveTasksOnce();
      continueStartup();
      await firstSync;
      await overlappingSync;
      assert.equal((await store.sandboxRuns.get(run.runId))?.state,"active");
      assert.equal(applyCalls,6);
    }finally{
      if(previousPostgresUrl===undefined)delete process.env.POSTGRES_APP_URL;else process.env.POSTGRES_APP_URL=previousPostgresUrl;
    }
  });

  it("aborts the matching local Terminal startup owner after exact Release commits its fence",async()=>{
    const previousPostgresUrl=process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL="postgresql://app:secret@db/app";
    const store=createLocalInMemoryProductStore();
    let applyEntered!:()=>void;
    const entered=new Promise<void>((resolve)=>{applyEntered=resolve;});
    let startupSignal:AbortSignal|undefined;
    const livePort={
      async applyResource(
        _resource:import("../../packages/contracts/src/api.js").KubernetesResource,
        _labels:Record<string,string>,
        signal?:AbortSignal
      ){
        startupSignal=signal;
        applyEntered();
        return new Promise<"applied">((_resolve,reject)=>{
          const abort=()=>reject(signal?.reason??new Error("Terminal startup aborted"));
          if(signal?.aborted)abort();
          else signal?.addEventListener("abort",abort,{once:true});
        });
      },
      async deleteResource(){return"not_found" as const;},
      async getPodReadiness(){return"not_found" as const;},
      async getConfigMapData(){return"not_found" as const;},
      async listManagedResources(){return[];},
      async inspectResource(){return"not_found" as const;}
    };
    try{
      api=await createApiServer({
        port:0,dataRoot,builtinAdminPassword:"production-admin-password",
        sessionSecret:validProductionSessionSecret,sandboxNamespaceLimit:100,
        runtimeTickIntervalMs:60_000,store,botifiedClient:new FakeBotifiedClient([]),
        botifiedServiceKeyFactory:({taskId})=>taskId,liveSandbox:{port:livePort}
      });
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const created=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
        prompt:"release aborts exact startup",endpointId:auth.endpointId,
        fileLibrary:{mode:"create_new",name:"Release abort files"}
      })).task;
      const task=await store.findTask(created.id as string);assert.ok(task?.currentRunId&&task.createdByUserId);
      const request={
        expectedRunId:task.currentRunId,
        expectedSandboxState:(await store.sandboxRuns.get(task.currentRunId))!.state
      };
      const services=createApplicationServices({
        store,dataRoot,builtinAdminPassword:"production-admin-password",
        sessionSecret:validProductionSessionSecret,sandboxNamespaceLimit:100,
        botifiedClient:new FakeBotifiedClient([]),botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{port:livePort},
        providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}}
      });
      assert.equal(
        (await services.tasks.startTaskTerminal(task.createdByUserId,task.id,request,"terminal-local-owner")).outcome,
        "accepted_in_progress"
      );

      const sync=services.tasks.syncActiveTasksOnce();
      await within(entered,500,"Terminal startup did not enter its local owner");
      const release=await services.tasks.releaseTaskSandbox(
        task.createdByUserId,
        task.id,
        {expectedRunId:task.currentRunId},
        "release-local-owner"
      );
      assert.equal(release.outcome,"accepted_in_progress");
      assert.equal(release.keyDisposition,"retain");
      assert.equal(startupSignal?.aborted,true);
      await within(sync,500,"Aborted Terminal startup did not converge");

      const fenced=await store.sandboxRuns.get(task.currentRunId);assert.ok(fenced);
      assert.equal(fenced.state,"release_requested");
      assert.ok(fenced.startupActionDeadlineAt);
      const replay=await services.tasks.startTaskTerminal(
        task.createdByUserId,task.id,request,"terminal-local-owner"
      );
      assert.equal(replay.outcome,"completed");
      assert.equal("error" in replay?replay.error.code:null,"sandbox_start_failed");
      assert.equal((await store.sandboxRuns.get(task.currentRunId))?.state,"release_requested");
    }finally{
      if(previousPostgresUrl===undefined)delete process.env.POSTGRES_APP_URL;else process.env.POSTGRES_APP_URL=previousPostgresUrl;
    }
  });

  it("rejects an invalid Terminal endpoint before reserving a replacement Run",async()=>{
    const previousPostgresUrl=process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL="postgresql://app:secret@db/app";
    const store=createLocalInMemoryProductStore();
    try{
      api=await createApiServer({
        port:0,dataRoot,builtinAdminPassword:"production-admin-password",sessionSecret:validProductionSessionSecret,sandboxNamespaceLimit:100,store,
        botifiedClient:new FakeBotifiedClient([]),botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{port:{async applyResource(){return"applied" as const;},async deleteResource(){return"deleted" as const;},async getPodReadiness(){return"not_found" as const;},async getConfigMapData(){return"not_found" as const;},async listManagedResources(){return[];},async inspectResource(){return"not_found" as const;}}}
      });
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const created=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
        prompt:"invalid endpoint before Terminal reservation",endpointId:auth.endpointId,
        fileLibrary:{mode:"create_new",name:"Invalid endpoint files"}
      })).task;
      const task=await store.findTask(created.id as string);assert.ok(task);
      await releaseTaskRunFixture(store,task);
      const releasedTask=await store.findTask(task.id);assert.ok(releasedTask?.currentRunId);
      const releasedRunId=releasedTask.currentRunId;
      const endpoint=await store.findEndpoint(auth.endpointId);assert.ok(endpoint);
      const healthUpdatedAt=new Date(Date.parse(endpoint.updatedAt)+1_000).toISOString();
      assert.ok(await store.updateEndpointHealth(endpoint.id,endpoint.projectId,{status:"unavailable",checkedAt:healthUpdatedAt,errorCategory:"network"},healthUpdatedAt,endpoint.updatedAt));
      let begins=0;
      const begin=store.beginTerminalStart.bind(store);
      store.beginTerminalStart=async(input)=>{begins+=1;return begin(input);};
      const terminalBody=await exactTerminalStartBody(store,task.id);

      const response=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{
        method:"POST",
        headers:{"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"invalid-endpoint-terminal"},
        body:terminalBody
      });

      assert.equal(response.status,409);
      assert.equal(begins,0);
      assert.equal((await store.findTask(task.id))?.currentRunId,releasedRunId);
      assert.deepEqual((await store.sandboxRuns.list()).map((run)=>run.runId),[releasedRunId]);
    }finally{
      if(previousPostgresUrl===undefined)delete process.env.POSTGRES_APP_URL;else process.env.POSTGRES_APP_URL=previousPostgresUrl;
    }
  });

  it("recovers a Terminal reservation after a pre-map crash without rerunning endpoint preflight",async(t)=>{
    const previousPostgresUrl=process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL="postgresql://app:secret@db/app";
    const store=createLocalInMemoryProductStore();
    const begin=store.beginTerminalStart.bind(store);
    let reserveWithoutMap=true,begins=0,requestHash="";
    store.beginTerminalStart=async(input)=>{
      begins+=1;
      requestHash=input.idempotency.requestHash;
      const result=await begin(input);
      if(reserveWithoutMap&&result.kind==="claimed"){
        reserveWithoutMap=false;
        return{kind:"in_progress" as const,task:result.task,run:result.run};
      }
      return result;
    };
    try{
      api=await createApiServer({
        port:0,dataRoot,builtinAdminPassword:"production-admin-password",sessionSecret:validProductionSessionSecret,
        sandboxNamespaceLimit:100,store,botifiedClient:new FakeBotifiedClient([]),botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{port:{async applyResource(){return"applied" as const;},async deleteResource(){return"deleted" as const;},async getPodReadiness(){return"not_found" as const;},async getConfigMapData(){return"not_found" as const;},async listManagedResources(){return[];},async inspectResource(){return"not_found" as const;}}}
      });
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const created=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
        prompt:"recover reservation after map crash",endpointId:auth.endpointId,
        fileLibrary:{mode:"create_new",name:"Reservation recovery files"}
      })).task;
      const task=await store.findTask(created.id as string);assert.ok(task?.currentRunId);
      const headers={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"terminal-pre-map-crash"};
      const terminalBody=await exactTerminalStartBody(store,task.id);
      const first=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:terminalBody});
      assert.equal(first.status,202);
      assert.equal(begins,1);
      t.mock.timers.enable({apis:["Date"],now:Date.now()});
      t.mock.timers.tick(31_000);
      await releaseTaskRunFixture(store,task);
      const endpoint=await store.findEndpoint(auth.endpointId);assert.ok(endpoint);
      const unavailableAt=new Date(Date.parse(endpoint.updatedAt)+1_000).toISOString();
      assert.ok(await store.updateEndpointHealth(endpoint.id,endpoint.projectId,{status:"unavailable",checkedAt:unavailableAt,errorCategory:"network"},unavailableAt,endpoint.updatedAt));

      const recovered=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:terminalBody});
      assert.equal(recovered.status,502);
      assert.equal(begins,1);
      const replayBody=await recovered.json();
      assert.deepEqual(replayBody,{
        outcome:"completed",keyDisposition:"retire",runId:task.currentRunId,
        error:{
          code:"sandbox_start_failed",message:"Sandbox could not be started",
          retryable:true,details:null,presentation:null
        }
      });
      assert.doesNotMatch(JSON.stringify(replayBody),/Endpoint is unavailable/);
      const receipt=await store.findTaskIdempotency({
        actorId:task.createdByUserId!,projectId:auth.projectId,operation:"terminal-start",
        key:"terminal-pre-map-crash",requestHash
      });
      assert.equal(receipt?.kind,"replay");
      if(receipt?.kind==="replay"){
        assert.equal(receipt.responseStatus,502);
        assert.deepEqual(receipt.responseBody,replayBody);
      }
    }finally{
      if(previousPostgresUrl===undefined)delete process.env.POSTGRES_APP_URL;else process.env.POSTGRES_APP_URL=previousPostgresUrl;
    }
  });

  it("atomically fixes a terminal failure receipt when recovered startup finds a session mismatch",async()=>{
    const previousPostgresUrl=process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL="postgresql://app:secret@db/app";
    const store=createLocalInMemoryProductStore();
    const botified=new FakeBotifiedClient([]);
    botified.stateSessionId="another-task-session";
    const begin=store.beginTerminalStart.bind(store);
    let reserveWithoutMap=true,requestHash="";
    store.beginTerminalStart=async(input)=>{
      requestHash=input.idempotency.requestHash;
      const result=await begin(input);
      if(reserveWithoutMap&&result.kind==="claimed"){
        reserveWithoutMap=false;
        return{kind:"in_progress" as const,task:result.task,run:result.run};
      }
      return result;
    };
    let terminalFailures=0;
    const failTerminal=store.failTaskSandboxStartupAtomically.bind(store);
    store.failTaskSandboxStartupAtomically=async(input)=>{
      terminalFailures+=1;
      return failTerminal(input);
    };
    const failRun=store.failSandboxRun.bind(store);
    store.failSandboxRun=async(input)=>{
      const run=await store.sandboxRuns.get(input.runId);
      if(run?.state==="starting"&&run.startupClaimToken)throw new Error("terminal-owned session mismatch must not use generic Run failure");
      return failRun(input);
    };
    const liveResources:import("../../packages/contracts/src/api.js").KubernetesResource[]=[];
    try{
      const livePort={
        async applyResource(resource:import("../../packages/contracts/src/api.js").KubernetesResource){
          const next=structuredClone(resource);
          if(next.kind==="Pod")next.metadata.uid="pod-uid-session-mismatch";
          liveResources.push(next);
          return"applied" as const;
        },
        async deleteResource(){return"deleted" as const;},
        async getPodReadiness(_namespace:string,name:string){
          const pod=liveResources.find((resource)=>resource.kind==="Pod"&&resource.metadata.name===name);
          return pod?{state:"ready" as const,podUid:String(pod.metadata.uid),podIp:"10.42.0.51"}:"not_found" as const;
        },
        async getConfigMapData(_namespace:string,name:string){
          const config=liveResources.find((resource)=>resource.kind==="ConfigMap"&&resource.metadata.name===name);
          return config?{data:structuredClone(config.data as Record<string,string>)}:"not_found" as const;
        },
        async listManagedResources(){return structuredClone(liveResources);},
        async inspectResource(ref:KubernetesResourceRef,labels:Record<string,string>){return inspectFixtureResource(liveResources,ref,labels);}
      };
      api=await createApiServer({
        port:0,dataRoot,builtinAdminPassword:"production-admin-password",sessionSecret:validProductionSessionSecret,
        sandboxNamespaceLimit:100,store,botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{readinessTimeoutMs:0,readinessPollMs:1,port:livePort}
      });
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const created=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
        prompt:"recover terminal session mismatch",endpointId:auth.endpointId,
        fileLibrary:{mode:"create_new",name:"Recovered mismatch files"}
      })).task;
      const task=await store.findTask(created.id as string);assert.ok(task?.currentRunId);
      const headers={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"terminal-session-mismatch"};
      const terminalBody=await exactTerminalStartBody(store,task.id);
      const reserved=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:terminalBody});
      assert.equal(reserved.status,202);

      const background=createApplicationServices({
        store,dataRoot,builtinAdminPassword:"production-admin-password",sessionSecret:validProductionSessionSecret,sandboxNamespaceLimit:100,
        botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,
        providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}},
        liveSandbox:{readinessTimeoutMs:0,readinessPollMs:1,port:livePort}
      });
      await background.tasks.syncActiveTasksOnce();

      const failedRun=await store.sandboxRuns.get(task.currentRunId);
      assert.equal(failedRun?.state,"failed");
      assert.equal(terminalFailures,1);
      const persisted=await store.findTaskIdempotency({
        actorId:task.createdByUserId!,projectId:task.projectId,operation:"terminal-start",
        key:"terminal-session-mismatch",requestHash
      });
      assert.equal(persisted?.kind,"replay");
      const replay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:terminalBody});
      assert.equal(replay.status,502);
      assert.deepEqual(await replay.json(),persisted?.kind==="replay"?persisted.responseBody:null);
    }finally{
      if(previousPostgresUrl===undefined)delete process.env.POSTGRES_APP_URL;else process.env.POSTGRES_APP_URL=previousPostgresUrl;
    }
  });

  it("claims the reserved Terminal Run before runtime directory preparation can fail",async()=>{
    const previousPostgresUrl=process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL="postgresql://app:secret@db/app";
    const store=createLocalInMemoryProductStore();
    let applies=0,claims=0;
    const claim=store.claimSandboxStartup.bind(store);
    store.claimSandboxStartup=async(input)=>{claims+=1;return claim(input);};
    const livePort={
      async applyResource(){applies+=1;return"applied" as const;},
      async deleteResource(){return"deleted" as const;},
      async getPodReadiness(){return"not_found" as const;},
      async getConfigMapData(){return"not_found" as const;},
      async listManagedResources(){return[];},
      async inspectResource(){return"not_found" as const;}
    };
    try{
      api=await createApiServer({
        port:0,dataRoot,builtinAdminPassword:"production-admin-password",sessionSecret:validProductionSessionSecret,sandboxNamespaceLimit:100,store,
        botifiedClient:new FakeBotifiedClient([]),botifiedServiceKeyFactory:({taskId})=>taskId,
        runtimeTickIntervalMs:60_000,
        liveSandbox:{port:livePort}
      });
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const created=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
        prompt:"directory failure after claim",endpointId:auth.endpointId,
        fileLibrary:{mode:"create_new",name:"Directory failure files"}
      })).task;
      const task=await store.findTask(created.id as string);assert.ok(task?.currentRunId);
      const project=await store.findProject(task.projectId);assert.ok(project);
      const botifiedDirectory=path.join(dataRoot,project.rootPath,"tasks",task.id,"botified");
      await rm(botifiedDirectory,{recursive:true,force:true});
      await writeFile(botifiedDirectory,"not a directory");
      const terminalBody=await exactTerminalStartBody(store,task.id);

      const response=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{
        method:"POST",
        headers:{"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"directory-failure-terminal"},
        body:terminalBody
      });

      assert.equal(response.status,202);
      const background=createApplicationServices({
        store,dataRoot,builtinAdminPassword:"production-admin-password",sessionSecret:validProductionSessionSecret,
        sandboxNamespaceLimit:100,botifiedClient:new FakeBotifiedClient([]),botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{port:livePort},
        providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}}
      });
      await background.tasks.syncActiveTasksOnce();
      const replay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{
        method:"POST",
        headers:{"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"directory-failure-terminal"},
        body:terminalBody
      });
      assert.equal(replay.status,502);
      assert.equal(claims,1);
      assert.equal(applies,0);
      const failed=await store.sandboxRuns.get(task.currentRunId);
      assert.equal(failed?.state,"failed");
      assert.equal(failed?.startupClaimToken,null);
    }finally{
      if(previousPostgresUrl===undefined)delete process.env.POSTGRES_APP_URL;else process.env.POSTGRES_APP_URL=previousPostgresUrl;
    }
  });

  it("terminal startup failure occupies capacity and replays the canonical failure",async()=>{
    const previousPostgresUrl=process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL="postgresql://app:secret@db/app";
    const store=createLocalInMemoryProductStore();
    const botified=new FakeBotifiedClient([]);
    botified.healthFailure=new Error("Botified readiness failed definitively");
    const liveResources:import("../../packages/contracts/src/api.js").KubernetesResource[]=[];
    const livePort={
      async applyResource(resource:import("../../packages/contracts/src/api.js").KubernetesResource){
        const next=structuredClone(resource);
        if(next.kind==="Pod")next.metadata.uid="pod-uid-terminal-failure";
        liveResources.push(next);
        return"applied" as const;
      },
      async deleteResource(){return"deleted" as const;},
      async getPodReadiness(_namespace:string,name:string){
        const pod=liveResources.find((resource)=>resource.kind==="Pod"&&resource.metadata.name===name);
        return pod?{state:"ready" as const,podUid:String(pod.metadata.uid),podIp:"10.42.0.61"}:"not_found" as const;
      },
      async getConfigMapData(_namespace:string,name:string){
        const config=liveResources.find((resource)=>resource.kind==="ConfigMap"&&resource.metadata.name===name);
        return config?{data:structuredClone(config.data as Record<string,string>)}:"not_found" as const;
      },
      async listManagedResources(){return structuredClone(liveResources);},
      async inspectResource(ref:KubernetesResourceRef,labels:Record<string,string>){return inspectFixtureResource(liveResources,ref,labels);}
    };
    try{
      api=await createApiServer({
        port:0,
        dataRoot,
        builtinAdminPassword:"production-admin-password",
        sessionSecret:validProductionSessionSecret,
        sandboxNamespaceLimit:100,
        runtimeTickIntervalMs:60_000,
        store,
        botifiedClient:botified,
        botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{readinessTimeoutMs:0,readinessPollMs:1,port:livePort}
      });
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const task=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{prompt:"terminal failure",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Failure files"}})).task;
      const complete=store.completeTaskIdempotency.bind(store);
      store.completeTaskIdempotency=async(input)=>{
        if(input.operation==="terminal-start"&&input.responseStatus===502)throw new Error("generic completion must not own terminal startup failure");
        return complete(input);
      };
      const headers={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"terminal-start-failure"};
      const terminalBody=await exactTerminalStartBody(store,task.id);
      const first=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:terminalBody});
      assert.equal(first.status,202);
      const background=createApplicationServices({
        store,dataRoot,builtinAdminPassword:"production-admin-password",sessionSecret:validProductionSessionSecret,
        sandboxNamespaceLimit:100,botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{readinessTimeoutMs:0,readinessPollMs:1,port:livePort},
        providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}}
      });
      await background.tasks.syncActiveTasksOnce();
      store.beginTerminalStart=async()=>{throw new Error("completed Terminal failure replay must not re-enter begin");};
      const replay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:terminalBody});
      assert.equal(replay.status,502);
      const firstBody=await replay.json();
      const exactReplay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:terminalBody});
      assert.equal(exactReplay.status,502);
      assert.deepEqual(await exactReplay.json(),firstBody);
      assert.deepEqual((firstBody as {error:{code:string;message:string;retryable:boolean;details:null}}).error,{
        code:"sandbox_start_failed",
        message:"Sandbox could not be started",
        retryable:true,
        details:null,
        presentation:(firstBody as {error:{presentation:unknown}}).error.presentation
      });
      const run=(await store.sandboxRuns.list()).find((candidate)=>candidate.taskId===task.id);
      assert.equal(run?.state,"failed");
      assert.ok(run?.releaseRequestedAt);
    }finally{
      if(previousPostgresUrl===undefined)delete process.env.POSTGRES_APP_URL;else process.env.POSTGRES_APP_URL=previousPostgresUrl;
    }
  });

  it("converges an accepted Kubernetes mutation by exact inventory reread without applying any resource twice",async()=>{
    const previousPostgresUrl=process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL="postgresql://app:secret@db/app";
    const store=createLocalInMemoryProductStore();
    const resources:import("../../packages/contracts/src/api.js").KubernetesResource[]=[];
    let mutationAborted=false,loseFirstResponse=true;
    const applyCounts=new Map<string,number>();
    const port={
      async applyResource(
        resource:import("../../packages/contracts/src/api.js").KubernetesResource,
        _labels:Record<string,string>,
        signal?:AbortSignal
      ){
        const resourceKey=`${resource.kind}/${resource.metadata.name}`;
        applyCounts.set(resourceKey,(applyCounts.get(resourceKey)??0)+1);
        const next=structuredClone(resource);
        if(next.kind==="Pod")next.metadata.uid="pod-uid-unknown-recovery";
        const existing=resources.findIndex((candidate)=>candidate.kind===resource.kind&&candidate.metadata.name===resource.metadata.name);
        if(existing>=0)resources[existing]=next;else resources.push(next);
        if(!loseFirstResponse)return"applied" as const;
        loseFirstResponse=false;
        return new Promise<"applied">((_resolve,reject)=>{
          const abort=()=>{
            mutationAborted=true;
            reject(signal?.reason??new Error("response lost after apiserver accepted the resource"));
          };
          if(signal?.aborted)abort();
          else signal?.addEventListener("abort",abort,{once:true});
        });
      },
      async deleteResource(ref:KubernetesResourceRef){
        const index=resources.findIndex((resource)=>resource.kind===ref.kind&&resource.metadata.name===ref.name&&resource.metadata.namespace===ref.namespace);
        if(index<0)return"not_found" as const;
        resources.splice(index,1);
        return"deleted" as const;
      },
      async getPodReadiness(_namespace:string,name:string){
        const pod=resources.find((resource)=>resource.kind==="Pod"&&resource.metadata.name===name);
        return pod?{state:"ready" as const,podUid:String(pod.metadata.uid),podIp:"10.42.0.21"}:"not_found" as const;
      },
      async getConfigMapData(_namespace:string,name:string){
        const config=resources.find((resource)=>resource.kind==="ConfigMap"&&resource.metadata.name===name);
        return config?{data:structuredClone(config.data as Record<string,string>)}:"not_found" as const;
      },
      async listManagedResources(){return structuredClone(resources);},
      async inspectResource(ref:KubernetesResourceRef,labels:Record<string,string>){return inspectFixtureResource(resources,ref,labels);}
    };
    try{
      api=await createApiServer({
        port:0,dataRoot,builtinAdminPassword:"production-admin-password",sessionSecret:validProductionSessionSecret,
        sandboxNamespaceLimit:100,store,botifiedClient:new FakeBotifiedClient([]),botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{port,startupActionTimeoutMs:1}
      });
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const task=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
        prompt:"accepted mutation response lost",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Unknown result files"}
      })).task;
      const headers={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"terminal-unknown-kubernetes-result"};
      const terminalBody=await exactTerminalStartBody(store,task.id);
      const response=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:terminalBody});
      assert.equal(response.status,202);
      const background=createApplicationServices({
        store,dataRoot,builtinAdminPassword:"production-admin-password",sessionSecret:validProductionSessionSecret,
        sandboxNamespaceLimit:100,botifiedClient:new FakeBotifiedClient([]),botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{port,startupActionTimeoutMs:1},
        providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}}
      });
      await background.tasks.syncActiveTasksOnce();
      const pending=(await store.sandboxRuns.list()).find((run)=>run.taskId===task.id);assert.ok(pending);
      assert.equal(mutationAborted,true);
      const active=await store.sandboxRuns.get(pending.runId);assert.ok(active);
      assert.equal(active.state,"active");
      assert.ok(active.startupConfigHash);
      assert.equal(active.startupPodUid,"pod-uid-unknown-recovery");
      assert.equal(active.startupClaimToken,null);
      assert.equal(active.startupActionDeadlineAt,null);
      assert.equal(new Set(resources.map((resource)=>`${resource.kind}/${resource.metadata.name}`)).size,6);
      assert.deepEqual([...applyCounts.values()],[1,1,1,1,1,1]);

      const replay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:terminalBody});
      assert.equal(replay.status,200);
      assert.deepEqual(await replay.json(),{outcome:"completed",keyDisposition:"retire",runId:active.runId});
    }finally{
      if(previousPostgresUrl===undefined)delete process.env.POSTGRES_APP_URL;else process.env.POSTGRES_APP_URL=previousPostgresUrl;
    }
  });

  it("fails the same claimed Run when Botified never becomes ready after Kubernetes apply",async()=>{
    const previousPostgresUrl=process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL="postgresql://app:secret@db/app";
    const store=createLocalInMemoryProductStore();
    const botified=new FakeBotifiedClient([]);
    botified.healthFailure=new Error("Botified is not ready");
    const resources:import("../../packages/contracts/src/api.js").KubernetesResource[]=[];
    let activations=0;
    const activate=store.activateTaskSandboxRun.bind(store);
    store.activateTaskSandboxRun=async(input)=>{activations+=1;return activate(input);};
    try{
      api=await createApiServer({
        port:0,dataRoot,builtinAdminPassword:"production-admin-password",
        sessionSecret:validProductionSessionSecret,sandboxNamespaceLimit:100,
        runtimeTickIntervalMs:60_000,store,botifiedClient:botified,
        botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{readinessTimeoutMs:0,readinessPollMs:1,port:{
          async applyResource(resource){
            const next=structuredClone(resource);
            if(next.kind==="Pod")next.metadata.uid="pod-uid-readiness-failure";
            resources.push(next);
            return"applied" as const;
          },
          async deleteResource(){return"deleted" as const;},
          async getPodReadiness(_namespace,name){
            const pod=resources.find((resource)=>resource.kind==="Pod"&&resource.metadata.name===name);
            return pod?{state:"ready" as const,podUid:String(pod.metadata.uid),podIp:"10.42.0.41"}:"not_found" as const;
          },
          async getConfigMapData(_namespace,name){
            const config=resources.find((resource)=>resource.kind==="ConfigMap"&&resource.metadata.name===name);
            return config?{data:structuredClone(config.data as Record<string,string>)}:"not_found" as const;
          },
          async listManagedResources(){return structuredClone(resources);},
          async inspectResource(ref,labels){return inspectFixtureResource(resources,ref,labels);}
        }}
      });
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const task=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{prompt:"Botified readiness failure",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Readiness failure files"}})).task;
      const terminalBody=await exactTerminalStartBody(store,task.id);
      const response=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{
        method:"POST",
        headers:{"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"botified-readiness-failure"},
        body:terminalBody
      });
      assert.equal(response.status,202);
      const background=createApplicationServices({
        store,dataRoot,builtinAdminPassword:"production-admin-password",sessionSecret:validProductionSessionSecret,
        sandboxNamespaceLimit:100,botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{readinessTimeoutMs:0,readinessPollMs:1,port:{
          async applyResource(resource){
            const next=structuredClone(resource);
            if(next.kind==="Pod")next.metadata.uid="pod-uid-readiness-failure";
            const index=resources.findIndex((candidate)=>candidate.kind===next.kind&&candidate.metadata.name===next.metadata.name);
            if(index>=0)resources[index]=next;else resources.push(next);
            return"applied" as const;
          },
          async deleteResource(){return"deleted" as const;},
          async getPodReadiness(_namespace,name){
            const pod=resources.find((resource)=>resource.kind==="Pod"&&resource.metadata.name===name);
            return pod?{state:"ready" as const,podUid:String(pod.metadata.uid),podIp:"10.42.0.41"}:"not_found" as const;
          },
          async getConfigMapData(_namespace,name){
            const config=resources.find((resource)=>resource.kind==="ConfigMap"&&resource.metadata.name===name);
            return config?{data:structuredClone(config.data as Record<string,string>)}:"not_found" as const;
          },
          async listManagedResources(){return structuredClone(resources);},
          async inspectResource(ref,labels){return inspectFixtureResource(resources,ref,labels);}
        }},
        providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}}
      });
      await background.tasks.syncActiveTasksOnce();
      const replay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{
        method:"POST",
        headers:{"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"botified-readiness-failure"},
        body:terminalBody
      });
      assert.equal(replay.status,502);
      assert.equal(resources.length,6);
      assert.equal(activations,0);
      const run=(await store.sandboxRuns.list()).find((candidate)=>candidate.taskId===task.id);assert.ok(run);
      assert.equal(run.state,"failed");
      assert.equal(run.startupClaimToken,null);
      assert.equal(run.startupActionDeadlineAt,null);
      assert.ok(run.releaseRequestedAt);
    }finally{
      if(previousPostgresUrl===undefined)delete process.env.POSTGRES_APP_URL;else process.env.POSTGRES_APP_URL=previousPostgresUrl;
    }
  });

  it("returns and replays the terminal Project-capacity envelope without admitted writes",async()=>{
    const store=createLocalInMemoryProductStore();
    api=await createApiServer({port:0,dataRoot,builtinAdminPassword:"admin-password",sandboxNamespaceLimit:100,store,botifiedClient:new FakeBotifiedClient([]),botifiedServiceKeyFactory:({taskId})=>taskId});
    const auth=await createProjectWithEndpoint(api.baseUrl);
    const first=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{prompt:"occupy",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Occupying files"}})).task;
    const candidate=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{prompt:"candidate",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Candidate files"}})).task;
    const occupyingTask=await store.findTask(first.id as string);
    assert.ok(occupyingTask);
    await makeTaskRunActive(store,occupyingTask,"http://botified.internal");
    const policy=await store.findProjectResourcePolicy(auth.projectId);
    assert.ok(policy);
    await store.patchProjectResourcePolicy(auth.projectId,{sandboxLimit:1},new Date(Date.parse(policy.updatedAt)+1).toISOString(),policy.updatedAt);
    store.upsertActiveProjectAlert=async()=>{throw new Error("alert sink unavailable");};

    const headers={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"terminal-capacity"};
    const terminalBody=await exactTerminalStartBody(store,candidate.id);
    const firstResponse=await fetch(`${api.baseUrl}/api/v1/tasks/${candidate.id}/terminal/start`,{method:"POST",headers,body:terminalBody});
    const firstBody=await firstResponse.json();
    const endpoint=await store.findEndpoint(auth.endpointId);assert.ok(endpoint);
    const unavailableAt=new Date(Date.parse(endpoint.updatedAt)+1_000).toISOString();
    assert.ok(await store.updateEndpointHealth(endpoint.id,endpoint.projectId,{status:"unavailable",checkedAt:unavailableAt,errorCategory:"network"},unavailableAt,endpoint.updatedAt));
    store.beginTerminalStart=async()=>{throw new Error("completed Terminal capacity replay must not re-enter begin");};
    const replay=await fetch(`${api.baseUrl}/api/v1/tasks/${candidate.id}/terminal/start`,{method:"POST",headers,body:terminalBody});
    assert.equal(firstResponse.status,409);
    assert.equal(replay.status,409);
    assert.deepEqual(await replay.json(),firstBody);
    const error=(firstBody as {error:{code:string;details:unknown;presentation:{sandboxState:{state:string}}}}).error;
    assert.equal(error.code,"project_sandbox_capacity_reached",JSON.stringify(firstBody));
    assert.deepEqual(error.details,{activeSandboxes:1,sandboxLimit:1});
    assert.equal(error.presentation.sandboxState.state,"released");
    assert.equal((await store.sandboxRuns.list()).some((run)=>run.taskId===candidate.id),false);
    const audits=(await store.queryProjectAuditEvents(auth.projectId,{limit:100})).items.filter((event)=>event.action==="sandbox.started"&&event.status==="rejected"&&event.resourceId===candidate.id);
    assert.equal(audits.length,1);
    assert.equal(audits[0]?.detail?.trigger,"terminal");
  });

  it("serializes exact terminal reservations and replays after endpoint health changes",async()=>{
    const store=createLocalInMemoryProductStore();
    api=await createApiServer({port:0,dataRoot,builtinAdminPassword:"admin-password",sandboxNamespaceLimit:100,store,botifiedClient:new FakeBotifiedClient([]),botifiedServiceKeyFactory:({taskId})=>taskId});
    const auth=await createProjectWithEndpoint(api.baseUrl);
    const occupying=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{prompt:"occupy terminal capacity",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Occupying reservation files"}})).task;
    const candidate=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{prompt:"race terminal reservation",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Racing reservation files"}})).task;
    const occupyingTask=await store.findTask(occupying.id as string);assert.ok(occupyingTask);
    await makeTaskRunActive(store,occupyingTask,"http://botified.internal");
    const policy=await store.findProjectResourcePolicy(auth.projectId);assert.ok(policy);
    await store.patchProjectResourcePolicy(auth.projectId,{sandboxLimit:1},new Date(Date.parse(policy.updatedAt)+1).toISOString(),policy.updatedAt);

    const originalFind=store.findTaskIdempotency.bind(store);
    let initialLookups=0;
    let releaseFirstLookup:()=>void=()=>undefined;
    const bothInitialLookups=new Promise<void>((resolve)=>{releaseFirstLookup=resolve;});
    let releaseSecondLookup:()=>void=()=>undefined;
    const endpointChanged=new Promise<void>((resolve)=>{releaseSecondLookup=resolve;});
    store.findTaskIdempotency=async(input)=>{
      if(input.operation==="terminal-start"&&input.key==="terminal-serialized"&&initialLookups<2){
        const result=await originalFind(input);
        assert.equal(result,null);
        initialLookups+=1;
        if(initialLookups===2)releaseFirstLookup();
        if(initialLookups===1)await bothInitialLookups;
        else await endpointChanged;
        return result;
      }
      return originalFind(input);
    };
    const originalBegin=store.beginTerminalStart.bind(store);
    let endpointWasChanged=false;
    store.beginTerminalStart=async(input)=>{
      const result=await originalBegin(input);
      if(!endpointWasChanged){
        endpointWasChanged=true;
        const endpoint=await store.findEndpoint(auth.endpointId);assert.ok(endpoint);
        const unavailableAt=new Date(Date.parse(endpoint.updatedAt)+1_000).toISOString();
        assert.ok(await store.updateEndpointHealth(endpoint.id,endpoint.projectId,{status:"unavailable",checkedAt:unavailableAt,errorCategory:"network"},unavailableAt,endpoint.updatedAt));
        releaseSecondLookup();
      }
      return result;
    };

    const headers={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"terminal-serialized"};
    const terminalBody=await exactTerminalStartBody(store,candidate.id);
    const request=()=>fetch(`${api!.baseUrl}/api/v1/tasks/${candidate.id}/terminal/start`,{method:"POST",headers,body:terminalBody});
    const [first,second]=await Promise.all([request(),request()]);
    const [firstBody,secondBody]=await Promise.all([first.json(),second.json()]);
    assert.equal(initialLookups,2);
    assert.equal(first.status,409);
    assert.equal(second.status,409);
    assert.deepEqual(secondBody,firstBody);
    assert.equal((firstBody as {error:{code:string}}).error.code,"project_sandbox_capacity_reached");
  });

  it("returns a stopped-sandbox message admission before startup and lets runtime sync deliver it once",async()=>{
    const previousPostgresUrl=process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL="postgresql://app:secret@db/app";
    const store=createLocalInMemoryProductStore();
    const botified=new class extends FakeBotifiedClient {
      private failNextState=true;
      override async readState(baseUrl:string,serviceKey:string){
        if(this.failNextState){
          this.failNextState=false;
          throw new TypeError("cold open outcome unknown");
        }
        return super.readState(baseUrl,serviceKey);
      }
    }([]);
    const resources:import("../../packages/contracts/src/api.js").KubernetesResource[]=[];
    let podSequence=0;
    let readinessReads=0;
    let configReads=0;
    let startupEntered!:()=>void;
    let continueStartup!:()=>void;
    const entered=new Promise<void>((resolve)=>{startupEntered=resolve;});
    const startupGate=new Promise<void>((resolve)=>{continueStartup=resolve;});
    let gateReleased=false;
    const liveSandbox={port:{
      async applyResource(resource:import("../../packages/contracts/src/api.js").KubernetesResource){
        const next=structuredClone(resource);
        if(next.kind==="Pod"&&!next.metadata.uid)next.metadata.uid=`pod-uid-${++podSequence}`;
        const index=resources.findIndex((candidate)=>candidate.kind===next.kind&&candidate.metadata.name===next.metadata.name);
        if(index>=0)resources[index]=next;else resources.push(next);
        startupEntered();
        if(!gateReleased)await startupGate;
        return"applied" as const;
      },
      async deleteResource(){return"deleted" as const;},
      async getPodReadiness(_namespace:string,name:string){
        readinessReads+=1;
        const pod=resources.find((resource)=>resource.kind==="Pod"&&resource.metadata.name===name);
        return pod?{state:"ready" as const,podUid:String(pod.metadata.uid),podIp:"10.42.0.17"}:"not_found" as const;
      },
      async getConfigMapData(_namespace:string,name:string){
        configReads+=1;
        const config=resources.find((resource)=>resource.kind==="ConfigMap"&&resource.metadata.name===name);
        return config?{data:structuredClone(config.data as Record<string,string>)}:"not_found" as const;
      },
      async listManagedResources(){return structuredClone(resources);},
      async inspectResource(ref:KubernetesResourceRef,labels:Record<string,string>){return inspectFixtureResource(resources,ref,labels);}
    }};
    try{
      api=await createApiServer({
        port:0,
        dataRoot,
        builtinAdminPassword:"production-admin-password",
        sessionSecret:validProductionSessionSecret,
        sandboxNamespaceLimit:100,
        runtimeTickIntervalMs:60_000,
        store,
        botifiedClient:botified,
        botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox
      });
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const task=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{prompt:"released message",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Released message files"}})).task;
      const persisted=await store.findTask(task.id as string);
      assert.ok(persisted?.currentRunId);
      await releaseTaskRunFixture(store,persisted);

      const headers={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"released-message-startup-failure"};
      const content="continue after restart";
      const request=fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/messages`,{method:"POST",headers,body:JSON.stringify({content})});
      const winner=await Promise.race([
        request.then((response)=>({kind:"response" as const,response})),
        entered.then(()=>({kind:"startup" as const}))
      ]);
      if(winner.kind==="startup"){
        gateReleased=true;
        continueStartup();
        await request;
        assert.fail("message admission waited for sandbox startup");
      }
      const first=winner.response;
      const firstBody=await first.json() as {messageId:string;disposition:string;duplicate:boolean};
      assert.equal(first.status,200);
      assert.equal(firstBody.disposition,"queued_for_active_run");
      assert.equal((await store.findTaskMessage(firstBody.messageId))?.deliveryStatus,"pending");
      assert.equal(resources.length,0);
      const currentTask=await store.findTask(task.id as string);
      assert.ok(currentTask?.currentRunId);
      const pendingRun=await store.sandboxRuns.get(currentTask.currentRunId);
      assert.equal(pendingRun?.state,"starting");
      assert.equal(pendingRun?.startupClaimToken,null);

      const background=createApplicationServices({
        store,dataRoot,builtinAdminPassword:"production-admin-password",
        sessionSecret:validProductionSessionSecret,sandboxNamespaceLimit:100,botifiedClient:botified,
        botifiedServiceKeyFactory:({taskId})=>taskId,liveSandbox,
        providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}}
      });
      const sync=background.tasks.syncActiveTasksOnce();
      await entered;
      gateReleased=true;
      continueStartup();
      await sync;
      const interruptedTask=await store.findTask(task.id as string);assert.ok(interruptedTask?.currentRunId);
      const interruptedRun=await store.sandboxRuns.get(interruptedTask.currentRunId);assert.ok(interruptedRun);
      assert.equal(interruptedRun.state,"starting");
      assert.equal(interruptedRun.startupPodUid,"pod-uid-1");
      assert.equal(interruptedRun.startupPodIp,"10.42.0.17");
      assert.equal(interruptedRun.startupClaimToken,null);
      assert.equal((await store.findTaskMessage(firstBody.messageId))?.deliveryStatus,"pending");

      const recovered=createApplicationServices({
        store,dataRoot,builtinAdminPassword:"production-admin-password",
        sessionSecret:validProductionSessionSecret,sandboxNamespaceLimit:100,botifiedClient:botified,
        botifiedServiceKeyFactory:({taskId})=>taskId,liveSandbox,
        providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}}
      });
      await new Promise((resolve)=>setTimeout(resolve,2));
      const recoveredSync=await recovered.tasks.syncActiveTasksOnce();

      const activeTask=await store.findTask(task.id as string);assert.ok(activeTask?.currentRunId);
      const activeRun=await store.sandboxRuns.get(activeTask.currentRunId);assert.ok(activeRun);
      assert.deepEqual(recoveredSync.failedTaskIds,[]);
      assert.equal(activeRun.state,"active");
      assert.equal(activeRun.startupPodUid,"pod-uid-1");
      assert.equal(activeRun.startupPodIp,"10.42.0.17");
      assert.ok(activeRun.startupConfigMapName?.endsWith(activeRun.startupConfigHash!.slice("sha256:".length,23)));
      assert.equal(resources.filter((resource)=>resource.kind==="Pod").length,1);
      const configs=resources.filter((resource)=>resource.kind==="ConfigMap").map((resource)=>
        (resource.data as Record<string,string>)["botified-config.yaml"]
      );
      assert.equal(configs.length,1);
      assert.ok(readinessReads>=2,"activation must reread the exact Pod after Botified health/state");
      assert.ok(configReads>=1,"activation must reread the exact ConfigMap bytes");
      assert.equal((await store.findTaskMessage(firstBody.messageId))?.deliveryStatus,"accepted");
      assert.equal(botified.postMessageCalls.filter((call)=>call.message===content).length,1);

      const restarted=createApplicationServices({
        store,dataRoot,builtinAdminPassword:"production-admin-password",
        sessionSecret:validProductionSessionSecret,sandboxNamespaceLimit:100,botifiedClient:botified,
        botifiedServiceKeyFactory:({taskId})=>taskId,liveSandbox,
        providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}}
      });
      assert.deepEqual((await restarted.tasks.syncActiveTasksOnce()).failedTaskIds,[]);
      assert.equal(podSequence,1);
      assert.equal(resources.filter((resource)=>resource.kind==="ConfigMap").length,1);
      assert.equal(botified.postMessageCalls.filter((call)=>call.message===content).length,1);
    }finally{
      gateReleased=true;
      continueStartup();
      if(previousPostgresUrl===undefined)delete process.env.POSTGRES_APP_URL;else process.env.POSTGRES_APP_URL=previousPostgresUrl;
    }
  });
});

async function exactTerminalStartBody(
  store:ReturnType<typeof createLocalInMemoryProductStore>,
  taskId:string
):Promise<string>{
  const task=await store.findTask(taskId);assert.ok(task);
  const run=task.currentRunId?await store.sandboxRuns.get(task.currentRunId):null;
  return JSON.stringify({expectedRunId:task.currentRunId,expectedSandboxState:run?.state??"released"});
}

function withFixtureUid(resource:KubernetesResource):KubernetesResource{
  const copy=structuredClone(resource);
  copy.metadata.uid??=`fixture-${copy.kind.toLowerCase()}-${copy.metadata.name}`;
  return copy;
}

function inspectFixtureResource(
  resources:KubernetesResource[],
  ref:KubernetesResourceRef,
  expectedLabels:Record<string,string>
){
  const resource=resources.find((candidate)=>
    candidate.kind===ref.kind&&candidate.metadata.namespace===ref.namespace&&candidate.metadata.name===ref.name
  );
  if(!resource)return"not_found" as const;
  const uid=typeof resource.metadata.uid==="string"&&resource.metadata.uid.length>0?resource.metadata.uid:null;
  if(
    !uid||
    ref.uid!==undefined&&ref.uid!==uid||
    Object.entries(expectedLabels).some(([key,value])=>resource.metadata.labels[key]!==value)
  )return"fence_mismatch" as const;
  return{state:"present" as const,resource:structuredClone(resource)};
}

async function exactReleaseBody(
  store:ReturnType<typeof createLocalInMemoryProductStore>,
  taskId:string
):Promise<string>{
  const task=await store.findTask(taskId);assert.ok(task?.currentRunId);
  return JSON.stringify({expectedRunId:task.currentRunId});
}

async function releaseTaskRunFixture(
  store:ReturnType<typeof createLocalInMemoryProductStore>,
  task:PersistedAgentTask
):Promise<void>{
  assert.ok(task.currentRunId);
  const run=await store.sandboxRuns.get(task.currentRunId);
  assert.ok(run);
  const requestedAt=new Date(Date.parse(run.updatedAt)+1).toISOString();
  const claim={
    actorId:task.createdByUserId!,
    projectId:task.projectId,
    operation:"release-sandbox" as const,
    key:`fixture-release-${run.runId}`,
    requestHash:`fixture-release-hash-${run.runId}`,
    resourceId:run.runId,
    claimToken:`fixture-release-claim-${run.runId}`,
    now:requestedAt,
    leaseExpiresAt:new Date(Date.parse(requestedAt)+60_000).toISOString()
  };
  assert.equal((await store.beginTaskIdempotency(claim)).kind,"claimed");
  const requested={...run,state:"release_requested" as const,releaseReason:"requested" as const,releaseRequestedAt:requestedAt,startupClaimToken:null,startupLeaseExpiresAt:null,cleanupClaimedAt:null,fencingToken:run.fencingToken+1,updatedAt:requestedAt};
  assert.equal(await store.requestTaskSandboxRelease({
    runId:run.runId,
    taskId:task.id,
    expectedFencingToken:run.fencingToken,
    intent:{requestedAt},
    idempotency:{actorId:claim.actorId,projectId:claim.projectId,operation:claim.operation,key:claim.key,requestHash:claim.requestHash,claimToken:claim.claimToken,responseStatus:200,responseBody:{released:true},updatedAt:requestedAt}
  }),"applied");
  const releasedAt=new Date(Date.parse(requestedAt)+1).toISOString();
  const released={...requested,state:"released" as const,releasedAt,cleanupClaimedAt:null,fencingToken:requested.fencingToken+1,updatedAt:releasedAt};
  const durationSeconds=run.startedAt===null?0:Math.max(0,(Date.parse(releasedAt)-Date.parse(run.startedAt))/1_000);
  assert.equal(await store.completeSandboxRunRelease({
    runId:run.runId,
    expectedFencingToken:requested.fencingToken,
    run:released,
    settlement:{runId:run.runId,workspaceId:run.workspaceId,projectId:run.projectId,taskId:run.taskId,fileLibraryId:run.fileLibraryId,startedByUserId:run.startedByUserId,startedAt:run.startedAt,releasedAt,durationSeconds,resources:run.resourceSnapshot,releaseReason:"requested"},
    auditEvent:{id:`audit_fixture_released_${run.runId}`,projectId:run.projectId,actorId:null,subjectUserId:run.startedByUserId,action:"sandbox.released",status:"accepted",resourceKind:"sandbox",resourceId:run.taskId,detail:{taskId:run.taskId,runId:run.runId},createdAt:releasedAt}
  }),"applied");
}

async function makeTaskRunActive(
  store: ReturnType<typeof createLocalInMemoryProductStore>,
  task: PersistedAgentTask,
  botifiedBaseUrl: string,
  runId=`run_fixture_${task.id}`
): Promise<void> {
  const timestamp = task.updatedAt;
  const project=await store.findProject(task.projectId);
  const library=task.fileLibraryId?await store.findFileLibrary(task.fileLibraryId):null;
  assert.ok(project);
  assert.ok(library);
  assert.ok(task.createdByUserId);
  const currentRun=task.currentRunId?await store.sandboxRuns.get(task.currentRunId):null;
  assert.equal(currentRun?.state??"released","released");
  const run:PersistedSandboxRunState={
    workspaceId:task.workspaceId,
    projectId:task.projectId,
    taskId:task.id,
    runId,
    namespace:"agentsmith",
    state:"starting",
    image:"agentsmith-lite/botified-runner:test",
    pvcName:"agentsmith-lite-files",
    projectSubPath:project.rootPath,
    fileLibraryRootSubPath:library.rootSubPath,
    fileLibraryId:library.id,
    startedByUserId:task.createdByUserId,
    startedAt:null,
    startupReadyAt:null,
    startupConfigMapName:`${task.id}-config-fixture`,
    startupConfigHash:"sha256:fixture",
    startupPodUid:`${task.id}-pod-uid`,
    startupPodIp:"10.42.0.17",
    startupActionDeadlineAt:null,
    botifiedPort:3099,
    resourceNames:{
      pod:`${task.id}-pod`,
      service:`${task.id}-service`,
      configMap:`${task.id}-config-fixture`,
      secret:`${task.id}-secret`,
      serviceAccount:`${task.id}-account`,
      networkPolicy:`${task.id}-policy`
    },
    serviceKeySecretRef:{name:`${task.id}-secret`,key:"BOTIFIED_SERVICE_KEY"},
    directories:{libraryHome:"/workspace/task/home",botified:"/workspace/task/botified"},
    resourceLimits:{cpuRequest:"250m",memoryRequest:"512Mi",cpuLimit:"1",memoryLimit:"1Gi"},
    resourceSnapshot:{cpuRequestMillis:"250",memoryRequestBytes:"536870912",cpuLimitMillis:"1000",memoryLimitBytes:"1073741824"},
    failureCode:null,
    failureCause:null,
    fencingToken:1,
    cleanupClaimedAt:null,
    cleanupAttempts:0,
    lastCleanupAt:null,
    lastCleanupError:null,
    releaseReason:null,
    releaseRequestedAt:null,
    failedAt:null,
    releasedAt:null,
    createdAt:timestamp,
    updatedAt:timestamp
  };
  const reserved=await store.restartTaskSandboxAtomically({
    expectedReleasedRunId:task.currentRunId,
    task:{...task,currentRunId:runId},
    runtimeState:{botifiedBaseUrl},
    sandboxRun:run,
    reservedAt:timestamp,
    admission:{namespace:run.namespace,namespaceLimit:100},
    idempotency:{actorId:task.createdByUserId!,projectId:task.projectId,operation:"terminal-start",key:`fixture-${runId}`,requestHash:`fixture-hash-${runId}`,resourceId:task.id,claimToken:`fixture-claim-${runId}`,now:timestamp,leaseExpiresAt:new Date(Date.parse(timestamp)+60_000).toISOString()},
    rejectionPresentation:{} as import("../../packages/contracts/src/api.js").TaskPresentation,
    rejectedAuditEvent:{id:`audit_fixture_rejected_${task.id}`,projectId:task.projectId,actorId:task.createdByUserId!,action:"sandbox.started",status:"rejected",resourceKind:"sandbox",resourceId:task.id,detail:{taskId:task.id,trigger:"terminal"},createdAt:timestamp}
  });
  assert.equal(reserved.kind,"restarted");
  assert.ok(await store.markTaskSandboxStartupReady({
    taskId:task.id,runId,expectedFencingToken:run.fencingToken,readyAt:timestamp
  }));
  const startupClaimToken=`startup_claim_${task.id}`;
  assert.equal((await store.claimSandboxStartup({
    taskId:task.id,
    runId,
    expectedFencingToken:run.fencingToken,
    claimToken:startupClaimToken,
    claimedAt:timestamp,
    leaseExpiresAt:new Date(Date.parse(timestamp)+60_000).toISOString()
  })).kind,"claimed");
  const readinessDeadlineAt=new Date(Date.parse(timestamp)+60_000).toISOString();
  assert.ok(await store.beginSandboxStartupAction({
    taskId:task.id,runId,expectedFencingToken:run.fencingToken,
    claimToken:startupClaimToken,actionDeadlineAt:readinessDeadlineAt,startedAt:timestamp
  }));
  const activated = await store.activateTaskSandboxRun({
    taskId:task.id,
    runId,
    expectedFencingToken:run.fencingToken,
    startupClaimToken,
    actionDeadlineAt:readinessDeadlineAt,
    expectedConfigMapName:run.startupConfigMapName!,
    expectedConfigHash:run.startupConfigHash!,
    expectedPodUid:run.startupPodUid!,
    expectedPodIp:run.startupPodIp!,
    activatedAt:timestamp,
    auditEvent:{
      id:`audit_started_${runId}`,
      projectId:task.projectId,
      actorId:null,
      subjectUserId:task.createdByUserId,
      action:"sandbox.started",
      status:"accepted",
      resourceKind:"sandbox",
      resourceId:task.id,
      detail:{taskId:task.id,runId},
      createdAt:timestamp
    }
  });
  assert.notEqual(activated.kind, "conflict");
}

async function createProjectWithEndpoint(baseUrl: string, password = "admin-password") {
  let idempotencySequence = 0;
  await fetch(baseUrl + "/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password })
  });
  const login = await fetch(baseUrl + "/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "admin@agentsmith-lite.local",
      password
    })
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const csrf = (await login.json() as { csrfToken: string }).csrfToken;

  const request = async (method: string, pathname: string, body?: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json", cookie };
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      headers["x-csrf-token"] = csrf;
    }
    if (pathname.includes("/tasks") && ["POST", "PATCH", "DELETE"].includes(method)) {
      headers["idempotency-key"] = `task-events-${++idempotencySequence}`;
    }
    if (method === "POST" && (pathname === "/api/v1/workspaces" || /^\/api\/v1\/workspaces\/[^/]+\/projects$/.test(pathname) || /^\/api\/v1\/projects\/[^/]+\/(credentials|endpoints)$/.test(pathname))) {
      headers["idempotency-key"] = crypto.randomUUID();
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    return fetch(baseUrl + pathname, init);
  };
  const requestJson = async (method: string, pathname: string, body?: unknown) => {
    const response = await request(method, pathname, body);
    if (response.status !== 200) {
      assert.fail(await response.text());
    }
    return response.json();
  };

  const workspace = (await requestJson("POST", "/api/v1/workspaces", { name: "Ops" })).workspace;
  const project = await requestJson("POST", `/api/v1/workspaces/${workspace.id}/projects`, { name: "Demo" });
  const credential = await requestJson("POST", `/api/v1/projects/${project.id}/credentials`, { name: "Mock credential", baseUrl: "https://models.example.com/v1", secret: "sk-real-model-key" });
  const endpoint = await requestJson("POST", `/api/v1/projects/${project.id}/endpoints`, {
    name: "Mock endpoint",
    protocol: "openai_chat_completions",
    baseUrl: "https://models.example.com/v1",
    model: "gpt-compatible",
    credentialId: credential.id,
    capabilities: ["text", "tool_calls"],
    requestTimeoutSecs: 30
  });

  return {
    workspaceId: workspace.id as string,
    projectId: project.id as string,
    endpointId: endpoint.id as string,
    cookie,
    csrf,
    request,
    requestJson
  };
}

async function listenTerminalTcpServer(
  sockets:Set<net.Socket>,
  onConnection:(socket:net.Socket)=>void
):Promise<net.Server>{
  const server=net.createServer((socket)=>{
    sockets.add(socket);
    socket.once("close",()=>sockets.delete(socket));
    onConnection(socket);
  });
  server.listen({host:"127.0.0.1",port:3110});
  await once(server,"listening");
  return server;
}

async function rejectedWebSocketStatus(url:string,cookie:string,origin?:string):Promise<number>{
  return new Promise<number>((resolve,reject)=>{
    const socket=new WebSocket(url,{headers:{cookie,...(origin?{origin}:{})}});
    socket.once("unexpected-response",(_request,response)=>{const status=response.statusCode;response.resume();status===undefined?reject(new Error("Terminal rejection had no HTTP status")):resolve(status);});
    socket.once("open",()=>{socket.close();reject(new Error("Terminal WebSocket unexpectedly opened"));});
    socket.once("error",()=>undefined);
  });
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForTerminalCapability(auth:Awaited<ReturnType<typeof createProjectWithEndpoint>>,taskId:string,expected:boolean):Promise<void>{
  for(let attempt=0;attempt<20;attempt+=1){
    const snapshot=await auth.requestJson("GET",`/api/v1/tasks/${taskId}/interactions`);
    if(snapshot.presentation.capabilities.openTerminal===expected)return;
    await new Promise<void>((resolve)=>setImmediate(resolve));
  }
  assert.fail(`Terminal capability did not become ${expected}`);
}

class DeferredDestroySocket extends net.Socket{
  readonly writes:string[]=[];
  private finishDestroy:(()=>void)|undefined;

  override write:net.Socket["write"]=((chunk:Uint8Array|string)=>{
    this.writes.push(Buffer.from(chunk).toString("utf8"));
    return true;
  }) as net.Socket["write"];

  override _destroy(error:Error|null,callback:(error?:Error|null)=>void):void{
    this.finishDestroy=()=>{
      callback(error);
      this.emit("close",Boolean(error));
    };
  }

  completeDestroy():void{
    assert.ok(this.finishDestroy,"Socket destroy was not requested");
    const finish=this.finishDestroy;
    this.finishDestroy=undefined;
    finish();
  }
}

class FakeBotifiedClient implements BotifiedRuntimeHttpClient {
  readonly postMessageCalls: Array<{ baseUrl: string; serviceKey: string; message: string }> = [];
  readonly readStateCalls: Array<{ baseUrl: string; serviceKey: string }> = [];
  readonly readTimelineCalls: Array<{ baseUrl: string; serviceKey: string; cursor: string | undefined }> = [];
  readonly downloadFileCalls: Array<{ baseUrl: string; serviceKey: string; fileId: string }> = [];
  readonly abortCalls:Array<{baseUrl:string;serviceKey:string}>=[];
  readonly downloads: Record<string, Uint8Array> = {};
  abortError: unknown;
  postMessageError: unknown;
  abortWait: Promise<void> | undefined;
  previewFailure: unknown;
  healthFailure: unknown;
  previewSignal: AbortSignal | undefined;
  previewWaitForAbort = false;
  timelineSessionId: string | undefined;
  stateSessionId: string | undefined;
  forceIdle = false;
  runtimeTimelineCursor="idle-cursor";

  constructor(private readonly timelineReads: BotifiedTimelineReadResult[]) {}

  async health(): Promise<{ status: "ok" }> {
    if(this.healthFailure)throw this.healthFailure;
    return { status: "ok" };
  }

  async postMessage(baseUrl: string, serviceKey: string, input: BotifiedMessageInput): Promise<BotifiedMessageResult> {
    this.postMessageCalls.push({baseUrl,serviceKey,message:input.text});
    if(this.postMessageError)throw this.postMessageError;
    return {
      type:"ordinary",
      kind:"input_queued",
      inputId:`input:${input.messageId}`,
      messageId:input.messageId,
      timelineCursor:"post-cursor",
      queueLength:1,
      state:"running"
    };
  }

  async readState(baseUrl: string, serviceKey: string) {
    this.readStateCalls.push({ baseUrl, serviceKey });
    const sessionId=this.stateSessionId??serviceKey;
    const idle=this.forceIdle||this.postMessageCalls.length===0;
    return{
      sessionId,
      snapshot:{
        session_id:sessionId,queue_length:idle?0:1,
        tasks:{running:idle?0:1,cancelling:0,pending_callbacks:0,pending_asks:0},
        active_items:[]
      },
      state:idle?"idle" as const:"running" as const,
      timelineCursor:this.runtimeTimelineCursor,
      activeItems:[]
    };
  }

  async readTimeline(baseUrl: string, serviceKey: string, cursor?: string): Promise<BotifiedTimelineReadResult> {
    this.readTimelineCalls.push({ baseUrl, serviceKey, cursor });
    const next = this.timelineReads.shift();
    if (next) {
      if (next.status === "gap") return next;
      return { ...next, events: next.events.map((event) => ({ ...(event as Record<string,unknown>), session_id: this.timelineSessionId??serviceKey })) };
    }
    const result: BotifiedTimelineReadResult = { status: "ok", events: [], nextCursor:cursor??"idle-cursor" };
    return result;
  }

  enqueueTimeline(result:BotifiedTimelineReadResult):void{this.timelineReads.push(result);}

  async uploadFile(_baseUrl: string, _serviceKey: string, _file: BotifiedUploadFileInput): Promise<BotifiedUploadFileResult> {
    return { files: [] };
  }

  async downloadFile(baseUrl: string, serviceKey: string, fileId: string) {
    this.downloadFileCalls.push({ baseUrl, serviceKey, fileId });
    const bytes = this.downloads[fileId] ?? new Uint8Array();
    return {
      bytes,
      filename: `${fileId}.txt`,
      mimeType: "application/octet-stream",
      sizeBytes: bytes.byteLength
    };
  }

  async abort(baseUrl:string,serviceKey:string):Promise<BotifiedAbortResult>{
    this.abortCalls.push({baseUrl,serviceKey});
    await this.abortWait;
    if (this.abortError) {
      throw this.abortError;
    }
    return{ok:true,state:"aborting",queueLength:0};
  }

  async *streamLlmTextPreview(_baseUrl:string,_serviceKey:string,options:BotifiedLlmTextPreviewOptions={}) {
    this.previewSignal = options.signal;
    if (this.previewFailure) throw this.previewFailure;
    if (this.previewWaitForAbort) {
      await new Promise<void>((_resolve, reject) => {
        const terminated = () => reject(new TypeError("terminated"));
        if (options.signal?.aborted) terminated();
        else options.signal?.addEventListener("abort", terminated, { once:true });
      });
    }
  }
}
