import type { ActionEvent, RawEvent } from "../../core/types.ts";
import type { RuleContext } from "../evidence.ts";
import { P, score, type Signal } from "../confidence.ts";
import { mkAction } from "../rule.ts";
import { toMs } from "../../core/time.ts";

/**
 * Audio reconstruction. The capture client emits on-device transcript segments
 * tagged with their channel:
 *   - "system" — what the Mac was playing (a call's remote side, music, video)
 *   - "mic"    — what was said near the machine
 *
 * Pairing the two is what turns sound into actions: interleaved mic + system
 * speech is a conversation (`attended_meeting`); system speech alone is
 * playback (`listened_audio`); mic speech alone is the user talking
 * (`spoke_aloud`, open-vocabulary — could be dictation or someone nearby).
 */

/** Segments closer than this belong to the same span. */
const SPAN_GAP_MS = 20_000;
/** Mic/system spans within this slack of each other count as one conversation. */
const OVERLAP_SLACK_MS = 30_000;

/**
 * A two-sided audio coincidence is enough only for apps whose primary role is a
 * live call. Generic browsers/editors need an actual back-and-forth so nearby
 * dictation plus a video does not become a confident meeting receipt.
 */
const STRONG_MEETING_APPS = [
  /\bzoom(?:\.us)?\b/i,
  /\bmicrosoft\s+teams\b/i,
  /\bface\s*time\b/i,
  /\b(?:cisco\s+)?webex\b/i,
  /\bgoogle\s+meet\b/i,
  /\bgo\s*to\s*meeting\b/i,
  /\bbluejeans\b/i,
  /\baround\b/i,
];

interface Span {
  channel: string;
  startMs: number;
  endMs: number;
  segments: RawEvent[];
}

function segText(e: RawEvent): string {
  const t = e.payload.text;
  return typeof t === "string" ? t : "";
}

