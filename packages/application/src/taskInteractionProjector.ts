import { createHash } from "node:crypto";
import type {
  AgentTaskArtifact,
  TaskAssistantMessageInteraction,
  TaskBackgroundTaskInteraction,
  TaskFileInteraction,
  TaskInteractionContentMode,
  TaskInteractionDeliveryStatus,
  TaskInteractionItem,
  TaskNoticeInteraction,
  TaskQuestionInteraction,
  TaskResultInteraction,
  TaskSubagentResultInteraction,
  TaskSystemErrorInteraction,
  TaskToolInteraction,
  TaskUserMessageInteraction
} from "../../contracts/src/api.js";
import type { TaskInteractionCorrelation } from "../../ports/src/store.js";
import type { BotifiedTimelineEvent } from "../../botified-runtime/src/projection.js";
import {
  redactInteractionText,
  redactProductInteractionText,
  type InteractionTextRedactionOptions,
  type RedactedInteractionText
} from "../../botified-runtime/src/redaction.js";

export interface BotifiedTaskInteractionSource {
  sourceKind: "botified";
  taskId: string;
  event: BotifiedTimelineEvent;
}

interface ProductSourceBase {
  sourceKind: "product";
  taskId: string;
  sourceId: string;
  sourceRevision: number;
  occurredAt: string;
  position: number;
}

export interface TaskCreatedInteractionSource extends ProductSourceBase {
  type: "task_created";
  actorId?: string | null;
  messageId: string;
  content: string;
  status: "pending" | "dispatching" | "accepted" | "failed";
}

export interface MessageAdmittedInteractionSource extends ProductSourceBase {
  type: "message_admitted";
  actorId?: string | null;
  messageId: string;
  content: string;
  status: "accepted" | "queued" | "rejected";
}

export interface MessageDeliveryInteractionSource extends ProductSourceBase {
  type: "message_delivery";
  actorId?: string | null;
  messageId: string;
  content?: string;
  status: "pending" | "dispatching" | "accepted" | "queued" | "rejected" | "failed";
}

export interface TurnAbortedInteractionSource extends ProductSourceBase {
  type: "turn_aborted";
  turnId: string;
}

export type ProductTaskInteractionSource =
  | TaskCreatedInteractionSource
  | MessageAdmittedInteractionSource
  | MessageDeliveryInteractionSource
  | TurnAbortedInteractionSource;

export type TaskInteractionProjectionSource = BotifiedTaskInteractionSource | ProductTaskInteractionSource;

export interface TaskInteractionProjectionState {
  interaction: TaskInteractionItem;
  correlation?: TaskInteractionCorrelation;
  sourceKind?: "botified" | "product";
  sourceId?: string;
  sourceRevision?: number;
}

export interface TaskInteractionArtifactUpsert extends AgentTaskArtifact {
  fileId: string;
  mediaType: string | null;
}

export interface TaskInteractionProjectionResult {
  interaction: TaskInteractionItem | null;
  correlation?: TaskInteractionCorrelation;
  artifact?: TaskInteractionArtifactUpsert;
}

export function projectTaskInteraction(
  source: TaskInteractionProjectionSource,
  previous: TaskInteractionProjectionState | null = null,
  redaction: InteractionTextRedactionOptions = {}
): TaskInteractionProjectionResult {
  if (
    source.sourceKind === "product"
    && previous?.sourceKind === "product"
    && previous.sourceId === source.sourceId
    && previous.sourceRevision !== undefined
    && source.sourceRevision <= previous.sourceRevision
  ) {
    return noInteraction();
  }
  const stableRedaction = redaction.knownSecrets === undefined
    ? redaction
    : { ...redaction, knownSecrets: [...redaction.knownSecrets] };
  return source.sourceKind === "botified"
    ? projectBotified(source, previous, stableRedaction)
    : projectProduct(source, previous, stableRedaction);
}

function projectBotified(
  source: BotifiedTaskInteractionSource,
  previous: TaskInteractionProjectionState | null,
  redaction: InteractionTextRedactionOptions
): TaskInteractionProjectionResult {
  const event = source.event;
  switch (event.type) {
    case "input.accepted":
    case "input.queued":
    case "input.rejected":
      return projectInput(source, previous, redaction);
    case "assistant_message.completed":
      return projectAssistant(source, previous, redaction);
    case "command_execution.started":
    case "command_execution.completed":
    case "command_execution.failed":
    case "command_execution.cancelled":
      return projectTool(source, previous, redaction);
    case "background_task.started":
    case "background_task.completed":
    case "background_task.failed":
    case "background_task.lost":
    case "background_task.cancelled":
    case "background_task.timed_out":
      return projectBackgroundTask(source, previous, redaction);
    case "background_task.callback_pending":
    case "background_task.callback_queued":
    case "background_task.callback_delivered":
    case "background_task.callback_failed":
      return projectTaskResult(source, previous, redaction);
    case "task_ask.requested":
    case "task_ask.expired":
    case "task_ask.rejected":
    case "task_reply.accepted":
    case "task_reply.written":
    case "task_reply.failed":
      return projectTaskQuestion(source, previous, redaction);
    case "task_tell.accepted":
    case "task_tell.queued":
    case "task_tell.rejected":
    case "task_tell.sent":
      return projectTaskNotice(source, previous, redaction);
    case "subagent.completed":
    case "subagent.failed":
    case "subagent.cancelled":
      return projectSubagentResult(source, previous, redaction);
    case "subagent.callback":
    case "subagent.callback_delivered":
      return projectCanonicalCallback(source, previous, redaction);
    case "file.published":
      return projectFile(source, previous, redaction);
    case "cycle.failed":
      return projectSystemError(source, previous, redaction);
    case "service.error":
      return stringField(event.data, "code") === "service_unavailable"
        ? projectSystemError(source, previous, redaction)
        : noInteraction();
    default:
      return noInteraction();
  }
}

