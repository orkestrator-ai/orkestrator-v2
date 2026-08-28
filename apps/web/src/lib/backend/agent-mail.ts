import { invoke } from "@/lib/native/backend";
import type {
  AgentMailMailboxSnapshot,
  AgentMailMailboxBatchSnapshot,
  AgentMailInboxSnapshot,
  AgentMailMessage,
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
  return invoke("get_agent_mail_mailbox", { environmentId, tabId, unreadOnly });
}

export function getAgentMailMessage(
  environmentId: string,
  tabId: string,
  messageId: string,
): Promise<AgentMailMessage> {
  return invoke("get_agent_mail_message", { environmentId, tabId, messageId });
}

export function sendAgentMail(input: {
  requestId: string;
  toEnvironmentId: string;
  toTabId: string;
  subject?: string;
  body: string;
}): Promise<AgentMailMessage> {
  return invoke("send_agent_mail", input);
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

export function getAgentMessagingSettings(): Promise<AgentMessagingSettings> {
  return invoke("get_agent_messaging_settings");
}

export function updateAgentMessagingSettings(settings: AgentMessagingSettings): Promise<unknown> {
  return invoke("update_agent_messaging_settings", { settings });
}

export function setAgentMessagingPaused(paused: boolean): Promise<{ paused: boolean }> {
  return invoke("set_agent_messaging_paused", { paused });
}
