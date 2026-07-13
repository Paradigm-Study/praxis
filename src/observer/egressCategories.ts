import type { ContextBundle } from "../core/types.ts";

/**
 * Data classes included in the rendered observer request. Keep every remote
 * provider on this shared list so the local egress ledger cannot under-report
 * a provider merely because its request or failure path is implemented apart.
 */
export function observerEgressCategories(bundle: ContextBundle): string[] {
  return [
    "reconstructed_actions",
    "screen_ocr",
    "accessibility_text",
    "terminal_context",
    "filesystem_context",
    "audio_transcript",
    ...(bundle.frameImages?.length ? ["screenshots"] : []),
  ];
}