function projectProduct(
  source: ProductTaskInteractionSource,
  previous: TaskInteractionProjectionState | null,
  redaction: InteractionTextRedactionOptions
): TaskInteractionProjectionResult {
  if (source.type === "turn_aborted") {
    const old = previous?.interaction.kind === "assistant_message" ? previous.interaction : null;
    const interaction: TaskAssistantMessageInteraction = {
      ...base(source.taskId, old?.id ?? interactionId(source.taskId, `TurnAbort:${source.turnId}`), source, old),
      kind: "assistant_message",
      title: "Assistant",
      body: "Current turn stopped.",
      contentMode: "full",
      status: terminalAssistantStatus(old?.status, "aborted")
    };
    return { interaction };
  }

  const old = previous?.interaction.kind === "user_message" ? previous.interaction : null;
  const content = "content" in source ? source.content : undefined;
  const body = content === undefined ? bodyFromPrevious(old) : optionalProductRedacted(content, redaction);
  const incomingStatus = source.status;
  const interaction: TaskUserMessageInteraction = {
    ...base(source.taskId, old?.id ?? interactionId(source.taskId, `User:${source.messageId}`), source, old),
    kind: "user_message",
    title: "You",
    actorId: source.actorId ?? old?.actorId ?? null,
    body: body.text,
    contentMode: body.text === null ? "none" : "full",
    status: monotonicUserStatus(old?.status, incomingStatus)
  };
  return { interaction };
}

function projectInput(
  source: BotifiedTaskInteractionSource,
  previous: TaskInteractionProjectionState | null,
  redaction: InteractionTextRedactionOptions
): TaskInteractionProjectionResult {
  const data = source.event.data;
  if (stringField(data, "source") !== "user") {
    return noInteraction();
  }
  const inputId = stringField(data, "input_id");
  if (!inputId) {
    return noInteraction();
  }
  const old = previous?.interaction.kind === "user_message" ? previous.interaction : null;
  const body = productTextBody(data, ["text", "message"], ["content_preview"], redaction);
  const status = source.event.type === "input.queued"
    ? "queued"
    : source.event.type === "input.rejected" ? "rejected" : "accepted";
  const interaction: TaskUserMessageInteraction = {
    ...eventBase(source, old?.id ?? interactionId(source.taskId, `User:${inputId}`), old),
    kind: "user_message",
    title: "You",
    actorId: old?.actorId ?? null,
    body: body.text ?? old?.body ?? null,
    contentMode: body.text === null ? old?.contentMode ?? "none" : body.mode,
    status: monotonicUserStatus(old?.status, status)
  };
  return { interaction };
}

function projectAssistant(
  source: BotifiedTaskInteractionSource,
  previous: TaskInteractionProjectionState | null,
  redaction: InteractionTextRedactionOptions
): TaskInteractionProjectionResult {
  const data = source.event.data;
  const messageId = stringField(data, "assistant_message_id") ?? itemId(source.event, "assistant_message");
  if (!messageId) {
    return noInteraction();
  }
  const old = previous?.interaction.kind === "assistant_message" ? previous.interaction : null;
  const body = productTextBody(data, ["text", "content", "message"], ["content_preview"], redaction);
  if (!body.text?.trim()) {
    return noInteraction();
  }
  const interaction: TaskAssistantMessageInteraction = {
    ...eventBase(source, old?.id ?? interactionId(source.taskId, `Assistant:${messageId}`), old),
    kind: "assistant_message",
    title: "Assistant",
    body: body.text ?? old?.body ?? null,
    contentMode: body.text === null ? old?.contentMode ?? "none" : body.mode,
    status: terminalAssistantStatus(old?.status, "completed")
  };
  return { interaction };
}

