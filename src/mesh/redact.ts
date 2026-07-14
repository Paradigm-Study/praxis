/**
 * Mesh redaction boundary. EVERYTHING mesh-bound (WorkFrame intents,
 * uncertainty strings, dispatch task text, brief text) passes through
 * `redactText` before serialization. Raw events, blobs, screen/audio content,
 * and prompt/response bodies must never reach this layer at all — redaction is
 * the second fence, not the first.
 */

import type { ContextFrame, MeshFrame, WorkFrame } from "./types.ts";

export interface RedactOptions {
  /** Hard cap on output length (redactor may truncate). */
  maxChars?: number;
}

/** Redact secrets/PII/content from a mesh-bound string. Deterministic. */
export function redactText(text: string, opts: RedactOptions = {}): string {
  let redacted = opts.maxChars === undefined
    ? text
    : text.slice(0, Math.max(1_024, Math.max(0, Math.trunc(opts.maxChars)) * 4));

  // Absolute paths disclose usernames, mount layouts, and client names. URLs
  // are left intact: their slashes are preceded by ':'/'/' or a host byte.
  redacted = redacted
    .replace(/\b(?:file|vscode):\/\/[^\s"'`]*/gi, "[redacted path]")
    .replace(/\\\\[^\s\\"'`]+\\[^\s"'`]*/g, "[redacted path]")
    .replace(/(?<![:/A-Za-z0-9])\/(?!\/)[^\s"'`]*/g, "[redacted path]")
    .replace(/\b[A-Za-z]:[\\/][^\s"'`]*/g, "[redacted path]");

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
  const sessionKey = safeOpaqueId(frame.sessionKey);
  return {
    v: 0,
    id: frame.id,
    kind: "workframe",
    person: frame.person,
    device: frame.device,
    project: frame.project,
    ts: frame.ts,
    intent: redactText(frame.intent, { maxChars: 500 }),
    status: frame.status,
    artifacts: frame.artifacts.slice(0, 64)
      .filter((artifact) => !isSecretArtifactPath(artifact.path))
      .map((artifact) => ({
        repo: artifact.repo,
        path: artifact.path,
        ...(safeBranch(artifact.branch) ? { branch: safeBranch(artifact.branch) } : {}),
      })),
    uncertainty: frame.uncertainty.slice(0, 16).map((value) => redactText(value, { maxChars: 240 })),
    claimsTouched: frame.claimsTouched.slice(0, 64).filter(isSafeReference),
    evidenceRefs: frame.evidenceRefs.slice(0, 64).filter((value) => /^[a-f0-9]{64}$/.test(value)),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

/** Explicit v1 whitelist projection. Local consent selectors can never cross it. */
export function redactContextFrame(frame: ContextFrame): ContextFrame {
  const sessionKey = safeOpaqueId(frame.sessionKey);
  const sourceId = safeOpaqueId(frame.source.id) ?? "invalid";
  return {
    v: 1,
    id: frame.id,
    kind: "context_frame",
    person: frame.person,
    device: frame.device,
    ts: frame.ts,
    source: {
      kind: frame.source.kind,
      id: sourceId,
      ...(frame.source.label
        ? { label: redactText(frame.source.label, { maxChars: 200 }) }
        : {}),
    },
    signal: frame.signal,
    summary: redactText(frame.summary, { maxChars: 500 }),
    status: frame.status,
    entities: frame.entities.slice(0, 32).flatMap((entity) => {
      const key = safeOpaqueId(entity.key);
      return key
        ? [{
            kind: entity.kind,
            key,
            ...(entity.label
              ? { label: redactText(entity.label, { maxChars: 200 }) }
              : {}),
          }]
        : [];
    }),
    artifacts: frame.artifacts.slice(0, 64)
      .filter((artifact) => !isSecretArtifactPath(artifact.path))
      .map((artifact) => ({
        repo: artifact.repo,
        path: artifact.path,
        ...(safeBranch(artifact.branch) ? { branch: safeBranch(artifact.branch) } : {}),
      })),
    links: frame.links.slice(0, 32).flatMap((link) => {
      const targetId = safeOpaqueId(link.targetId);
      return targetId
        ? [{
            relation: link.relation,
            targetId,
            reason: redactText(link.reason, { maxChars: 240 }),
          }]
        : [];
    }),
    uncertainty: frame.uncertainty.slice(0, 16)
      .map((value) => redactText(value, { maxChars: 240 })),
    claimsTouched: frame.claimsTouched.slice(0, 64).filter(isSafeReference),
    evidenceRefs: frame.evidenceRefs.slice(0, 64)
      .filter((value) => /^[a-f0-9]{64}$/.test(value)),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

/** Whitelist and redact either v0 relay frame before network OR retry disk. */
export function redactMeshFrame(frame: MeshFrame): MeshFrame {
  if (frame.kind === "workframe") return redactWorkFrame(frame);
  if (frame.kind === "context_frame") return redactContextFrame(frame);
  return {
    v: 0,
    kind: "card_event",
    person: frame.person,
    device: frame.device,
    project: frame.project,
    ts: frame.ts,
    cardId: frame.cardId,
    stage: frame.stage,
    event: frame.event,
    ...(frame.verdict !== undefined ? { verdict: redactText(frame.verdict, { maxChars: 500 }) } : {}),
    artifacts: frame.artifacts.slice(0, 64)
      .filter((artifact) => !isSecretArtifactPath(artifact.path))
      .map((artifact) => ({ repo: artifact.repo, path: artifact.path })),
    specCriteria: frame.specCriteria.slice(0, 32).flatMap((criterion) => safeOpaqueId(criterion.id)
      ? [{
      id: criterion.id,
      behavior: redactText(criterion.behavior, { maxChars: 500 }),
    }]
      : []),
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

function isSafeReference(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)
    && redactText(value) === value;
}

function safeOpaqueId(value: string | undefined): string | undefined {
  return value && isSafeReference(value) ? value : undefined;
}

function safeBranch(value: string | undefined): string | undefined {
  if (!value || value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value)) {
    return undefined;
  }
  return redactText(value) === value ? value : undefined;
}
