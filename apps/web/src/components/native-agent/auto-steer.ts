import {
  nativeAgentSteerRejectionMessage,
  type NativeAgentSessionActionOutcome,
} from "@orkestrator/protocol/native-agent";

/**
 * Auto-steer (Settings → General) sends a message typed while a turn is running
 * into that turn instead of leaving it queued for the next one.
 *
 * The message is always queued first and then steered from the queue, the same
 * path as the queue's own Steer button. The backend owns that transfer, so a
 * steer that is refused, or that loses the race with the end of the turn,
 * leaves the message in the queue rather than losing or duplicating it.
 */
export function shouldAutoSteer(input: {
  /** The user's Auto-steer setting. */
  enabled: boolean;
  /** A turn is running, nothing is parked, and the provider reports `actions.steer`. */
  steerAvailable: boolean;
  /** A slash or `$` command: it must be revalidated as a command at dequeue. */
  command: boolean;
  /** Launch and review prompts are sent by the app, not typed by the user. */
  preparedPrompt: boolean;
  /** Steering carries text only. */
  attachmentCount: number;
  /** A pending handoff's history belongs at the start of a turn, not inside one. */
  pendingHandoff: boolean;
}): boolean {
  return (
    input.enabled &&
    input.steerAvailable &&
    !input.command &&
    !input.preparedPrompt &&
    input.attachmentCount === 0 &&
    !input.pendingHandoff
  );
}

export type AutoSteerNotice = { tone: "success" | "info"; message: string } | null;

/**
 * What to tell the user after auto-steering a just-queued message. `null`
 * outcome means the message had already left the queue (the turn ended and the
 * queue sent it as the next one). An `unknown` outcome is owned by the
 * recovery card under the transcript, so it gets no toast of its own.
 */
export function autoSteerNotice(
  outcome: NativeAgentSessionActionOutcome | null,
  label: string,
): AutoSteerNotice {
  if (outcome === null) {
    return {
      tone: "info",
      message: `${label} finished the turn first, so your message was sent as the next turn.`,
    };
  }
  switch (outcome.outcome) {
    case "applied":
      return { tone: "success", message: `Steered the active ${label} turn` };
    case "unknown":
      return null;
    case "rejected":
      return {
        tone: "info",
        message: `${nativeAgentSteerRejectionMessage(outcome)} Your message was queued instead.`,
      };
    case "mismatch":
      return {
        tone: "info",
        message:
          "The turn moved on before the steering text was delivered. Your message was queued instead.",
      };
    default:
      return {
        tone: "info",
        message: `${label} finished the turn before it could be steered, so your message is queued.`,
      };
  }
}
