import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKUsageReport,
} from "@anthropic-ai/claude-agent-sdk";
import { isRootAssistantRecord, normalizeBackendModelId } from "@orkestrator/protocol/model-id";
import { claudePlanWindowFromKind } from "@orkestrator/protocol/plan-usage";
import type { SdkMessageBase, SessionState, SessionUsageSnapshot } from "../../types/index.js";
import { sessionHealth } from "../../types/index.js";
import {
  noteClaudeAuthenticationFailure,
  noteClaudeAuthenticationWorked,
} from "../claude-sign-in.js";
import { claudeEvidenceTurnId, claudeToolUses, recordClaudeToolUse } from "../change-evidence.js";
import { eventEmitter } from "../event-emitter.js";
import { noteSessionLoginRefused, setSessionAuthNotice } from "../session-auth-notice.js";
import { debugLog } from "../logger.js";
import {
  recordBackgroundTaskLaunch,
  registerBackgroundTaskCandidate,
} from "../session-manager-background-tasks.js";
import {
  bashToolUseIdsFromAssistantMessage,
  parseMessageContent,
  provisionalBackgroundTaskLaunchesFromAssistantMessage,
} from "../session-manager-messages.js";
import {
  clearThinkingTokens,
  reclaimReleasedTurnForAssistant,
} from "../session-manager-prompt-turn-lifecycle.js";
import type { TurnState } from "../session-manager-prompt-turn.js";
import { recordClaudeToolOwner } from "../session-manager-runtime.js";
import { settlePendingApiRetry } from "./transcript-notice.js";

export function applyClaudeUsageReport(
  session: SessionState,
  report: SDKUsageReport,
): SessionUsageSnapshot {
  const previous = session.inProgressUsage ?? session.usage;
  const limits = report.rate_limits?.limits?.flatMap((limit) => {
    const identity = claudePlanWindowFromKind(limit.kind, limit.scope?.model?.display_name);
    if (!Number.isFinite(limit.percent) || limit.percent < 0) return [];
    return [
      {
        label:
          identity?.label ??
          limit.scope?.model?.display_name ??
          limit.scope?.surface?.display_name ??
          limit.kind.replaceAll("_", " "),
        ...(identity ? { windowMinutes: identity.windowMinutes } : {}),
        usedPercent: Math.max(0, Math.min(100, limit.percent)),
        ...(limit.resets_at ? { resetsAt: limit.resets_at } : {}),
      },
    ];
  });
  if (limits) session.rateLimits = limits;

  const extra = report.rate_limits?.extra_usage;
  const remaining =
    extra?.monthly_limit != null && extra.used_credits != null
      ? Math.max(0, extra.monthly_limit - extra.used_credits)
      : undefined;
  const snapshot: SessionUsageSnapshot = {
    ...(previous ?? {
      usedTokens: 0,
      source: "claude" as const,
      updatedAt: new Date().toISOString(),
    }),
    costUsd: report.session.total_cost_usd,
    durationMs: report.session.total_duration_ms,
    apiDurationMs: report.session.total_api_duration_ms,
    linesAdded: report.session.total_lines_added,
    linesRemoved: report.session.total_lines_removed,
    ...(extra
      ? {
          credits: {
            hasCredits: extra.is_enabled,
            ...(remaining !== undefined
              ? { balance: `${(remaining / 100).toFixed(2)} ${extra.currency ?? "USD"}` }
              : {}),
          },
        }
      : {}),
    ...(limits ? { rateLimits: limits } : {}),
    updatedAt: new Date().toISOString(),
  };
  session.usage = snapshot;
  return snapshot;
}

/** Ids of the tool calls an assistant message makes. */
function toolUseIdsFromAssistantMessage(message: unknown): string[] {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const { type, id } = (block ?? {}) as { type?: unknown; id?: unknown };
    return (type === "tool_use" || type === "server_tool_use" || type === "mcp_tool_use") &&
      typeof id === "string" &&
      id
      ? [id]
      : [];
  });
}

