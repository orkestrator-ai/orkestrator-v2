import {
  AGENT_MAIL_CONVERSATION_PREVIEW_LENGTH,
  AGENT_MAIL_DEFAULT_CONVERSATION_LIMIT,
  AGENT_MAIL_MAX_LIST_LIMIT,
  agentMailConversationKey,
  agentMailNeedsAttention,
  agentMailParticipantKey,
  type AgentMailConversation,
  type AgentMailConversationSummary,
  type AgentMailMessage,
  type AgentMailMessageSummary,
  type AgentMailParticipant,
  type MailActor,
  type MailboxDescriptor,
} from "@orkestrator/protocol/agent-mail";

/**
 * Conversations between two participants, read out of the mail store.
 *
 * The store files each message in its recipient's mailbox only, so the history
 * between A and B is A's mail from B plus B's mail from A. Everything here is a
 * pure read over that store; `AgentMailRepository` supplies the mailboxes.
 */

export interface ConversationMailbox {
  descriptor: MailboxDescriptor;
  messages: readonly AgentMailMessage[];
}

/** At most this many conversations are listed; the list is sorted, so the oldest fall off. */
export const AGENT_MAIL_MAX_CONVERSATIONS = 200;

function summary(message: AgentMailMessage): AgentMailMessageSummary {
  const { body: _body, ...rest } = message;
  return rest;
}

function compareMessages(first: AgentMailMessage, second: AgentMailMessage): number {
  return first.createdAt.localeCompare(second.createdAt) || first.id.localeCompare(second.id);
}

function preview(body: string): string {
  const text = body.replace(/\s+/g, " ").trim();
  return text.length > AGENT_MAIL_CONVERSATION_PREVIEW_LENGTH
    ? `${text.slice(0, AGENT_MAIL_CONVERSATION_PREVIEW_LENGTH - 1)}…`
    : text;
}

function mailboxParticipant(descriptor: MailboxDescriptor): AgentMailParticipant {
  return {
    key: descriptor.mailboxId,
    kind: descriptor.ownerKind === "coordinator" ? "coordinator" : "agent",
    displayName: descriptor.displayName,
    agent: descriptor.agent,
    environmentId: descriptor.environmentId,
    tabId: descriptor.tabId,
    environmentName: descriptor.environmentName,
    projectId: descriptor.projectId,
    ...(descriptor.tombstonedAt ? { closed: true } : {}),
    canReceive: !descriptor.tombstonedAt && descriptor.capabilities.canPull,
  };
}

/** A sender whose mailbox is gone still has a name: the one its messages carry. */
function actorParticipant(actor: MailActor): AgentMailParticipant {
  const key = agentMailParticipantKey(actor);
  switch (actor.kind) {
    case "tab":
    case "coordinator":
      return {
        key,
        kind: actor.kind === "coordinator" ? "coordinator" : "agent",
        displayName:
          actor.title || (actor.kind === "coordinator" ? "Project coordinator" : "Closed tab"),
        agent: actor.agent,
        environmentId: actor.environmentId,
        tabId: actor.tabId,
        projectId: actor.projectId,
        closed: true,
        canReceive: false,
      };
    case "user":
      return { key, kind: "user", displayName: "You", agent: null, canReceive: false };
    case "external":
      return {
        key,
        kind: "external",
        displayName: "External client",
        agent: null,
        canReceive: false,
      };
    case "system":
      return {
        key,
        kind: "workflow",
        displayName: "Orkestrator workflow",
        agent: null,
        projectId: actor.projectId,
        canReceive: false,
      };
    case "node":
      return {
        key,
        kind: actor.role === "coordinator" ? "coordinator" : "agent",
        displayName: `${actor.title || (actor.role === "coordinator" ? "Project coordinator" : actor.tabId)} on ${actor.nodeName}`,
        agent: null,
        projectId: actor.projectId,
        canReceive: false,
      };
  }
}

/** Every retained message, keyed by the conversation it belongs to. */
function messagesByConversation(
  mailboxes: readonly ConversationMailbox[],
  cutoff: number,
): Map<string, { a: string; b: string; messages: AgentMailMessage[]; senders: MailActor[] }> {
  const conversations = new Map<
    string,
    { a: string; b: string; messages: AgentMailMessage[]; senders: MailActor[] }
  >();
  for (const mailbox of mailboxes) {
    const recipient = mailbox.descriptor.mailboxId;
    for (const message of mailbox.messages) {
      if (Date.parse(message.createdAt) < cutoff) continue;
      const sender = agentMailParticipantKey(message.from);
      const key = agentMailConversationKey(sender, recipient);
      let conversation = conversations.get(key);
      if (!conversation) {
        conversation = { a: sender, b: recipient, messages: [], senders: [] };
        conversations.set(key, conversation);
      }
      conversation.messages.push(message);
      conversation.senders.push(message.from);
    }
  }
  return conversations;
}

