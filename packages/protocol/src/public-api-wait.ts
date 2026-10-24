/**
 * How an observer reads a receipt while it waits for an operation.
 *
 * The CLI's `--wait` and Control MCP's `run_status` poll `run.get` and stop
 * on the same evidence, so they share this classification: done when the
 * receipt is terminal, stopped early when waiting longer cannot change the
 * answer (a pending interaction, an unconfirmed dispatch, an unknown outcome,
 * or a provider whose completion cannot be observed), and pending otherwise.
 * Nothing here reads the clock or the network.
 */

import type { PublicErrorCode, PublicInteractionRef, PublicReceipt } from "./public-api.js";

export type PublicWaitVerdict =
  | { kind: "terminal"; succeeded: boolean }
  | { kind: "pending" }
  | {
      kind: "stopped";
      code: Extract<
        PublicErrorCode,
        "interaction-required" | "dispatch-unknown" | "run-unknown" | "capability-unavailable"
      >;
      message: string;
      retryable?: boolean;
      interactions?: PublicInteractionRef[];
    };

export interface PublicWaitOptions {
  /** Keep waiting while another client answers a pending interaction. */
  continueOnInteraction?: boolean;
}

export function isTerminalPublicReceipt(receipt: Pick<PublicReceipt, "state">): boolean {
  return !["admitted", "running", "unknown"].includes(receipt.state);
}

export function classifyReceiptForWait(
  receipt: PublicReceipt,
  options: PublicWaitOptions = {},
): PublicWaitVerdict {
  if (isTerminalPublicReceipt(receipt)) {
    return { kind: "terminal", succeeded: receipt.state === "succeeded" };
  }
  const execution = receipt.execution;
  if (execution?.state === "waiting-for-input" && !options.continueOnInteraction) {
    return {
      kind: "stopped",
      code: "interaction-required",
      message: "The run is waiting for an answer to a pending interaction",
      interactions: execution.interactions ?? [],
    };
  }
  if (receipt.state === "unknown" && receipt.dispatch?.state === "unknown") {
    return {
      kind: "stopped",
      code: "dispatch-unknown",
      message:
        "The provider may or may not have received the prompt; retry it under the same key or discard it",
      retryable: true,
    };
  }
  if (receipt.state === "unknown") {
    // The backend concluded it cannot prove the outcome; waiting longer would
    // not change that.
    return {
      kind: "stopped",
      code: "run-unknown",
      message: receipt.error?.message ?? "The outcome of this run is not known",
    };
  }
  if (execution?.state === "unsupported") {
    return {
      kind: "stopped",
      code: "capability-unavailable",
      message: execution.reason ?? "Completion of this run cannot be observed for its provider",
    };
  }
  return { kind: "pending" };
}

/** The error a terminal, unsuccessful receipt reports. */
export function terminalReceiptErrorCode(receipt: PublicReceipt): PublicErrorCode | null {
  if (receipt.state === "succeeded") return null;
  if (receipt.state === "partial") return "partial-failure";
  if (receipt.state === "cancelled") return "run-cancelled";
  if (receipt.state === "interrupted") return "run-interrupted";
  if (receipt.state === "unknown") return "run-unknown";
  return receipt.error?.code ?? "operation-failed";
}

/** The CLI's observation backoff: 250 ms doubling to at most 2 s. */
export function nextPublicWaitDelay(previousMs: number | undefined): number {
  return previousMs === undefined ? 250 : Math.min(previousMs * 2, 2_000);
}
