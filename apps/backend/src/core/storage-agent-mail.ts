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
  AGENT_MAIL_MAX_THREAD_HOPS,
  AgentMailError,
  agentMailCapabilities,
  agentMailboxId,
  normalizeAgentMessagingSettings,
  resolveTabDisplayName,
  type AgentMailMailboxSnapshot,
  type AgentMailMailboxBatchSnapshot,
  type AgentMailInboxSnapshot,
  type AgentMailMessage,
  type AgentMailMessageSummary,
  type AgentMailSendInput,
  type AgentMailSummarySnapshot,
  type AgentMailTrust,
  type MailActor,
  type MailboxDescriptor,
  type MailboxKind,
} from "@orkestrator/protocol/agent-mail";
import { isAgentPlatform, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { StorageDrafts } from "./storage-drafts.ts";
import { paneLayoutLeaves } from "./storage-shared.js";
import {
  COORDINATOR_DELEGATION_HOLD_REASON,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";

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
  }>;
  counterparts: Record<string, AgentMailMessageSummary>;
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
  | { kind: "external" };

export type PendingAgentMailInject = {
  mailbox: MailboxDescriptor;
  message: AgentMailMessage;
  deferredUntil?: string;
};

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

function countsAsPendingInject(message: AgentMailMessage | AgentMailMessageSummary): boolean {
  return (
    message.placement === "pending-inject" ||
    (message.placement === "inject-held" &&
      (message.placementReason === "loop-budget-exhausted" ||
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

function sortableId(): string {
  return `${Date.now().toString(36).padStart(10, "0")}-${randomUUID()}`;
}

function sameMailboxPair(
  message: AgentMailMessage,
  firstMailboxId: string,
  secondMailboxId: string,
): boolean {
  if (message.from.kind !== "tab" && message.from.kind !== "coordinator") return false;
  const from = agentMailboxId(message.from.environmentId, message.from.tabId);
  const to = agentMailboxId(message.toEnvironmentId, message.toTabId);
  return (
    (from === firstMailboxId && to === secondMailboxId) ||
    (from === secondMailboxId && to === firstMailboxId)
  );
}

function latestMailboxPairDepth(
  store: PersistedAgentMailStore,
  firstMailboxId: string,
  secondMailboxId: string,
  cutoff: number,
): number | null {
  let latest: AgentMailMessage | null = null;
  for (const mailboxId of [firstMailboxId, secondMailboxId]) {
    const mailbox = store.mailboxes[mailboxId];
    if (!mailbox) continue;
    for (const message of mailbox.messages) {
      if (message.autonomousSequence === undefined) continue;
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

export class StorageAgentMail extends StorageDrafts {
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

  setAgentMailRuntimeProvider(provider: StorageAgentMail["agentMailRuntimeProvider"]): void {
    this.agentMailRuntimeProvider = provider;
  }

  private enqueueAgentMailMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(this.agentMailFile(), "agent mail storage");
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.agentMailMutation.then(run, run);
    this.agentMailMutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async loadAgentMailStore(): Promise<PersistedAgentMailStore> {
    const value = await this.loadJsonCached<unknown>(this.agentMailFile(), emptyStore);
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
    await this.saveSensitiveJson(this.agentMailFile(), store);
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
    const [projects, environments, layoutsResult, coordinators] = await Promise.all([
      this.loadProjects(),
      this.loadEnvironments(),
      this.loadPaneLayoutsForReconciliation(),
      this.listCoordinatorWorkspaces(),
    ]);
    if (!layoutsResult.available) return;
    const sessionsByEnvironment = new Map(
      await Promise.all(
        environments.map(
          async (environment) =>
            [environment.id, await this.getSessionsByEnvironment(environment.id)] as const,
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
      this.announce("agent-mail-summary", "all");
      for (const mailboxId of changedMailboxIds) {
        this.announce("agent-mail", mailboxId, store.mailboxes[mailboxId]?.projectId);
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
      const layout = await this.getPaneLayout(environmentId);
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
    const [store, config] = await Promise.all([this.loadAgentMailStore(), this.loadConfig()]);
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
    const [store, config] = await Promise.all([this.loadAgentMailStore(), this.loadConfig()]);
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
    const [store, config] = await Promise.all([this.loadAgentMailStore(), this.loadConfig()]);
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
    const [store, config] = await Promise.all([this.loadAgentMailStore(), this.loadConfig()]);
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
        message.from.kind === "coordinator" &&
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

  async sendAgentMail(
    sender: AgentMailSender,
    input: AgentMailSendInput,
  ): Promise<AgentMailMessage> {
    const requestId = input.requestId.trim();
    if (!requestId || requestId.length > AGENT_MAIL_MAX_REQUEST_ID_LENGTH)
      throw new Error("requestId must be 1-256 characters");
    const bodyBytes = Buffer.byteLength(input.body, "utf8");
    if (!input.body.trim() || bodyBytes > AGENT_MAIL_MAX_BODY_BYTES)
      throw new Error("body must be non-empty and at most 32 KiB UTF-8");
    const subject = input.subject?.trim() || undefined;
    if (subject && subject.length > AGENT_MAIL_MAX_SUBJECT_LENGTH)
      throw new Error("subject must be at most 200 characters");
    await this.ensureAgentMailDirectoryFresh([
      input.toEnvironmentId,
      sender.kind === "tab" || sender.kind === "coordinator" ? sender.environmentId : "",
    ]);
    const config = await this.loadConfig();
    const settings = normalizeAgentMessagingSettings(config.global.agentMessaging);
    if (!settings.enabled)
      throw new AgentMailError("messaging-disabled", "Agent messaging is disabled");

    return this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
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
      } else {
        actor = sender;
        senderScope =
          sender.kind === "system"
            ? `system:${sender.projectId}:${sender.source}:${sender.resourceId}`
            : sender.kind;
      }

      const key = idempotencyKey(senderScope, requestId);
      const fingerprint = sendFingerprint({ ...input, subject });
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
      const crossProject = senderMailbox && senderMailbox.projectId !== recipient.projectId;
      if (crossProject && !settings.allowCrossProject)
        throw new AgentMailError("policy-denied", "Cross-project messaging is disabled");

      let parent: AgentMailMessage | undefined;
      if (input.replyToMessageId) {
        parent = this.findMessage(store, input.replyToMessageId)?.message;
        if (!parent) throw new AgentMailError("message-not-found", "Reply parent was not found");
        if (parent.threadDepth >= AGENT_MAIL_MAX_THREAD_HOPS)
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
          : sender.kind === "system"
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
      const coordinatorExchange =
        trust === "same-project" &&
        recipient.injectOverride === "inherit" &&
        (sender.kind === "coordinator" ||
          sender.kind === "system" ||
          recipient.ownerKind === "coordinator");
      const pairDepth =
        coordinatorExchange && senderMailbox
          ? latestMailboxPairDepth(store, senderMailbox.mailboxId, destinationId, lineageCutoff)
          : null;
      // A new subject still belongs to the same autonomous coordinator/worker
      // exchange. Only the explicit Resume action resets the latest message to
      // depth zero; omitting replyToMessageId cannot restart the budget.
      const nextThreadDepth =
        (coordinatorExchange
          ? Math.max(parent?.threadDepth ?? -1, pairDepth ?? -1)
          : (parent?.threadDepth ?? -1)) + 1;
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
        sender.kind === "tab" && recipient.ownerKind === "coordinator" && trust === "same-project"
          ? (await this.listOpenCoordinatorDelegations()).find(
              (association) =>
                association.resourceId === sender.environmentId &&
                association.delegation?.workerTabId === sender.tabId &&
                // The delegation has to belong to *this* conversation. A second
                // conversation that never asked this worker for anything is not
                // waiting on it, so holding its mail would silence a message
                // nothing will ever release.
                association.conversationId !== undefined &&
                coordinatorRuntimeId(association.coordinatorId, association.conversationId) ===
                  recipient.environmentId,
            )
          : undefined;
      const heldForDelegation = Boolean(holdingDelegation);
      const shouldScheduleInject =
        (effectivePolicy === "idle" || coordinatorExchange) &&
        !recipient.mutedInbound &&
        !heldForDelegation &&
        trust !== "cross-project" &&
        trust !== "external" &&
        (injectDepth === 0 || coordinatorExchange) &&
        nextThreadDepth < AGENT_MAIL_MAX_THREAD_HOPS &&
        canInject;
      const heldForLoopBudget =
        coordinatorExchange &&
        !recipient.mutedInbound &&
        nextThreadDepth >= AGENT_MAIL_MAX_THREAD_HOPS &&
        canInject;
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
        ...(coordinatorExchange ? { autonomousSequence: store.revision + 1 } : {}),
        placement: shouldScheduleInject
          ? "pending-inject"
          : heldForDelegation || heldForLoopBudget
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
              ? { placementReason: "loop-budget-exhausted" }
              : {}),
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
        if (shouldScheduleInject)
          store.pendingInject.push({ mailboxId: destinationId, messageId: id });
      }
      store.revision += 1;
      await this.saveAgentMailStore(store);
      this.announce("agent-mail", destinationId, recipient.projectId);
      this.announce("agent-mail-summary", "all");
      return message;
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
      this.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      this.announce("agent-mail-summary", "all");
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
    return this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const mailboxId = agentMailboxId(environmentId, tabId);
      const mailbox = store.mailboxes[mailboxId];
      if (!mailbox) return 0;
      if (!agentMailCapabilities(mailbox.tabType, mailbox.agent, mailbox.locked).canInject)
        return 0;
      let promoted = 0;
      for (const message of mailbox.messages) {
        if (
          message.placement !== "stored" ||
          message.ackedAt ||
          message.discardedAt ||
          mailbox.mutedInbound ||
          message.injectDepth !== 0 ||
          message.threadDepth >= AGENT_MAIL_MAX_THREAD_HOPS ||
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
            (candidate) => candidate.mailboxId === mailboxId && candidate.messageId === message.id,
          )
        ) {
          store.pendingInject.push({ mailboxId, messageId: message.id });
        }
        message.revision += 1;
        promoted += 1;
      }
      if (promoted === 0) return 0;
      mailbox.revision += 1;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      this.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      this.announce("agent-mail-summary", "all");
      return promoted;
    });
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
          message.from.kind === "tab" &&
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
            message.from.kind === "tab" &&
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
      this.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      this.announce("agent-mail-summary", "all");
      return released;
    });
  }

  async retryAgentMailInject(
    environmentId: string,
    tabId: string,
    messageId: string,
  ): Promise<AgentMailMessage> {
    return this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      const mailboxId = agentMailboxId(environmentId, tabId);
      const mailbox = store.mailboxes[mailboxId];
      const message = mailbox?.messages.find((candidate) => candidate.id === messageId);
      if (!mailbox || !message)
        throw new AgentMailError("message-not-found", "Message not found in this mailbox");
      const resumesLoopBudget =
        message.placement === "inject-held" && message.placementReason === "loop-budget-exhausted";
      const wakesPending = message.placement === "pending-inject";
      const wakesStored =
        message.placement === "stored" &&
        !message.ackedAt &&
        !message.discardedAt &&
        !mailbox.mutedInbound &&
        message.injectDepth === 0 &&
        message.threadDepth < AGENT_MAIL_MAX_THREAD_HOPS &&
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
        }
      }
      message.placement = "pending-inject";
      if (!wakesPending || wakesStored) delete message.placementReason;
      message.injectRequestId ??= `mail-inject-${message.id}`;
      if (resumesLoopBudget) {
        // Preserve the thread identity while beginning a new user-authorized
        // autonomous run budget. Replies remain in the same lineage and cannot
        // reset this counter merely by changing subject or acknowledging mail.
        message.threadDepth = 0;
        message.injectDepth = 0;
        message.autonomousSequence = store.revision + 1;
      }
      if (
        !store.pendingInject.some(
          (candidate) => candidate.mailboxId === mailboxId && candidate.messageId === message.id,
        )
      ) {
        store.pendingInject.push({ mailboxId, messageId: message.id });
      }
      message.revision += 1;
      mailbox.revision += 1;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      this.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      this.announce("agent-mail-summary", "all");
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
      if (updates.inject) mailbox.injectOverride = updates.inject;
      if (typeof updates.mutedInbound === "boolean") mailbox.mutedInbound = updates.mutedInbound;
      if (typeof updates.mutedOutbound === "boolean") mailbox.mutedOutbound = updates.mutedOutbound;
      mailbox.revision += 1;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      const config = await this.loadConfig();
      this.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      this.announce("agent-mail-summary", "all");
      return this.descriptor(
        mailbox,
        normalizeAgentMessagingSettings(config.global.agentMessaging).defaultInjectPolicy,
      );
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
    options: { includeDeferred?: boolean } = {},
  ): Promise<PendingAgentMailInject[]> {
    const [store, config] = await Promise.all([this.loadAgentMailStore(), this.loadConfig()]);
    const settings = normalizeAgentMessagingSettings(config.global.agentMessaging);
    const pending: PendingAgentMailInject[] = [];
    const now = Date.now();
    const entries = store.pendingInject.toSorted((a, b) => {
      const aDeferred = a.nextAttemptAt && Date.parse(a.nextAttemptAt) > now ? 1 : 0;
      const bDeferred = b.nextAttemptAt && Date.parse(b.nextAttemptAt) > now ? 1 : 0;
      return aDeferred - bDeferred;
    });
    for (const { mailboxId, messageId, nextAttemptAt } of entries) {
      const deferred = Boolean(nextAttemptAt && Date.parse(nextAttemptAt) > now);
      if (deferred && !options.includeDeferred) continue;
      const mailbox = store.mailboxes[mailboxId];
      const message = mailbox?.messages.find((candidate) => candidate.id === messageId);
      if (!mailbox || !message || message.placement !== "pending-inject") continue;
      pending.push({
        mailbox: this.descriptor(mailbox, settings.defaultInjectPolicy),
        message,
        ...(deferred && nextAttemptAt ? { deferredUntil: nextAttemptAt } : {}),
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
    const [store, config] = await Promise.all([this.loadAgentMailStore(), this.loadConfig()]);
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
    const [store, config] = await Promise.all([this.loadAgentMailStore(), this.loadConfig()]);
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
    const [store, config] = await Promise.all([this.loadAgentMailStore(), this.loadConfig()]);
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

  async beginAgentMailInject(
    mailboxId: string,
    messageId: string,
    incarnationId: string,
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
      message.placement = "inject-held";
      const pendingEntry = store.pendingInject.find(
        (candidate) => candidate.mailboxId === mailboxId && candidate.messageId === messageId,
      );
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
      | { outcome: "failed"; reason: "ambiguous" | "rejected" },
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
        this.announce("agent-mail", mailboxId, mailbox.projectId);
        this.announce("agent-mail-summary", "all");
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
      this.announce("agent-mail-summary", "all");
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
              message.from.kind !== "system") ||
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
      await this.transformSensitiveJsonBackups(this.agentMailFile(), (record) => {
        const backup = record as unknown as PersistedAgentMailStore;
        if (backup.version !== 1 || !backup.mailboxes) return record;
        for (const [mailboxId, mailbox] of Object.entries(backup.mailboxes)) {
          if (mailbox.projectId === projectId) delete backup.mailboxes[mailboxId];
          else
            for (const message of mailbox.messages ?? []) {
              if (
                (message.from.kind === "tab" ||
                  message.from.kind === "coordinator" ||
                  message.from.kind === "system") &&
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
        this.announce("agent-mail", mailboxId, affectedProjectId);
      }
      this.announce("agent-mail-summary", "all");
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
      await this.transformSensitiveJsonBackups(this.agentMailFile(), (record) => {
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
        this.announce("agent-mail", mailboxId, projectId);
      }
      this.announce("agent-mail-summary", "all");
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
        this.announce("agent-mail", mailboxId, projectId);
      }
      this.announce("agent-mail-summary", "all");
    });
  }
}
