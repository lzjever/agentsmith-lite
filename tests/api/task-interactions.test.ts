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
      builtinAdminPassword: "admin-password",
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
    const interactions = await auth.requestJson("GET", `/api/v1/tasks/${task.id}/interactions`);
    const artifacts = await auth.requestJson("GET", `/api/v1/tasks/${task.id}/artifacts`);
    const leakedJson = JSON.stringify({ interactions, artifacts });

    assert.equal(interactions.items.some((item: { kind:string; artifactId?:string }) => item.kind === "file" && item.artifactId === artifacts[0].id), true);
    assert.equal(task.prompt, "make notes");
    assert.deepEqual(artifacts.map((artifact: { name: string; bytes: number; sha256?: string }) => [
      artifact.name,
      artifact.bytes,
      artifact.sha256
    ]), [["报告\".txt", artifactBytes.byteLength, "6c839ab9cab51908aff7e97713dfeaf25eec58eb99b3ed52b31dfedf4b0699d3"]]);
    assert.equal("fileId" in artifacts[0], false);
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
      builtinAdminPassword: "admin-password",
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
      builtinAdminPassword: "admin-password",
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
    const failedAudits = (await store.listProjectAuditEvents(auth.projectId))
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
      (await store.listProjectAuditEvents(auth.projectId))
        .filter((event) => event.action === "sandbox.failed").length,
      1
    );
  });

  it("fails closed when currentRunId cannot be resolved",async()=>{
    const store=createLocalInMemoryProductStore();
    api=await createApiServer({port:0,dataRoot,builtinAdminPassword:"admin-password",botifiedClient:new FakeBotifiedClient([]),store});
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
      builtinAdminPassword: "admin-password",
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
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", botifiedClient:botified, botifiedServiceKeyFactory:({taskId})=>taskId, store });
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
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", botifiedClient:botified, botifiedServiceKeyFactory:({taskId})=>taskId, terminalAccessRecheckMs:20, store });
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

  it("forwards terminal input sent while the Botified socket is connecting", async () => {
    terminalUpstream = new WebSocketServer({ port:0 });
    await once(terminalUpstream, "listening");
    const upstreamAddress = terminalUpstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
    const received = new Promise<string>((resolve) => {
      terminalUpstream!.once("connection", (socket) => socket.once("message", (data) => resolve(String(data))));
    });

    const store = createLocalInMemoryProductStore();
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", botifiedClient:new FakeBotifiedClient([]), botifiedServiceKeyFactory:({taskId})=>taskId, store });
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
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", botifiedClient:new FakeBotifiedClient([]), botifiedServiceKeyFactory:({taskId})=>taskId, store });
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
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", botifiedClient:new FakeBotifiedClient([]), botifiedServiceKeyFactory:({taskId})=>taskId, store });
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
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", botifiedClient:botified, botifiedServiceKeyFactory:({taskId})=>taskId, store });
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
    const owner = (await store.listProjectMemberships(task.projectId)).find((membership)=>membership.role==="owner"); assert.ok(owner);
    await store.updateProjectMembership({...owner,role:"viewer",updatedAt:new Date(Date.parse(owner.updatedAt)+1_000).toISOString()});
    const viewer = await auth.requestJson("GET",`/api/v1/tasks/${task.id}/interactions`);
    assert.equal(viewer.items.length,initial.items.length);
    assert.deepEqual(viewer.presentation.capabilities,{sendMessage:false,editQueuedMessage:false,abortTurn:false,stopWork:false,openTerminal:false,releaseSandbox:false,editTask:false,archiveTask:false,deleteTask:false});

    await store.updateProjectMembership(owner);
    const findCredential = store.findProjectCredential.bind(store);
    store.findProjectCredential = async (id) => id === endpoint.credentialId ? null : findCredential(id);
    const credentialDisabled = await auth.requestJson("GET",`/api/v1/tasks/${task.id}/interactions`);
    assert.equal(credentialDisabled.items.length,initial.items.length);
    assert.equal(credentialDisabled.presentation.capabilities.sendMessage,false);
    assert.equal(credentialDisabled.presentation.capabilities.openTerminal,false);
  });

  it("replays a background-completed pending message from canonical state with current capabilities",async()=>{
    const store=createLocalInMemoryProductStore();
    const botified=new FakeBotifiedClient([]);
    api=await createApiServer({port:0,dataRoot,builtinAdminPassword:"admin-password",botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,runtimeTickIntervalMs:60_000,store});
    const auth=await createProjectWithEndpoint(api.baseUrl);
    const created=await auth.requestJson("POST",`/api/v1/projects/${auth.projectId}/tasks`,{prompt:"background replay",endpointId:auth.endpointId,fileLibrary:{mode:"create_new",name:"Replay files"}});
    const task=await store.findTask(created.task.id as string);assert.ok(task);
    await makeTaskRunActive(store,task,"http://botified.internal");
    const current=await store.findTask(task.id);assert.ok(current?.currentRunId);
    const owner=(await store.listProjectMemberships(task.projectId)).find((membership)=>membership.role==="owner");assert.ok(owner);
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
    const persisted=await store.createTaskMessageAtomically({
      taskId:task.id,
      expectedCurrentRunId:current.currentRunId,
      message:pending,
      idempotency:{actorId:owner.userId,projectId:task.projectId,operation:"message",key,requestHash,resourceId:messageId,claimToken:"claim_background_replay",now:timestamp,leaseExpiresAt:new Date(Date.parse(timestamp)+60_000).toISOString()},
      auditEvent:{id:"audit_background_replay",projectId:task.projectId,actorId:owner.userId,action:"task.message.create",status:"accepted",resourceKind:"task",resourceId:task.id,detail:{taskId:task.id,messageId,deliveryStatus:"pending"},createdAt:timestamp}
    });
    assert.equal(persisted.kind,"created");
    const headers={"content-type":"application/json",cookie:auth.cookie,"x-csrf-token":auth.csrf,"idempotency-key":key};
    const inProgress=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/messages`,{method:"POST",headers,body:JSON.stringify({content})});
    assert.equal(inProgress.status,409);
    assert.deepEqual(await inProgress.json(),{error:"Idempotent task operation is still in progress",code:"idempotency_in_progress"});

    const background=createApplicationServices({store,dataRoot,builtinAdminPassword:"admin-password",botifiedClient:botified,botifiedServiceKeyFactory:({taskId})=>taskId,providerClient:{async validateEndpoint(){return{status:"healthy" as const};},async completeChat(){throw new Error("not used");}}});
    await background.tasks.syncActiveTasksOnce();
    assert.deepEqual(await store.beginTaskIdempotency({actorId:owner.userId,projectId:task.projectId,operation:"message",key,requestHash,resourceId:"unused-replay-resource",claimToken:"unused-replay-claim",now:new Date().toISOString(),leaseExpiresAt:new Date(Date.now()+60_000).toISOString()}),{
      kind:"replay",
      resourceId:messageId,
      responseStatus:200,
      responseBody:{kind:"task_message",messageId,taskId:task.id,projectId:task.projectId,actorId:owner.userId}
    });
    const replay=await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/messages`,{method:"POST",headers,body:JSON.stringify({content})});
    assert.equal(replay.status,200);
    const replayBody=await replay.json() as {duplicate:boolean;messageId:string;presentation:{sandboxState:{state:string;runId:string|null};capabilities:{sendMessage:boolean;releaseSandbox:boolean}}};
    assert.equal(replayBody.duplicate,true);
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
    assert.equal(capabilityBody.duplicate,true);
    assert.equal(capabilityBody.presentation.task.endpointId,endpoint.id);
    assert.equal(capabilityBody.presentation.capabilities.sendMessage,false);
    assert.equal(capabilityBody.presentation.capabilities.openTerminal,false);
    assert.equal(capabilityBody.presentation.capabilities.releaseSandbox,true);
    assert.equal((await store.listTaskMessages(task.id)).filter((message)=>message.content===content).length,1);
    assert.equal(botified.postMessageCalls.filter((call)=>call.message===content).length,1);
  });

  it("streams independent typed state and connection changes without a duplicate Run event", async () => {
    const store = createLocalInMemoryProductStore();
    const botified = new FakeBotifiedClient([]);
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", botifiedClient:botified, botifiedServiceKeyFactory:({taskId})=>taskId, store });
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
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", botifiedClient:botified, botifiedServiceKeyFactory:({taskId})=>taskId, store });
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
    api = await createApiServer({ port:0, dataRoot, builtinAdminPassword:"admin-password", botifiedClient:botified, botifiedServiceKeyFactory:({taskId})=>taskId, store });
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
            builtinAdminPassword: "admin-password",
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
      api=await createApiServer({port:0,dataRoot,builtinAdminPassword:"production-admin-password",sessionSecret:validProductionSessionSecret,store:createLocalInMemoryProductStore(),botifiedClient:new FakeBotifiedClient([]),botifiedServiceKeyFactory:({taskId})=>taskId,liveSandbox:{port:{async applyResource(resource){resources.push(structuredClone(resource));return"applied" as const;},async deleteResource(){return"deleted" as const;},async getPodReadiness(){return"ready" as const;},async listManagedResources(){return structuredClone(resources);}}}});
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
});

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
    reservedAt:timestamp
  });
  assert.equal(reserved.kind,"restarted");
  const startupClaimToken=`startup_claim_${task.id}`;
  assert.equal((await store.runSandboxStartupOperation({
    taskId:task.id,
    runId,
    expectedFencingToken:run.fencingToken,
    claimToken:startupClaimToken,
    claimedAt:timestamp,
    leaseExpiresAt:new Date(Date.parse(timestamp)+60_000).toISOString()
  },async()=>null)).kind,"applied");
  const started=await store.confirmSandboxRunStarted({
    runId,
    expectedFencingToken:run.fencingToken,
    startupClaimToken,
    startedAt:timestamp,
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
  assert.notEqual(started.kind,"conflict");
  if(started.kind==="conflict")return;
  const activated = await store.activateTaskSandboxRun({
    taskId:task.id,
    runId,
    expectedFencingToken:started.run.fencingToken,
    activatedAt:timestamp
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

  const workspace = await requestJson("POST", "/api/v1/workspaces", { name: "Ops" });
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
  previewSignal: AbortSignal | undefined;
  previewWaitForAbort = false;
  timelineSessionId: string | undefined;

  constructor(private readonly timelineReads: BotifiedTimelineReadResult[]) {}

  async health(): Promise<{ status: "ok" }> {
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
    return { sessionId: serviceKey, snapshot: { session_id: serviceKey }, state: "running" };
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
