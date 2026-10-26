import {
  AGENT_MAIL_MAX_PENDING_INJECTS,
  AGENT_MAIL_MAX_STORE_BYTES,
  AGENT_MAIL_MAX_THREAD_HOPS,
  AgentMailError,
  agentMailCapabilities,
  agentMailRouteWakes,
  isAgentMailBudgetHeld,
  type AgentMailMessage,
  type AgentMailMessageSummary,
  type AgentMessagingSettings,
  type MailboxKind,
  type NodeMailActor,
} from "@orkestrator/protocol/agent-mail";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { COORDINATOR_DELEGATION_HOLD_REASON } from "@orkestrator/protocol/coordinator";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";

export type PersistedMailbox = {
  mailboxId: string;
  incarnationId: string;
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  environmentStatus: string;
  tabId: string;
  tabType: string;
  title: string | null;
  displayName?: string;
  tabOrdinal?: number;
  agent: AgentPlatform | null;
  kind: MailboxKind;
  locked: boolean;
  injectOverride: "inherit" | "off" | "idle";
  mutedInbound: boolean;
  mutedOutbound: boolean;
  tombstonedAt?: string;
  messages: AgentMailMessage[];
  revision: number;
  ownerKind?: "environment" | "coordinator";
  coordinatorId?: string;
  conversationId?: string;
  /** Main coordinator or side agent; only on coordinator mailboxes. */
  coordinatorRole?: "main" | "side";
  /** Mail address of the main coordinator whose coordinator created this environment. */
  coordinatorOrigin?: string;
  /**
   * Store revision at which a person or a new request last reset this tab's
   * routed budgets. Routed mail sequenced at or before it no longer counts.
   */
  budgetResetSequence?: number;
  logicalSessionKey?: string;
};

type IdempotencyRecord = {
  senderScope: string;
  requestId: string;
  fingerprint: string;
  createdAt: string;
  mailboxId?: string;
  messageId?: string;
  bounce?: AgentMailMessage;
};

export type PersistedAgentMailStore = {
  version: 1;
  revision: number;
  mailboxes: Record<string, PersistedMailbox>;
  idempotency: Record<string, IdempotencyRecord>;
  pendingInject: Array<{
    mailboxId: string;
    messageId: string;
    nextAttemptAt?: string;
    attempts?: number;
    lastHoldReason?: string;
    /**
     * Not before this time, whatever the recipient's presence. Busy backoff
     * (`nextAttemptAt`) resets on an activity edge; a failed dispatch must
     * not, or a recipient that keeps refusing would be retried every pass.
     */
    retryAt?: string;
    retryAttempts?: number;
    verificationAttempts?: number;
    /** An ambiguous dispatch to confirm against the session journal before resending. */
    verifyRequestId?: string;
    /** `retryAt` is a coalescing window other notices may join, not a failure backoff. */
    coalescing?: true;
    /**
     * The person pressed Deliver now: if the recipient is mid-turn, the next
     * dispatch steers into that turn rather than waiting for it to end. One
     * attempt; any settlement clears it.
     */
    steerRequested?: true;
    /**
     * The steer request id of the dispatch in flight (stamped at claim) or
     * awaiting confirmation (with `verifyRequestId`). Restart recovery and
     * verification ask the steer journal under it.
     */
    steerRequestId?: string;
  }>;
  counterparts: Record<string, AgentMailMessageSummary>;
  /**
   * Budget epochs of pairs whose one side is a sender on another node, which
   * has no mailbox here to carry the epoch: keyed by `pairEpochKey`.
   */
  pairEpochs?: Record<string, number>;
};

export type AgentMailSender =
  | { kind: "tab"; environmentId: string; projectId: string; tabId: string }
  | {
      kind: "coordinator";
      projectId: string;
      coordinatorId: string;
      conversationId: string;
      environmentId: string;
      tabId: string;
    }
  | { kind: "user" }
  | { kind: "system"; projectId: string; source: "workflow"; resourceId: string }
  | { kind: "external" }
  /** Mail across the node link; see `NodeMailActor`. */
  | NodeMailActor;

function emptyStore(): PersistedAgentMailStore {
  return {
    version: 1,
    revision: 0,
    mailboxes: {},
    idempotency: {},
    pendingInject: [],
    counterparts: {},
  };
}

export function metadataMessage(message: AgentMailMessage): AgentMailMessageSummary {
  const { body: _body, ...summary } = message;
  return summary;
}

/**
 * Whether a message is past the thread hop limit. Routed mail (it carries an
 * `autonomousSequence`) is bounded by the pair budget at send time instead,
 * where it is held rather than refused, so its depth is not a limit here.
 */
export function exceedsThreadHops(message: AgentMailMessage): boolean {
  return (
    message.autonomousSequence === undefined && message.threadDepth >= AGENT_MAIL_MAX_THREAD_HOPS
  );
}

export function countsAsPendingInject(
  message: AgentMailMessage | AgentMailMessageSummary,
): boolean {
  return (
    message.placement === "pending-inject" ||
    (message.placement === "inject-held" &&
      (isAgentMailBudgetHeld(message) ||
        // Held until its delegation completes, not withheld from delivery: it
        // is still on its way to the recipient, so it counts as pending.
        message.placementReason === COORDINATOR_DELEGATION_HOLD_REASON))
  );
}

