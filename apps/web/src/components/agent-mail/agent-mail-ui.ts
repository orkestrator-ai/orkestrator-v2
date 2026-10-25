import {
  AGENT_MAIL_HOURLY_LIMIT_REASON,
  AGENT_MAIL_USER_PARTICIPANT,
  agentMailboxId,
  isAgentMailBudgetHeld,
  type AgentMailMessageSummary,
} from "@orkestrator/protocol/agent-mail";
import { useAgentMailStore } from "@/stores/agentMailStore";

export type AgentMailStatusTone = "muted" | "progress" | "warning" | "error";

/** Where a message stands, in a few words a person can act on. */
export function agentMailStatus(
  message: Pick<
    AgentMailMessageSummary,
    "placement" | "placementReason" | "ackedAt" | "discardedAt"
  >,
): { label: string; tone: AgentMailStatusTone } {
  if (message.discardedAt) return { label: "discarded", tone: "muted" };
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

export const AGENT_MAIL_STATUS_TONE_CLASS: Record<AgentMailStatusTone, string> = {
  muted: "bg-zinc-800/80 text-muted-foreground",
  progress: "bg-cyan-400/10 text-cyan-300",
  warning: "bg-amber-400/10 text-amber-300",
  error: "bg-red-400/10 text-red-300",
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
 * Open the messages panel on one tab: its conversations, or with `compose`
 * the person's own conversation with it.
 */
export function openAgentMailForTab(
  environmentId: string,
  tabId: string,
  mode: "inbox" | "compose" = "inbox",
): void {
  const mailboxId = agentMailboxId(environmentId, tabId);
  useAgentMailStore
    .getState()
    .openPanel(
      mode === "compose"
        ? { focus: mailboxId, conversation: [mailboxId, AGENT_MAIL_USER_PARTICIPANT] }
        : { focus: mailboxId },
    );
}

/** Open the conversation between two participants. */
export function openAgentMailConversation(a: string, b: string): void {
  useAgentMailStore.getState().openPanel({ conversation: [a, b] });
}
