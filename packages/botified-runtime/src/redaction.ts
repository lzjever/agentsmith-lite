const REDACTED = "[redacted]";
const DEFAULT_MAX_BYTES = 8 * 1024;
const ABSOLUTE_MAX_INPUT_BYTES = 64 * 1024;
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const URL_PATTERN = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"']+/g;
const SENSITIVE_NAME_PATTERN = /(?:^|[_-])(?:api[_-]?key|private[_-]?key|service[_-]?key|ssl[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|secret|password|passwd|credential|signature|sig|authorization|cookie|session[_-]?(?:id|key|token))(?:$|[_-])/i;

export interface InteractionTextRedactionOptions {
  knownSecrets?: Iterable<string>;
  maxBytes?: number;
}

export interface RedactedInteractionText {
  text: string | null;
  detailsOmitted: boolean;
}

export function redactInteractionText(
  value: unknown,
  options: InteractionTextRedactionOptions = {}
): RedactedInteractionText {
  return redactBoundedInteractionText(value, options.knownSecrets, normalizeMaxBytes(options.maxBytes));
}

export function redactProductInteractionText(
  value: unknown,
  options: InteractionTextRedactionOptions = {}
): RedactedInteractionText {
  return redactBoundedInteractionText(value, options.knownSecrets, ABSOLUTE_MAX_INPUT_BYTES);
}

function redactBoundedInteractionText(
  value: unknown,
  knownSecrets: Iterable<string> | undefined,
  maxBytes: number
): RedactedInteractionText {
  if (typeof value !== "string" || UNSAFE_CONTROL_CHARACTERS.test(value)) {
    return omittedText();
  }

  const inputBytes = Buffer.byteLength(value, "utf8");
  if (inputBytes > maxBytes) {
    return omittedText();
  }

  const text = redactSecretLikeText(value, knownSecrets);
  if (Buffer.byteLength(text, "utf8") > maxBytes || UNSAFE_CONTROL_CHARACTERS.test(text)) {
    return omittedText();
  }
  return { text, detailsOmitted: false };
}

export function redactSecretLikeText(text: string, knownSecrets: Iterable<string> = []): string {
  let redacted = redactKnownSecrets(text, knownSecrets);
  redacted = redacted.replace(URL_PATTERN, redactUrl);
  redacted = redactQuotedHeaders(redacted);
  redacted = redactUnquotedHeaders(redacted);
  redacted = redactJsonSecrets(redacted);
  redacted = redactAssignments(redacted);
  return redactTokenShapes(redacted);
}

export function isSecretLikeText(text: string, knownSecrets: Iterable<string> = []): boolean {
  return redactSecretLikeText(text, knownSecrets) !== text;
}

function redactKnownSecrets(text: string, knownSecrets: Iterable<string>): string {
  const secrets = new Set<string>();
  for (const secret of knownSecrets) {
    if (secret.length > 0) {
      secrets.add(secret);
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) {
        secrets.add(encoded);
        secrets.add(encoded.replace(/%[0-9A-F]{2}/g, (value) => value.toLowerCase()));
        secrets.add(encoded.replace(/%20/g, "+"));
      }
    }
  }

  let redacted = text;
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted;
}

function redactUrl(raw: string): string {
  const trailing = /[),.;:!?]+$/.exec(raw)?.[0] ?? "";
  const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
  try {
    const url = new URL(candidate);
    let changed = false;
    if (url.username) {
      url.username = "redacted";
      changed = true;
    }
    if (url.password) {
      url.password = "redacted";
      changed = true;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveName(key)) {
        url.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    return changed ? `${url.toString()}${trailing}` : raw;
  } catch {
    return REDACTED;
  }
}

function redactQuotedHeaders(text: string): string {
  const names = "authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token|service-key";
  const shellHeader = new RegExp(`(["'])\\s*(${names})\\s*:\\s*.*?\\1`, "gi");
  const valueQuoted = new RegExp(`\\b(${names})\\s*:\\s*(["'])(.*?)\\2`, "gi");
  return text
    .replace(shellHeader, (_match, quote: string, name: string) => `${quote}${name}: ${REDACTED}${quote}`)
    .replace(valueQuoted, (_match, name: string, quote: string) => `${name}: ${quote}${REDACTED}${quote}`);
}

function redactUnquotedHeaders(text: string): string {
  let redacted = text.replace(
    /\b(authorization|proxy-authorization)\s*:\s*(?:basic|bearer)\s+[^\s,"';}]+/gi,
    (_match, name: string) => `${name}: ${REDACTED}`
  );
  redacted = redacted.replace(
    /(?<!["'])\b(cookie|set-cookie)\s*:\s*[^\r\n]*/gi,
    (_match, name: string) => `${name}: ${REDACTED}`
  );
  redacted = redacted.replace(
    /(^|[\r\n])([ \t]*)(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token|service-key)\s*:\s*[^\r\n]*/gi,
    (_match, boundary: string, whitespace: string, name: string) => `${boundary}${whitespace}${name}: ${REDACTED}`
  );
  return redacted;
}

function redactJsonSecrets(text: string): string {
  return text.replace(
    /(["'])([^"'\r\n]{1,128})\1\s*:\s*(["'])(.*?)\3/g,
    (match, keyQuote: string, key: string, valueQuote: string) => isSensitiveName(key)
      ? `${keyQuote}${key}${keyQuote}: ${valueQuote}${REDACTED}${valueQuote}`
      : match
  );
}

function redactAssignments(text: string): string {
  return text.replace(
    /\b([A-Za-z_][A-Za-z0-9_-]{0,127})\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/g,
    (match, key: string) => isSensitiveName(key) ? `${key}=${REDACTED}` : match
  );
}

function redactTokenShapes(text: string): string {
  return text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, (match) => `${match.split(/\s+/, 1)[0]} ${REDACTED}`)
    .replace(/\b(?:bsk[_-]|sk[-_]|gh[opusr]_|glpat-)[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED);
}

function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME_PATTERN.test(name);
}

function normalizeMaxBytes(maxBytes: number | undefined): number {
  if (maxBytes === undefined) {
    return DEFAULT_MAX_BYTES;
  }
  return Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? Math.min(maxBytes, ABSOLUTE_MAX_INPUT_BYTES)
    : DEFAULT_MAX_BYTES;
}

function omittedText(): RedactedInteractionText {
  return { text: null, detailsOmitted: true };
}