/**
 * Whether a stored message may be woken despite a non-zero inject depth.
 *
 * Inject depth exists to stop an injected tab's replies from waking anyone, so
 * two tabs cannot ping-pong unattended. Routed mail is instead bounded by the
 * pair hop budget, so a reply is as deliverable as the message it answers.
 */
export function routedMessageWakes(
  message: AgentMailMessage,
  mailbox: PersistedMailbox,
  settings: Pick<AgentMessagingSettings, "wakePeers">,
): boolean {
  return agentMailRouteWakes(message.route, mailbox.injectOverride, settings);
}

function storeByteLength(store: PersistedAgentMailStore): number {
  return Buffer.byteLength(JSON.stringify(store, null, 2), "utf8") + 1;
}

export function findMessage(
  store: PersistedAgentMailStore,
  messageId: string,
): { mailbox: PersistedMailbox; message: AgentMailMessage } | null {
  for (const mailbox of Object.values(store.mailboxes)) {
    const message = mailbox.messages.find((candidate) => candidate.id === messageId);
    if (message) return { mailbox, message };
  }
  return null;
}

/**
 * Move a mailbox's stored, unhandled mail onto the inject queue. Callers own
 * the mutation lock and the save. Mail addressed to an earlier incarnation of
 * the tab is left alone: the claim would refuse it, and it would sit in
 * `pending-inject` for good.
 *
 * `routed` promotes only mail whose route wakes the recipient on its own —
 * what an explicit Off was holding back — and leaves policy-governed mail
 * stored, since the drain would never claim it.
 */
export function promoteStoredMessages(
  store: PersistedAgentMailStore,
  mailbox: PersistedMailbox,
  settings: Pick<AgentMessagingSettings, "wakePeers">,
  scope: "all" | "routed",
): number {
  if (!agentMailCapabilities(mailbox.tabType, mailbox.agent, mailbox.locked).canInject) return 0;
  if (mailbox.tombstonedAt || mailbox.mutedInbound) return 0;
  let promoted = 0;
  for (const message of mailbox.messages) {
    if (
      message.placement !== "stored" ||
      message.toIncarnationId !== mailbox.incarnationId ||
      message.ackedAt ||
      message.discardedAt ||
      (message.injectDepth !== 0 && !routedMessageWakes(message, mailbox, settings)) ||
      (scope === "routed" && !routedMessageWakes(message, mailbox, settings)) ||
      exceedsThreadHops(message) ||
      message.trust === "cross-project" ||
      message.trust === "external"
    ) {
      continue;
    }
    message.placement = "pending-inject";
    delete message.placementReason;
    message.injectRequestId ??= `mail-inject-${message.id}`;
    if (
      !store.pendingInject.some(
        (candidate) =>
          candidate.mailboxId === mailbox.mailboxId && candidate.messageId === message.id,
      )
    ) {
      store.pendingInject.push({ mailboxId: mailbox.mailboxId, messageId: message.id });
    }
    message.revision += 1;
    promoted += 1;
  }
  return promoted;
}

/**
 * The agent mail store (`agent-mail.json`) and its lease: what the mail
 * repository and its collaborators (mailbox directory, inject queue and
 * budgets) share. Every read-modify-write runs inside {@link enqueue}.
 */
export class AgentMailStore {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
  ) {}

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(this.files.agentMailFile(), "agent mail storage", operation);
  }

  async load(): Promise<PersistedAgentMailStore> {
    const value = await this.context.loadJsonCached<unknown>(
      this.files.agentMailFile(),
      emptyStore,
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Agent mail store is malformed");
    }
    const record = value as Partial<PersistedAgentMailStore>;
    if (record.version !== 1 || !record.mailboxes || !record.idempotency) {
      throw new Error("Unsupported agent mail store");
    }
    const store = value as PersistedAgentMailStore;
    store.revision = Number.isSafeInteger(store.revision) ? store.revision : 0;
    const pendingByMessage = new Map(
      (store.pendingInject ?? []).map((entry) => [`${entry.mailboxId}\0${entry.messageId}`, entry]),
    );
    store.pendingInject = [];
    store.counterparts ??= {};
    for (const mailbox of Object.values(store.mailboxes)) {
      mailbox.messages ??= [];
      mailbox.injectOverride ??= "inherit";
      mailbox.mutedInbound ??= false;
      mailbox.mutedOutbound ??= false;
      for (const message of mailbox.messages) {
        if (
          message.placement === "pending-inject" ||
          (message.placement === "inject-held" && message.placementReason === "submitting")
        ) {
          store.pendingInject.push({
            mailboxId: mailbox.mailboxId,
            messageId: message.id,
            ...pendingByMessage.get(`${mailbox.mailboxId}\0${message.id}`),
          });
        }
      }
    }
    return store;
  }

  async save(store: PersistedAgentMailStore): Promise<void> {
    if (store.pendingInject.length > AGENT_MAIL_MAX_PENDING_INJECTS) {
      throw new AgentMailError("mailbox-backlog-full", "Too many messages are awaiting injection");
    }
    if (storeByteLength(store) > AGENT_MAIL_MAX_STORE_BYTES) {
      throw new AgentMailError("store-full", "Agent mail store has reached its size limit");
    }
    await this.context.saveSensitiveJson(this.files.agentMailFile(), store);
  }
}
