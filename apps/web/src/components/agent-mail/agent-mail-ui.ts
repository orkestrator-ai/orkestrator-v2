import {
  AGENT_MAIL_HOURLY_LIMIT_REASON,
  agentMailAwaitingAgent,
  isAgentMailBudgetHeld,
  type AgentMailMessageSummary,
  type MailboxCapabilities,
} from "@orkestrator/protocol/agent-mail";
import * as backend from "@/lib/backend";
import { createAgentMailApi, type AgentMailApi } from "@/lib/backend/agent-mail";
import { backendApiForScope } from "@/lib/backend/client";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useNodeScope } from "@/lib/node-scope/providers";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { useEnvironmentStore } from "@/stores/environmentStore";

export type AgentMailStatusTone = "muted" | "progress" | "warning" | "error";

/** Where a message stands, in a few words a person can act on. */
export function agentMailStatus(
  message: Pick<
    AgentMailMessageSummary,
    "placement" | "placementReason" | "ackedAt" | "discardedAt"
  >,
  recipient?: Pick<MailboxCapabilities, "canPull">,
): { label: string; tone: AgentMailStatusTone } {
  if (message.discardedAt) return { label: "discarded", tone: "muted" };
  if (recipient && agentMailAwaitingAgent(message, recipient)) {
    return { label: "waiting for agent", tone: "warning" };
  }
  if (isAgentMailBudgetHeld(message)) {
    return {
      label:
        message.placementReason === AGENT_MAIL_HOURLY_LIMIT_REASON
          ? "paused · hourly limit"
          : "paused · loop budget",
      tone: "warning",
    };
  }
  switch (message.placement) {
    case "inject_failed":
      return { label: "delivery failed", tone: "error" };
    case "pending-inject":
      return {
        label:
          message.placementReason === "retrying"
            ? "retrying delivery"
            : message.placementReason === "verifying"
              ? "checking delivery"
              : "waiting to deliver",
        tone: "progress",
      };
    case "inject-held":
      return { label: "held", tone: "progress" };
    case "injected":
      return { label: message.ackedAt ? "handled" : "delivered", tone: "muted" };
    case "stored":
      return { label: message.ackedAt ? "handled" : "in inbox", tone: "muted" };
    case "undeliverable":
      return { label: "undeliverable", tone: "error" };
    case "bounced":
      return { label: "refused", tone: "error" };
    case "expired":
      return { label: "expired", tone: "muted" };
  }
}

/** What to tell the person when Deliver now could not deliver the message yet. */
export function deliverNowNotice(
  message: Pick<AgentMailMessageSummary, "placement" | "placementReason">,
): { title: string; description: string } | null {
  if (message.placement !== "pending-inject") return null;
  switch (message.placementReason) {
    case "steer-unsupported":
      return {
        title: "This agent can't take messages mid-turn",
        description: "It will be delivered when the current turn ends.",
      };
    case "steer-too-large":
      return {
        title: "This message is too large to deliver mid-turn",
        description: "It will be delivered in full when the current turn ends.",
      };
    case "steer-refused":
      return {
        title: "Couldn't deliver into the running turn",
        description: "It will be delivered when the current turn ends.",
      };
    case "verifying":
      return {
        title: "Checking whether it arrived",
        description: "It is confirmed before anything is sent again.",
      };
    case "draft":
      return {
        title: "Delivery is still waiting",
        description: "You have unsent text in the composer.",
      };
    default:
      return {
        title: "Delivery is still waiting",
        description: "It will be delivered when this agent is idle.",
      };
  }
}

export const AGENT_MAIL_STATUS_TONE_CLASS: Record<AgentMailStatusTone, string> = {
  muted: "bg-zinc-800/80 text-muted-foreground",
  progress: "bg-cyan-400/10 text-cyan-300",
  warning: "bg-amber-400/10 text-amber-300",
  error: "bg-failure/10 text-failure",
};

/** Same day: the time. Otherwise the date and time. */
export function formatAgentMailTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/**
 * An environment's current name, for mail that names it by id: the
 * environment store's, or a loaded mailbox descriptor's. Undefined until one
 * of them knows it, and for an id this node does not have.
 */
export function useAgentMailEnvironmentName(environmentId: string | undefined): string | undefined {
  const fromEnvironments = useEnvironmentStore((state) =>
    environmentId
      ? state.environments.find((environment) => environment.id === environmentId)?.name
      : undefined,
  );
  const fromMailboxes = useAgentMailStore((state) => {
    if (!environmentId) return undefined;
    for (const mailbox of state.mailboxes.values()) {
      if (mailbox.descriptor.environmentId === environmentId)
        return mailbox.descriptor.environmentName;
    }
    return undefined;
  });
  return fromEnvironments || fromMailboxes || undefined;
}

/**
 * The nearest node scope and its mail commands (plan item 3010): the
 * `@/lib/backend` named exports (which suites mock or spy on) on the app's
 * command scope, otherwise that scope's own node.
 */
export function useAgentMailScope(): { scope: NodeScope; api: AgentMailApi } {
  const scope = useNodeScope();
  return { scope, api: backendApiForScope(scope, createAgentMailApi, backend) };
}
