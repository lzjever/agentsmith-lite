import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOTIFIED_TIMELINE_VERSION,
  parseBotifiedTimelineEvent,
  parseBotifiedTimelineEvents,
  type BotifiedTimelineEvent
} from "../../packages/botified-runtime/src/projection.js";
import { redactInteractionText, redactSecretLikeText } from "../../packages/botified-runtime/src/redaction.js";
import {
  projectTaskInteraction,
  type BotifiedTaskInteractionSource,
  type ProductTaskInteractionSource,
  type TaskInteractionProjectionResult,
  type TaskInteractionProjectionState
} from "../../packages/application/src/taskInteractionProjector.js";

describe("canonical Botified timeline parsing", () => {
  it("preserves the complete canonical envelope and ignores non-envelope fields", () => {
    const raw = {
      version: BOTIFIED_TIMELINE_VERSION,
      seq: 7,
      cursor: "evt_proc7_7",
      time: "2026-07-13T10:00:07.000Z",
      session_id: "session-1",
      type: "assistant_message.completed",
      trace: { cycle_id: "cycle-1", ignored: true },
      item: { id: "item-1", type: "assistant_message", status: "completed", ignored: true },
      data: { nested: { value: 1 } },
      payload: { legacy: true },
      unknown_top: true
    };

    const parsed = parseBotifiedTimelineEvent(raw);
    assert.deepEqual(parsed, {
      version: BOTIFIED_TIMELINE_VERSION,
      seq: 7,
      cursor: "evt_proc7_7",
      time: "2026-07-13T10:00:07.000Z",
      session_id: "session-1",
      type: "assistant_message.completed",
      trace: { cycle_id: "cycle-1" },
      item: { id: "item-1", type: "assistant_message", status: "completed" },
      data: { nested: { value: 1 } }
    });
    (raw.data.nested as { value: number }).value = 2;
    assert.deepEqual(parsed?.data, { nested: { value: 1 } });
    const withoutItem = { ...raw };
    delete (withoutItem as { item?: unknown }).item;
    assert.equal(parseBotifiedTimelineEvent(withoutItem)?.item, null);
  });

  it("normalizes live Unix seconds and valid ISO offsets before projection", () => {
    const parsed = parseBotifiedTimelineEvent({
      ...canonicalEvent(17, "file.published", {
        file_id: "file-unix",
        filename: "unix.txt",
        mime_type: "text/plain",
        size_bytes: 4
      }, "file"),
      time: "unix:1784011517"
    });
    assert.equal(parsed?.time, "2026-07-14T06:45:17.000Z");
    const projected = projectBotified(parsed!);
    assert.equal(projected.interaction?.occurredAt, "2026-07-14T06:45:17.000Z");
    assert.equal(projected.artifact?.createdAt, "2026-07-14T06:45:17.000Z");

    const offset = parseBotifiedTimelineEvent({
      ...canonicalEvent(18, "assistant_message.completed", { assistant_message_id: "assistant-offset" }),
      time: "2026-07-13T23:45:17-07:00"
    });
    assert.equal(offset?.time, "2026-07-14T06:45:17.000Z");
  });

  it("rejects partial, legacy, malformed, and cursor-mismatched envelopes", () => {
    const valid = canonicalEvent(3, "assistant_message.completed", { text: "done" });
    assert.equal(parseBotifiedTimelineEvent({ ...valid, version: "botified.timeline.v0" }), null);
    assert.equal(parseBotifiedTimelineEvent({ ...valid, cursor: "c3" }), null);
    assert.equal(parseBotifiedTimelineEvent({ ...valid, cursor: "evt_proc3_2" }), null);
    assert.equal(parseBotifiedTimelineEvent({ ...valid, time: undefined }), null);
    assert.equal(parseBotifiedTimelineEvent({ ...valid, time: "unix:-1" }), null);
    assert.equal(parseBotifiedTimelineEvent({ ...valid, time: "unix:1.5" }), null);
    assert.equal(parseBotifiedTimelineEvent({ ...valid, time: "unix:253402300800" }), null);
    assert.equal(parseBotifiedTimelineEvent({ ...valid, time: "2026-02-30T10:00:00Z" }), null);
    assert.equal(parseBotifiedTimelineEvent({ ...valid, time: "2026-07-13T10:00:00+14:01" }), null);
    assert.equal(parseBotifiedTimelineEvent({ ...valid, time: "2026-07-13T10:00:00" }), null);
    assert.equal(parseBotifiedTimelineEvent({ ...valid, time: "0000-01-01T00:00:00Z" }), null);
    assert.equal(parseBotifiedTimelineEvent({ ...valid, trace: {} }), null);
    assert.equal(parseBotifiedTimelineEvent({ ...valid, item: { id: "x", type: "tool" } }), null);
    assert.equal(parseBotifiedTimelineEvent({ ...valid, data: ["not", "an", "object"] }), null);
    assert.equal(parseBotifiedTimelineEvent({ cursor: "c3", seq: 3, type: "assistant.message", payload: {} }), null);
    assert.throws(
      () => parseBotifiedTimelineEvents([valid, { ...valid, cursor: "c3" }]),
      /Invalid canonical Botified timeline envelope at index 1/
    );

    let overlyDeep: Record<string, unknown> = { value: "leaf" };
    for (let index = 0; index < 40; index += 1) overlyDeep = { nested: overlyDeep };
    assert.equal(parseBotifiedTimelineEvent({ ...valid, data: overlyDeep }), null);
  });
});