function projectTool(
  source: BotifiedTaskInteractionSource,
  previous: TaskInteractionProjectionState | null,
  redaction: InteractionTextRedactionOptions
): TaskInteractionProjectionResult {
  const data = source.event.data;
  const toolCallId = stringField(data, "tool_call_id") ?? itemId(source.event, "command_execution");
  if (!toolCallId) {
    return noInteraction();
  }
  if (
    (previous?.interaction.kind === "background_task" || previous?.interaction.kind === "task_result")
    && previous.correlation?.toolCallId === toolCallId
  ) {
    return noInteraction();
  }
  const old = previous?.interaction.kind === "tool" ? previous.interaction : null;
  const incomingStatus: TaskToolInteraction["executionStatus"] = source.event.type === "command_execution.started"
    ? "running"
    : source.event.type === "command_execution.completed"
      ? "completed"
      : source.event.type === "command_execution.cancelled" ? "cancelled" : "failed";
  const executionStatus = monotonicExecution(old?.executionStatus, incomingStatus, TOOL_TERMINAL);
  const summary = optionalRedacted(stringField(data, "command") ?? stringField(data, "arguments_summary"), redaction);
  const output = source.event.type === "command_execution.failed"
    ? textBody(data, ["failure_reason", "error", "output_tail"], [], redaction)
    : textBody(data, ["output_tail", "output", "summary"], [], redaction);
  const outputDetailsOmitted = canonicalOutputDetailsOmitted(data);
  const terminalWasPreserved = old !== null && TOOL_TERMINAL.has(old.executionStatus) && old.executionStatus !== incomingStatus;
  const outputTail = terminalWasPreserved ? old.outputTail : output.text ?? old?.outputTail ?? null;
  const body = terminalWasPreserved
    ? bodyFromPrevious(old)
    : output.text !== null ? output : summary.text !== null ? summary : bodyFromPrevious(old);
  const interaction: TaskToolInteraction = {
    ...eventBase(source, old?.id ?? interactionId(source.taskId, `Tool:${toolCallId}`), old),
    kind: "tool",
    title: "Tool",
    body: body.text,
    contentMode: contentMode(body, output.text !== null && canonicalOutputIsPartial(data)),
    executionStatus,
    deliveryStatus: old?.deliveryStatus ?? null,
    toolName: safeLabel(data, ["tool_name"], redaction) ?? old?.toolName ?? "bash",
    command: summary.text ?? old?.command ?? null,
    outputTail,
    exitCode: integerField(data, "exit_code") ?? old?.exitCode ?? null,
    detailsOmitted: old?.detailsOmitted === true || summary.detailsOmitted || output.detailsOmitted || outputDetailsOmitted
  };
  return { interaction, correlation: mergeCorrelation(previous?.correlation, { toolCallId }) };
}

function projectBackgroundTask(
  source: BotifiedTaskInteractionSource,
  previous: TaskInteractionProjectionState | null,
  redaction: InteractionTextRedactionOptions
): TaskInteractionProjectionResult {
  const data = source.event.data;
  const workTaskId = stringField(data, "task_id");
  if (!workTaskId) {
    return noInteraction();
  }
  if (previous?.interaction.kind === "task_result") {
    return projectTaskResult(source, previous, redaction);
  }
  const toolCallId = stringField(data, "tool_call_id") ?? previous?.correlation?.toolCallId ?? undefined;
  const old = previous?.interaction;
  const oldWork = old?.kind === "background_task" ? old : null;
  const incomingStatus = backgroundExecutionStatus(source.event);
  const executionStatus = monotonicExecution(oldWork?.executionStatus, incomingStatus, BACKGROUND_TERMINAL);
  const incomingDelivery = explicitCallbackDelivery(source.event);
  const workSummary = optionalRedacted(stringField(data, "work_summary") ?? stringField(data, "arguments_summary"), redaction);
  const result = textBody(data, ["result_text", "latest_result", "output_tail"], [], redaction);
  const error = textBody(data, ["latest_error", "failure_reason", "error"], [], redaction);
  const outputDetailsOmitted = canonicalOutputDetailsOmitted(data);
  const terminalWasPreserved = oldWork !== null && BACKGROUND_TERMINAL.has(oldWork.executionStatus) && oldWork.executionStatus !== incomingStatus;
  const selectedBody = terminalWasPreserved
    ? bodyFromPrevious(oldWork)
    : error.text !== null ? error : result.text !== null ? result : workSummary.text !== null ? workSummary : bodyFromPrevious(oldWork);
  const anchor = toolCallId ? `Tool:${toolCallId}` : `Task:${workTaskId}`;
  const interaction: TaskBackgroundTaskInteraction = {
    ...eventBase(source, old?.id ?? interactionId(source.taskId, anchor), old),
    kind: "background_task",
    title: "Background task",
    body: selectedBody.text,
    contentMode: contentMode(selectedBody, canonicalOutputIsPartial(data) && (error.text !== null || result.text !== null)),
    executionStatus,
    deliveryStatus: incomingDelivery === null
      ? oldWork?.deliveryStatus ?? deliveryFromInteraction(old)
      : monotonicDelivery(oldWork?.deliveryStatus ?? deliveryFromInteraction(old), incomingDelivery),
    label: safeLabel(data, ["task_label", "label", "sender"], redaction) ?? oldWork?.label ?? "Background task",
    workSummary: workSummary.text ?? oldWork?.workSummary ?? null,
    result: terminalWasPreserved ? oldWork.result : result.text ?? oldWork?.result ?? null,
    error: terminalWasPreserved ? oldWork.error : error.text ?? oldWork?.error ?? null,
    detailsOmitted: detailsOmitted(old) || workSummary.detailsOmitted || result.detailsOmitted || error.detailsOmitted || outputDetailsOmitted
  };
  return {
    interaction,
    correlation: mergeCorrelation(previous?.correlation, { toolCallId, workTaskId })
  };
}

