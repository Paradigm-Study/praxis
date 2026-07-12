import type { ContextBundle, Observation } from "../core/types.ts";
import { newId as defaultNewId } from "../core/ids.ts";
import { nowIso } from "../core/time.ts";
import { renderBundle } from "./bundle.ts";
import { logger } from "../core/log.ts";
import { EgressAuditor } from "../privacy/egress.ts";
import { sha256 } from "../core/hash.ts";
import type { Observer, ObserveOptions } from "./observer.ts";

const log = logger("gemini");

/**
 * Gemini-backed observer — same contract as the AnthropicObserver: a bounded
 * bundle in, an evidence-linked Observation out. Exists for the cost question
 * (Flash-tier pricing is ~10x below Haiku) and for A/B-ing observer quality
 * across providers (`praxis ab`).
 *
 * Privacy note: enabling this sends bounded screen frames + transcripts to
 * Google rather than Anthropic. It is opt-in via PRAXIS_OBSERVER=gemini.
 */

/**
 * Structured output schema — JSON Schema subset, lowercase types (the 2026
 * `responseFormat` dialect; the old OpenAPI-style uppercase enum is legacy).
 */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", description: "What the user is trying to accomplish and why." },
    task: { type: "string" },
    decisionPoint: {
      type: "string",
      description:
        "A GENERALIZABLE decision rule the choice reveals, NOT a play-by-play of this session. Empty unless it generalizes.",
    },
    acceptedOptions: {
      type: "array",
      items: { type: "string" },
      description:
        "DURABLE approaches the user favors that would recur in other sessions. NOT one-off actions. Usually 0-2; empty is fine.",
    },
    rejectedOptions: {
      type: "array",
      items: { type: "string" },
      description:
        "DURABLE approaches the user reliably avoids (a real pattern). Usually 0-2; empty is fine — do NOT pad.",
    },
    inferredPreference: {
      type: "string",
      description:
        "A durable taste/preference about HOW they like to work that would hold across sessions. Empty unless evidenced.",
    },
    uncertainty: {
      type: "array",
      items: { type: "string" },
      description: "Where you are NOT confident you understood the user's intent or reasoning. Be honest.",
    },
    suggestedQuestion: {
      type: "string",
      description:
        "If (and only if) you're genuinely unsure WHY the user did something, a single specific question. Empty if you understood it.",
    },
    options: {
      type: "array",
      items: { type: "string" },
      description: "2-4 concrete, mutually-exclusive candidate answers to suggestedQuestion. Empty if no question.",
    },
    evidenceActionIndexes: {
      type: "array",
      items: { type: "integer" },
      description: "Indexes (0-based) into the actions list that justify this reading.",
    },
  },
  required: ["intent", "acceptedOptions", "rejectedOptions", "uncertainty"],
} as const;

const SYSTEM =
  "You observe a user's computer activity across ANY domain — coding, sales, " +
  "recruiting, research, design, ops. You get a high-fidelity, already-" +
  "reconstructed action list plus raw context (screen text, conversations, " +
  "audio transcripts). Infer what they're doing, the decisions they make and " +
  "the reasoning behind them, and durable preferences about HOW they work — " +
  "but treat the actions as the source of truth and cite the action indexes " +
  "that justify each reading. Crucially: be honest about what you DON'T " +
  "understand. If you can't tell why the user did something, say so in " +
  "`uncertainty` and ask one specific `suggestedQuestion`. Do not invent a " +
  "confident story over a real gap.";

export type FetchFn = typeof fetch;

export class GeminiObserver implements Observer {
  readonly remote = true;
  readonly model: string;
  readonly wantsImages: boolean;
  #apiKey: string;
  #fetch: FetchFn;
  #auditor: EgressAuditor;
  /** Set after the current `responseFormat` shape is rejected once — later
   * calls then go straight to the legacy fields instead of paying a 400. */
  #useLegacyShape = false;

