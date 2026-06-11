import { createHash } from "node:crypto";
import { canonicalStringify } from "./json.ts";

/** sha256 of a string or buffer, hex-encoded. */
export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** sha256 of a value's canonical JSON form. */
export function hashObject(value: unknown): string {
  return sha256(canonicalStringify(value));
}

/**
 * Content hash for a raw event, computed over the fields that define its
 * identity (everything except the `id` and the `hash` itself).
 */
export function hashEventContent(input: {
  ts: string;
  source: string;
  app: string;
  window: string;
  type: string;
  payload: Record<string, unknown>;
  blobRefs: string[];
}): string {
  return hashObject(input);
}
