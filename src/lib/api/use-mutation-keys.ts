"use client";

import { useRef } from "react";
import { newIdempotencyKey } from "./client";

type MutationKey = { key: string; request?: string };

export function useMutationKeys() {
  const keys = useRef(new Map<string, MutationKey>());
  function scope(operation: string, requestIdentity: string) { return `${operation}:${requestIdentity}`; }
  return {
    key(operation: string, requestIdentity: string): string {
      const id = scope(operation, requestIdentity);
      const existing = keys.current.get(id);
      if (existing) return existing.key;
      const created = newIdempotencyKey(operation);
      keys.current.set(id, { key: created });
      return created;
    },
    requestKey(operation: string, requestSlot: string, request: unknown): string {
      const id = scope(operation, requestSlot);
      const signature = JSON.stringify(request) ?? "undefined";
      const existing = keys.current.get(id);
      if (existing?.request === signature) return existing.key;
      const created = newIdempotencyKey(operation);
      keys.current.set(id, { key: created, request: signature });
      return created;
    },
    complete(operation: string, requestIdentity: string): void { keys.current.delete(scope(operation, requestIdentity)); },
    clear(operation: string): void { for (const key of keys.current.keys()) if (key.startsWith(`${operation}:`)) keys.current.delete(key); }
  };
}
