import type { AgentMailMessage } from "@orkestrator/protocol/agent-mail";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import type { CommandContext } from "./commands-context.js";

/**
 * What a coordinator's `deliverNow` did, as its `send_message` result says it.
 *
 * - `steered`: the message landed in the worker's running turn.
 * - `delivered`: the worker was idle, so it went out as a new turn.
 * - `queued until idle`: the worker was busy and the steer did not happen
 *   (refused, too large, or the turn could not take it); it is delivered when
 *   the turn ends.
 * - `unsupported, queued`: the worker's agent cannot take mail mid-turn (a
 *   terminal agent, or a provider without steer); delivered when the turn ends.
 * - `verifying`: the steer was handed off but not confirmed. It is checked
 *   against the session's steer journal and never offered twice.
 * - `not queued`: the message was not scheduled for delivery at all (held by a
 *   budget, stored, or bounced). `deliverNow` never bypasses that.
 */
export type CoordinatorDeliverNowOutcome =
  | "steered"
  | "delivered"
  | "queued until idle"
  | "unsupported, queued"
  | "verifying"
  | "not queued";

export type CoordinatorDeliverNowResult = {
  deliverNow: CoordinatorDeliverNowOutcome;
  deliverNowNote: string;
};

/** Whether this mailbox's agent can take mail mid-turn at all. */
async function recipientCanSteer(context: CommandContext, message: AgentMailMessage) {
  const mailbox = await context.storage.getAgentMailMailbox(
    message.toEnvironmentId,
    message.toTabId,
    { limit: 1 },
  );
  const { kind, agent } = mailbox.descriptor;
  return kind === "native" && agent !== undefined && agent !== null
    ? nativeAgentCapabilities(agent).actions?.steer === true
    : false;
}

/**
 * Run one delivery pass for a `deliverNow` message and report its outcome.
 *
 * The send already marked the pending entry `steerRequested`, the same flag
 * Deliver now sets, so the drain decides everything: eligibility
 * (`mayInjectMessage`), presence, the single steer attempt, and journal
 * verification of an unanswered one. This only waits for that pass, as
 * `retry_agent_mail_inject` does, and reads where the message ended up.
 */
export async function settleCoordinatorDeliverNow(
  context: CommandContext,
  sent: AgentMailMessage,
): Promise<CoordinatorDeliverNowResult> {
  if (sent.placement !== "pending-inject") {
    return {
      deliverNow: "not queued",
      deliverNowNote: `Not scheduled for delivery (${sent.placement}${
        sent.placementReason ? `: ${sent.placementReason}` : ""
      }); deliverNow does not bypass holds, budgets or mutes.`,
    };
  }
  const canSteer = await recipientCanSteer(context, sent).catch(() => false);
  try {
    await context.drainAgentMail?.();
  } catch (error) {
    console.warn(
      "[coordinator] Delivery pass after deliverNow failed:",
      error instanceof Error ? error.message : error,
    );
  }
  const current = await context.storage
    .getAgentMailMessage(sent.toEnvironmentId, sent.toTabId, sent.id)
    .catch(() => sent);
  if (current.placement === "injected") {
    return current.injectedVia === "steer"
      ? { deliverNow: "steered", deliverNowNote: "Steered into the worker's running turn." }
      : {
          deliverNow: "delivered",
          deliverNowNote: "The worker was idle, so it was delivered as a new turn.",
        };
  }
  if (current.placement === "pending-inject" && current.placementReason === "verifying") {
    return {
      deliverNow: "verifying",
      deliverNowNote:
        "The steer was handed to the worker but not confirmed. It is checked against the session's steer journal and never sent twice.",
    };
  }
  if (current.placement === "pending-inject" || current.placement === "inject-held") {
    if (!canSteer || current.placementReason === "steer-unsupported") {
      return {
        deliverNow: "unsupported, queued",
        deliverNowNote:
          "This worker's agent cannot take mail mid-turn; it is delivered when the turn ends.",
      };
    }
    return {
      deliverNow: "queued until idle",
      deliverNowNote: `Not steered${
        current.placementReason ? ` (${current.placementReason})` : ""
      }; it is delivered when the worker's turn ends.`,
    };
  }
  return {
    deliverNow: "not queued",
    deliverNowNote: `Not delivered (${current.placement}${
      current.placementReason ? `: ${current.placementReason}` : ""
    }).`,
  };
}
