import type { Store } from "../../storage/index.ts";
import { retrieveForTask } from "../../agent/retrieveForTask.ts";
import { redactText } from "../../mesh/redact.ts";

/**
 * Proxy prompt injection: when PRAXIS_PROXY_INJECT=1, the AI proxy
 * (aiProxyServer.ts) asks this module for a context block ("what praxis
 * already knows that bears on this prompt") and splices it into the outgoing
 * request body before forwarding upstream.
 *
 * Privacy: the block may carry claim TEXTS only — never raw events, blobs, or
 * prior prompt/response bodies.
 */

const INJECTION_HEADER = "## How this user works (praxis)";

/** What aiProxyServer's extractPrompt produced from the request body. */
export interface ParsedPrompt {
  model?: string;
  prompt: string;
}

/** Provider request-body dialect, for shape-correct splicing. */
export type BodyShape = "anthropic" | "openai" | "unknown";

export interface InjectOptions {
  /** Requesting app (x-praxis-app header), for per-app policies. */
  app?: string;
  /** Hard cap on the injected block's size. */
  maxChars?: number;
}

/**
 * Render already-redacted context within a hard character budget. Claims are
 * removed as whole bullets, least-relevant last, so a tight budget never
 * exposes a misleading fragment of a claim. The fixed header/focus prefix is
 * the only portion that may be hard-truncated.
 */
export function formatInjectionBlock(
  claimTexts: string[],
  focusGoal: string | undefined,
  maxChars: number,
): string | null {
  if (Number.isNaN(maxChars) || maxChars <= 0) return null;
  const budget = Math.floor(maxChars);
  if (budget <= 0) return null;
  const focus = focusGoal?.trim();
  const bullets = claimTexts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text) => `- ${text}`);

  if (!focus && bullets.length === 0) return null;

  const prefix = [INJECTION_HEADER];
  if (focus) prefix.push(`Current focus: ${focus}`);

  const render = (): string => [...prefix, ...bullets].join("\n");
  let block = render();
  while (block.length > budget && bullets.length > 0) {
    bullets.pop();
    block = render();
  }

  return block.length > budget ? block.slice(0, budget) : block;
}

/** Use the newest meaningful prompt segment without losing short follow-ups. */
function retrievalQuery(prompt: string): string {
  const fullPrompt = prompt.trim();
  const segments = prompt.split("\n");
  let latest = "";
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i]!.trim();
    if (segment.length > 0) {
      latest = segment;
      break;
    }
  }
  return latest.length >= 8 ? latest : fullPrompt;
}

/**
 * Build the context block to inject, or null to inject nothing (the common
 * case: nothing relevant, flag off upstream, or budget exhausted).
 */
export function buildInjectionBlock(
  store: Store,
  parsedPrompt: ParsedPrompt,
  opts: InjectOptions = {},
): string | null {
  try {
    const claims = retrieveForTask(store, retrievalQuery(parsedPrompt.prompt), {
      cwd: process.cwd(),
      limit: 5,
    });
    const episode = store.episodes.latest(1)[0];
    const rawGoal = episode?.goal;
    const focusGoal = rawGoal?.trim() ? redactText(rawGoal) : undefined;
    const claimTexts = claims.map((claim) => redactText(claim.text));

    return formatInjectionBlock(claimTexts, focusGoal, opts.maxChars ?? 2000);
  } catch {
    // Injection is optional: any retrieval/redaction/storage failure must leave
    // the transparent proxy path intact.
    return null;
  }
}

/**
 * Return a COPY of `body` with `block` spliced in shape-appropriately
 * (anthropic: append to `system`; openai: prepend a system message;
 * unknown: unchanged). Never mutates the input.
 */
export function injectIntoBody(
  body: Record<string, unknown>,
  shape: BodyShape,
  block: string,
): Record<string, unknown> {
  const copy = structuredClone(body);

  if (shape === "anthropic") {
    if (typeof copy.system === "string") {
      copy.system = `${copy.system}\n\n${block}`;
    } else if (Array.isArray(copy.system)) {
      copy.system.push({ type: "text", text: block });
    } else {
      copy.system = block;
    }
    return copy;
  }

  if (shape === "openai") {
    if (!Array.isArray(copy.messages)) {
      copy.messages = [{ role: "system", content: block }];
      return copy;
    }

    const first = copy.messages[0];
    if (isRecord(first) && first.role === "system") {
      if (typeof first.content === "string") {
        first.content = `${first.content}\n\n${block}`;
      } else if (Array.isArray(first.content)) {
        first.content.push({ type: "text", text: block });
      } else {
        first.content = block;
      }
    } else {
      copy.messages.unshift({ role: "system", content: block });
    }
  }

  return copy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Classify a request body's provider dialect. Deterministic helper used by
 * the proxy call site; builders may refine internals but not the signature.
 */
export function detectBodyShape(body: Record<string, unknown>): BodyShape {
  const model = typeof body.model === "string" ? body.model : "";
  if (
    typeof body.system === "string" ||
    Array.isArray(body.system) ||
    model.startsWith("claude")
  ) return "anthropic";
  if (Array.isArray(body.messages)) return "openai";
  return "unknown";
}
