import { recordClaudePermissionDecision } from "./change-evidence.js";
import { handleTurnMessage } from "./session-manager-prompt-handlers/dispatch.js";
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
export function createClaudeRuntimeTurn(turn: TurnState): ClaudeRuntimeTurn {
  return {
    handleMessage: (message) => handleTurnMessage(turn, message),
    pushSteerInput: (message) => pushSteerInput(turn, message),
    canUseTool: async (toolName, input, permissionContext) => {
      const decision = await turnCanUseTool(turn, toolName, input, permissionContext);
      // A refusal here has no `permission_denied` frame of its own.
      if (decision) {
        recordClaudePermissionDecision(
          turn.sessionId,
          permissionContext?.toolUseID,
          toolName,
          input,
          decision.behavior,
        );
      }
      return decision;
    },
    recordBackgroundTaskHook: turnHook(turn, recordBackgroundTaskHook),
    recordPreCompact: turnHook(turn, recordPreCompact),
    recordPostCompact: turnHook(turn, recordPostCompact),
    workflowResultTurn: () => turn.options?.workflowResultTurn,
    applyCommandChanges: (toolUseId, change) => applyCommandChanges(turn, toolUseId, change),
    supersede: () => {
      // The newer turn owns the root conversation, its continuations and the
      // input from here; this turn only draws the rows of tools it started.
      turn.superseded = true;
      stopWaitingForContinuation(turn);
      turn.resolveTurnEnded();
    },
    runtimeEnded: (failure) => {
      // An owed continuation dies with the process.
      stopWaitingForContinuation(turn);
      if (failure) turn.rejectTurnEnded(failure.error);
      else turn.resolveTurnEnded();
    },
    isAwaitingContinuation: () => turn.awaitingContinuation,
    inheritContinuation: () => {
      turn.inheritedContinuation = true;
    },
  };
}
