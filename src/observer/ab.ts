import type { ContextBundle, Observation } from "../core/types.ts";
import type { Store } from "../storage/index.ts";
import type { Observer } from "./observer.ts";
import { buildBundle, renderBundle } from "./bundle.ts";
import { toMs, toIso } from "../core/time.ts";

/**
 * Observer A/B harness: run two observers on the SAME bounded bundles from the
 * user's real ledger and compare. Nothing is persisted — A/B observations must
 * not leak into the memory graph and double-count claims.
 *
 * The optional judge is a third model that sees the bundle text plus both
 * observations with their identities hidden and POSITIONS RANDOMIZED per round
 * (LLM judges have a measurable first-position bias).
 */

export interface AbRound {
  endTs: string;
  actionCount: number;
  a: Observation;
  b: Observation;
  aMs: number;
  bMs: number;
  /** Which observer the judge preferred, if judging was enabled. */
  verdict?: { winner: "a" | "b" | "tie"; reason: string };
}

export interface AbOptions {
  rounds?: number;
  /** Minutes to step back between rounds' windows. */
  stepMinutes?: number;
  judge?: (bundleText: string, first: Observation, second: Observation) => Promise<{
    winner: "first" | "second" | "tie";
    reason: string;
  }>;
  /** Injected for determinism in tests. */
  random?: () => number;
  onRound?: (r: AbRound, index: number) => void;
}

/**
 * Pick up to `rounds` recent windows that actually contain user actions, then
 * run both observers concurrently on each.
 */
export async function runAb(
  store: Store,
  a: Observer,
  b: Observer,
  opts: AbOptions = {},
): Promise<AbRound[]> {
  const rounds = opts.rounds ?? 3;
  const stepMs = (opts.stepMinutes ?? 15) * 60_000;
  const random = opts.random ?? Math.random;

  const all = store.events.range();
  if (!all.length) return [];
  let cursor = toMs(all[all.length - 1]!.ts);
  const out: AbRound[] = [];
  let attempts = 0;

  while (out.length < rounds && attempts < rounds * 6) {
    attempts++;
    const endTs = toIso(cursor);
    cursor -= stepMs;
    const bundle = buildBundle(store, { endTs, includeImages: true });
    if (bundle.actions.length < 3) continue; // nothing meaningful to observe

    const round = await runRound(bundle, a, b, endTs, opts, random);
    out.push(round);
    opts.onRound?.(round, out.length - 1);
  }
  return out;
}

async function runRound(
  bundle: ContextBundle,
  a: Observer,
  b: Observer,
  endTs: string,
  opts: AbOptions,
  random: () => number,
): Promise<AbRound> {
  const time = async (o: Observer) => {
    const t0 = Date.now();
    const obs = await o.observe(bundle);
    return { obs, ms: Date.now() - t0 };
  };
  const [ra, rb] = await Promise.all([time(a), time(b)]);

  const round: AbRound = {
    endTs,
    actionCount: bundle.actions.length,
    a: ra.obs,
    b: rb.obs,
    aMs: ra.ms,
    bMs: rb.ms,
  };

  if (opts.judge) {
    // Randomize presentation order so the judge can't develop a position habit.
    const aFirst = random() < 0.5;
    const [first, second] = aFirst ? [ra.obs, rb.obs] : [rb.obs, ra.obs];
    const v = await opts.judge(renderBundle(bundle), first, second);
    const winner =
      v.winner === "tie" ? "tie" : (v.winner === "first") === aFirst ? "a" : "b";
    round.verdict = { winner, reason: v.reason };
  }
  return round;
}

/** Rough per-call cost in USD from bundle shape — for the comparison table. */
export function estimateCost(
  bundle: { textChars: number; images: number },
  pricing: { inPerM: number; outPerM: number; imageTokens: number },
): number {
  const inputTokens = bundle.textChars / 4 + bundle.images * pricing.imageTokens;
  const outputTokens = 350; // typical structured observation
  return (inputTokens * pricing.inPerM + outputTokens * pricing.outPerM) / 1_000_000;
}

/** Make a Claude-backed blind judge (haiku by default — cheap and adequate). */
export function makeClaudeJudge(apiKey: string, model = "claude-haiku-4-5") {
  return async (
    bundleText: string,
    first: Observation,
    second: Observation,
  ): Promise<{ winner: "first" | "second" | "tie"; reason: string }> => {
    const show = (o: Observation) =>
      JSON.stringify(
        {
          intent: o.intent,
          decisionPoint: o.decisionPoint,
          inferredPreference: o.inferredPreference,
          uncertainty: o.uncertainty,
          suggestedQuestion: o.suggestedQuestion,
          options: o.options,
        },
        null,
        1,
      );
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        system:
          "You judge two anonymous observers that watched the same slice of a " +
          "user's computer activity. Score on: (1) does the reading match the " +
          "EVIDENCE (no invention)? (2) are inferred preferences durable rather " +
          "than one-off narration? (3) is the uncertainty honest and the " +
          "question specific and worth interrupting a human for? Output is " +
          "forced to the verdict tool.",
        tools: [
          {
            name: "verdict",
            description: "Your judgment.",
            input_schema: {
              type: "object",
              properties: {
                winner: { type: "string", enum: ["first", "second", "tie"] },
                reason: { type: "string", description: "One sentence." },
              },
              required: ["winner", "reason"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "verdict" },
        messages: [
          {
            role: "user",
            content:
              `# Observed context\n${bundleText.slice(0, 12_000)}\n\n` +
              `# Observation FIRST\n${show(first)}\n\n# Observation SECOND\n${show(second)}`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`judge API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      content: Array<{ type: string; input?: { winner?: string; reason?: string } }>;
    };
    const tool = data.content.find((c) => c.type === "tool_use");
    const winner = tool?.input?.winner;
    return {
      winner: winner === "first" || winner === "second" ? winner : "tie",
      reason: tool?.input?.reason ?? "",
    };
  };
}
