import type { RawEventInput } from "../capture/source.ts";

const REDACTED = "[redacted sensitive content]";
const SENSITIVE_KEY = /(?:pass(?:word|phrase)?|secret|token|api[_-]?key|private[_-]?key|credential|recovery[_-]?code)/i;
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:sk|gh[op]|xox[baprs]|AIza)[-_A-Za-z0-9]{12,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /(?:password|passphrase|secret|token|api[_ -]?key|client[_ -]?secret|recovery[_ -]?code)\s*[:=]\s*[^\s]{6,}/i,
] as const;

/** Conservative content check used only for clipboard/accessibility capture. */
export function looksLikeSensitiveContent(value: string): boolean {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) return true;
  // Fail closed for standalone high-entropy values commonly copied from a
  // password manager, while leaving ordinary prose and short identifiers.
  const trimmed = value.trim();
  return trimmed.length >= 32
    && trimmed.length <= 4096
    && !/\s/.test(trimmed)
    && /[A-Za-z]/.test(trimmed)
    && /\d/.test(trimmed)
    && /^[A-Za-z0-9+/=_~.-]+$/.test(trimmed);
}

function filterValue(value: unknown, key?: string): { value: unknown; redacted: boolean } {
  if (typeof value === "string") {
    if ((key !== undefined && SENSITIVE_KEY.test(key)) || looksLikeSensitiveContent(value)) {
      return { value: REDACTED, redacted: true };
    }
    return { value, redacted: false };
  }
  if (Array.isArray(value)) {
    let redacted = false;
    const filtered = value.map((item) => {
      const next = filterValue(item);
      redacted ||= next.redacted;
      return next.value;
    });
    return { value: filtered, redacted };
  }
  if (typeof value === "object" && value !== null) {
    let redacted = false;
    const filtered: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      const next = filterValue(nestedValue, nestedKey);
      redacted ||= next.redacted;
      filtered[nestedKey] = next.value;
    }
    return { value: filtered, redacted };
  }
  return { value, redacted: false };
}

/** Final content fence before sensitive native/user text can reach storage. */
export function filterSensitiveCapture(input: RawEventInput): RawEventInput {
  if (input.source !== "clipboard" && input.source !== "accessibility") return input;
  const payload = filterValue(input.payload ?? {}) as {
    value: Record<string, unknown>;
    redacted: boolean;
  };
  let redacted = payload.redacted;
  const blobs = (input.blobs ?? []).map((blob) => {
    if (blob.kind !== "text") return blob;
    const text = typeof blob.data === "string"
      ? blob.data
      : Buffer.from(blob.data).toString("utf8");
    if (!looksLikeSensitiveContent(text)) return blob;
    redacted = true;
    return { kind: blob.kind, data: REDACTED };
  });
  return {
    ...input,
    payload: redacted ? { ...payload.value, contentRedacted: true } : payload.value,
    ...(input.blobs ? { blobs } : {}),
  };
}
