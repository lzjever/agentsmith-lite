import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createTestApiServer } from "../../packages/api-entry-node/src/server.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import { DryRunBotifiedRuntimeHttpClient } from "../../packages/ports/src/botified.js";

describe("Task command convergence API", { concurrency:false }, () => {
  const store = createLocalInMemoryProductStore();
  let dataRoot = "";
  let baseUrl = "";
  let closeServer: (() => Promise<void>) | undefined;
  let auth: Awaited<ReturnType<typeof createProjectWithEndpoint>>;
  let messageTaskId = "";

  before(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-task-command-"));
    const api = await createTestApiServer({
      port: 0,
      dataRoot,
      builtinAdminPassword: "admin-password",
      store,
      sandboxNamespaceLimit: 100,
      providerClient: {
        async validateEndpoint() { return { status: "healthy" as const }; },
        async completeChat() { throw new Error("not used"); }
      }
    });
    baseUrl = api.baseUrl;
    closeServer = api.close;
    auth = await createProjectWithEndpoint(baseUrl);
    const messageParent = await auth.requestJson(
      "POST",
      `/api/v1/projects/${auth.projectId}/tasks`,
      taskCreateInput(auth.endpointId, "Message convergence parent", "Message convergence files"),
      "task-message-shared-parent"
    );
    messageTaskId = messageParent.task.id as string;
    await auth.requestJson(
      "POST",
      `/api/v1/tasks/${messageTaskId}/messages`,
      { content:"Start the shared message Run" },
      "task-message-shared-run"
    );
  });

  after(async () => {
    await closeServer?.();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("exposes only server wire outcomes and keeps the original command replayable after a fingerprint mismatch", async () => {
    const input = taskCreateInput(auth.endpointId, "Create one Task", "Convergence files");
    const key = "task-create-convergence";
    const first = await auth.request("POST", `/api/v1/projects/${auth.projectId}/tasks`, input, key);
    assert.equal(first.status, 200);
    const completed = await first.json() as { outcome:string;keyDisposition:string;task:{id:string} };
    assert.equal(completed.outcome, "completed");
    assert.equal(completed.keyDisposition, "retire");

    const mismatch = await auth.request("POST", `/api/v1/projects/${auth.projectId}/tasks`, {
      ...input,
      prompt: "Changed payload"
    }, key);
    assert.equal(mismatch.status, 409);
    assert.deepEqual(await mismatch.json(), {
      outcome: "rejected_before_acceptance",
      keyDisposition: "retain",
      error: "Idempotency-Key was already used with a different request",
      code: "idempotency_payload_mismatch"
    });

    const replay = await auth.request("POST", `/api/v1/projects/${auth.projectId}/tasks`, input, key);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as {outcome:string;task:{id:string}}).task.id, completed.task.id);
    const tasks = await auth.requestJson("GET", `/api/v1/projects/${auth.projectId}/tasks`);
    assert.equal(tasks.items.filter((item: {task:{id:string}}) => item.task.id === completed.task.id).length, 1);

    const rejected = await auth.request("POST", `/api/v1/projects/${auth.projectId}/tasks`, {
      ...input,
      endpointId: "missing"
    }, "task-create-rejected");
    assert.equal(rejected.status, 404);
    assert.deepEqual(await rejected.json(), {
      outcome: "rejected_before_acceptance",
      keyDisposition: "retire",
      error: "Endpoint not found"
    });
  });

  it("keeps the admitting request successful across membership removal after receipt completion", async () => {
    const memberId="task_create_authorization_drift_member";
    const sessionId="task-create-authorization-drift-session";
    const csrfToken="task-create-authorization-drift-csrf";
    const timestamp=new Date().toISOString();
    await store.createUser({
      id:memberId,
      email:"task-create-authorization-drift@example.test",
      emailVerified:true,
      passwordHash:"external:oidc",
      createdAt:timestamp,
      updatedAt:timestamp
    });
    assert.notEqual(await store.createWorkspaceMembership({
      workspaceId:auth.workspaceId,userId:memberId,role:"member",createdAt:timestamp,updatedAt:timestamp
    }),"already_exists");
    assert.notEqual(await store.createProjectMembershipForWorkspaceMember({
      projectId:auth.projectId,userId:memberId,role:"member",createdAt:timestamp,updatedAt:timestamp
    }),"already_exists");
    await store.createSession({
      id:sessionId,
      userId:memberId,
      csrfToken,
      createdAt:timestamp,
      expiresAt:"2999-01-01T00:00:00.000Z"
    });
    const completeTaskIdempotency=store.completeTaskIdempotency.bind(store);
    const key="task-create-authorization-drift";
    let removed=false;
    try{
      store.completeTaskIdempotency=async(candidate)=>{
        const completed=await completeTaskIdempotency(candidate);
        if(completed&&!removed&&candidate.operation==="create"&&candidate.key===key){
          removed=true;
          assert.equal(await store.deleteProjectMembership(auth.projectId,memberId),true);
        }
        return completed;
      };
      const input=taskCreateInput(auth.endpointId,"Authorization snapshot survives","Authorization snapshot files");
      const request=()=>fetch(baseUrl+`/api/v1/projects/${auth.projectId}/tasks`,{
        method:"POST",
        headers:{
          "content-type":"application/json",
          cookie:`asl_session=${sessionId}`,
          "x-csrf-token":csrfToken,
          "idempotency-key":key
        },
        body:JSON.stringify(input)
      });

      const accepted=await request();
      assert.equal(accepted.status,200,await accepted.clone().text());
      const acceptedBody=await accepted.json() as {outcome:string;keyDisposition:string;task:{id:string}};
      assert.equal(acceptedBody.outcome,"completed");
      assert.equal(acceptedBody.keyDisposition,"retire");

      const denied=await request();
      assert.equal(denied.status,403);
      const deniedBody=await denied.json() as Record<string,unknown>;
      assert.equal(deniedBody.error,"Project access denied");
      assert.equal("task" in deniedBody,false);
      assert.equal("taskId" in deniedBody,false);
    }finally{
      store.completeTaskIdempotency=completeTaskIdempotency;
    }
  });

  it("strictly replays a historical TaskPresentation create receipt", async () => {
    const createTaskAtomically=store.createTaskAtomically.bind(store);
    const input=taskCreateInput(auth.endpointId,"Legacy create receipt","Legacy receipt files");
    let requestHash="";
    try{
      store.createTaskAtomically=async(candidate)=>{
        if(candidate.task.prompt===input.prompt)requestHash=candidate.idempotency?.requestHash??"";
        return createTaskAtomically(candidate);
      };
      const created=await auth.request(
        "POST",
        `/api/v1/projects/${auth.projectId}/tasks`,
        input,
        "task-create-legacy-source"
      );
      assert.equal(created.status,200,await created.clone().text());
      const body=await created.json() as Record<string,unknown>&{task:{id:string}};
      const {outcome:_,keyDisposition:__,...legacyPresentation}=body;
      const historicalPresentation=structuredClone(legacyPresentation) as unknown as {
        currentTurn:{state:string;turnId?:string|null};
      };
      delete historicalPresentation.currentTurn.turnId;
      assert.ok(requestHash);
      const workspace=await store.findWorkspace(auth.workspaceId);
      assert.ok(workspace);
      const seed=async(key:string,responseBody:unknown)=>{
        const claim={
          actorId:workspace.ownerUserId,
          projectId:auth.projectId,
          operation:"create" as const,
          key,
          requestHash,
          resourceId:body.task.id,
          claimToken:`claim-${key}`,
          now:new Date().toISOString(),
          leaseExpiresAt:new Date(Date.now()+30_000).toISOString()
        };
        assert.equal((await store.beginTaskIdempotency(claim)).kind,"claimed");
        assert.equal(await store.completeTaskIdempotency({
          ...claim,responseStatus:200,responseBody,updatedAt:new Date().toISOString()
        }),true);
      };
      await seed("task-create-legacy-replay",historicalPresentation);
      const replay=await auth.request(
        "POST",
        `/api/v1/projects/${auth.projectId}/tasks`,
        input,
        "task-create-legacy-replay"
      );
      assert.equal(replay.status,200,await replay.clone().text());
      const replayBody=await replay.json() as {task:{id:string};currentTurn:{state:string;turnId:string|null}};
      assert.equal(replayBody.task.id,body.task.id);
      assert.equal(Object.hasOwn(replayBody.currentTurn,"turnId"),true);

      await seed("task-create-explicit-turn-replay",legacyPresentation);
      const explicit=await auth.request(
        "POST",
        `/api/v1/projects/${auth.projectId}/tasks`,
        input,
        "task-create-explicit-turn-replay"
      );
      assert.equal(explicit.status,200,await explicit.clone().text());
      assert.equal((await explicit.json() as {task:{id:string}}).task.id,body.task.id);

      await seed("task-create-malformed-legacy-replay",{task:body.task});
      const malformed=await auth.request(
        "POST",
        `/api/v1/projects/${auth.projectId}/tasks`,
        input,
        "task-create-malformed-legacy-replay"
      );
      assert.equal(malformed.status,409);
      const malformedBody=await malformed.json() as Record<string,unknown>;
      assert.deepEqual(malformedBody,{
        error:"Task create idempotency record is invalid",
        code:"task_create_idempotency_invalid"
      });
      assert.equal("outcome" in malformedBody,false);
      assert.equal("keyDisposition" in malformedBody,false);
    }finally{
      store.createTaskAtomically=createTaskAtomically;
    }
  });

  it("keeps a malformed completed Task message receipt uncertain", async () => {
    const createTaskMessageAtomically=store.createTaskMessageAtomically.bind(store);
    const content="Malformed completed message receipt";
    let captured:Parameters<typeof store.beginTaskIdempotency>[0]|undefined;
    try{
      store.createTaskMessageAtomically=async(candidate)=>{
        if(candidate.message.content===content)captured={...candidate.idempotency};
        return createTaskMessageAtomically(candidate);
      };
      const source=await auth.request(
        "POST",
        `/api/v1/tasks/${messageTaskId}/messages`,
        {content},
        "task-message-malformed-source"
      );
      assert.equal(source.status,200,await source.clone().text());
      assert.ok(captured);
      const malformedClaim={
        ...captured,
        key:"task-message-malformed-replay",
        claimToken:"task-message-malformed-replay-claim",
        now:new Date().toISOString(),
        leaseExpiresAt:new Date(Date.now()+30_000).toISOString()
      };
      assert.equal((await store.beginTaskIdempotency(malformedClaim)).kind,"claimed");
      assert.equal(await store.completeTaskIdempotency({
        ...malformedClaim,
        responseStatus:200,
        responseBody:{kind:"task_message",messageId:captured.resourceId},
        updatedAt:new Date().toISOString()
      }),true);

      const malformed=await auth.request(
        "POST",
        `/api/v1/tasks/${messageTaskId}/messages`,
        {content},
        malformedClaim.key
      );
      assert.equal(malformed.status,409);
      const malformedBody=await malformed.json() as Record<string,unknown>;
      assert.deepEqual(malformedBody,{
        error:"Task message idempotency record is invalid",
        code:"task_message_idempotency_invalid"
      });
      assert.equal("outcome" in malformedBody,false);
      assert.equal("keyDisposition" in malformedBody,false);
    }finally{
      store.createTaskMessageAtomically=createTaskMessageAtomically;
    }
  });

  it("replays after a successful Task message response is discarded by the caller", async () => {
    const taskId = messageTaskId;
    const content = "Only one interaction";
    const key = "task-message-response-loss";

    const discarded = await auth.request("POST", `/api/v1/tasks/${taskId}/messages`, { content }, key);
    assert.equal(discarded.status, 200);
    const replay = await auth.request("POST", `/api/v1/tasks/${taskId}/messages`, { content }, key);
    assert.equal(replay.status, 200);
    const receipt = await replay.json() as {outcome:string;keyDisposition:string;messageId:string};
    assert.equal(receipt.outcome, "completed");
    assert.equal(receipt.keyDisposition, "retire");

    const mismatch = await auth.request("POST", `/api/v1/tasks/${taskId}/messages`, {
      content: "Changed interaction"
    }, key);
    assert.equal(mismatch.status, 409);
    assert.deepEqual(await mismatch.json(), {
      outcome: "rejected_before_acceptance",
      keyDisposition: "retain",
      error: "Idempotency-Key was already used with a different request",
      code: "idempotency_payload_mismatch"
    });

    const original = await auth.request("POST", `/api/v1/tasks/${taskId}/messages`, { content }, key);
    assert.equal(original.status, 200);
    assert.equal((await original.json() as {messageId:string}).messageId, receipt.messageId);
    assert.equal((await store.listTaskMessages(taskId)).filter((message) =>
      message.content === content
    ).length, 1);
    const snapshot = await store.readTaskInteractionSnapshot(taskId, null, 100);
    assert.ok(snapshot);
    assert.equal(snapshot.items.filter((item) =>
      item.kind === "user_message" && item.body === content
    ).length, 1);
  });

  it("replays an admitted Task create after Project or Workspace lifecycle drift", async () => {
    const createAtomically = store.createTaskAtomically.bind(store);
    for (const lifecycle of ["project", "workspace"] as const) {
      let blockedTarget = "";
      try {
        store.createTaskAtomically = async (input) => {
          const result = await createAtomically(input);
          if (result.kind === "created") {
            const project = await store.findProject(input.task.projectId);
            assert.ok(project);
            blockedTarget = path.join(dataRoot, project.rootPath, "tasks", input.task.id);
            await mkdir(path.dirname(blockedTarget), { recursive: true });
            await writeFile(blockedTarget, "blocks promotion");
          }
          return result;
        };

        const input = taskCreateInput(
          auth.endpointId,
          `Create replay after ${lifecycle} drift`,
          `${lifecycle} drift files`
        );
        const key = `task-create-${lifecycle}-lifecycle-drift`;
        const first = await auth.request("POST", `/api/v1/projects/${auth.projectId}/tasks`, input, key);
        assert.equal(first.status, 202);
        const pending = await first.json() as {taskId:string};

        if (lifecycle === "project") {
          await store.setProjectLifecycleStatus(auth.projectId, "archived", new Date().toISOString());
        } else {
          await store.setWorkspaceLifecycleStatus(auth.workspaceId, "archived", new Date().toISOString());
        }
        await unlink(blockedTarget);

        const replay = await withExpiredCreateClaim(store,key,() =>
          auth.request("POST", `/api/v1/projects/${auth.projectId}/tasks`, input, key)
        );
        assert.equal(replay.status, 200);
        assert.equal((await replay.json() as {task:{id:string}}).task.id, pending.taskId);
      } finally {
        store.createTaskAtomically = createAtomically;
        if (lifecycle === "project") {
          await store.setProjectLifecycleStatus(auth.projectId, "active", new Date().toISOString());
        } else {
          await store.setWorkspaceLifecycleStatus(auth.workspaceId, "active", new Date().toISOString());
        }
      }
    }
  });

  it("replays an admitted Task message after Project or Workspace lifecycle drift", async () => {
    const taskId = messageTaskId;

    for (const lifecycle of ["project", "workspace"] as const) {
      const content = `Message replay after ${lifecycle} drift`;
      const key = `task-message-${lifecycle}-lifecycle-drift`;
      const first = await auth.request("POST", `/api/v1/tasks/${taskId}/messages`, { content }, key);
      assert.equal(first.status, 200, await first.clone().text());
      const messageId = (await first.json() as {messageId:string}).messageId;
      try {
        if (lifecycle === "project") {
          await store.setProjectLifecycleStatus(auth.projectId, "archived", new Date().toISOString());
        } else {
          await store.setWorkspaceLifecycleStatus(auth.workspaceId, "archived", new Date().toISOString());
        }

        const replay = await auth.request("POST", `/api/v1/tasks/${taskId}/messages`, { content }, key);
        assert.equal(replay.status, 200);
        assert.equal((await replay.json() as {messageId:string}).messageId, messageId);
      } finally {
        if (lifecycle === "project") {
          await store.setProjectLifecycleStatus(auth.projectId, "active", new Date().toISOString());
        } else {
          await store.setWorkspaceLifecycleStatus(auth.workspaceId, "active", new Date().toISOString());
        }
      }
    }
  });

  it("leaves an unresolved idempotency claim untyped", async () => {
    const createTaskMessageAtomically = store.createTaskMessageAtomically.bind(store);
    const beginTaskIdempotency = store.beginTaskIdempotency.bind(store);
    const content = "Claim outcome is uncertain";
    const key = "task-message-unresolved-claim";
    try {
      store.createTaskMessageAtomically = async (input) => {
        await beginTaskIdempotency(input.idempotency);
        throw new Error("response lost after persisting an active claim");
      };
      const first = await auth.request(
        "POST",
        `/api/v1/tasks/${messageTaskId}/messages`,
        { content },
        key
      );
      assert.equal(first.status, 500);
      store.createTaskMessageAtomically = createTaskMessageAtomically;

      const response = await auth.request(
        "POST",
        `/api/v1/tasks/${messageTaskId}/messages`,
        { content },
        key
      );
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error:"Idempotent task operation is still in progress",
        code:"idempotency_in_progress"
      });
    } finally {
      store.createTaskMessageAtomically = createTaskMessageAtomically;
      store.beginTaskIdempotency = beginTaskIdempotency;
    }
  });

  it("reclaims an expired message admission claim with the same message identity", async () => {
    const createTaskMessageAtomically = store.createTaskMessageAtomically.bind(store);
    const beginTaskIdempotency = store.beginTaskIdempotency.bind(store);
    const content = "Retry the persisted message admission";
    const key = "task-message-expired-admission";
    let persistedResourceId = "";
    try {
      store.createTaskMessageAtomically = async (input) => {
        persistedResourceId = input.idempotency.resourceId;
        await beginTaskIdempotency(input.idempotency);
        throw new Error("message admission failed after persisting its claim");
      };
      const first = await auth.request("POST", `/api/v1/tasks/${messageTaskId}/messages`, { content }, key);
      assert.equal(first.status, 500);
      assert.deepEqual(await first.json(), { error:"Internal server error" });
      assert.ok(persistedResourceId);

      store.createTaskMessageAtomically = createTaskMessageAtomically;
      store.beginTaskIdempotency = async (input) => input.operation === "message" && input.key === key
        ? beginTaskIdempotency({
            ...input,
            now:new Date(Date.now() + 120_000).toISOString(),
            leaseExpiresAt:new Date(Date.now() + 180_000).toISOString()
          })
        : beginTaskIdempotency(input);

      const retry = await auth.request("POST", `/api/v1/tasks/${messageTaskId}/messages`, { content }, key);
      assert.equal(retry.status, 200, await retry.clone().text());
      const receipt = await retry.json() as {messageId:string};
      assert.equal(receipt.messageId, persistedResourceId);
      assert.equal((await store.listTaskMessages(messageTaskId)).filter((message) => message.content === content).length, 1);
    } finally {
      store.createTaskMessageAtomically = createTaskMessageAtomically;
      store.beginTaskIdempotency = beginTaskIdempotency;
    }
  });

  it("keeps a lost pre-admission rejection claim uncertain", async () => {
    const completeTaskIdempotency = store.completeTaskIdempotency.bind(store);
    const key = "task-message-lost-rejection-claim";
    try {
      await store.setProjectLifecycleStatus(auth.projectId, "archived", new Date().toISOString());
      store.completeTaskIdempotency = async (input) => input.operation === "message" && input.key === key
        ? false
        : completeTaskIdempotency(input);

      const response = await auth.request(
        "POST",
        `/api/v1/tasks/${messageTaskId}/messages`,
        { content:"This rejection loses its receipt claim" },
        key
      );
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error:"Idempotent task operation is still in progress",
        code:"idempotency_in_progress"
      });
    } finally {
      store.completeTaskIdempotency = completeTaskIdempotency;
      await store.setProjectLifecycleStatus(auth.projectId, "active", new Date().toISOString());
    }
  });

  it("leaves a generic admission store failure untyped", async () => {
    const createTaskMessageAtomically = store.createTaskMessageAtomically.bind(store);
    try {
      store.createTaskMessageAtomically = async () => {
        throw new Error("Task message admission store unavailable");
      };

      const response = await auth.request(
        "POST",
        `/api/v1/tasks/${messageTaskId}/messages`,
        { content:"Admission outcome cannot be established" },
        "task-message-admission-store-failure"
      );
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error:"Internal server error" });
    } finally {
      store.createTaskMessageAtomically = createTaskMessageAtomically;
    }
  });

  it("replays a terminalized pre-admission 500 as a typed rejection", async () => {
    const findEndpoint=store.findEndpoint.bind(store);
    try {
      store.findEndpoint=async(id)=>{
        if(id===auth.endpointId)throw new ProductError("Pre-admission endpoint policy failed",500);
        return findEndpoint(id);
      };
      const input=taskCreateInput(auth.endpointId,"Proven pre-admission 500","Proven failure files");
      const key="task-create-proven-pre-admission-500";
      const expected={
        outcome:"rejected_before_acceptance",
        keyDisposition:"retire",
        error:"Pre-admission endpoint policy failed"
      };

      const first=await auth.request("POST",`/api/v1/projects/${auth.projectId}/tasks`,input,key);
      assert.equal(first.status,500);
      assert.deepEqual(await first.json(),expected);

      const replay=await auth.request("POST",`/api/v1/projects/${auth.projectId}/tasks`,input,key);
      assert.equal(replay.status,500);
      assert.deepEqual(await replay.json(),expected);
    } finally {
      store.findEndpoint=findEndpoint;
    }
  });

  it("terminalizes a store-owned project rejection and replays it", async () => {
    const createTaskAtomically=store.createTaskAtomically.bind(store);
    const input=taskCreateInput(auth.endpointId,"Atomic project rejection","Atomic project rejection files");
    const key="task-create-atomic-project-rejection";
    let forced=false;
    try{
      store.createTaskAtomically=async(candidate)=>{
        if(candidate.idempotency?.key!==key||forced)return createTaskAtomically(candidate);
        forced=true;
        assert.ok(await store.setProjectLifecycleStatus(auth.projectId,"archived",new Date().toISOString()));
        try{
          return await createTaskAtomically(candidate);
        }finally{
          assert.ok(await store.setProjectLifecycleStatus(auth.projectId,"active",new Date().toISOString()));
        }
      };
      const expected={
        outcome:"rejected_before_acceptance",
        keyDisposition:"retire",
        error:"Project is not active",
        code:"project_not_active"
      };

      const first=await auth.request("POST",`/api/v1/projects/${auth.projectId}/tasks`,input,key);
      assert.equal(first.status,409);
      assert.deepEqual(await first.json(),expected);

      const replay=await auth.request("POST",`/api/v1/projects/${auth.projectId}/tasks`,input,key);
      assert.equal(replay.status,409);
      assert.deepEqual(await replay.json(),expected);
    }finally{
      store.createTaskAtomically=createTaskAtomically;
      await store.setProjectLifecycleStatus(auth.projectId,"active",new Date().toISOString());
    }
  });

  it("terminalizes a store-owned Library rejection and replays it", async () => {
    const createTaskAtomically=store.createTaskAtomically.bind(store);
    const input=taskCreateInput(auth.endpointId,"Atomic Library rejection","Atomic Library conflict");
    const key="task-create-atomic-library-rejection";
    let forced=false;
    try{
      store.createTaskAtomically=async(candidate)=>{
        if(candidate.idempotency?.key!==key||forced)return createTaskAtomically(candidate);
        forced=true;
        assert.ok(candidate.newFileLibrary);
        const competing={
          ...candidate.newFileLibrary,
          id:"library_atomic_conflict",
          rootSubPath:"libraries/library_atomic_conflict/home"
        };
        assert.ok(await store.createFileLibrary(competing));
        return createTaskAtomically(candidate);
      };
      const expected={
        outcome:"rejected_before_acceptance",
        keyDisposition:"retire",
        error:"File Library name already exists",
        code:"file_library_name_conflict"
      };

      const first=await auth.request("POST",`/api/v1/projects/${auth.projectId}/tasks`,input,key);
      assert.equal(first.status,409);
      assert.deepEqual(await first.json(),expected);

      const replay=await auth.request("POST",`/api/v1/projects/${auth.projectId}/tasks`,input,key);
      assert.equal(replay.status,409);
      assert.deepEqual(await replay.json(),expected);
    }finally{
      store.createTaskAtomically=createTaskAtomically;
    }
  });

  it("converges through a receipt when the message store throws after admission", async () => {
    const taskId = messageTaskId;
    const createTaskMessageAtomically = store.createTaskMessageAtomically.bind(store);
    let throwAfterAdmission = true;
    try {
      store.createTaskMessageAtomically = async (input) => {
        const result = await createTaskMessageAtomically(input);
        if (throwAfterAdmission && result.kind === "created") {
          throwAfterAdmission = false;
          throw new Error("store response failed after Task message admission");
        }
        return result;
      };

      const content = "The receipt survives the failed store response";
      const key = "task-message-post-admission-store-failure";
      const response = await auth.request("POST", `/api/v1/tasks/${taskId}/messages`, { content }, key);
      assert.equal(response.status, 200, await response.clone().text());
      const receipt = await response.json() as {outcome:string;messageId:string};
      assert.equal(receipt.outcome, "completed");

      const replay = await auth.request("POST", `/api/v1/tasks/${taskId}/messages`, { content }, key);
      assert.equal(replay.status, 200);
      assert.equal((await replay.json() as {messageId:string}).messageId, receipt.messageId);
      assert.equal((await store.listTaskMessages(taskId)).filter((message) => message.content === content).length, 1);
    } finally {
      store.createTaskMessageAtomically = createTaskMessageAtomically;
    }
  });

  it("does not retire a create rejection when the same key admits concurrently", async () => {
    const createTaskAtomically = store.createTaskAtomically.bind(store);
    const beginTaskIdempotency = store.beginTaskIdempotency.bind(store);
    const atomicEntered = deferred();
    const releaseAtomic = deferred();
    const rejectionClaimEntered = deferred();
    const releaseRejectionClaim = deferred();
    const key = "task-create-validation-admission-race";
    const input = taskCreateInput(auth.endpointId, "Create validation race", "Create validation race files");
    try {
      store.createTaskAtomically = async (candidate) => {
        if (candidate.idempotency?.key === key) {
          atomicEntered.resolve();
          await releaseAtomic.promise;
        }
        return createTaskAtomically(candidate);
      };
      store.beginTaskIdempotency = async (candidate) => {
        if (candidate.operation === "create" && candidate.key === key) {
          rejectionClaimEntered.resolve();
          await releaseRejectionClaim.promise;
        }
        return beginTaskIdempotency(candidate);
      };

      const winnerPromise = auth.request("POST", `/api/v1/projects/${auth.projectId}/tasks`, input, key);
      await atomicEntered.promise;
      await store.setProjectLifecycleStatus(auth.projectId, "archived", new Date().toISOString());
      const loserPromise = auth.request("POST", `/api/v1/projects/${auth.projectId}/tasks`, input, key);
      const loserBeforeAdmission = loserPromise.then((response) => ({kind:"response" as const,response}));
      const rejectionClaim = rejectionClaimEntered.promise.then(() => ({kind:"claim" as const}));
      const observed = await Promise.race([loserBeforeAdmission,rejectionClaim]);

      await store.setProjectLifecycleStatus(auth.projectId, "active", new Date().toISOString());
      releaseAtomic.resolve();
      const winner = await winnerPromise;
      assert.equal(winner.status, 200, await winner.clone().text());
      if (observed.kind === "claim") releaseRejectionClaim.resolve();
      const loser = observed.kind === "response" ? observed.response : await loserPromise;
      assert.equal(loser.status, 200, await loser.clone().text());
      assert.equal(
        (await loser.json() as {task:{id:string}}).task.id,
        (await winner.json() as {task:{id:string}}).task.id
      );
    } finally {
      releaseAtomic.resolve();
      releaseRejectionClaim.resolve();
      store.createTaskAtomically = createTaskAtomically;
      store.beginTaskIdempotency = beginTaskIdempotency;
      await store.setProjectLifecycleStatus(auth.projectId, "active", new Date().toISOString());
    }
  });

  it("does not retire a message rejection when the same key admits concurrently", async () => {
    const createTaskMessageAtomically = store.createTaskMessageAtomically.bind(store);
    const beginTaskIdempotency = store.beginTaskIdempotency.bind(store);
    const firstBeginEntered = deferred();
    const releaseFirstBegin = deferred();
    const atomicEntered = deferred();
    const releaseAtomic = deferred();
    const rejectionClaimEntered = deferred();
    const releaseRejectionClaim = deferred();
    const key = "task-message-validation-admission-race";
    const content = "Message validation race";
    let atomicMayProceed = false;
    try {
      store.beginTaskIdempotency = async (candidate) => {
        if (candidate.operation === "message" && candidate.key === key) {
          if (!atomicEntered.settled) {
            firstBeginEntered.resolve();
            await releaseFirstBegin.promise;
          } else {
            rejectionClaimEntered.resolve();
            await releaseRejectionClaim.promise;
          }
        }
        return beginTaskIdempotency(candidate);
      };
      store.createTaskMessageAtomically = async (candidate) => {
        if (candidate.idempotency.key === key && !atomicMayProceed) {
          atomicEntered.resolve();
          await releaseAtomic.promise;
        }
        return createTaskMessageAtomically(candidate);
      };

      const winnerPromise = auth.request("POST", `/api/v1/tasks/${messageTaskId}/messages`, { content }, key);
      const firstPause = await Promise.race([
        firstBeginEntered.promise.then(() => "begin" as const),
        atomicEntered.promise.then(() => "atomic" as const)
      ]);
      await store.setProjectLifecycleStatus(auth.projectId, "archived", new Date().toISOString());
      const loserPromise = auth.request("POST", `/api/v1/tasks/${messageTaskId}/messages`, { content }, key);
      const loserBeforeAdmission = loserPromise.then((response) => ({kind:"response" as const,response}));
      const rejectionClaim = rejectionClaimEntered.promise.then(() => ({kind:"claim" as const}));
      const observed = await Promise.race([loserBeforeAdmission,rejectionClaim]);

      await store.setProjectLifecycleStatus(auth.projectId, "active", new Date().toISOString());
      atomicMayProceed = true;
      if (firstPause === "begin") releaseFirstBegin.resolve();
      else releaseAtomic.resolve();
      releaseAtomic.resolve();
      const winner = await winnerPromise;
      assert.equal(winner.status, 200, await winner.clone().text());
      if (observed.kind === "claim") releaseRejectionClaim.resolve();
      const loser = observed.kind === "response" ? observed.response : await loserPromise;
      assert.equal(loser.status, 200, await loser.clone().text());
      const winnerBody = await winner.json() as {messageId:string};
      assert.equal((await loser.json() as {messageId:string}).messageId, winnerBody.messageId);
      assert.equal((await store.listTaskMessages(messageTaskId)).filter((message) => message.content === content).length, 1);
    } finally {
      atomicMayProceed = true;
      releaseFirstBegin.resolve();
      releaseAtomic.resolve();
      releaseRejectionClaim.resolve();
      store.createTaskMessageAtomically = createTaskMessageAtomically;
      store.beginTaskIdempotency = beginTaskIdempotency;
      await store.setProjectLifecycleStatus(auth.projectId, "active", new Date().toISOString());
    }
  });

  it("reconciles a committed Task create with no staging marker and completes its receipt", async () => {
    const crashRoot = await mkdtemp(path.join(tmpdir(), "asl-task-create-crash-"));
    const crashStore = createLocalInMemoryProductStore();
    const liveOptions = liveTaskServiceOptions(crashStore, crashRoot);
    try {
      const services = createApplicationServices(liveOptions);
      const { user } = await services.auth.loginAfterBootstrap("production-admin-password");
      const workspace = await services.workspaces.createWorkspace(user.id, {name:"Crash recovery"});
      const project = await services.workspaces.createProject(user.id, workspace.id, {name:"Crash recovery",sandboxLimit:10});
      const credential = await services.credentials.create(user.id, project.id, {
        name:"Crash recovery credential",
        baseUrl:"https://models.example.test/v1",
        secret:"secret"
      });
      const endpoint = await services.endpoints.createEndpoint(user.id, project.id, {
        name:"Crash recovery endpoint",
        protocol:"openai_chat_completions",
        baseUrl:credential.baseUrl,
        model:"model",
        credentialId:credential.id,
        capabilities:["text","tool_calls"],
        requestTimeoutSecs:30
      });
      const input = taskCreateInput(endpoint.id, "Recover before marker", "Crash recovery files");
      const key = "task-create-crash-before-marker";
      const createTaskAtomically = crashStore.createTaskAtomically.bind(crashStore);
      const findTaskIdempotency = crashStore.findTaskIdempotency.bind(crashStore);
      let admitted = false;
      try {
        crashStore.createTaskAtomically = async (candidate) => {
          const result = await createTaskAtomically(candidate);
          if (result.kind === "created") {
            admitted = true;
            throw new Error("process stopped after Task admission");
          }
          return result;
        };
        crashStore.findTaskIdempotency = async (candidate) => {
          if (admitted && candidate.operation === "create" && candidate.key === key) {
            throw new Error("process stopped before receipt recovery");
          }
          return findTaskIdempotency(candidate);
        };
        await assert.rejects(
          services.tasks.createTask(user.id, project.id, input, key),
          /process stopped before receipt recovery/
        );
      } finally {
        crashStore.createTaskAtomically = createTaskAtomically;
        crashStore.findTaskIdempotency = findTaskIdempotency;
      }

      const persisted = (await crashStore.listTasksForProject(project.id)).find((task) => task.prompt === input.prompt);
      assert.ok(persisted?.currentRunId);
      const originalRunId = persisted.currentRunId;
      const originalRun = await crashStore.sandboxRuns.get(originalRunId);
      assert.equal(originalRun?.startupReadyAt, null);
      await assert.rejects(
        access(path.join(crashRoot, project.rootPath, ".preparations", persisted.id, ".agentsmith-preparation.json")),
        (error:unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
      );
      const operation=await crashStore.findTaskPreparationOperation(persisted.id);
      assert.ok(operation);

      const restarted = createApplicationServices(liveOptions);
      const beginTaskIdempotency=crashStore.beginTaskIdempotency.bind(crashStore);
      crashStore.beginTaskIdempotency=(candidate)=>candidate.operation==="create"&&candidate.key===key
        ?beginTaskIdempotency({
            ...candidate,
            now:new Date(Date.now()+120_000).toISOString(),
            leaseExpiresAt:new Date(Date.now()+150_000).toISOString()
          })
        :beginTaskIdempotency(candidate);
      await restarted.tasks.syncActiveTasksOnce();
      crashStore.beginTaskIdempotency=beginTaskIdempotency;
      const recovered = await crashStore.findTask(persisted.id);
      assert.equal(recovered?.id, persisted.id);
      assert.equal(recovered?.currentRunId, originalRunId);
      const recoveredRun = await crashStore.sandboxRuns.get(originalRunId);
      assert.ok(recoveredRun?.startupReadyAt, JSON.stringify(recoveredRun));
      const completedReceipt=await crashStore.findTaskIdempotency({
        actorId:user.id,
        projectId:project.id,
        operation:"create",
        key,
        requestHash:operation.requestHash
      });
      assert.equal(completedReceipt?.kind,"replay");
      const replay = await restarted.tasks.createTask(user.id, project.id, input, key);
      assert.equal(replay.task.id, persisted.id);
    } finally {
      await rm(crashRoot, {recursive:true,force:true});
    }
  });

  it("leaves a contended preparation receipt and Run untouched", async () => {
    const contentionRoot=await mkdtemp(path.join(tmpdir(),"asl-task-create-contention-"));
    const contentionStore=createLocalInMemoryProductStore();
    const liveOptions=liveTaskServiceOptions(contentionStore,contentionRoot);
    try{
      const fixture=await createLiveProjectFixture(contentionStore,contentionRoot,"Receipt contention");
      const input=taskCreateInput(fixture.endpoint.id,"Contended preparation","Contention files");
      const key="task-create-reconcile-contention";
      const createTaskAtomically=contentionStore.createTaskAtomically.bind(contentionStore);
      let blockedTarget="";
      contentionStore.createTaskAtomically=async(candidate)=>{
        const result=await createTaskAtomically(candidate);
        if(result.kind==="created"){
          blockedTarget=path.join(contentionRoot,fixture.project.rootPath,"tasks",candidate.task.id);
          await mkdir(path.dirname(blockedTarget),{recursive:true});
          await writeFile(blockedTarget,"blocks initial promotion");
        }
        return result;
      };
      await assert.rejects(
        fixture.services.tasks.createTask(fixture.user.id,fixture.project.id,input,key),
        /existing target/
      );
      contentionStore.createTaskAtomically=createTaskAtomically;
      await unlink(blockedTarget);
      const persisted=(await contentionStore.listTasksForProject(fixture.project.id)).find((task)=>task.prompt===input.prompt);
      assert.ok(persisted?.currentRunId);
      const operationRead=deferred(),beginEntered=deferred(),releaseBegin=deferred();
      const findTaskPreparationOperation=contentionStore.findTaskPreparationOperation.bind(contentionStore);
      const beginTaskIdempotency=contentionStore.beginTaskIdempotency.bind(contentionStore);
      contentionStore.findTaskPreparationOperation=async(taskId)=>{
        const operation=await findTaskPreparationOperation(taskId);
        if(taskId===persisted.id)operationRead.resolve();
        return operation;
      };
      contentionStore.beginTaskIdempotency=async(candidate)=>{
        if(candidate.operation==="create"&&candidate.key===key){
          beginEntered.resolve();
          await releaseBegin.promise;
        }
        return beginTaskIdempotency(candidate);
      };

      const restarted=createApplicationServices(liveOptions);
      const reconciliation=restarted.tasks.syncActiveTasksOnce();
      await operationRead.promise;
      await beginEntered.promise;
      const operation=await findTaskPreparationOperation(persisted.id);
      assert.ok(operation);
      const claimantNow=new Date(Date.now()+120_000).toISOString();
      const claimant=await beginTaskIdempotency({
        ...operation,
        claimToken:"competing-preparation-claim",
        now:claimantNow,
        leaseExpiresAt:new Date(Date.parse(claimantNow)+30_000).toISOString()
      });
      assert.equal(claimant.kind,"claimed");
      releaseBegin.resolve();
      await reconciliation;
      const run=await contentionStore.sandboxRuns.get(persisted.currentRunId);
      assert.equal(run?.state,"starting");
      assert.equal(run?.startupReadyAt,null);
      assert.equal((await contentionStore.findTaskIdempotency({
        actorId:operation.actorId,
        projectId:operation.projectId,
        operation:"create",
        key:operation.key,
        requestHash:operation.requestHash
      }))?.kind,"in_progress");
    }finally{
      await rm(contentionRoot,{recursive:true,force:true});
    }
  });

  it("terminalizes a startup-ready create after the admitting member is removed", async () => {
    const readyRoot=await mkdtemp(path.join(tmpdir(),"asl-task-create-ready-receipt-"));
    const readyStore=createLocalInMemoryProductStore();
    const liveOptions=liveTaskServiceOptions(readyStore,readyRoot);
    try{
      const fixture=await createLiveProjectFixture(readyStore,readyRoot,"Ready receipt");
      const memberId="ready_receipt_member";
      const timestamp=new Date().toISOString();
      await readyStore.createUser({
        id:memberId,
        email:"ready-receipt-member@example.test",
        emailVerified:true,
        passwordHash:"external:oidc",
        createdAt:timestamp,
        updatedAt:timestamp
      });
      assert.notEqual(await readyStore.createWorkspaceMembership({
        workspaceId:fixture.workspace.id,userId:memberId,role:"member",createdAt:timestamp,updatedAt:timestamp
      }),"already_exists");
      assert.notEqual(await readyStore.createProjectMembershipForWorkspaceMember({
        projectId:fixture.project.id,userId:memberId,role:"member",createdAt:timestamp,updatedAt:timestamp
      }),"already_exists");
      const input=taskCreateInput(fixture.endpoint.id,"Ready before receipt","Ready receipt files");
      const key="task-create-ready-before-receipt";
      const completeTaskIdempotency=readyStore.completeTaskIdempotency.bind(readyStore);
      let interrupt=true;
      readyStore.completeTaskIdempotency=async(candidate)=>{
        if(interrupt&&candidate.operation==="create"&&candidate.key===key){
          interrupt=false;
          throw new Error("process stopped after Run readiness");
        }
        return completeTaskIdempotency(candidate);
      };
      await assert.rejects(
        fixture.services.tasks.createTask(memberId,fixture.project.id,input,key),
        /process stopped after Run readiness/
      );
      readyStore.completeTaskIdempotency=completeTaskIdempotency;
      const persisted=(await readyStore.listTasksForProject(fixture.project.id)).find((task)=>task.prompt===input.prompt);
      assert.ok(persisted?.currentRunId);
      assert.ok((await readyStore.sandboxRuns.get(persisted.currentRunId))?.startupReadyAt);
      const operation=await readyStore.findTaskPreparationOperation(persisted.id);
      assert.ok(operation);
      assert.equal(await readyStore.deleteProjectMembership(fixture.project.id,memberId),true);
      const beginTaskIdempotency=readyStore.beginTaskIdempotency.bind(readyStore);
      readyStore.beginTaskIdempotency=(candidate)=>candidate.operation==="create"&&candidate.key===key
        ?beginTaskIdempotency({
            ...candidate,
            now:new Date(Date.now()+120_000).toISOString(),
            leaseExpiresAt:new Date(Date.now()+150_000).toISOString()
          })
        :beginTaskIdempotency(candidate);

      const restarted=createApplicationServices(liveOptions);
      await restarted.tasks.syncActiveTasksOnce();
      const receipt=await readyStore.findTaskIdempotency({
        actorId:memberId,
        projectId:fixture.project.id,
        operation:"create",
        key,
        requestHash:operation.requestHash
      });
      assert.equal(receipt?.kind,"replay");
      if(receipt?.kind==="replay"){
        assert.deepEqual(receipt.responseBody,{
          kind:"task_create",
          taskId:persisted.id,
          projectId:fixture.project.id,
          actorId:memberId
        });
      }
      const run=await readyStore.sandboxRuns.get(persisted.currentRunId);
      assert.notEqual(run?.state,"failed");
      assert.ok(run?.startupReadyAt);
    }finally{
      await rm(readyRoot,{recursive:true,force:true});
    }
  });

  it("terminalizes after ready contention activates the Run and advances its fence", async () => {
    const activeRoot=await mkdtemp(path.join(tmpdir(),"asl-task-create-active-receipt-"));
    const activeStore=createLocalInMemoryProductStore();
    const liveOptions=liveTaskServiceOptions(activeStore,activeRoot);
    try{
      const fixture=await createLiveProjectFixture(activeStore,activeRoot,"Active receipt");
      const input=taskCreateInput(fixture.endpoint.id,"Activate before receipt reclaim","Active receipt files");
      const key="task-create-active-before-receipt";
      const completeTaskIdempotency=activeStore.completeTaskIdempotency.bind(activeStore);
      let interrupt=true;
      activeStore.completeTaskIdempotency=async(candidate)=>{
        if(interrupt&&candidate.operation==="create"&&candidate.key===key){
          interrupt=false;
          throw new Error("process stopped after readiness before active receipt");
        }
        return completeTaskIdempotency(candidate);
      };
      await assert.rejects(
        fixture.services.tasks.createTask(fixture.user.id,fixture.project.id,input,key),
        /process stopped after readiness before active receipt/
      );
      activeStore.completeTaskIdempotency=completeTaskIdempotency;
      const persisted=(await activeStore.listTasksForProject(fixture.project.id)).find((task)=>task.prompt===input.prompt);
      assert.ok(persisted?.currentRunId);
      const operation=await activeStore.findTaskPreparationOperation(persisted.id);
      assert.ok(operation);
      const readyRun=await activeStore.sandboxRuns.get(persisted.currentRunId);
      assert.ok(readyRun?.startupReadyAt);

      const restarted=createApplicationServices(liveOptions);
      await restarted.tasks.syncActiveTasksOnce();
      const activeRun=await activeStore.sandboxRuns.get(persisted.currentRunId);
      assert.equal(activeRun?.state,"active");
      assert.ok(activeRun.fencingToken>readyRun.fencingToken);
      assert.equal((await activeStore.findTaskIdempotency({
        actorId:operation.actorId,
        projectId:operation.projectId,
        operation:"create",
        key:operation.key,
        requestHash:operation.requestHash
      }))?.kind,"in_progress");

      const beginTaskIdempotency=activeStore.beginTaskIdempotency.bind(activeStore);
      activeStore.beginTaskIdempotency=(candidate)=>candidate.operation==="create"&&candidate.key===key
        ?beginTaskIdempotency({
            ...candidate,
            now:new Date(Date.now()+120_000).toISOString(),
            leaseExpiresAt:new Date(Date.now()+150_000).toISOString()
          })
        :beginTaskIdempotency(candidate);
      await restarted.tasks.syncActiveTasksOnce();
      const receipt=await activeStore.findTaskIdempotency({
        actorId:operation.actorId,
        projectId:operation.projectId,
        operation:"create",
        key:operation.key,
        requestHash:operation.requestHash
      });
      assert.equal(receipt?.kind,"replay");
      const replay=await restarted.tasks.createTask(fixture.user.id,fixture.project.id,input,key);
      assert.equal(replay.task.id,persisted.id);
      assert.equal(replay.sandboxState.runId,persisted.currentRunId);
    }finally{
      await rm(activeRoot,{recursive:true,force:true});
    }
  });

  it("commits Task identity before filesystem preparation and resumes the same durable operation", async () => {
    const createAtomically = store.createTaskAtomically.bind(store);
    let blockedTarget = "";
    let sabotage = true;
    try {
      store.createTaskAtomically = async (input) => {
        const result = await createAtomically(input);
        if (sabotage && result.kind === "created") {
          sabotage = false;
          const project = await store.findProject(input.task.projectId);
          assert.ok(project);
          blockedTarget = path.join(dataRoot, project.rootPath, "tasks", input.task.id);
          await mkdir(path.dirname(blockedTarget), { recursive: true });
          await writeFile(blockedTarget, "blocks promotion");
        }
        return result;
      };

      const input = taskCreateInput(auth.endpointId, "Resume preparation", "Resumable files");
      const key = "task-create-preparation-resume";
      const accepted = await auth.request("POST", `/api/v1/projects/${auth.projectId}/tasks`, input, key);
      assert.equal(accepted.status, 202);
      const pending = await accepted.json() as {outcome:string;keyDisposition:string;taskId:string};
      assert.deepEqual(Object.keys(pending).sort(), ["keyDisposition", "outcome", "taskId"]);
      assert.equal(pending.outcome, "accepted_in_progress");
      assert.equal(pending.keyDisposition, "retain");
      assert.ok(await store.findTask(pending.taskId));

      await unlink(blockedTarget);
      const replay = await withExpiredCreateClaim(store,key,() =>
        auth.request("POST", `/api/v1/projects/${auth.projectId}/tasks`, input, key)
      );
      assert.equal(replay.status, 200);
      const completed = await replay.json() as {outcome:string;task:{id:string}};
      assert.equal(completed.outcome, "completed");
      assert.equal(completed.task.id, pending.taskId);
      assert.equal((await store.listTasksForProject(auth.projectId)).filter((task) => task.id === pending.taskId).length, 1);
    } finally {
      store.createTaskAtomically = createAtomically;
    }
  });

  it("resumes persisted preparation after its Endpoint becomes unavailable", async () => {
    const createAtomically = store.createTaskAtomically.bind(store);
    const originalEndpoint = await store.findEndpoint(auth.endpointId);
    assert.ok(originalEndpoint);
    let blockedTarget = "";
    let admitted = false;
    try {
      store.createTaskAtomically = async (input) => {
        const result = await createAtomically(input);
        if (!admitted && result.kind === "created") {
          admitted = true;
          const project = await store.findProject(input.task.projectId);
          assert.ok(project);
          blockedTarget = path.join(dataRoot, project.rootPath, "tasks", input.task.id);
          await mkdir(path.dirname(blockedTarget), { recursive: true });
          await writeFile(blockedTarget, "blocks promotion");
          const updatedAt = new Date(Date.parse(originalEndpoint.updatedAt) + 1).toISOString();
          assert.ok(await store.updateEndpointHealth(
            originalEndpoint.id,
            originalEndpoint.projectId,
            { status:"unavailable",checkedAt:updatedAt,errorCategory:"network" },
            updatedAt,
            originalEndpoint.updatedAt
          ));
        }
        return result;
      };

      const input = taskCreateInput(auth.endpointId, "Persisted Endpoint identity", "Endpoint recovery files");
      const key = "task-create-endpoint-recovery";
      const first = await auth.request("POST", `/api/v1/projects/${auth.projectId}/tasks`, input, key);
      assert.equal(first.status, 202);
      const pending = await first.json() as {taskId:string};
      await unlink(blockedTarget);

      const replay = await withExpiredCreateClaim(store,key,() =>
        auth.request("POST", `/api/v1/projects/${auth.projectId}/tasks`, input, key)
      );
      assert.equal(replay.status, 200);
      assert.equal((await replay.json() as {task:{id:string}}).task.id, pending.taskId);
    } finally {
      store.createTaskAtomically = createAtomically;
      const current = await store.findEndpoint(originalEndpoint.id);
      if (current) {
        const updatedAt = new Date(Date.parse(current.updatedAt) + 1).toISOString();
        await store.updateEndpointHealth(
          current.id,
          current.projectId,
          { status:"healthy",checkedAt:updatedAt,errorCategory:null },
          updatedAt,
          current.updatedAt
        );
      }
    }
  });

  it("reclaims an expired create lease with the persisted Task identity", async () => {
    const createAtomically = store.createTaskAtomically.bind(store);
    const beginTaskIdempotency = store.beginTaskIdempotency.bind(store);
    let blockedTarget = "";
    let expireNextClaim = false;
    try {
      store.beginTaskIdempotency = async (input) => {
        if (expireNextClaim && input.operation === "create") {
          expireNextClaim = false;
          const now = new Date(Date.now() + 120_000).toISOString();
          return beginTaskIdempotency({
            ...input,
            now,
            leaseExpiresAt:new Date(Date.parse(now) + 30_000).toISOString()
          });
        }
        return beginTaskIdempotency(input);
      };
      store.createTaskAtomically = async (input) => {
        const result = await createAtomically(input);
        if (result.kind === "created") {
          const project = await store.findProject(input.task.projectId);
          assert.ok(project);
          blockedTarget = path.join(dataRoot, project.rootPath, "tasks", input.task.id);
          await mkdir(path.dirname(blockedTarget), { recursive: true });
          await writeFile(blockedTarget, "blocks promotion");
        }
        return result;
      };

      const input = taskCreateInput(auth.endpointId, "Expired lease identity", "Expired lease files");
      const key = "task-create-expired-lease";
      const first = await auth.request("POST", `/api/v1/projects/${auth.projectId}/tasks`, input, key);
      assert.equal(first.status, 202);
      const pending = await first.json() as {taskId:string};
      await unlink(blockedTarget);
      expireNextClaim = true;

      const replay = await auth.request("POST", `/api/v1/projects/${auth.projectId}/tasks`, input, key);
      assert.equal(replay.status, 200);
      assert.equal((await replay.json() as {task:{id:string}}).task.id, pending.taskId);
    } finally {
      store.createTaskAtomically = createAtomically;
      store.beginTaskIdempotency = beginTaskIdempotency;
    }
  });

  it("returns accepted when a post-admission identity read fails", async () => {
    const createAtomically = store.createTaskAtomically.bind(store);
    const findFileLibrary = store.findFileLibrary.bind(store);
    let failNextLibraryRead = false;
    try {
      store.createTaskAtomically = async (input) => {
        const result = await createAtomically(input);
        if (result.kind === "created") failNextLibraryRead = true;
        return result;
      };
      store.findFileLibrary = async (id) => {
        if (failNextLibraryRead) {
          failNextLibraryRead = false;
          throw new Error("post-admission File Library read failed");
        }
        return findFileLibrary(id);
      };

      const input = taskCreateInput(auth.endpointId, "Post-admission read", "Read recovery files");
      const key = "task-create-post-admission-read";
      const first = await auth.request("POST", `/api/v1/projects/${auth.projectId}/tasks`, input, key);
      assert.equal(first.status, 202);
      assert.deepEqual(await first.json(), {
        outcome:"accepted_in_progress",
        keyDisposition:"retain",
        taskId:(await store.listTasksForProject(auth.projectId)).find((task) => task.prompt === input.prompt)?.id
      });

      store.findFileLibrary = findFileLibrary;
      const replay = await withExpiredCreateClaim(store,key,() =>
        auth.request("POST", `/api/v1/projects/${auth.projectId}/tasks`, input, key)
      );
      assert.equal(replay.status, 200);
    } finally {
      store.createTaskAtomically = createAtomically;
      store.findFileLibrary = findFileLibrary;
    }
  });
});

