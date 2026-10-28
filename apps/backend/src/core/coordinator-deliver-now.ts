import {
  agentMailRouteWakes,
  normalizeAgentMessagingSettings,
} from "@orkestrator/protocol/agent-mail";
import type { AgentMailMessage } from "@orkestrator/protocol/agent-mail";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import type { CommandContext } from "./commands-context.js";

/**
 * What a coordinator's `deliverNow` did, as its `send_message` result says it.
 *
 * - `steered`: the message landed in the worker's running turn.
 * - `delivered`: the worker was idle, so it went out as a new turn.
 * - `queued until idle`: the worker was busy and the steer did not happen
 *   (refused, too large, or the turn could not take it); queued for idle delivery.
 * - `unsupported, queued`: the worker's agent cannot take mail mid-turn (a
 *   terminal agent, provider without steer, or node link); queued for idle delivery.
 * - `verifying`: the steer was handed off but not confirmed. It is checked
 *   against the session's steer journal and never offered twice.
 * - `not queued`: delivery is blocked (budget, storage policy, bounce, pause,
 *   or environment readiness). `deliverNow` never bypasses those decisions.
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

/** Classify the persisted placement, including replies from remote nodes. */
export function coordinatorDeliverNowResult(
  message: { placement?: unknown; placementReason?: unknown; injectedVia?: unknown },
  options: { unsupported?: boolean; blockedReason?: string } = {},
): CoordinatorDeliverNowResult {
  if (message.placement === "injected") {
    return message.injectedVia === "steer"
      ? { deliverNow: "steered", deliverNowNote: "Steered into the worker's running turn." }
      : { deliverNow: "delivered", deliverNowNote: "Delivered as a new turn." };
  }
  if (message.placement === "pending-inject" && message.placementReason === "verifying") {
    return {
      deliverNow: "verifying",
      deliverNowNote:
        "The steer was handed to the worker but not confirmed. It is checked against the session's steer journal and never sent twice.",
    };
  }
  const reason = options.blockedReason ?? message.placementReason;
  if (message.placement !== "pending-inject" || options.blockedReason || reason === "paused") {
    return {
      deliverNow: "not queued",
      deliverNowNote: `Not scheduled for delivery now (${message.placement ?? "unknown placement"}${
        reason ? `: ${reason}` : ""
      }); deliverNow does not bypass holds, budgets or mutes.`,
    };
  }
  if (options.unsupported || reason === "steer-unsupported") {
    return {
      deliverNow: "unsupported, queued",
      deliverNowNote:
        "Mid-turn delivery is unsupported for this recipient or node link; the message is queued for idle delivery.",
    };
  }
  return {
    deliverNow: "queued until idle",
    deliverNowNote: `Not steered${reason ? ` (${reason})` : ""}; queued for idle delivery.`,
  };
}

/**
 * Wait for one delivery pass, then return the authoritative message and outcome.
 * A completed replay never enters the drain. An unused steer request expires
 * after this pass so it cannot interrupt a different, later turn.
 */
export async function settleCoordinatorDeliverNow(
  context: CommandContext,
  sent: AgentMailMessage,
): Promise<AgentMailMessage & CoordinatorDeliverNowResult> {
  if (sent.placement !== "pending-inject") {
    return { ...sent, ...coordinatorDeliverNowResult(sent) };
  }
  try {
    await context.drainAgentMail?.();
  } catch (error) {
    console.warn(
      "[coordinator] Delivery pass after deliverNow failed:",
      error instanceof Error ? error.message : error,
    );
  }
  const unusedSteer = await context.storage.clearAgentMailSteerRequest(
    sent.toEnvironmentId,
    sent.toTabId,
    sent.id,
  );
  const current = await context.storage.getAgentMailMessage(
    sent.toEnvironmentId,
    sent.toTabId,
    sent.id,
  );
  if (current.placement !== "pending-inject" || current.placementReason === "verifying") {
    return { ...current, ...coordinatorDeliverNowResult(current) };
  }
  const [config, mailbox, environment] = await Promise.all([
    context.storage.loadConfig(),
    context.storage.getAgentMailMailbox(sent.toEnvironmentId, sent.toTabId, { limit: 1 }),
    context.storage.getEnvironment(sent.toEnvironmentId),
  ]);
  const { kind, agent } = mailbox.descriptor;
  const canSteer =
    kind === "native" && agent != null && nativeAgentCapabilities(agent).actions?.steer === true;
  const descriptor = mailbox.descriptor;
  let blockedReason: string | undefined;
  if (!config.global.agentMessaging?.enabled) blockedReason = "messaging-disabled";
  else if (config.global.agentMessaging.paused) blockedReason = "paused";
  else if (!environment || environment.status !== "running") blockedReason = "environment-stopped";
  else if (
    environment.setupPhase !== "ready" &&
    environment.setupScriptsComplete !== true &&
    environment.setupOverride !== true
  )
    blockedReason = "environment-unready";
  else if (descriptor.mutedInbound) blockedReason = "recipient-muted";
  else if (descriptor.tombstonedAt) blockedReason = "recipient-unavailable";
  else if (!descriptor.capabilities.canInject) blockedReason = "recipient-cannot-inject";
  else if (
    descriptor.injectPolicy !== "idle" &&
    !current.userReleasedAt &&
    !agentMailRouteWakes(
      current.route,
      descriptor.injectOverride,
      normalizeAgentMessagingSettings(config.global.agentMessaging),
    )
  )
    blockedReason = "inject-policy-off";
  else if (unusedSteer) blockedReason = "delivery-pass-deferred";

  return {
    ...current,
    ...coordinatorDeliverNowResult(current, { unsupported: !canSteer, blockedReason }),
  };
}
