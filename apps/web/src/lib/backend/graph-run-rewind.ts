import type {
  GraphRunCodeRewindPreview,
  GraphRunCodeRewindRequest,
  GraphRunRestartRequest,
  GraphRunRestartResult,
} from "@orkestrator/protocol/graphs/run-rewind";
import { type AccountMachine } from "./agent-accounts";
import { graphsOn } from "@/lib/node-scope/domains/graphs";
import { commandBackendClient, type BackendClient } from "./client";

/**
 * Restart and code rewind of a graph run's activation (item 210), for the run
 * view's "Restart from here" and "Rewind code to here" (item 211). Every
 * call goes to the machine that owns the run (`machine`, as in
 * `machineInvoke`). Pass a `requestId` per user action so a retried call is a
 * no-op (`repeated: true`). A refused call rejects with the backend's message
 * and a `code`: `not-found`, `invalid-request`, `invalid-state`, `limit` or
 * `unavailable`. Calls go through the `graphs` domain client (`graphsOn`,
 * plan item 7007).
 */

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createGraphRunRewindApi(client: BackendClient) {
  /** Restarts the activation and everything that depended on it; a finished run reopens. */
  function restartGraphRunActivation(
    request: GraphRunRestartRequest,
    machine?: AccountMachine,
  ): Promise<GraphRunRestartResult> {
    return graphsOn(client, machine).graph_run_restart({ ...request });
  }

  /** What rewinding code to the activation would drop and rerun, and why it cannot now (`blocked`). */
  function previewGraphRunCodeRewind(
    request: Pick<GraphRunRestartRequest, "runId" | "activationKey">,
    machine?: AccountMachine,
  ): Promise<GraphRunCodeRewindPreview> {
    return graphsOn(client, machine).graph_run_rewind_code_preview({
      runId: request.runId,
      activationKey: request.activationKey,
    });
  }

  /**
   * Resets the worktree to the activation's input commit and restarts it.
   * `expectedHead` is the preview's `head`; a branch that moved since is refused.
   */
  function rewindGraphRunCode(
    request: GraphRunCodeRewindRequest,
    machine?: AccountMachine,
  ): Promise<GraphRunRestartResult> {
    return graphsOn(client, machine).graph_run_rewind_code({ ...request });
  }

  return { restartGraphRunActivation, previewGraphRunCodeRewind, rewindGraphRunCode };
}

export type GraphRunRewindApi = ReturnType<typeof createGraphRunRewindApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const { restartGraphRunActivation, previewGraphRunCodeRewind, rewindGraphRunCode } =
  createGraphRunRewindApi(commandBackendClient);