function projectTaskResult(
  source: BotifiedTaskInteractionSource,
  previous: TaskInteractionProjectionState | null,
  redaction: InteractionTextRedactionOptions
): TaskInteractionProjectionResult {
  const data = source.event.data;
  const workTaskId = stringField(data, "task_id") ?? previous?.correlation?.workTaskId ?? undefined;
  const callbackId = stringField(data, "callback_id") ?? previous?.correlation?.callbackId ?? undefined;
  if (!workTaskId && !callbackId) {
    return noInteraction();
  }
  const old = previous?.interaction;
  const oldResult = old?.kind === "task_result" ? old : null;
  const previousExecution = oldResult?.executionStatus
    ?? (old?.kind === "background_task" ? taskResultStatus(old.executionStatus) : undefined);
  const incomingExecution = taskResultExecution(data) ?? previousExecution ?? "completed";
  const executionStatus = monotonicExecution(previousExecution, incomingExecution, TASK_RESULT_TERMINAL);
  const deliveryStatus = monotonicDelivery(deliveryFromInteraction(old), callbackDelivery(source.event));
  const result = textBody(data, ["task_message", "result_text", "latest_result", "output", "output_tail"], [], redaction);
  const error = textBody(data, ["latest_error", "failure_reason", "callback_failure_reason", "error"], [], redaction);
  const outputDetailsOmitted = canonicalOutputDetailsOmitted(data);
  const body = error.text !== null ? error : result.text !== null ? result : bodyFromPrevious(old);
  const identity = workTaskId ? `Task:${workTaskId}` : `TaskCallback:${callbackId!}`;
  const interaction: TaskResultInteraction = {
    ...eventBase(source, old?.id ?? interactionId(source.taskId, identity), old),
    kind: "task_result",
    title: deliveryStatus === "failed" ? "Task result delivery failed" : "Task result",
    body: body.text,
    contentMode: contentMode(body, canonicalOutputIsPartial(data) && (error.text !== null || result.text !== null)),
    executionStatus,
    deliveryStatus,
    result: result.text ?? resultFromInteraction(old),
    error: error.text ?? errorFromInteraction(old),
    detailsOmitted: detailsOmitted(old) || result.detailsOmitted || error.detailsOmitted || outputDetailsOmitted
  };
  return {
    interaction,
    correlation: mergeCorrelation(previous?.correlation, {
      toolCallId: stringField(data, "tool_call_id"),
      workTaskId,
      callbackId
    })
  };
}

function projectTaskQuestion(
  source: BotifiedTaskInteractionSource,
  previous: TaskInteractionProjectionState | null,
  redaction: InteractionTextRedactionOptions
): TaskInteractionProjectionResult {
  const data = source.event.data;
  const workTaskId = stringField(data, "task_id");
  const askId = stringField(data, "ask_id");
  if (!workTaskId || !askId) {
    return noInteraction();
  }
  const old = previous?.interaction.kind === "task_question" ? previous.interaction : null;
  const incomingStatus = questionStatus(source.event);
  const question = textBody(data, ["question", "task_message", "message", "text"], ["content_preview"], redaction);
  const answer = textBody(data, ["answer", "reply", "response"], [], redaction);
  const interaction: TaskQuestionInteraction = {
    ...eventBase(source, old?.id ?? interactionId(source.taskId, `TaskQuestion:${workTaskId}:${askId}`), old),
    kind: "task_question",
    title: "Task question",
    body: question.text ?? old?.body ?? null,
    contentMode: question.text === null ? old?.contentMode ?? "none" : question.mode,
    status: monotonicQuestionStatus(old?.status, incomingStatus),
    question: question.text ?? old?.question ?? "Question unavailable",
    expect: safeLabel(data, ["expect"], redaction) ?? old?.expect ?? null,
    answer: answer.text ?? old?.answer ?? null
  };
  return { interaction };
}

function projectTaskNotice(
  source: BotifiedTaskInteractionSource,
  previous: TaskInteractionProjectionState | null,
  redaction: InteractionTextRedactionOptions
): TaskInteractionProjectionResult {
  const data = source.event.data;
  const workTaskId = stringField(data, "task_id");
  const tellId = stringField(data, "tell_id");
  if (!workTaskId || !tellId) {
    return noInteraction();
  }
  const old = previous?.interaction.kind === "task_notice" ? previous.interaction : null;
  const notice = textBody(data, ["notice", "task_message", "message", "text"], ["content_preview"], redaction);
  const status = source.event.type === "task_tell.rejected" ? "rejected" : "accepted";
  const interaction: TaskNoticeInteraction = {
    ...eventBase(source, old?.id ?? interactionId(source.taskId, `TaskNotice:${workTaskId}:${tellId}`), old),
    kind: "task_notice",
    title: "Task notice",
    body: notice.text ?? old?.body ?? null,
    contentMode: notice.text === null ? old?.contentMode ?? "none" : notice.mode,
    status: old?.status === "rejected" ? "rejected" : status,
    sender: safeLabel(data, ["sender", "task_label", "label", "name"], redaction) ?? old?.sender ?? null
  };
  return { interaction };
}

function projectSubagentResult(
  source: BotifiedTaskInteractionSource,
  previous: TaskInteractionProjectionState | null,
  redaction: InteractionTextRedactionOptions
): TaskInteractionProjectionResult {
  const data = source.event.data;
  const subagentId = stringField(data, "subagent_id");
  if (!subagentId) {
    return noInteraction();
  }
  const old = previous?.interaction.kind === "subagent_result" ? previous.interaction : null;
  const incomingStatus = source.event.type === "subagent.completed"
    ? "completed" : source.event.type === "subagent.cancelled" ? "cancelled" : "failed";
  const executionStatus = monotonicExecution(old?.executionStatus, incomingStatus, SUBAGENT_TERMINAL);
  const result = textBody(data, ["latest_result", "result_text", "task_message", "output"], [], redaction);
  const error = textBody(data, ["latest_error", "failure_reason", "error"], [], redaction);
  const outputDetailsOmitted = canonicalOutputDetailsOmitted(data);
  const body = error.text !== null ? error : result.text !== null ? result : bodyFromPrevious(old);
  const interaction: TaskSubagentResultInteraction = {
    ...eventBase(source, old?.id ?? interactionId(source.taskId, `Subagent:${subagentId}`), old),
    kind: "subagent_result",
    title: "Subagent result",
    body: body.text,
    contentMode: contentMode(body, canonicalOutputIsPartial(data) && (error.text !== null || result.text !== null)),
    executionStatus,
    deliveryStatus: monotonicDelivery(old?.deliveryStatus, callbackDelivery(source.event)),
    name: safeLabel(data, ["name"], redaction) ?? old?.name ?? "Subagent",
    purpose: optionalRedacted(stringField(data, "purpose"), redaction).text ?? old?.purpose ?? null,
    result: result.text ?? old?.result ?? null,
    error: error.text ?? old?.error ?? null,
    detailsOmitted: old?.detailsOmitted === true || result.detailsOmitted || error.detailsOmitted || outputDetailsOmitted
  };
  return {
    interaction,
    correlation: mergeCorrelation(previous?.correlation, {
      callbackId: stringField(data, "callback_id")
    })
  };
}

