/**
 * Result schemas of the `agent-mail` commands (plan item 7008), over the
 * protocol's own model types (`@orkestrator/protocol/agent-mail`,
 * `@orkestrator/protocol/agent-registry`).
 *
 * Each record is a {@link modelRecord}: the fields that identify it and that
 * callers branch on (ids, revisions, placements, counts) are validated, and
 * every other key passes through a client's tolerant decode, so a newer
 * backend's fields reach the renderer. Enumerations a newer backend may extend
 * (placements, trust classes, actor kinds, presence, mailbox kinds) are
 * `Schema.String`; the renderer's own guards decide what it understands.
 * Optional fields are `Schema.optional`, which also accepts an explicit
 * `undefined`.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type {
  AgentMailConversation,
  AgentMailConversationList,
  AgentMailConversationSummary,
  AgentMailInboxSnapshot,
  AgentMailMailboxBatchSnapshot,
  AgentMailMailboxSnapshot,
  AgentMailMessage,
  AgentMailMessageSummary,
  AgentMailParticipant,
  AgentMailSummaryEntry,
  AgentMailSummarySnapshot,
  AgentMessagingSettings,
  MailActor,
  MailboxDescriptor,
} from "../../../agent-mail.js";
import type {
  AgentRegistryEntry,
  AgentRegistryEnvironmentSummary,
  AgentRegistrySnapshot,
} from "../../../agent-registry.js";
import { modelRecord } from "../../model-schema.js";

const Count = Schema.Finite;

/** Who sent a message: its `kind` is declared, every other actor field passes through. */
export const MailActorSchema = modelRecord<{ kind: MailActor["kind"] }>()({
  kind: Schema.String,
}) as unknown as Schema.Codec<MailActor, MailActor, never, never>;

/** The fields every stored message, with or without its body, carries. */
const messageFields = {
  id: Schema.String,
  threadId: Schema.String,
  requestId: Schema.String,
  createdAt: Schema.String,
  from: MailActorSchema,
  toEnvironmentId: Schema.String,
  toTabId: Schema.String,
  trust: Schema.String,
  placement: Schema.String,
  placementReason: Schema.optional(Schema.String),
  replyToMessageId: Schema.optional(Schema.String),
  revision: Count,
};

/** One message, body included (`get_agent_mail_message`, a send, an ack...). */
export const AgentMailMessageSchema = modelRecord<AgentMailMessage>()({
  ...messageFields,
  body: Schema.String,
}).annotate({ identifier: "AgentMailMessage" });

/** A message without its body, as lists and status reads carry it. */
export const AgentMailMessageSummarySchema = modelRecord<AgentMailMessageSummary>()(
  messageFields,
).annotate({ identifier: "AgentMailMessageSummary" });

/** One mailbox in the directory. */
export const MailboxDescriptorSchema = modelRecord<MailboxDescriptor>()({
  mailboxId: Schema.String,
  incarnationId: Schema.String,
  projectId: Schema.String,
  environmentId: Schema.String,
  tabId: Schema.String,
  displayName: Schema.String,
  kind: Schema.String,
  presence: Schema.String,
  injectPolicy: Schema.String,
  mutedInbound: Schema.Boolean,
  mutedOutbound: Schema.Boolean,
  unreadCount: Count,
  userUnseenCount: Count,
  agentUnackedCount: Count,
  pendingInjectCount: Count,
  failedInjectCount: Count,
}).annotate({ identifier: "MailboxDescriptor" });

/** One page of the mailbox directory (`list_agent_mailboxes`). */
export interface AgentMailboxList {
  mailboxes: MailboxDescriptor[];
  total: number;
  offset: number;
  limit: number;
}

/** `list_agent_mailboxes`: one page of the directory. */
export const AgentMailboxListSchema = modelRecord<AgentMailboxList>()({
  mailboxes: Schema.Array(MailboxDescriptorSchema),
  total: Count,
  offset: Count,
  limit: Count,
}).annotate({ identifier: "AgentMailboxList" });

/** Sent mail, newest last (`list_agent_mail_sent`). */
export const AgentMailSentListSchema = Schema.mutable(
  Schema.Array(AgentMailMessageSummarySchema),
).annotate({ identifier: "AgentMailSentList" });

/** One mailbox and a page of its messages. */
export const AgentMailMailboxSnapshotSchema = modelRecord<AgentMailMailboxSnapshot>()({
  descriptor: MailboxDescriptorSchema,
  messages: Schema.Array(AgentMailMessageSummarySchema),
  total: Count,
  offset: Count,
  limit: Count,
  revision: Count,
}).annotate({ identifier: "AgentMailMailboxSnapshot" });

