import { invoke } from "@/lib/native/backend";
import { invokeCommandNodeSetting } from "@/lib/portal/command-node-config";
import { AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX } from "@orkestrator/protocol/agent-mail";
import type { AgentRegistrySnapshot } from "@orkestrator/protocol/agent-registry";
import type {
  AgentMailConversation,
  AgentMailConversationList,
  AgentMailMailboxSnapshot,
  AgentMailMailboxBatchSnapshot,
  AgentMailInboxSnapshot,
  AgentMailMessage,
  AgentMailMessageSummary,
  AgentMailSummarySnapshot,
  AgentMessagingSettings,
  MailboxDescriptor,
} from "@orkestrator/protocol/agent-mail";

export function getAgentMailSummary(): Promise<AgentMailSummarySnapshot> {
  return invoke("get_agent_mail_summary");
}

export function listAgentMailboxes(
  options: {
    projectId?: string;
    q?: string;
    offset?: number;
    limit?: number;
    includeTombstoned?: boolean;
  } = {},
): Promise<{ mailboxes: MailboxDescriptor[]; total: number; offset: number; limit: number }> {
  return invoke("list_agent_mailboxes", options);
}

export function getAgentMailMailboxes(
  addresses: Array<{ environmentId: string; tabId: string }>,
): Promise<AgentMailMailboxBatchSnapshot> {
  return invoke("get_agent_mail_mailboxes", { addresses });
}

export function getAgentMailInboxSnapshot(): Promise<AgentMailInboxSnapshot> {
  return invoke("get_agent_mail_inbox_snapshot");
}

export function getAgentMailMailbox(
  environmentId: string,
  tabId: string,
  unreadOnly = false,
): Promise<AgentMailMailboxSnapshot> {
  return invoke("get_agent_mail_mailbox", {
    environmentId,
    tabId,
    unreadOnly,
    limit: AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX,
  });
}

export function getAgentMailMessage(
  environmentId: string,
  tabId: string,
  messageId: string,
): Promise<AgentMailMessage> {
  return invoke("get_agent_mail_message", { environmentId, tabId, messageId });
}

/** Every pair that has exchanged mail, or only one participant's. */
export function listAgentMailConversations(
  participant?: string,
): Promise<AgentMailConversationList> {
  return invoke("list_agent_mail_conversations", participant ? { participant } : {});
}

/** The messages between two participants, oldest first. */
export function getAgentMailConversation(
  a: string,
  b: string,
  limit?: number,
): Promise<AgentMailConversation> {
  return invoke("get_agent_mail_conversation", { a, b, ...(limit ? { limit } : {}) });
}

export function markAgentMailConversationSeen(
  a: string,
  b: string,
  messageIds: string[],
): Promise<{ marked: number }> {
  return invoke("mark_agent_mail_conversation_seen", { a, b, messageIds });
}

export function sendAgentMail(input: {
  requestId: string;
  toEnvironmentId: string;
  toTabId: string;
  subject?: string;
  body: string;
  replyToMessageId?: string;
}): Promise<AgentMailMessage> {
  return invoke("send_agent_mail", input);
}

export function listAgentMailSent(address?: {
  environmentId: string;
  tabId: string;
}): Promise<AgentMailMessageSummary[]> {
  return invoke("list_agent_mail_sent", address ?? {});
}

export function ackAgentMail(
  environmentId: string,
  tabId: string,
  messageId: string,
): Promise<AgentMailMessage> {
  return invoke("ack_agent_mail", { environmentId, tabId, messageId });
}

export function markAgentMailSeen(
  environmentId: string,
  tabId: string,
  messageId: string,
): Promise<AgentMailMessage> {
  return invoke("mark_agent_mail_seen", { environmentId, tabId, messageId });
}

export function updateAgentMailboxPolicy(input: {
  environmentId: string;
  tabId: string;
  inject?: "inherit" | "off" | "idle";
  mutedInbound?: boolean;
  mutedOutbound?: boolean;
}): Promise<MailboxDescriptor> {
  return invoke("mute_agent_mail", input);
}

export function retryAgentMailInject(
  environmentId: string,
  tabId: string,
  messageId: string,
): Promise<AgentMailMessage> {
  return invoke("retry_agent_mail_inject", { environmentId, tabId, messageId });
}

export function discardAgentMailInject(
  environmentId: string,
  tabId: string,
  messageId: string,
): Promise<AgentMailMessage> {
  return invoke("discard_agent_mail_inject", { environmentId, tabId, messageId });
}

/** Messaging settings are the command node's, which its leaves inherit. */
export function getAgentMessagingSettings(): Promise<AgentMessagingSettings> {
  return invokeCommandNodeSetting("get_agent_messaging_settings");
}

export function updateAgentMessagingSettings(settings: AgentMessagingSettings): Promise<unknown> {
  return invokeCommandNodeSetting("update_agent_messaging_settings", { settings });
}

export function setAgentMessagingPaused(paused: boolean): Promise<{ paused: boolean }> {
  return invoke("set_agent_messaging_paused", { paused });
}

/** Every agent tab and what it is doing, optionally for one project or environment. */
export function getAgentRegistry(filter: {
  projectId?: string;
  environmentId?: string;
}): Promise<AgentRegistrySnapshot> {
  return invoke<AgentRegistrySnapshot>("get_agent_registry", filter);
}
