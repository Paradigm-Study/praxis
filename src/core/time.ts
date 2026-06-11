/** ISO-8601 timestamp helpers used across the ledger. */

export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function toMs(iso: string): number {
  return Date.parse(iso);
}

/** Milliseconds between two ISO timestamps (b - a). */
export function gapMs(a: string, b: string): number {
  return toMs(b) - toMs(a);
}

/** Seconds between two ISO timestamps (b - a). */
export function gapSeconds(a: string, b: string): number {
  return gapMs(a, b) / 1000;
}

/** Add milliseconds to an ISO timestamp, returning a new ISO timestamp. */
export function addMs(iso: string, ms: number): string {
  return toIso(toMs(iso) + ms);
}
