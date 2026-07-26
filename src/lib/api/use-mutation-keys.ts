"use client";

import { useRef } from "react";
import { newIdempotencyKey } from "./client.ts";

export type MutationKeyOutcome =
  | "accepted_in_progress"
  | "completed"
  | "rejected_before_acceptance"
  | "outcome_unknown";

export type MutationKeyTransition = {
  outcome: MutationKeyOutcome;
  keyDisposition: "retain" | "retire";
};

export type MutationKeyAttempt = {
  key: string;
  fingerprint: string;
};

type MutationKey = {
  key: string;
  fingerprint?: string;
  state: "locked" | "completed_waiting";
};

export class MutationPayloadLockedError extends Error {
  constructor() {
    super("The unresolved command payload cannot be changed.");
    this.name = "MutationPayloadLockedError";
  }
}

export function createMutationKeyStore(
  generate: (operation: string) => string = newIdempotencyKey
) {
  const keys = new Map<string, MutationKey>();
  const scope = (operation: string, requestIdentity: string) =>
    `${operation}:${requestIdentity}`;

  return {
    key(operation: string, requestIdentity: string): string {
      const id = scope(operation, requestIdentity);
      const existing = keys.get(id);
      if (existing) return existing.key;
      const created = generate(operation);
      keys.set(id, { key: created, state: "locked" });
      return created;
    },

    requestKey(operation: string, requestSlot: string, request: unknown): string {
      const id = scope(operation, requestSlot);
      const fingerprint = JSON.stringify(request) ?? "undefined";
      const existing = keys.get(id);
      if (existing?.fingerprint === fingerprint) return existing.key;
      const key = generate(operation);
      keys.set(id, { key, fingerprint, state: "locked" });
      return key;
    },

    fingerprintKey(
      operation: string,
      requestSlot: string,
      fingerprint: string
    ): MutationKeyAttempt {
      const id = scope(operation, requestSlot);
      const existing = keys.get(id);
      if (existing) {
        if (existing.fingerprint === fingerprint) {
          return { key: existing.key, fingerprint };
        }
        throw new MutationPayloadLockedError();
      }
      const key = generate(operation);
      keys.set(id, { key, fingerprint, state: "locked" });
      return { key, fingerprint };
    },

    restore(
      operation: string,
      requestIdentity: string,
      identity: MutationKeyAttempt
    ): void {
      const id = scope(operation, requestIdentity);
      const existing = keys.get(id);
      if (
        existing
        && (
          existing.key !== identity.key
          || existing.fingerprint !== identity.fingerprint
        )
      ) {
        throw new Error("Mutation key identity changed during restore");
      }
      keys.set(id, {
        key: identity.key,
        fingerprint: identity.fingerprint,
        state: "locked"
      });
    },

    transition(
      operation: string,
      requestIdentity: string,
      attempt: MutationKeyAttempt,
      transition: MutationKeyTransition
    ): void {
      const id = scope(operation, requestIdentity);
      const existing = keys.get(id);
      if (
        !existing
        || existing.key !== attempt.key
        || existing.fingerprint !== attempt.fingerprint
      ) return;

      if (transition.keyDisposition === "retain") {
        keys.set(id, { ...existing, state: "locked" });
      } else if (transition.outcome === "completed") {
        keys.set(id, { ...existing, state: "completed_waiting" });
      } else {
        keys.delete(id);
      }
    },

    canonicalAbsorbed(
      operation: string,
      requestIdentity: string,
      attempt: MutationKeyAttempt
    ): void {
      const id = scope(operation, requestIdentity);
      const existing = keys.get(id);
      if (
        existing?.state === "completed_waiting"
        && existing.key === attempt.key
        && existing.fingerprint === attempt.fingerprint
      ) keys.delete(id);
    },

    discard(
      operation: string,
      requestIdentity: string,
      attempt: MutationKeyAttempt
    ): void {
      const id = scope(operation, requestIdentity);
      const existing = keys.get(id);
      if (
        existing?.key === attempt.key
        && existing.fingerprint === attempt.fingerprint
      ) keys.delete(id);
    },

    complete(operation: string, requestIdentity: string): void {
      keys.delete(scope(operation, requestIdentity));
    },

    clear(operation: string): void {
      for (const key of keys.keys()) {
        if (key.startsWith(`${operation}:`)) keys.delete(key);
      }
    }
  };
}

export function useMutationKeys() {
  return useRef(createMutationKeyStore()).current;
}
