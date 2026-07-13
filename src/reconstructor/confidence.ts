/**
 * Confidence scoring for reconstructed actions.
 *
 * An action is supported by one or more independent signals (an Enter keypress,
 * a draft in the text field, a new conversation bubble, a matching AI request).
 * We treat these as independent evidence and combine them with a noisy-OR: each
 * signal alone gives some probability the action happened; together they push
 * confidence up. This is why "Enter + draft + bubble" lands near 0.98 while a
 * lone weak signal stays low.
 */

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** A named evidence signal with its standalone probability. */
export interface Signal {
  /** RawEvent id this signal comes from. */
  id: string;
  /** Standalone probability that this signal implies the action (0..1). */
  p: number;
  /** Short tag for explanations. */
  tag: string;
}

export interface Scored {
  confidence: number;
  evidence: string[];
  signals: string[];
}

/** Combine present signals via noisy-OR. */
export function score(signals: Signal[]): Scored {
  // Multiple features can be extracted from one raw event (for example a
  // filesystem change that also carries a diff). They describe one source,
  // not independent corroboration. Keep the strongest interpretation of each
  // raw event so noisy-OR cannot count the same evidence twice.
  const independent = new Map<string, Signal>();
  for (const signal of signals) {
    if (signal.p <= 0) continue;
    const prior = independent.get(signal.id);
    if (!prior || signal.p > prior.p) independent.set(signal.id, signal);
  }
  const present = [...independent.values()];
  const conf = clamp01(1 - present.reduce((acc, s) => acc * (1 - s.p), 1));
  return {
    confidence: round2(conf),
    evidence: present.map((s) => s.id),
    signals: present.map((s) => s.tag),
  };
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Standalone signal probabilities, tuned so corroboration matters. */
export const P = {
  enterKey: 0.6,
  draftText: 0.5,
  userBubble: 0.85,
  aiRequest: 0.5,
  screenMatch: 0.4,
  /** A frame whose OCR text actually contains the draft — strong corroboration. */
  screenOcrMatch: 0.6,
  focusActive: 0.3,

  fileChanged: 0.9,
  fileDiff: 0.4,
  fileSaved: 0.92,
  cmdSaveKey: 0.6,
  uiSnapshotFile: 0.7,

  commandRun: 0.97,
  failExit: 0.6,
  dwellOnFailure: 0.55,
  copyAfterFail: 0.45,
  sameCmdRetry: 0.85,
  prevFailed: 0.5,

  gitCommit: 0.98,
  appFocused: 0.97,
  pageLoaded: 0.92,
  controlClick: 0.9,
  clipboard: 0.85,

  dwellWithAx: 0.55,
  axPresent: 0.35,

  // audio — a transcript segment is a raw fact that sound played; what the USER
  // was doing with it (listening? in a meeting? background noise?) is the
  // interpretation, so these stay deliberately moderate.
  systemSpeech: 0.6,
  micSpeech: 0.6,
  bothSidesTalking: 0.5,
  moreSegments: 0.08,
  playbackState: 0.1,
  // weak / uncertain
  dwellNoAx: 0.4,
  screenOnly: 0.25,
} as const;
