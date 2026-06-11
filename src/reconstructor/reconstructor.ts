import type { ActionEvent, RawEvent } from "../core/types.ts";
import type { Store } from "../storage/index.ts";
import type { EventRange } from "../storage/eventStore.ts";
import { newId as defaultNewId } from "../core/ids.ts";
import { toMs } from "../core/time.ts";
import { buildContext } from "./evidence.ts";
import type { Rule } from "./rule.ts";
import { navigationRules } from "./rules/navigation.ts";
import { conversationRules } from "./rules/conversation.ts";
import { fileRules } from "./rules/files.ts";
import { terminalRules } from "./rules/terminal.ts";
import { inputRules } from "./rules/input.ts";
import { audioRules } from "./rules/audio.ts";

/** The full deterministic rule set, in display order. */
export const ALL_RULES: Rule[] = [
  ...navigationRules,
  ...conversationRules,
  ...fileRules,
  ...terminalRules,
  ...inputRules,
  ...audioRules,
];

export interface ReconstructOptions {
  rules?: Rule[];
  newId?: (prefix: string) => string;
  blob?: (hash: string) => string | undefined;
}

/** Pure reconstruction over an event list — no storage involved. */
export function reconstructEvents(
  events: RawEvent[],
  opts: ReconstructOptions = {},
): ActionEvent[] {
  const rules = opts.rules ?? ALL_RULES;
  const ctx = buildContext(events, opts.newId ?? defaultNewId, opts.blob);
  const actions: ActionEvent[] = [];
  for (const rule of rules) {
    for (const a of rule(ctx)) actions.push(a);
  }
  actions.sort(
    (a, b) =>
      toMs(a.startTs) - toMs(b.startTs) ||
      toMs(a.endTs) - toMs(b.endTs) ||
      a.action.localeCompare(b.action),
  );
  return actions;
}

export interface ReconstructFromStore extends ReconstructOptions {
  range?: EventRange;
  persist?: boolean;
}

/**
 * Read raw events from the ledger, reconstruct actions, and (by default) write
 * them back. The blob reader is wired so rules can resolve text that the capture
 * pipeline offloaded to the blob store.
 */
export function reconstruct(
  store: Store,
  opts: ReconstructFromStore = {},
): ActionEvent[] {
  const events = store.events.range(opts.range);
  const actions = reconstructEvents(events, {
    rules: opts.rules,
    newId: opts.newId,
    blob: opts.blob ?? ((h) => store.blobs.getText(h)),
  });
  if (opts.persist !== false) store.actions.putMany(actions);
  return actions;
}
