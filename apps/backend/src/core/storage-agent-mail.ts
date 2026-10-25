import { createHash, randomUUID } from "node:crypto";
import {
  AGENT_MAIL_DEFAULT_LIST_LIMIT,
  AGENT_MAIL_MAX_BODY_BYTES,
  AGENT_MAIL_MAX_IDEMPOTENCY_ROWS,
  AGENT_MAIL_MAX_LIST_LIMIT,
  AGENT_MAIL_MAX_MAILBOXES,
  AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX,
  AGENT_MAIL_MAX_PENDING_INJECTS,
  AGENT_MAIL_MAX_REQUEST_ID_LENGTH,
  AGENT_MAIL_MAX_STORE_BYTES,
  AGENT_MAIL_MAX_SUBJECT_LENGTH,
  AGENT_MAIL_HOURLY_LIMIT_REASON,
  AGENT_MAIL_LOOP_BUDGET_REASON,
  AGENT_MAIL_MAX_THREAD_HOPS,
  AgentMailError,
  agentMailCapabilities,
  agentMailNeedsAttention,
  agentMailRouteWakes,
  agentMailboxId,
  isAgentMailBudgetHeld,
  classifyAgentMailRoute,
  normalizeAgentMailNotice,
  normalizeAgentMessagingSettings,
  resolveTabDisplayName,
  type AgentMailConversation,
  type AgentMailConversationList,
  type AgentMailMailboxSnapshot,
  type AgentMailMailboxBatchSnapshot,
  type AgentMailInboxSnapshot,
  type AgentMailMessage,
  type AgentMailMessageSummary,
  type AgentMailNotice,
  type AgentMailSendInput,
  type AgentMailSummarySnapshot,
  type AgentMailTrust,
  type AgentMessagingSettings,
  type MailActor,
  type MailboxDescriptor,
  type MailboxKind,
  type NodeMailActor,
  nodeMailSenderKey,
} from "@orkestrator/protocol/agent-mail";
import { isAgentPlatform, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  agentMailConversationBetween,
  isAgentMailConversationMessage,
  listAgentMailConversations,
  type ConversationMailbox,
} from "./agent-mail-conversations.js";
import { paneLayoutLeaves } from "./storage-shared.js";
import {
  COORDINATOR_DELEGATION_HOLD_REASON,
  COORDINATOR_MAIL_ADDRESS,
  coordinatorConversationIdFromRuntimeId,
  coordinatorIdFromRuntimeId,
  coordinatorMainConversation,
  coordinatorRuntimeId,
  type CoordinatorWorkflowAssociation,
  type CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";
import type { StorageRepositories } from "./storage-repositories.js";

type PersistedMailbox = {
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

type PersistedAgentMailStore = {
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
  }>;
  counterparts: Record<string, AgentMailMessageSummary>;
  /**
   * Budget epochs of pairs whose one side is a sender on another node, which
   * has no mailbox here to carry the epoch: keyed by `pairEpochKey`.
   */
  pairEpochs?: Record<string, number>;
};

/** Pairs whose epoch the store keeps (`pairEpochs`); the oldest are dropped. */
const MAX_PAIR_EPOCHS = 2_000;

function pairEpochKey(firstId: string, secondId: string): string {
  return firstId < secondId ? `${firstId}\n${secondId}` : `${secondId}\n${firstId}`;
}

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

export type PendingAgentMailInject = {
  mailbox: MailboxDescriptor;
  message: AgentMailMessage;
  deferredUntil?: string;
  /** Present when an earlier dispatch's outcome is unknown and must be confirmed first. */
  verifyRequestId?: string;
  retryAttempts?: number;
  verificationAttempts?: number;
  /**
   * A status notice still inside its coalescing hold, listed only when asked
   * for: it may join a batch going to the same mailbox, never start one.
   */
  coalescingUntil?: string;
};

/**
 * Delay before retrying a failed delivery: quick at first, then settling at a
 * quarter of an hour. A refused dispatch is retried for as long as the message
 * is retained, so nobody has to press Retry for mail to arrive eventually.
 */
const AGENT_MAIL_RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000];

export function agentMailRetryDelayMs(attempt: number): number {
  return AGENT_MAIL_RETRY_DELAYS_MS[
    Math.min(Math.max(attempt, 1), AGENT_MAIL_RETRY_DELAYS_MS.length) - 1
  ]!;
}

/** Inconclusive journal checks before an ambiguous dispatch is given up as failed. */
export const AGENT_MAIL_MAX_VERIFY_ATTEMPTS = 8;

const TERMINAL_TYPES = new Set(["claude", "codex", "opencode"]);
const WORKFLOW_TYPES = new Set(["claude-build", "looped-review", "multi-review"]);
const SETTLED_PLACEMENTS = new Set(["undeliverable", "bounced", "expired"]);

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

function metadataMessage(message: AgentMailMessage): AgentMailMessageSummary {
  const { body: _body, ...summary } = message;
  return summary;
}

/**
 * Whether a message is past the thread hop limit. Routed mail (it carries an
 * `autonomousSequence`) is bounded by the pair budget at send time instead,
 * where it is held rather than refused, so its depth is not a limit here.
 */
function exceedsThreadHops(message: AgentMailMessage): boolean {
  return (
    message.autonomousSequence === undefined && message.threadDepth >= AGENT_MAIL_MAX_THREAD_HOPS
  );
}

function countsAsPendingInject(message: AgentMailMessage | AgentMailMessageSummary): boolean {
  return (
    message.placement === "pending-inject" ||
    (message.placement === "inject-held" &&
      (isAgentMailBudgetHeld(message) ||
        // Held until its delegation completes, not withheld from delivery: it
        // is still on its way to the recipient, so it counts as pending.
        message.placementReason === COORDINATOR_DELEGATION_HOLD_REASON))
  );
}

function idempotencyKey(senderScope: string, requestId: string): string {
  return createHash("sha256").update(senderScope).update("\0").update(requestId).digest("hex");
}

function sendFingerprint(input: AgentMailSendInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        toEnvironmentId: input.toEnvironmentId,
        toTabId: input.toTabId,
        subject: input.subject ?? null,
        body: input.body,
        replyToMessageId: input.replyToMessageId ?? null,
      }),
    )
    .digest("hex");
}

let lastIdTime = 0;
let idSequence = 0;

/**
 * Ids sort in send order: a clock that never runs backwards, then a sequence
 * within one millisecond, then a random suffix. Without the sequence, two
 * sends in the same millisecond ordered by their random suffixes.
 */
function sortableId(): string {
  const now = Date.now();
  if (now > lastIdTime) {
    lastIdTime = now;
    idSequence = 0;
  } else {
    idSequence += 1;
  }
  return `${lastIdTime.toString(36).padStart(10, "0")}-${idSequence.toString(36).padStart(4, "0")}-${randomUUID()}`;
}

/**
 * Who a routed message is budgeted as: the sending tab's mailbox, or for a
 * workflow status notice its resource's stand-in (`statusBudgetKey`).
 */
function budgetSenderOf(message: AgentMailMessage): string | null {
  if (message.from.kind === "tab" || message.from.kind === "coordinator") {
    return agentMailboxId(message.from.environmentId, message.from.tabId);
  }
  if (message.from.kind === "node") return nodeMailSenderKey(message.from);
  return message.from.kind === "system" && message.statusBudgetKey ? message.statusBudgetKey : null;
}

/**
 * When a coalescing hold for this recipient ends: an open window if a notice
 * already started one, otherwise a new one. Joining rather than starting keeps
 * a burst of notices in one delivery instead of a chain of overlapping holds.
 */
function coalescingWindow(
  store: PersistedAgentMailStore,
  mailboxId: string,
  coalesceMs: number,
): string {
  const now = Date.now();
  const open = store.pendingInject
    .filter(
      (entry) =>
        entry.mailboxId === mailboxId &&
        entry.coalescing === true &&
        entry.retryAt !== undefined &&
        Date.parse(entry.retryAt) > now,
    )
    .map((entry) => entry.retryAt!)
    .sort()[0];
  return open ?? new Date(now + coalesceMs).toISOString();
}

function sameMailboxPair(
  message: AgentMailMessage,
  firstMailboxId: string,
  secondMailboxId: string,
): boolean {
  const from = budgetSenderOf(message);
  if (!from) return false;
  const to = agentMailboxId(message.toEnvironmentId, message.toTabId);
  return (
    (from === firstMailboxId && to === secondMailboxId) ||
    (from === secondMailboxId && to === firstMailboxId)
  );
}

/** The sequence at or before which a pair's routed mail no longer counts. */
function pairBudgetEpoch(
  store: PersistedAgentMailStore,
  firstMailboxId: string,
  secondMailboxId: string,
): number {
  return Math.max(
    store.mailboxes[firstMailboxId]?.budgetResetSequence ?? 0,
    store.mailboxes[secondMailboxId]?.budgetResetSequence ?? 0,
    store.pairEpochs?.[pairEpochKey(firstMailboxId, secondMailboxId)] ?? 0,
    ...[firstMailboxId, secondMailboxId].flatMap((id) =>
      (store.mailboxes[id]?.messages ?? [])
        .filter((message) => sameMailboxPair(message, firstMailboxId, secondMailboxId))
        .map((message) => message.autonomousBudgetEpoch ?? 0),
    ),
  );
}

function latestMailboxPairDepth(
  store: PersistedAgentMailStore,
  firstMailboxId: string,
  secondMailboxId: string,
  cutoff: number,
): number | null {
  const epoch = pairBudgetEpoch(store, firstMailboxId, secondMailboxId);
  let latest: AgentMailMessage | null = null;
  for (const mailboxId of [firstMailboxId, secondMailboxId]) {
    const mailbox = store.mailboxes[mailboxId];
    if (!mailbox) continue;
    for (const message of mailbox.messages) {
      if (message.autonomousSequence === undefined) continue;
      if (message.autonomousSequence <= epoch) continue;
      if (Date.parse(message.createdAt) < cutoff) continue;
      if (!sameMailboxPair(message, firstMailboxId, secondMailboxId)) continue;
      if (
        !latest ||
        (message.autonomousSequence ?? -1) > (latest.autonomousSequence ?? -1) ||
        ((message.autonomousSequence ?? -1) === (latest.autonomousSequence ?? -1) &&
          (message.createdAt > latest.createdAt ||
            (message.createdAt === latest.createdAt && message.id > latest.id)))
      ) {
        latest = message;
      }
    }
  }
  return latest?.threadDepth ?? null;
}

/**
 * Routed messages this pair scheduled in the last hour, in either direction.
 *
 * Mail held over a budget has not been scheduled and does not count, so the
 * hourly hold releases itself as older messages age out of the window.
 */
function pairMessagesInLastHour(
  store: PersistedAgentMailStore,
  firstMailboxId: string,
  secondMailboxId: string,
  now: number,
): number {
  const since = now - 3_600_000;
  let count = 0;
  for (const mailboxId of [firstMailboxId, secondMailboxId]) {
    for (const message of store.mailboxes[mailboxId]?.messages ?? []) {
      if (
        message.autonomousSequence === undefined ||
        Date.parse(message.wakeAdmittedAt ?? message.createdAt) < since ||
        message.placement === "stored" ||
        message.placement === "bounced" ||
        isAgentMailBudgetHeld(message) ||
        !sameMailboxPair(message, firstMailboxId, secondMailboxId)
      ) {
        continue;
      }
      count += 1;
    }
  }
  return count;
}

/**
 * Which coordinator each environment belongs to, as the mail address of that
 * coordinator's main conversation.
 *
 * Only launch associations count: they carry the worker's base commit. A
 * delegation that only messages or prompts an existing environment does not
 * make the coordinator its creator, so a user's own environment never becomes
 * some coordinator's worker just because a coordinator asked it something.
 *
 * Every worker belongs to the main coordinator, whichever conversation
 * launched it. While no main is open the origin is the coordinator's bare
 * runtime id: the worker stays attached (its mail is not peer mail), and the
 * first message it sends to "coordinator" starts a new main.
 */
function coordinatorOriginsByEnvironment(
  workspaces: CoordinatorWorkspace[],
  workflows: CoordinatorWorkflowAssociation[],
): Map<string, string> {
  const originByCoordinator = new Map<string, string>();
  for (const workspace of workspaces) {
    const main = coordinatorMainConversation(workspace);
    originByCoordinator.set(
      workspace.id,
      coordinatorRuntimeId(workspace.id, main ? main.id : undefined),
    );
  }
  const origins = new Map<string, string>();
  for (const association of workflows) {
    if (
      association.kind !== "environment" ||
      association.pending ||
      !association.baseCommit ||
      association.nodeId
    ) {
      continue;
    }
    const origin = originByCoordinator.get(association.coordinatorId);
    if (origin) origins.set(association.resourceId, origin);
  }
  return origins;
}

/**
 * Whether a stored message may be woken despite a non-zero inject depth.
 *
 * Inject depth exists to stop an injected tab's replies from waking anyone, so
 * two tabs cannot ping-pong unattended. Routed mail is instead bounded by the
 * pair hop budget, so a reply is as deliverable as the message it answers.
 */
function routedMessageWakes(
  message: AgentMailMessage,
  mailbox: PersistedMailbox,
  settings: Pick<AgentMessagingSettings, "wakePeers">,
): boolean {
  return agentMailRouteWakes(message.route, mailbox.injectOverride, settings);
}

function mailboxKind(tabType: string): MailboxKind | null {
  if (tabType === "agent-native") return "native";
  if (tabType === "claude-tmux") return "tmux";
  if (TERMINAL_TYPES.has(tabType)) return "terminal";
  return null;
}

function tabAgent(tab: Record<string, unknown>): { agent: AgentPlatform | null; locked: boolean } {
  if (tab.type !== "agent-native") {
    return {
      agent: isAgentPlatform(tab.type) ? tab.type : tab.type === "claude-tmux" ? "claude" : null,
      locked: true,
    };
  }
  const data = tab.nativeAgentData;
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { agent: null, locked: false };
  const platform = (data as Record<string, unknown>).platform;
  return { agent: isAgentPlatform(platform) ? platform : null, locked: isAgentPlatform(platform) };
}

