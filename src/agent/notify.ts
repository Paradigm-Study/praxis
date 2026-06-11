import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../core/log.ts";

const log = logger("notify");

export type Notifier = (title: string, message: string) => void;

/**
 * Append questions to an NDJSON queue that the Praxis.app menu-bar app tails and
 * surfaces as native notifications. This is the RELIABLE path: notifications
 * posted by a background `osascript`/node process are silently dropped by macOS,
 * but the signed app (with its own notification permission) shows them.
 */
export function fileNotifier(path: string): Notifier {
  return (title, message) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), title, message }) + "\n");
    } catch (err) {
      log.debug("file notify failed", String(err));
    }
  };
}

/**
 * Post a native macOS notification. Used to proactively surface the agent's
 * questions ("I'm not sure I understood why you…") so it reaches you even when
 * the Studio isn't open. No-op off macOS.
 */
export const macNotify: Notifier = (title, message) => {
  if (process.platform !== "darwin") return;
  const esc = (s: string) => s.replace(/[\\"]/g, "\\$&").replace(/[\r\n]+/g, " ");
  execFile(
    "osascript",
    ["-e", `display notification "${esc(message)}" with title "${esc(title)}" sound name "Tink"`],
    (err) => {
      if (err) log.debug("notify failed", String(err));
    },
  );
};

/** A notifier that respects a cooldown — Praxis should only speak up when it matters. */
export function throttled(notify: Notifier, cooldownMs: number): Notifier {
  let last = 0;
  return (title, message) => {
    const now = Date.now();
    if (now - last < cooldownMs) return;
    last = now;
    notify(title, message);
  };
}

// ---------------------------------------------------------------------------
// Rich "ask" payload: a question + candidate answers the user can pick from
// (the menu-bar app renders option buttons + a free-text box).
// ---------------------------------------------------------------------------

export interface AskPayload {
  id: string;
  question: string;
  options: string[];
}
export type AskHandler = (ask: AskPayload) => void;

/** Append a question (with options) to the queue the menu-bar app tails. */
export function fileAsk(path: string): AskHandler {
  return (ask) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(
        path,
        JSON.stringify({
          ts: new Date().toISOString(),
          id: ask.id,
          message: ask.question,
          options: ask.options,
        }) + "\n",
      );
    } catch (err) {
      log.debug("file ask failed", String(err));
    }
  };
}

export function throttledAsk(handler: AskHandler, cooldownMs: number): AskHandler {
  let last = 0;
  const seen = new Set<string>();
  return (ask) => {
    if (seen.has(ask.id)) return; // never re-ask the same question
    const now = Date.now();
    if (now - last < cooldownMs) return;
    last = now;
    seen.add(ask.id);
    handler(ask);
  };
}
