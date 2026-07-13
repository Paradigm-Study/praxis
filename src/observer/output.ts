const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g;

/**
 * Treat provider output as untrusted input before it reaches observations,
 * questions, or long-term memory. Empty/whitespace-only values disappear and
 * every retained value has a small, deterministic storage/UI bound.
 */
export function observerText(value: unknown, maxChars = 1_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value
    .normalize("NFKC")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return undefined;
  return clean.slice(0, Math.max(1, Math.floor(maxChars)));
}

/** Bounded, non-empty, order-preserving, semantic de-duplication for lists. */
export function observerStrings(
  value: unknown,
  opts: { maxItems?: number; maxChars?: number } = {},
): string[] {
  if (!Array.isArray(value)) return [];
  const maxItems = Math.max(0, Math.floor(opts.maxItems ?? 8));
  if (maxItems === 0) return [];
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? 500));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const text = observerText(item, maxChars);
    if (!text) continue;
    const key = text.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}