function projectCanonicalCallback(
  source: BotifiedTaskInteractionSource,
  previous: TaskInteractionProjectionState | null,
  redaction: InteractionTextRedactionOptions
): TaskInteractionProjectionResult {
  switch (stringField(source.event.data, "callback_kind")) {
    case "task_ask":
      return projectCallbackQuestion(source, previous, redaction);
    case "task_tell":
      return projectCallbackNotice(source, previous, redaction);
    case "task_completed":
    case "task_failed":
    case "task_timed_out":
    case "task_cancelled":
    case "task_lost":
      return projectTaskResult(source, previous, redaction);
    case "completed":
    case "failed":
      return projectCallbackSubagentResult(source, previous, redaction);
    default:
      return noInteraction();
  }
}

function projectCallbackQuestion(
  source: BotifiedTaskInteractionSource,
  previous: TaskInteractionProjectionState | null,
  redaction: InteractionTextRedactionOptions
): TaskInteractionProjectionResult {
  const data = source.event.data;
  const workTaskId = stringField(data, "task_id");
  const askId = stringField(data, "ask_id");
  const callbackId = stringField(data, "callback_id");
  if ((!workTaskId || !askId) && !callbackId) return noInteraction();
  const old = previous?.interaction.kind === "task_question" ? previous.interaction : null;
  const question = textBody(data, ["question", "task_message"], ["question_preview", "task_message_preview"], redaction);
  const identity = workTaskId && askId
    ? `TaskQuestion:${workTaskId}:${askId}`
    : `CallbackQuestion:${callbackId!}`;
  const interaction: TaskQuestionInteraction = {
    ...eventBase(source, old?.id ?? interactionId(source.taskId, identity), old),
    kind: "task_question",
    title: "Task question",
    body: question.text ?? old?.body ?? null,
    contentMode: question.text === null ? old?.contentMode ?? "none" : question.mode,
    status: monotonicQuestionStatus(old?.status, "waiting"),
    question: question.text ?? old?.question ?? "Question unavailable",
    expect: safeLabel(data, ["expect"], redaction) ?? old?.expect ?? null,
    answer: old?.answer ?? null
  };
  return { interaction, correlation: callbackCorrelation(previous, data) };
}

function projectCallbackNotice(
  source: BotifiedTaskInteractionSource,
  previous: TaskInteractionProjectionState | null,
  redaction: InteractionTextRedactionOptions
): TaskInteractionProjectionResult {
  const data = source.event.data;
  const workTaskId = stringField(data, "task_id");
  const tellId = stringField(data, "tell_id");
  const callbackId = stringField(data, "callback_id");
  if ((!workTaskId || !tellId) && !callbackId) return noInteraction();
  const old = previous?.interaction.kind === "task_notice" ? previous.interaction : null;
  const notice = textBody(data, ["notice", "task_message"], ["notice_preview", "task_message_preview"], redaction);
  const identity = workTaskId && tellId
    ? `TaskNotice:${workTaskId}:${tellId}`
    : `CallbackNotice:${callbackId!}`;
  const interaction: TaskNoticeInteraction = {
    ...eventBase(source, old?.id ?? interactionId(source.taskId, identity), old),
    kind: "task_notice",
    title: "Task notice",
    body: notice.text ?? old?.body ?? null,
    contentMode: notice.text === null ? old?.contentMode ?? "none" : notice.mode,
    status: old?.status === "rejected" ? "rejected" : "accepted",
    sender: safeLabel(data, ["sender", "task_label", "label", "name"], redaction) ?? old?.sender ?? null
  };
  return { interaction, correlation: callbackCorrelation(previous, data) };
}

