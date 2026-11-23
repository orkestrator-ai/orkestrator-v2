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
  type AgentMailSystemSource,
  type AgentMessagingSettings,
  type MailboxKind,
  type MailboxPipelineWorker,
  type NodeMailActor,
} from "@orkestrator/protocol/agent-mail";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { STORAGE_COLLECTION_MARKER } from "@orkestrator/protocol/node/storage-database";
import { COORDINATOR_DELEGATION_HOLD_REASON } from "@orkestrator/protocol/coordinator";
import {
  AgentMailKeyedRows,
  mailRowId,
  type AgentMailRowCollection,
  type ParsedMailRow,
} from "./agent-mail-keyed-rows.js";
import type { StorageContext } from "./context.js";
import type { RowSelection } from "./database-queries.js";
import { StoreTooLargeError, type StorageDatabase } from "./database.js";
import type { StorageFiles } from "./files.js";

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
  /** Last admitted merge notice; retained with the mailbox, independently of mail retention. */
  mergeNoticeRequestId?: string;
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
  /** A build pipeline worker's mailbox: which worker, and its last observed status. */
  pipelineWorker?: MailboxPipelineWorker;
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
      /** The conversation's turn was not started by the user; see `MailActor`. */
      turnOrigin?: "mail";
    }
  | { kind: "user" }
  | { kind: "system"; projectId: string; source: AgentMailSystemSource; resourceId: string }
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
 * Whether a message is past the reply hop limit. Routed mail also has a
 * resettable pair budget (`threadDepth`); its transport-independent hop count
 * still bounds a single thread across nodes, independently of budget resets.
 */
