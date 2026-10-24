import type {
  SDKAuthStatusMessage,
  SDKMessage,
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { SdkMessageBase, SessionRateLimitWindow, SessionState } from "../../types/index.js";
import { sessionHealth } from "../../types/index.js";
import { eventEmitter } from "../event-emitter.js";
import { type RateLimitEventInfo, rateLimitsFromEventInfo } from "../session-manager-core.js";
import { markTranscriptChanged, resetTranscriptEpoch } from "../transcript-revision.js";
import type { TurnState } from "../session-manager-prompt-turn.js";
import type { PromptMessageHandler } from "./context.js";
import {
  publishStreamUsage,
  reclaimReleasedTurnForAssistant,
} from "../session-manager-prompt-turn-lifecycle.js";
import { appendTranscriptNotice } from "./transcript-notice.js";
import { setSessionAuthNotice } from "../session-auth-notice.js";

/** Notice wording per `conversation_reset.trigger`; an open set upstream. */
const CONVERSATION_RESET_CAUSES: Record<string, string> = {
  clear: "Conversation cleared with /clear.",
  plan_mode_exit: "Conversation cleared when the plan was approved.",
  fresh_session: "Started a fresh session to implement the approved plan.",
  onboarding: "Conversation restarted by onboarding.",
};

/** `prompt_suggestion`: the follow-up the CLI offers once a turn ends. */
function handlePromptSuggestion(turn: TurnState, message: SDKMessage): void {
  const { session, sessionId } = turn;
  const suggestion =
    typeof (message as { suggestion?: unknown }).suggestion === "string"
      ? (message as { suggestion: string }).suggestion.trim()
      : "";
  if (suggestion) {
    session.promptSuggestion = suggestion;
    eventEmitter.emit({
      type: "session.updated",
      sessionId,
      data: { promptSuggestion: suggestion },
    });
  }
}

/** `rate_limit_event`: plan-window utilization, merged by window label. */
function handleRateLimitEvent(turn: TurnState, message: SDKMessage): void {
  const { session, sessionId } = turn;
  const info = (message as { rate_limit_info?: RateLimitEventInfo }).rate_limit_info;
  if (info) {
    const nextWindows = rateLimitsFromEventInfo(info);
    const nextLabels = new Set(nextWindows.map((window) => window.label));
    // Held on the session, not inside `usage`. Rate-limit events arrive
    // mid-turn and `usage` only exists after the first `result`, so
    // gating on it discarded every window a first turn reported.
    const existing = session.rateLimits ?? session.usage?.rateLimits ?? [];
    const existingByLabel = new Map(existing.map((window) => [window.label, window]));
    session.rateLimits = [
      ...existing.filter((window: SessionRateLimitWindow) => !nextLabels.has(window.label)),
      ...nextWindows.map((window) => ({ ...existingByLabel.get(window.label), ...window })),
    ];
    if (session.usage) {
      session.usage = {
        ...session.usage,
        rateLimits: session.rateLimits,
        updatedAt: new Date().toISOString(),
      };
    }
    // Read through the declared session shape: this turn initializes the
    // field to undefined and later mutates it from a stream callback,
    // which TypeScript's local control-flow analysis cannot observe.
    const inProgressUsage = (session as SessionState).inProgressUsage;
    if (inProgressUsage) {
      session.inProgressUsage = {
        ...inProgressUsage,
        rateLimits: session.rateLimits,
        updatedAt: new Date().toISOString(),
      };
    }
    const contextUsage = session.inProgressUsage ?? session.usage;
    eventEmitter.emit({
      type: "session.updated",
      sessionId,
      data: {
        rateLimits: session.rateLimits,
        ...(contextUsage ? { contextUsage } : {}),
      },
    });
    // The notification is often only a threshold edge with no
    // utilization. Use it as a signal to fetch the complete `/usage`
    // snapshot, but never pause the SDK iterator while doing so.
    void turn.structuredUsageRefresh?.trigger();
  }
}

/** `auth_status`: sign-in state changing mid-session. */
function handleAuthStatus(turn: TurnState, message: SDKMessage): void {
  const { session, sessionId } = turn;
  const auth = message as SDKAuthStatusMessage;
  const content = auth.error
    ? `Claude authentication failed: ${auth.error}`
    : auth.isAuthenticating
      ? "Claude authentication is in progress."
      : "Claude authentication state changed.";
  sessionHealth(session).recordNotice({
    method: "auth_status",
    message: content,
    severity: auth.error ? "error" : "info",
    source: "provider",
  });
  appendTranscriptNotice(session, sessionId, (event) => eventEmitter.emit(event), {
    type: "status",
    content,
    severity: auth.error ? "error" : "info",
    createdAt: new Date().toISOString(),
  });
  // The row records what happened; the notice says what to do about it, and
  // goes away once Claude reports the authentication finished.
  const occurrenceId = typeof auth.uuid === "string" && auth.uuid ? auth.uuid : crypto.randomUUID();
  setSessionAuthNotice(
    session,
    sessionId,
    auth.error
      ? {
          state: "expired",
          message: `${content.slice(0, 300)}. Sign in to Claude again to keep working.`,
          occurrenceId,
        }
      : auth.isAuthenticating
        ? {
            state: "needs-auth",
            message: "Claude is signing in again. Finish any sign-in it opened to continue.",
            occurrenceId,
          }
        : undefined,
  );
}

/** `stream_event`: one streamed delta. Runs once per token, so it stays cheap. */
function handleStreamEvent(turn: TurnState, message: SDKMessage): void {
  // A resumed root turn can think for minutes before its first complete
  // assistant record, streaming only partials meanwhile. Waiting for that
  // record left the session idle — and the environment marked done —
  // while Claude was still working, so the first root partial reclaims.
  // Pings carry no content and are not evidence of a new model request.
  if ((message as { event?: { type?: unknown } }).event?.type !== "ping") {
    reclaimReleasedTurnForAssistant(turn, message as SdkMessageBase);
  }
  publishStreamUsage(turn, message);
  turn.stream.applyPartialAssistantMessage(message);
}

/** `tool_progress`: how long a running call has been going. */
function handleToolProgress(turn: TurnState, message: SDKMessage): void {
  const { session } = turn;
  // A live sub-line on the tool row it names, not a row of its own. It is
  // pushed into the assistant message holding the call so the backend's
  // projection can fold it onto that call — a progress part in its own
  // message would have nothing to attach to.
  const progress = message as SDKToolProgressMessage;
  const progressRow = progress.tool_use_id
    ? turn.stream.rowHoldingTool(progress.tool_use_id)
    : null;
  if (progressRow && progress.tool_use_id) {
    const elapsedMs =
      typeof progress.elapsed_time_seconds === "number"
        ? Math.max(0, Math.round(progress.elapsed_time_seconds * 1_000))
        : undefined;
    // Only the newest report per call survives: progress is a hint over
    // the authoritative tool state, so superseded lines are noise.
    const parts = progressRow.parts.filter(
      (candidate) => candidate.type !== "progress" || candidate.toolUseId !== progress.tool_use_id,
    );
    parts.push({
      type: "progress",
      // The subagent type is the only thing the SDK says about *what* is
      // taking the time; without it the line is just a clock.
      content: progress.subagent_type
        ? `${progress.subagent_type} running`
        : `${progress.tool_name ?? "Tool"} running`,
      toolUseId: progress.tool_use_id,
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      createdAt: new Date().toISOString(),
    });
    progressRow.parts = parts;
    markTranscriptChanged(session);
    turn.stream.publishRow(progressRow);
  }
}

/** `tool_use_summary`: a one-line summary of a completed tool call. */
function handleToolUseSummary(turn: TurnState, message: SDKMessage): void {
  const { session, sessionId } = turn;
  const summary = (message as SDKToolUseSummaryMessage).summary?.trim();
  if (summary) {
    appendTranscriptNotice(session, sessionId, (event) => eventEmitter.emit(event), {
      type: "status",
      content: summary,
      severity: "info",
      createdAt: new Date().toISOString(),
    });
  }
}

/** `conversation_reset`: the conversation the transcript describes is gone. */
function handleConversationReset(turn: TurnState, message: SDKMessage): void {
  const { session, sessionId } = turn;
  // The conversation this transcript describes no longer exists. Leaving
  // the old messages would show history the model has no memory of and
  // will not answer questions about.
  session.messages = [];
  resetTranscriptEpoch(session);
  // No bespoke "cleared" event: the backend re-reads the whole transcript
  // on every projection poll, so the authoritative snapshot already
  // reflects the clear. The status row below is what a live client needs.
  // `trigger` (Agent SDK 0.3.281+) only words the notice: every reset
  // clears, whatever it says, and an absent or unknown value is generic.
  const reset = message as { trigger?: unknown; timestamp?: unknown };
  const cause =
    typeof reset.trigger === "string" && Object.hasOwn(CONVERSATION_RESET_CAUSES, reset.trigger)
      ? CONVERSATION_RESET_CAUSES[reset.trigger]
      : undefined;
  appendTranscriptNotice(session, sessionId, (event) => eventEmitter.emit(event), {
    type: "status",
    content: `${cause ?? "Conversation cleared."} The agent no longer has the earlier history.`,
    severity: "warning",
    createdAt:
      typeof reset.timestamp === "string" && !Number.isNaN(Date.parse(reset.timestamp))
        ? new Date(reset.timestamp).toISOString()
        : new Date().toISOString(),
  });
}

/** Message types whose handling needs nothing beyond the frame and the turn. */
export const LEAF_MESSAGE_HANDLERS: Partial<Record<SDKMessage["type"], PromptMessageHandler>> = {
  prompt_suggestion: handlePromptSuggestion,
  rate_limit_event: handleRateLimitEvent,
  auth_status: handleAuthStatus,
  stream_event: handleStreamEvent,
  tool_progress: handleToolProgress,
  tool_use_summary: handleToolUseSummary,
  conversation_reset: handleConversationReset,
};

export function leafMessageHandler(type: unknown): PromptMessageHandler | undefined {
  return typeof type === "string" && Object.hasOwn(LEAF_MESSAGE_HANDLERS, type)
    ? LEAF_MESSAGE_HANDLERS[type as SDKMessage["type"]]
    : undefined;
}