describe("task interaction projection", () => {
  it("lets canonical acceptance correct an ambiguous local failure",()=>{
    const failed=projectProduct({
      sourceKind:"product",type:"message_delivery",taskId:"task-1",sourceId:"message:message-1",
      sourceRevision:1,occurredAt:"2026-07-13T10:00:00.000Z",position:1,messageId:"message-1",
      actorId:"actor-a",content:"hello",status:"failed"
    });
    const accepted=projectBotified(canonicalEvent(2,"input.accepted",{
      input_id:"message-1",source:"user",text:"hello"
    }),state(failed));
    assert.equal(accepted.interaction?.kind,"user_message");
    assert.equal(accepted.interaction?.status,"accepted");
    assert.equal(accepted.interaction?.actorId,"actor-a");
  });

  it("projects the command field emitted by the Botified timeline", () => {
    const projected = projectBotified(canonicalEvent(
      1,
      "command_execution.completed",
      { tool_call_id: "call-command", command: "printf 'done\\n'", output_tail: "done\n", exit_code: 0 },
      "command_execution"
    ));

    assert.equal(field(projected, "command"), "printf 'done\\n'");
  });

  it("projects every public high-value interaction kind from canonical or product sources", () => {
    const cases: Array<[BotifiedTimelineEvent, string]> = [
      [canonicalEvent(1, "input.accepted", { input_id: "input-1", source: "user", text: "hello" }), "user_message"],
      [canonicalEvent(2, "assistant_message.completed", { assistant_message_id: "assistant-1", text: "hi" }, "assistant_message"), "assistant_message"],
      [canonicalEvent(3, "command_execution.started", { tool_call_id: "call-1", arguments_summary: "list files" }, "command_execution"), "tool"],
      [canonicalEvent(4, "background_task.started", { task_id: "work-1", task_label: "Indexer", work_summary: "Index files" }, "background_task"), "background_task"],
      [canonicalEvent(5, "task_ask.requested", { task_id: "work-1", ask_id: "ask-1", question: "Continue?" }, "task_ask"), "task_question"],
      [canonicalEvent(6, "task_tell.accepted", { task_id: "work-1", tell_id: "tell-1", notice: "Checkpoint reached" }, "task_tell"), "task_notice"],
      [canonicalEvent(7, "subagent.callback", { callback_kind: "task_completed", callback_status: "pending", task_id: "work-1", subagent_id: "sub-1", task_message: "Indexed" }, "subagent"), "task_result"],
      [canonicalEvent(8, "subagent.completed", { subagent_id: "sub-1", name: "Reviewer", latest_result: "Approved" }, "subagent"), "subagent_result"],
      [canonicalEvent(9, "file.published", { file_id: "file-1", filename: "result.txt", mime_type: "text/plain", size_bytes: 12 }, "file"), "file"],
      [canonicalEvent(10, "cycle.failed", { cycle_id: "cycle-1", message: "Provider unavailable", retryable: true }, "cycle"), "system_error"]
    ];

    for (const [event, expectedKind] of cases) {
      const result = projectBotified(event);
      assert.equal(result.interaction?.kind, expectedKind, event.type);
      assert.equal(result.interaction?.revision, 1, event.type);
      assert.equal(result.interaction?.position, event.seq, event.type);
    }

  });

  it("skips canonical tool-call-only assistant completions without disturbing a visible final projection", () => {
    const preview: TaskInteractionProjectionState = {
      interaction: {
        id: "preview_assistant-deepseek",
        revision: 1,
        taskId: "task-1",
        kind: "assistant_message",
        title: "Assistant",
        body: "Inspecting the project",
        contentMode: "preview",
        status: "generating",
        position: 1,
        occurredAt: "2026-07-13T10:00:01.000Z",
        updatedAt: "2026-07-13T10:00:01.000Z"
      }
    };
    const toolCallOnly = {
      ...canonicalEvent(2, "assistant_message.completed", {
        assistant_message_id: "assistant-deepseek-tool-call",
        provider_request_id: "provider-deepseek-1",
        message_index: 1,
        text: "",
        content_preview: "",
        content_bytes: 0,
        content_truncated: false,
        content_kind: "text",
        tool_call_count: 1,
        usage: null,
        stop_reason: "tool_calls"
      }, "assistant_message"),
      item: { id: "assistant-deepseek-tool-call", type: "assistant_message", status: "completed" }
    };

    assert.deepEqual(projectBotified(toolCallOnly, preview), { interaction: null });

    const visibleFinal = projectBotified({
      ...canonicalEvent(3, "assistant_message.completed", {
        assistant_message_id: "assistant-deepseek-final",
        provider_request_id: "provider-deepseek-2",
        message_index: 2,
        text: "Finished the requested work.",
        content_preview: "Finished the requested work.",
        content_bytes: 28,
        content_truncated: false,
        content_kind: "text",
        tool_call_count: 0,
        usage: null,
        stop_reason: "stop"
      }, "assistant_message"),
      item: { id: "assistant-deepseek-final", type: "assistant_message", status: "completed" }
    });
    assert.equal(visibleFinal.interaction?.kind, "assistant_message");
    assert.equal(visibleFinal.interaction?.body, "Finished the requested work.");
    assert.equal(visibleFinal.interaction?.contentMode, "full");
    assert.equal(field(visibleFinal, "status"), "completed");
  });

  it("keeps the public ID while promoting a tool to detached background work", () => {
    const tool = projectBotified(canonicalEvent(
      1,
      "command_execution.started",
      { tool_call_id: "call-detached", arguments_summary: "run indexer" },
      "command_execution"
    ));
    const promoted = projectBotified(
      canonicalEvent(
        2,
        "background_task.started",
        { task_id: "work-detached", tool_call_id: "call-detached", task_label: "Indexer", work_summary: "Index project" },
        "background_task"
      ),
      state(tool)
    );

    assert.equal(tool.interaction?.kind, "tool");
    assert.equal(promoted.interaction?.kind, "background_task");
    assert.equal(promoted.interaction?.id, tool.interaction?.id);
    assert.equal(promoted.interaction?.revision, 2);
    assert.deepEqual(promoted.correlation, { toolCallId: "call-detached", workTaskId: "work-detached" });
    assert.equal(promoted.interaction?.occurredAt, tool.interaction?.occurredAt);
    assert.equal(promoted.interaction?.position, tool.interaction?.position);

    const replayedFromTask = projectBotified(canonicalEvent(
      2,
      "background_task.started",
      { task_id: "work-detached", tool_call_id: "call-detached", work_summary: "Index project" },
      "background_task"
    ));
    assert.equal(replayedFromTask.interaction?.id, tool.interaction?.id);
  });

  it("preserves terminal execution and delivery states under late updates", () => {
    const running = projectBotified(canonicalEvent(
      1,
      "background_task.started",
      { task_id: "work-1", work_summary: "Compile" },
      "background_task"
    ));
    const completed = projectBotified(
      canonicalEvent(2, "background_task.completed", { task_id: "work-1", result_text: "Build complete" }, "background_task"),
      state(running)
    );
    const lateRunning = projectBotified(
      canonicalEvent(3, "background_task.started", { task_id: "work-1", work_summary: "stale" }, "background_task"),
      state(completed)
    );
    assert.equal(field(lateRunning, "executionStatus"), "completed");
    assert.equal(lateRunning.interaction?.body, "Build complete");

    const deliveryFailed = projectBotified(
      canonicalEvent(4, "background_task.callback_failed", {
        task_id: "work-1",
        callback_id: "callback-1",
        status: "completed",
        callback_failure_reason: "Main agent unavailable"
      }, "background_task"),
      state(lateRunning)
    );
    const lateDelivered = projectBotified(
      canonicalEvent(5, "background_task.callback_delivered", {
        task_id: "work-1",
        callback_id: "callback-1",
        status: "running"
      }, "background_task"),
      state(deliveryFailed)
    );
    assert.equal(deliveryFailed.interaction?.kind, "task_result");
    assert.equal(field(deliveryFailed, "executionStatus"), "completed");
    assert.equal(field(deliveryFailed, "deliveryStatus"), "failed");
    assert.equal(field(lateDelivered, "executionStatus"), "completed");
    assert.equal(field(lateDelivered, "deliveryStatus"), "failed");

    const lateBackgroundUpdate = projectBotified(
      canonicalEvent(6, "background_task.started", { task_id: "work-1", work_summary: "stale again" }, "background_task"),
      state(lateDelivered)
    );
    assert.equal(lateBackgroundUpdate.interaction?.kind, "task_result");
    assert.equal(field(lateBackgroundUpdate, "executionStatus"), "completed");
    assert.equal(field(lateBackgroundUpdate, "deliveryStatus"), "failed");
  });


  it("merges ask/reply and canonical callback identities", () => {
    const asked = projectBotified(canonicalEvent(
      1,
      "task_ask.requested",
      { task_id: "work-1", ask_id: "ask-1", question: "Ship it?", expect: "yes/no" },
      "task_ask"
    ));
    const answered = projectBotified(
      canonicalEvent(2, "task_reply.accepted", { task_id: "work-1", ask_id: "ask-1", answer: "yes" }, "task_ask"),
      state(asked)
    );
    const callback = projectBotified(
      canonicalEvent(3, "subagent.callback_delivered", {
        callback_kind: "task_ask",
        callback_status: "delivered",
        semantic_kind: "subagent_result",
        semantic_status: "failed",
        subagent_id: "subagent-1",
        task_id: "work-1",
        ask_id: "ask-1",
        callback_id: "callback-ask-1",
        question: "Ship it?"
      }, "subagent"),
      state(answered)
    );

    assert.equal(answered.interaction?.id, asked.interaction?.id);
    assert.equal(callback.interaction?.id, asked.interaction?.id);
    assert.equal(field(callback, "status"), "answered");
    assert.deepEqual(callback.correlation, { workTaskId: "work-1", callbackId: "callback-ask-1" });
  });

  it("maps callback kinds and callback delivery independently", () => {
    const question = projectBotified(canonicalEvent(1, "subagent.callback", {
      callback_kind: "task_ask",
      callback_status: "pending",
      callback_id: "callback-question",
      subagent_id: "subagent-1",
      name: "Worker"
    }, "subagent"));
    assert.equal(question.interaction?.kind, "task_question");

    const notice = projectBotified(canonicalEvent(1, "subagent.callback", {
      callback_kind: "task_tell",
      callback_status: "pending",
      callback_id: "callback-notice",
      subagent_id: "subagent-1",
      name: "Worker"
    }, "subagent"));
    assert.equal(notice.interaction?.kind, "task_notice");
    assert.equal(field(notice, "sender"), "Worker");

    const lost = projectBotified(canonicalEvent(2, "subagent.callback", {
      callback_kind: "task_failed",
      callback_status: "pending",
      callback_id: "callback-result",
      subagent_id: "subagent-1",
      name: "Worker",
      latest_error: "Task failed"
    }, "subagent"));
    const delivered = projectBotified(canonicalEvent(3, "subagent.callback_delivered", {
      callback_kind: "task_failed",
      callback_status: "delivered",
      callback_id: "callback-result",
      subagent_id: "subagent-1",
      name: "Worker",
      latest_error: "Task failed"
    }, "subagent"), state(lost));
    assert.equal(lost.interaction?.kind, "task_result");
    assert.equal(field(lost, "executionStatus"), "failed");
    assert.equal(field(lost, "deliveryStatus"), "pending");
    assert.equal(delivered.interaction?.id, lost.interaction?.id);
    assert.equal(field(delivered, "executionStatus"), "failed");
    assert.equal(field(delivered, "deliveryStatus"), "delivered");

    const subagent = projectBotified(canonicalEvent(4, "subagent.callback", {
      callback_kind: "failed",
      callback_status: "failed",
      callback_id: "callback-subagent",
      subagent_id: "subagent-2",
      name: "Reviewer",
      latest_error: "Review failed"
    }, "subagent"));
    assert.equal(subagent.interaction?.kind, "subagent_result");
    assert.equal(field(subagent, "executionStatus"), "failed");
    assert.equal(field(subagent, "deliveryStatus"), "failed");
  });

  it("skips unknown canonical events without manufacturing a public interaction", () => {
    let arbitrary: Record<string, unknown> = { raw: true };
    for (let index = 0; index < 80; index += 1) arbitrary = { nested: arbitrary };
    const event = { ...canonicalEvent(41, "plugin.experimental", arbitrary, "plugin"), time: "unix:1784011517" };
    const parsed = parseBotifiedTimelineEvent({ ...event, data: arbitrary });
    assert.equal(parsed?.cursor, "evt_proc41_41");
    assert.equal(parsed?.time, "2026-07-14T06:45:17.000Z");
    assert.deepEqual(parsed?.data, {});
    assert.deepEqual(projectBotified(parsed!).interaction, null);
    assert.equal(parseBotifiedTimelineEvents([{ ...event, data: arbitrary }])[0]?.cursor, "evt_proc41_41");
    assert.deepEqual(parseBotifiedTimelineEvent({ ...event, data: ["arbitrary"] })?.data, {});
  });

  it("reconciles the migrated initial message with its Phase 2 interaction identity", () => {
    const created = projectProduct({
      sourceKind: "product",
      taskId: "task-1",
      sourceId: "task:task-1:prompt",
      sourceRevision: 1,
      occurredAt: "2026-07-13T10:00:00.000Z",
      position: 1,
      type: "task_created",
      messageId: "task-1",
      content: "Start work",
      status: "pending"
    });
    const delivered = projectProduct({
      sourceKind: "product",
      taskId: "task-1",
      sourceId: "message:task-1",
      sourceRevision: 2,
      occurredAt: "2026-07-13T10:00:02.000Z",
      position: 2,
      type: "message_delivery",
      messageId: "task-1",
      status: "accepted"
    }, state(created));
    const stale = projectProduct({
      sourceKind: "product",
      taskId: "task-1",
      sourceId: "message:task-1",
      sourceRevision: 3,
      occurredAt: "2026-07-13T10:00:03.000Z",
      position: 3,
      type: "message_delivery",
      messageId: "task-1",
      status: "dispatching"
    }, state(delivered));

    assert.equal(created.interaction?.kind, "user_message");
    assert.equal(delivered.interaction?.id, created.interaction?.id);
    assert.equal(delivered.interaction?.revision, 2);
    assert.equal(delivered.interaction?.position,created.interaction?.position);
    assert.equal(delivered.interaction?.body, "Start work");
    assert.equal(field(stale, "status"), "accepted");

    const failed = projectProduct({
      sourceKind: "product",
      taskId: "task-1",
      sourceId: "retry-message",
      sourceRevision: 2,
      occurredAt: "2026-07-13T10:00:04.000Z",
      position: 4,
      type: "message_delivery",
      messageId: "retry-message",
      content: "Retry me",
      status: "failed"
    });
    const lateDispatching = projectProduct({
      sourceKind: "product",
      taskId: "task-1",
      sourceId: "retry-message",
      sourceRevision: 3,
      occurredAt: "2026-07-13T10:00:05.000Z",
      position: 5,
      type: "message_delivery",
      messageId: "retry-message",
      status: "dispatching"
    }, state(failed));
    assert.equal(field(lateDispatching, "status"), "failed");

    const canonicalAcceptance = projectBotified(canonicalEvent(4, "input.accepted", {
      input_id: "botified-input-1",
      message_id: "botified-message-1",
      source: "user",
      text: "Start work"
    }), state(delivered));
    assert.equal(canonicalAcceptance.interaction?.id, created.interaction?.id);
    assert.equal(canonicalAcceptance.interaction?.revision, 3);
  });

  it("returns an internal artifact upsert without exposing storage fields in the interaction", () => {
    const result = projectBotified(canonicalEvent(1, "file.published", {
      file_id: "file-1",
      filename: "result.txt",
      mime_type: "text/plain",
      size_bytes: 12,
      sha256: "a".repeat(64),
      download_url: "http://botified.internal/v1/files/file-1?service_key=secret"
    }, "file"));

    assert.equal(result.interaction?.kind, "file");
    assert.equal(result.artifact?.fileId, "file-1");
    assert.equal(result.artifact?.sha256, "a".repeat(64));
    assert.equal("fileId" in (result.interaction ?? {}), false);
    assert.doesNotMatch(JSON.stringify(result.interaction), /download_url|botified\.internal|service_key/);
  });

  it("honors background lost state and canonical output truncation metadata", () => {
    const lost = projectBotified(canonicalEvent(1, "background_task.failed", {
      task_id: "work-lost",
      state: "lost",
      output_tail: "partial output",
      output_tail_truncated: true,
      output_dropped_bytes: 64
    }, "background_task"));
    assert.equal(field(lost, "executionStatus"), "lost");
    assert.equal(field(lost, "detailsOmitted"), true);
    assert.equal(lost.interaction?.contentMode, "preview");

    const tool = projectBotified(canonicalEvent(2, "command_execution.completed", {
      tool_call_id: "call-truncated",
      output_tail: "tail only",
      output_complete: false,
      exit_code: 0
    }, "command_execution"));
    assert.equal(field(tool, "detailsOmitted"), true);
    assert.equal(tool.interaction?.contentMode, "preview");
  });

  it("keeps cancelled command execution distinct from failure", () => {
    const cancelled = projectBotified(canonicalEvent(
      1,
      "command_execution.cancelled",
      {
        tool_call_id: "call-cancelled",
        command: "sleep 120",
        output_tail: "tool execution aborted",
        exit_code: null,
        status: "cancelled"
      },
      "command_execution"
    ));

    assert.equal(field(cancelled, "executionStatus"), "cancelled");
    assert.equal(field(cancelled, "command"), "sleep 120");
  });
});

