import { agentMail, commandNodeAgentMail } from "@/lib/node-scope/domains/agent-mail";
import { AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX } from "@orkestrator/protocol/agent-mail";
import type { AgentRegistrySnapshot } from "@orkestrator/protocol/agent-registry";
import type {
  AgentMailConversation,
  AgentMailConversationList,
  AgentMailMailboxSnapshot,
  AgentMailMailboxBatchSnapshot,
  AgentMailInboxSnapshot,
  AgentMailMessage,
  AgentMailSummarySnapshot,
  AgentMessagingSettings,
  MailboxDescriptor,
} from "@orkestrator/protocol/agent-mail";
import { commandBackendClient, type BackendClient } from "./client";

/** Messaging settings are the command node's, which its leaves inherit. */
export function getAgentMessagingSettings(): Promise<AgentMessagingSettings> {
  return commandNodeAgentMail().get_agent_messaging_settings({});
}

/** Saves the command node's messaging settings and answers with what it stored. */
export function updateAgentMessagingSettings(
  settings: AgentMessagingSettings,
): Promise<AgentMessagingSettings> {
  return commandNodeAgentMail().update_agent_messaging_settings({ settings });
}

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createAgentMailApi(client: BackendClient) {
  // Every call goes through the `agent-mail` domain client (plan item 7008).
  const mail = agentMail(client);

  function getAgentMailSummary(): Promise<AgentMailSummarySnapshot> {
    return mail().get_agent_mail_summary({});
  }

  function listAgentMailboxes(
    options: {
      projectId?: string;
      q?: string;
      offset?: number;
      limit?: number;
      includeTombstoned?: boolean;
    } = {},
  ): Promise<{ mailboxes: MailboxDescriptor[]; total: number; offset: number; limit: number }> {
    return mail().list_agent_mailboxes(options);
  }

  function getAgentMailMailboxes(
    addresses: Array<{ environmentId: string; tabId: string }>,
  ): Promise<AgentMailMailboxBatchSnapshot> {
    return mail().get_agent_mail_mailboxes({ addresses });
  }

  function getAgentMailInboxSnapshot(): Promise<AgentMailInboxSnapshot> {
    return mail().get_agent_mail_inbox_snapshot({});
  }

  function getAgentMailMailbox(
    environmentId: string,
    tabId: string,
    unreadOnly = false,
  ): Promise<AgentMailMailboxSnapshot> {
    return mail().get_agent_mail_mailbox({
      environmentId,
      tabId,
      unreadOnly,
      limit: AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX,
    });
  }

  /** Every pair that has exchanged mail, or only one participant's. */
  function listAgentMailConversations(participant?: string): Promise<AgentMailConversationList> {
    return mail().list_agent_mail_conversations(participant ? { participant } : {});
  }

  /** The messages between two participants, oldest first. */
  function getAgentMailConversation(
    a: string,
    b: string,
    limit?: number,
  ): Promise<AgentMailConversation> {
    return mail().get_agent_mail_conversation({ a, b, ...(limit ? { limit } : {}) });
  }

  function markAgentMailConversationSeen(
    a: string,
    b: string,
    messageIds: string[],
  ): Promise<{ marked: number }> {
    return mail().mark_agent_mail_conversation_seen({ a, b, messageIds });
  }

  function sendAgentMail(input: {
    requestId: string;
    toEnvironmentId: string;
    toTabId: string;
    subject?: string;
    body: string;
    replyToMessageId?: string;
  }): Promise<AgentMailMessage> {
    return mail().send_agent_mail(input);
  }

  function updateAgentMailboxPolicy(input: {
    environmentId: string;
    tabId: string;
    inject?: "inherit" | "off" | "idle";
    mutedInbound?: boolean;
    mutedOutbound?: boolean;
  }): Promise<MailboxDescriptor> {
    return mail().mute_agent_mail(input);
  }

  function retryAgentMailInject(
    environmentId: string,
    tabId: string,
    messageId: string,
  ): Promise<AgentMailMessage> {
    return mail().retry_agent_mail_inject({ environmentId, tabId, messageId });
  }

  /**
   * Deliver one message now. A recipient mid-turn has it steered into that turn
   * when its agent can take it; otherwise it is delivered when the turn ends.
   * Resolves after the attempt, with the message as it then stands.
   */
  function deliverAgentMailNow(
    environmentId: string,
    tabId: string,
    messageId: string,
  ): Promise<AgentMailMessage> {
    return mail().retry_agent_mail_inject({ environmentId, tabId, messageId, now: true });
  }

  function discardAgentMailInject(
    environmentId: string,
    tabId: string,
    messageId: string,
  ): Promise<AgentMailMessage> {
    return mail().discard_agent_mail_inject({ environmentId, tabId, messageId });
  }

  /** Every agent tab and what it is doing, optionally for one project or environment. */
  function getAgentRegistry(filter: {
    projectId?: string;
    environmentId?: string;
  }): Promise<AgentRegistrySnapshot> {
    return mail().get_agent_registry(filter);
  }

  return {
    getAgentMailSummary,
    listAgentMailboxes,
    getAgentMailMailboxes,
    getAgentMailInboxSnapshot,
    getAgentMailMailbox,
    listAgentMailConversations,
    getAgentMailConversation,
    markAgentMailConversationSeen,
    sendAgentMail,
    updateAgentMailboxPolicy,
    retryAgentMailInject,
    deliverAgentMailNow,
    discardAgentMailInject,
    getAgentRegistry,
  };
}

export type AgentMailApi = ReturnType<typeof createAgentMailApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  getAgentMailSummary,
  listAgentMailboxes,
  getAgentMailMailboxes,
  getAgentMailInboxSnapshot,
  getAgentMailMailbox,
  listAgentMailConversations,
  getAgentMailConversation,
  markAgentMailConversationSeen,
  sendAgentMail,
  updateAgentMailboxPolicy,
  retryAgentMailInject,
  deliverAgentMailNow,
  discardAgentMailInject,
  getAgentRegistry,
} = createAgentMailApi(commandBackendClient);
