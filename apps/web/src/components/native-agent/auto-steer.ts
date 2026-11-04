import type { NativeAgentSessionActionOutcome } from "@orkestrator/protocol/native-agent";

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
 * Current queue blockers and historical steer refusals, shown on the row.
 * Recovery remains visible even after a turn ends; otherwise an idle or
 * steerable row without a refusal needs no note.
 *
 * A refusal is historical context, not a claim that another steer cannot run.
 * Current recovery requirements always take priority over that history.
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
  if (input.parked) {
    return "Waiting for the earlier message to be resolved. If prompted, use the recovery controls to retry or discard it.";
  }
  if (!input.running) return undefined;
  if (input.refusal) return input.refusal;
  if (!input.providerSteers) {
    return `${input.label} cannot be steered here, so this is sent when the turn ends.`;
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
      return `${queuedSteerRejectionReason(outcome.reason)} This message remains queued.`;
    case "mismatch":
      return "The last steer attempt missed the active turn. This message remains queued.";
    default:
      return `${label} finished the turn before the last steer attempt. This message remains queued.`;
  }
}

/** Queue guidance must never reuse direct-send instructions to resend. */
function queuedSteerRejectionReason(
  reason: Extract<NativeAgentSessionActionOutcome, { outcome: "rejected" }>["reason"],
): string {
  switch (reason) {
    case "steer-capacity-exceeded":
      return "The last steer attempt was refused because steering is full for this turn.";
    case "steer-history-unavailable":
      return "The last steer attempt was refused because steering history is unavailable.";
    case "steer-not-recorded":
      return "The last steer attempt could not be recorded.";
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
        message: `${queuedSteerRejectionReason(outcome.reason)} Your message remains queued.`,
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
