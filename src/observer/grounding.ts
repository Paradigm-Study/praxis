import type { ActionEvent } from "../core/types.ts";

/**
 * Resolve model-provided action indexes without manufacturing grounding.
 * Missing, malformed, duplicate, fractional, negative, and out-of-range values
 * are ignored; an empty result deliberately stays empty.
 */
export function citedActionIds(value: unknown, actions: readonly ActionEvent[]): string[] {
  if (!Array.isArray(value)) return [];

  const evidence: string[] = [];
  const seen = new Set<string>();
  for (const index of value) {
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) continue;
    const id = actions[index]?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    evidence.push(id);
  }
  return evidence;
}
