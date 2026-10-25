import { useState } from "react";
import type { AgentInteractionApplyOutcome } from "@orkestrator/protocol/agent-interactions";

export type PromptHoldHandler = (held: boolean) => Promise<AgentInteractionApplyOutcome>;

/**
 * Pause and resume for one blocking request's countdown.
 *
 * The pause lives where the deadline is enforced, so the request's published
 * `hold` is the truth; this only shows the state being asked for until the
 * call returns, and why it failed if it did. A request that went away
 * meanwhile (`stale`) is not an error: its card is about to disappear.
 */
export function usePromptHold(
  hold: { available: boolean; heldAt?: number } | undefined,
  onHold?: PromptHoldHandler,
) {
  const [requested, setRequested] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const serverHeld = hold?.heldAt !== undefined;
  const canToggle = hold?.available === true && onHold !== undefined;

  const toggle = async () => {
    if (!canToggle || requested !== null) return;
    const desired = !serverHeld;
    setRequested(desired);
    setError(null);
    try {
      const outcome = await onHold(desired);
      if (outcome.result === "rejected") {
        setError(
          desired ? "This countdown can't be paused right now." : "The countdown couldn't restart.",
        );
      } else if (outcome.result === "provider-unavailable") {
        setError("The agent is temporarily unavailable. It is safe to try again.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRequested(null);
    }
  };

  return {
    held: requested ?? serverHeld,
    pending: requested !== null,
    error,
    toggle: canToggle ? toggle : undefined,
  };
}