function projectCallbackSubagentResult(
  source: BotifiedTaskInteractionSource,
  previous: TaskInteractionProjectionState | null,
  redaction: InteractionTextRedactionOptions
): TaskInteractionProjectionResult {
  const data = source.event.data;
  const subagentId = stringField(data, "subagent_id");
  if (!subagentId) return noInteraction();
  const old = previous?.interaction.kind === "subagent_result" ? previous.interaction : null;
  const incoming = subagentExecutionStatus(stringField(data, "callback_kind")) ?? old?.executionStatus ?? "completed";
  const result = textBody(data, ["task_message", "latest_result", "output"], [], redaction);
  const error = textBody(data, ["latest_error", "failure_reason", "callback_failure_reason", "error"], [], redaction);
  const outputDetailsOmitted = canonicalOutputDetailsOmitted(data);
  const body = error.text !== null ? error : result.text !== null ? result : bodyFromPrevious(old);
  const interaction: TaskSubagentResultInteraction = {
    ...eventBase(source, old?.id ?? interactionId(source.taskId, `Subagent:${subagentId}`), old),
    kind: "subagent_result",
    title: "Subagent result",
    body: body.text,
    contentMode: contentMode(body, canonicalOutputIsPartial(data) && (error.text !== null || result.text !== null)),
    executionStatus: monotonicExecution(old?.executionStatus, incoming, SUBAGENT_TERMINAL),
    deliveryStatus: monotonicDelivery(old?.deliveryStatus, callbackDelivery(source.event)),
    name: safeLabel(data, ["name"], redaction) ?? old?.name ?? "Subagent",
    purpose: optionalRedacted(stringField(data, "purpose"), redaction).text ?? old?.purpose ?? null,
    result: result.text ?? old?.result ?? null,
    error: error.text ?? old?.error ?? null,
    detailsOmitted: old?.detailsOmitted === true || result.detailsOmitted || error.detailsOmitted || outputDetailsOmitted
  };
  return { interaction, correlation: callbackCorrelation(previous, data) };
}

function projectFile(
  source: BotifiedTaskInteractionSource,
  previous: TaskInteractionProjectionState | null,
  redaction: InteractionTextRedactionOptions
): TaskInteractionProjectionResult {
  const data = source.event.data;
  const fileId = stringField(data, "file_id") ?? itemId(source.event, "file");
  const filename = safeLabel(data, ["filename"], redaction);
  if (!fileId || !filename) {
    return noInteraction();
  }
  const old = previous?.interaction.kind === "file" ? previous.interaction : null;
  const artifactId = old?.artifactId ?? stableId("art", source.taskId, fileId);
  const description = optionalRedacted(stringField(data, "description"), redaction);
  const mediaType = safeMediaType(stringField(data, "mime_type"));
  const bytes = nonNegativeIntegerField(data, "size_bytes") ?? 0;
  const occurredAt = old?.occurredAt ?? source.event.time;
  const interaction: TaskFileInteraction = {
    ...eventBase(source, old?.id ?? interactionId(source.taskId, `File:${fileId}`), old),
    kind: "file",
    title: "File",
    body: description.text,
    contentMode: contentMode(description),
    status: "available",
    artifactId,
    name: filename,
    mediaType,
    bytes
  };
  const artifact: TaskInteractionArtifactUpsert = {
    id: artifactId,
    taskId: source.taskId,
    fileId,
    name: filename,
    bytes,
    mediaType,
    createdAt: occurredAt
  };
  const sha256 = safeSha256(stringField(data, "sha256"));
  if (sha256) artifact.sha256 = sha256;
  return { interaction, artifact };
}

function projectSystemError(
  source: BotifiedTaskInteractionSource,
  previous: TaskInteractionProjectionState | null,
  redaction: InteractionTextRedactionOptions
): TaskInteractionProjectionResult {
  const data = source.event.data;
  const code = safeLabel(data, ["code"], redaction);
  const cycleId = stringField(data, "cycle_id") ?? source.event.trace.cycle_id;
  const errorId = source.event.type === "service.error" ? source.event.cursor : cycleId ?? source.event.cursor;
  const old = previous?.interaction.kind === "system_error" ? previous.interaction : null;
  const message = textBody(data, ["message", "failure_reason", "error"], [], redaction);
  const interaction: TaskSystemErrorInteraction = {
    ...eventBase(source, old?.id ?? interactionId(source.taskId, `SystemError:${errorId}`), old),
    kind: "system_error",
    title: source.event.type === "cycle.failed" ? "Execution failed" : "Service unavailable",
    body: message.text ?? old?.body ?? null,
    contentMode: message.text === null ? old?.contentMode ?? "none" : message.mode,
    status: "active",
    code: code ?? old?.code ?? null,
    retryable: booleanField(data, "retryable") ?? source.event.type === "service.error",
    detailsOmitted: old?.detailsOmitted === true || message.detailsOmitted
  };
  return { interaction };
}

function base(
  taskId: string,
  id: string,
  source: ProductTaskInteractionSource,
  previous: TaskInteractionItem | null | undefined
) {
  return {
    id,
    revision: nextRevision(previous),
    taskId,
    position: previous?.position ?? source.position,
    occurredAt: previous?.occurredAt ?? source.occurredAt,
    updatedAt: source.occurredAt
  };
}

function eventBase(
  source: BotifiedTaskInteractionSource,
  id: string,
  previous: TaskInteractionItem | null | undefined
) {
  return {
    id,
    revision: nextRevision(previous),
    taskId: source.taskId,
    position: previous?.position ?? source.event.seq,
    occurredAt: previous?.occurredAt ?? source.event.time,
    updatedAt: source.event.time
  };
}

function nextRevision(previous: TaskInteractionItem | null | undefined): number {
  return previous ? previous.revision + 1 : 1;
}

function interactionId(taskId: string, stableKey: string): string {
  return stableId("int", taskId, stableKey);
}

function stableId(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, "utf8")));
    hash.update(":");
    hash.update(part);
  }
  return `${prefix}_${hash.digest("hex").slice(0, 24)}`;
}

function textBody(
  data: Record<string, unknown>,
  fullFields: readonly string[],
  previewFields: readonly string[],
  redaction: InteractionTextRedactionOptions
): RedactedInteractionText & { mode: TaskInteractionContentMode } {
  for (const field of fullFields) {
    const value = textField(data, field);
    if (value !== undefined) {
      return { ...redactInteractionText(value, redaction), mode: "full" };
    }
  }
  for (const field of previewFields) {
    const value = textField(data, field);
    if (value !== undefined) {
      return { ...redactInteractionText(value, redaction), mode: "preview" };
    }
  }
  return { text: null, detailsOmitted: false, mode: "none" };
}