function resolveParticipant(
  key: string,
  byId: ReadonlyMap<string, MailboxDescriptor>,
  senders: readonly MailActor[],
): AgentMailParticipant {
  const descriptor = byId.get(key);
  if (descriptor) return mailboxParticipant(descriptor);
  const actor = senders.findLast((candidate) => agentMailParticipantKey(candidate) === key);
  if (actor) return actorParticipant(actor);
  if (key === "user") return actorParticipant({ kind: "user" });
  if (key === "external") return actorParticipant({ kind: "external" });
  return {
    key,
    kind: "agent",
    displayName: "Closed tab",
    agent: null,
    closed: true,
    canReceive: false,
  };
}

/**
 * Order a pair for display: the focused participant first, and the person
 * always second, so "You" sits on the sending side of the thread.
 */
function orderParticipants(
  pair: [AgentMailParticipant, AgentMailParticipant],
  focus?: string,
): [AgentMailParticipant, AgentMailParticipant] {
  const [first, second] = pair;
  if (first.kind === "user") return [second, first];
  if (second.kind === "user") return pair;
  if (focus && second.key === focus) return [second, first];
  if (focus && first.key === focus) return pair;
  return first.displayName.localeCompare(second.displayName) <= 0 ? pair : [second, first];
}

/**
 * One summary per pair that has exchanged mail, those needing the person
 * first, then the most recent. `participant` keeps only that participant's
 * conversations.
 */
export function listAgentMailConversations(
  mailboxes: readonly ConversationMailbox[],
  options: { cutoff: number; participant?: string },
): AgentMailConversationSummary[] {
  const byId = new Map(
    mailboxes.map((mailbox) => [mailbox.descriptor.mailboxId, mailbox.descriptor]),
  );
  const summaries: AgentMailConversationSummary[] = [];
  for (const [key, conversation] of messagesByConversation(mailboxes, options.cutoff)) {
    if (
      options.participant &&
      conversation.a !== options.participant &&
      conversation.b !== options.participant
    ) {
      continue;
    }
    let last = conversation.messages[0]!;
    let attentionCount = 0;
    for (const message of conversation.messages) {
      if (compareMessages(message, last) > 0) last = message;
      if (agentMailNeedsAttention(message)) attentionCount += 1;
    }
    summaries.push({
      key,
      participants: orderParticipants(
        [
          resolveParticipant(conversation.a, byId, conversation.senders),
          resolveParticipant(conversation.b, byId, conversation.senders),
        ],
        options.participant,
      ),
      lastMessage: summary(last),
      lastPreview: preview(last.body),
      messageCount: conversation.messages.length,
      attentionCount,
    });
  }
  return summaries
    .sort(
      (first, second) =>
        Number(second.attentionCount > 0) - Number(first.attentionCount > 0) ||
        second.lastMessage.createdAt.localeCompare(first.lastMessage.createdAt),
    )
    .slice(0, AGENT_MAIL_MAX_CONVERSATIONS);
}

/** Whether a message filed in `recipient`'s mailbox passed between `a` and `b`. */
export function isAgentMailConversationMessage(
  recipient: string,
  message: Pick<AgentMailMessage, "from">,
  a: string,
  b: string,
): boolean {
  const sender = agentMailParticipantKey(message.from);
  return (sender === a && recipient === b) || (sender === b && recipient === a);
}

/** The most recent `limit` messages between two participants, oldest first. */
export function agentMailConversationBetween(
  mailboxes: readonly ConversationMailbox[],
  a: string,
  b: string,
  options: { cutoff: number; limit?: number; revision: number },
): AgentMailConversation {
  const limit = Math.min(
    AGENT_MAIL_MAX_LIST_LIMIT,
    Math.max(1, Math.trunc(options.limit ?? AGENT_MAIL_DEFAULT_CONVERSATION_LIMIT)),
  );
  const byId = new Map(
    mailboxes.map((mailbox) => [mailbox.descriptor.mailboxId, mailbox.descriptor]),
  );
  const messages: AgentMailMessage[] = [];
  for (const key of a === b ? [a] : [a, b]) {
    const mailbox = mailboxes.find((candidate) => candidate.descriptor.mailboxId === key);
    for (const message of mailbox?.messages ?? []) {
      if (Date.parse(message.createdAt) < options.cutoff) continue;
      if (isAgentMailConversationMessage(key, message, a, b)) messages.push(message);
    }
  }
  messages.sort(compareMessages);
  const senders = messages.map((message) => message.from);
  return {
    revision: options.revision,
    key: agentMailConversationKey(a, b),
    participants: orderParticipants([
      resolveParticipant(a, byId, senders),
      resolveParticipant(b, byId, senders),
    ]),
    messages: messages.slice(-limit),
    total: messages.length,
  };
}