/** `get_agent_mail_mailboxes`: several mailboxes at one store revision. */
export const AgentMailMailboxBatchSnapshotSchema = modelRecord<AgentMailMailboxBatchSnapshot>()({
  revision: Count,
  mailboxes: Schema.Array(AgentMailMailboxSnapshotSchema),
}).annotate({ identifier: "AgentMailMailboxBatchSnapshot" });

export const AgentMailSummaryEntrySchema = modelRecord<AgentMailSummaryEntry>()({
  mailboxId: Schema.String,
  projectId: Schema.String,
  environmentId: Schema.String,
  tabId: Schema.String,
  unreadCount: Count,
  userUnseenCount: Count,
  agentUnackedCount: Count,
  pendingInjectCount: Count,
  failedInjectCount: Count,
  attentionCount: Schema.optional(Count),
  revision: Count,
});

/** `get_agent_mail_summary`: per-mailbox counts. */
export const AgentMailSummarySnapshotSchema = modelRecord<AgentMailSummarySnapshot>()({
  revision: Count,
  mailboxes: Schema.Array(AgentMailSummaryEntrySchema),
}).annotate({ identifier: "AgentMailSummarySnapshot" });

/** `get_agent_mail_inbox_snapshot`: the directory, every mailbox and the summary at once. */
export const AgentMailInboxSnapshotSchema = modelRecord<AgentMailInboxSnapshot>()({
  revision: Count,
  mailboxes: Schema.Array(AgentMailMailboxSnapshotSchema),
  directory: Schema.Array(MailboxDescriptorSchema),
  summary: AgentMailSummarySnapshotSchema,
}).annotate({ identifier: "AgentMailInboxSnapshot" });

const AgentMailParticipantSchema = modelRecord<AgentMailParticipant>()({
  key: Schema.String,
});

const AgentMailConversationSummarySchema = modelRecord<AgentMailConversationSummary>()({
  key: Schema.String,
  participants: Schema.Array(AgentMailParticipantSchema),
  lastMessage: AgentMailMessageSummarySchema,
  messageCount: Count,
  attentionCount: Count,
});

/** `list_agent_mail_conversations`. */
export const AgentMailConversationListSchema = modelRecord<AgentMailConversationList>()({
  revision: Count,
  conversations: Schema.Array(AgentMailConversationSummarySchema),
}).annotate({ identifier: "AgentMailConversationList" });

/** `get_agent_mail_conversation`: the latest messages between a pair, oldest first. */
export const AgentMailConversationSchema = modelRecord<AgentMailConversation>()({
  revision: Count,
  key: Schema.String,
  participants: Schema.Array(AgentMailParticipantSchema),
  messages: Schema.Array(AgentMailMessageSchema),
  total: Count,
}).annotate({ identifier: "AgentMailConversation" });

/** The machine's messaging settings, normalised. */
export const AgentMessagingSettingsSchema = modelRecord<AgentMessagingSettings>()({
  enabled: Schema.Boolean,
  allowCrossProject: Schema.Boolean,
  defaultInjectPolicy: Schema.String,
  wakePeers: Schema.Boolean,
  autonomousWakeBudget: Count,
  hourlyWakeLimit: Count,
  coordinatorStatusWakes: Schema.String,
  retentionDays: Count,
  paused: Schema.Boolean,
}).annotate({ identifier: "AgentMessagingSettings" });

const AgentRegistryEntrySchema = modelRecord<AgentRegistryEntry>()({
  projectId: Schema.String,
  environmentId: Schema.String,
  tabId: Schema.String,
  ownerKind: Schema.String,
  kind: Schema.String,
  agent: Schema.NullOr(Schema.String),
  displayName: Schema.String,
  state: Schema.String,
});

const AgentRegistryEnvironmentSummarySchema = modelRecord<AgentRegistryEnvironmentSummary>()({
  environmentId: Schema.String,
  tabs: Count,
});

/** `get_agent_registry`: every agent tab, and per environment how many are busy. */
export const AgentRegistrySnapshotSchema = modelRecord<AgentRegistrySnapshot>()({
  generatedAt: Schema.String,
  entries: Schema.Array(AgentRegistryEntrySchema),
  environments: Schema.Array(AgentRegistryEnvironmentSummarySchema),
}).annotate({ identifier: "AgentRegistrySnapshot" });
