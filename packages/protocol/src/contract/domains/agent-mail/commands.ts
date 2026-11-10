/**
 * `agent-mail` commands (plan item 7008): mail between agent tabs, the person
 * and external senders on one node (mailboxes, inboxes, messages,
 * conversations, delivery state), the agent registry and the messaging
 * settings. Mail between nodes is `node-mail`.
 *
 * Every handler was lenient: it reads each key with `typeof` or checks it
 * with its own message (`environmentId is required`, `paused must be a
 * boolean`, `addresses must be an array of at most …`), and nothing refused
 * unknown keys. So every argument key is `optionalKey(Unknown)`: a decode
 * never refuses what a handler accepts today and every message is unchanged.
 * The arguments are declared so that the tolerant decode keeps them; anything
 * else is dropped (§11.4).
 *
 * Critical keys (an older receiver must not silently ignore them):
 * - `requestId` on both sends: the idempotency key; a receiver ignoring it
 *   would deliver a retried send twice.
 * - `now` on `retry_agent_mail_inject` (Deliver now): ignored, the message is
 *   not steered into the recipient's running turn.
 * - `strictProjectScope` on `list_agent_mailboxes`: ignored, a caller that
 *   asked for its own project's mailboxes is shown other projects' as well.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "../../command.js";
import { agentMailDomain } from "./domain.js";
import {
  AgentMailboxListSchema,
  AgentMailConversationListSchema,
  AgentMailConversationSchema,
  AgentMailInboxSnapshotSchema,
  AgentMailMailboxBatchSnapshotSchema,
  AgentMailMailboxSnapshotSchema,
  AgentMailMessageSchema,
  AgentMailMessageSummarySchema,
  AgentMailSentListSchema,
  AgentMailSummarySnapshotSchema,
  AgentMessagingSettingsSchema,
  AgentRegistrySnapshotSchema,
  MailboxDescriptorSchema,
} from "./schemas.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);

/** One message in one mailbox (`required(...)` in the handler, with its own text). */
const messageAddress = {
  environmentId: optionalUnknown,
  tabId: optionalUnknown,
  messageId: optionalUnknown,
};

/** One mailbox's page (`unreadOnly`, `offset`, `limit` read with `typeof`). */
const mailboxPage = {
  environmentId: optionalUnknown,
  tabId: optionalUnknown,
  unreadOnly: optionalUnknown,
  offset: optionalUnknown,
  limit: optionalUnknown,
};

/** Every agent tab on this node and how many are busy, per environment. */
export const getAgentRegistryCommand = defineCommand({
  domain: agentMailDomain,
  name: "get_agent_registry",
  since: 1,
  access: "workspace",
  read: true,
  critical: [],
  args: Schema.Struct({ projectId: optionalUnknown, environmentId: optionalUnknown }),
  result: AgentRegistrySnapshotSchema,
});

export const listAgentMailboxesCommand = defineCommand({
  domain: agentMailDomain,
  name: "list_agent_mailboxes",
  since: 1,
  access: "workspace",
  read: true,
  critical: ["strictProjectScope"],
  args: Schema.Struct({
    projectId: optionalUnknown,
    environmentId: optionalUnknown,
    q: optionalUnknown,
    offset: optionalUnknown,
    limit: optionalUnknown,
    includeTombstoned: optionalUnknown,
    strictProjectScope: optionalUnknown,
  }),
  result: AgentMailboxListSchema,
});

export const getAgentMailSummaryCommand = defineCommand({
  domain: agentMailDomain,
  name: "get_agent_mail_summary",
  since: 1,
  access: "workspace",
  read: true,
  critical: [],
  args: Schema.Struct({}),
  result: AgentMailSummarySnapshotSchema,
});

export const getAgentMailInboxSnapshotCommand = defineCommand({
  domain: agentMailDomain,
  name: "get_agent_mail_inbox_snapshot",
  since: 1,
  access: "workspace",
  read: true,
  critical: [],
  args: Schema.Struct({}),
  result: AgentMailInboxSnapshotSchema,
});

export const getAgentMailMailboxCommand = defineCommand({
  domain: agentMailDomain,
  name: "get_agent_mail_mailbox",
  since: 1,
  access: "workspace",
  read: true,
  critical: [],
  args: Schema.Struct(mailboxPage),
  result: AgentMailMailboxSnapshotSchema,
});

export const getAgentMailMailboxesCommand = defineCommand({
  domain: agentMailDomain,
  name: "get_agent_mail_mailboxes",
  since: 1,
  access: "workspace",
  read: true,
  critical: [],
  args: Schema.Struct({ addresses: optionalUnknown }),
  result: AgentMailMailboxBatchSnapshotSchema,
});

export const getAgentMailMessageCommand = defineCommand({
  domain: agentMailDomain,
  name: "get_agent_mail_message",
  since: 1,
  access: "workspace",
  read: true,
  critical: [],
  args: Schema.Struct(messageAddress),
  result: AgentMailMessageSchema,
});

export const getAgentMailStatusCommand = defineCommand({
  domain: agentMailDomain,
  name: "get_agent_mail_status",
  since: 1,
  access: "workspace",
  read: true,
  critical: [],
  args: Schema.Struct({ messageId: optionalUnknown }),
  result: AgentMailMessageSummarySchema,
});

/** The person's sent mail, or one mailbox's (both or neither of the keys). */
export const listAgentMailSentCommand = defineCommand({
  domain: agentMailDomain,
  name: "list_agent_mail_sent",
  since: 1,
  access: "workspace",
  read: true,
  critical: [],
  args: Schema.Struct({ environmentId: optionalUnknown, tabId: optionalUnknown }),
  result: AgentMailSentListSchema,
});

