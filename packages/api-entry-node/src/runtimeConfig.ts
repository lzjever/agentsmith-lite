export function optionalRuntimeTickIntervalMs(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error("AGENTSMITH_LITE_RUNTIME_TICK_MS must be a positive integer");
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("AGENTSMITH_LITE_RUNTIME_TICK_MS must be a positive integer");
  }
  return parsed;
}
