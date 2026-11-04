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

/**
 * Why a queued prompt has no Steer action while a turn is running, shown on
 * its row so a message waiting for the next turn says why rather than just
 * sitting there. `undefined` when there is no running turn (nothing to steer
 * into) or the row can be steered.
 *
 * A row that steering refused keeps that refusal (`refusal`) until it leaves
 * the queue; it wins over the generic reasons because it is what actually
 * happened to this message.
 */
export function queuedSteerNote(input: {
  /** A turn is running: the queue's rows would otherwise be steerable. */
  running: boolean;
  /** The provider reports `actions.steer` for this session. */
  providerSteers: boolean;
  /** A dispatch or steer is parked awaiting recovery. */
  parked: boolean;
  /** The row passes the per-item checks (text only, not a command). */
  steerable: boolean;
  attachmentCount: number;
  command: boolean;
  /** What happened when this row was last steered, if it was refused. */
  refusal?: string;
  label: string;
}): string | undefined {
  if (!input.running) return undefined;
  if (input.refusal) return input.refusal;
  if (!input.providerSteers) {
    return `${input.label} cannot be steered here, so this is sent when the turn ends.`;
  }
  if (input.parked) {
    return "An earlier message is still being confirmed, so this is sent when the turn ends.";
  }
  if (input.steerable) return undefined;
  if (input.attachmentCount > 0) {
    return "Steering carries text only, so this is sent with its attachments when the turn ends.";
  }
  if (input.command) return "Commands run as their own turn, so this runs when the turn ends.";
  return undefined;
}

/**
 * The row note for a steer that left the message queued, or `undefined` when
 * the message was delivered or is owned by the recovery card. Pairs with
 * {@link autoSteerNotice}: the toast reports the moment, the row keeps the
 * reason for as long as the message waits.
 */
export function steerRefusalNote(
  outcome: NativeAgentSessionActionOutcome | null,
  label: string,
): string | undefined {
  if (outcome === null) return undefined;
  switch (outcome.outcome) {
    case "applied":
    case "unknown":
      return undefined;
    case "rejected":
      return `${nativeAgentSteerRejectionMessage(outcome)} Sent when the turn ends.`;
    case "mismatch":
      return "The turn moved on before this could be steered. Sent when the turn ends.";
    default:
      return `${label} finished the turn before this could be steered. Sent as the next turn.`;
  }
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