/** `assistant`: one model response, root or subagent, written to the row it belongs to. */
export function handleAssistantMessage(turn: TurnState, message: SDKMessage): void {
  const { session, sessionId, stream } = turn;
  const { toolTracker, taskRegistry, activeTaskIds } = stream;
  // SDKUserMessage.timestamp is optional (older emitters omit it). Capture
  // one receive-time clock for a record that can carry transcript content, so
  // a terminal tool result still records where its card settled.
  const receivedAt = new Date().toISOString();
  const recordUnknownContentBlock = (blockType: string) =>
    sessionHealth(session).recordUnknown(`block:${blockType}`);
  // Claude answers a turn it cannot run with a synthetic reply carrying this
  // code ("Not logged in · Please run /login"). Re-read the account so a
  // missing login locks the composer; any real answer proves one works.
  const assistantError = (message as SDKAssistantMessage).error;
  if (assistantError === "authentication_failed") {
    noteClaudeAuthenticationFailure();
    noteSessionLoginRefused(
      session,
      sessionId,
      typeof (message as { uuid?: unknown }).uuid === "string"
        ? (message as { uuid: string }).uuid
        : crypto.randomUUID(),
    );
  } else if (!assistantError) {
    noteClaudeAuthenticationWorked();
    setSessionAuthNotice(session, sessionId, undefined);
  }
  const usageReport = (message as SDKAssistantMessage).usage_report;
  if (usageReport) {
    const usage = applyClaudeUsageReport(session, usageReport);
    eventEmitter.emit({
      type: "session.updated",
      sessionId,
      data: {
        contextUsage: usage,
        ...(session.rateLimits !== undefined ? { rateLimits: session.rateLimits } : {}),
      },
    });
  }
  // The thinking this estimate measured has produced its block.
  clearThinkingTokens(turn);
  // The retry above worked: the model answered. Settle the row rather
  // than leaving a spinner on a request that has already succeeded.
  settlePendingApiRetry(session, sessionId, (event) => eventEmitter.emit(event), stream, {
    state: "success",
  });
  reclaimReleasedTurnForAssistant(turn, message as SdkMessageBase);

  // If we receive a new assistant message after a plan denial, it means
  // the SDK continued the agent loop and Claude did see the feedback.
  // Clear the pending feedback so we don't re-prompt unnecessarily.
  if (stream.pendingPlanRejectionFeedback) {
    debugLog("[session-manager] Claude responded after plan denial, clearing re-prompt feedback", {
      sessionId,
    });
    stream.pendingPlanRejectionFeedback = null;
  }

  // Assistant message - parse content and register tools with tracker
  const { orderedParts, newTaskIds, contentBlockCount } = parseMessageContent(
    message,
    toolTracker,
    turn.mcpServerNames,
    activeTaskIds,
    taskRegistry,
    receivedAt,
    recordUnknownContentBlock,
  );

  // Each call this response makes starts its change-evidence lifecycle with
  // the proposal its input states. A subagent's calls name the call that
  // started the subagent.
  const evidenceParent = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  for (const use of claudeToolUses(message)) {
    recordClaudeToolUse(sessionId, {
      ...use,
      turnId: claudeEvidenceTurnId(turn),
      ...(typeof evidenceParent === "string" && evidenceParent
        ? { parentCallId: evidenceParent }
        : {}),
    });
  }

  // Frames a subagent sends name the call that started it. Remember that
  // this turn's row holds the call, so they reach it after a newer turn
  // has taken over the root conversation.
  if (turn.runtime && turn.thisTurn) {
    for (const toolUseId of toolUseIdsFromAssistantMessage(message)) {
      recordClaudeToolOwner(turn.runtime, toolUseId, turn.thisTurn);
    }
  }

  // A foreground Bash call can become background work after a timeout or
  // Ctrl+B. Keep that possibility hidden from the task snapshot, but
  // retain this query's control until the correlated provider result
  // tells us whether it actually happened.
  for (const toolUseId of bashToolUseIdsFromAssistantMessage(message)) {
    registerBackgroundTaskCandidate(session, toolUseId, turn.queryIteratorControl!);
  }

  // Establish liveness from the invocation itself. The provider can emit
  // the turn result before its Bash tool_result or task lifecycle frames;
  // waiting for either of those edges recreates the stdin-close race that
  // kills the just-launched process. The provisional id is replaced by
  // the provider task id as soon as either later edge supplies it.
  for (const launch of provisionalBackgroundTaskLaunchesFromAssistantMessage(message)) {
    recordBackgroundTaskLaunch(session, launch, turn.queryIteratorControl!);
  }

  // Update active Task tracking - add new Tasks
  for (const taskId of newTaskIds) {
    activeTaskIds.add(taskId);
  }

  // Each root model response is a row of its own; a subagent's output
  // joins the row holding the call that started it.
  const apiMessageId = (message as SDKAssistantMessage).message?.id;
  const parentToolUseId = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  const isRootAssistant = isRootAssistantRecord(
    parentToolUseId,
    (message as { isSidechain?: unknown }).isSidechain,
  );
  const sdkMessageUuid = (message as { uuid?: unknown }).uuid;
  const observedModel = (message as { message?: { model?: unknown } }).message?.model;
  const modelId = isRootAssistant ? normalizeBackendModelId(observedModel) : undefined;
  stream.applyAssistantRecord({
    ...(typeof apiMessageId === "string" ? { apiMessageId } : {}),
    ...(typeof sdkMessageUuid === "string" ? { uuid: sdkMessageUuid } : {}),
    ...(typeof parentToolUseId === "string" && parentToolUseId.length > 0
      ? { parentToolUseId }
      : {}),
    isRoot: isRootAssistant,
    orderedParts,
    contentBlockCount,
    ...(modelId ? { modelId } : {}),
    ...(receivedAt ? { receivedAt } : {}),
  });
}
