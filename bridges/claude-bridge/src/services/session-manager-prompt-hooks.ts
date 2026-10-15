import type { HookCallback, HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import { commandChangeHooks } from "./command-changes.js";
import { eventEmitter } from "./event-emitter.js";
import {
  LIVE_BACKGROUND_TASK_STATUSES,
  emitBackgroundTaskSnapshot,
  recordBackgroundTaskLaunch,
  settleBackgroundTask,
} from "./session-manager-background-tasks.js";
import { sessions } from "./session-manager-core.js";
import { refreshSettledToolRows } from "./session-manager-messages.js";
import { appendTranscriptNotice } from "./session-manager-prompt-handlers/transcript-notice.js";
import {
  finishTurnInputIfSettled,
  waitForContinuationAfterNotification,
} from "./session-manager-prompt-turn-lifecycle.js";
import type { TurnState } from "./session-manager-prompt-turn.js";
import type { ClaudeRuntimeTurn } from "./session-manager-runtime.js";

// Hook callbacks run on the SDK's hook path, not on the JSONL message
// consumer. Keep them synchronous apart from the required Promise return:
// state is updated and the event is queued without delaying either stream.
export async function recordPreCompact(
  turn: TurnState,
  hookInput: HookInput,
): Promise<HookJSONOutput> {
  const { session } = turn;
  if (
    hookInput.hook_event_name !== "PreCompact" ||
    session.latestTurnGeneration !== turn.turnGeneration
  ) {
    return {};
  }
  turn.compactedTokensBefore = (session.inProgressUsage ?? session.usage)?.usedTokens;
  return {};
}

export async function recordPostCompact(
  turn: TurnState,
  hookInput: HookInput,
): Promise<HookJSONOutput> {
  const { session, sessionId } = turn;
  if (
    hookInput.hook_event_name !== "PostCompact" ||
    session.latestTurnGeneration !== turn.turnGeneration
  ) {
    return {};
  }
  // Publish only once PostCompact confirms success. PreCompact captures the
  // before-value, but an attempted compaction that fails must not leave a
  // durable boundary claiming the model's context changed.
  appendTranscriptNotice(session, sessionId, (event) => eventEmitter.emit(event), {
    type: "compaction",
    content: "",
    createdAt: new Date().toISOString(),
    ...(typeof turn.compactedTokensBefore === "number"
      ? { compactedTokensBefore: turn.compactedTokensBefore }
      : {}),
    tokenCountText: `${hookInput.trigger} compaction`,
  });
  eventEmitter.emit({
    type: "system.compact",
    sessionId,
    data: {
      preTokens: turn.compactedTokensBefore,
      trigger: hookInput.trigger,
    },
  });
  return {};
}

export async function recordBackgroundTaskHook(
  turn: TurnState,
  hookInput: HookInput,
): Promise<HookJSONOutput> {
  const { session, sessionId } = turn;
  if (
    // Not gated on the turn generation: the session's CLI keeps running
    // agents an earlier turn started after a follow-up takes the
    // foreground, and their lifecycle is recorded against the CLI's
    // control, exactly as its stream-side task messages are.
    sessions.get(sessionId) !== session ||
    session.deleting ||
    turn.abortController.signal.aborted ||
    turn.queryEnded ||
    !turn.queryIteratorControl ||
    (hookInput.hook_event_name !== "TaskCreated" &&
      hookInput.hook_event_name !== "TaskCompleted" &&
      hookInput.hook_event_name !== "SubagentStart" &&
      hookInput.hook_event_name !== "SubagentStop")
  ) {
    return {};
  }
  const hookTaskId =
    hookInput.hook_event_name === "TaskCreated" || hookInput.hook_event_name === "TaskCompleted"
      ? hookInput.task_id
      : hookInput.agent_id;
  const owner = session.backgroundTaskControls?.get(hookTaskId);
  if (owner && owner !== turn.queryIteratorControl) return {};
  if (
    hookInput.hook_event_name === "TaskCreated" ||
    hookInput.hook_event_name === "SubagentStart"
  ) {
    recordBackgroundTaskLaunch(
      session,
      hookInput.hook_event_name === "TaskCreated"
        ? {
            id: hookInput.task_id,
            description: hookInput.task_subject || hookInput.task_description,
          }
        : {
            id: hookInput.agent_id,
            description: hookInput.agent_type,
            subagentType: hookInput.agent_type || undefined,
          },
      turn.queryIteratorControl,
      // The hook fires as a run starts, so a terminal record under this id
      // belongs to an earlier run: a SendMessage resume, or a subagent
      // waking from a pause under the same tool-use id.
      { newRun: hookInput.hook_event_name === "SubagentStart" },
    );
  } else {
    const taskId =
      hookInput.hook_event_name === "TaskCompleted" ? hookInput.task_id : hookInput.agent_id;
    // A subagent's `agent_id` *is* the id its `task_notification` reports,
    // and this hook is delivered on the control channel — so for a
    // backgrounded subagent it normally arrives before the notification
    // the SDK injects back into the root loop. Settling first hands the
    // last reference to this query to `closeQueryControlIfUnused`, whose
    // `Query.close()` is destructive, and then closes held stdin: the CLI
    // dies in the gap, having written the notification to its rollout with
    // nothing left to answer it. Retain exactly as the `task_notification`
    // and `background_tasks_changed` branches do — the edge that follows
    // still writes the authoritative terminal status over this one. A stop
    // landing while the result is still settling follows that result too,
    // so it owes the same continuation.
    const settlesReleasedTurn =
      (turn.turnReleasedToBackgroundTasks || turn.settlingResult) &&
      session.backgroundTaskControls?.get(taskId) === turn.queryIteratorControl &&
      LIVE_BACKGROUND_TASK_STATUSES.has(session.backgroundTasks?.[taskId]?.status ?? "completed");
    if (settlesReleasedTurn) {
      turn.receivedResult = false;
      waitForContinuationAfterNotification(turn);
    }
    if (settleBackgroundTask(session, taskId, "completed")) {
      emitBackgroundTaskSnapshot(session);
    }
  }
  finishTurnInputIfSettled(turn);
  return {};
}

export function applyCommandChanges(
  turn: TurnState,
  toolUseId: string,
  change: MeasuredWorkspaceChange,
) {
  const { session, sessionId, stream } = turn;
  if (!stream.toolTracker.setCommandChanges(toolUseId, change)) {
    turn.pendingCommandChanges.set(toolUseId, change);
    return;
  }
  if (session.latestTurnGeneration !== turn.turnGeneration) return;
  const refreshed = stream.refreshToolRows([toolUseId]);
  refreshSettledToolRows(session, sessionId, stream.toolTracker, [toolUseId], refreshed);
}

/** Command-change hooks that report each measurement to the turn `route` names. */
export function commandChangeHookFor(route: (toolUseId: string) => ClaudeRuntimeTurn) {
  return commandChangeHooks((toolUseId, change) =>
    route(toolUseId).applyCommandChanges(toolUseId, change),
  );
}

/** Adapts a hook of this turn to the SDK's callback shape. */
export function turnHook(
  turn: TurnState,
  hook: (turn: TurnState, hookInput: HookInput) => Promise<HookJSONOutput>,
): HookCallback {
  return (hookInput) => hook(turn, hookInput);
}
