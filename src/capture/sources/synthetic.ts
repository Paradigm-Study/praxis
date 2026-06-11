import type { CaptureSource, EventSink, RawEventInput } from "../source.ts";
import type { RawEvent } from "../../core/types.ts";
import { addMs } from "../../core/time.ts";

/**
 * A scenario step is a raw-event input plus an optional delay from the previous
 * step. {@link buildScenario} turns a list of steps into events with concrete
 * timestamps, so demos and tests are fully deterministic.
 */
export interface ScenarioStep extends RawEventInput {
  /** Milliseconds after the previous step (default 1000). */
  afterMs?: number;
}

export function buildScenario(
  baseTs: string,
  steps: ScenarioStep[],
): RawEventInput[] {
  let ts = baseTs;
  const out: RawEventInput[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (i > 0) ts = addMs(ts, step.afterMs ?? 1000);
    const { afterMs: _omit, ...rest } = step;
    out.push({ ...rest, ts });
  }
  return out;
}

/** Replay a list of inputs through the sink. Optionally pace in real time. */
export async function replay(
  events: RawEventInput[],
  sink: EventSink,
  opts: { realtime?: boolean; speed?: number } = {},
): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  let prevMs: number | undefined;
  for (const ev of events) {
    if (opts.realtime && ev.ts) {
      const cur = Date.parse(ev.ts);
      if (prevMs !== undefined) {
        const wait = Math.max(0, (cur - prevMs) / (opts.speed ?? 1));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      prevMs = cur;
    }
    out.push(sink(ev));
  }
  return out;
}

/** A CaptureSource that replays a fixed scenario (for `capture --synthetic`). */
export class SyntheticSource implements CaptureSource {
  readonly name = "synthetic";
  readonly source = "synthetic" as const;
  #events: RawEventInput[];
  #opts: { realtime?: boolean; speed?: number };

  constructor(
    events: RawEventInput[],
    opts: { realtime?: boolean; speed?: number } = {},
  ) {
    this.#events = events;
    this.#opts = opts;
  }

  async start(sink: EventSink): Promise<void> {
    await replay(this.#events, sink, this.#opts);
  }

  stop(): void {
    /* nothing to tear down */
  }
}