function taskCreateInput(endpointId:string,prompt:string,libraryName:string) {
  return {
    prompt,
    endpointId,
    fileLibrary: { mode: "create_new" as const, name: libraryName }
  };
}

function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  let settled = false;
  return {
    promise,
    get settled() { return settled; },
    resolve() {
      if (settled) return;
      settled = true;
      resolvePromise();
    }
  };
}

async function withExpiredCreateClaim<T>(
  store:ReturnType<typeof createLocalInMemoryProductStore>,
  key:string,
  action:()=>Promise<T>
):Promise<T>{
  const beginTaskIdempotency=store.beginTaskIdempotency.bind(store);
  store.beginTaskIdempotency=(candidate)=>candidate.operation==="create"&&candidate.key===key
    ?beginTaskIdempotency({
        ...candidate,
        now:new Date(Date.now()+120_000).toISOString(),
        leaseExpiresAt:new Date(Date.now()+150_000).toISOString()
      })
    :beginTaskIdempotency(candidate);
  try{return await action();}
  finally{store.beginTaskIdempotency=beginTaskIdempotency;}
}

function liveTaskServiceOptions(store:ReturnType<typeof createLocalInMemoryProductStore>,dataRoot:string) {
  return {
    store,
    dataRoot,
    builtinAdminPassword:"production-admin-password",
    sessionSecret:"0123456789abcdef0123456789abcdef",
    sandboxNamespaceLimit:100,
    botifiedServiceKeyFactory:({taskId}:{taskId:string}) => `service-key-${taskId}`,
    botifiedClient:new class extends DryRunBotifiedRuntimeHttpClient {
      override async readState(_baseUrl?:string,serviceKey?:string) {
        const sessionId=serviceKey?.slice("service-key-".length);
        return{
          ...(sessionId===undefined?{}:{sessionId}),
          snapshot:{...(sessionId===undefined?{}:{session_id:sessionId})},
          state:"idle"
        };
      }
    },
    providerClient:{
      async validateEndpoint() { return {status:"healthy" as const}; },
      async completeChat() { throw new Error("not used"); }
    },
    liveSandbox:{
      port:{
        async applyResource() { return "applied" as const; },
        async deleteResource() { return "deleted" as const; },
        async getPodReadiness() { return "ready" as const; },
        async listManagedResources() { return []; }
      }
    }
  };
}