export const listAgentMailConversationsCommand = defineCommand({
  domain: agentMailDomain,
  name: "list_agent_mail_conversations",
  since: 1,
  access: "workspace",
  read: true,
  critical: [],
  args: Schema.Struct({ participant: optionalUnknown }),
  result: AgentMailConversationListSchema,
});

export const getAgentMailConversationCommand = defineCommand({
  domain: agentMailDomain,
  name: "get_agent_mail_conversation",
  since: 1,
  access: "workspace",
  read: true,
  critical: [],
  args: Schema.Struct({ a: optionalUnknown, b: optionalUnknown, limit: optionalUnknown }),
  result: AgentMailConversationSchema,
});

export const markAgentMailConversationSeenCommand = defineCommand({
  domain: agentMailDomain,
  name: "mark_agent_mail_conversation_seen",
  since: 1,
  access: "workspace",
  read: false,
  critical: [],
  args: Schema.Struct({ a: optionalUnknown, b: optionalUnknown, messageIds: optionalUnknown }),
  result: Schema.Struct({ marked: Schema.Finite }),
});

/** The person writes to an agent tab. */
export const sendAgentMailCommand = defineCommand({
  domain: agentMailDomain,
  name: "send_agent_mail",
  since: 1,
  access: "workspace",
  read: false,
  critical: ["requestId"],
  args: Schema.Struct({
    requestId: optionalUnknown,
    toEnvironmentId: optionalUnknown,
    toTabId: optionalUnknown,
    subject: optionalUnknown,
    body: optionalUnknown,
    replyToMessageId: optionalUnknown,
  }),
  result: AgentMailMessageSchema,
});

/**
 * An external sender (the public API's `send_mail` action) writes to an agent
 * tab; the message is untrusted. `workspace`, like the action that calls it.
 */
export const sendExternalAgentMailCommand = defineCommand({
  domain: agentMailDomain,
  name: "send_external_agent_mail",
  since: 1,
  access: "workspace",
  read: false,
  critical: ["requestId"],
  args: Schema.Struct({
    requestId: optionalUnknown,
    toEnvironmentId: optionalUnknown,
    toTabId: optionalUnknown,
    subject: optionalUnknown,
    body: optionalUnknown,
  }),
  result: AgentMailMessageSchema,
});

export const ackAgentMailCommand = defineCommand({
  domain: agentMailDomain,
  name: "ack_agent_mail",
  since: 1,
  access: "workspace",
  read: false,
  critical: [],
  args: Schema.Struct(messageAddress),
  result: AgentMailMessageSchema,
});

export const markAgentMailSeenCommand = defineCommand({
  domain: agentMailDomain,
  name: "mark_agent_mail_seen",
  since: 1,
  access: "workspace",
  read: false,
  critical: [],
  args: Schema.Struct(messageAddress),
  result: AgentMailMessageSchema,
});

/** A mailbox's delivery policy and mutes. */
export const muteAgentMailCommand = defineCommand({
  domain: agentMailDomain,
  name: "mute_agent_mail",
  since: 1,
  access: "workspace",
  read: false,
  critical: [],
  args: Schema.Struct({
    environmentId: optionalUnknown,
    tabId: optionalUnknown,
    inject: optionalUnknown,
    mutedInbound: optionalUnknown,
    mutedOutbound: optionalUnknown,
  }),
  result: MailboxDescriptorSchema,
});

/** Retry a failed or held delivery; `now` is Deliver now (steered into a running turn). */
export const retryAgentMailInjectCommand = defineCommand({
  domain: agentMailDomain,
  name: "retry_agent_mail_inject",
  since: 1,
  access: "workspace",
  read: false,
  critical: ["now"],
  args: Schema.Struct({ ...messageAddress, now: optionalUnknown }),
  result: AgentMailMessageSchema,
});

export const discardAgentMailInjectCommand = defineCommand({
  domain: agentMailDomain,
  name: "discard_agent_mail_inject",
  since: 1,
  access: "workspace",
  read: false,
  critical: [],
  args: Schema.Struct(messageAddress),
  result: AgentMailMessageSchema,
});

export const getAgentMessagingSettingsCommand = defineCommand({
  domain: agentMailDomain,
  name: "get_agent_messaging_settings",
  since: 1,
  access: "workspace",
  read: true,
  critical: [],
  args: Schema.Struct({}),
  result: AgentMessagingSettingsSchema,
});

/** Answers the settings alone: the full config carries stored credentials. */
export const updateAgentMessagingSettingsCommand = defineCommand({
  domain: agentMailDomain,
  name: "update_agent_messaging_settings",
  since: 1,
  access: "workspace",
  read: false,
  critical: [],
  args: Schema.Struct({ settings: optionalUnknown }),
  result: AgentMessagingSettingsSchema,
});

/** Every `agent-mail` command, in registration order. */
export const AGENT_MAIL_COMMANDS = [
  getAgentRegistryCommand,
  listAgentMailboxesCommand,
  getAgentMailSummaryCommand,
  getAgentMailInboxSnapshotCommand,
  getAgentMailMailboxCommand,
  getAgentMailMailboxesCommand,
  getAgentMailMessageCommand,
  getAgentMailStatusCommand,
  listAgentMailSentCommand,
  listAgentMailConversationsCommand,
  getAgentMailConversationCommand,
  markAgentMailConversationSeenCommand,
  sendAgentMailCommand,
  sendExternalAgentMailCommand,
  ackAgentMailCommand,
  markAgentMailSeenCommand,
  muteAgentMailCommand,
  retryAgentMailInjectCommand,
  discardAgentMailInjectCommand,
  getAgentMessagingSettingsCommand,
  updateAgentMessagingSettingsCommand,
] as const;
