import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundTaskSnapshot } from "../../types/index.js";
import { sessionHealth } from "../../types/index.js";
import { claudeToolResultOutcomes, recordClaudeToolResult } from "../change-evidence.js";
import { commandChangeProbe } from "../command-changes.js";
import { eventEmitter } from "../event-emitter.js";
import {
  LIVE_BACKGROUND_TASK_STATUSES,
  emitBackgroundTaskSnapshot,
  recordBackgroundTaskLaunch,
  settleBackgroundTask,
  takeBackgroundTaskCandidate,
} from "../session-manager-background-tasks.js";
import {
  appendInterruptedNotice,
  appendSubagentInterruptedNotice,
  bashToolResultOutcomes,
  parseMessageContent,
  provisionalBackgroundTaskId,
  refreshSettledToolRows,
  taskNotificationNoticePart,
  toolResultIds,
} from "../session-manager-messages.js";
import { finishTurnInputIfSettled } from "../session-manager-prompt-turn-lifecycle.js";
import type { TurnState } from "../session-manager-prompt-turn.js";
import { appendTranscriptNotice } from "./transcript-notice.js";

/** `user`: tool results and task reports settling the calls they answer. */
export function handleUserMessage(turn: TurnState, message: SDKMessage): void {
  const { session, sessionId, stream } = turn;
  const { toolTracker, taskRegistry, activeTaskIds } = stream;
  // SDKUserMessage.timestamp is optional (older emitters omit it). Capture
  // one receive-time clock for a record that can carry transcript content, so
  // a terminal tool result still records where its card settled.
  const receivedAt = new Date().toISOString();
  const recordUnknownContentBlock = (blockType: string) =>
    sessionHealth(session).recordUnknown(`block:${blockType}`);
  // User message with tool results - parse to update tool tracker
  const {
    completedTaskIds,
    unattachedTaskNotifications,
    attachedTaskToolUseIds,
    interrupted,
    subagentInterrupted,
  } = parseMessageContent(
    message,
    toolTracker,
    turn.mcpServerNames,
    activeTaskIds,
    taskRegistry,
    receivedAt,
    recordUnknownContentBlock,
  );

  const sdkUserMessage = message as SDKUserMessage;
  for (const toolUseId of toolResultIds(sdkUserMessage)) {
    // A call whose PostToolUse already ran has closed its window, so this
    // only drops one no hook will close: a call refused by `canUseTool`,
    // or one cut off by an interrupt.
    commandChangeProbe.discard(toolUseId);
    const pending = turn.pendingCommandChanges.get(toolUseId);
    if (pending) {
      turn.pendingCommandChanges.delete(toolUseId);
      toolTracker.setCommandChanges(toolUseId, pending);
    }
  }
  for (const outcome of claudeToolResultOutcomes(sdkUserMessage)) {
    recordClaudeToolResult(outcome.callId, outcome.isError);
  }
  let settledProvisionalTask = false;
  for (const outcome of bashToolResultOutcomes(sdkUserMessage, toolTracker)) {
    if (outcome.launch) {
      recordBackgroundTaskLaunch(session, outcome.launch, turn.runtime);
      continue;
    }
    if (outcome.retainCandidate) continue;
    takeBackgroundTaskCandidate(session, outcome.toolUseId);
    const provisionalId = provisionalBackgroundTaskId(outcome.toolUseId);
    const provisional = session.backgroundTasks?.[provisionalId];
    if (outcome.failed && provisional && LIVE_BACKGROUND_TASK_STATUSES.has(provisional.status)) {
      settleBackgroundTask(
        session,
        provisionalId,
        "failed",
        "The Bash invocation failed before its background task was confirmed",
      );
      settledProvisionalTask = true;
    }
  }
  if (settledProvisionalTask) emitBackgroundTaskSnapshot(session);
  finishTurnInputIfSettled(turn);

  // Update active Task tracking - remove completed Tasks
  for (const taskId of completedTaskIds) {
    activeTaskIds.delete(taskId);
  }

  // Defensive fallback: if the user approved the plan this turn but the
  // SDK still reported the ExitPlanMode tool as a failure, rewrite the
  // tracked tool to "success" so the UI doesn't show a red failure for
  // something the user explicitly approved. Capture a continuation
  // re-prompt so Claude doesn't just abandon the turn. See the comment
  // on `TurnState.planApprovedThisTurn` for full context.
  if (turn.planApprovedThisTurn) {
    for (const tool of toolTracker.getTools()) {
      if (tool.toolName === "ExitPlanMode" && tool.toolState === "failure" && tool.toolUseId) {
        console.warn(
          "[session-manager] ExitPlanMode reported failure despite user approval — overriding to success and scheduling continuation re-prompt",
          { sessionId, toolUseId: tool.toolUseId, sdkError: tool.toolError },
        );
        toolTracker.updateToolResult(tool.toolUseId, {
          state: "success",
          output: "Plan approved by the user. Proceeding with implementation.",
          error: undefined,
        });
        if (!turn.pendingPlanApprovalContinuation) {
          turn.pendingPlanApprovalContinuation =
            "The user has approved your plan. Please proceed with implementing it now. You are no longer in plan mode and may write, edit, and run commands as needed.";
        }
      }
    }
  }

  // Rebuild the rows holding the calls these results settle. A result can
  // land on an earlier row of this turn: a subagent's tools render in the
  // row holding the call that started it, however many responses ago.
  const refreshed = stream.refreshToolRows([
    ...toolResultIds(sdkUserMessage),
    ...attachedTaskToolUseIds,
  ]);
  // A result can land on a call this turn no longer tracks: a task report
  // for an earlier turn's call, or a row past the tracking bound.
  refreshSettledToolRows(
    session,
    sessionId,
    toolTracker,
    [...toolResultIds(sdkUserMessage), ...attachedTaskToolUseIds],
    refreshed,
  );
  for (const report of unattachedTaskNotifications) {
    appendTranscriptNotice(
      session,
      sessionId,
      (event) => eventEmitter.emit(event),
      taskNotificationNoticePart(report, receivedAt ?? new Date().toISOString()),
    );
  }
  if (interrupted) appendInterruptedNotice(session, sessionId);
  else if (subagentInterrupted) {
    const parentToolUseId = sdkUserMessage.parent_tool_use_id;
    const stoppedTask = parentToolUseId
      ? (Object.values(session.backgroundTasks ?? {}) as BackgroundTaskSnapshot[]).find(
          (task) => task.toolUseId === parentToolUseId,
        )
      : undefined;
    appendSubagentInterruptedNotice(
      session,
      sessionId,
      stoppedTask?.description,
      parentToolUseId ?? undefined,
    );
  }
  // Skip adding user message replay as we already added it
}