export function exceedsThreadHops(message: AgentMailMessage): boolean {
  return (
    (message.hopCount ?? 0) >= AGENT_MAIL_MAX_THREAD_HOPS ||
    (message.autonomousSequence === undefined && message.threadDepth >= AGENT_MAIL_MAX_THREAD_HOPS)
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

/** Whether a message belongs on the inject queue (`pendingInject`). */
export function isQueuedForInject(message: AgentMailMessage | AgentMailMessageSummary): boolean {
  return (
    message.placement === "pending-inject" ||
    (message.placement === "inject-held" && message.placementReason === "submitting")
  );
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
      if (isQueuedForInject(message)) {
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

/** Mail is JSON data only. Copy without structuredClone's serialization pass. */
export function cloneMailValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneMailValue) as T;
  if (value && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const child = cloneMailValue((value as Record<string, unknown>)[key]);
      if (key === "__proto__") {
        Object.defineProperty(copy, key, {
          value: child,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        copy[key] = child;
      }
    }
    return copy as T;
  }
  return value;
}

/** Freezes `value` and everything reachable from it, skipping frozen subtrees. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** One stored row, parsed (a mailbox normalized) and deeply frozen. */
function parseMailRow(collection: string, value: string): unknown {
  return deepFreeze(
    collection === "mailboxes"
      ? normalizeMailbox(JSON.parse(value) as PersistedMailbox)
      : (JSON.parse(value) as unknown),
  );
}

/**
 * Whether an envelope document is one {@link checkedStore} would accept, so
 * a keyed read answers only where the whole-store read would. Collections
 * appear as markers (or are absent) in a row-held envelope.
 */
function envelopeMailRevision(document: string): number | null {
  const envelope = JSON.parse(document) as unknown;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const record = envelope as Record<string, unknown>;
  if (record.version !== 1 || !record.mailboxes || !record.idempotency) return null;
  return Number.isSafeInteger(record.revision) ? (record.revision as number) : 0;
}

export function findMessage(
  store: PersistedAgentMailStore,
  messageId: string,
): { key: string; mailbox: PersistedMailbox; message: AgentMailMessage } | null {
  for (const [key, mailbox] of Object.entries(store.mailboxes)) {
    const message = mailbox.messages.find((candidate) => candidate.id === messageId);
    if (message) return { key, mailbox, message };
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
 * stored, since the drain would never claim it. `awaiting-agent` recovers only
 * mail filed because the recipient lacked injection capability; routine
 * synchronization must not release other policy-held mail.
 */
export function promoteStoredMessages(
  store: PersistedAgentMailStore,
  mailbox: PersistedMailbox,
  settings: Pick<AgentMessagingSettings, "wakePeers">,
  scope: "all" | "routed" | "awaiting-agent",
): number {
  if (!agentMailCapabilities(mailbox.tabType, mailbox.agent, mailbox.locked).canInject) return 0;
  if (mailbox.tombstonedAt || mailbox.mutedInbound) return 0;
  let promoted = 0;
  for (const message of mailbox.messages) {
    if (
      message.placement !== "stored" ||
      (scope === "awaiting-agent" && message.placementReason !== "recipient-cannot-inject") ||
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
    rows: Map<string, ParsedMailRow>;
  } | null = null;

  /** Parsed rows of keyed reads and where messages were last seen. */
  private readonly keyed = new AgentMailKeyedRows();
  /** The last committed revision at which a keyed read found the envelope supported. */
  private supportedEnvelope: {
    database: StorageDatabase;
    revision: number;
    mailRevision: number;
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
   * {@link save}. Reuse the revision-validated read model, which parses only
   * changed rows. Clone it so mutations (including abandoned/failed writes)
   * cannot change a committed snapshot. Read-only callers use {@link snapshot}.
   */
  async load(): Promise<PersistedAgentMailStore> {
    return cloneMailValue(await this.snapshot());
  }

  /** Whole/document and atomic-buffer fallback; never calls the read model. */
  private async loadUncached(): Promise<PersistedAgentMailStore> {
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
      return deepFreeze(await this.loadUncached());
    }
    const database = this.context.database;
    if (this.readModel?.database === database && this.readModel.revision === serialized.revision) {
      return this.readModel.store;
    }
    // Reusing a parsed row needs only its serialized value to match, whatever
    // the revision or connection it was read under.
    const previous = this.readModel?.rows;
    const rows = new Map<string, ParsedMailRow>();
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
        let parsed: unknown;
        if (known && known.value === row.value) {
          parsed = known.parsed;
        } else {
          parsed = this.keyed.cached(id, row.value) ?? parseMailRow(row.collection, row.value);
          this.keyed.index(row.collection as AgentMailRowCollection, row.key, parsed);
        }
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
      return deepFreeze(await this.loadUncached());
    }
    deepFreeze(store);
    this.readModel = { database, revision: serialized.revision, store, rows };
    return store;
  }

  /**
   * One committed mailbox by id, as {@link snapshot} would hold it (normalized
   * and deeply frozen), reading and parsing only that mailbox's row: what a
   * mailbox's own reads cost no longer grows with everyone else's retained
   * mail or with how recently someone wrote. Falls back to the whole
   * {@link snapshot} where the store has no rows to select (held whole,
   * buffered by an atomic scope, unreadable or of an unsupported version).
   */
  async mailbox(mailboxId: string): Promise<PersistedMailbox | undefined> {
    const selected = this.selectRows("mailboxes", { keys: [mailboxId] });
    if (!selected) return (await this.snapshot()).mailboxes[mailboxId];
    return selected.rows[0]?.parsed as PersistedMailbox | undefined;
  }

  /**
   * The committed mailboxes of one environment, keyed like {@link mailbox}:
   * every mailbox id is `agentMailboxId(environmentId, tabId)`, so they are
   * one key range. In stored order.
   */
  async environmentMailboxes(environmentId: string): Promise<PersistedMailbox[]> {
    if (!environmentId || environmentId.includes("\0")) return [];
    const selected = this.selectRows("mailboxes", { keyPrefix: `${environmentId}\0` });
    const mailboxes = selected
      ? selected.rows.map((row) => row.parsed as PersistedMailbox)
      : Object.values((await this.snapshot()).mailboxes);
    return mailboxes.filter((mailbox) => mailbox.environmentId === environmentId);
  }

  /** Requested mailboxes in caller order, with the mail revision from the same snapshot. */
  async mailboxesById(
    keys: string[],
  ): Promise<{ revision: number; mailboxes: PersistedMailbox[] }> {
    const selected = this.selectRows("mailboxes", { keys });
    if (!selected) {
      const store = await this.snapshot();
      return {
        revision: store.revision,
        mailboxes: keys.flatMap((key) => store.mailboxes[key] ?? []),
      };
    }
    const byKey = new Map(selected.rows.map((row) => [row.key, row.parsed as PersistedMailbox]));
    return {
      revision: selected.mailRevision,
      mailboxes: keys.flatMap((key) => byKey.get(key) ?? []),
    };
  }

  /**
   * A message's committed status by id. Verify the last known location, then
   * try its counterpart row. A successful whole-store search relearns the key
   * even if the matching row's parse was already cached.
   */
  async messageStatus(messageId: string): Promise<AgentMailMessageSummary | undefined> {
    const location = this.keyed.locate(messageId);
    if (location) {
      const row = this.selectRows(location.collection, { keys: [location.key] })?.rows[0];
      const message =
        location.collection === "mailboxes"
          ? (row?.parsed as PersistedMailbox | undefined)?.messages.find(
              (candidate) => candidate.id === messageId,
            )
          : (row?.parsed as IdempotencyRecord | undefined)?.bounce;
      if (message?.id === messageId) {
        this.keyed.rememberLocation(messageId, location);
        return metadataMessage(message);
      }
    }
    const counterpart = this.selectRows("counterparts", { keys: [messageId] })?.rows[0];
    if (counterpart?.parsed) return counterpart.parsed as AgentMailMessageSummary;

    const store = await this.snapshot();
    const located = findMessage(store, messageId);
    if (located) {
      this.keyed.rememberLocation(messageId, { collection: "mailboxes", key: located.key });
      return metadataMessage(located.message);
    }
    if (store.counterparts[messageId]) return store.counterparts[messageId];
    for (const [key, row] of Object.entries(store.idempotency)) {
      if (row.bounce?.id === messageId) {
        this.keyed.rememberLocation(messageId, { collection: "idempotency", key });
        return metadataMessage(row.bounce);
      }
    }
    return undefined;
  }

  /**
   * Committed rows of one collection, parsed and frozen, reusing the read
   * model's or an earlier keyed read's parse of an unchanged value. `null`
   * when the caller must read the whole {@link snapshot} instead.
   */
  private selectRows(
    collection: AgentMailRowCollection,
    selection: RowSelection,
  ): { mailRevision: number; rows: Array<{ key: string; parsed: unknown }> } | null {
    const database = this.context.database;
    const selected = this.context.loadStoreRowsSerialized(
      this.files.agentMailFile(),
      collection,
      selection,
      this.supportedEnvelope?.database === database
        ? { documentKnownAt: this.supportedEnvelope.revision }
        : {},
    );
    if (selected === null) return { mailRevision: 0, rows: [] };
    if (selected === undefined || selected.mode === "document") return null;
    try {
      // Checked once per committed revision: a revision is never reused.
      let envelope = this.supportedEnvelope;
      if (selected.document !== undefined) {
        const mailRevision =
          selected.document === null ? null : envelopeMailRevision(selected.document);
        if (mailRevision === null) return null;
        envelope = { database, revision: selected.revision, mailRevision };
        this.supportedEnvelope = envelope;
      }
      if (!envelope) return null;
      const rows = selected.rows.map(({ key, value }) => {
        const id = mailRowId(collection, key);
        const modelled = this.readModel?.rows.get(id);
        if (modelled?.value === value) return { key, parsed: modelled.parsed };
        const cached = this.keyed.cached(id, value);
        if (cached !== undefined) return { key, parsed: cached };
        const parsed = parseMailRow(collection, value);
        this.keyed.remember(id, { value, parsed });
        this.keyed.index(collection, key, parsed);
        return { key, parsed };
      });
      return { mailRevision: envelope.mailRevision, rows };
    } catch (error) {
      // An unreadable row or envelope reads as the whole-store read reads it.
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  /**
   * Commits a change to a few rows without loading or reserializing the rest
   * of the store, for a mutation computed from {@link snapshot} or keyed reads
   * under {@link enqueue}: `mailboxes`, `idempotency` and `counterparts` rows
   * to write (`undefined` deletes one), and the store's next `revision` and
   * `pendingInject`, which live in the envelope document. `revision: "next"`
   * bumps the committed revision, and a function derives the queue from the
   * committed one, for a writer that did not read the envelope. Bounded as
   * {@link save} is, except that a change that shrinks the store always
   * commits. `false`, writing nothing, when the store must be saved whole
   * instead (see `StorageContext.updateStoreRows`): take a copy with
   * {@link load} and {@link save} it.
   */
  saveRows(change: {
    rows: ReadonlyArray<{
      collection: AgentMailRowCollection;
      key: string;
      value: unknown;
    }>;
    revision: number | "next";
    pendingInject:
      | PersistedAgentMailStore["pendingInject"]
      | ((
          committed: PersistedAgentMailStore["pendingInject"],
        ) => PersistedAgentMailStore["pendingInject"]);
  }): boolean {
    const assertQueueBound = (queue: PersistedAgentMailStore["pendingInject"]) => {
      if (queue.length > AGENT_MAIL_MAX_PENDING_INJECTS) {
        throw new AgentMailError(
          "mailbox-backlog-full",
          "Too many messages are awaiting injection",
        );
      }
    };
    if (typeof change.pendingInject !== "function") assertQueueBound(change.pendingInject);
    // Locations are hints a reader verifies, so recording them before the
    // commit is safe even when it fails.
    for (const row of change.rows) {
      if (row.value !== undefined) this.keyed.index(row.collection, row.key, row.value);
    }
    try {
      return this.context.updateStoreRows(this.files.agentMailFile(), change.rows, {
        document: (envelope) => {
          envelope.revision =
            change.revision === "next"
              ? (Number.isSafeInteger(envelope.revision) ? (envelope.revision as number) : 0) + 1
              : change.revision;
          if (typeof change.pendingInject === "function") {
            const queue = change.pendingInject(
              Array.isArray(envelope.pendingInject)
                ? (envelope.pendingInject as PersistedAgentMailStore["pendingInject"])
                : [],
            );
            assertQueueBound(queue);
            envelope.pendingInject = queue;
          } else {
            envelope.pendingInject = change.pendingInject;
          }
        },
        maxBytes: AGENT_MAIL_MAX_STORE_BYTES,
      });
    } catch (error) {
      if (!(error instanceof StoreTooLargeError)) throw error;
      throw new AgentMailError("store-full", "Agent mail store has reached its size limit");
    }
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
    this.indexSaved(store);
  }

  /**
   * Learns where the messages a whole save added or moved live, so a status
   * read right after a send finds them by key. Only mailboxes whose revision
   * differs from the read model's copy (every change to a mailbox's messages
   * bumps it) and idempotency records the read model lacks are visited.
   */
  private indexSaved(store: PersistedAgentMailStore): void {
    const model = this.readModel?.store;
    for (const [key, mailbox] of Object.entries(store.mailboxes)) {
      if (model?.mailboxes[key]?.revision === mailbox.revision) continue;
      this.keyed.index("mailboxes", key, mailbox);
    }
    for (const [key, record] of Object.entries(store.idempotency)) {
      if (record.bounce && !model?.idempotency[key]) this.keyed.index("idempotency", key, record);
    }
  }
}
