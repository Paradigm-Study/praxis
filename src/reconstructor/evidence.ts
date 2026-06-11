import type { EventSource, RawEvent } from "../core/types.ts";
import { toMs } from "../core/time.ts";

/**
 * Shared context handed to every rule. It carries the (time-sorted) events, a
 * parallel array of epoch-ms for fast windowing, an id factory, and an optional
 * blob reader so rules can resolve text that was offloaded to the blob store.
 */
export interface RuleContext {
  events: RawEvent[];
  ms: number[];
  newId: (prefix: string) => string;
  blob?: (hash: string) => string | undefined;
}

export function buildContext(
  events: RawEvent[],
  newId: (prefix: string) => string,
  blob?: (hash: string) => string | undefined,
): RuleContext {
  const sorted = [...events].sort((a, b) => toMs(a.ts) - toMs(b.ts));
  return { events: sorted, ms: sorted.map((e) => toMs(e.ts)), newId, blob };
}

export interface Pred {
  source?: EventSource;
  type?: string;
  app?: string;
  where?: (e: RawEvent) => boolean;
}

export function matches(e: RawEvent, p: Pred): boolean {
  if (p.source && e.source !== p.source) return false;
  if (p.type && e.type !== p.type) return false;
  if (p.app && e.app !== p.app) return false;
  if (p.where && !p.where(e)) return false;
  return true;
}

/** Nearest event before index `i` within `withinMs` matching `p`. */
export function before(
  ctx: RuleContext,
  i: number,
  withinMs: number,
  p: Pred,
): RawEvent | undefined {
  const t = ctx.ms[i]!;
  for (let j = i - 1; j >= 0; j--) {
    if (t - ctx.ms[j]! > withinMs) break;
    if (matches(ctx.events[j]!, p)) return ctx.events[j]!;
  }
  return undefined;
}

/** Nearest event after index `i` within `withinMs` matching `p`. */
export function after(
  ctx: RuleContext,
  i: number,
  withinMs: number,
  p: Pred,
): RawEvent | undefined {
  const t = ctx.ms[i]!;
  for (let j = i + 1; j < ctx.events.length; j++) {
    if (ctx.ms[j]! - t > withinMs) break;
    if (matches(ctx.events[j]!, p)) return ctx.events[j]!;
  }
  return undefined;
}

/** All events in the half-open window [startMs, endMs) matching `p`. */
export function inWindow(
  ctx: RuleContext,
  startMs: number,
  endMs: number,
  p: Pred = {},
): RawEvent[] {
  const out: RawEvent[] = [];
  for (let j = 0; j < ctx.events.length; j++) {
    const m = ctx.ms[j]!;
    if (m < startMs) continue;
    if (m >= endMs) break;
    if (matches(ctx.events[j]!, p)) out.push(ctx.events[j]!);
  }
  return out;
}

/** Human-meaningful text from an event: inline payload first, then blob. */
export function payloadText(ctx: RuleContext, e: RawEvent): string | undefined {
  const p = e.payload as Record<string, unknown>;
  for (const key of ["text", "value", "prompt", "message", "title", "cmd"]) {
    const v = p[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  if (ctx.blob) {
    for (const ref of e.blobRefs) {
      const t = ctx.blob(ref);
      if (t) return t;
    }
  }
  return undefined;
}
