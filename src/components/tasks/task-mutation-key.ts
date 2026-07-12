"use client";

import { useRef } from "react";
import { newIdempotencyKey } from "../../lib/api/client";

export function useTaskMutationKeys() {
  const keys = useRef(new Map<string, string>());
  function scope(operation: string, requestIdentity: string) { return `${operation}:${requestIdentity}`; }
  return {
    key(operation: string, requestIdentity: string): string {
      const id = scope(operation, requestIdentity);
      const existing = keys.current.get(id);
      if (existing) return existing;
      const created = newIdempotencyKey(operation);
      keys.current.set(id, created);
      return created;
    },
    complete(operation: string, requestIdentity: string): void { keys.current.delete(scope(operation, requestIdentity)); },
    clear(operation: string): void { for (const key of keys.current.keys()) if (key.startsWith(`${operation}:`)) keys.current.delete(key); }
  };
}
