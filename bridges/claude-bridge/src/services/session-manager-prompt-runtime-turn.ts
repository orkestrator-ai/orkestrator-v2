import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { turnCanUseTool } from "./session-manager-prompt-can-use-tool.js";
import {
  applyCommandChanges,
  recordBackgroundTaskHook,
  recordPostCompact,
  recordPreCompact,
  turnHook,
} from "./session-manager-prompt-hooks.js";
import {
  pushSteerInput,
  stopWaitingForContinuation,
} from "./session-manager-prompt-turn-lifecycle.js";
import type { TurnState } from "./session-manager-prompt-turn.js";
import type { ClaudeRuntimeTurn } from "./session-manager-runtime.js";

/** This turn as its runtime sees it: the boundary the runtime calls into. */
export function createClaudeRuntimeTurn(
  turn: TurnState,
  handleMessage: (message: SDKMessage) => Promise<void>,
): ClaudeRuntimeTurn {
  return {
    handleMessage,
    pushSteerInput: (message) => pushSteerInput(turn, message),
    canUseTool: (toolName, input, permissionContext) =>
      turnCanUseTool(turn, toolName, input, permissionContext),
    recordBackgroundTaskHook: turnHook(turn, recordBackgroundTaskHook),
    recordPreCompact: turnHook(turn, recordPreCompact),
    recordPostCompact: turnHook(turn, recordPostCompact),
    applyCommandChanges: (toolUseId, change) => applyCommandChanges(turn, toolUseId, change),
    supersede: () => {
      // The newer turn owns the root conversation, its continuations and the
      // input from here; this turn only draws the rows of tools it started.
      turn.superseded = true;
      stopWaitingForContinuation(turn);
      turn.resolveTurnEnded();
    },
    runtimeEnded: (failure) => {
      if (failure) turn.rejectTurnEnded(failure.error);
      else turn.resolveTurnEnded();
    },
    isAwaitingContinuation: () => turn.retainedContinuationTimer !== null,
    inheritContinuation: () => {
      turn.inheritedContinuation = true;
    },
  };
}
