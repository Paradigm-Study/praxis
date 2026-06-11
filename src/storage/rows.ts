/** Helpers for mapping between JSON text columns and JS values. */

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJsonArray(text: unknown): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function fromJsonObject(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== "string" || text.length === 0) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
