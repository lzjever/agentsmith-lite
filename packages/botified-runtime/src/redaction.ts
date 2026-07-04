const SECRET_FIELD_PATTERN = /secret|token|api[_-]?key|password/i;

export function redactSecretLikeText(text: string): string {
  return text
    .replace(/\bBearer\s+[^"',\s}]+/gi, "Bearer <redacted>")
    .replace(/\bbsk_[A-Za-z0-9_-]{3,}\b/g, "bsk_<redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]{3,}\b/g, "sk-<redacted>");
}

export function isSecretLikeText(text: string): boolean {
  return redactSecretLikeText(text) !== text;
}

export function redactBotifiedPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    result[key] = SECRET_FIELD_PATTERN.test(key) ? "[redacted]" : redactBotifiedValue(value);
  }
  return result;
}

function redactBotifiedValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecretLikeText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactBotifiedValue);
  }
  if (isRecord(value)) {
    return redactBotifiedPayload(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
