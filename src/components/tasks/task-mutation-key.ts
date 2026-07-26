import { useMemo } from "react";
import { ApiError } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";

export function useTaskMutationKeys() {
  const keys = useMutationKeys();
  return useMemo(() => ({
    ...keys,
    completeApiFailure(reason: unknown, operation: string, requestIdentity: string) {
      if (reason instanceof ApiError) keys.complete(operation, requestIdentity);
    },
  }), [keys]);
}
