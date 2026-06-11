/**
 * Canonical JSON serialization for content hashing.
 *
 * Object keys are emitted in sorted order at every level so that two payloads
 * with the same content but different key ordering hash identically. This makes
 * the ledger's content-addressing stable and dedupe-friendly.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeysDeep(obj[key]);
    }
    return out;
  }
  return value;
}
