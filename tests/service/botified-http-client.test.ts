import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BotifiedHttpError,
  FetchBotifiedRuntimeHttpClient
} from "../../packages/ports/src/botified.js";
import { MAX_TASK_ARTIFACT_BYTES } from "../../packages/domain/src/sandboxDefaults.js";

type FetchCall = {
  url: string;
  init: RequestInit;
};

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const item of items) values.push(item);
  return values;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers
    }
  });
}

describe("Botified HTTP client", () => {
  it("aborts a pending health request with the caller readiness signal",async()=>{
    let observedSignal:AbortSignal|undefined;
    const client=new FetchBotifiedRuntimeHttpClient(async(_input,init={})=>{
      observedSignal=init.signal??undefined;
      return new Promise<Response>((_resolve,reject)=>{
        observedSignal?.addEventListener("abort",()=>reject(observedSignal?.reason),{once:true});
      });
    },60_000);
    const controller=new AbortController();
    const health=client.health("http://botified.local",undefined,controller.signal);
    await new Promise<void>((resolve)=>setImmediate(resolve));

    controller.abort(new Error("readiness deadline elapsed"));

    await assert.rejects(health,/readiness deadline elapsed/);
    assert.equal(observedSignal?.aborted,true);
  });

  it("aborts a pending state identity read with the caller startup signal",async()=>{
    let observedSignal:AbortSignal|undefined;
    const client=new FetchBotifiedRuntimeHttpClient(async(_input,init={})=>{
      observedSignal=init.signal??undefined;
      return new Promise<Response>((_resolve,reject)=>{
        observedSignal?.addEventListener("abort",()=>reject(observedSignal?.reason),{once:true});
      });
    },60_000);
    const controller=new AbortController();
    const read=client.readState("http://botified.local","service-secret",controller.signal);
    await new Promise<void>((resolve)=>setImmediate(resolve));

    controller.abort(new Error("startup identity deadline elapsed"));

    await assert.rejects(read,/startup identity deadline elapsed/);
    assert.equal(observedSignal?.aborted,true);
  });

  it("checks healthz without bearer auth", async () => {
    const calls: FetchCall[] = [];
    const client = new FetchBotifiedRuntimeHttpClient(async (input, init = {}) => {
      const call = { url: String(input), init };
      calls.push(call);
      assert.equal(call.url, "http://botified.local/healthz");
      assert.equal(new Headers(init.headers).has("authorization"), false);
      return jsonResponse({ ok: true });
    });

    assert.deepEqual(await client.health("http://botified.local", "service-secret"), { status: "ok" });
    assert.equal(calls.length, 1);
  });

  it("posts one v0.4.44 message and accepts each ordinary admission kind", async () => {
    for (const kind of ["input_accepted", "input_queued", "input_duplicate"] as const) {
      let calls = 0;
      const client = new FetchBotifiedRuntimeHttpClient(async (input, init = {}) => {
        calls += 1;
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer service-secret");
        assert.equal(init.method, "POST");
        assert.equal(String(input), "http://botified.local/v1/messages");
        assert.deepEqual(JSON.parse(String(init.body)), {
          client_message_id: "message-1",
          text: "run once"
        });
        return jsonResponse({
          ok: true,
          kind,
          input_id: "message-1",
          message_id: "message-1",
          timeline_cursor: "evt_1",
          queue_length: 1,
          state: "running"
        });
      });

      assert.deepEqual(await client.postMessage("http://botified.local", "service-secret", {
        messageId: "message-1",
        text: "run once"
      }), {
        type: "ordinary",
        kind,
        inputId: "message-1",
        messageId: "message-1",
        timelineCursor: "evt_1",
        queueLength: 1,
        state: "running"
      });
      assert.equal(calls, 1);
    }
  });

  it("returns a successful slash response as opaque command data without inventing a cursor", async () => {
    const response = { ok: true, command: "tasks", rows: [{ id: "task_1" }] };
    const client = new FetchBotifiedRuntimeHttpClient(async () => jsonResponse(response));

    assert.deepEqual(await client.postMessage("http://botified.local", "service-secret", {
      messageId: "message-slash",
      text: "/tasks"
    }), {
      type: "slash",
      response
    });
  });

  it("rejects malformed ordinary message admissions", async () => {
    const client = new FetchBotifiedRuntimeHttpClient(async () => jsonResponse({
      ok: true,
      kind: "input_accepted",
      input_id: "message-1",
      message_id: "message-1",
      queue_length: 0,
      state: "idle"
    }));

    await assert.rejects(
      () => client.postMessage("http://botified.local", "service-secret", {
        messageId: "message-1",
        text: "run once"
      }),
      (error: unknown) => error instanceof BotifiedHttpError
        && error.code === "invalid_message_response"
    );
  });

  it("sends bearer auth for timeline reads and ignores blank heartbeat lines", async () => {
    const client = new FetchBotifiedRuntimeHttpClient(async (input, init = {}) => {
      assert.equal(String(input), "http://botified.local/v1/timeline?cursor=timeline%3Amain%3A0&limit=200");
      assert.equal(init.method, "GET");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer service-secret");
      return new Response("\n{\"seq\":1,\"cursor\":\"timeline:main:1\"}\n\n{\"seq\":2,\"cursor\":\"timeline:main:2\"}\n", {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson",
          "x-botified-has-more-after": "false",
          "x-botified-next-cursor": "timeline:main:2"
        }
      });
    });

    assert.deepEqual(await client.readTimeline("http://botified.local", "service-secret", "timeline:main:0"), {
      status: "ok",
      events: [
        { seq: 1, cursor: "timeline:main:1" },
        { seq: 2, cursor: "timeline:main:2" }
      ],
      hasMoreAfter: false,
      nextCursor: "timeline:main:2"
    });
  });

  it("reads runtime state without promoting turn identity into Abort authority", async () => {
    const client = new FetchBotifiedRuntimeHttpClient(async (input, init = {}) => {
      assert.equal(String(input), "http://botified.local/v1/state");
      assert.equal(init.method, "GET");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer service-secret");
      return jsonResponse({
        session_id: "session_1",
        state: "running",
        turn_id: "turn_1",
        timeline_cursor: "timeline:main:4",
        active_items: [{ id: "service", type: "service_status", status: "running" }]
      });
    });

    assert.deepEqual(await client.readState("http://botified.local", "service-secret"), {
      snapshot: {
        session_id: "session_1",
        state: "running",
        turn_id: "turn_1",
        timeline_cursor: "timeline:main:4",
        active_items: [{ id: "service", type: "service_status", status: "running" }]
      },
      sessionId: "session_1",
      state: "running",
      timelineCursor: "timeline:main:4",
      activeItems: [{ id: "service", type: "service_status", status: "running" }]
    });
  });

  it("reads typed history pages and returns an explicit gap for an expired cursor", async () => {
    const urls: string[] = [];
    const client = new FetchBotifiedRuntimeHttpClient(async (input, init = {}) => {
      urls.push(String(input));
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer service-secret");

      if (String(input).includes("cursor=timeline%3Amain%3Astale")) {
        return jsonResponse(
          {
            ok: false,
            error: {
              code: "stale_cursor",
              message: "cursor is outside the retained event window",
              retryable: true,
              history_boundary: "expired"
            }
          },
          {
            status: 410,
            headers: {
              "x-botified-history-boundary": "expired"
            }
          }
        );
      }

      assert.equal(String(input), "http://botified.local/v1/timeline?tail=50");
      return new Response("{\"seq\":8,\"cursor\":\"timeline:main:8\"}\n{\"seq\":9,\"cursor\":\"timeline:main:9\"}\n", {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson",
          "x-botified-history-boundary": "expired",
          "x-botified-next-cursor": "timeline:main:9",
          "x-botified-page-start-cursor": "timeline:main:8",
          "x-botified-page-end-cursor": "timeline:main:9",
          "x-botified-has-more-before": "true"
        }
      });
    });

    assert.deepEqual(await client.readTimeline("http://botified.local", "service-secret", "timeline:main:stale"), {
      status: "gap",
      reason: "stale_cursor",
      historyBoundary: "expired",
      events: []
    });
    assert.deepEqual(await client.readTimeline("http://botified.local", "service-secret", undefined, {
      direction: "history",
      limit: 50
    }), {
      status: "ok",
      events: [
        { seq: 8, cursor: "timeline:main:8" },
        { seq: 9, cursor: "timeline:main:9" }
      ],
      nextCursor: "timeline:main:9",
      pageStartCursor: "timeline:main:8",
      pageEndCursor: "timeline:main:9",
      hasMoreBefore: true,
      historyBoundary: "expired"
    });
    assert.deepEqual(urls, [
      "http://botified.local/v1/timeline?cursor=timeline%3Amain%3Astale&limit=200",
      "http://botified.local/v1/timeline?tail=50"
    ]);
  });

  it("streams typed LLM previews", async () => {
    const client = new FetchBotifiedRuntimeHttpClient(async (input, init = {}) => {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer service-secret");
      if (String(input) === "http://botified.local/v1/llm-text-preview?provider_request_id=request_1&cycle_id=cycle_1&input_id=input_1") {
        assert.equal(init.method, "GET");
        return new Response([
          "event: started\n",
          "data: {\"type\":\"started\",\"time\":\"unix:1\",\"provider_request_id\":\"request_1\",\"turn_id\":\"turn_1\",\"cycle_id\":\"cycle_1\",\"provider_call_index\":0,\"input_ids\":[\"input_1\"]}\n\n",
          "event: text_delta\n",
          "data: {\"type\":\"text_delta\",\"time\":\"unix:2\",\"provider_request_id\":\"request_1\",\"provider_call_index\":0,\"input_ids\":[\"input_1\"],\"delta\":\"hello\"}\n\n"
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      }

      throw new Error(`Unexpected request: ${String(input)}`);
    });

    assert.deepEqual(await collect(client.streamLlmTextPreview("http://botified.local", "service-secret", {
      providerRequestId: "request_1",
      cycleId: "cycle_1",
      inputId: "input_1"
    })), [
      {
        type: "started",
        time: "unix:1",
        providerRequestId: "request_1",
        turnId: "turn_1",
        cycleId: "cycle_1",
        providerCallIndex: 0,
        inputIds: ["input_1"]
      },
      {
        type: "text_delta",
        time: "unix:2",
        providerRequestId: "request_1",
        providerCallIndex: 0,
        inputIds: ["input_1"],
        delta: "hello"
      }
    ]);
  });

  it("uploads files and sends a bodyless abort", async () => {
    const client = new FetchBotifiedRuntimeHttpClient(async (input, init = {}) => {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer service-secret");

      if (String(input) === "http://botified.local/v1/files") {
        assert.equal(init.method, "POST");
        assert.equal(init.body instanceof FormData, true);
        const file = (init.body as FormData).get("file");
        assert.equal(file instanceof File, true);
        assert.equal((file as File).name, "note.txt");
        return jsonResponse({ ok: true, files: [{ file_id: "file_1", filename: "note.txt" }] });
      }

      assert.equal(String(input), "http://botified.local/v1/abort");
      assert.equal(init.method, "POST");
      assert.equal(init.body, undefined);
      return jsonResponse({
        ok: true,
        state: "aborting",
        queue_length: 2
      });
    });

    assert.deepEqual(await client.uploadFile("http://botified.local", "service-secret", {
      filename: "note.txt",
      mimeType: "text/plain",
      bytes: new Uint8Array([1, 2, 3])
    }), {
      files: [{ file_id: "file_1", filename: "note.txt" }]
    });
    assert.deepEqual(await client.abort("http://botified.local", "service-secret"), {
      ok: true,
      state: "aborting",
      queueLength: 2
    });
  });

  it("downloads files with bearer auth and returns response metadata", async () => {
    const client = new FetchBotifiedRuntimeHttpClient(async (input, init = {}) => {
      assert.equal(String(input), "http://botified.local/v1/files/file_1");
      assert.equal(init.method, "GET");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer service-secret");
      return new Response(new Uint8Array([104, 101, 108, 108, 111]), {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-disposition": "attachment; filename=\"artifact.txt\"",
          "x-botified-sha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        }
      });
    });

    const downloaded = await client.downloadFile("http://botified.local", "service-secret", "file_1");

    assert.deepEqual([...downloaded.bytes], [104, 101, 108, 108, 111]);
    assert.deepEqual({
      filename: downloaded.filename,
      mimeType: downloaded.mimeType,
      sizeBytes: downloaded.sizeBytes,
      sha256: downloaded.sha256
    }, {
      filename: "artifact.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    });
  });

  it("rejects a Botified artifact whose declared content length exceeds the product limit", async () => {
    const client = new FetchBotifiedRuntimeHttpClient(async () =>
      new Response(null, {
        status: 200,
        headers: { "content-length": String(MAX_TASK_ARTIFACT_BYTES + 1) }
      })
    );

    await assert.rejects(
      client.downloadFile("http://botified.local", "service-secret", "oversize"),
      (error: unknown) => {
        assert.ok(error instanceof BotifiedHttpError);
        assert.equal(error.status, 413);
        assert.equal(error.code, "artifact_too_large");
        return true;
      }
    );
  });

  it("stops a chunked Botified artifact when its downloaded bytes exceed the product limit", async () => {
    const client = new FetchBotifiedRuntimeHttpClient(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_TASK_ARTIFACT_BYTES));
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        }
      });
      return new Response(body, { status: 200 });
    });

    await assert.rejects(
      client.downloadFile("http://botified.local", "service-secret", "chunked-oversize"),
      (error: unknown) => {
        assert.ok(error instanceof BotifiedHttpError);
        assert.equal(error.status, 413);
        assert.equal(error.code, "artifact_too_large");
        return true;
      }
    );
  });

  it("raises structured HTTP errors without swallowing server details", async () => {
    const client = new FetchBotifiedRuntimeHttpClient(async () =>
      jsonResponse(
        {
          ok: false,
          error: {
            code: "persistence_error",
            message: "timeline write failed",
            retryable: true
          },
          timeline_cursor: "timeline:main:4"
        },
        { status: 500 }
      )
    );

    await assert.rejects(
      client.abort("http://botified.local","service-secret"),
      (error: unknown) => {
        assert.equal(error instanceof BotifiedHttpError, true);
        const httpError = error as BotifiedHttpError;
        assert.equal(httpError.status, 500);
        assert.equal(httpError.code, "persistence_error");
        assert.equal(httpError.retryable, true);
        assert.equal(httpError.timelineCursor, "timeline:main:4");
        assert.equal(httpError.message, "timeline write failed");
        return true;
      }
    );
  });

  it("raises structured HTTP errors for runtime state reads", async () => {
    const client = new FetchBotifiedRuntimeHttpClient(async () =>
      jsonResponse(
        {
          ok: false,
          error: {
            code: "unauthorized",
            message: "missing bearer",
            retryable: false
          }
        },
        { status: 401 }
      )
    );

    await assert.rejects(
      client.readState("http://botified.local", "service-secret"),
      (error: unknown) => {
        assert.equal(error instanceof BotifiedHttpError, true);
        const httpError = error as BotifiedHttpError;
        assert.equal(httpError.status, 401);
        assert.equal(httpError.code, "unauthorized");
        assert.equal(httpError.retryable, false);
        assert.equal(httpError.message, "missing bearer");
        return true;
      }
    );
  });
});
