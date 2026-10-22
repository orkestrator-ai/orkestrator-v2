import type {
  SDKAPIRetryMessage,
  SDKHookResponseMessage,
  SDKInformationalMessage,
  SDKMemoryRecallMessage,
  SDKMessage,
  SDKPermissionDeniedMessage,
  SDKStatusMessage,
  SDKThinkingTokensMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { NormalizedPart, SdkSystemMessage, SessionState } from "../../types/index.js";
import { sessionHealth, systemSubtypeDisposition } from "../../types/index.js";
import { recordClaudeToolDenied } from "../change-evidence.js";
import { commandChangeProbe } from "../command-changes.js";
import { eventEmitter } from "../event-emitter.js";
import { debugLog } from "../logger.js";
import { appendLocalCommandResult, recordCommandsChanged } from "../session-manager-commands.js";
import {
  boundedNoticeText,
  memoryRecallPart,
  refreshSettledToolRows,
} from "../session-manager-messages.js";
import {
  finishTurnInputIfSettled,
  ownsActiveTurn,
  reconcilePlanModeFromStatus,
  setTurnActivity,
} from "../session-manager-prompt-turn-lifecycle.js";
import type { TurnState } from "../session-manager-prompt-turn.js";
import { markTranscriptChanged } from "../transcript-revision.js";
import {
  handleBackgroundTasksChanged,
  handleTaskEdge,
  handleTaskNotification,
} from "./system-tasks.js";
import { appendTranscriptNotice, settlePendingApiRetry } from "./transcript-notice.js";

/**
 * How loudly to report one Claude system subtype.
 *
 * These are the SDK's own diagnostics, so they are recorded as `provider`
 * notices. The severity split is what decides whether the tab shows the notice
 * at all: `info` and `warning` stay in the health panel, while the backend
 * raises `error` in the tab as a persistent toast. Dedicated transcript rows,
 * such as API retry progress, remain independent of this health severity.
 */
const SYSTEM_MESSAGE_SEVERITIES: Record<string, "info" | "warning" | "error"> = {
  informational: "info",
  notification: "info",
  // Hook progress never reaches here (`ignored` in the disposition table). A
  // hook *response* only does when it failed, and is graded by its outcome
  // below, because a failed hook is the case this bridge cannot otherwise
  // notice.
  api_retry: "warning",
  model_refusal_fallback: "warning",
  model_refusal_no_fallback: "error",
  mirror_error: "error",
};

/**
 * Record a system subtype the dispatch above had no branch for.
 *
 * Only the subtype name and, where the SDK supplies a plain string, a bounded
 * message travel: the rest of an SDK system message can carry prompts, file
 * contents and tool output, and a notice reaches the renderer and the logs.
 */
function recordSystemMessageNotice(session: SessionState, message: SdkSystemMessage): void {
  const subtype = message.subtype ?? "unknown";
  if (subtype === "plugin_install") {
    // A failed install names its plugin and carries its own `error`, not the
    // `message` every other subtype uses; reading it generically recorded an
    // info notice with no detail.
    const install = message as { status?: unknown; name?: unknown; error?: unknown };
    if (install.status === "failed") {
      const name = typeof install.name === "string" && install.name ? install.name : undefined;
      sessionHealth(session).recordNotice({
        message: name
          ? `Claude plugin ${name} failed to install`
          : "A Claude plugin failed to install",
        method: "plugin/install",
        severity: "error",
        source: "provider",
        ...(typeof install.error === "string" && install.error ? { detail: install.error } : {}),
      });
      return;
    }
  }
  const outcome = (message as { outcome?: unknown }).outcome;
  const severity =
    subtype === "hook_response"
      ? // The hook this bridge registers observes plan writes. If it fails,
        // plan observation is broken and nothing else would report it.
        outcome === "error"
        ? "error"
        : "info"
      : (SYSTEM_MESSAGE_SEVERITIES[subtype] ?? "info");
  const detail = (message as { message?: unknown }).message;
  sessionHealth(session).recordNotice({
    message: `Claude reported ${subtype.replaceAll("_", " ")}`,
    method: `system/${subtype}`,
    severity,
    source: "provider",
    ...(typeof detail === "string" && detail.length > 0 ? { detail } : {}),
  });
}

/**
 * Minimum spacing between published thinking-token estimates.
 *
 * The SDK sends one frame per thinking delta — thousands in a long turn — and
 * every `session.updated` reaches each subscriber. A counter that ticks a few
 * times a second reads as live; one frame per delta is only load.
 */
export const THINKING_TOKENS_EMIT_INTERVAL_MS = 500;

/**
 * What one `system` subtype does before the shared tail below. Only `status`
 * returns a promise; `"stop"` skips the tail for a frame that says nothing
 * about this turn.
 */
type SystemSubtypeHandler = (turn: TurnState, message: SDKMessage) => void | "stop" | Promise<void>;

/** `commands_changed`: the CLI replaced its command inventory. */
function handleCommandsChanged(turn: TurnState, message: SDKMessage): void {
  const { session } = turn;
  // A full replacement (SDKCommandsChangedMessage). Applied to the
  // bridge-owned inventory whether or not anybody is subscribed.
  recordCommandsChanged(session, message);
}

/** `local_command_output`: a command the CLI answered itself. */
function handleLocalCommandOutput(turn: TurnState, message: SDKMessage): void {
  const { session } = turn;
  const sysMsg = message as SdkSystemMessage;
  // A command the CLI answered itself (SDKLocalCommandOutputMessage).
  // Without this row the turn settles with nothing visible.
  const output = (message as { content?: unknown }).content;
  if (typeof output === "string") {
    turn.localCommandOutputSeen = true;
    appendLocalCommandResult(
      session,
      output,
      typeof sysMsg.uuid === "string"
        ? sysMsg.uuid
        : `${turn.turnGeneration}:${turn.sdkMessageCount}`,
    );
  }
}

/** `thinking_tokens`: a running estimate during redacted thinking. */
function handleThinkingTokens(turn: TurnState, message: SDKMessage): void {
  const { session, sessionId } = turn;
  // A running estimate during the redacted-thinking phase, where the
  // API otherwise streams only pings. Arrives once per delta, so the
  // session keeps every value but publishes at most one per interval.
  const estimate = (message as SDKThinkingTokensMessage).estimated_tokens;
  if (
    ownsActiveTurn(turn) &&
    typeof estimate === "number" &&
    Number.isFinite(estimate) &&
    estimate >= 0
  ) {
    session.thinkingTokens = Math.round(estimate);
    const now = Date.now();
    if (now - turn.lastThinkingTokensEmitAt >= THINKING_TOKENS_EMIT_INTERVAL_MS) {
      turn.lastThinkingTokensEmitAt = now;
      eventEmitter.emit({
        type: "session.updated",
        sessionId,
        data: { thinkingTokens: session.thinkingTokens },
      });
    }
  }
}

/** `status`: what the CLI is doing, and whether compaction failed. */
async function handleStatus(turn: TurnState, message: SDKMessage): Promise<void> {
  const { session, sessionId } = turn;
  const status = message as SDKStatusMessage;
  setTurnActivity(turn, status.status === "compacting" ? "compacting" : undefined);
  // The compaction row is written by the PostCompact hook, which only
  // runs on success. A failed compaction left nothing in the tab while
  // the context stayed exactly as full as before.
  if (status.compact_result === "failed") {
    const reason = boundedNoticeText(status.compact_error);
    appendTranscriptNotice(session, sessionId, (event) => eventEmitter.emit(event), {
      type: "status",
      severity: "warning",
      content: reason ? `Compaction failed: ${reason}` : "Compaction failed",
      createdAt: new Date().toISOString(),
    });
  }
  await reconcilePlanModeFromStatus(turn, status.permissionMode);
}

/** `hook_response`: only a failed or cancelled hook is worth a notice. */
function handleHookResponse(turn: TurnState, message: SDKMessage): void {
  const { session } = turn;
  const sysMsg = message as SdkSystemMessage;
  // Most of these are this bridge's own compaction and background-task
  // hooks. Only a failed or cancelled hook says something is broken.
  if ((message as SDKHookResponseMessage).outcome !== "success") {
    recordSystemMessageNotice(session, sysMsg);
  }
}

/** `informational`: a CLI notice, shown when it would interrupt the user. */
function handleInformational(turn: TurnState, message: SDKMessage): void {
  const { session, sessionId } = turn;
  const sysMsg = message as SdkSystemMessage;
  const info = message as SDKInformationalMessage;
  const content = boundedNoticeText(info.content);
  // `info` renders only in the CLI's verbose transcript mode and
  // `notice` in inactive gray: inventory, not something to interrupt
  // the tab with. A stopped continuation is always shown, because the
  // turn ends on it and nothing else would say why.
  const visible =
    info.prevent_continuation === true || info.level === "warning" || info.level === "suggestion";
  if (content && visible) {
    const part: NormalizedPart = {
      type: "status",
      severity: info.prevent_continuation === true || info.level === "warning" ? "warning" : "info",
      content,
      createdAt: new Date().toISOString(),
    };
    // The SDK repeats a progress line for one tool use; keep one row.
    const existingId = info.tool_use_id
      ? turn.informationalRowsByToolUse.get(info.tool_use_id)
      : undefined;
    const existing = existingId
      ? session.messages.find((candidate) => candidate.id === existingId)
      : undefined;
    if (existing) {
      existing.content = part.content;
      existing.parts = [part];
      markTranscriptChanged(session);
      eventEmitter.emit({
        type: "message.updated",
        sessionId,
        data: { message: existing },
      });
    } else {
      const row = appendTranscriptNotice(
        session,
        sessionId,
        (event) => eventEmitter.emit(event),
        part,
      );
      if (info.tool_use_id) turn.informationalRowsByToolUse.set(info.tool_use_id, row.id);
    }
  } else {
    recordSystemMessageNotice(session, sysMsg);
  }
}

/** `permission_denied`: who refused a tool call, kept on the call. */
function handlePermissionDenied(turn: TurnState, message: SDKMessage): void {
  const { session, sessionId, stream } = turn;
  const { toolTracker } = stream;
  const denial = message as SDKPermissionDeniedMessage;
  // The tool result that follows carries the rejection the model read.
  // What only this frame says is *who* decided and why, so that is
  // what is kept on the call, where the renderer shows it.
  const reason = boundedNoticeText(denial.decision_reason ?? denial.message);
  // PreToolUse ran before the permission decision; no PostToolUse
  // will close the window it opened.
  if (typeof denial.tool_use_id === "string") {
    commandChangeProbe.discard(denial.tool_use_id);
    // It never ran: the proposal stays, and no applied effect is claimed.
    recordClaudeToolDenied(
      sessionId,
      denial.tool_use_id,
      typeof denial.tool_name === "string" ? { toolName: denial.tool_name } : {},
    );
  }
  const marked =
    typeof denial.tool_use_id === "string" &&
    toolTracker.recordDenial(denial.tool_use_id, {
      reason,
      ...(typeof denial.decision_reason_type === "string"
        ? { source: denial.decision_reason_type.slice(0, 64) }
        : {}),
    });
  if (marked) {
    const refreshed = stream.refreshToolRows([denial.tool_use_id]);
    refreshSettledToolRows(session, sessionId, toolTracker, [denial.tool_use_id], refreshed);
  } else {
    // A call this turn never saw (a subagent's, or one from before a
    // reconnect) still deserves to say it was refused.
    const toolName = boundedNoticeText(denial.tool_name) ?? "A tool call";
    appendTranscriptNotice(session, sessionId, (event) => eventEmitter.emit(event), {
      type: "status",
      severity: "warning",
      content: reason ? `${toolName} was denied: ${reason}` : `${toolName} was denied`,
      createdAt: new Date().toISOString(),
    });
  }
}

/** `memory_recall`: the memories the CLI loaded into context. */
function handleMemoryRecall(turn: TurnState, message: SDKMessage): void {
  const { session, sessionId } = turn;
  const recall = message as SDKMemoryRecallMessage;
  const memories = Array.isArray(recall.memories) ? recall.memories : [];
  if (memories.length > 0) {
    appendTranscriptNotice(
      session,
      sessionId,
      (event) => eventEmitter.emit(event),
      memoryRecallPart(recall.mode, memories),
    );
  }
}

const SYSTEM_SUBTYPE_HANDLERS: Record<string, SystemSubtypeHandler> = {
  commands_changed: handleCommandsChanged,
  local_command_output: handleLocalCommandOutput,
  task_started: handleTaskEdge,
  task_progress: handleTaskEdge,
  task_updated: handleTaskEdge,
  task_notification: handleTaskNotification,
  background_tasks_changed: handleBackgroundTasksChanged,
  thinking_tokens: handleThinkingTokens,
  status: handleStatus,
  hook_response: handleHookResponse,
  informational: handleInformational,
  permission_denied: handlePermissionDenied,
  memory_recall: handleMemoryRecall,
};

/** `system`, other than `init`: tasks, status, notices and the subtypes the disposition table keeps. */
export async function handleSystemMessage(turn: TurnState, message: SDKMessage): Promise<void> {
  const { session, sessionId, stream } = turn;
  // Handle other system messages (log for debugging)
  const sysMsg = message as SdkSystemMessage;
  debugLog("[session-manager] System message received", {
    sessionId,
    subtype: sysMsg.subtype,
  });

  const subtype = sysMsg.subtype;
  const outcome =
    typeof subtype === "string" && Object.hasOwn(SYSTEM_SUBTYPE_HANDLERS, subtype)
      ? SYSTEM_SUBTYPE_HANDLERS[subtype]!(turn, message)
      : undefined;
  if (outcome === "stop") return;
  if (outcome) await outcome;
  finishTurnInputIfSettled(turn);

  // System subtypes with no branch above are diagnostics, not transcript
  // content. They used to be re-emitted as an untyped `system.message`
  // frame carrying the whole SDK message — which nothing consumed, and
  // which put arbitrary provider payload on the wire. Record them as
  // runtime notices instead, where they are bounded, redacted, carry a
  // severity, and reach the health panel. Only errors are additionally
  // raised in the tab by the backend. Which subtypes are recorded at all
  // is `SYSTEM_SUBTYPE_DISPOSITIONS`, applied at the end of this branch.
  if (sysMsg.subtype === "api_retry") {
    // A retry the user can see, rather than a silent stall. Recorded as a
    // pending row and settled by the next assistant message or by the
    // turn's own outcome — a retry row that never settles is exactly the
    // stale card this replaces.
    const retry = sysMsg as unknown as SDKAPIRetryMessage;
    // A later retry proves the preceding attempt failed. Settle that row
    // before opening the next one so no superseded spinner can survive.
    settlePendingApiRetry(session, sessionId, (event) => eventEmitter.emit(event), stream, {
      state: "failure",
    });
    stream.pendingApiRetryMessageId = appendTranscriptNotice(
      session,
      sessionId,
      (event) => eventEmitter.emit(event),
      {
        type: "retry",
        content:
          typeof retry.error_status === "number"
            ? `The API answered ${retry.error_status}`
            : "The API request failed",
        toolState: "pending",
        ...(typeof retry.attempt === "number" ? { retryAttempt: retry.attempt } : {}),
        createdAt: new Date().toISOString(),
      },
    ).id;
  }
  const disposition = systemSubtypeDisposition(sysMsg.subtype);
  if (disposition === undefined) {
    // A subtype newer than the table: counted as drift, and still kept
    // as a notice so whatever it said is not lost.
    sessionHealth(session).recordUnknown(`system:${sysMsg.subtype ?? "(untyped)"}`);
    recordSystemMessageNotice(session, sysMsg);
  } else if (disposition === "notice" || disposition === "handled+notice") {
    recordSystemMessageNotice(session, sysMsg);
  }
}
