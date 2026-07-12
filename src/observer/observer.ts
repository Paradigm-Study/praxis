import type { ContextBundle, Observation } from "../core/types.ts";
import { newId as defaultNewId } from "../core/ids.ts";
import { nowIso } from "../core/time.ts";
import { renderBundle } from "./bundle.ts";
import { GeminiObserver } from "./gemini.ts";
import { logger } from "../core/log.ts";
import type { Store } from "../storage/index.ts";
import { PrivacyControlStore } from "../privacy/control.ts";
import { EgressAuditor } from "../privacy/egress.ts";
import { sha256 } from "../core/hash.ts";

const log = logger("observer");

export interface ObserveOptions {
  episodeId?: string;
  newId?: (prefix: string) => string;
  now?: string;
}

/**
 * The observer turns a bounded bundle into an interpretation. Its output is
 * ALWAYS an {@link Observation} carrying `evidence` (action/event ids) — it is
 * never written back into the ledger as fact. Swap the implementation (mock vs.
 * model-backed) without changing any consumer.
 */
export interface Observer {
  readonly model: string;
  readonly remote?: boolean;
  /** True if this observer should be given base64 frame images in the bundle. */
  readonly wantsImages?: boolean;
  observe(bundle: ContextBundle, opts?: ObserveOptions): Promise<Observation>;
}

// ---------------------------------------------------------------------------
// Deterministic, offline observer — runs with zero dependencies and no API key.
// ---------------------------------------------------------------------------

export class MockObserver implements Observer {
  readonly model = "mock";

  async observe(bundle: ContextBundle, opts: ObserveOptions = {}): Promise<Observation> {
    const newId = opts.newId ?? defaultNewId;
    const a = bundle.actions;
    const find = (type: string) => a.find((x) => x.action === type);
    const corrected = find("corrected_agent");
    const committed = find("committed");
    const accepted = a.filter((x) => x.action === "accepted_suggestion");
    const uncertain = a.filter((x) => x.confidence < 0.6 && x.uncertainty?.length);

    const rejected = corrected?.payload?.rejects;
    const acceptedOptions = accepted.map((x) => `clicked "${x.text}"`);
    const rejectedOptions = [
      ...(typeof rejected === "string" && rejected ? [rejected] : []),
      ...a.filter((x) => x.action === "rejected_suggestion").map((x) => x.text ?? ""),
    ].filter(Boolean);

    const intent = corrected
      ? "Refine the approach toward evidence-backed action reconstruction, rejecting model-only inference."
      : committed
        ? `Ship a change: ${committed.text}`
        : "Iterate on the implementation.";

    const decisionPoint = corrected
      ? "The model should not be the source of truth for user actions."
      : undefined;

    const inferredPreference = corrected
      ? "Prefers high-fidelity evidence over model speculation."
      : accepted.length
        ? "Reviews AI edits before accepting them."
        : undefined;

    // The single most pressing clarification, framed as the doc's centerpiece.
    const focusAction = uncertain[0] ?? corrected ?? committed ?? a[a.length - 1];
    const suggestedQuestion = focusAction
      ? `I think you ${describe(focusAction)} because ${why(focusAction)}. Correct?`
      : undefined;
    const options = suggestedQuestion
      ? ["Yes, that's right", "Close, but not quite", "No — I was doing something else"]
      : [];

    const evidence = [
      ...(corrected ? [corrected.id] : []),
      ...(committed ? [committed.id] : []),
      ...accepted.map((x) => x.id),
      ...uncertain.map((x) => x.id),
    ];

    return {
      id: newId("obs"),
      bundleId: bundle.id,
      episodeId: opts.episodeId,
      intent,
      task: committed?.text ?? bundle.actions.find((x) => x.text)?.text,
      decisionPoint,
      acceptedOptions,
      rejectedOptions,
      inferredPreference,
      uncertainty: uncertain.map((x) => `${x.action}: ${x.uncertainty![0]}`),
      suggestedQuestion,
      options,
      evidence: evidence.length ? evidence : a.map((x) => x.id),
      model: this.model,
      createdTs: opts.now ?? nowIso(),
    };
  }
}

const VERB_PHRASE: Record<string, string> = {
  submitted_message: "sent a message",
  corrected_agent: "corrected the agent",
  committed: "committed",
  accepted_suggestion: "accepted a suggestion",
  rejected_suggestion: "rejected a suggestion",
  ran_command: "ran a command",
  saved_file: "saved a file",
  edited_file: "edited a file",
  inspected_failure: "inspected a failure",
  retried: "retried a command",
};

