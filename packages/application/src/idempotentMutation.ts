import { createHash } from "node:crypto";
import { ProductError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import type {
  ClaimedTaskIdempotencyOperation,
  CompleteTaskIdempotencyInput,
  ProductStore,
  TaskIdempotencyOperation
} from "../../ports/src/store.js";

type ProductMutationOperation = Extract<TaskIdempotencyOperation, `${"workspace" | "project"}.${string}`>;
interface IdempotentMutationRunContext<Operation extends ProductMutationOperation> {
  owner: ClaimedTaskIdempotencyOperation & { operation: Operation };
  completion(responseStatus: number, responseBody: unknown): CompleteTaskIdempotencyInput;
}

export async function runIdempotentMutation<T, Operation extends ProductMutationOperation>(input: {
  store: ProductStore;
  actorId: string;
  scopeId: string;
  operation: Operation;
  key: string;
  request: unknown;
  resourceId: string;
  failureMessage: string;
  completeServerErrors?: boolean;
  run: (resourceId: string, context: IdempotentMutationRunContext<Operation>) => Promise<T>;
}): Promise<T> {
  const timestamp = nowIso();
  const requestHash = canonicalRequestHash(input.request);
  const claimToken = newId("idempotency_claim");
  const begun = await input.store.beginTaskIdempotency({
    actorId: input.actorId,
    projectId: input.scopeId,
    operation: input.operation,
    key: input.key,
    requestHash,
    resourceId: input.resourceId,
    claimToken,
    now: timestamp,
    leaseExpiresAt: new Date(Date.parse(timestamp) + 30_000).toISOString()
  });
  if (begun.kind === "hash_mismatch") throw new ProductError("Idempotency-Key was already used with a different request", 409);
  if (begun.kind === "in_progress") throw new ProductError("Idempotent operation is still in progress", 409, "idempotency_in_progress");
  if (begun.kind === "replay") {
    if (begun.responseStatus >= 400) {
      const body = begun.responseBody as { error?: unknown; code?: unknown };
      throw new ProductError(
        typeof body?.error === "string" ? body.error : input.failureMessage,
        begun.responseStatus,
        typeof body?.code === "string" ? body.code : undefined
      );
    }
    return begun.responseBody as T;
  }
  const owner: ClaimedTaskIdempotencyOperation & { operation: Operation } = {
    actorId: input.actorId,
    projectId: input.scopeId,
    operation: input.operation,
    key: input.key,
    requestHash,
    resourceId: begun.resourceId,
    claimToken: begun.claimToken
  };
  try {
    const response = await input.run(begun.resourceId, {
      owner,
      completion: (responseStatus, responseBody) => ({
        actorId: input.actorId,
        projectId: input.scopeId,
        operation: input.operation,
        key: input.key,
        requestHash,
        claimToken: begun.claimToken,
        responseStatus,
        responseBody,
        updatedAt: nowIso()
      })
    });
    const completed = await input.store.completeTaskIdempotency({
      actorId: input.actorId,
      projectId: input.scopeId,
      operation: input.operation,
      key: input.key,
      requestHash,
      claimToken: begun.claimToken,
      responseStatus: 200,
      responseBody: response,
      updatedAt: nowIso()
    });
    if (!completed) throw new ProductError("Idempotent operation lost its claim", 409);
    return response;
  } catch (error) {
    const productError = error instanceof ProductError ? error : new ProductError(input.failureMessage, 500);
    if (input.completeServerErrors !== false || productError.statusCode < 500) await input.store.completeTaskIdempotency({
      actorId: input.actorId,
      projectId: input.scopeId,
      operation: input.operation,
      key: input.key,
      requestHash,
      claimToken: begun.claimToken,
      responseStatus: productError.statusCode,
      responseBody: {
        error: productError.message,
        ...(productError.code ? { code: productError.code } : {})
      },
      updatedAt: nowIso()
    });
    throw productError;
  }
}

export function canonicalRequestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("base64url");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProductError("Request contains a non-finite number", 400);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new ProductError("Request cannot be canonically hashed", 400);
}