function productTextBody(
  data: Record<string, unknown>,
  fullFields: readonly string[],
  previewFields: readonly string[],
  redaction: InteractionTextRedactionOptions
): RedactedInteractionText & { mode: TaskInteractionContentMode } {
  for (const field of fullFields) {
    const value = textField(data, field);
    if (value !== undefined) {
      return { ...redactProductInteractionText(value, redaction), mode: "full" };
    }
  }
  return textBody(data, [], previewFields, redaction);
}

function textField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    for (const nested of ["text", "content", "message", "output", "output_tail", "result"]) {
      const text = value[nested];
      if (typeof text === "string") return text;
    }
  }
  return undefined;
}

function optionalRedacted(value: string | undefined, options: InteractionTextRedactionOptions): RedactedInteractionText {
  return value === undefined ? { text: null, detailsOmitted: false } : redactInteractionText(value, options);
}

function optionalProductRedacted(value: string | undefined, options: InteractionTextRedactionOptions): RedactedInteractionText {
  return value === undefined ? { text: null, detailsOmitted: false } : redactProductInteractionText(value, options);
}

function bodyFromPrevious(previous: TaskInteractionItem | null | undefined): RedactedInteractionText {
  return { text: previous?.body ?? null, detailsOmitted: detailsOmitted(previous) };
}

function contentMode(value: RedactedInteractionText, partial = false): TaskInteractionContentMode {
  return value.text === null ? "none" : partial ? "preview" : "full";
}

function detailsOmitted(interaction: TaskInteractionItem | null | undefined): boolean {
  return interaction !== undefined && interaction !== null && "detailsOmitted" in interaction
    ? interaction.detailsOmitted
    : false;
}

function resultFromInteraction(interaction: TaskInteractionItem | null | undefined): string | null {
  return interaction && "result" in interaction ? interaction.result : null;
}

function errorFromInteraction(interaction: TaskInteractionItem | null | undefined): string | null {
  return interaction && "error" in interaction ? interaction.error : null;
}

function deliveryFromInteraction(interaction: TaskInteractionItem | null | undefined): TaskInteractionDeliveryStatus | null {
  return interaction && "deliveryStatus" in interaction ? interaction.deliveryStatus : null;
}