function describe(action: { action: string; text?: string }): string {
  const phrase = action.action.startsWith("possibly_reading")
    ? "were reading"
    : (VERB_PHRASE[action.action] ?? `did ${action.action.replace(/_/g, " ")}`);
  const t = action.text ? ` "${truncate(action.text, 60)}"` : "";
  return `${phrase}${t}`;
}

function why(action: { confidence: number; uncertainty?: string[] }): string {
  if (action.uncertainty?.length) return action.uncertainty[0]!;
  return `the evidence supports it at ${(action.confidence * 100).toFixed(0)}% confidence`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---------------------------------------------------------------------------
// Anthropic-backed observer — real API call, used only when a key is present.
// ---------------------------------------------------------------------------

const OBSERVE_TOOL = {
  name: "report_observation",
  description: "Report your interpretation of the user's recent activity.",
  input_schema: {
    type: "object",
    properties: {
      intent: { type: "string", description: "What the user is trying to accomplish and why." },
      task: { type: "string" },
      decisionPoint: { type: "string", description: "A GENERALIZABLE decision rule the choice reveals (e.g. 'reviews AI output before committing'), NOT a play-by-play of this session. Empty unless it generalizes." },
      acceptedOptions: { type: "array", items: { type: "string" }, description: "DURABLE approaches the user favors that would recur in other sessions. NOT one-off actions ('navigated to X', 'typed Y', 'gave name Z') — those are episode narration, not learnings. Usually 0-2; empty is fine." },
      rejectedOptions: { type: "array", items: { type: "string" }, description: "DURABLE approaches the user reliably avoids (a real pattern), NOT a single thing they happened not to do this time. Usually 0-2; empty is fine — do NOT pad." },
      inferredPreference: { type: "string", description: "A durable taste/preference about HOW they like to work that would hold across sessions. Empty unless you've seen real evidence it generalizes." },
      uncertainty: {
        type: "array",
        items: { type: "string" },
        description: "Where you are NOT confident you understood the user's intent or reasoning. Be honest — list real gaps.",
      },
      suggestedQuestion: {
        type: "string",
        description: "If (and only if) you're genuinely unsure WHY the user did something or what they're aiming for, a single specific question to ask them. Empty if you understood it.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "2-4 concrete, mutually-exclusive candidate answers to suggestedQuestion the user can pick from (the UI also offers a free-text box). Empty if no question.",
      },
      evidenceActionIndexes: {
        type: "array",
        items: { type: "integer" },
        description: "Indexes (0-based) into the actions list that justify this reading.",
      },
    },
    required: ["intent", "acceptedOptions", "rejectedOptions", "uncertainty"],
  },
} as const;

export class AnthropicObserver implements Observer {
  readonly remote = true;
  readonly model: string;
  readonly wantsImages: boolean;
  #apiKey: string;
  #auditor: EgressAuditor;

  constructor(opts: {
    apiKey: string;
    model?: string;
    auditor?: EgressAuditor;
    includeImages?: boolean;
  }) {
    this.#apiKey = opts.apiKey;
    this.model = opts.model ?? "claude-opus-4-8";
    this.#auditor = opts.auditor ?? EgressAuditor.forStore();
    this.wantsImages = opts.includeImages ?? true;
  }

  async observe(bundle: ContextBundle, opts: ObserveOptions = {}): Promise<Observation> {
    const newId = opts.newId ?? defaultNewId;
    const system =
      "You observe a user's computer activity across ANY domain — coding, sales, " +
      "recruiting, research, design, ops. You get a high-fidelity, already-" +
      "reconstructed action list plus raw context (screen text, conversations). " +
      "Infer what they're doing, the decisions they make and the reasoning behind " +
      "them, and durable preferences about HOW they work — but treat the actions " +
      "as the source of truth and cite the action indexes that justify each " +
      "reading. Crucially: be honest about what you DON'T understand. If you can't " +
      "tell why the user did something or what they're aiming for, say so in " +
      "`uncertainty` and ask one specific `suggestedQuestion`. Do not invent a " +
      "confident story over a real gap — a good clarifying question is more " +
      "valuable than a plausible guess.";
    const userText =
      `${renderBundle(bundle)}\n\nactions (indexed):\n` +
      bundle.actions
        .map((a, i) => `  [${i}] ${a.action} (${a.confidence.toFixed(2)}) ${a.text ?? ""}`)
        .join("\n");

    // Genuinely multimodal: attach the recent screen frames as image blocks
    // alongside the reconstructed-action text.
    const content: unknown[] = (bundle.frameImages ?? []).slice(0, 4).map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.base64 },
    }));
    content.push({ type: "text", text: userText });

    const requestBody = JSON.stringify({
      model: this.model,
      max_tokens: 1024,
      system,
      tools: [OBSERVE_TOOL],
      tool_choice: { type: "tool", name: OBSERVE_TOOL.name },
      messages: [{ role: "user", content }],
    });
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.#apiKey,
        "anthropic-version": "2023-06-01",
      },
        body: requestBody,
      });
    } catch (error) {
      this.#audit(requestBody, bundle, "failed", undefined, String(error));
      throw error;
    }
    if (!res.ok) {
      this.#audit(requestBody, bundle, "failed", res.status, res.statusText);
      throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    }
    this.#audit(requestBody, bundle, "succeeded", res.status);
    const data = (await res.json()) as {
      content: Array<{ type: string; input?: Record<string, unknown> }>;
    };
    const tool = data.content.find((c) => c.type === "tool_use");
    const input = (tool?.input ?? {}) as Record<string, unknown>;
    log.debug("anthropic observation", input);

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

  #audit(
    body: string,
    bundle: ContextBundle,
    outcome: "succeeded" | "failed",
    status?: number,
    error?: string,
  ): void {
    this.#auditor.record({
      destination: "https://api.anthropic.com",
      purpose: "remote_observer",
      categories: [
        "reconstructed_actions",
        "screen_ocr",
        "accessibility_text",
        "terminal_context",
        "audio_transcript",
        ...(bundle.frameImages?.length ? ["screenshots"] : []),
      ],
      bytes: Buffer.byteLength(body),
      digest: sha256(body),
      outcome,
      ...(status !== undefined ? { status } : {}),
      ...(error ? { error } : {}),
    });
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Pick the model-backed observer when an API key is present, else the mock.
 * Overrides: PRAXIS_OBSERVER=mock|anthropic|gemini forces a choice;
 * PRAXIS_OBSERVER_MODEL picks the model. Gemini is OPT-IN only — it sends the
 * bounded screen context to Google instead of Anthropic.
 */
