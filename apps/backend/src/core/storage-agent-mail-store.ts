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
import { STORAGE_COLLECTION_MARKER } from "@orkestrator/protocol/node/storage-database";
import { COORDINATOR_DELEGATION_HOLD_REASON } from "@orkestrator/protocol/coordinator";
import type { StorageContext } from "./storage-context.js";
import { StoreTooLargeError, type StorageDatabase } from "./storage-database.js";
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

/** A parsed row of the read model and the serialized value it came from. */
type ParsedRow = { value: string; parsed: unknown };

function checkedStore(value: unknown): PersistedAgentMailStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent mail store is malformed");
  }
  const record = value as Partial<PersistedAgentMailStore>;
  if (record.version !== 1 || !record.mailboxes || !record.idempotency) {
    throw new Error("Unsupported agent mail store");
  }
  return value as PersistedAgentMailStore;
}

/** Defaults for fields older mailboxes lack. Changes `mailbox` in place. */
function normalizeMailbox(mailbox: PersistedMailbox): PersistedMailbox {
  mailbox.messages ??= [];
  mailbox.injectOverride ??= "inherit";
  mailbox.mutedInbound ??= false;
  mailbox.mutedOutbound ??= false;
  return mailbox;
}

/**
 * Store-level defaults, and the inject queue rebuilt from the messages that
 * are awaiting injection (keeping each entry's stored retry state). Reads the
 * mailboxes, which must already be normalized, without changing them.
 */
function normalizeStore(store: PersistedAgentMailStore): PersistedAgentMailStore {
  store.revision = Number.isSafeInteger(store.revision) ? store.revision : 0;
  const pendingByMessage = new Map(
    (store.pendingInject ?? []).map((entry) => [`${entry.mailboxId}\0${entry.messageId}`, entry]),
  );
  store.pendingInject = [];
  store.counterparts ??= {};
  for (const mailbox of Object.values(store.mailboxes)) {
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

/** Freezes `value` and everything reachable from it, skipping frozen subtrees. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
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
  /** {@link snapshot}'s last result and the parsed rows it was built from. */
  private readModel: {
    /** The connection the revision belongs to; a reopened one rebuilds. */
    database: StorageDatabase;
    revision: number;
    store: PersistedAgentMailStore;
    rows: Map<string, ParsedRow>;
  } | null = null;

  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
  ) {}

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(this.files.agentMailFile(), "agent mail storage", operation);
  }

  /**
   * A fresh copy of the committed store that the caller may mutate and
   * {@link save}. It parses every row, so only read-modify-write paths use it;
   * read-only callers use {@link snapshot}.
   */
  async load(): Promise<PersistedAgentMailStore> {
    const value = await this.context.loadJsonCached<unknown>(
      this.files.agentMailFile(),
      emptyStore,
    );
    const store = checkedStore(value);
    for (const mailbox of Object.values(store.mailboxes)) normalizeMailbox(mailbox);
    return normalizeStore(store);
  }

  /**
   * The committed store as one shared, deeply frozen value, for read-only
   * callers. It is kept between calls and rebuilt when the store's committed
   * revision moves, which every writer bumps in this or any other process, so
   * a read never sees an older store than {@link load} would. A rebuild
   * parses only the rows whose serialized value changed since the last one;
   * an unchanged store costs one revision query.
   *
   * Never mutate the result or anything reached from it (it is frozen, so a
   * write throws), and take a mutable copy from {@link load} inside
   * {@link enqueue} to change the store.
   */
  async snapshot(): Promise<PersistedAgentMailStore> {
    const serialized = this.context.loadStoreSerialized(this.files.agentMailFile());
    if (serialized === null) {
      this.readModel = null;
      return deepFreeze(normalizeStore(checkedStore(emptyStore())));
    }
    // Buffered by an atomic scope, or stored whole: no rows to reuse.
    if (serialized === undefined || serialized.mode === "document") {
      this.readModel = null;
      return deepFreeze(await this.load());
    }
    const database = this.context.database;
    if (this.readModel?.database === database && this.readModel.revision === serialized.revision) {
      return this.readModel.store;
    }
    // Reusing a parsed row needs only its serialized value to match, whatever
    // the revision or connection it was read under.
    const previous = this.readModel?.rows;
    const rows = new Map<string, ParsedRow>();
    let store: PersistedAgentMailStore;
    try {
      const envelope =
        serialized.document === null
          ? {}
          : (JSON.parse(serialized.document) as Record<string, unknown>);
      for (const [field, value] of Object.entries(envelope)) {
        if (value === STORAGE_COLLECTION_MARKER) envelope[field] = {};
      }
      // Assembled in the order `assembleStoredValue` uses, so collections
      // iterate exactly as they do in a loaded copy.
      const ordered = [...serialized.rows].sort((a, b) => a.position - b.position);
      for (const row of ordered) {
        const id = `${row.collection}\u0000${row.key}`;
        const known = previous?.get(id);
        const parsed =
          known && known.value === row.value
            ? known.parsed
            : deepFreeze(
                row.collection === "mailboxes"
                  ? normalizeMailbox(JSON.parse(row.value) as PersistedMailbox)
                  : (JSON.parse(row.value) as unknown),
              );
        rows.set(id, { value: row.value, parsed });
        const target = envelope[row.collection];
        const records =
          target && typeof target === "object" && !Array.isArray(target)
            ? (target as Record<string, unknown>)
            : (envelope[row.collection] = {} as Record<string, unknown>);
        records[row.key] = parsed;
      }
      store = normalizeStore(checkedStore(envelope));
    } catch (error) {
      // An unreadable row reads as `load` reads it (an absent store).
      if (!(error instanceof SyntaxError)) throw error;
      this.readModel = null;
      return deepFreeze(await this.load());
    }
    deepFreeze(store);
    this.readModel = { database, revision: serialized.revision, store, rows };
    return store;
  }

  async save(store: PersistedAgentMailStore): Promise<void> {
    if (store.pendingInject.length > AGENT_MAIL_MAX_PENDING_INJECTS) {
      throw new AgentMailError("mailbox-backlog-full", "Too many messages are awaiting injection");
    }
    try {
      // Measured on the serialized rows the write produces anyway, rather
      // than by serializing the whole store a second time.
      await this.context.saveSensitiveJson(this.files.agentMailFile(), store, {
        maxBytes: AGENT_MAIL_MAX_STORE_BYTES,
      });
    } catch (error) {
      if (!(error instanceof StoreTooLargeError)) throw error;
      throw new AgentMailError("store-full", "Agent mail store has reached its size limit");
    }
  }
}
