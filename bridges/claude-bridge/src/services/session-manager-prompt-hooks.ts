import type {
  HookCallback,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import type { SessionState } from "../types/index.js";
import { recordClaudeToolDenied } from "./change-evidence.js";
import { commandChangeHooks } from "./command-changes.js";
import { eventEmitter } from "./event-emitter.js";
import {
  LIVE_BACKGROUND_TASK_STATUSES,
  emitBackgroundTaskSnapshot,
  recordBackgroundTaskLaunch,
  recordShellCommand,
  recordShellResult,
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
    // The latest turn's prompt may have settled while its CLI runs on; only
    // the process ending makes its hooks stale.
    !turn.runtime ||
    turn.runtime.state === "ended" ||
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
    // the SDK injects back into the root loop. Settling first would end the
    // released turn, and a later result with nothing owed would then publish
    // an idle edge before the CLI answers the notification. Wait for the
    // continuation exactly as the `task_notification` and
    // `background_tasks_changed` branches do — the edge that follows still
    // writes the authoritative terminal status over this one. A stop landing
    // while the result is still settling follows that result too, so it owes
    // the same continuation.
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

/**
 * Bash hooks that record what a shell task runs and how it ended.
 *
 * The CLI names neither on any task message, and a background subagent's tool
 * calls never reach this stream, so for a command such an agent runs these
 * hooks are the only witness. They fire for every agent's calls, record into
 * bounded state, and never change the call.
 */
export function shellTaskHooks(session: SessionState): {
  PreToolUse: HookCallbackMatcher;
  PostToolUse: HookCallbackMatcher;
  PostToolUseFailure: HookCallbackMatcher;
} {
  const live = () => sessions.get(session.id) === session && !session.deleting;
  const hook: HookCallback = async (input) => {
    if (!live() || !("tool_use_id" in input) || !input.tool_use_id) return {};
    if (input.hook_event_name === "PreToolUse") {
      const command = (input.tool_input as { command?: unknown } | undefined)?.command;
      if (typeof command === "string")
        await recordShellCommand(session, input.tool_use_id, command);
    } else if (input.hook_event_name === "PostToolUse") {
      const response = input.tool_response as
        | { stdout?: unknown; stderr?: unknown; backgroundTaskId?: unknown }
        | undefined;
      const output = [response?.stdout, response?.stderr]
        .filter((text): text is string => typeof text === "string" && text.trim().length > 0)
        .join("\n");
      await recordShellResult(session, input.tool_use_id, {
        output,
        backgrounded: typeof response?.backgroundTaskId === "string",
      });
    } else if (input.hook_event_name === "PostToolUseFailure") {
      await recordShellResult(session, input.tool_use_id, {
        failure: input.error,
        interrupted: input.is_interrupt === true,
      });
    }
    return {};
  };
  const matcher: HookCallbackMatcher = { matcher: "^Bash$", hooks: [hook] };
  return { PreToolUse: matcher, PostToolUse: matcher, PostToolUseFailure: matcher };
}

/**
 * Command-change hooks that report each measurement to the turn `route` names
 * and each observation under the session's change-evidence binding.
 */
export function commandChangeHookFor(
  route: (toolUseId: string) => ClaudeRuntimeTurn,
  conversationId: string,
) {
  return commandChangeHooks(
    (toolUseId, change) => route(toolUseId).applyCommandChanges(toolUseId, change),
    conversationId,
  );
}

/**
 * A PreToolUse hook whose denials are recorded as change evidence. The CLI
 * reports no `permission_denied` frame for a hook's refusal, and the error
 * `tool_result` that follows does not say the call never ran.
 */
export function recordingHookDenials(hook: HookCallback, conversationId: string): HookCallback {
  return async (input, toolUseId, options) => {
    const output = await hook(input, toolUseId, options);
    const decision = (output as { hookSpecificOutput?: { permissionDecision?: unknown } })
      .hookSpecificOutput?.permissionDecision;
    if (input.hook_event_name === "PreToolUse" && input.tool_use_id && decision === "deny") {
      recordClaudeToolDenied(conversationId, input.tool_use_id, {
        toolName: input.tool_name,
        input: input.tool_input,
      });
    }
    return output;
  };
}

/** Adapts a hook of this turn to the SDK's callback shape. */
export function turnHook(
  turn: TurnState,
  hook: (turn: TurnState, hookInput: HookInput) => Promise<HookJSONOutput>,
): HookCallback {
  return (hookInput) => hook(turn, hookInput);
}