async function createLiveProjectFixture(
  store:ReturnType<typeof createLocalInMemoryProductStore>,
  dataRoot:string,
  label:string
) {
  const services=createApplicationServices(liveTaskServiceOptions(store,dataRoot));
  const {user}=await services.auth.loginAfterBootstrap("production-admin-password");
  const workspace=await services.workspaces.createWorkspace(user.id,{name:label});
  const project=await services.workspaces.createProject(user.id,workspace.id,{name:label,sandboxLimit:10});
  const credential=await services.credentials.create(user.id,project.id,{
    name:`${label} credential`,
    baseUrl:"https://models.example.test/v1",
    secret:"secret"
  });
  const endpoint=await services.endpoints.createEndpoint(user.id,project.id,{
    name:`${label} endpoint`,
    protocol:"openai_chat_completions",
    baseUrl:credential.baseUrl,
    model:"model",
    credentialId:credential.id,
    capabilities:["text","tool_calls"],
    requestTimeoutSecs:30
  });
  return{services,user,workspace,project,endpoint};
}

async function createProjectWithEndpoint(baseUrl:string,password="admin-password") {
  await fetch(baseUrl + "/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password })
  });
  const login = await fetch(baseUrl + "/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@agentsmith-lite.local", password })
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const csrf = (await login.json() as {csrfToken:string}).csrfToken;
  let idempotency = 0;
  const request = (method:string,pathname:string,body?:unknown,key?:string) => {
    const headers:Record<string,string> = { "content-type": "application/json", cookie };
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) headers["x-csrf-token"] = csrf;
    if (key) headers["idempotency-key"] = key;
    else if (method === "POST") headers["idempotency-key"] = `task-command-setup-${++idempotency}`;
    return fetch(baseUrl + pathname, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  };
  const requestJson = async (method:string,pathname:string,body?:unknown,key?:string) => {
    const response = await request(method, pathname, body, key);
    if (response.status !== 200) assert.fail(await response.text());
    return response.json();
  };
  const workspace = (await requestJson("POST", "/api/v1/workspaces", {name:"Commands"})).workspace;
  const project = await requestJson("POST", `/api/v1/workspaces/${workspace.id}/projects`, {
    name:"Commands",
    sandboxLimit:100
  });
  const credential = await requestJson("POST", `/api/v1/projects/${project.id}/credentials`, {
    name: "Credential",
    baseUrl: "https://models.example.test/v1",
    secret: "secret"
  });
  const endpoint = await requestJson("POST", `/api/v1/projects/${project.id}/endpoints`, {
    name: "Endpoint",
    protocol: "openai_chat_completions",
    baseUrl: credential.baseUrl,
    model: "model",
    credentialId: credential.id,
    capabilities: ["text", "tool_calls"],
    requestTimeoutSecs: 30
  });
  return {
    workspaceId: workspace.id as string,
    projectId: project.id as string,
    endpointId: endpoint.id as string,
    request,
    requestJson
  };
}
