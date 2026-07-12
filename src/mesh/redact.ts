/**
 * Mesh redaction boundary. EVERYTHING mesh-bound (WorkFrame intents,
 * uncertainty strings, dispatch task text, brief text) passes through
 * `redactText` before serialization. Raw events, blobs, screen/audio content,
 * and prompt/response bodies must never reach this layer at all — redaction is
 * the second fence, not the first.
 */

import type { WorkFrame } from "./types.ts";

export interface RedactOptions {
  /** Hard cap on output length (redactor may truncate). */
  maxChars?: number;
}

/** Redact secrets/PII/content from a mesh-bound string. Deterministic. */
export function redactText(text: string, opts: RedactOptions = {}): string {
  let redacted = text;

  // Keep this order stable: the more specific forms must be removed before
  // the broad encoded-value rules below inspect the remaining text.
  redacted = redacted.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    "[redacted]",
  );

  redacted = redacted
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "[redacted]")
    .replace(/gh[po]_[A-Za-z0-9]{10,}/g, "[redacted]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[redacted]")
    .replace(/xox[bp]-[A-Za-z0-9-]{10,}/g, "[redacted]")
    .replace(
      /eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+){0,2}/g,
      "[redacted]",
    )
    .replace(
      /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
      "Bearer [redacted]",
    );

  redacted = redacted.replace(
    /(?<![A-Fa-f0-9])[A-Fa-f0-9]{32,}(?![A-Fa-f0-9])/g,
    "[redacted]",
  );

  redacted = redacted.replace(
    /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{32,}(?![A-Za-z0-9+/_=-])/g,
    (value) => (/[0-9+/=]/.test(value) ? "[redacted]" : value),
  );

  redacted = redactLongQuotedLiterals(redacted);

  if (opts.maxChars !== undefined && redacted.length > opts.maxChars) {
    const maxChars = Math.max(0, Math.trunc(opts.maxChars));
    redacted = redacted.slice(0, maxChars);
  }

  return redacted;
}

/**
 * Apply the second privacy fence to an entire WorkFrame. Returning a copy
 * keeps callers from accidentally replacing their local, richer projection.
 *
 * The copy is an explicit contract-v0 field WHITELIST (no spread): a caller
 * that smuggled extra fields onto a frame must not see them serialized to the
 * wire — this function is the redaction boundary, not just a string filter.
 */
export function redactWorkFrame(frame: WorkFrame): WorkFrame {
  return {
    v: 0,
    id: frame.id,
    kind: "workframe",
    person: frame.person,
    device: frame.device,
    project: frame.project,
    ts: frame.ts,
    intent: redactText(frame.intent),
    status: frame.status,
    artifacts: frame.artifacts
      .filter((artifact) => !isSecretArtifactPath(artifact.path))
      .map((artifact) => ({
        repo: artifact.repo,
        path: artifact.path,
        ...(artifact.branch !== undefined ? { branch: artifact.branch } : {}),
      })),
    uncertainty: frame.uncertainty.map((value) => redactText(value)),
    claimsTouched: [...frame.claimsTouched],
    evidenceRefs: [...frame.evidenceRefs],
    ...(frame.sessionKey !== undefined ? { sessionKey: frame.sessionKey } : {}),
  };
}

function redactLongQuotedLiterals(text: string): string {
  const redactIfLong = (literal: string): string =>
    literal.slice(1, -1).length > 80 ? "[redacted]" : literal;

  return text
    .replace(/"(?:\\[\s\S]|[^"\\])*"/g, redactIfLong)
    .replace(/'(?:\\[\s\S]|[^'\\])*'/g, redactIfLong)
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, redactIfLong);
}

function isSecretArtifactPath(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) =>
    /^\.env(?:\..*)?$/i.test(segment)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$/i.test(segment)
    || /\.pem$/i.test(segment)
    || /^credentials/i.test(segment)
  );
}
