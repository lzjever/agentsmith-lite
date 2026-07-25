import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createTestApiServer as createRawApiServer, type TestApiServerOptions as ApiServerOptions, type RunningApiServer } from "../../packages/api-entry-node/src/server.js";
import {
  type BotifiedAbortResult,
  type BotifiedDeliveryMessageInput,
  type BotifiedDeliveryReceipt,
  type BotifiedPostMessageResult,
  type BotifiedRuntimeHttpClient,
  type BotifiedLlmTextPreviewOptions,
  type BotifiedTimelineReadResult,
  type BotifiedUploadFileInput,
  type BotifiedUploadFileResult
} from "../../packages/ports/src/botified.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { SandboxLifecycleService } from "../../packages/application/src/sandboxLifecycleService.js";
import type { KubernetesResourceRef } from "../../packages/sandbox-controller/src/kubernetesPort.js";
import type { PersistedAgentTask, PersistedSandboxRunState } from "../../packages/ports/src/store.js";
import { WebSocket, WebSocketServer } from "ws";

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
  let terminalUpstream: WebSocketServer | undefined;
  let dataRoot = "";

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-task-api-"));
  });

  afterEach(async () => {
    if (terminalUpstream) {
      for (const client of terminalUpstream.clients) client.terminate();
      await new Promise<void>((resolve) => terminalUpstream!.close(() => resolve()));
      terminalUpstream = undefined;
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
      stopWork: false,
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
    assert.deepEqual(detail.capabilities,{sendMessage:false,editQueuedMessage:false,abortTurn:false,stopWork:false,openTerminal:false,releaseSandbox:false,editTask:false,archiveTask:false,deleteTask:false});
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

  it("resolves background work stop through server-side interaction correlation", async () => {
    const store = createLocalInMemoryProductStore();
    const botified = new FakeBotifiedClient([]);
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", sandboxNamespaceLimit:100, botifiedClient:botified, botifiedServiceKeyFactory:({taskId})=>taskId, store });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const created = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, { prompt:"background", endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Task files"} });
    const task = await store.findTask(created.task.id as string); assert.ok(task);
    await makeTaskRunActive(store, task, "http://botified.internal");
    const interaction = { id:"interaction-work", revision:1, taskId:task.id, kind:"background_task" as const, title:"Background task", body:null, contentMode:"none" as const, position:1, occurredAt:task.createdAt, updatedAt:task.createdAt, executionStatus:"running" as const, deliveryStatus:null, label:"Compile", workSummary:null, result:null, error:null, detailsOmitted:false, canStop:true };
    await store.persistTaskInteractionMutation({ taskId:task.id, changes:[{ sourceKind:"botified", sourceId:"evt_test_1", sourceRevision:0, interaction, correlation:{workTaskId:"botified-work-1"} }] });

    const stopped = await auth.requestJson("POST", `/api/v1/tasks/${task.id}/work/${interaction.id}/stop`, {});
    assert.equal(stopped.workTaskId, "botified-work-1");
    assert.deepEqual(botified.stopCalls, ["botified-work-1"]);
  });

  it("rejects a second interactive terminal and releases occupancy after an abnormal close", async () => {
    terminalUpstream = new WebSocketServer({ port:0 });
    await once(terminalUpstream, "listening");
    const upstreamAddress = terminalUpstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress !== "string");

    const store = createLocalInMemoryProductStore();
    const botified = new FakeBotifiedClient([]);
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", sandboxNamespaceLimit:100, botifiedClient:botified, botifiedServiceKeyFactory:({taskId})=>taskId, terminalAccessRecheckMs:20, store });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const created = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, { prompt:"terminal occupancy", endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Task files"} });
    const task = await store.findTask(created.task.id as string); assert.ok(task);
    await makeTaskRunActive(store, task, `http://127.0.0.1:${upstreamAddress.port}`);
    const terminalUrl = `${api.baseUrl.replace(/^http/, "ws")}/api/v1/tasks/${task.id}/terminal/ws`;

    assert.equal((await auth.requestJson("GET", `/api/v1/tasks/${task.id}/interactions`)).presentation.capabilities.openTerminal, true);
    const first = new WebSocket(terminalUrl, { headers:{ cookie:auth.cookie } });
    await once(first, "open");
    assert.equal((await auth.requestJson("GET", `/api/v1/tasks/${task.id}/interactions`)).presentation.capabilities.openTerminal, false);

    const secondStatus = await rejectedWebSocketStatus(terminalUrl, auth.cookie);
    assert.equal(secondStatus, 403);
    assert.equal(first.readyState, WebSocket.OPEN);

    const revoked = once(first, "close");
    await store.setWorkspaceLifecycleStatus(auth.workspaceId, "archived", new Date().toISOString());
    const [code, reason] = await within(revoked, 500, "Terminal stayed open after workspace access changed");
    assert.equal(code, 1008);
    assert.equal(String(reason), "Task terminal access changed");
    assert.equal((await auth.requestJson("GET", `/api/v1/tasks/${task.id}/interactions`)).presentation.capabilities.openTerminal, false);

    await store.setWorkspaceLifecycleStatus(auth.workspaceId, "active", new Date().toISOString());
    await waitForTerminalCapability(auth, task.id, true);

    const replacement = new WebSocket(terminalUrl, { headers:{ cookie:auth.cookie } });
    await once(replacement, "open");
    const replacementClosed = once(replacement, "close");
    replacement.close();
    await replacementClosed;
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

  it("forwards terminal input sent while the Botified socket is connecting", async () => {
    terminalUpstream = new WebSocketServer({ port:0 });
    await once(terminalUpstream, "listening");
    const upstreamAddress = terminalUpstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
    const received = new Promise<string>((resolve) => {
      terminalUpstream!.once("connection", (socket) => socket.once("message", (data) => resolve(String(data))));
    });

    const store = createLocalInMemoryProductStore();
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", sandboxNamespaceLimit:100, botifiedClient:new FakeBotifiedClient([]), botifiedServiceKeyFactory:({taskId})=>taskId, store });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const created = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, { prompt:"terminal input", endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Task files"} });
    const task = await store.findTask(created.task.id as string); assert.ok(task);
    await makeTaskRunActive(store, task, `http://127.0.0.1:${upstreamAddress.port}`);

    const client = new WebSocket(`${api.baseUrl.replace(/^http/, "ws")}/api/v1/tasks/${task.id}/terminal/ws`, { headers:{ cookie:auth.cookie } });
    await once(client, "open");
    const frame = JSON.stringify({ op:"stdin", data:"ZWNobyByZWFkeQo=" });
    client.send(frame);
    const forwarded = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Terminal frame was dropped before upstream connected")), 1_000);
      void received.then((value) => { clearTimeout(timeout); resolve(value); }, reject);
    });
    assert.equal(forwarded, frame);
    const closed = once(client, "close");
    client.close();
    await closed;
  });

  it("closes a terminal connection when client input exceeds the upstream buffer", async () => {
    terminalUpstream = new WebSocketServer({ port:0 });
    await once(terminalUpstream, "listening");
    const upstreamAddress = terminalUpstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
    const upstreamConnected = new Promise<void>((resolve) => terminalUpstream!.once("connection", () => resolve()));

    const store = createLocalInMemoryProductStore();
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", sandboxNamespaceLimit:100, botifiedClient:new FakeBotifiedClient([]), botifiedServiceKeyFactory:({taskId})=>taskId, store });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const created = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, { prompt:"terminal oversized input", endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Task files"} });
    const task = await store.findTask(created.task.id as string); assert.ok(task);
    await makeTaskRunActive(store, task, `http://127.0.0.1:${upstreamAddress.port}`);

    const client = new WebSocket(`${api.baseUrl.replace(/^http/, "ws")}/api/v1/tasks/${task.id}/terminal/ws`, { headers:{ cookie:auth.cookie } });
    await once(client, "open");
    await upstreamConnected;
    const closeCode = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Oversized terminal input did not close the proxy connection")), 1_000);
      client.once("close", (code) => { clearTimeout(timeout); resolve(code); });
    });
    client.send(Buffer.alloc(65 * 1024));
    assert.equal(await closeCode, 1009);
  });

  it("closes a terminal connection when one upstream output frame exceeds the proxy buffer", async () => {
    terminalUpstream = new WebSocketServer({ port:0 });
    await once(terminalUpstream, "listening");
    const upstreamAddress = terminalUpstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
    terminalUpstream.once("connection", (socket) => socket.send(Buffer.alloc(300 * 1024)));

    const store = createLocalInMemoryProductStore();
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", sandboxNamespaceLimit:100, botifiedClient:new FakeBotifiedClient([]), botifiedServiceKeyFactory:({taskId})=>taskId, store });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const created = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, { prompt:"terminal output", endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Task files"} });
    const task = await store.findTask(created.task.id as string); assert.ok(task);
    await makeTaskRunActive(store, task, `http://127.0.0.1:${upstreamAddress.port}`);

    const client = new WebSocket(`${api.baseUrl.replace(/^http/, "ws")}/api/v1/tasks/${task.id}/terminal/ws`, { headers:{ cookie:auth.cookie } });
    const closeCode = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Oversized terminal output did not close the proxy connection")), 1_000);
      client.once("close", (code) => { clearTimeout(timeout); resolve(code); });
    });
    await once(client, "open");
    assert.equal(await closeCode, 1009);
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
    assert.deepEqual(endpointDisabled.presentation.capabilities,{sendMessage:false,editQueuedMessage:false,abortTurn:false,stopWork:false,openTerminal:false,releaseSandbox:true,editTask:true,archiveTask:false,deleteTask:false});

    await store.updateEndpoint(endpoint);
    const project=await store.findProject(task.projectId);assert.ok(project);const owner=await store.findProjectMembership(task.projectId,project.ownerUserId);assert.ok(owner);
    await store.updateProjectMembership({...owner,role:"viewer",updatedAt:new Date(Date.parse(owner.updatedAt)+1_000).toISOString()});
    const viewer = await auth.requestJson("GET",`/api/v1/tasks/${task.id}/interactions`);
    assert.equal(viewer.items.length,initial.items.length);
    assert.deepEqual(viewer.presentation.capabilities,{sendMessage:false,editQueuedMessage:false,abortTurn:false,stopWork:false,openTerminal:false,releaseSandbox:false,editTask:false,archiveTask:false,deleteTask:false});

    await store.updateProjectMembership(owner);
    const findCredential = store.findStoredProjectCredential.bind(store);
    store.findStoredProjectCredential = async (projectId,id) => id === endpoint.credentialId ? null : findCredential(projectId,id);
    const credentialDisabled = await auth.requestJson("GET",`/api/v1/tasks/${task.id}/interactions`);
    assert.equal(credentialDisabled.items.length,initial.items.length);
    assert.equal(credentialDisabled.presentation.capabilities.sendMessage,false);
    assert.equal(credentialDisabled.presentation.capabilities.openTerminal,false);
  });

  it("replays the fixed accepted message receipt after background and capability changes",async()=>{
    const store=createLocalInMemoryProductStore();
    const botified=new FakeBotifiedClient([]);
    api=await createApiServer({port:0,dataRoot,builtinAdminPassword:"admin-password", sandboxNamespaceLimit:100,botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,runtimeTickIntervalMs:60_000,store});
    const auth=await createProjectWithEndpoint(api.baseUrl);
    const created=await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{prompt:"background replay",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Replay files"}});
    const task=await store.findTask(created.task.id as string);assert.ok(task);
    await makeTaskRunActive(store,task,"http://botified.internal");
    const current=await store.findTask(task.id);assert.ok(current?.currentRunId);
    const project=await store.findProject(task.projectId);assert.ok(project);const owner=await store.findProjectMembership(task.projectId,project.ownerUserId);assert.ok(owner);
    const content="deliver after request interruption",key="background-message-key",messageId="message_background_replay";
    const requestHash=createHash("sha256").update(JSON.stringify({content,taskId:task.id}),"utf8").digest("base64url");
    const timestamp=new Date().toISOString();
    const pending={
      id:messageId,
      taskId:task.id,
      actorId:owner.userId,
      content,
      deliveryKey:`delivery_${messageId}`,
      requestHash:createHash("sha256").update(content,"utf8").digest("base64url"),
      claimToken:null,
      receipt:null,
      timelineCursor:null,
      deliveryStatus:"pending" as const,
      claimedAt:null,
      leaseExpiresAt:null,
      attemptCount:0,
      nextRetryAt:null,
      safeError:null,
      createdAt:timestamp,
      updatedAt:timestamp,
      deletedAt:null
    };
    const fixedResponseBody={kind:"task_message" as const,messageId,taskId:task.id,projectId:task.projectId,actorId:owner.userId,receipt:{
      messageId,disposition:"queued_for_active_run" as const,duplicate:false,queuedMessage:null,interaction:null,
      presentation:(await auth.requestJson("GET",`/api/v1/tasks/${task.id}/detail`))
    }};
    const persisted=await store.createTaskMessageAtomically({
      taskId:task.id,
      expectedCurrentRunId:current.currentRunId,
      message:pending,
      idempotency:{actorId:owner.userId,projectId:task.projectId,operation:"message",key,requestHash,resourceId:messageId,claimToken:"claim_background_replay",now:timestamp,leaseExpiresAt:new Date(Date.parse(timestamp)+60_000).toISOString()},
      auditEvent:{id:"audit_background_replay",projectId:task.projectId,actorId:owner.userId,action:"task.message.create",status:"accepted",resourceKind:"task",resourceId:task.id,detail:{taskId:task.id,messageId,deliveryStatus:"pending"},createdAt:timestamp},
      admission:{namespace:"agentsmith",namespaceLimit:100},
      rejectionPresentation:{} as import("../../packages/contracts/src/api.js").TaskPresentation,
      rejectedAuditEvent:{id:"audit_background_replay_rejected",projectId:task.projectId,actorId:owner.userId,action:"sandbox.started",status:"rejected",resourceKind:"sandbox",resourceId:task.id,detail:{taskId:task.id,trigger:"task_message"},createdAt:timestamp},
      responseStatus:200,
      responseBody:fixedResponseBody,
      interactionChange:{sourceKind:"product",sourceId:`message:${messageId}`,sourceRevision:0,interaction:{id:`interaction_${messageId}`,revision:1,taskId:task.id,kind:"user_message",title:"You",body:content,contentMode:"full",position:0,occurredAt:timestamp,updatedAt:timestamp,actorId:owner.userId,status:"pending"}}
    });
    assert.equal(persisted.kind,"created");
    const headers={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":key};
    const acceptedReplay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/messages`,{method:"POST",headers,body:JSON.stringify({content})});
    assert.equal(acceptedReplay.status,200);
    assert.equal(((await acceptedReplay.json()) as {duplicate:boolean}).duplicate,false);

    const background=createApplicationServices({store,dataRoot,builtinAdminPassword:"admin-password", sandboxNamespaceLimit:100,botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}}});
    await background.tasks.syncActiveTasksOnce();
    assert.deepEqual(await store.beginTaskIdempotency({actorId:owner.userId,projectId:task.projectId,operation:"message",key,requestHash,resourceId:"unused-replay-resource",claimToken:"unused-replay-claim",now:new Date().toISOString(),leaseExpiresAt:new Date(Date.now()+60_000).toISOString()}),{
      kind:"replay",
      resourceId:messageId,
      responseStatus:200,
      responseBody:fixedResponseBody
    });
    const replay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/messages`,{method:"POST",headers,body:JSON.stringify({content})});
    assert.equal(replay.status,200);
    const replayBody=await replay.json() as {duplicate:boolean;messageId:string;presentation:{sandboxState:{state:string;runId:string|null};capabilities:{sendMessage:boolean;releaseSandbox:boolean}}};
    assert.equal(replayBody.duplicate,false);
    assert.equal(replayBody.messageId,messageId);
    assert.deepEqual(replayBody.presentation.sandboxState,{state:"active",runId:current.currentRunId,cause:null});
    assert.equal(replayBody.presentation.capabilities.sendMessage,true);
    assert.equal(replayBody.presentation.capabilities.releaseSandbox,true);
    assert.equal((await store.listTaskMessages(task.id)).filter((message)=>message.content===content).length,1);
    assert.equal(botified.postMessageCalls.filter((call)=>call.message===content).length,1);

    const endpoint=await store.findEndpoint(task.endpointId);assert.ok(endpoint);
    await store.updateEndpoint({...endpoint,capabilities:["text"],updatedAt:new Date(Date.parse(endpoint.updatedAt)+1_000).toISOString()});
    const capabilityReplay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/messages`,{method:"POST",headers,body:JSON.stringify({content})});
    assert.equal(capabilityReplay.status,200);
    const capabilityBody=await capabilityReplay.json() as {duplicate:boolean;presentation:{task:{endpointId:string};capabilities:{sendMessage:boolean;openTerminal:boolean;releaseSandbox:boolean}}};
    assert.deepEqual(capabilityBody,replayBody);
    assert.equal((await store.listTaskMessages(task.id)).filter((message)=>message.content===content).length,1);
    assert.equal(botified.postMessageCalls.filter((call)=>call.message===content).length,1);
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
      {id:"message_not_ready_tick",taskId:task.id,actorId:task.createdByUserId??null,content:"wait for readiness",deliveryKey:"delivery_message_not_ready_tick",requestHash:"not-ready-hash",claimToken:null,receipt:null,timelineCursor:null,deliveryStatus:"pending",claimedAt:null,leaseExpiresAt:null,attemptCount:0,nextRetryAt:null,safeError:null,createdAt:timestamp,updatedAt:timestamp,deletedAt:null},
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
                getPodReadiness: async () => "ready" as const,
                listManagedResources: async () => []
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
        getPodReadiness: async () => "ready" as const,
        listManagedResources: async () => []
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
        getPodReadiness: async () => "ready" as const,
        listManagedResources: async () => []
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
    try{
      api=await createApiServer({port:0,dataRoot,builtinAdminPassword:"production-admin-password",sessionSecret:validProductionSessionSecret,sandboxNamespaceLimit:100,store:createLocalInMemoryProductStore(),botifiedClient:new FakeBotifiedClient([]),botifiedServiceKeyFactory:({taskId})=>taskId,liveSandbox:{port:{async applyResource(resource){resources.push(structuredClone(resource));return"applied" as const;},async deleteResource(){return"deleted" as const;},async getPodReadiness(){return"ready" as const;},async listManagedResources(){return structuredClone(resources);}}}});
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const task=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{prompt:"release through API",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Task files"}})).task;
      assert.equal((await auth.requestJson("GET",`/api/v1/tasks/${task.id}/detail`)).capabilities.releaseSandbox,true);
      assert.equal((await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/sandbox/release`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status,401);
      const baseHeaders={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf};
      assert.equal((await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/sandbox/release`,{method:"POST",headers:baseHeaders,body:"{}"})).status,400);
      const headers={...baseHeaders,"idempotency-key":"release-api-key"};
      const first=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/sandbox/release`,{method:"POST",headers,body:"{}"});const firstBody=await first.json();
      const replay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/sandbox/release`,{method:"POST",headers,body:"{}"});const replayBody=await replay.json();
      assert.equal(first.status,200);assert.equal(replay.status,200);assert.deepEqual(replayBody,firstBody);assert.equal((firstBody as {presentation:{sandboxState:{state:string}}}).presentation.sandboxState.state,"release_requested");
    }finally{if(previousPostgresUrl===undefined)delete process.env.POSTGRES_APP_URL;else process.env.POSTGRES_APP_URL=previousPostgresUrl;}
  });

  it("starts a terminal only through the JSON command and exactly replays its receipt",async(t)=>{
    const previousPostgresUrl=process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL="postgresql://app:secret@db/app";
    const store=createLocalInMemoryProductStore();
    const resources:import("../../packages/contracts/src/api.js").KubernetesResource[]=[];
    let startupEntered!:()=>void;
    let continueStartup!:()=>void;
    const entered=new Promise<void>((resolve)=>{startupEntered=resolve;});
    const startupGate=new Promise<void>((resolve)=>{continueStartup=resolve;});
    try{
      api=await createApiServer({
        port:0,
        dataRoot,
        builtinAdminPassword:"production-admin-password",
        sessionSecret:validProductionSessionSecret,
        sandboxNamespaceLimit:100,
        store,
        botifiedClient:new FakeBotifiedClient([]),
        botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{port:{
          async applyResource(resource){resources.push(structuredClone(resource));startupEntered();await startupGate;return"applied" as const;},
          async deleteResource(){return"deleted" as const;},
          async getPodReadiness(){return"ready" as const;},
          async listManagedResources(){return structuredClone(resources);}
        }}
      });
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const task=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{prompt:"terminal start",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Terminal files"}})).task;
      const pathName=`/api/v1/tasks/${task.id}/terminal/start`;
      assert.equal((await fetch(api.baseUrl+pathName,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status,401);
      const baseHeaders={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf};
      assert.equal((await fetch(api.baseUrl+pathName,{method:"POST",headers:baseHeaders,body:"{}"})).status,400);
      assert.equal((await fetch(api.baseUrl+pathName,{method:"POST",headers:{...baseHeaders,"idempotency-key":"terminal-start-body"},body:JSON.stringify({unexpected:true})})).status,400);

      const runBefore=(await store.sandboxRuns.list()).find((run)=>run.taskId===task.id);
      assert.equal(runBefore?.state,"starting");
      assert.equal(await rejectedWebSocketStatus(`${api.baseUrl.replace(/^http/,"ws")}/api/v1/tasks/${task.id}/terminal/ws`,auth.cookie),403);
      assert.equal(resources.length,0);

      const headers={...baseHeaders,"idempotency-key":"terminal-start-success"};
      const beginTerminalStart=store.beginTerminalStart.bind(store);
      let terminalBeginCalls=0;
      store.beginTerminalStart=async(input)=>{
        terminalBeginCalls+=1;
        assert.equal(Date.parse(input.idempotency.leaseExpiresAt)-Date.parse(input.idempotency.now),30_000);
        return beginTerminalStart(input);
      };
      const firstRequest=fetch(api.baseUrl+pathName,{method:"POST",headers,body:"{}"});
      await entered;
      t.mock.timers.enable({apis:["Date"],now:Date.now()});
      t.mock.timers.tick(31_000);
      const concurrent=await fetch(api.baseUrl+pathName,{method:"POST",headers,body:"{}"});
      const concurrentBody=await concurrent.json() as {status:string;runId:string;presentation:{sandboxState:{runId:string|null}}};
      assert.equal(terminalBeginCalls,1);
      const differentKey=await fetch(api.baseUrl+pathName,{
        method:"POST",
        headers:{...baseHeaders,"idempotency-key":"terminal-start-different-operation"},
        body:"{}"
      });
      assert.equal(differentKey.status,202);
      assert.equal(terminalBeginCalls,2);
      continueStartup();
      const first=await firstRequest;
      assert.equal(concurrent.status,202);
      assert.equal(concurrentBody.status,"in_progress");
      assert.equal(concurrentBody.runId,runBefore!.runId);
      assert.equal(concurrentBody.presentation.sandboxState.runId,runBefore!.runId);
      const firstBody=await first.json();
      const replay=await fetch(api.baseUrl+pathName,{method:"POST",headers,body:"{}"});
      const replayBody=await replay.json();
      assert.equal(first.status,200);
      assert.equal(replay.status,200);
      assert.deepEqual(replayBody,firstBody);
      assert.equal((firstBody as {status:string}).status,"active");
      assert.equal((firstBody as {runId:string}).runId,runBefore!.runId);
      assert.equal((firstBody as {presentation:{sandboxState:{state:string}}}).presentation.sandboxState.state,"active");
      assert.equal((await store.sandboxRuns.get(runBefore!.runId))?.state,"active");
      assert.ok(resources.length>0);
    }finally{
      if(previousPostgresUrl===undefined)delete process.env.POSTGRES_APP_URL;else process.env.POSTGRES_APP_URL=previousPostgresUrl;
    }
  });

  it("returns the Store active receipt while the local startup Promise is still unwinding",async()=>{
    const previousPostgresUrl=process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL="postgresql://app:secret@db/app";
    const store=createLocalInMemoryProductStore();
    const resources:import("../../packages/contracts/src/api.js").KubernetesResource[]=[];
    let activationStored!:()=>void,finishActivation!:()=>void;
    const stored=new Promise<void>((resolve)=>{activationStored=resolve;});
    const activationGate=new Promise<void>((resolve)=>{finishActivation=resolve;});
    const activate=store.activateTaskSandboxRun.bind(store);
    store.activateTaskSandboxRun=async(input)=>{
      const result=await activate(input);
      activationStored();
      await activationGate;
      return result;
    };
    try{
      api=await createApiServer({
        port:0,dataRoot,builtinAdminPassword:"production-admin-password",sessionSecret:validProductionSessionSecret,
        sandboxNamespaceLimit:100,store,botifiedClient:new FakeBotifiedClient([]),botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{port:{
          async applyResource(resource){resources.push(structuredClone(resource));return"applied" as const;},
          async deleteResource(){return"deleted" as const;},
          async getPodReadiness(){return"ready" as const;},
          async listManagedResources(){return structuredClone(resources);}
        }}
      });
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const task=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
        prompt:"active receipt during Promise cleanup",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Activation map files"}
      })).task;
      const headers={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"terminal-activation-map"};
      const firstRequest=fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:"{}"});
      await stored;

      const converged=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:"{}"});
      const convergedBody=await converged.json() as {status:string};
      assert.equal(converged.status,200);
      assert.equal(convergedBody.status,"active");

      finishActivation();
      assert.equal((await firstRequest).status,200);
    }finally{
      if(previousPostgresUrl===undefined)delete process.env.POSTGRES_APP_URL;else process.env.POSTGRES_APP_URL=previousPostgresUrl;
    }
  });

  it("lets a release race terminalize the bound Terminal receipt instead of returning local 202",async()=>{
    const previousPostgresUrl=process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL="postgresql://app:secret@db/app";
    const store=createLocalInMemoryProductStore();
    const resources:import("../../packages/contracts/src/api.js").KubernetesResource[]=[];
    let applyEntered!:()=>void,finishApply!:()=>void;
    const entered=new Promise<void>((resolve)=>{applyEntered=resolve;});
    const applyGate=new Promise<void>((resolve)=>{finishApply=resolve;});
    try{
      api=await createApiServer({
        port:0,dataRoot,builtinAdminPassword:"production-admin-password",sessionSecret:validProductionSessionSecret,
        sandboxNamespaceLimit:100,store,botifiedClient:new FakeBotifiedClient([]),botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{port:{
          async applyResource(resource){resources.push(structuredClone(resource));applyEntered();await applyGate;return"applied" as const;},
          async deleteResource(){return"deleted" as const;},
          async getPodReadiness(){return"ready" as const;},
          async listManagedResources(){return structuredClone(resources);}
        }}
      });
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const task=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
        prompt:"release races Terminal startup",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Release race files"}
      })).task;
      const baseHeaders={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf};
      const terminalHeaders={...baseHeaders,"idempotency-key":"terminal-release-race"};
      const firstRequest=fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers:terminalHeaders,body:"{}"});
      await entered;
      const released=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/sandbox/release`,{
        method:"POST",headers:{...baseHeaders,"idempotency-key":"release-during-terminal"},body:"{}"
      });
      assert.equal(released.status,200);

      const converged=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers:terminalHeaders,body:"{}"});
      const convergedBody=await converged.json();
      assert.equal(converged.status,502);
      assert.equal((convergedBody as {error:{code:string}}).error.code,"sandbox_start_failed");
      const run=(await store.sandboxRuns.list()).find((candidate)=>candidate.taskId===task.id);assert.ok(run);
      assert.equal(run.state,"release_requested");
      assert.ok(run.startupClaimToken);
      assert.ok(run.startupActionDeadlineAt);

      finishApply();
      const owner=await firstRequest;
      const ownerBody=await owner.json();
      assert.equal(owner.status,502);
      assert.deepEqual(ownerBody,convergedBody);
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
        liveSandbox:{port:{async applyResource(){return"applied" as const;},async deleteResource(){return"deleted" as const;},async getPodReadiness(){return"ready" as const;},async listManagedResources(){return[];}}}
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

      const response=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{
        method:"POST",
        headers:{"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"invalid-endpoint-terminal"},
        body:"{}"
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
        liveSandbox:{port:{async applyResource(){return"applied" as const;},async deleteResource(){return"deleted" as const;},async getPodReadiness(){return"ready" as const;},async listManagedResources(){return[];}}}
      });
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const created=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{
        prompt:"recover reservation after map crash",endpointId:auth.endpointId,
        fileLibrary:{mode:"create_new",name:"Reservation recovery files"}
      })).task;
      const task=await store.findTask(created.id as string);assert.ok(task?.currentRunId);
      const headers={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"terminal-pre-map-crash"};
      const first=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:"{}"});
      assert.equal(first.status,202);
      assert.equal(begins,1);
      t.mock.timers.enable({apis:["Date"],now:Date.now()});
      t.mock.timers.tick(31_000);
      await releaseTaskRunFixture(store,task);
      const endpoint=await store.findEndpoint(auth.endpointId);assert.ok(endpoint);
      const unavailableAt=new Date(Date.parse(endpoint.updatedAt)+1_000).toISOString();
      assert.ok(await store.updateEndpointHealth(endpoint.id,endpoint.projectId,{status:"unavailable",checkedAt:unavailableAt,errorCategory:"network"},unavailableAt,endpoint.updatedAt));

      const recovered=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:"{}"});
      assert.equal(recovered.status,409);
      assert.equal(begins,2);
      assert.doesNotMatch(JSON.stringify(await recovered.json()),/Endpoint is unavailable/);
      const receipt=await store.findTaskIdempotency({
        actorId:task.createdByUserId!,projectId:auth.projectId,operation:"terminal-start",
        key:"terminal-pre-map-crash",requestHash
      });
      assert.equal(receipt?.kind,"replay");
      if(receipt?.kind==="replay"){
        const body=receipt.responseBody as {error:{presentation:{sandboxState:{runId:string|null;state:string}}}};
        assert.deepEqual(body.error.presentation.sandboxState,{runId:task.currentRunId,state:"released",cause:null});
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
    try{
      const livePort={
        async applyResource(){return"applied" as const;},
        async deleteResource(){return"deleted" as const;},
        async getPodReadiness(){return"ready" as const;},
        async listManagedResources(){return[];}
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
      const reserved=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:"{}"});
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
      const replay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:"{}"});
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
    try{
      api=await createApiServer({
        port:0,dataRoot,builtinAdminPassword:"production-admin-password",sessionSecret:validProductionSessionSecret,sandboxNamespaceLimit:100,store,
        botifiedClient:new FakeBotifiedClient([]),botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{port:{
          async applyResource(){applies+=1;return"applied" as const;},
          async deleteResource(){return"deleted" as const;},
          async getPodReadiness(){return"ready" as const;},
          async listManagedResources(){return[];}
        }}
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

      const response=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{
        method:"POST",
        headers:{"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"directory-failure-terminal"},
        body:"{}"
      });

      assert.equal(response.status,502);
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
    try{
      api=await createApiServer({
        port:0,
        dataRoot,
        builtinAdminPassword:"production-admin-password",
        sessionSecret:validProductionSessionSecret,
        sandboxNamespaceLimit:100,
        store,
        botifiedClient:botified,
        botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{readinessTimeoutMs:0,readinessPollMs:1,port:{
          async applyResource(){return"applied" as const;},
          async deleteResource(){return"deleted" as const;},
          async getPodReadiness(){return"ready" as const;},
          async listManagedResources(){return[];}
        }}
      });
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const task=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{prompt:"terminal failure",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Failure files"}})).task;
      const complete=store.completeTaskIdempotency.bind(store);
      store.completeTaskIdempotency=async(input)=>{
        if(input.operation==="terminal-start"&&input.responseStatus===502)throw new Error("generic completion must not own terminal startup failure");
        return complete(input);
      };
      const headers={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"terminal-start-failure"};
      const first=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:"{}"});
      const firstBody=await first.json();
      store.beginTerminalStart=async()=>{throw new Error("completed Terminal failure replay must not re-enter begin");};
      const replay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:"{}"});
      assert.equal(first.status,502,JSON.stringify(firstBody));
      assert.equal(replay.status,502);
      assert.deepEqual(await replay.json(),firstBody);
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

  it("drains an accepted Kubernetes mutation whose response was lost before failing its Terminal receipt",async()=>{
    const previousPostgresUrl=process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL="postgresql://app:secret@db/app";
    const store=createLocalInMemoryProductStore();
    const resources:import("../../packages/contracts/src/api.js").KubernetesResource[]=[];
    let mutationAborted=false;
    const port={
      async applyResource(
        resource:import("../../packages/contracts/src/api.js").KubernetesResource,
        _labels:Record<string,string>,
        signal?:AbortSignal
      ){
        resources.push(structuredClone(resource));
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
      async getPodReadiness(){return"ready" as const;},
      async listManagedResources(){return structuredClone(resources);}
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
      const response=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:"{}"});
      assert.equal(response.status,202);
      const pending=(await store.sandboxRuns.list()).find((run)=>run.taskId===task.id);assert.ok(pending);
      assert.equal(pending.state,"starting");
      assert.ok(pending.startupClaimToken);
      assert.ok(pending.startupActionDeadlineAt);
      assert.equal(resources.length,1);
      assert.equal(mutationAborted,true);

      const afterDeadline=new Date(Date.parse(pending.startupActionDeadlineAt)+1);
      const lifecycle=new SandboxLifecycleService(store,{namespace:pending.namespace,port,now:()=>afterDeadline});
      const reaped=await lifecycle.reapSandboxRunsOnce({apply:true,runId:pending.runId});
      assert.deepEqual(reaped.errors,[]);
      assert.equal(resources.length,0);
      const failed=await store.sandboxRuns.get(pending.runId);assert.ok(failed);
      assert.equal(failed.state,"failed");
      assert.equal(failed.startupClaimToken,null);
      assert.equal(failed.startupActionDeadlineAt,null);

      const replay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{method:"POST",headers,body:"{}"});
      assert.equal(replay.status,502);
      assert.equal((await replay.json() as {error:{code:string}}).error.code,"sandbox_start_failed");
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
          async applyResource(resource){resources.push(structuredClone(resource));return"applied" as const;},
          async deleteResource(){return"deleted" as const;},
          async getPodReadiness(){return"ready" as const;},
          async listManagedResources(){return structuredClone(resources);}
        }}
      });
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const task=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{prompt:"Botified readiness failure",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Readiness failure files"}})).task;
      const response=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/terminal/start`,{
        method:"POST",
        headers:{"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"botified-readiness-failure"},
        body:"{}"
      });
      assert.equal(response.status,502);
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
    await store.patchProjectResourcePolicy(auth.projectId,{activeTasksLimit:1},new Date(Date.parse(policy.updatedAt)+1).toISOString(),policy.updatedAt);
    store.upsertActiveProjectAlert=async()=>{throw new Error("alert sink unavailable");};

    const headers={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"terminal-capacity"};
    const firstResponse=await fetch(`${api.baseUrl}/api/v1/tasks/${candidate.id}/terminal/start`,{method:"POST",headers,body:"{}"});
    const firstBody=await firstResponse.json();
    const endpoint=await store.findEndpoint(auth.endpointId);assert.ok(endpoint);
    const unavailableAt=new Date(Date.parse(endpoint.updatedAt)+1_000).toISOString();
    assert.ok(await store.updateEndpointHealth(endpoint.id,endpoint.projectId,{status:"unavailable",checkedAt:unavailableAt,errorCategory:"network"},unavailableAt,endpoint.updatedAt));
    store.beginTerminalStart=async()=>{throw new Error("completed Terminal capacity replay must not re-enter begin");};
    const replay=await fetch(`${api.baseUrl}/api/v1/tasks/${candidate.id}/terminal/start`,{method:"POST",headers,body:"{}"});
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
    await store.patchProjectResourcePolicy(auth.projectId,{activeTasksLimit:1},new Date(Date.parse(policy.updatedAt)+1).toISOString(),policy.updatedAt);

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
    const request=()=>fetch(`${api!.baseUrl}/api/v1/tasks/${candidate.id}/terminal/start`,{method:"POST",headers,body:"{}"});
    const [first,second]=await Promise.all([request(),request()]);
    const [firstBody,secondBody]=await Promise.all([first.json(),second.json()]);
    assert.equal(initialLookups,2);
    assert.equal(first.status,409);
    assert.equal(second.status,409);
    assert.deepEqual(secondBody,firstBody);
    assert.equal((firstBody as {error:{code:string}}).error.code,"project_sandbox_capacity_reached");
  });

  it("keeps an ordinary message restart pending when its accepted Kubernetes response is lost",async()=>{
    const previousPostgresUrl=process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL="postgresql://app:secret@db/app";
    const store=createLocalInMemoryProductStore();
    try{
      api=await createApiServer({
        port:0,
        dataRoot,
        builtinAdminPassword:"production-admin-password",
        sessionSecret:validProductionSessionSecret,
        sandboxNamespaceLimit:100,
        store,
        botifiedClient:new FakeBotifiedClient([]),
        botifiedServiceKeyFactory:({taskId})=>taskId,
        liveSandbox:{port:{
          async applyResource(){throw Object.assign(new Error("message restart response lost"),{code:"ECONNRESET"});},
          async deleteResource(){return"deleted" as const;},
          async getPodReadiness(){return"ready" as const;},
          async listManagedResources(){return[];}
        }}
      });
      const auth=await createProjectWithEndpoint(api.baseUrl,"production-admin-password");
      const task=(await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{prompt:"released message",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Released message files"}})).task;
      const persisted=await store.findTask(task.id as string);
      assert.ok(persisted?.currentRunId);
      await releaseTaskRunFixture(store,persisted);

      const headers={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":"released-message-startup-failure"};
      const first=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/messages`,{method:"POST",headers,body:JSON.stringify({content:"continue despite startup failure"})});
      const firstBody=await first.json() as {messageId:string;disposition:string;duplicate:boolean};
      const replay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/messages`,{method:"POST",headers,body:JSON.stringify({content:"continue despite startup failure"})});
      const replayBody=await replay.json() as {messageId:string;disposition:string;duplicate:boolean};
      assert.equal(first.status,200);
      assert.equal(replay.status,200);
      assert.equal(firstBody.disposition,"queued_for_active_run");
      assert.equal(replayBody.disposition,"queued_for_active_run");
      assert.equal(replayBody.messageId,firstBody.messageId);
      assert.equal(replayBody.duplicate,false);
      assert.equal((await store.findTaskMessage(firstBody.messageId))?.deliveryStatus,"pending");
      const currentTask=await store.findTask(task.id as string);
      assert.ok(currentTask?.currentRunId);
      const pendingRun=await store.sandboxRuns.get(currentTask.currentRunId);
      assert.equal(pendingRun?.state,"starting");
      assert.ok(pendingRun?.startupClaimToken);
      assert.ok(pendingRun?.startupActionDeadlineAt);
      assert.equal(pendingRun?.releaseRequestedAt,null);
    }finally{
      if(previousPostgresUrl===undefined)delete process.env.POSTGRES_APP_URL;else process.env.POSTGRES_APP_URL=previousPostgresUrl;
    }
  });
});

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
    run:requested,
    idempotency:{actorId:claim.actorId,projectId:claim.projectId,operation:claim.operation,key:claim.key,requestHash:claim.requestHash,claimToken:claim.claimToken,responseStatus:200,responseBody:{released:true},updatedAt:requestedAt}
  }),"applied");
  const releasedAt=new Date(Date.parse(requestedAt)+1).toISOString();
  const released={...requested,state:"released" as const,releasedAt,cleanupClaimedAt:null,fencingToken:requested.fencingToken+1,updatedAt:releasedAt};
  assert.equal(await store.completeSandboxRunRelease({
    runId:run.runId,
    expectedFencingToken:requested.fencingToken,
    run:released,
    settlement:{runId:run.runId,workspaceId:run.workspaceId,projectId:run.projectId,taskId:run.taskId,fileLibraryId:run.fileLibraryId,startedByUserId:run.startedByUserId,startedAt:run.startedAt,releasedAt,durationSeconds:0,resources:run.resourceSnapshot,releaseReason:"requested"},
    auditEvent:{id:`audit_fixture_released_${run.runId}`,projectId:run.projectId,actorId:null,subjectUserId:run.startedByUserId,action:"sandbox.released",status:"accepted",resourceKind:"sandbox",resourceId:run.taskId,detail:{taskId:run.taskId,runId:run.runId},createdAt:releasedAt}
  }),"applied");
}

async function makeTaskRunActive(
  store: ReturnType<typeof createLocalInMemoryProductStore>,
  task: PersistedAgentTask,
  botifiedBaseUrl: string
): Promise<void> {
  const timestamp = task.updatedAt;
  const project=await store.findProject(task.projectId);
  const library=task.fileLibraryId?await store.findFileLibrary(task.fileLibraryId):null;
  assert.ok(project);
  assert.ok(library);
  assert.ok(task.createdByUserId);
  assert.equal(task.currentRunId,null);
  const runId=`run_fixture_${task.id}`;
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
    startupActionDeadlineAt:null,
    botifiedPort:3099,
    resourceNames:{
      pod:`${task.id}-pod`,
      service:`${task.id}-service`,
      configMap:`${task.id}-config`,
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
    expectedReleasedRunId:null,
    task:{...task,currentRunId:runId},
    runtimeState:{botifiedBaseUrl},
    sandboxRun:run,
    reservedAt:timestamp,
    admission:{namespace:run.namespace,namespaceLimit:100},
    idempotency:{actorId:task.createdByUserId!,projectId:task.projectId,operation:"terminal-start",key:`fixture-${task.id}`,requestHash:`fixture-hash-${task.id}`,resourceId:task.id,claimToken:`fixture-claim-${task.id}`,now:timestamp,leaseExpiresAt:new Date(Date.parse(timestamp)+60_000).toISOString()},
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

async function rejectedWebSocketStatus(url:string,cookie:string):Promise<number>{
  return new Promise<number>((resolve,reject)=>{
    const socket=new WebSocket(url,{headers:{cookie}});
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

class FakeBotifiedClient implements BotifiedRuntimeHttpClient {
  readonly postMessageCalls: Array<{ baseUrl: string; serviceKey: string; message: string }> = [];
  readonly readStateCalls: Array<{ baseUrl: string; serviceKey: string }> = [];
  readonly readTimelineCalls: Array<{ baseUrl: string; serviceKey: string; cursor: string | undefined }> = [];
  readonly downloadFileCalls: Array<{ baseUrl: string; serviceKey: string; fileId: string }> = [];
  readonly abortCalls: Array<{ baseUrl: string; serviceKey: string }> = [];
  readonly stopCalls: string[] = [];
  readonly downloads: Record<string, Uint8Array> = {};
  abortError: unknown;
  abortWait: Promise<void> | undefined;
  previewFailure: unknown;
  healthFailure: unknown;
  previewSignal: AbortSignal | undefined;
  previewWaitForAbort = false;
  timelineSessionId: string | undefined;
  stateSessionId: string | undefined;

  constructor(private readonly timelineReads: BotifiedTimelineReadResult[]) {}

  async health(): Promise<{ status: "ok" }> {
    if(this.healthFailure)throw this.healthFailure;
    return { status: "ok" };
  }

  async postMessage(baseUrl: string, serviceKey: string, message: string): Promise<BotifiedPostMessageResult> {
    this.postMessageCalls.push({ baseUrl, serviceKey, message });
    return { accepted: true, messageId: "msg_1", cursor: "post-cursor" };
  }

  async postMessageWithDelivery(baseUrl: string, serviceKey: string, input: BotifiedDeliveryMessageInput): Promise<BotifiedDeliveryReceipt> {
    const posted = await this.postMessage(baseUrl, serviceKey, input.text);
    return { accepted: posted.accepted, deliveryKey: input.deliveryKey, requestHash: input.requestHash, ...(posted.messageId ? { messageId: posted.messageId } : {}), ...(posted.cursor ? { cursor: posted.cursor } : {}) };
  }

  async queryDeliveryReceipt(): Promise<BotifiedDeliveryReceipt | null> {
    return null;
  }

  async readState(baseUrl: string, serviceKey: string) {
    this.readStateCalls.push({ baseUrl, serviceKey });
    const sessionId=this.stateSessionId??serviceKey;
    return { sessionId, snapshot: { session_id: sessionId }, state: "running" };
  }

  async readTimeline(baseUrl: string, serviceKey: string, cursor?: string): Promise<BotifiedTimelineReadResult> {
    this.readTimelineCalls.push({ baseUrl, serviceKey, cursor });
    const next = this.timelineReads.shift();
    if (next) {
      if (next.status === "gap") return next;
      return { ...next, events: next.events.map((event) => ({ ...(event as Record<string,unknown>), session_id: this.timelineSessionId??serviceKey })) };
    }
    const result: BotifiedTimelineReadResult = { status: "ok", events: [] };
    if (cursor !== undefined) {
      result.nextCursor = cursor;
    }
    return result;
  }

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

  async abort(baseUrl: string, serviceKey: string): Promise<BotifiedAbortResult> {
    this.abortCalls.push({ baseUrl, serviceKey });
    if (this.abortError) {
      throw this.abortError;
    }
    await this.abortWait;
    return { aborted: true };
  }

  async stopBackgroundTask(_baseUrl:string,_serviceKey:string,taskId:string){this.stopCalls.push(taskId);return{taskId,state:"cancelling" as const};}

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