describe("interaction text redaction", () => {
  it("redacts task-known values, headers, cookies, URL credentials and query secrets, assignments, JSON credentials, and token shapes", () => {
    const text = [
      "known=task-known-secret",
      "curl 'https://alice:pass@example.test/path?api_key=query-secret&ok=yes'",
      "DATABASE_URL=postgresql://dbuser:dbpass@db.example.test/app?sslkey=query-key",
      "Authorization: Bearer bearer-secret",
      "Cookie: session=cookie-secret",
      "curl -H 'X-API-Key: opaque-header' -H \"Cookie: embedded-cookie\" https://example.test",
      "command prefix Cookie: inline-cookie with trailing output",
      "OPENAI_API_KEY=env-secret",
      "{\"client_secret\":\"json-secret\",\"signature\":\"signature-secret\"}",
      "service bsk_service_secret broker lbk_broker_secret",
      "token sk-1234567890abcdef",
      "jwt eyJabcdefghijk.abcdefghijk.abcdefghijk"
    ].join("\n");
    const result = redactInteractionText(text, { knownSecrets: ["task-known-secret"] });

    assert.equal(result.detailsOmitted, false);
    assert.notEqual(result.text, null);
    assert.doesNotMatch(result.text!, /task-known-secret|alice|pass|query-secret|dbuser|dbpass|query-key|bearer-secret|cookie-secret|opaque-header|embedded-cookie|inline-cookie|env-secret|json-secret|signature-secret|bsk_service_secret|lbk_broker_secret|1234567890abcdef|eyJabcdefghijk/);
    assert.match(result.text!, /redacted/);
  });

  it("redacts exact service and broker key shapes from generic text while preserving surrounding text", () => {
    assert.equal(
      redactSecretLikeText("before bsk_Aa0_- middle lbk_Zz9_- after"),
      "before [redacted] middle [redacted] after"
    );
  });

  it("omits unsafe and over-bound bodies instead of leaking partial text", () => {
    assert.deepEqual(redactInteractionText("safe\u0000secret"), { text: null, detailsOmitted: true });
    assert.deepEqual(redactInteractionText("x".repeat(33), { maxBytes: 32 }), { text: null, detailsOmitted: true });
    assert.deepEqual(redactInteractionText("https://example.test/path?view=full"), {
      text: "https://example.test/path?view=full",
      detailsOmitted: false
    });
  });

  it("preserves long user and assistant product bodies while keeping details bounded and secrets redacted", () => {
    const knownSecret = "task-known-secret";
    const longBody = `${"Complete product body. ".repeat(600)}\nTOKEN=${knownSecret}\nEnd of body.`;
    const expectedBody = longBody.replace(knownSecret, "[redacted]");
    assert.ok(Buffer.byteLength(longBody, "utf8") > 8 * 1024);

    const user = projectProduct({
      sourceKind: "product",
      taskId: "task-1",
      sourceId: "long-user-message",
      sourceRevision: 1,
      occurredAt: "2026-07-13T10:00:00.000Z",
      position: 1,
      type: "message_admitted",
      messageId: "long-user-message",
      content: longBody,
      status: "accepted"
    }, null, { knownSecrets: [knownSecret] });
    const assistant = projectBotified(canonicalEvent(2, "assistant_message.completed", {
      assistant_message_id: "long-assistant-message",
      text: longBody
    }, "assistant_message"), null, { knownSecrets: [knownSecret] });
    const tool = projectBotified(canonicalEvent(3, "command_execution.completed", {
      tool_call_id: "long-tool-output",
      output_tail: longBody,
      exit_code: 0
    }, "command_execution"), null, { knownSecrets: [knownSecret] });
    const background = projectBotified(canonicalEvent(4, "background_task.completed", {
      task_id: "long-background-output",
      result_text: longBody
    }, "background_task"), null, { knownSecrets: [knownSecret] });

    assert.equal(user.interaction?.body, expectedBody);
    assert.equal(assistant.interaction?.body, expectedBody);
    assert.doesNotMatch(user.interaction?.body ?? "", /task-known-secret/);
    assert.doesNotMatch(assistant.interaction?.body ?? "", /task-known-secret/);
    assert.equal(tool.interaction?.body, null);
    assert.equal(field(tool, "outputTail"), null);
    assert.equal(field(tool, "detailsOmitted"), true);
    assert.equal(background.interaction?.body, null);
    assert.equal(field(background, "result"), null);
    assert.equal(field(background, "detailsOmitted"), true);
  });

  it("redacts known secrets from tool output and errors before projection", () => {
    const started = projectBotified(canonicalEvent(
      1,
      "command_execution.started",
      { tool_call_id: "call-1", arguments_summary: "deploy with TASK_TOKEN=task-secret" },
      "command_execution"
    ), null, { knownSecrets: ["task-secret"] });
    const failed = projectBotified(canonicalEvent(
      2,
      "command_execution.failed",
      { tool_call_id: "call-1", failure_reason: "Authorization: Bearer task-secret" },
      "command_execution"
    ), state(started), { knownSecrets: ["task-secret"] });
    const completed = projectBotified(canonicalEvent(
      3,
      "command_execution.completed",
      { tool_call_id: "call-2", output_tail: "result=task-secret", exit_code: 0 },
      "command_execution"
    ), null, { knownSecrets: ["task-secret"] });

    assert.doesNotMatch(JSON.stringify(started.interaction), /task-secret/);
    assert.doesNotMatch(JSON.stringify(failed.interaction), /task-secret/);
    assert.doesNotMatch(JSON.stringify(completed.interaction), /task-secret/);
  });

});

