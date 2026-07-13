const CORRECTION_DIRECTIVE =
  /^(?:use|choose|keep|switch|replace|remove|add|change|leave|restore|run|make|prefer|avoid|always|never|require|do|don'?t|this|that)\b/i;

/**
 * Conservative natural-language gate for direct corrections.
 *
 * Marker words such as "actually", "instead", and "stop" are ordinary
 * language too. Treat them as corrections only in a corrective construction,
 * never merely because the word appears in a follow-up prompt.
 */
export function isExplicitCorrectionText(value: string): boolean {
  const text = value.replace(/\s+/g, " ").trim();
  if (/^(?:no|nope)\s*[,;:\-\u2014]\s*\S/i.test(text)) return true;
  const reframed = text.match(/^(?:actually|instead)\s*[,;:\-\u2014]\s*(.+)$/i)?.[1];
  if (reframed && CORRECTION_DIRECTIVE.test(reframed)) return true;
  return /^(?:that(?:'s| is) (?:wrong|incorrect)|this is (?:wrong|incorrect)|not quite\b|you misunderstood\b|i meant\b|i said\b|do not do that\b|don'?t do that\b|stop\s*[.!?]*$)/i.test(text);
}

/** Remove conversational correction markers before classifying memory scope. */
export function correctionDirective(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:no|nope|actually|instead)\s*[,;:\-\u2014]\s*/i, "")
    .trim();
}
