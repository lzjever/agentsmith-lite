import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BotifiedHttpError,
  FetchBotifiedRuntimeHttpClient
} from "../../packages/ports/src/botified.js";

type FetchCall = {
  url: string;
  init: RequestInit;
};

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
  it("checks healthz without bearer auth and posts messages with the service key", async () => {
    const calls: FetchCall[] = [];
    const client = new FetchBotifiedRuntimeHttpClient(async (input, init = {}) => {
      const call = { url: String(input), init };
      calls.push(call);

      if (call.url === "http://botified.local/healthz") {
        assert.equal(new Headers(init.headers).has("authorization"), false);
        return jsonResponse({ ok: true });
      }

      assert.equal(call.url, "http://botified.local/v1/messages");
      assert.equal(init.method, "POST");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer service-secret");
      assert.deepEqual(JSON.parse(String(init.body)), { text: "hello" });
      return jsonResponse({
        ok: true,
        kind: "input_accepted",
        message_id: "msg_1",
        timeline_cursor: "timeline:main:1"
      });
    });

    assert.deepEqual(await client.health("http://botified.local", "service-secret"), { status: "ok" });
    assert.deepEqual(await client.postMessage("http://botified.local", "service-secret", "hello"), {
      accepted: true,
      kind: "input_accepted",
      messageId: "msg_1",
      cursor: "timeline:main:1"
    });
    assert.equal(calls.length, 2);
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

  it("turns stale timeline cursors into a structured reset result from the tail page", async () => {
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

      assert.equal(String(input), "http://botified.local/v1/timeline?tail=1");
      return new Response("{\"seq\":9,\"cursor\":\"timeline:main:9\"}\n", {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson",
          "x-botified-history-boundary": "none",
          "x-botified-next-cursor": "timeline:main:9",
          "x-botified-page-start-cursor": "timeline:main:9",
          "x-botified-page-end-cursor": "timeline:main:9"
        }
      });
    });

    assert.deepEqual(await client.readTimeline("http://botified.local", "service-secret", "timeline:main:stale"), {
      status: "reset",
      reason: "stale_cursor",
      historyBoundary: "expired",
      events: [{ seq: 9, cursor: "timeline:main:9" }],
      nextCursor: "timeline:main:9",
      pageStartCursor: "timeline:main:9",
      pageEndCursor: "timeline:main:9"
    });
    assert.deepEqual(urls, [
      "http://botified.local/v1/timeline?cursor=timeline%3Amain%3Astale&limit=200",
      "http://botified.local/v1/timeline?tail=1"
    ]);
  });

  it("uploads files and aborts with bearer auth", async () => {
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
      return jsonResponse({ ok: true, queue_length: 0, state: "stopped" });
    });

    assert.deepEqual(await client.uploadFile("http://botified.local", "service-secret", {
      filename: "note.txt",
      mimeType: "text/plain",
      bytes: new Uint8Array([1, 2, 3])
    }), {
      files: [{ file_id: "file_1", filename: "note.txt" }]
    });
    assert.deepEqual(await client.abort("http://botified.local", "service-secret"), {
      aborted: true,
      queueLength: 0,
      state: "stopped"
    });
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
      client.abort("http://botified.local", "service-secret"),
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
});
