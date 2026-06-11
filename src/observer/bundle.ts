import type { ContextBundle, Episode, RawEvent } from "../core/types.ts";
import type { Store } from "../storage/index.ts";
import { newId as defaultNewId } from "../core/ids.ts";
import { toMs, toIso } from "../core/time.ts";

export interface BundleOptions {
  endTs?: string;
  windowSeconds?: number;
  newId?: (prefix: string) => string;
  /** Attach base64 frame images for a multimodal model (heavier bundle). */
  includeImages?: boolean;
}

/**
 * Assemble a bounded context bundle — the only thing the observer ever sees.
 * The model receives the last ~30-120s of frames/AX/input/focus/terminal/diffs
 * plus the reconstructed actions, never the unbounded ledger.
 */
export function buildBundle(store: Store, opts: BundleOptions = {}): ContextBundle {
  const newId = opts.newId ?? defaultNewId;
  const windowSeconds = opts.windowSeconds ?? 90;
  const all = store.events.range();
  const endTs = opts.endTs ?? all[all.length - 1]?.ts ?? new Date(0).toISOString();
  const endMs = toMs(endTs);
  const startMs = endMs - windowSeconds * 1000;
  const startTs = toIso(startMs);

  const events = store.events.range({ startTs, endTs: toIso(endMs + 1) });
  const bySource = (s: string) => events.filter((e) => e.source === s);

  const actions = store.actions.range({ startTs, endTs: toIso(endMs + 1) });

  const frameEvents = bySource("screen_video");
  // The observer only takes a handful of images, so order them to "compose"
  // the whole desk: the NEWEST frame of EVERY display first (multi-monitor
  // setups must all be visible), then remaining frames newest-first.
  const newestFirst = [...frameEvents].reverse();
  const perDisplay = new Map<unknown, RawEvent>();
  for (const e of newestFirst) {
    const d = e.payload.displayID ?? 0;
    if (!perDisplay.has(d)) perDisplay.set(d, e);
  }
  const picked = new Set([...perDisplay.values()].map((e) => e.id));
  const orderedFrames = [
    ...perDisplay.values(),
    ...newestFirst.filter((e) => !picked.has(e.id)),
  ];
  const frameImages = opts.includeImages
    ? orderedFrames.flatMap((e) =>
        e.blobRefs.flatMap((hash) => {
          const buf = store.blobs.get(hash);
          // Only genuine images go to a multimodal model — a corrupt blob
          // would fail the whole API request.
          const mediaType = buf ? sniffImage(buf) : undefined;
          return buf && mediaType
            ? [{ hash, base64: Buffer.from(buf).toString("base64"), mediaType }]
            : [];
        }),
      )
    : undefined;

  return {
    id: newId("bundle"),
    startTs,
    endTs,
    windowSeconds,
    frames: frameEvents.flatMap((e) => e.blobRefs),
    frameText: frameEvents
      .map((e) => {
        const t = (e.payload.ocrText as string | undefined) ?? "";
        if (!t) return "";
        // On multi-monitor setups, tell the model WHICH screen the text is on.
        const total = e.payload.displays as number | undefined;
        const idx = (e.payload.displayIndex as number | undefined) ?? 0;
        return total && total > 1 ? `[display ${idx + 1}] ${t}` : t;
      })
      .filter((t) => t.length > 0),
    frameImages,
    axText: bySource("accessibility")
      .map((e) => textOf(e.payload))
      .filter((t): t is string => !!t),
    inputEvents: bySource("input_events"),
    focus: bySource("focus_timeline"),
    terminal: bySource("terminal"),
    fileDiffs: bySource("filesystem"),
    audio: bySource("audio"),
    conversationTurns: actions.filter(
      (a) =>
        a.action === "submitted_message" ||
        a.action === "answered_question" ||
        a.action === "corrected_agent",
    ),
    actions,
  };
}

/** A bundle spanning an entire episode (for episode-level observation). */
export function bundleForEpisode(
  store: Store,
  episode: Episode,
  newId = defaultNewId,
): ContextBundle {
  const seconds = Math.ceil(
    (toMs(episode.endTs) - toMs(episode.startTs)) / 1000,
  ) + 1;
  return buildBundle(store, {
    endTs: episode.endTs,
    windowSeconds: seconds,
    newId,
  });
}

/** Detect a real image by magic bytes; returns its media type or undefined. */
export function sniffImage(buf: Uint8Array): string | undefined {
  if (
    buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  ) {
    return "image/png";
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  return undefined;
}

function textOf(payload: Record<string, unknown>): string | undefined {
  for (const k of ["text", "value", "title", "visibleText"]) {
    const v = payload[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/** Render a bundle as compact text for an LLM prompt or for debugging. */
export function renderBundle(bundle: ContextBundle): string {
  const lines: string[] = [];
  lines.push(`# Context window (${bundle.windowSeconds}s, ${bundle.startTs} → ${bundle.endTs})`);
  lines.push(`frames: ${bundle.frames.length}`);
  if (bundle.frameText.length)
    lines.push(`screen text (OCR):\n  - ${bundle.frameText.slice(-8).join("\n  - ")}`);
  if (bundle.axText.length)
    lines.push(`accessibility text:\n  - ${bundle.axText.slice(0, 12).join("\n  - ")}`);
  if (bundle.terminal.length)
    lines.push(
      `terminal:\n  - ${bundle.terminal
        .map((e) => `${e.payload.cmd} (exit ${e.payload.exitCode})`)
        .join("\n  - ")}`,
    );
  if (bundle.fileDiffs.length)
    lines.push(
      `file changes:\n  - ${bundle.fileDiffs
        .map((e) => `${e.type} ${e.payload.path ?? ""}`)
        .join("\n  - ")}`,
    );
  const transcript = bundle.audio.filter((e) => e.type === "transcript_segment");
  if (transcript.length)
    lines.push(
      `audio transcript (on-device; [mic] = said near the machine, [system] = playing on it):\n  - ${transcript
        .slice(-12)
        .map((e) => `[${e.payload.channel ?? "?"}] ${e.payload.text ?? ""}`)
        .join("\n  - ")}`,
    );
  lines.push(
    `reconstructed actions:\n  - ${bundle.actions
      .map((a) => `${a.action} (${a.confidence.toFixed(2)}) ${a.text ?? ""}`.trim())
      .join("\n  - ")}`,
  );
  return lines.join("\n");
}
