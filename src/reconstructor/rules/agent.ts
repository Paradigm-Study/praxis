import type { ActionEvent, RawEvent } from "../../core/types.ts";
import type { RuleContext } from "../evidence.ts";
import { after } from "../evidence.ts";
import { score, type Signal } from "../confidence.ts";
import { mkAction, type Rule } from "../rule.ts";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function str(e: RawEvent, key: string): string | undefined {
  const value = (e.payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function isAgentSessionEvent(e: RawEvent): boolean {
  return e.source === "ai_proxy" && str(e, "sessionKey") !== undefined;
}

function toolResultAfter(
  ctx: RuleContext,
  index: number,
  toolUseId: string | undefined,
): RawEvent | undefined {
  if (toolUseId === undefined) return undefined;
  return after(ctx, index, 120_000, {
    source: "ai_proxy",
    type: "ai_request",
    where: (candidate) =>
      isAgentSessionEvent(candidate) &&
      str(candidate, "role") === "tool_result" &&
      str(candidate, "toolUseId") === toolUseId,
  });
}

function toolSignals(toolUse: RawEvent, result: RawEvent | undefined): Signal[] {
  return [
    { id: toolUse.id, p: 0.9, tag: "agent_tool_use" },
    ...(result ? [{ id: result.id, p: 0.4, tag: "tool_result" }] : []),
  ];
}

/** Agent Edit/Write-family tool use => `edited_file`. */
export function agentEditedFile(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  ctx.events.forEach((e, index) => {
    if (!isAgentSessionEvent(e)) return;

    const tool = str(e, "tool");
    const filePath = str(e, "filePath");
    const sessionKey = str(e, "sessionKey")!;
    if (tool === undefined || !EDIT_TOOLS.has(tool) || filePath === undefined) {
      return;
    }

    const result = toolResultAfter(ctx, index, str(e, "toolUseId"));
    out.push(
      mkAction(ctx, {
        action: "edited_file",
        app: e.app,
        window: e.window,
        startTs: e.ts,
        endTs: result?.ts ?? e.ts,
        text: filePath,
        scored: score(toolSignals(e, result)),
        payload: { filePath, tool, cwd: str(e, "cwd"), sessionKey },
        reconstructedBy: "agent.agentEditedFile",
      }),
    );
  });
  return out;
}

/** Agent Bash tool use => `ran_command`. */
export function agentRanCommand(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  ctx.events.forEach((e, index) => {
    if (!isAgentSessionEvent(e) || str(e, "tool") !== "Bash") return;

    const command = str(e, "command");
    const sessionKey = str(e, "sessionKey")!;
    if (command === undefined) return;

    const result = toolResultAfter(ctx, index, str(e, "toolUseId"));
    out.push(
      mkAction(ctx, {
        action: "ran_command",
        app: e.app,
        window: e.window,
        startTs: e.ts,
        endTs: result?.ts ?? e.ts,
        text: command,
        scored: score(toolSignals(e, result)),
        payload: { cmd: command, cwd: str(e, "cwd"), sessionKey },
        reconstructedBy: "agent.agentRanCommand",
      }),
    );
  });
  return out;
}

/** The final plain assistant message after tool activity => task completion. */
export function agentCompletedTask(ctx: RuleContext): ActionEvent[] {
  const bySession = new Map<string, RawEvent[]>();
  for (const e of ctx.events) {
    if (!isAgentSessionEvent(e)) continue;
    const sessionKey = str(e, "sessionKey")!;
    const sessionEvents = bySession.get(sessionKey);
    if (sessionEvents) sessionEvents.push(e);
    else bySession.set(sessionKey, [e]);
  }

  const out: ActionEvent[] = [];
  for (const [sessionKey, sessionEvents] of bySession) {
    let finalIndex = -1;
    for (let i = sessionEvents.length - 1; i >= 0; i--) {
      const e = sessionEvents[i]!;
      if (
        e.type === "ai_response" &&
        str(e, "role") === "assistant" &&
        str(e, "textHash") !== undefined &&
        str(e, "tool") === undefined
      ) {
        finalIndex = i;
        break;
      }
    }
    if (finalIndex < 0) continue;

    let lastToolUse: RawEvent | undefined;
    for (let i = finalIndex - 1; i >= 0; i--) {
      const e = sessionEvents[i]!;
      if (str(e, "tool") !== undefined) {
        lastToolUse = e;
        break;
      }
    }
    if (!lastToolUse) continue;

    const finalEvent = sessionEvents[finalIndex]!;
    const textHash = str(finalEvent, "textHash")!;
    out.push(
      mkAction(ctx, {
        action: "received_response",
        app: finalEvent.app,
        window: finalEvent.window,
        startTs: finalEvent.ts,
        endTs: finalEvent.ts,
        text: str(finalEvent, "preview"),
        scored: score([
          { id: finalEvent.id, p: 0.7, tag: "final_assistant_text" },
          { id: lastToolUse.id, p: 0.4, tag: "prior_tool_activity" },
        ]),
        uncertainty: ["completion inferred from transcript tail"],
        payload: { sessionKey, cwd: str(finalEvent, "cwd"), textHash },
        reconstructedBy: "agent.agentCompletedTask",
      }),
    );
  }
  return out;
}

export const agentRules: Rule[] = [
  agentEditedFile,
  agentRanCommand,
  agentCompletedTask,
];
