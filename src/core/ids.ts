import { randomUUID } from "node:crypto";

/**
 * Generate a prefixed id, e.g. newId("event") -> "event_8f3c1a2b...".
 *
 * Ids are not used for ordering (timestamps are); they only need to be unique.
 * A deterministic counter-based generator is available for tests via
 * {@link makeSeededIdGen}.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

/**
 * Deterministic id generator for tests/demos so output is reproducible.
 * Returns a function with the same shape as {@link newId}.
 */
export function makeSeededIdGen(seed = 0): (prefix: string) => string {
  let counter = seed;
  const perPrefix = new Map<string, number>();
  return (prefix: string) => {
    const n = (perPrefix.get(prefix) ?? 0) + 1;
    perPrefix.set(prefix, n);
    counter += 1;
    return `${prefix}_${String(n).padStart(4, "0")}`;
  };
}
