import type {
  TaskTerminalStartClientOutcome
} from "../../lib/api/client.js";
import type {
  TaskTerminalStartRequest
} from "../../../packages/contracts/src/api.js";

export type TerminalStartSubmissionOptions = {
  taskId:string;
  request:TaskTerminalStartRequest;
  idempotencyKey:string;
  signal:AbortSignal;
  start:(
    taskId:string,
    request:TaskTerminalStartRequest,
    idempotencyKey:string,
    signal:AbortSignal
  )=>Promise<TaskTerminalStartClientOutcome>;
};

export async function submitTerminalStart(
  options:TerminalStartSubmissionOptions
):Promise<TaskTerminalStartClientOutcome>{
  options.signal.throwIfAborted();
  const outcome=await options.start(
    options.taskId,
    options.request,
    options.idempotencyKey,
    options.signal
  );
  options.signal.throwIfAborted();
  return outcome;
}
