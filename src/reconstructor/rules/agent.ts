import type { ActionEvent, RawEvent } from "../../core/types.ts";
import type { RuleContext } from "../evidence.ts";
import { score, type Signal } from "../confidence.ts";
import { mkAction, type Rule } from "../rule.ts";
import { isExplicitCorrectionText } from "../correctionText.ts";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CORRECTION_MAX_GAP_MS = 5 * 60_000;

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
  sessionKey: string,
): RawEvent | undefined {
  if (toolUseId === undefined) return undefined;
  const startedAt = ctx.ms[index]!;
  for (let nextIndex = index + 1; nextIndex < ctx.events.length; nextIndex += 1) {
    if (ctx.ms[nextIndex]! - startedAt > 120_000) break;
    const candidate = ctx.events[nextIndex]!;
    if (!isAgentSessionEvent(candidate) || str(candidate, "sessionKey") !== sessionKey) {
      continue;
    }
    // A result can only complete a tool call in the same transcript turn. Do
    // not let a reused id in a later user turn retroactively validate it.
    if (candidate.type === "ai_request" && str(candidate, "role") === "user") {
      break;
    }
    if (
      candidate.type === "ai_request" &&
      str(candidate, "role") === "tool_result" &&
      str(candidate, "toolUseId") === toolUseId
    ) {
      return candidate;
    }
  }
  return undefined;
}

function isFailedToolResult(result: RawEvent): boolean {
  const payload = result.payload as Record<string, unknown>;
  return payload.is_error === true || payload.isError === true;
}

function toolSignals(toolUse: RawEvent, result: RawEvent): Signal[] {
  return [
    { id: toolUse.id, p: 0.9, tag: "agent_tool_use" },
    { id: result.id, p: 0.4, tag: "tool_result" },
  ];
}

/**
 * A Claude transcript's role:user record is direct structured evidence of a
 * submitted request. This preserves the user's actual task even when terminal
 * input/Accessibility events cannot be correlated with the Claude process.
 */
export function agentSubmittedPrompt(ctx: RuleContext): ActionEvent[] {
  const out: ActionEvent[] = [];
  ctx.events.forEach((event, index) => {
    if (
      !isAgentSessionEvent(event) ||
      event.type !== "ai_request" ||
      str(event, "role") !== "user"
    ) return;
    const preview = str(event, "preview");
    if (!preview) return;
    const sessionKey = str(event, "sessionKey")!;
    out.push(
      mkAction(ctx, {
        action: "submitted_message",
        app: event.app,
        window: event.window,
        startTs: event.ts,
        endTs: event.ts,
        text: preview,
        scored: score([{ id: event.id, p: 0.96, tag: "agent_user_prompt" }]),
        payload: {
          sessionKey,
          cwd: str(event, "cwd"),
          textHash: str(event, "textHash"),
          structuredAgentContext: true,
        },
        reconstructedBy: "agent.agentSubmittedPrompt",
      }),
    );

    // A corrective turn following assistant text is also explicit evidence of
    // a decision/rejected approach. Keep it alongside the submitted request so
    // the episode retains both the task and the correction.
    if (!isExplicitCorrectionText(preview)) return;
    let priorConversation: RawEvent | undefined;
    for (let priorIndex = index - 1; priorIndex >= 0; priorIndex -= 1) {
      const candidate = ctx.events[priorIndex]!;
      if (!isAgentSessionEvent(candidate) || str(candidate, "sessionKey") !== sessionKey) continue;
      if (str(candidate, "role") === "user") break;
      if (
        candidate.type === "ai_response" &&
        str(candidate, "role") === "assistant" &&
        str(candidate, "preview") !== undefined
      ) {
        priorConversation = candidate;
        break;
      }
    }
    if (!priorConversation) return;
    const gapMs = Date.parse(event.ts) - Date.parse(priorConversation.ts);
    if (!Number.isFinite(gapMs) || gapMs < 0 || gapMs > CORRECTION_MAX_GAP_MS) return;
    out.push(
      mkAction(ctx, {
        action: "corrected_agent",
        app: event.app,
        window: event.window,
        startTs: event.ts,
        endTs: event.ts,
        text: preview,
        scored: score([
          { id: event.id, p: 0.94, tag: "corrective_agent_prompt" },
          { id: priorConversation.id, p: 0.45, tag: "prior_agent_response" },
        ]),
        payload: {
          sessionKey,
          cwd: str(event, "cwd"),
          textHash: str(event, "textHash"),
          structuredAgentContext: true,
        },
        reconstructedBy: "agent.agentCorrectedPrompt",
      }),
    );
  });
  return out;
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

    const result = toolResultAfter(ctx, index, str(e, "toolUseId"), sessionKey);
    // A tool invocation is only an attempted edit. The matching successful
    // result is what proves bytes were changed; failed or missing results must
    // not enter durable activity/memory as `edited_file`.
    if (!result || isFailedToolResult(result)) return;
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

    const result = toolResultAfter(ctx, index, str(e, "toolUseId"), sessionKey);
    // A completed result is required so a same-id result in another session
    // cannot validate this call and so downstream summaries know the outcome.
    if (!result) return;
    const failed = isFailedToolResult(result);
    out.push(
      mkAction(ctx, {
        action: "ran_command",
        app: e.app,
        window: e.window,
        startTs: e.ts,
        endTs: result?.ts ?? e.ts,
        text: command,
        scored: score(toolSignals(e, result)),
        payload: {
          cmd: command,
          cwd: str(e, "cwd"),
          sessionKey,
          exitCode: failed ? 1 : 0,
          succeeded: !failed,
        },
        reconstructedBy: "agent.agentRanCommand",
      }),
    );
  });
  return out;
}

/** The final plain assistant message in each user turn after tool activity. */
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
    const userTurns = sessionEvents
      .map((event, index) => ({ event, index }))
      .filter(({ event }) =>
        event.type === "ai_request" && str(event, "role") === "user",
      );
    for (let turn = 0; turn < userTurns.length; turn += 1) {
      const startIndex = userTurns[turn]!.index;
      const endIndex = userTurns[turn + 1]?.index ?? sessionEvents.length;
      let finalIndex = -1;
      for (let i = endIndex - 1; i > startIndex; i -= 1) {
        const event = sessionEvents[i]!;
        if (
          event.type === "ai_response" &&
          str(event, "role") === "assistant" &&
          str(event, "textHash") !== undefined &&
          str(event, "tool") === undefined &&
          str(event, "stopReason") !== "tool_use"
        ) {
          finalIndex = i;
          break;
        }
      }
      if (finalIndex < 0) continue;

      let lastToolUse: RawEvent | undefined;
      for (let i = finalIndex - 1; i > startIndex; i -= 1) {
        const event = sessionEvents[i]!;
        if (str(event, "tool") !== undefined) {
          lastToolUse = event;
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
          uncertainty: ["completion inferred from transcript turn"],
          payload: { sessionKey, cwd: str(finalEvent, "cwd"), textHash },
          reconstructedBy: "agent.agentCompletedTask",
        }),
      );
    }
  }
  return out;
}

export const agentRules: Rule[] = [
  agentSubmittedPrompt,
  agentEditedFile,
  agentRanCommand,
  agentCompletedTask,
];
