/** Helpers for mapping between JSON text columns and JS values. */
import type { StorageCipher } from "./crypto.ts";

export function toJson(value: unknown, cipher?: StorageCipher, context = "json"): string {
  const text = JSON.stringify(value ?? null);
  return cipher ? cipher.encryptText(text, context) : text;
}

export function fromJsonArray(text: unknown, cipher?: StorageCipher, context = "json"): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  try {
    const parsed = JSON.parse(cipher?.decryptText(text, context) ?? text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function fromJsonObject(
  text: unknown,
  cipher?: StorageCipher,
  context = "json",
): Record<string, unknown> | undefined {
  if (typeof text !== "string" || text.length === 0) return undefined;
  try {
    const parsed = JSON.parse(cipher?.decryptText(text, context) ?? text);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function strOrUndef(v: unknown, cipher?: StorageCipher, context = "text"): string | undefined {
  return typeof v === "string" ? (cipher?.decryptText(v, context) ?? v) : undefined;
}

export function sensitiveText(
  value: string | undefined | null,
  cipher: StorageCipher | undefined,
  context: string,
): string | null {
  if (value === undefined || value === null) return null;
  return cipher ? cipher.encryptText(value, context) : value;
}