function canonicalEvent(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  itemType: string | null = null
): BotifiedTimelineEvent {
  return {
    version: BOTIFIED_TIMELINE_VERSION,
    seq,
    cursor: `evt_proc${seq}_${seq}`,
    time: `2026-07-13T10:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    session_id: "session-1",
    type,
    trace: { cycle_id: "cycle-1" },
    item: itemType === null ? null : { id: `${itemType}-${seq}`, type: itemType, status: "running" },
    data
  };
}

function projectBotified(
  event: BotifiedTimelineEvent,
  previous: TaskInteractionProjectionState | null = null,
  redaction: { knownSecrets?: Iterable<string>; maxBytes?: number } = {}
): TaskInteractionProjectionResult {
  const source: BotifiedTaskInteractionSource = { sourceKind: "botified", taskId: "task-1", event };
  return projectTaskInteraction(source, previous, redaction);
}

function projectProduct(
  source: ProductTaskInteractionSource,
  previous: TaskInteractionProjectionState | null = null,
  redaction: { knownSecrets?: Iterable<string>; maxBytes?: number } = {}
): TaskInteractionProjectionResult {
  return projectTaskInteraction(source, previous, redaction);
}

function state(result: TaskInteractionProjectionResult): TaskInteractionProjectionState {
  assert.notEqual(result.interaction, null);
  return {
    interaction: result.interaction!,
    ...(result.correlation ? { correlation: result.correlation } : {})
  };
}

function field(result: TaskInteractionProjectionResult, name: string): unknown {
  assert.notEqual(result.interaction, null);
  return (result.interaction as unknown as Record<string, unknown>)[name];
}