function itemId(event: BotifiedTimelineEvent, expectedType: string): string | undefined {
  return event.item?.type === expectedType ? event.item.id : undefined;
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerField(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function nonNegativeIntegerField(data: Record<string, unknown>, key: string): number | undefined {
  const value = integerField(data, key);
  return value !== undefined && value >= 0 ? value : undefined;
}

function booleanField(data: Record<string, unknown>, key: string): boolean | undefined {
  const value = data[key];
  return typeof value === "boolean" ? value : undefined;
}

function canonicalOutputDetailsOmitted(data: Record<string, unknown>): boolean {
  return booleanField(data, "output_complete") === false
    || booleanField(data, "output_tail_truncated") === true
    || booleanField(data, "output_artifact_truncated") === true
    || (nonNegativeIntegerField(data, "output_dropped_bytes") ?? 0) > 0;
}

function canonicalOutputIsPartial(data: Record<string, unknown>): boolean {
  return canonicalOutputDetailsOmitted(data);
}

function safeLabel(
  data: Record<string, unknown>,
  fields: readonly string[],
  redaction: InteractionTextRedactionOptions
): string | undefined {
  for (const field of fields) {
    const value = stringField(data, field);
    if (!value) continue;
    const redacted = redactInteractionText(value, { ...redaction, maxBytes: Math.min(redaction.maxBytes ?? 512, 512) });
    if (redacted.text !== null) return redacted.text;
  }
  return undefined;
}

function safeMediaType(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value) ? value : null;
}

function safeSha256(value: string | undefined): string | undefined {
  return value && /^[a-fA-F0-9]{64}$/.test(value) ? value.toLowerCase() : undefined;
}

function backgroundExecutionStatus(event: BotifiedTimelineEvent): TaskBackgroundTaskInteraction["executionStatus"] {
  const state = stringField(event.data, "state") ?? stringField(event.data, "status");
  if (
    state === "queued" || state === "running" || state === "completed" || state === "failed"
    || state === "cancelled" || state === "timed_out" || state === "lost"
  ) {
    return state;
  }
  switch (event.type) {
    case "background_task.completed": return "completed";
    case "background_task.failed": return "failed";
    case "background_task.cancelled": return "cancelled";
    case "background_task.timed_out": return "timed_out";
    case "background_task.lost": return "lost";
    default: return "running";
  }
}

function taskResultExecution(data: Record<string, unknown>): TaskResultInteraction["executionStatus"] | undefined {
  const callbackKind = stringField(data, "callback_kind");
  const callbackStatus: TaskResultInteraction["executionStatus"] | undefined = callbackKind === "task_completed"
    ? "completed"
    : callbackKind === "task_failed" ? "failed"
      : callbackKind === "task_timed_out" ? "timed_out"
        : callbackKind === "task_cancelled" ? "cancelled"
          : callbackKind === "task_lost" ? "lost" : undefined;
  if (callbackStatus) return callbackStatus;
  const value = stringField(data, "status") ?? stringField(data, "state");
  return value === "completed" || value === "failed" || value === "cancelled" || value === "timed_out" || value === "lost"
    ? value
    : undefined;
}

function taskResultStatus(
  value: TaskBackgroundTaskInteraction["executionStatus"]
): TaskResultInteraction["executionStatus"] | undefined {
  return value === "completed" || value === "failed" || value === "cancelled" || value === "timed_out" || value === "lost"
    ? value
    : undefined;
}

function subagentExecutionStatus(value: string | undefined): TaskSubagentResultInteraction["executionStatus"] | undefined {
  return value === "completed" || value === "failed" || value === "cancelled" ? value : undefined;
}

function callbackDelivery(event: BotifiedTimelineEvent): TaskInteractionDeliveryStatus {
  return explicitCallbackDelivery(event) ?? "pending";
}

function explicitCallbackDelivery(event: BotifiedTimelineEvent): TaskInteractionDeliveryStatus | null {
  const value = stringField(event.data, "callback_status")
    ?? stringField(event.data, "callback_delivery")
    ?? stringField(event.data, "result_delivery_status");
  if (value === "failed" || value === "delivered") return value;
  if (value === "pending" || value === "queued") return "pending";
  if (event.type === "background_task.callback_failed") return "failed";
  if (event.type === "background_task.callback_delivered" || event.type === "subagent.callback_delivered") return "delivered";
  return null;
}

function questionStatus(event: BotifiedTimelineEvent): TaskQuestionInteraction["status"] {
  switch (event.type) {
    case "task_ask.expired": return "expired";
    case "task_ask.rejected": return "rejected";
    case "task_reply.accepted":
    case "task_reply.written": return "answered";
    case "task_reply.failed": {
      const state = stringField(event.data, "state") ?? event.item?.status;
      if (state === "expired") return "expired";
      if (state === "rejected" || state === "task_terminal") return "rejected";
      return "reply_failed";
    }
    default: return "waiting";
  }
}

function monotonicUserStatus(
  current: TaskUserMessageInteraction["status"] | undefined,
  incoming: TaskUserMessageInteraction["status"]
): TaskUserMessageInteraction["status"] {
  if (!current) return incoming;
  if(current==="accepted"&&incoming==="queued")return "queued";
  const rank: Record<TaskUserMessageInteraction["status"], number> = {
    pending: 0, dispatching: 1, queued: 2, accepted: 3, rejected: 3, failed: 3
  };
  return rank[incoming] < rank[current] || rank[current] >= 3 ? current : incoming;
}

function terminalAssistantStatus(
  current: TaskAssistantMessageInteraction["status"] | undefined,
  incoming: TaskAssistantMessageInteraction["status"]
): TaskAssistantMessageInteraction["status"] {
  return current && current !== "generating" ? current : incoming;
}

function monotonicQuestionStatus(
  current: TaskQuestionInteraction["status"] | undefined,
  incoming: TaskQuestionInteraction["status"]
): TaskQuestionInteraction["status"] {
  if (!current) return incoming;
  const terminal = new Set<TaskQuestionInteraction["status"]>(["answered", "expired", "rejected", "reply_failed"]);
  return terminal.has(current) ? current : incoming;
}

function monotonicExecution<T extends string>(current: T | undefined, incoming: T, terminal: ReadonlySet<T>): T {
  return current !== undefined && terminal.has(current) ? current : incoming;
}

function monotonicDelivery(
  current: TaskInteractionDeliveryStatus | null | undefined,
  incoming: TaskInteractionDeliveryStatus
): TaskInteractionDeliveryStatus {
  return current === "delivered" || current === "failed" ? current : incoming;
}

function mergeCorrelation(
  current: TaskInteractionCorrelation | undefined,
  incoming: {
    toolCallId?: string | null | undefined;
    workTaskId?: string | null | undefined;
    callbackId?: string | null | undefined;
  }
): TaskInteractionCorrelation {
  return {
    ...(current?.toolCallId ? { toolCallId: current.toolCallId } : {}),
    ...(current?.workTaskId ? { workTaskId: current.workTaskId } : {}),
    ...(current?.callbackId ? { callbackId: current.callbackId } : {}),
    ...(incoming.toolCallId ? { toolCallId: incoming.toolCallId } : {}),
    ...(incoming.workTaskId ? { workTaskId: incoming.workTaskId } : {}),
    ...(incoming.callbackId ? { callbackId: incoming.callbackId } : {})
  };
}

function callbackCorrelation(
  previous: TaskInteractionProjectionState | null,
  data: Record<string, unknown>
): TaskInteractionCorrelation {
  return mergeCorrelation(previous?.correlation, {
    workTaskId: stringField(data, "task_id"),
    callbackId: stringField(data, "callback_id")
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function noInteraction(): TaskInteractionProjectionResult {
  return { interaction: null };
}

const TOOL_TERMINAL = new Set<TaskToolInteraction["executionStatus"]>(["completed", "failed", "cancelled"]);
const BACKGROUND_TERMINAL = new Set<TaskBackgroundTaskInteraction["executionStatus"]>([
  "completed", "failed", "cancelled", "timed_out", "lost"
]);
const TASK_RESULT_TERMINAL = new Set<"completed" | "failed" | "cancelled" | "timed_out" | "lost">([
  "completed", "failed", "cancelled", "timed_out", "lost"
]);
const SUBAGENT_TERMINAL = new Set<TaskSubagentResultInteraction["executionStatus"]>([
  "completed", "failed", "cancelled"
]);