function isAddressableTab(tab: Record<string, unknown>): boolean {
  if (typeof tab.id !== "string" || typeof tab.type !== "string") return false;
  if (tab.isReviewTab === true || WORKFLOW_TYPES.has(tab.type)) return false;
  return mailboxKind(tab.type) !== null;
}

function storeByteLength(store: PersistedAgentMailStore): number {
  return Buffer.byteLength(JSON.stringify(store, null, 2), "utf8") + 1;
}

export class AgentMailRepository {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
    private readonly repos: StorageRepositories,
  ) {}

  private readonly agentMailLayoutRevisions = new Map<string, number>();
  private agentMailRuntimeProvider:
    | ((mailbox: {
        mailboxId: string;
        environmentId: string;
        tabId: string;
        agent: AgentPlatform | null;
        logicalSessionKey?: string;
        kind: MailboxKind;
      }) => { presence?: MailboxDescriptor["presence"]; title?: string } | undefined)
    | null = null;

  setAgentMailRuntimeProvider(provider: AgentMailRepository["agentMailRuntimeProvider"]): void {
    this.agentMailRuntimeProvider = provider;
  }

  private coordinatorMailResolver:
    | ((projectId: string) => Promise<{ environmentId: string; tabId: string } | null>)
    | null = null;

  /** Set by the coordinator service, which can start a main conversation. */
  setCoordinatorMailResolver(resolver: AgentMailRepository["coordinatorMailResolver"]): void {
    this.coordinatorMailResolver = resolver;
  }

  /**
   * Rewrite a coordinator address to the project's current main conversation.
   *
   * Applies to the `"coordinator"` alias, a coordinator's bare runtime id, and
   * the address of a conversation that has since closed — which is what a
   * worker launched by a replaced main still holds. Redirected mail starts a
   * new message rather than replying into the closed conversation's thread,
   * whose other end no longer exists. Open conversations, side agents
   * included, are left alone; who may mail them is checked at send.
   */
  /**
   * The tab to deliver to when a sender named only an environment.
   *
   * A coordinator means the tab it is waiting on; otherwise the environment's
   * only agent tab, then the agent it was launched with. Guessing between
   * several tabs is refused with their ids, so the sender can choose.
   */
  /** The tab a sender naming only `environmentId` would reach (see `recipientTab`). */
  resolveAgentMailRecipientTab(sender: AgentMailSender, environmentId: string): Promise<string> {
    return this.recipientTab(sender, {
      requestId: "resolve",
      toEnvironmentId: environmentId,
      toTabId: "",
      body: "",
    });
  }

  private async recipientTab(sender: AgentMailSender, input: AgentMailSendInput): Promise<string> {
    await this.ensureAgentMailDirectoryFresh([input.toEnvironmentId]);
    if (sender.kind === "coordinator") {
      const delegated = (await this.repos.coordinators.listOpenCoordinatorDelegations()).find(
        (association) =>
          association.coordinatorId === sender.coordinatorId &&
          !association.nodeId &&
          association.resourceId === input.toEnvironmentId &&
          association.delegation,
      );
      if (delegated) return delegated.delegation!.workerTabId;
    }
    const tabs = await this.listAgentMailPullTabIds(input.toEnvironmentId);
    if (tabs.length === 1) return tabs[0]!;
    if (tabs.includes("startup-agent")) return "startup-agent";
    if (tabs.length === 0)
      throw new AgentMailError(
        "recipient-not-found",
        "That environment has no agent tab to message",
      );
    throw new AgentMailError(
      "recipient-not-found",
      `That environment has several agent tabs; pass toTabId (one of: ${tabs.join(", ")})`,
    );
  }

  private async resolveCoordinatorAddress(
    sender: AgentMailSender,
    input: AgentMailSendInput,
  ): Promise<AgentMailSendInput> {
    const alias = input.toEnvironmentId === COORDINATOR_MAIL_ADDRESS;
    const coordinatorId = alias ? null : coordinatorIdFromRuntimeId(input.toEnvironmentId);
    if (!alias && !coordinatorId) {
      return input.toTabId ? input : { ...input, toTabId: await this.recipientTab(sender, input) };
    }
    const workspaces = await this.repos.coordinators.listCoordinatorWorkspaces();
    const projectId =
      sender.kind === "tab" || sender.kind === "coordinator" || sender.kind === "system"
        ? sender.projectId
        : undefined;
    const workspace = alias
      ? workspaces.find((candidate) => candidate.projectId === projectId)
      : workspaces.find((candidate) => candidate.id === coordinatorId);
    if (!workspace) {
      if (alias) throw new AgentMailError("recipient-not-found", "This project has no coordinator");
      return input;
    }
    if (!alias) {
      const conversationId = coordinatorConversationIdFromRuntimeId(input.toEnvironmentId);
      const conversation = workspace.conversations.find((item) => item.id === conversationId);
      // One mailbox per conversation, so its tab id is never in doubt.
      if (conversation && !conversation.closedAt) return { ...input, toTabId: conversation.tabId };
    }
    const open = coordinatorMainConversation(workspace);
    const address = open
      ? { environmentId: coordinatorRuntimeId(workspace.id, open.id), tabId: open.tabId }
      : await this.coordinatorMailResolver?.(workspace.projectId);
    if (!address)
      throw new AgentMailError("recipient-not-found", "The project coordinator is not open");
    const { replyToMessageId: _replyToMessageId, ...rest } = input;
    return { ...rest, toEnvironmentId: address.environmentId, toTabId: address.tabId };
  }

  private enqueueAgentMailMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(this.files.agentMailFile(), "agent mail storage", operation);
  }

  private async loadAgentMailStore(): Promise<PersistedAgentMailStore> {
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

  private async saveAgentMailStore(store: PersistedAgentMailStore): Promise<void> {
    if (store.pendingInject.length > AGENT_MAIL_MAX_PENDING_INJECTS) {
      throw new AgentMailError("mailbox-backlog-full", "Too many messages are awaiting injection");
    }
    if (storeByteLength(store) > AGENT_MAIL_MAX_STORE_BYTES) {
      throw new AgentMailError("store-full", "Agent mail store has reached its size limit");
    }
    await this.context.saveSensitiveJson(this.files.agentMailFile(), store);
  }

  /**
   * Resolve an environment credential only when it has one unambiguous agent
   * identity. This intentionally scans the authoritative store rather than a
   * paginated project directory: authorization must never depend on which
   * mailbox happened to land on the first page.
   */
  async resolveUniqueAgentMailPullTabId(environmentId: string): Promise<string | null> {
    if (!environmentId.trim()) return null;
    const store = await this.loadAgentMailStore();
    let tabId: string | null = null;
    for (const mailbox of Object.values(store.mailboxes)) {
      if (
        mailbox.environmentId !== environmentId ||
        mailbox.tombstonedAt ||
        !agentMailCapabilities(mailbox.tabType, mailbox.agent, mailbox.locked).canPull
      ) {
        continue;
      }
      if (tabId !== null) return null;
      tabId = mailbox.tabId;
    }
    return tabId;
  }

  async listAgentMailPullTabIds(environmentId: string): Promise<string[]> {
    if (!environmentId.trim()) return [];
    const store = await this.loadAgentMailStore();
    return Object.values(store.mailboxes)
      .filter(
        (mailbox) =>
          mailbox.environmentId === environmentId &&
          !mailbox.tombstonedAt &&
          agentMailCapabilities(mailbox.tabType, mailbox.agent, mailbox.locked).canPull,
      )
      .sort((a, b) => (a.tabOrdinal ?? 0) - (b.tabOrdinal ?? 0) || a.tabId.localeCompare(b.tabId))
      .map((mailbox) => mailbox.tabId);
  }

  async synchronizeAgentMailboxes(): Promise<void> {
    const [projects, environments, layoutsResult, coordinators, coordinatorWorkflows] =
      await Promise.all([
        this.repos.projects.loadProjects(),
        this.repos.projects.loadEnvironments(),
        this.repos.sessions.loadPaneLayoutsForReconciliation(),
        this.repos.coordinators.listCoordinatorWorkspaces(),
        this.repos.coordinators.listAllCoordinatorWorkflowAssociations(),
      ]);
    const coordinatorOrigins = coordinatorOriginsByEnvironment(coordinators, coordinatorWorkflows);
    if (!layoutsResult.available) return;
    const sessionsByEnvironment = new Map(
      await Promise.all(
        environments.map(
          async (environment) =>
            [
              environment.id,
              await this.repos.drafts.getSessionsByEnvironment(environment.id),
            ] as const,
        ),
      ),
    );
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const environmentById = new Map(
      environments.map((environment) => [environment.id, environment]),
    );
    const observed = new Map<
      string,
      Omit<
        PersistedMailbox,
        | "incarnationId"
        | "injectOverride"
        | "mutedInbound"
        | "mutedOutbound"
        | "messages"
        | "revision"
      > & { incarnationId?: string }
    >();
    for (const [environmentId, layout] of Object.entries(layoutsResult.layouts)) {
      const environment = environmentById.get(environmentId);
      // Deletion marks the environment before mail is scrubbed. Treat that
      // tombstone as authoritative so a renderer reconciliation cannot
      // recreate the mailbox in the short interval before the environment row
      // and pane layout are removed.
      if (!environment || environment.deletionRequestedAt) continue;
      const project = projectById.get(environment.projectId);
      if (!project) continue;
      let tabOrdinal = 0;
      for (const leaf of paneLayoutLeaves(layout.root)) {
        for (const tab of leaf.tabs) {
          tabOrdinal += 1;
          if (!isAddressableTab(tab)) continue;
          const tabId = tab.id as string;
          const tabType = tab.type as string;
          const kind = mailboxKind(tabType)!;
          const { agent, locked } = tabAgent(tab);
          const mailboxId = agentMailboxId(environmentId, tabId);
          const logicalSessionKey = `env-${environmentId}:${tabId}`;
          const runtime = this.agentMailRuntimeProvider?.({
            mailboxId,
            environmentId,
            tabId,
            agent,
            logicalSessionKey,
            kind,
          });
          const customSessionName = sessionsByEnvironment
            .get(environmentId)
            ?.find((session) => session.tabId === tabId)?.name;
          const displayName = resolveTabDisplayName({
            tabType,
            tabOrdinal,
            agent,
            customSessionName,
            nativeSessionTitle: runtime?.title,
            displayTitle: typeof tab.displayTitle === "string" ? tab.displayTitle : null,
          });
          observed.set(mailboxId, {
            mailboxId,
            projectId: project.id,
            projectName: project.name,
            environmentId,
            environmentName: environment.name,
            environmentStatus: environment.status,
            tabId,
            tabType,
            title: displayName,
            displayName,
            tabOrdinal,
            agent,
            kind,
            locked,
            // Present even when undefined so a closed creator clears it.
            coordinatorOrigin: coordinatorOrigins.get(environmentId),
          });
        }
      }
    }
    for (const workspace of coordinators) {
      const project = projectById.get(workspace.projectId);
      if (!project) continue;
      for (const conversation of workspace.conversations) {
        if (conversation.closedAt) continue;
        const environmentId = coordinatorRuntimeId(workspace.id, conversation.id);
        const mailboxId = agentMailboxId(environmentId, conversation.tabId);
        observed.set(mailboxId, {
          mailboxId,
          projectId: project.id,
          projectName: project.name,
          environmentId,
          environmentName: "Coordinator",
          environmentStatus: workspace.lifecycleState === "ready" ? "running" : "stopped",
          tabId: conversation.tabId,
          tabType: "agent-native",
          title: conversation.title,
          displayName: resolveTabDisplayName({
            tabType: "agent-native",
            tabOrdinal: 1,
            agent: conversation.agent,
            nativeSessionTitle: conversation.title,
          }),
          tabOrdinal: 1,
          agent: conversation.agent ?? null,
          kind: "native",
          locked: true,
          ownerKind: "coordinator",
          coordinatorId: workspace.id,
          conversationId: conversation.id,
          coordinatorRole: conversation.role ?? "main",
          logicalSessionKey: conversation.logicalSessionKey,
          incarnationId: conversation.mailboxIncarnationId,
        });
      }
    }

    await this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const changedMailboxIds = new Set<string>();
      const now = new Date().toISOString();
      for (const [mailboxId, metadata] of observed) {
        const current = store.mailboxes[mailboxId];
        if (!current || current.tombstonedAt) {
          if (!current && Object.keys(store.mailboxes).length >= AGENT_MAIL_MAX_MAILBOXES) continue;
          store.mailboxes[mailboxId] = {
            ...metadata,
            incarnationId: metadata.incarnationId ?? randomUUID(),
            injectOverride: "inherit",
            mutedInbound: false,
            mutedOutbound: false,
            messages: current?.messages ?? [],
            revision: (current?.revision ?? 0) + 1,
          };
          changedMailboxIds.add(mailboxId);
          continue;
        }
        const changed = Object.entries(metadata).some(
          ([key, value]) => current[key as keyof PersistedMailbox] !== value,
        );
        if (changed) {
          Object.assign(current, metadata);
          current.revision += 1;
          changedMailboxIds.add(mailboxId);
        }
      }
      for (const [mailboxId, mailbox] of Object.entries(store.mailboxes)) {
        if (observed.has(mailboxId) || mailbox.tombstonedAt) continue;
        mailbox.tombstonedAt = now;
        mailbox.injectOverride = "off";
        mailbox.revision += 1;
        for (const message of mailbox.messages) {
          if (message.placement !== "pending-inject" && message.placement !== "inject-held")
            continue;
          message.placement = "undeliverable";
          message.placementReason = "tab-closed";
          message.revision += 1;
        }
        changedMailboxIds.add(mailboxId);
      }
      if (changedMailboxIds.size === 0) return;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      this.context.changes.announce("agent-mail-summary", "all");
      for (const mailboxId of changedMailboxIds) {
        this.context.changes.announce(
          "agent-mail",
          mailboxId,
          store.mailboxes[mailboxId]?.projectId,
        );
      }
    });
    this.agentMailLayoutRevisions.clear();
    for (const [environmentId, layout] of Object.entries(layoutsResult.layouts)) {
      this.agentMailLayoutRevisions.set(environmentId, layout.revision);
    }
    for (const workspace of coordinators) {
      for (const conversation of workspace.conversations) {
        if (!conversation.closedAt) {
          this.agentMailLayoutRevisions.set(
            coordinatorRuntimeId(workspace.id, conversation.id),
            -1,
          );
        }
      }
    }
  }

  private async ensureAgentMailDirectoryFresh(environmentIds: string[]): Promise<void> {
    for (const environmentId of new Set(environmentIds.filter(Boolean))) {
      const layout = await this.repos.sessions.getPaneLayout(environmentId);
      const revision = layout?.revision ?? -1;
      if (this.agentMailLayoutRevisions.get(environmentId) !== revision) {
        await this.synchronizeAgentMailboxes();
        return;
      }
    }
  }

  private descriptor(mailbox: PersistedMailbox, defaultPolicy: "off" | "idle"): MailboxDescriptor {
    const userUnseenCount = mailbox.messages.filter(
      (message) =>
        message.toIncarnationId === mailbox.incarnationId &&
        !message.userSeenAt &&
        !message.discardedAt,
    ).length;
    const agentUnackedCount = mailbox.messages.filter(
      (message) =>
        message.toIncarnationId === mailbox.incarnationId &&
        !message.ackedAt &&
        !message.discardedAt,
    ).length;
    const runtime = this.agentMailRuntimeProvider?.(mailbox);
    const presence = mailbox.tombstonedAt
      ? "tab_closed"
      : mailbox.environmentStatus !== "running"
        ? "environment_stopped"
        : (runtime?.presence ?? "unknown");
    // Naming is synchronized on session-title resources. Do not recompute it
    // here from only the runtime title: that would incorrectly outrank a
    // persisted custom session name between observer passes.
    const displayName = mailbox.displayName ?? mailbox.title ?? mailbox.tabId;
    return {
      mailboxId: mailbox.mailboxId,
      incarnationId: mailbox.incarnationId,
      projectId: mailbox.projectId,
      projectName: mailbox.projectName,
      environmentId: mailbox.environmentId,
      environmentName: mailbox.environmentName,
      environmentStatus: mailbox.environmentStatus,
      tabId: mailbox.tabId,
      tabType: mailbox.tabType,
      title: displayName,
      displayName,
      tabOrdinal: mailbox.tabOrdinal ?? 1,
      agent: mailbox.agent,
      kind: mailbox.kind,
      presence,
      injectPolicy:
        mailbox.tombstonedAt || mailbox.injectOverride === "off"
          ? "off"
          : mailbox.injectOverride === "idle"
            ? "idle"
            : defaultPolicy,
      injectOverride: mailbox.injectOverride,
      mutedInbound: mailbox.mutedInbound,
      mutedOutbound: mailbox.mutedOutbound,
      unreadCount: userUnseenCount,
      userUnseenCount,
      agentUnackedCount,
      pendingInjectCount: mailbox.messages.filter(
        (message) =>
          message.toIncarnationId === mailbox.incarnationId && countsAsPendingInject(message),
      ).length,
      failedInjectCount: mailbox.messages.filter(
        (message) =>
          message.toIncarnationId === mailbox.incarnationId &&
          message.placement === "inject_failed",
      ).length,
      capabilities: agentMailCapabilities(mailbox.tabType, mailbox.agent, mailbox.locked),
      ...(mailbox.ownerKind ? { ownerKind: mailbox.ownerKind } : {}),
      ...(mailbox.coordinatorId ? { coordinatorId: mailbox.coordinatorId } : {}),
      ...(mailbox.conversationId ? { conversationId: mailbox.conversationId } : {}),
      ...(mailbox.coordinatorOrigin ? { coordinatorOrigin: mailbox.coordinatorOrigin } : {}),
      ...(mailbox.logicalSessionKey ? { logicalSessionKey: mailbox.logicalSessionKey } : {}),
      ...(mailbox.tombstonedAt ? { tombstonedAt: mailbox.tombstonedAt } : {}),
    };
  }

  async listAgentMailboxes(
    options: {
      projectId?: string;
      allowCrossProject?: boolean;
      q?: string;
      offset?: number;
      limit?: number;
      includeTombstoned?: boolean;
      currentEnvironmentId?: string;
      environmentId?: string;
    } = {},
  ): Promise<{ mailboxes: MailboxDescriptor[]; total: number; offset: number; limit: number }> {
    const [store, config] = await Promise.all([
      this.loadAgentMailStore(),
      this.repos.config.loadConfig(),
    ]);
    const settings = normalizeAgentMessagingSettings(config.global.agentMessaging);
    const query = options.q?.trim().toLocaleLowerCase();
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.min(
      AGENT_MAIL_MAX_LIST_LIMIT,
      Math.max(1, options.limit ?? AGENT_MAIL_DEFAULT_LIST_LIMIT),
    );
    const filtered = Object.values(store.mailboxes)
      .filter((mailbox) => options.includeTombstoned || !mailbox.tombstonedAt)
      .filter(
        (mailbox) => !options.environmentId || mailbox.environmentId === options.environmentId,
      )
      .filter(
        (mailbox) =>
          !options.projectId ||
          options.allowCrossProject ||
          mailbox.projectId === options.projectId,
      )
      .filter((mailbox) => {
        if (!query) return true;
        return [mailbox.projectName, mailbox.environmentName, mailbox.title, mailbox.tabId]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLocaleLowerCase().includes(query));
      })
      .filter(
        (mailbox) => agentMailCapabilities(mailbox.tabType, mailbox.agent, mailbox.locked).canPull,
      )
      .sort((a, b) => {
        const aCurrent = a.environmentId === options.currentEnvironmentId ? 0 : 1;
        const bCurrent = b.environmentId === options.currentEnvironmentId ? 0 : 1;
        return (
          aCurrent - bCurrent ||
          a.projectName.localeCompare(b.projectName) ||
          a.environmentName.localeCompare(b.environmentName) ||
          (a.tabOrdinal ?? 0) - (b.tabOrdinal ?? 0) ||
          a.tabId.localeCompare(b.tabId)
        );
      });
    return {
      mailboxes: filtered
        .slice(offset, offset + limit)
        .map((mailbox) => this.descriptor(mailbox, settings.defaultInjectPolicy)),
      total: filtered.length,
      offset,
      limit,
    };
  }

  async getAgentMailSummary(): Promise<AgentMailSummarySnapshot> {
    const store = await this.loadAgentMailStore();
    return {
      revision: store.revision,
      mailboxes: Object.values(store.mailboxes).map((mailbox) => ({
        mailboxId: mailbox.mailboxId,
        projectId: mailbox.projectId,
        environmentId: mailbox.environmentId,
        tabId: mailbox.tabId,
        userUnseenCount: mailbox.messages.filter(
          (message) =>
            message.toIncarnationId === mailbox.incarnationId &&
            !message.userSeenAt &&
            !message.discardedAt,
        ).length,
        unreadCount: mailbox.messages.filter(
          (message) =>
            message.toIncarnationId === mailbox.incarnationId &&
            !message.userSeenAt &&
            !message.discardedAt,
        ).length,
        agentUnackedCount: mailbox.messages.filter(
          (message) =>
            message.toIncarnationId === mailbox.incarnationId &&
            !message.ackedAt &&
            !message.discardedAt,
        ).length,
        pendingInjectCount: mailbox.messages.filter(
          (message) =>
            message.toIncarnationId === mailbox.incarnationId && countsAsPendingInject(message),
        ).length,
        failedInjectCount: mailbox.messages.filter(
          (message) =>
            message.toIncarnationId === mailbox.incarnationId &&
            message.placement === "inject_failed",
        ).length,
        attentionCount: mailbox.messages.filter(
          (message) =>
            message.toIncarnationId === mailbox.incarnationId && agentMailNeedsAttention(message),
        ).length,
        revision: mailbox.revision,
      })),
    };
  }

  async getAgentMailMailbox(
    environmentId: string,
    tabId: string,
    options: {
      unreadOnly?: boolean;
      offset?: number;
      limit?: number;
      incarnationId?: string;
    } = {},
  ): Promise<AgentMailMailboxSnapshot> {
    const [store, config] = await Promise.all([
      this.loadAgentMailStore(),
      this.repos.config.loadConfig(),
    ]);
    const mailbox = store.mailboxes[agentMailboxId(environmentId, tabId)];
    if (!mailbox) throw new AgentMailError("recipient-not-found", "Mailbox not found");
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.min(
      AGENT_MAIL_MAX_LIST_LIMIT,
      Math.max(1, options.limit ?? AGENT_MAIL_DEFAULT_LIST_LIMIT),
    );
    const messages = mailbox.messages
      .filter(
        (message) =>
          options.incarnationId === undefined || message.toIncarnationId === options.incarnationId,
      )
      .filter((message) => !options.unreadOnly || (!message.ackedAt && !message.discardedAt))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      descriptor: this.descriptor(
        mailbox,
        normalizeAgentMessagingSettings(config.global.agentMessaging).defaultInjectPolicy,
      ),
      messages: messages.slice(offset, offset + limit).map(metadataMessage),
      total: messages.length,
      offset,
      limit,
      revision: mailbox.revision,
    };
  }

  async getAgentMailMailboxes(
    addresses: Array<{ environmentId: string; tabId: string }>,
  ): Promise<AgentMailMailboxBatchSnapshot> {
    if (addresses.length > AGENT_MAIL_MAX_MAILBOXES) {
      throw new Error(`At most ${AGENT_MAIL_MAX_MAILBOXES} mailboxes may be read at once`);
    }
    const [store, config] = await Promise.all([
      this.loadAgentMailStore(),
      this.repos.config.loadConfig(),
    ]);
    const defaultPolicy = normalizeAgentMessagingSettings(
      config.global.agentMessaging,
    ).defaultInjectPolicy;
    const mailboxes: AgentMailMailboxSnapshot[] = [];
    const seen = new Set<string>();
    for (const address of addresses) {
      const mailboxId = agentMailboxId(address.environmentId, address.tabId);
      if (seen.has(mailboxId)) continue;
      seen.add(mailboxId);
      const mailbox = store.mailboxes[mailboxId];
      if (!mailbox) continue;
      const messages = mailbox.messages.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
      mailboxes.push({
        descriptor: this.descriptor(mailbox, defaultPolicy),
        messages: messages.map(metadataMessage),
        total: messages.length,
        offset: 0,
        limit: messages.length,
        revision: mailbox.revision,
      });
    }
    return { revision: store.revision, mailboxes };
  }

  async getAgentMailInboxSnapshot(): Promise<AgentMailInboxSnapshot> {
    const [store, config] = await Promise.all([
      this.loadAgentMailStore(),
      this.repos.config.loadConfig(),
    ]);
    const defaultPolicy = normalizeAgentMessagingSettings(
      config.global.agentMessaging,
    ).defaultInjectPolicy;
    const persisted = Object.values(store.mailboxes).toSorted((a, b) =>
      `${a.projectName}\0${a.environmentName}\0${a.tabId}`.localeCompare(
        `${b.projectName}\0${b.environmentName}\0${b.tabId}`,
      ),
    );
    const directory = persisted.map((mailbox) => this.descriptor(mailbox, defaultPolicy));
    const mailboxes = persisted.map((mailbox): AgentMailMailboxSnapshot => {
      const messages = mailbox.messages.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
      return {
        descriptor: this.descriptor(mailbox, defaultPolicy),
        messages: messages.map(metadataMessage),
        total: messages.length,
        offset: 0,
        limit: messages.length,
        revision: mailbox.revision,
      };
    });
    return {
      revision: store.revision,
      directory,
      mailboxes,
      summary: {
        revision: store.revision,
        mailboxes: mailboxes.map(({ descriptor, messages, revision }) => ({
          mailboxId: descriptor.mailboxId,
          projectId: descriptor.projectId,
          environmentId: descriptor.environmentId,
          tabId: descriptor.tabId,
          unreadCount: descriptor.unreadCount,
          userUnseenCount: descriptor.userUnseenCount,
          agentUnackedCount: descriptor.agentUnackedCount,
          pendingInjectCount: messages.filter(
            (message) =>
              message.toIncarnationId === descriptor.incarnationId &&
              countsAsPendingInject(message),
          ).length,
          failedInjectCount: messages.filter(
            (message) =>
              message.toIncarnationId === descriptor.incarnationId &&
              message.placement === "inject_failed",
          ).length,
          attentionCount: messages.filter(
            (message) =>
              message.toIncarnationId === descriptor.incarnationId &&
              agentMailNeedsAttention(message),
          ).length,
          revision,
        })),
      },
    };
  }

  /**
   * Whether a coordinator request is still sitting undelivered in this worker's
   * inbox.
   *
   * A delegation opened by messaging a worker that was already mid-turn would
   * otherwise be settled by that in-flight turn ending — the worker has not
   * read the request yet, so reporting it as finished is a lie, and it is
   * exactly the kind of unsolicited "done" this design exists to prevent.
   *
   * Deliberately not filtered by time. The obvious version compares against the
   * delegation's `requestedAt`, but the request is *sent* before the delegation
   * is opened, so its `createdAt` is at best equal and usually earlier — the
   * comparison decides on a millisecond boundary and drops the very case it was
   * written for. Delivery state alone is the evidence, and it is unambiguous:
   * an uninjected request has not reached any turn.
   */
  async hasUndeliveredCoordinatorRequest(
    workerEnvironmentId: string,
    workerTabId: string,
  ): Promise<boolean> {
    const store = await this.loadAgentMailStore();
    const mailbox = store.mailboxes[agentMailboxId(workerEnvironmentId, workerTabId)];
    if (!mailbox) return false;
    return mailbox.messages.some(
      (message) =>
        (message.from.kind === "coordinator" ||
          (message.from.kind === "node" && message.from.role === "coordinator")) &&
        !message.injectedAt &&
        !message.ackedAt &&
        !message.discardedAt &&
        (message.placement === "pending-inject" || message.placement === "inject-held"),
    );
  }

  async getAgentMailMessage(
    environmentId: string,
    tabId: string,
    messageId: string,
  ): Promise<AgentMailMessage> {
    const store = await this.loadAgentMailStore();
    const mailbox = store.mailboxes[agentMailboxId(environmentId, tabId)];
    const message = mailbox?.messages.find((candidate) => candidate.id === messageId);
    if (!message)
      throw new AgentMailError("message-not-found", "Message not found in this mailbox");
    return message;
  }

  private findMessage(
    store: PersistedAgentMailStore,
    messageId: string,
  ): { mailbox: PersistedMailbox; message: AgentMailMessage } | null {
    for (const mailbox of Object.values(store.mailboxes)) {
      const message = mailbox.messages.find((candidate) => candidate.id === messageId);
      if (message) return { mailbox, message };
    }
    return null;
  }

  /** Serializes follow-up admission with worker completion, including periodic recovery. */
  withAgentMailWorkerAdmission<T>(environmentId: string, operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(
      `${this.files.agentMailFile()}:worker-admission:${environmentId}`,
      "worker mail admission",
      operation,
    );
  }

  private authenticateMailSender(
    store: PersistedAgentMailStore,
    sender: AgentMailSender,
  ): { actor: MailActor; senderScope: string; senderMailbox: PersistedMailbox | undefined } {
    let actor: MailActor;
    let senderScope: string;
    let senderMailbox: PersistedMailbox | undefined;
    if (sender.kind === "tab" || sender.kind === "coordinator") {
      senderMailbox = store.mailboxes[agentMailboxId(sender.environmentId, sender.tabId)];
      if (
        !senderMailbox ||
        senderMailbox.tombstonedAt ||
        senderMailbox.projectId !== sender.projectId
      ) {
        throw new AgentMailError("sender-not-found", "Sender tab is not an active mailbox");
      }
      if (
        sender.kind === "coordinator" &&
        (senderMailbox.ownerKind !== "coordinator" ||
          senderMailbox.coordinatorId !== sender.coordinatorId ||
          senderMailbox.conversationId !== sender.conversationId)
      ) {
        throw new AgentMailError(
          "capability-denied",
          "Coordinator identity does not own this mailbox",
        );
      }
      const capabilities = agentMailCapabilities(
        senderMailbox.tabType,
        senderMailbox.agent,
        senderMailbox.locked,
      );
      if (!capabilities.canSend)
        throw new AgentMailError("capability-denied", "This tab cannot send agent mail");
      if (senderMailbox.mutedOutbound)
        throw new AgentMailError("policy-denied", "Outbound messaging is muted for this mailbox");
      actor =
        sender.kind === "coordinator"
          ? {
              kind: "coordinator",
              projectId: senderMailbox.projectId,
              coordinatorId: sender.coordinatorId,
              conversationId: sender.conversationId,
              environmentId: senderMailbox.environmentId,
              tabId: senderMailbox.tabId,
              incarnationId: senderMailbox.incarnationId,
              agent: senderMailbox.agent!,
              title: senderMailbox.title,
            }
          : {
              kind: "tab",
              projectId: senderMailbox.projectId,
              environmentId: senderMailbox.environmentId,
              tabId: senderMailbox.tabId,
              incarnationId: senderMailbox.incarnationId,
              agent: senderMailbox.agent,
              title: senderMailbox.title,
            };
      senderScope = `${sender.kind}:${senderMailbox.mailboxId}`;
    } else if (sender.kind === "node") {
      actor = { ...sender, title: sender.title ?? null };
      senderScope = nodeMailSenderKey(sender);
    } else {
      actor = sender;
      senderScope =
        sender.kind === "system"
          ? `system:${sender.projectId}:${sender.source}:${sender.resourceId}`
          : sender.kind;
    }

    return { actor, senderScope, senderMailbox };
  }

  async sendAgentMail(
    sender: AgentMailSender,
    input: AgentMailSendInput,
    options: {
      newDelegation?: boolean;
      /** Structured facts for a workflow notice; ignored for any other sender. */
      notice?: AgentMailNotice;
      /**
       * Budget a workflow status notice as this stand-in sender
       * (`agentMailStatusBudgetKey`). Ignored for any other sender.
       */
      statusBudgetKey?: string;
      /**
       * Hold a scheduled wake this long so notices that land together are
       * delivered as one batch. A notice joins a window already open for the
       * recipient rather than starting its own.
       */
      coalesceMs?: number;
    } = {},
  ): Promise<AgentMailMessage> {
    const requestId = input.requestId.trim();
    const notice = sender.kind === "system" ? normalizeAgentMailNotice(options.notice) : null;
    const statusBudgetKey =
      sender.kind === "system" && options.statusBudgetKey ? options.statusBudgetKey : undefined;
    if (!requestId || requestId.length > AGENT_MAIL_MAX_REQUEST_ID_LENGTH)
      throw new Error("requestId must be 1-256 characters");
    const bodyBytes = Buffer.byteLength(input.body, "utf8");
    if (!input.body.trim() || bodyBytes > AGENT_MAIL_MAX_BODY_BYTES)
      throw new Error("body must be non-empty and at most 32 KiB UTF-8");
    const subject = input.subject?.trim() || undefined;
    if (subject && subject.length > AGENT_MAIL_MAX_SUBJECT_LENGTH)
      throw new Error("subject must be at most 200 characters");
    // Idempotency keys on what the sender asked for, so a retry still matches
    // after "coordinator" has come to mean a different conversation.
    const requested = input;
    await this.ensureAgentMailDirectoryFresh([
      sender.kind === "tab" || sender.kind === "coordinator" ? sender.environmentId : "",
    ]);
    const replay = await this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const { senderScope } = this.authenticateMailSender(store, sender);
      const key = idempotencyKey(senderScope, requestId);
      const fingerprint = sendFingerprint({ ...requested, subject });
      const prior = store.idempotency[key];
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new AgentMailError(
            "idempotency-conflict",
            "requestId was already used with different content",
          );
        if (prior.bounce) return prior.bounce;
        const located = prior.messageId ? this.findMessage(store, prior.messageId) : null;
        if (located) return located.message;
        const counterpart = prior.messageId ? store.counterparts[prior.messageId] : undefined;
        if (counterpart) return { ...counterpart, body: "" };
        throw new AgentMailError(
          "message-not-found",
          "Idempotent message record is no longer retained",
        );
      }
      return null;
    });
    if (replay) return replay;
    input = await this.resolveCoordinatorAddress(sender, input);
    await this.ensureAgentMailDirectoryFresh([
      input.toEnvironmentId,
      sender.kind === "tab" || sender.kind === "coordinator" ? sender.environmentId : "",
    ]);
    const recipientEnvironment = await this.repos.projects.getEnvironment(input.toEnvironmentId);
    const config = await this.repos.config.loadConfig();
    const settings = normalizeAgentMessagingSettings(config.global.agentMessaging);
    if (!settings.enabled)
      throw new AgentMailError("messaging-disabled", "Agent messaging is disabled");

    const placed = await this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const { actor, senderScope, senderMailbox } = this.authenticateMailSender(store, sender);
      const key = idempotencyKey(senderScope, requestId);
      const fingerprint = sendFingerprint({ ...requested, subject });
      const prior = store.idempotency[key];
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new AgentMailError(
            "idempotency-conflict",
            "requestId was already used with different content",
          );
        if (prior.bounce) return prior.bounce;
        const located = prior.messageId ? this.findMessage(store, prior.messageId) : null;
        if (located) return located.message;
        const counterpart = prior.messageId ? store.counterparts[prior.messageId] : undefined;
        if (counterpart) return { ...counterpart, body: "" };
        throw new AgentMailError(
          "message-not-found",
          "Idempotent message record is no longer retained",
        );
      }
      if (Object.keys(store.idempotency).length >= AGENT_MAIL_MAX_IDEMPOTENCY_ROWS) {
        throw new AgentMailError("store-full", "Agent mail idempotency store is full");
      }

      const destinationId = agentMailboxId(input.toEnvironmentId, input.toTabId);
      const recipient = store.mailboxes[destinationId];
      if (!recipient || recipient.tombstonedAt)
        throw new AgentMailError("recipient-not-found", "Recipient mailbox is not active");
      // A mailbox is a tab, so a subagent or background task inside that tab
      // shares its address. Mail it sends "to the parent" would land back in
      // its own inbox and only surface when the whole tab next goes idle —
      // usually after the subagent that needed an answer has finished.
      if (senderMailbox?.mailboxId === destinationId)
        throw new AgentMailError(
          "policy-denied",
          "A tab cannot message its own mailbox. Subagents and background tasks share their parent tab's address, so this would only reach you; report to the parent session in your final result instead.",
        );
      // A side agent talks to its main coordinator and nobody else; only the
      // main (or the user) may talk to it. Everything else in the project
      // addresses the main, so a side agent is never a second coordinator.
      if (
        senderMailbox?.coordinatorRole === "side" &&
        !(
          recipient.ownerKind === "coordinator" &&
          recipient.coordinatorRole === "main" &&
          recipient.coordinatorId === senderMailbox.coordinatorId
        )
      ) {
        throw new AgentMailError(
          "policy-denied",
          'A side agent can only message the main coordinator. Send to "coordinator".',
        );
      }
      if (
        recipient.coordinatorRole === "side" &&
        sender.kind !== "user" &&
        !(
          senderMailbox?.coordinatorRole === "main" &&
          senderMailbox.coordinatorId === recipient.coordinatorId
        )
      ) {
        throw new AgentMailError(
          "policy-denied",
          'Side agents only receive mail from the main coordinator. Send to "coordinator" instead.',
        );
      }
      const crossProject = senderMailbox && senderMailbox.projectId !== recipient.projectId;
      if (crossProject && !settings.allowCrossProject)
        throw new AgentMailError("policy-denied", "Cross-project messaging is disabled");

      let parent: AgentMailMessage | undefined;
      if (input.replyToMessageId) {
        parent = this.findMessage(store, input.replyToMessageId)?.message;
        if (!parent) throw new AgentMailError("message-not-found", "Reply parent was not found");
        if (exceedsThreadHops(parent))
          throw new AgentMailError("hop-limit", "Thread hop limit reached");
        if (sender.kind === "tab" || sender.kind === "coordinator") {
          const senderIsParentSource =
            (parent.from.kind === "tab" || parent.from.kind === "coordinator") &&
            parent.from.environmentId === sender.environmentId &&
            parent.from.tabId === sender.tabId;
          const senderIsParentRecipient =
            parent.toEnvironmentId === sender.environmentId && parent.toTabId === sender.tabId;
          const senderParticipates = senderIsParentSource || senderIsParentRecipient;
          if (!senderParticipates)
            throw new AgentMailError("policy-denied", "Sender is not a participant in this thread");
          const senderIncarnationMatches = senderIsParentSource
            ? (parent.from.kind === "tab" || parent.from.kind === "coordinator") &&
              parent.from.incarnationId === senderMailbox?.incarnationId
            : parent.toIncarnationId === senderMailbox?.incarnationId;
          if (!senderIncarnationMatches) {
            throw new AgentMailError(
              "recipient-superseded",
              "This thread belongs to a prior incarnation of the sender tab",
            );
          }
          const expectedOther =
            (parent.from.kind === "tab" || parent.from.kind === "coordinator") &&
            parent.toEnvironmentId === sender.environmentId &&
            parent.toTabId === sender.tabId
              ? agentMailboxId(parent.from.environmentId, parent.from.tabId)
              : agentMailboxId(parent.toEnvironmentId, parent.toTabId);
          if (expectedOther !== destinationId)
            throw new AgentMailError("policy-denied", "A reply cannot redirect the thread");
          const expectedIncarnation =
            (parent.from.kind === "tab" || parent.from.kind === "coordinator") &&
            expectedOther === agentMailboxId(parent.from.environmentId, parent.from.tabId)
              ? parent.from.incarnationId
              : parent.toIncarnationId;
          if (recipient.incarnationId !== expectedIncarnation) {
            throw new AgentMailError(
              "recipient-superseded",
              "The other thread participant was closed and recreated",
            );
          }
        }
      }

      if (recipient.messages.length >= AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX) {
        const eligible = recipient.messages
          .map((message, index) => ({ message, index }))
          .filter(
            ({ message }) =>
              message.ackedAt || message.discardedAt || SETTLED_PLACEMENTS.has(message.placement),
          )
          .sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt))[0];
        if (!eligible)
          throw new AgentMailError(
            "mailbox-backlog-full",
            "Recipient mailbox has too many unsettled messages",
          );
        recipient.messages.splice(eligible.index, 1);
      }

      const now = new Date().toISOString();
      const id = sortableId();
      const trust: AgentMailTrust =
        sender.kind === "user"
          ? "user"
          : sender.kind === "system" || sender.kind === "node"
            ? sender.projectId === recipient.projectId
              ? "same-project"
              : "cross-project"
            : sender.kind === "external"
              ? "external"
              : sender.environmentId === recipient.environmentId
                ? "same-environment"
                : sender.projectId === recipient.projectId
                  ? "same-project"
                  : "cross-project";
      const lineageCutoff = Date.now() - settings.retentionDays * 86_400_000;
      // Acknowledging a carrier must not reset its injection lineage: the
      // carrier itself asks the recipient to ack, and replies ack implicitly.
      // Retention bounds how long the lineage suppresses autonomous delivery.
      const recentlyInjected =
        senderMailbox?.messages.some(
          (message) =>
            message.injectedAt !== undefined && Date.parse(message.injectedAt) >= lineageCutoff,
        ) ?? false;
      const injectDepth =
        sender.kind === "tab" || sender.kind === "coordinator"
          ? parent?.injectedAt
            ? parent.injectDepth + 1
            : recentlyInjected
              ? 1
              : 0
          : 0;
      const effectivePolicy =
        recipient.injectOverride === "inherit"
          ? settings.defaultInjectPolicy
          : recipient.injectOverride;
      const route = classifyAgentMailRoute({
        trust,
        sender:
          sender.kind === "tab"
            ? { kind: "tab", coordinatorOrigin: senderMailbox?.coordinatorOrigin }
            : sender.kind === "coordinator"
              ? { kind: "coordinator", environmentId: senderMailbox!.environmentId }
              : { kind: sender.kind },
        recipient,
      });
      // Coordinator ↔ its workers, and peer ↔ peer, wake the recipient whatever
      // the default inject policy is. Only an explicit per-tab Off or a mute
      // stops them; the pair hop budget below bounds an unattended exchange.
      const routeWakes = agentMailRouteWakes(route, recipient.injectOverride, settings);
      // The pair a routed budget counts: the sending tab, the remote sender of
      // node mail, or for a workflow status notice the resource it reports on.
      const budgetSenderId =
        senderMailbox?.mailboxId ??
        (sender.kind === "node" ? nodeMailSenderKey(sender) : statusBudgetKey);
      const pairDepth =
        routeWakes && budgetSenderId
          ? latestMailboxPairDepth(store, budgetSenderId, destinationId, lineageCutoff)
          : null;
      // Only admission of a new delegation, a user prompt, or Resume resets
      // the pair budget. Follow-ups and main/side mail consume the same lineage.
      const startsBudget =
        options.newDelegation === true &&
        (sender.kind === "coordinator" ||
          (sender.kind === "node" && sender.role === "coordinator")) &&
        recipient.ownerKind !== "coordinator";
      const pairEpoch = startsBudget
        ? store.revision
        : budgetSenderId
          ? pairBudgetEpoch(store, budgetSenderId, destinationId)
          : 0;
      const parentDepthInEpoch =
        parent?.autonomousSequence !== undefined && parent.autonomousSequence > pairEpoch
          ? parent.threadDepth
          : -1;
      const nextThreadDepth = !routeWakes
        ? (parent?.threadDepth ?? -1) + 1
        : startsBudget
          ? 0
          : Math.max(parentDepthInEpoch, pairDepth ?? -1) + 1;
      const depthLimit = routeWakes ? settings.autonomousWakeBudget : AGENT_MAIL_MAX_THREAD_HOPS;
      const overHourlyLimit =
        routeWakes &&
        budgetSenderId !== undefined &&
        pairMessagesInLastHour(store, budgetSenderId, destinationId, Date.now()) >=
          settings.hourlyWakeLimit;
      const canInject = agentMailCapabilities(
        recipient.tabType,
        recipient.agent,
        recipient.locked,
      ).canInject;
      /*
       * A worker reporting to the coordinator that is currently waiting on it
       * does not get to interrupt. The coordinator asked for one answer and is
       * woken once, when the worker's turn ends; anything the worker sends
       * before then — a progress note, a partial finding, a second thought — is
       * stored and released together with that wake.
       *
       * This is the difference between a dispatcher and a chat room. Without it
       * a chatty worker turns one delegation into a turn per message, each one
       * billable and each one interrupting whatever the user is doing with the
       * coordinator. The message is never lost: it is readable immediately
       * through the mail tools and delivered in full on completion.
       */
      const holdingDelegation =
        (sender.kind === "tab" || (sender.kind === "node" && sender.role === "agent")) &&
        recipient.ownerKind === "coordinator" &&
        trust === "same-project"
          ? (await this.repos.coordinators.listOpenCoordinatorDelegations()).find(
              (association) =>
                // A worker on another node is the same worker only on that node.
                (sender.kind === "node"
                  ? association.nodeId === sender.nodeId
                  : association.nodeId === undefined) &&
                association.resourceId === sender.environmentId &&
                association.delegation?.workerTabId === sender.tabId &&
                // The delegation has to belong to *this* conversation. A second
                // conversation that never asked this worker for anything is not
                // waiting on it, so holding its mail would silence a message
                // nothing will ever release.
                association.conversationId !== undefined &&
                (coordinatorRuntimeId(association.coordinatorId, association.conversationId) ===
                  recipient.environmentId ||
                  // Work moves to the main coordinator; so does the hold.
                  (recipient.coordinatorRole === "main" &&
                    recipient.coordinatorId === association.coordinatorId)),
            )
          : undefined;
      const heldForDelegation =
        Boolean(holdingDelegation) && nextThreadDepth < depthLimit && !overHourlyLimit;
      const shouldScheduleInject =
        (effectivePolicy === "idle" || routeWakes) &&
        !recipient.mutedInbound &&
        !heldForDelegation &&
        trust !== "cross-project" &&
        trust !== "external" &&
        (injectDepth === 0 || routeWakes) &&
        nextThreadDepth < depthLimit &&
        !overHourlyLimit &&
        canInject;
      const heldForLoopBudget =
        routeWakes && !recipient.mutedInbound && nextThreadDepth >= depthLimit && canInject;
      const heldForHourlyLimit =
        routeWakes && !recipient.mutedInbound && !heldForLoopBudget && overHourlyLimit && canInject;
      const message: AgentMailMessage = {
        version: 1,
        id,
        threadId: parent?.threadId ?? id,
        ...(parent ? { replyToMessageId: parent.id } : {}),
        requestId,
        createdAt: now,
        from: actor,
        toEnvironmentId: recipient.environmentId,
        toTabId: recipient.tabId,
        toIncarnationId: recipient.incarnationId,
        ...(subject ? { subject } : {}),
        body: input.body,
        bodyBytes,
        trust,
        injectDepth,
        threadDepth: nextThreadDepth,
        ...(routeWakes
          ? { autonomousSequence: store.revision + 1, autonomousBudgetEpoch: pairEpoch }
          : {}),
        ...((shouldScheduleInject || heldForDelegation) && routeWakes
          ? { wakeAdmittedAt: now }
          : {}),
        ...(sender.kind === "coordinator" && recipientEnvironment?.status === "stopped"
          ? {
              recipientStoppedAtSend: true,
              recipientStopGeneration: recipientEnvironment.stopGeneration ?? 0,
            }
          : {}),
        ...(route ? { route } : {}),
        ...(notice ? { notice } : {}),
        ...(statusBudgetKey ? { statusBudgetKey } : {}),
        placement: shouldScheduleInject
          ? "pending-inject"
          : heldForDelegation || heldForLoopBudget || heldForHourlyLimit
            ? "inject-held"
            : "stored",
        ...(shouldScheduleInject
          ? {
              injectRequestId: `mail-inject-${id}`,
              ...(settings.paused ? { placementReason: "paused" } : {}),
            }
          : heldForDelegation
            ? {
                // Minted now, not on release: the delegation's completion
                // pushes this straight onto the pending index, and an inject
                // identity invented at that point would differ across a retry.
                injectRequestId: `mail-inject-${id}`,
                placementReason: COORDINATOR_DELEGATION_HOLD_REASON,
                coordinatorDelegationId: holdingDelegation!.id,
              }
            : heldForLoopBudget
              ? { placementReason: AGENT_MAIL_LOOP_BUDGET_REASON }
              : heldForHourlyLimit
                ? { placementReason: AGENT_MAIL_HOURLY_LIMIT_REASON }
                : {
                    // Stored is a decision, not a default: name why nobody will
                    // be woken so the sender and the user can see it.
                    placementReason:
                      trust === "cross-project" || trust === "external"
                        ? "untrusted-sender"
                        : !canInject
                          ? "recipient-cannot-inject"
                          : effectivePolicy !== "idle" && !routeWakes
                            ? route === "isolated"
                              ? "isolated-route"
                              : "inject-policy-off"
                            : injectDepth !== 0 && !routeWakes
                              ? "reply-to-injected-turn"
                              : "hop-limit",
                  }),
        revision: 1,
      };
      if (recipient.mutedInbound) {
        message.placement = "bounced";
        message.placementReason = "recipient-muted";
        store.idempotency[key] = {
          senderScope,
          requestId,
          fingerprint,
          createdAt: now,
          bounce: message,
        };
      } else {
        recipient.messages.push(message);
        recipient.revision += 1;
        store.idempotency[key] = {
          senderScope,
          requestId,
          fingerprint,
          createdAt: now,
          mailboxId: destinationId,
          messageId: id,
        };
        if (shouldScheduleInject) {
          store.pendingInject.push({
            mailboxId: destinationId,
            messageId: id,
            ...(options.coalesceMs && options.coalesceMs > 0
              ? {
                  retryAt: coalescingWindow(store, destinationId, options.coalesceMs),
                  coalescing: true as const,
                }
              : {}),
          });
        }
      }
      store.revision += 1;
      await this.saveAgentMailStore(store);
      // Ids and decisions only: never subjects or bodies.
      console.info("[agent-mail] placed", {
        messageId: message.id,
        from: message.from.kind,
        toEnvironmentId: message.toEnvironmentId,
        toTabId: message.toTabId,
        route: route ?? "none",
        trust,
        placement: message.placement,
        reason: message.placementReason ?? null,
        injectDepth,
        threadDepth: nextThreadDepth,
      });
      this.context.changes.announce("agent-mail", destinationId, recipient.projectId);
      this.context.changes.announce("agent-mail-summary", "all");
      return message;
    });
    await this.noticeCoordinatorBudgetHold(placed);
    return placed;
  }

  /**
   * Tell a coordinator, once per budget, that a worker's mail is being held.
   *
   * The held message cannot wake anyone, so without this the coordinator would
   * never learn the worker is still talking. The notice is a workflow message
   * and wakes it once; its request id is fixed per budget epoch (or per hour
   * for the hourly limit), so a worker that keeps sending does not keep waking
   * it. Mail the coordinator itself sent is not noticed: its send result
   * already reports the hold.
   */
  private async noticeCoordinatorBudgetHold(message: AgentMailMessage): Promise<void> {
    const from = message.from;
    if (
      !(from.kind === "tab" || (from.kind === "node" && from.role === "agent")) ||
      message.route !== "coordinator"
    )
      return;
    if (!isAgentMailBudgetHeld(message)) return;
    const store = await this.loadAgentMailStore();
    const coordinatorMailboxId = agentMailboxId(message.toEnvironmentId, message.toTabId);
    if (store.mailboxes[coordinatorMailboxId]?.ownerKind !== "coordinator") return;
    const workerMailboxId =
      from.kind === "node"
        ? nodeMailSenderKey(from)
        : agentMailboxId(from.environmentId, from.tabId);
    const onNode = from.kind === "node" ? ` on ${from.nodeName}` : "";
    const hourly = message.placementReason === AGENT_MAIL_HOURLY_LIMIT_REASON;
    const window = hourly
      ? `hour-${Math.floor(Date.parse(message.createdAt) / 3_600_000)}`
      : `epoch-${pairBudgetEpoch(store, workerMailboxId, coordinatorMailboxId)}`;
    const worker = from.title ?? from.tabId;
    try {
      await this.sendAgentMail(
        {
          kind: "system",
          projectId: from.projectId,
          source: "workflow",
          resourceId: from.environmentId,
        },
        {
          requestId: `mail-budget:${from.tabId}:${message.toTabId}:${window}`,
          toEnvironmentId: message.toEnvironmentId,
          toTabId: message.toTabId,
          subject: hourly ? "Worker mail held: hourly limit" : "Worker mail held: loop budget",
          body: hourly
            ? `Mail from worker ${worker} (environment ${from.environmentId}${onNode}) reached the hourly message limit for this conversation and is being held. It is delivered automatically as the hour passes. Read it now with read_messages if it cannot wait.`
            : `Mail from worker ${worker} (environment ${from.environmentId}${onNode}) used up its unattended message budget and is being held. Read it with read_messages, then send the worker a new request (which starts a new budget) or ask the user to resume delivery.`,
        },
        {
          notice: {
            resource: {
              kind: "agent-tab",
              id: from.tabId,
              environmentId: from.environmentId,
              tabId: from.tabId,
              ...(from.title ? { label: from.title } : {}),
            },
            state: "mail-held",
            tone: "attention",
          },
        },
      );
    } catch (error) {
      console.warn(
        "[agent-mail] Could not notify the coordinator of held worker mail:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * Start a new routed budget between a coordinator and a worker on another
   * node, as admitting a new local delegation does. The request itself went
   * to that node, so nothing here would otherwise mark the new epoch, and the
   * worker's reports would keep counting against every earlier delegation.
   */
  async startRemoteWorkerBudget(
    coordinator: { environmentId: string; tabId: string },
    worker: { nodeId: string; environmentId: string; tabId: string },
  ): Promise<void> {
    await this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const key = pairEpochKey(
        agentMailboxId(coordinator.environmentId, coordinator.tabId),
        nodeMailSenderKey(worker),
      );
      const epochs = { ...store.pairEpochs, [key]: store.revision + 1 };
      const keys = Object.keys(epochs);
      if (keys.length > MAX_PAIR_EPOCHS) {
        for (const stale of keys
          .sort((a, b) => epochs[a]! - epochs[b]!)
          .slice(0, keys.length - MAX_PAIR_EPOCHS)) {
          delete epochs[stale];
        }
      }
      store.pairEpochs = epochs;
      store.revision += 1;
      await this.saveAgentMailStore(store);
    });
  }

  /**
   * Start a new routed budget for the tab a user just prompted.
   *
   * A person taking part in an exchange is the authority the budget stands in
   * for, so a prompt to either tab of a pair lets it run unattended again.
   * Mail already held stays held until Resume: the prompt is about what the
   * user typed, not consent to deliver a backlog. A no-op when nothing routed
   * has touched the tab since its last reset.
   */
  async resetAgentMailBudgetForSession(
    environmentId: string,
    logicalSessionKey: string,
  ): Promise<boolean> {
    return this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const mailbox = Object.values(store.mailboxes).find(
        (candidate) =>
          candidate.environmentId === environmentId &&
          !candidate.tombstonedAt &&
          (candidate.logicalSessionKey ?? `env-${candidate.environmentId}:${candidate.tabId}`) ===
            logicalSessionKey,
      );
      if (!mailbox) return false;
      let latest = 0;
      for (const candidate of Object.values(store.mailboxes)) {
        for (const message of candidate.messages) {
          if (message.autonomousSequence === undefined) continue;
          if (
            candidate.mailboxId !== mailbox.mailboxId &&
            !(
              (message.from.kind === "tab" || message.from.kind === "coordinator") &&
              agentMailboxId(message.from.environmentId, message.from.tabId) === mailbox.mailboxId
            )
          ) {
            continue;
          }
          latest = Math.max(latest, message.autonomousSequence);
        }
      }
      if (latest <= (mailbox.budgetResetSequence ?? 0)) return false;
      mailbox.budgetResetSequence = store.revision + 1;
      mailbox.revision += 1;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      this.context.changes.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      return true;
    });
  }

  /**
   * Release mail held by the hourly limit once its pair is back under it.
   *
   * The hourly limit is a runaway guard, not a request for a person to step
   * in, so it clears itself. Oldest first, and only as many as the window has
   * room for, so a burst is spread across the hour rather than replayed at once.
   */
  async releaseHourlyHeldAgentMail(): Promise<number> {
    const settings = normalizeAgentMessagingSettings(
      (await this.repos.config.loadConfig()).global.agentMessaging,
    );
    const store = await this.loadAgentMailStore();
    const hasHeld = Object.values(store.mailboxes).some((mailbox) =>
      mailbox.messages.some(
        (message) =>
          message.placement === "inject-held" &&
          message.placementReason === AGENT_MAIL_HOURLY_LIMIT_REASON,
      ),
    );
    if (!hasHeld) return 0;
    return this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const now = Date.now();
      const changed = new Set<PersistedMailbox>();
      for (const mailbox of Object.values(store.mailboxes)) {
        if (mailbox.tombstonedAt || mailbox.mutedInbound) continue;
        const held = mailbox.messages
          .filter(
            (message) =>
              message.placement === "inject-held" &&
              message.placementReason === AGENT_MAIL_HOURLY_LIMIT_REASON &&
              !message.discardedAt &&
              budgetSenderOf(message) !== null,
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        for (const message of held) {
          const senderMailboxId = budgetSenderOf(message);
          if (!senderMailboxId) continue;
          if (
            pairMessagesInLastHour(store, senderMailboxId, mailbox.mailboxId, now) >=
            settings.hourlyWakeLimit
          ) {
            continue;
          }
          message.placement = "pending-inject";
          message.wakeAdmittedAt = new Date(now).toISOString();
          delete message.placementReason;
          message.injectRequestId ??= `mail-inject-${message.id}`;
          message.revision += 1;
          store.pendingInject.push({ mailboxId: mailbox.mailboxId, messageId: message.id });
          changed.add(mailbox);
        }
      }
      if (changed.size === 0) return 0;
      for (const mailbox of changed) mailbox.revision += 1;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      for (const mailbox of changed) {
        this.context.changes.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      }
      this.context.changes.announce("agent-mail-summary", "all");
      return changed.size;
    });
  }

  async replyAgentMail(
    sender: Extract<AgentMailSender, { kind: "tab" }>,
    parentMessageId: string,
    requestId: string,
    body: string,
    subject?: string,
  ): Promise<AgentMailMessage> {
    const parent = await this.getAgentMailMessage(
      sender.environmentId,
      sender.tabId,
      parentMessageId,
    );
    if (parent.from.kind !== "tab" && parent.from.kind !== "coordinator")
      throw new AgentMailError("policy-denied", "This sender cannot receive a tab reply");
    return this.sendAgentMail(sender, {
      requestId,
      toEnvironmentId: parent.from.environmentId,
      toTabId: parent.from.tabId,
      body,
      subject,
      replyToMessageId: parent.id,
    });
  }

  private async mutateMessage(
    environmentId: string,
    tabId: string,
    messageId: string,
    mutation: (message: AgentMailMessage) => boolean,
  ): Promise<AgentMailMessage> {
    return this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const mailbox = store.mailboxes[agentMailboxId(environmentId, tabId)];
      const message = mailbox?.messages.find((candidate) => candidate.id === messageId);
      if (!mailbox || !message)
        throw new AgentMailError("message-not-found", "Message not found in this mailbox");
      if (!mutation(message)) return message;
      message.revision += 1;
      mailbox.revision += 1;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      this.context.changes.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      this.context.changes.announce("agent-mail-summary", "all");
      return message;
    });
  }

  ackAgentMail(environmentId: string, tabId: string, messageId: string): Promise<AgentMailMessage> {
    return this.mutateMessage(environmentId, tabId, messageId, (message) => {
      if (message.ackedAt) return false;
      message.ackedAt = new Date().toISOString();
      return true;
    });
  }

  markAgentMailSeen(
    environmentId: string,
    tabId: string,
    messageId: string,
  ): Promise<AgentMailMessage> {
    return this.mutateMessage(environmentId, tabId, messageId, (message) => {
      if (message.userSeenAt) return false;
      message.userSeenAt = new Date().toISOString();
      return true;
    });
  }

  /**
   * Make already-stored mail deliverable once a mailbox gains an agent.
   *
   * A coordinator conversation has no provider until its first prompt, and a
   * mailbox with no agent cannot be injected into — so a workflow notice or a
   * worker reply that arrives in the meantime is filed as `stored` and would
   * otherwise sit there for good. Assignment is the moment that becomes
   * deliverable, and this applies exactly the eligibility rule
   * `retryAgentMailInject` uses for the same transition, rather than a looser
   * one that could wake mail the user muted or already acknowledged.
   */
  async promoteStoredAgentMailForMailbox(environmentId: string, tabId: string): Promise<number> {
    const settings = normalizeAgentMessagingSettings(
      (await this.repos.config.loadConfig()).global.agentMessaging,
    );
    return this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const mailbox = store.mailboxes[agentMailboxId(environmentId, tabId)];
      if (!mailbox) return 0;
      const promoted = this.promoteStoredMessages(store, mailbox, settings, "all");
      if (promoted === 0) return 0;
      mailbox.revision += 1;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      this.context.changes.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      this.context.changes.announce("agent-mail-summary", "all");
      return promoted;
    });
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
  private promoteStoredMessages(
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

  /** Whether this exact delegation has a worker report waiting to be released. */
  async hasDelegationHeldAgentMail(
    associationId: string,
    coordinatorEnvironmentId: string,
    coordinatorTabId: string,
    workerEnvironmentId: string,
    workerTabId: string,
  ): Promise<boolean> {
    const store = await this.loadAgentMailStore();
    const mailbox = store.mailboxes[agentMailboxId(coordinatorEnvironmentId, coordinatorTabId)];
    return Boolean(
      mailbox?.messages.some(
        (message) =>
          message.placement === "inject-held" &&
          message.placementReason === COORDINATOR_DELEGATION_HOLD_REASON &&
          (message.coordinatorDelegationId === associationId ||
            message.coordinatorDelegationId === undefined) &&
          (message.from.kind === "tab" || message.from.kind === "node") &&
          message.from.environmentId === workerEnvironmentId &&
          message.from.tabId === workerTabId &&
          !message.ackedAt &&
          !message.discardedAt,
      ),
    );
  }

  /**
   * Release the mail a finished worker sent while its coordinator was waiting.
   *
   * Every held message becomes deliverable at once, oldest first, so the
   * coordinator's next turn sees the whole exchange in order rather than one
   * message now and the rest on later sweeps. The durable delegation wake kind,
   * recorded before this mutation, distinguishes a silent worker from a retry
   * after an earlier pass already released the report.
   */
  /**
   * Hand a replaced main coordinator's unhandled mail to the new main.
   *
   * Closing the main tombstones its mailbox, which marks what was waiting there
   * undeliverable — including a worker's report held for a delegation. When a
   * new main starts it collects that mail: a report its delegation still owes
   * goes back to being held for that delegation (which moved with it),
   * anything else waits for delivery. Acknowledged, discarded and expired mail
   * stays where it was.
   */
  async moveClosedCoordinatorMail(
    coordinatorId: string,
    to: { environmentId: string; tabId: string },
    owedDelegations: ReadonlySet<string>,
  ): Promise<number> {
    const settings = normalizeAgentMessagingSettings(
      (await this.repos.config.loadConfig()).global.agentMessaging,
    );
    return this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const target = store.mailboxes[agentMailboxId(to.environmentId, to.tabId)];
      if (!target || target.tombstonedAt) return 0;
      const cutoff = Date.now() - settings.retentionDays * 86_400_000;
      let moved = 0;
      for (const mailbox of Object.values(store.mailboxes)) {
        if (
          mailbox === target ||
          !mailbox.tombstonedAt ||
          mailbox.ownerKind !== "coordinator" ||
          mailbox.coordinatorId !== coordinatorId ||
          mailbox.coordinatorRole === "side"
        ) {
          continue;
        }
        const keep: AgentMailMessage[] = [];
        for (const message of mailbox.messages) {
          const waiting =
            message.placement === "pending-inject" ||
            message.placement === "inject-held" ||
            message.placement === "stored" ||
            (message.placement === "undeliverable" && message.placementReason === "tab-closed");
          if (
            !waiting ||
            message.ackedAt ||
            message.discardedAt ||
            Date.parse(message.createdAt) < cutoff ||
            target.messages.length >= AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX
          ) {
            keep.push(message);
            continue;
          }
          message.toEnvironmentId = target.environmentId;
          message.toTabId = target.tabId;
          message.toIncarnationId = target.incarnationId;
          if (message.placement !== "stored") {
            const owed =
              message.coordinatorDelegationId !== undefined &&
              owedDelegations.has(message.coordinatorDelegationId);
            const canInject = agentMailCapabilities(
              target.tabType,
              target.agent,
              target.locked,
            ).canInject;
            message.placement = owed ? "inject-held" : canInject ? "pending-inject" : "stored";
            message.placementReason = owed
              ? COORDINATOR_DELEGATION_HOLD_REASON
              : canInject
                ? undefined
                : "recipient-cannot-inject";
            if (!owed && canInject) {
              message.injectRequestId ??= `mail-inject-${message.id}`;
              store.pendingInject.push({ mailboxId: target.mailboxId, messageId: message.id });
            }
          }
          message.revision += 1;
          target.messages.push(message);
          moved += 1;
        }
        if (keep.length !== mailbox.messages.length) {
          store.pendingInject = store.pendingInject.filter(
            (entry) =>
              entry.mailboxId !== mailbox.mailboxId ||
              keep.some((message) => message.id === entry.messageId),
          );
          mailbox.messages = keep;
          mailbox.revision += 1;
        }
      }
      if (moved === 0) return 0;
      target.revision += 1;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      this.context.changes.announce("agent-mail", target.mailboxId, target.projectId);
      this.context.changes.announce("agent-mail-summary", "all");
      return moved;
    });
  }

  /**
   * Release worker mail still held for a delegation nobody owes a wake any
   * more.
   *
   * A report can be held in the instant between its delegation being read as
   * open and that delegation closing with a "finished without a report"
   * notice. The wake then never looks for it, and without this it would stay
   * held for good. `owed` is every delegation still open or closed but not yet
   * woken; anything held for a different delegation is released to deliver as
   * ordinary mail.
   */
  async releaseOrphanedDelegationHolds(owed: ReadonlySet<string>): Promise<number> {
    return this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      let released = 0;
      const changed = new Set<PersistedMailbox>();
      for (const mailbox of Object.values(store.mailboxes)) {
        for (const message of mailbox.messages) {
          if (
            message.placement !== "inject-held" ||
            message.placementReason !== COORDINATOR_DELEGATION_HOLD_REASON ||
            !message.coordinatorDelegationId ||
            owed.has(message.coordinatorDelegationId) ||
            message.ackedAt ||
            message.discardedAt
          ) {
            continue;
          }
          message.placement = "pending-inject";
          delete message.placementReason;
          message.injectRequestId ??= `mail-inject-${message.id}`;
          message.revision += 1;
          store.pendingInject.push({ mailboxId: mailbox.mailboxId, messageId: message.id });
          changed.add(mailbox);
          released += 1;
        }
      }
      if (released === 0) return 0;
      for (const mailbox of changed) mailbox.revision += 1;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      for (const mailbox of changed) {
        this.context.changes.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      }
      this.context.changes.announce("agent-mail-summary", "all");
      return released;
    });
  }

  async releaseDelegationHeldAgentMail(
    associationId: string,
    coordinatorEnvironmentId: string,
    coordinatorTabId: string,
    workerEnvironmentId: string,
    workerTabId: string,
  ): Promise<number> {
    return this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const mailboxId = agentMailboxId(coordinatorEnvironmentId, coordinatorTabId);
      const mailbox = store.mailboxes[mailboxId];
      if (!mailbox) return 0;
      let released = 0;
      const held = mailbox.messages
        .filter(
          (message) =>
            message.placement === "inject-held" &&
            message.placementReason === COORDINATOR_DELEGATION_HOLD_REASON &&
            (message.coordinatorDelegationId === associationId ||
              message.coordinatorDelegationId === undefined) &&
            (message.from.kind === "tab" || message.from.kind === "node") &&
            message.from.environmentId === workerEnvironmentId &&
            message.from.tabId === workerTabId &&
            !message.ackedAt &&
            !message.discardedAt,
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const message of held) {
        message.placement = "pending-inject";
        delete message.placementReason;
        message.injectRequestId ??= `mail-inject-${message.id}`;
        message.revision += 1;
        if (
          !store.pendingInject.some(
            (candidate) => candidate.mailboxId === mailboxId && candidate.messageId === message.id,
          )
        ) {
          store.pendingInject.push({ mailboxId, messageId: message.id });
        }
        released += 1;
      }
      if (released === 0) return 0;
      mailbox.revision += 1;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      this.context.changes.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      this.context.changes.announce("agent-mail-summary", "all");
      return released;
    });
  }

  async retryAgentMailInject(
    environmentId: string,
    tabId: string,
    messageId: string,
  ): Promise<AgentMailMessage> {
    const settings = normalizeAgentMessagingSettings(
      (await this.repos.config.loadConfig()).global.agentMessaging,
    );
    return this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const mailboxId = agentMailboxId(environmentId, tabId);
      const mailbox = store.mailboxes[mailboxId];
      const message = mailbox?.messages.find((candidate) => candidate.id === messageId);
      if (!mailbox || !message)
        throw new AgentMailError("message-not-found", "Message not found in this mailbox");
      const resumesLoopBudget = isAgentMailBudgetHeld(message);
      const wakesPending = message.placement === "pending-inject";
      const wakesStored =
        message.placement === "stored" &&
        !message.ackedAt &&
        !message.discardedAt &&
        !mailbox.mutedInbound &&
        (message.injectDepth === 0 || routedMessageWakes(message, mailbox, settings)) &&
        !exceedsThreadHops(message) &&
        message.trust !== "cross-project" &&
        message.trust !== "external" &&
        agentMailCapabilities(mailbox.tabType, mailbox.agent, mailbox.locked).canInject;
      if (
        message.placement !== "inject_failed" &&
        !resumesLoopBudget &&
        !wakesPending &&
        !wakesStored
      )
        return message;
      if (wakesPending) {
        const pending = store.pendingInject.find(
          (candidate) => candidate.mailboxId === mailboxId && candidate.messageId === message.id,
        );
        if (pending) {
          delete pending.nextAttemptAt;
          pending.attempts = 0;
          // A person asked: skip the remaining wait. A pending journal check
          // stays, so an ambiguous dispatch is still never sent twice.
          delete pending.retryAt;
        }
      }
      message.placement = "pending-inject";
      if (!wakesPending || wakesStored) delete message.placementReason;
      message.injectRequestId ??= `mail-inject-${message.id}`;
      // A person asked for this message. The drain delivers it once even when
      // the mailbox policy is off, without the caller having to change that
      // policy (which would also change how every later message is routed).
      message.userReleasedAt = new Date().toISOString();
      const released = [message];
      if (resumesLoopBudget) {
        // Resume is one decision for this tab, not one per message: release
        // everything its budgets were holding and start a new budget for every
        // pair it is in. Replies keep their thread identity, and the epoch
        // still cannot move by changing subject or acknowledging mail.
        mailbox.budgetResetSequence = store.revision + 1;
        for (const sibling of mailbox.messages) {
          if (sibling === message || !isAgentMailBudgetHeld(sibling) || sibling.discardedAt)
            continue;
          sibling.placement = "pending-inject";
          delete sibling.placementReason;
          sibling.injectRequestId ??= `mail-inject-${sibling.id}`;
          sibling.userReleasedAt = message.userReleasedAt;
          sibling.revision += 1;
          released.push(sibling);
        }
        for (const entry of released) {
          entry.threadDepth = 0;
          entry.injectDepth = 0;
          entry.autonomousSequence = store.revision + 1;
        }
      }
      for (const entry of released) {
        if (
          !store.pendingInject.some(
            (candidate) => candidate.mailboxId === mailboxId && candidate.messageId === entry.id,
          )
        ) {
          store.pendingInject.push({ mailboxId, messageId: entry.id });
        }
      }
      message.revision += 1;
      mailbox.revision += 1;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      this.context.changes.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      this.context.changes.announce("agent-mail-summary", "all");
      return message;
    });
  }

  discardAgentMail(
    environmentId: string,
    tabId: string,
    messageId: string,
  ): Promise<AgentMailMessage> {
    return this.mutateMessage(environmentId, tabId, messageId, (message) => {
      if (message.discardedAt) return false;
      if (message.placement === "inject-held" && message.placementReason === "submitting") {
        throw new AgentMailError(
          "policy-denied",
          "Delivery is currently being submitted; wait for it to settle before discarding",
        );
      }
      message.discardedAt = new Date().toISOString();
      if (message.placement === "pending-inject" || message.placement === "inject_failed") {
        message.placement = "expired";
        message.placementReason = "discarded";
      }
      return true;
    });
  }

  async updateAgentMailboxPolicy(
    environmentId: string,
    tabId: string,
    updates: {
      inject?: "inherit" | "off" | "idle";
      mutedInbound?: boolean;
      mutedOutbound?: boolean;
    },
  ): Promise<MailboxDescriptor> {
    await this.synchronizeAgentMailboxes();
    return this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const mailbox = store.mailboxes[agentMailboxId(environmentId, tabId)];
      if (!mailbox) throw new AgentMailError("recipient-not-found", "Mailbox not found");
      const config = await this.repos.config.loadConfig();
      const settings = normalizeAgentMessagingSettings(config.global.agentMessaging);
      const defaultPolicy = settings.defaultInjectPolicy;
      const deliversWhenIdle = () =>
        !mailbox.mutedInbound &&
        (mailbox.injectOverride === "inherit" ? defaultPolicy : mailbox.injectOverride) === "idle";
      const routesWake = () => !mailbox.mutedInbound && mailbox.injectOverride !== "off";
      const delivered = deliversWhenIdle();
      const routed = routesWake();
      if (updates.inject) mailbox.injectOverride = updates.inject;
      if (typeof updates.mutedInbound === "boolean") mailbox.mutedInbound = updates.mutedInbound;
      if (typeof updates.mutedOutbound === "boolean") mailbox.mutedOutbound = updates.mutedOutbound;
      // Turning delivery on is a request to deliver what is already waiting,
      // not only what arrives next. Mail sent while delivery was off would
      // otherwise stay `stored` until an agent happened to pull it.
      if (!delivered && deliversWhenIdle())
        this.promoteStoredMessages(store, mailbox, settings, "all");
      else if (!routed && routesWake())
        this.promoteStoredMessages(store, mailbox, settings, "routed");
      mailbox.revision += 1;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      this.context.changes.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      this.context.changes.announce("agent-mail-summary", "all");
      return this.descriptor(mailbox, defaultPolicy);
    });
  }

  async getAgentMailStatus(messageId: string): Promise<AgentMailMessageSummary> {
    const store = await this.loadAgentMailStore();
    const located = this.findMessage(store, messageId);
    if (located) return metadataMessage(located.message);
    const counterpart = store.counterparts[messageId];
    if (counterpart) return counterpart;
    for (const row of Object.values(store.idempotency)) {
      if (row.bounce?.id === messageId) return metadataMessage(row.bounce);
    }
    throw new AgentMailError("message-not-found", "Message status is no longer retained");
  }

  async listPendingAgentMailInjects(
    limit = 100,
    options: { includeDeferred?: boolean; includeCoalescing?: boolean } = {},
  ): Promise<PendingAgentMailInject[]> {
    const [store, config] = await Promise.all([
      this.loadAgentMailStore(),
      this.repos.config.loadConfig(),
    ]);
    const settings = normalizeAgentMessagingSettings(config.global.agentMessaging);
    const pending: PendingAgentMailInject[] = [];
    const now = Date.now();
    const entries = store.pendingInject.toSorted((a, b) => {
      const aDeferred = a.nextAttemptAt && Date.parse(a.nextAttemptAt) > now ? 1 : 0;
      const bDeferred = b.nextAttemptAt && Date.parse(b.nextAttemptAt) > now ? 1 : 0;
      return aDeferred - bDeferred;
    });
    for (const {
      mailboxId,
      messageId,
      nextAttemptAt,
      retryAt,
      retryAttempts,
      verificationAttempts,
      verifyRequestId,
      coalescing,
    } of entries) {
      const held = Boolean(retryAt && Date.parse(retryAt) > now);
      if (held && !(coalescing && options.includeCoalescing)) continue;
      const deferred = Boolean(nextAttemptAt && Date.parse(nextAttemptAt) > now);
      if (deferred && !options.includeDeferred) continue;
      const mailbox = store.mailboxes[mailboxId];
      const message = mailbox?.messages.find((candidate) => candidate.id === messageId);
      if (!mailbox || !message || message.placement !== "pending-inject") continue;
      pending.push({
        mailbox: this.descriptor(mailbox, settings.defaultInjectPolicy),
        message,
        ...(deferred && nextAttemptAt ? { deferredUntil: nextAttemptAt } : {}),
        ...(verifyRequestId ? { verifyRequestId } : {}),
        ...(retryAttempts ? { retryAttempts } : {}),
        ...(verificationAttempts ? { verificationAttempts } : {}),
        ...(held && retryAt ? { coalescingUntil: retryAt } : {}),
      });
      if (pending.length >= Math.max(1, Math.min(limit, AGENT_MAIL_MAX_PENDING_INJECTS))) break;
    }
    return pending;
  }

  /** Activity edges make a held delivery immediately eligible without announcing UI churn. */
  async resetAgentMailInjectBackoff(mailboxId: string): Promise<void> {
    await this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      let changed = false;
      for (const entry of store.pendingInject) {
        if (entry.mailboxId !== mailboxId || !entry.nextAttemptAt) continue;
        delete entry.nextAttemptAt;
        entry.attempts = 0;
        changed = true;
      }
      if (changed) await this.saveAgentMailStore(store);
    });
  }

  async listInterruptedAgentMailInjects(): Promise<PendingAgentMailInject[]> {
    const [store, config] = await Promise.all([
      this.loadAgentMailStore(),
      this.repos.config.loadConfig(),
    ]);
    const settings = normalizeAgentMessagingSettings(config.global.agentMessaging);
    const interrupted: PendingAgentMailInject[] = [];
    for (const mailbox of Object.values(store.mailboxes)) {
      for (const message of mailbox.messages) {
        if (message.placement !== "inject-held" || message.placementReason !== "submitting") {
          continue;
        }
        interrupted.push({
          mailbox: this.descriptor(mailbox, settings.defaultInjectPolicy),
          message,
        });
      }
    }
    return interrupted;
  }

  async listAgentMailSentByMailbox(
    environmentId: string,
    tabId: string,
  ): Promise<AgentMailMessageSummary[]> {
    const [store, config] = await Promise.all([
      this.loadAgentMailStore(),
      this.repos.config.loadConfig(),
    ]);
    const cutoff =
      Date.now() -
      normalizeAgentMessagingSettings(config.global.agentMessaging).retentionDays * 86_400_000;
    const mailboxId = agentMailboxId(environmentId, tabId);
    return Object.values(store.mailboxes)
      .flatMap((mailbox) => mailbox.messages)
      .filter(
        (message) =>
          Date.parse(message.createdAt) >= cutoff &&
          (message.from.kind === "tab" || message.from.kind === "coordinator") &&
          agentMailboxId(message.from.environmentId, message.from.tabId) === mailboxId,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX)
      .map(metadataMessage);
  }

  async listUserSentAgentMail(): Promise<AgentMailMessageSummary[]> {
    const [store, config] = await Promise.all([
      this.loadAgentMailStore(),
      this.repos.config.loadConfig(),
    ]);
    const cutoff =
      Date.now() -
      normalizeAgentMessagingSettings(config.global.agentMessaging).retentionDays * 86_400_000;
    return Object.values(store.mailboxes)
      .flatMap((mailbox) => mailbox.messages)
      .filter((message) => message.from.kind === "user" && Date.parse(message.createdAt) >= cutoff)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX)
      .map(metadataMessage);
  }

  private async conversationMailboxes(): Promise<{
    revision: number;
    cutoff: number;
    mailboxes: ConversationMailbox[];
  }> {
    const [store, config] = await Promise.all([
      this.loadAgentMailStore(),
      this.repos.config.loadConfig(),
    ]);
    const settings = normalizeAgentMessagingSettings(config.global.agentMessaging);
    return {
      revision: store.revision,
      cutoff: Date.now() - settings.retentionDays * 86_400_000,
      mailboxes: Object.values(store.mailboxes).map((mailbox) => ({
        descriptor: this.descriptor(mailbox, settings.defaultInjectPolicy),
        messages: mailbox.messages,
      })),
    };
  }

  /** Every pair that has exchanged mail, or only `participant`'s; see `agent-mail-conversations.ts`. */
  async listAgentMailConversations(
    options: { participant?: string } = {},
  ): Promise<AgentMailConversationList> {
    const { revision, cutoff, mailboxes } = await this.conversationMailboxes();
    return {
      revision,
      conversations: listAgentMailConversations(mailboxes, { cutoff, ...options }),
    };
  }

  async getAgentMailConversation(
    a: string,
    b: string,
    options: { limit?: number } = {},
  ): Promise<AgentMailConversation> {
    const { revision, cutoff, mailboxes } = await this.conversationMailboxes();
    return agentMailConversationBetween(mailboxes, a, b, { cutoff, revision, ...options });
  }

  /** Stamp only messages present in the conversation snapshot the person displayed. */
  async markAgentMailConversationSeen(a: string, b: string, messageIds: string[]): Promise<number> {
    const displayed = new Set(messageIds);
    return this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const seenAt = new Date().toISOString();
      const changed: PersistedMailbox[] = [];
      let marked = 0;
      for (const key of new Set([a, b])) {
        const mailbox = store.mailboxes[key];
        if (!mailbox) continue;
        let mailboxMarked = false;
        for (const message of mailbox.messages) {
          if (
            !displayed.has(message.id) ||
            message.userSeenAt ||
            !isAgentMailConversationMessage(key, message, a, b)
          )
            continue;
          message.userSeenAt = seenAt;
          message.revision += 1;
          mailboxMarked = true;
          marked += 1;
        }
        if (mailboxMarked) {
          mailbox.revision += 1;
          changed.push(mailbox);
        }
      }
      if (marked === 0) return 0;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      for (const mailbox of changed)
        this.context.changes.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      this.context.changes.announce("agent-mail-summary", "all");
      return marked;
    });
  }

  /** One durable startup attempt per queued item, only for a local family worker. */
  async claimAgentMailWorkerStart(environmentId: string, messageId: string): Promise<boolean> {
    const environment = await this.repos.projects.getEnvironment(environmentId);
    if (
      !environment ||
      environment.environmentType !== "local" ||
      environment.status !== "stopped" ||
      environment.deletionRequestedAt
    )
      return false;
    return this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const located = this.findMessage(store, messageId);
      const message = located?.message;
      const recipient = located?.mailbox;
      if (
        !message ||
        !recipient ||
        message.from.kind !== "coordinator" ||
        message.route !== "coordinator" ||
        message.placement !== "pending-inject" ||
        !message.recipientStoppedAtSend ||
        message.workerStartAttemptedAt ||
        message.recipientStopGeneration !== (environment.stopGeneration ?? 0) ||
        recipient.coordinatorOrigin !== message.from.environmentId
      )
        return false;
      // A queued batch asks for one start, even if it contains several requests.
      const now = new Date().toISOString();
      for (const mailbox of Object.values(store.mailboxes)) {
        if (mailbox.environmentId !== environmentId) continue;
        for (const item of mailbox.messages) {
          if (
            item.placement === "pending-inject" &&
            item.recipientStopGeneration === message.recipientStopGeneration
          )
            item.workerStartAttemptedAt = now;
        }
      }
      await this.saveAgentMailStore(store);
      return true;
    });
  }

  /**
   * Claim one pending message for dispatch. `joinCoalescing` lets a status
   * notice still inside its coalescing hold ride along with a batch already
   * going to this mailbox: the hold only exists to gather notices into one
   * wake, and that wake is happening now.
   */
  async beginAgentMailInject(
    mailboxId: string,
    messageId: string,
    incarnationId: string,
    verificationRequestId?: string,
    options: { joinCoalescing?: boolean } = {},
  ): Promise<AgentMailMessage | null> {
    return this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const mailbox = store.mailboxes[mailboxId];
      const message = mailbox?.messages.find((candidate) => candidate.id === messageId);
      if (
        !mailbox ||
        !message ||
        mailbox.incarnationId !== incarnationId ||
        mailbox.tombstonedAt ||
        message.toIncarnationId !== incarnationId ||
        message.placement !== "pending-inject"
      )
        return null;
      const pendingEntry = store.pendingInject.find(
        (candidate) => candidate.mailboxId === mailboxId && candidate.messageId === messageId,
      );
      if (
        pendingEntry?.verifyRequestId !== verificationRequestId ||
        (pendingEntry?.retryAt &&
          Date.parse(pendingEntry.retryAt) > Date.now() &&
          !(options.joinCoalescing && pendingEntry.coalescing)) ||
        (pendingEntry?.nextAttemptAt && Date.parse(pendingEntry.nextAttemptAt) > Date.now())
      )
        return null;
      message.placement = "inject-held";
      if (pendingEntry) pendingEntry.lastHoldReason = message.placementReason;
      message.placementReason = "submitting";
      await this.saveAgentMailStore(store);
      return message;
    });
  }

  async finishAgentMailInject(
    mailboxId: string,
    messageId: string,
    outcome:
      | { outcome: "accepted" }
      | { outcome: "held"; reason: string }
      | { outcome: "failed"; reason: "ambiguous" | "rejected" }
      /** Refused before it reached the agent: queue it again after a delay. */
      | { outcome: "retry"; reason: string }
      /** Outcome unknown: confirm `requestId` against the journal before resending. */
      | { outcome: "verify"; requestId: string },
  ): Promise<AgentMailMessage | null> {
    return this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const mailbox = store.mailboxes[mailboxId];
      const message = mailbox?.messages.find((candidate) => candidate.id === messageId);
      if (
        !mailbox ||
        !message ||
        message.placement !== "inject-held" ||
        message.placementReason !== "submitting"
      )
        return null;
      const pendingIndex = store.pendingInject.findIndex(
        (candidate) => candidate.mailboxId === mailboxId && candidate.messageId === messageId,
      );
      const pendingEntry = pendingIndex >= 0 ? store.pendingInject[pendingIndex] : undefined;
      let announce = true;
      if (outcome.outcome === "accepted") {
        message.placement = "injected";
        message.injectedAt = new Date().toISOString();
        delete message.placementReason;
        if (pendingIndex >= 0) store.pendingInject.splice(pendingIndex, 1);
      } else if (outcome.outcome === "held") {
        const reason = outcome.reason.slice(0, 100);
        const previousReason = pendingEntry?.lastHoldReason;
        message.placement = "pending-inject";
        message.placementReason = reason;
        const attempts = Math.min(5, (pendingEntry?.attempts ?? 0) + 1);
        const delayMs = Math.min(30_000, 2_000 * 2 ** (attempts - 1));
        const next = {
          mailboxId,
          messageId,
          attempts,
          nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
          lastHoldReason: reason,
          ...(pendingEntry?.coalescing &&
          pendingEntry.retryAt &&
          Date.parse(pendingEntry.retryAt) > Date.now()
            ? { coalescing: true as const, retryAt: pendingEntry.retryAt }
            : {}),
        };
        if (pendingIndex >= 0) store.pendingInject[pendingIndex] = next;
        else store.pendingInject.push(next);
        announce = previousReason !== reason;
      } else if (outcome.outcome === "retry" || outcome.outcome === "verify") {
        const retryAttempts =
          (pendingEntry?.retryAttempts ?? 0) + (outcome.outcome === "retry" ? 1 : 0);
        const verificationAttempts =
          outcome.outcome === "verify" ? (pendingEntry?.verificationAttempts ?? 0) + 1 : 0;
        const reason = outcome.outcome === "retry" ? "retrying" : "verifying";
        // `beginAgentMailInject` saved the placement reason it replaced.
        const previousReason = pendingEntry?.lastHoldReason;
        message.placement = "pending-inject";
        message.placementReason = reason;
        const next = {
          mailboxId,
          messageId,
          retryAttempts,
          verificationAttempts,
          retryAt: new Date(
            Date.now() +
              agentMailRetryDelayMs(
                outcome.outcome === "verify" ? verificationAttempts : retryAttempts,
              ),
          ).toISOString(),
          lastHoldReason: reason,
          ...(outcome.outcome === "verify" ? { verifyRequestId: outcome.requestId } : {}),
          ...(outcome.outcome === "retry" &&
          pendingEntry?.coalescing &&
          pendingEntry.retryAt &&
          Date.parse(pendingEntry.retryAt) > Date.now()
            ? { coalescing: true as const, retryAt: pendingEntry.retryAt }
            : {}),
        };
        if (pendingIndex >= 0) store.pendingInject[pendingIndex] = next;
        else store.pendingInject.push(next);
        announce = previousReason !== reason;
      } else {
        message.placement = "inject_failed";
        message.placementReason = outcome.reason;
        if (pendingIndex >= 0) store.pendingInject.splice(pendingIndex, 1);
      }
      if (announce) {
        message.revision += 1;
        mailbox.revision += 1;
        store.revision += 1;
      }
      await this.saveAgentMailStore(store);
      if (announce) {
        this.context.changes.announce("agent-mail", mailboxId, mailbox.projectId);
        this.context.changes.announce("agent-mail-summary", "all");
      }
      return message;
    });
  }

  async recoverInterruptedAgentMailInjects(): Promise<number> {
    return this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      let recovered = 0;
      for (const mailbox of Object.values(store.mailboxes)) {
        for (const message of mailbox.messages) {
          if (message.placement !== "inject-held" || message.placementReason !== "submitting")
            continue;
          message.placement = "inject_failed";
          message.placementReason = "ambiguous";
          message.revision += 1;
          mailbox.revision += 1;
          recovered += 1;
        }
      }
      if (recovered === 0) return 0;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      this.context.changes.announce("agent-mail-summary", "all");
      return recovered;
    });
  }

  async deleteAgentMailByProject(projectId: string): Promise<void> {
    await this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const mailboxIds = new Set(
        Object.values(store.mailboxes)
          .filter((mailbox) => mailbox.projectId === projectId)
          .map((mailbox) => mailbox.mailboxId),
      );
      if (mailboxIds.size === 0) return;
      const changedMailboxes = new Map<string, string | undefined>();
      for (const mailboxId of mailboxIds) {
        const mailbox = store.mailboxes[mailboxId];
        if (mailbox) {
          for (const message of mailbox.messages) {
            store.counterparts[message.id] = {
              ...metadataMessage(message),
              placement: "undeliverable",
              placementReason: "recipient-deleted",
              revision: message.revision + 1,
            };
          }
          changedMailboxes.set(mailboxId, mailbox.projectId);
        }
        delete store.mailboxes[mailboxId];
      }
      for (const mailbox of Object.values(store.mailboxes)) {
        for (const message of mailbox.messages) {
          if (
            (message.from.kind !== "tab" &&
              message.from.kind !== "coordinator" &&
              message.from.kind !== "system" &&
              message.from.kind !== "node") ||
            message.from.projectId !== projectId
          ) {
            continue;
          }
          message.body = "";
          message.bodyBytes = 0;
          delete message.subject;
          message.placement = "expired";
          message.placementReason = "sender-deleted";
          message.revision += 1;
          mailbox.revision += 1;
          changedMailboxes.set(mailbox.mailboxId, mailbox.projectId);
        }
      }
      store.pendingInject = store.pendingInject.filter((item) => !mailboxIds.has(item.mailboxId));
      for (const [key, row] of Object.entries(store.idempotency)) {
        if (
          (row.mailboxId && mailboxIds.has(row.mailboxId)) ||
          Array.from(mailboxIds).some(
            (mailboxId) =>
              row.senderScope === `tab:${mailboxId}` ||
              row.senderScope === `coordinator:${mailboxId}`,
          ) ||
          row.senderScope.startsWith(`system:${projectId}:`)
        ) {
          delete store.idempotency[key];
        }
      }
      store.revision += 1;
      await this.saveAgentMailStore(store);
      await this.context.transformSensitiveJsonBackups(this.files.agentMailFile(), (record) => {
        const backup = record as unknown as PersistedAgentMailStore;
        if (backup.version !== 1 || !backup.mailboxes) return record;
        for (const [mailboxId, mailbox] of Object.entries(backup.mailboxes)) {
          if (mailbox.projectId === projectId) delete backup.mailboxes[mailboxId];
          else
            for (const message of mailbox.messages ?? []) {
              if (
                (message.from.kind === "tab" ||
                  message.from.kind === "coordinator" ||
                  message.from.kind === "system" ||
                  message.from.kind === "node") &&
                message.from.projectId === projectId
              ) {
                message.body = "";
                message.bodyBytes = 0;
                delete message.subject;
              }
            }
        }
        return backup as unknown as Record<string, unknown>;
      });
      for (const [mailboxId, affectedProjectId] of changedMailboxes) {
        this.context.changes.announce("agent-mail", mailboxId, affectedProjectId);
      }
      this.context.changes.announce("agent-mail-summary", "all");
    });
  }

  async deleteAgentMailByEnvironment(environmentId: string): Promise<void> {
    if (!environmentId.trim()) throw new Error("environmentId is required");
    await this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      let changed = false;
      const changedMailboxes = new Map<string, string | undefined>();
      for (const [mailboxId, mailbox] of Object.entries(store.mailboxes)) {
        if (mailbox.environmentId === environmentId) {
          for (const message of mailbox.messages) {
            store.counterparts[message.id] = {
              ...metadataMessage(message),
              placement: "undeliverable",
              placementReason: "recipient-deleted",
              revision: message.revision + 1,
            };
          }
          changedMailboxes.set(mailboxId, mailbox.projectId);
          delete store.mailboxes[mailboxId];
          changed = true;
          continue;
        }
        for (const message of mailbox.messages) {
          if (message.from.kind !== "tab" || message.from.environmentId !== environmentId) continue;
          message.body = "";
          message.bodyBytes = 0;
          delete message.subject;
          message.placement = "expired";
          message.placementReason = "sender-deleted";
          message.revision += 1;
          mailbox.revision += 1;
          changedMailboxes.set(mailboxId, mailbox.projectId);
          changed = true;
        }
      }
      for (const [key, row] of Object.entries(store.idempotency)) {
        if (row.senderScope.startsWith(`tab:${environmentId}\0`)) {
          delete store.idempotency[key];
          changed = true;
        }
      }
      const pendingInject = store.pendingInject.filter(
        ({ mailboxId }) => !mailboxId.startsWith(`${environmentId}\0`),
      );
      if (pendingInject.length !== store.pendingInject.length) changed = true;
      store.pendingInject = pendingInject;
      if (!changed) return;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      await this.context.transformSensitiveJsonBackups(this.files.agentMailFile(), (record) => {
        const backup = record as unknown as PersistedAgentMailStore;
        if (backup.version !== 1 || !backup.mailboxes) return record;
        for (const [mailboxId, mailbox] of Object.entries(backup.mailboxes)) {
          if (mailbox.environmentId === environmentId) delete backup.mailboxes[mailboxId];
          else
            for (const message of mailbox.messages ?? []) {
              if (message.from.kind === "tab" && message.from.environmentId === environmentId) {
                message.body = "";
                message.bodyBytes = 0;
                delete message.subject;
              }
            }
        }
        return backup as unknown as Record<string, unknown>;
      });
      for (const [mailboxId, projectId] of changedMailboxes) {
        this.context.changes.announce("agent-mail", mailboxId, projectId);
      }
      this.context.changes.announce("agent-mail-summary", "all");
    });
  }

  async pruneAgentMail(retentionDays: number): Promise<void> {
    const cutoff = Date.now() - Math.max(1, retentionDays) * 86_400_000;
    await this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      let changed = false;
      const changedMailboxes = new Map<string, string | undefined>();
      for (const [mailboxId, mailbox] of Object.entries(store.mailboxes)) {
        const retained = mailbox.messages.filter((message) => {
          const old = Date.parse(message.createdAt) < cutoff;
          // Retention is the hard bound for message content. It applies even
          // when a recipient disappeared without acknowledging the message;
          // otherwise tombstoned mailboxes grow forever and can make the
          // bounded store impossible to write or prune.
          return !old;
        });
        if (retained.length !== mailbox.messages.length) {
          mailbox.messages = retained;
          mailbox.revision += 1;
          changedMailboxes.set(mailboxId, mailbox.projectId);
          changed = true;
        }
        if (mailbox.tombstonedAt && mailbox.messages.length === 0) {
          changedMailboxes.set(mailboxId, mailbox.projectId);
          delete store.mailboxes[mailboxId];
          changed = true;
        }
      }
      for (const [key, row] of Object.entries(store.idempotency)) {
        if (Date.parse(row.createdAt) < cutoff) {
          delete store.idempotency[key];
          changed = true;
        }
      }
      for (const [messageId, counterpart] of Object.entries(store.counterparts)) {
        if (Date.parse(counterpart.createdAt) < cutoff) {
          delete store.counterparts[messageId];
          changed = true;
        }
      }
      const pendingInject = store.pendingInject.filter(({ mailboxId, messageId }) =>
        store.mailboxes[mailboxId]?.messages.some((message) => message.id === messageId),
      );
      if (pendingInject.length !== store.pendingInject.length) {
        store.pendingInject = pendingInject;
        changed = true;
      }
      if (!changed) return;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      for (const [mailboxId, projectId] of changedMailboxes) {
        this.context.changes.announce("agent-mail", mailboxId, projectId);
      }
      this.context.changes.announce("agent-mail-summary", "all");
    });
  }
}