  constructor(opts: {
    apiKey: string;
    model?: string;
    fetchFn?: FetchFn;
    auditor?: EgressAuditor;
    includeImages?: boolean;
  }) {
    this.#apiKey = opts.apiKey;
    this.model = opts.model ?? "gemini-3.5-flash";
    this.#fetch = opts.fetchFn ?? fetch;
    this.#auditor = opts.auditor ?? EgressAuditor.forStore();
    this.wantsImages = opts.includeImages ?? true;
  }

  async observe(bundle: ContextBundle, opts: ObserveOptions = {}): Promise<Observation> {
    const newId = opts.newId ?? defaultNewId;
    const userText =
      `${renderBundle(bundle)}\n\nactions (indexed):\n` +
      bundle.actions
        .map((a, i) => `  [${i}] ${a.action} (${a.confidence.toFixed(2)}) ${a.text ?? ""}`)
        .join("\n");

    // Same multimodal payload the Anthropic observer gets: recent frames as
    // inline images alongside the reconstructed-action text.
    const parts: unknown[] = (bundle.frameImages ?? []).slice(0, 4).map((img) => ({
      inlineData: { mimeType: img.mediaType, data: img.base64 },
    }));
    parts.push({ text: userText });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const call = async (generationConfig: Record<string, unknown>) => {
      const body = JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts }],
        generationConfig,
      });
      try {
        const response = await this.#fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.#apiKey,
        },
          body,
        });
        this.#auditor.record({
          destination: url,
          purpose: "remote_observer",
          categories: ["reconstructed_actions", "screen_ocr", ...(bundle.frameImages?.length ? ["screenshots"] : [])],
          bytes: Buffer.byteLength(body),
          digest: sha256(body),
          outcome: response.ok ? "succeeded" : "failed",
          status: response.status,
        });
        return response;
      } catch (error) {
        this.#auditor.record({
          destination: url,
          purpose: "remote_observer",
          categories: ["reconstructed_actions", "screen_context"],
          bytes: Buffer.byteLength(body),
          digest: sha256(body),
          outcome: "failed",
          error: String(error),
        });
        throw error;
      }
    };

    // Current (2026) structured-output shape; fall back to the legacy fields
    // if a model/endpoint rejects it — the serving API can lag the docs.
    const modern = {
      maxOutputTokens: 2048,
      responseFormat: {
        text: { mimeType: "application/json", schema: RESPONSE_SCHEMA },
      },
    };
    const legacy = {
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    };
    let res = await call(this.#useLegacyShape ? legacy : modern);
    if (res.status === 400 && !this.#useLegacyShape) {
      log.warn("responseFormat rejected — falling back to legacy responseSchema");
      this.#useLegacyShape = true;
      res = await call(legacy);
    }
    if (!res.ok) {
      throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    // Iterate parts defensively — with tools enabled the JSON text part may
    // not be first.
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(text) as Record<string, unknown>;
    } catch {
      log.warn("gemini returned non-JSON despite responseSchema", text.slice(0, 120));
    }
    log.debug("gemini observation", input);

    const idxs = (input.evidenceActionIndexes as number[] | undefined) ?? [];
    const evidence = idxs
      .map((i) => bundle.actions[i]?.id)
      .filter((id): id is string => !!id);

    return {
      id: newId("obs"),
      bundleId: bundle.id,
      episodeId: opts.episodeId,
      intent: str(input.intent),
      task: str(input.task),
      decisionPoint: str(input.decisionPoint),
      acceptedOptions: arr(input.acceptedOptions),
      rejectedOptions: arr(input.rejectedOptions),
      inferredPreference: str(input.inferredPreference),
      uncertainty: arr(input.uncertainty),
      suggestedQuestion: str(input.suggestedQuestion),
      options: arr(input.options),
      evidence: evidence.length ? evidence : bundle.actions.map((x) => x.id),
      model: this.model,
      createdTs: opts.now ?? nowIso(),
    };
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
