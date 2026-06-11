import type { ActionEvent, BoundaryReason } from "../core/types.ts";
import { toMs } from "../core/time.ts";

export interface BoundaryConfig {
  /** A pause longer than this ends an episode. Default 90s. */
  longGapMs: number;
  /** An app switch only cuts if the pause is at least this long. Default 30s. */
  appShiftGapMs: number;
}

export const DEFAULT_BOUNDARY: BoundaryConfig = {
  longGapMs: 90_000,
  appShiftGapMs: 30_000,
};

/**
 * Decide whether a boundary falls *between* two consecutive actions, and why.
 *
 * Episode boundaries are determined by the signals the design doc lists, but
 * they are weighed rather than applied blindly: an app switch mid-task (edit →
 * terminal → edit) does NOT split an episode, while a commit, a long pause, or
 * an app switch after a real gap does. This keeps a coherent edit/test/fix cycle
 * in one episode, matching the worked example.
 */
export function boundaryBetween(
  prev: ActionEvent,
  next: ActionEvent,
  cfg: BoundaryConfig = DEFAULT_BOUNDARY,
): BoundaryReason | undefined {
  // A commit closes a unit of work.
  if (prev.action === "committed") return "file_save_commit";

  const gap = toMs(next.startTs) - toMs(prev.endTs);
  if (gap >= cfg.longGapMs) return "long_dwell_gap";

  // Command/test cycle then a long pause = a natural seam.
  if (
    (prev.action === "ran_command" || prev.action === "inspected_failure") &&
    gap >= cfg.longGapMs
  ) {
    return "command_test_cycle";
  }

  // An app/window switch only seams the episode if it follows a real pause.
  if (prev.app !== next.app && gap >= cfg.appShiftGapMs) {
    return "app_window_shift";
  }

  return undefined;
}
