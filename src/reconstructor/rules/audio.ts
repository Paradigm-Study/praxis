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

function spans(events: RawEvent[], channel: string): Span[] {
  const segs = events
    .filter(
      (e) =>
        e.source === "audio" &&
        e.type === "transcript_segment" &&
        e.payload.channel === channel &&
        segText(e).trim().length > 0,
    )
    .sort((a, b) => toMs(a.ts) - toMs(b.ts));
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
    const partner = system.find((s) => !pairedSystem.has(s) && overlaps(m, s));
    if (partner) {
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
