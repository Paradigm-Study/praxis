import type { ActionEvent } from "../../core/types.ts";
import type { RuleContext } from "../evidence.ts";
import { before, payloadText } from "../evidence.ts";
import { P, score, type Signal } from "../confidence.ts";
import { mkAction } from "../rule.ts";

const FILE_TITLE = /\.[a-z0-9]{1,5}$|\//i;

function str(e: { payload: Record<string, unknown> }, key: string): string | undefined {
  const v = e.payload[key];
  return typeof v === "string" ? v : undefined;
}

/** filesystem `file_changed` (with a diff) => `edited_file`. */
export function editedFile(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  ctx.events.forEach((e) => {
    if (e.source !== "filesystem" || e.type !== "file_changed") return;
    const hasDiff = e.blobRefs.length > 0;
    const signals: Signal[] = [{ id: e.id, p: P.fileChanged, tag: "file_changed" }];
    if (hasDiff) signals.push({ id: e.id, p: P.fileDiff, tag: "diff" });
    out.push(
      mkAction(ctx, {
        action: "edited_file",
        app: e.app,
        window: e.window,
        startTs: e.ts,
        endTs: e.ts,
        text: str(e, "path"),
        scored: score(signals),
        payload: {
          path: str(e, "path"),
          workspaceRoot: str(e, "workspaceRoot"),
          hashAfter: str(e, "hashAfter"),
        },
        reconstructedBy: "editedFile",
      }),
    );
  });
  return out;
}

/** filesystem `file_saved`, corroborated by a nearby Cmd+S => `saved_file`. */
export function savedFile(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  ctx.events.forEach((e, i) => {
    if (e.source !== "filesystem" || e.type !== "file_saved") return;
    const cmdS = before(ctx, i, 3000, {
      source: "input_events",
      type: "key_down",
      where: (ev) => {
        const p = ev.payload as Record<string, unknown>;
        return p.key === "s" && (p.mods as string[] | undefined)?.includes("cmd") === true;
      },
    });
    const signals: Signal[] = [{ id: e.id, p: P.fileSaved, tag: "file_saved" }];
    if (cmdS) signals.push({ id: cmdS.id, p: P.cmdSaveKey, tag: "cmd_s" });
    out.push(
      mkAction(ctx, {
        action: "saved_file",
        app: e.app,
        window: e.window,
        startTs: (cmdS ?? e).ts,
        endTs: e.ts,
        text: str(e, "path"),
        scored: score(signals),
        payload: { path: str(e, "path") },
        reconstructedBy: "savedFile",
      }),
    );
  });
  return out;
}

/** filesystem `file_opened` or an editor AX snapshot of a file => `opened_file`. */
export function openedFile(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  ctx.events.forEach((e) => {
    let path: string | undefined;
    let signal: Signal | undefined;
    if (e.source === "filesystem" && e.type === "file_opened") {
      path = str(e, "path");
      signal = { id: e.id, p: P.fileChanged, tag: "file_opened" };
    } else if (
      e.source === "accessibility" &&
      e.type === "ui_snapshot" &&
      str(e, "focusedRole") === "editor"
    ) {
      const title = str(e, "title");
      if (title && FILE_TITLE.test(title)) {
        path = title;
        signal = { id: e.id, p: P.uiSnapshotFile, tag: "ui_snapshot" };
      }
    }
    if (!path || !signal) return;
    out.push(
      mkAction(ctx, {
        action: "opened_file",
        app: e.app,
        window: e.window,
        startTs: e.ts,
        endTs: e.ts,
        text: path,
        scored: score([signal]),
        payload: { path },
        reconstructedBy: "openedFile",
      }),
    );
  });
  return out;
}

/** git `commit` => `committed`. */
export function committed(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  ctx.events.forEach((e) => {
    if (e.source !== "git" || e.type !== "commit") return;
    out.push(
      mkAction(ctx, {
        action: "committed",
        app: e.app,
        window: e.window,
        startTs: e.ts,
        endTs: e.ts,
        text: str(e, "message") ?? payloadText(ctx, e),
        scored: score([{ id: e.id, p: P.gitCommit, tag: "git_commit" }]),
        payload: {
          sha: str(e, "sha"),
          files: e.payload.files,
          branch: str(e, "branch"),
        },
        reconstructedBy: "committed",
      }),
    );
  });
  return out;
}

export const fileRules = [editedFile, savedFile, openedFile, committed];