function normalizedTranscript(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function multisetDice(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const remaining = new Map<string, number>();
  for (const item of left) remaining.set(item, (remaining.get(item) ?? 0) + 1);
  let intersection = 0;
  for (const item of right) {
    const count = remaining.get(item) ?? 0;
    if (count > 0) {
      intersection += 1;
      remaining.set(item, count - 1);
    }
  }
  return (2 * intersection) / (left.length + right.length);
}

function bigrams(text: string): string[] {
  const compact = text.replace(/\s+/g, " ");
  if (compact.length < 2) return compact ? [compact] : [];
  return Array.from({ length: compact.length - 1 }, (_, index) => compact.slice(index, index + 2));
}

/** Deterministic transcript similarity used to reject mic/system loopback. */
export function audioTranscriptSimilarity(left: string, right: string): number {
  const a = normalizedTranscript(left);
  const b = normalizedTranscript(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const tokenScore = multisetDice(a.split(" "), b.split(" "));
  const bigramScore = multisetDice(bigrams(a), bigrams(b));
  return Math.max(tokenScore, bigramScore);
}

function spans(events: RawEvent[], channel: string): Span[] {
  const segs = events
    .filter(
      (e) =>
        e.source === "audio" &&
        e.type === "transcript_segment" &&
        e.payload.channel === channel &&
        segText(e).trim().length > 0,
    )
    .sort((a, b) => toMs(a.ts) - toMs(b.ts) || a.id.localeCompare(b.id));
  const out: Span[] = [];
  for (const e of segs) {
    const ms = toMs(e.ts);
    const last = out[out.length - 1];
    if (last && ms - last.endMs <= SPAN_GAP_MS) {
      last.endMs = ms;
      last.segments.push(e);
    } else {
      out.push({ channel, startMs: ms, endMs: ms, segments: [e] });
    }
  }
  return out;
}

function overlaps(a: Span, b: Span): boolean {
  return (
    a.startMs <= b.endMs + OVERLAP_SLACK_MS &&
    b.startMs <= a.endMs + OVERLAP_SLACK_MS
  );
}

function spanText(span: Span): string {
  return span.segments.map(segText).join(" ");
}

function strongMeetingApp(...spans: Span[]): boolean {
  return spans.some((span) => {
    const app = span.segments[0]?.app ?? "";
    return STRONG_MEETING_APPS.some((pattern) => pattern.test(app));
  });
}

/** Count speaker turns after collapsing consecutive segments on one channel. */
function alternatingTurnCount(...spans: Span[]): number {
  const ordered = spans
    .flatMap((span) => span.segments.map((event) => ({ channel: span.channel, event })))
    .sort((left, right) =>
      toMs(left.event.ts) - toMs(right.event.ts) || left.event.id.localeCompare(right.event.id)
    );
  let turns = 0;
  let previous: string | undefined;
  for (const item of ordered) {
    if (item.channel === previous) continue;
    turns += 1;
    previous = item.channel;
  }
  return turns;
}

function likelyEcho(mic: Span, system: Span): boolean {
  if (!overlaps(mic, system)) return false;
  const micText = normalizedTranscript(spanText(mic));
  const systemText = normalizedTranscript(spanText(system));
  const micLength = micText.replace(/\s/g, "").length;
  const systemLength = systemText.replace(/\s/g, "").length;
  const shortest = Math.min(micLength, systemLength);
  const longest = Math.max(micLength, systemLength);
  if (shortest < 8 || longest === 0 || shortest / longest < 0.65) return false;
  return audioTranscriptSimilarity(micText, systemText) >= 0.86;
}

function midpoint(span: Span): number {
  return span.startMs + (span.endMs - span.startMs) / 2;
}

function snippet(spansIn: Span[], n: number): string {
  const joined = spansIn
    .flatMap((s) => s.segments.map(segText))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return joined.length > n ? joined.slice(0, n) + "…" : joined;
}

/** Tail segments corroborate without inflating confidence past the band. */
function tailSignals(segments: RawEvent[], cap = 6): Signal[] {
  return segments
    .slice(1, 1 + cap)
    .map((e) => ({ id: e.id, p: P.moreSegments, tag: "more_segments" }));
}

export function audioActivity(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  const mic = spans(ctx.events, "mic");
  const system = spans(ctx.events, "system");
  const playback = ctx.events.filter(
    (e) => e.source === "audio" && e.type === "playback_state",
  );

  const pairedSystem = new Set<Span>();
  const iso = (ms: number) => new Date(ms).toISOString();
  const appOf = (s: Span) => s.segments[0]!.app;

  // Interleaved mic + system speech → a conversation with another party.
  for (const m of mic) {
    // System capture can contain a looped-back copy of the microphone. Treat
    // that as one playback span, not as two people in a meeting.
    if (system.some((s) => likelyEcho(m, s))) continue;
    const partner = system
      .filter((s) => !pairedSystem.has(s) && overlaps(m, s))
      .sort(
        (a, b) =>
          Math.abs(midpoint(a) - midpoint(m)) - Math.abs(midpoint(b) - midpoint(m)) ||
          a.startMs - b.startMs ||
          a.segments[0]!.id.localeCompare(b.segments[0]!.id),
      )[0];
    const isMeeting = partner !== undefined && (
      strongMeetingApp(m, partner) || alternatingTurnCount(m, partner) >= 3
    );
    if (partner && isMeeting) {
      pairedSystem.add(partner);
      const both = [m, partner];
      out.push(
        mkAction(ctx, {
          action: "attended_meeting",
          app: appOf(partner),
          startTs: iso(Math.min(m.startMs, partner.startMs)),
          endTs: iso(Math.max(m.endMs, partner.endMs)),
          text: snippet(both, 140),
          scored: score([
            { id: m.segments[0]!.id, p: P.micSpeech, tag: "mic_speech" },
            { id: partner.segments[0]!.id, p: P.systemSpeech, tag: "system_speech" },
            { id: m.segments[0]!.id, p: P.bothSidesTalking, tag: "both_sides" },
            ...tailSignals([...m.segments, ...partner.segments]),
          ]),
          payload: {
            micText: snippet([m], 400),
            systemText: snippet([partner], 400),
          },
          reconstructedBy: "audio.attendedMeeting",
        }),
      );
    } else {
      // The user talking with no system-side speech: dictation, a muted call,
      // or someone in the room — real signal, honest uncertainty.
      out.push(
        mkAction(ctx, {
          action: "spoke_aloud",
          app: appOf(m),
          startTs: iso(m.startMs),
          endTs: iso(m.endMs),
          text: snippet([m], 140),
          scored: score([
            { id: m.segments[0]!.id, p: P.micSpeech, tag: "mic_speech" },
            ...tailSignals(m.segments),
          ]),
          uncertainty: [
            "microphone speech with no system audio — could be dictation, a call with the remote side silent, or a conversation in the room",
          ],
          reconstructedBy: "audio.spokeAloud",
        }),
      );
    }
  }

  // System speech with nobody talking back → the user had audio playing.
  for (const s of system) {
    if (pairedSystem.has(s)) continue;
    const during = playback.filter((e) => {
      const ms = toMs(e.ts);
      return ms >= s.startMs - SPAN_GAP_MS && ms <= s.endMs + SPAN_GAP_MS;
    });
    out.push(
      mkAction(ctx, {
        action: "listened_audio",
        app: appOf(s),
        startTs: iso(s.startMs),
        endTs: iso(s.endMs),
        text: snippet([s], 140),
        scored: score([
          { id: s.segments[0]!.id, p: P.systemSpeech, tag: "system_speech" },
          ...tailSignals(s.segments),
          ...during
            .slice(0, 3)
            .map((e) => ({ id: e.id, p: P.playbackState, tag: "playback" })),
        ]),
        uncertainty: [
          "audio was playing on this machine — cannot confirm the user was actively listening",
        ],
        reconstructedBy: "audio.listenedAudio",
      }),
    );
  }

  return out;
}

export const audioRules = [audioActivity];