export function defaultObserver(store?: Store): Observer {
  const apiKey =
    process.env.PRAXIS_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const pref = process.env.PRAXIS_OBSERVER;
  const privacy = store ? PrivacyControlStore.forStore(store).read() : undefined;
  const cloudAllowed = privacy?.cloudObserverConsent === true;
  const auditor = EgressAuditor.forStore(store);
  if ((pref === "anthropic" || pref === "gemini" || apiKey) && !cloudAllowed) {
    log.warn("remote observer available but privacy consent is off — using offline mock");
    auditor.record({
      destination: pref === "gemini" ? "https://generativelanguage.googleapis.com" : "https://api.anthropic.com",
      purpose: "remote_observer",
      categories: ["reconstructed_actions", "screen_context"],
      bytes: 0,
      outcome: "blocked",
      error: "cloudObserverConsent is false",
    });
    return new MockObserver();
  }
  if (pref === "gemini") {
    const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (geminiKey) {
      const model = process.env.PRAXIS_GEMINI_MODEL;
      log.info(`using Gemini observer${model ? ` (${model})` : ""}`);
      return new GeminiObserver({
        apiKey: geminiKey,
        ...(model ? { model } : {}),
        auditor,
        includeImages: privacy?.screenshotConsent === true,
      });
    }
    log.warn("PRAXIS_OBSERVER=gemini but no GEMINI_API_KEY found — falling through");
  }
  if (pref !== "mock" && apiKey) {
    const model = process.env.PRAXIS_OBSERVER_MODEL;
    log.info(`using Anthropic observer${model ? ` (${model})` : ""}`);
    return new AnthropicObserver({
      apiKey,
      ...(model ? { model } : {}),
      auditor,
      includeImages: privacy?.screenshotConsent === true,
    });
  }
  if (pref === "anthropic" && !apiKey) {
    log.warn("PRAXIS_OBSERVER=anthropic but no API key found — using mock");
  }
  log.info("using offline mock observer (set ANTHROPIC_API_KEY for model-backed)");
  return new MockObserver();
}
