import type {
  GraphRunCodeRewindPreview,
  GraphRunCodeRewindRequest,
  GraphRunRestartRequest,
  GraphRunRestartResult,
} from "@orkestrator/protocol/graphs/run-rewind";
import { machineInvoke, type AccountMachine } from "./agent-accounts";

/**
 * Restart and code rewind of a graph run's activation (item 210), for the run
 * view's "Restart from here" and "Rewind code to here" (item 211). Every
 * call goes to the machine that owns the run (`machine`, as in
 * `machineInvoke`). Pass a `requestId` per user action so a retried call is a
 * no-op (`repeated: true`). A refused call rejects with the backend's message
 * and a `code`: `not-found`, `invalid-request`, `invalid-state`, `limit` or
 * `unavailable`.
 */

/** Restarts the activation and everything that depended on it; a finished run reopens. */
export function restartGraphRunActivation(
  request: GraphRunRestartRequest,
  machine?: AccountMachine,
): Promise<GraphRunRestartResult> {
  return machineInvoke(machine, "graph_run_restart", { ...request });
}

/** What rewinding code to the activation would drop and rerun, and why it cannot now (`blocked`). */
export function previewGraphRunCodeRewind(
  request: Pick<GraphRunRestartRequest, "runId" | "activationKey">,
  machine?: AccountMachine,
): Promise<GraphRunCodeRewindPreview> {
  return machineInvoke(machine, "graph_run_rewind_code_preview", {
    runId: request.runId,
    activationKey: request.activationKey,
  });
}

/**
 * Resets the worktree to the activation's input commit and restarts it.
 * `expectedHead` is the preview's `head`; a branch that moved since is refused.
 */
export function rewindGraphRunCode(
  request: GraphRunCodeRewindRequest,
  machine?: AccountMachine,
): Promise<GraphRunRestartResult> {
  return machineInvoke(machine, "graph_run_rewind_code", { ...request });
}
