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
  agent: AgentPlatform | null;
  kind: MailboxKind;
  locked: boolean;
  injectOverride: "inherit" | "off" | "idle";
  mutedInbound: boolean;
  mutedOutbound: boolean;
  tombstonedAt?: string;
  messages: AgentMailMessage[];
  revision: number;
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
  pendingInject: Array<{ mailboxId: string; messageId: string }>;
  counterparts: Record<string, AgentMailMessageSummary>;
};

export type AgentMailSender =
  | { kind: "tab"; environmentId: string; projectId: string; tabId: string }
  | { kind: "user" }
  | { kind: "external" };

export type PendingAgentMailInject = {
  mailbox: MailboxDescriptor;
  message: AgentMailMessage;
};

const TERMINAL_TYPES = new Set([
  "claude",
  "codex",
  "opencode",
  "cursor",
  "grok",
  "pi",
  "plain",
  "root",
]);
const UI_TYPES = new Set(["browser", "file"]);
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

function mailboxKind(tabType: string): MailboxKind | null {
  if (tabType === "agent-native") return "native";
  if (tabType === "claude-tmux") return "tmux";
  if (TERMINAL_TYPES.has(tabType)) return "terminal";
  if (UI_TYPES.has(tabType)) return "ui";
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
    const value = await this.loadJson<unknown>(this.agentMailFile(), emptyStore);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Agent mail store is malformed");
    }
    const record = value as Partial<PersistedAgentMailStore>;
    if (record.version !== 1 || !record.mailboxes || !record.idempotency) {
      throw new Error("Unsupported agent mail store");
    }
    const store = value as PersistedAgentMailStore;
    store.revision = Number.isSafeInteger(store.revision) ? store.revision : 0;
    store.pendingInject = [];
    store.counterparts ??= {};
    for (const mailbox of Object.values(store.mailboxes)) {
      mailbox.messages ??= [];
      mailbox.injectOverride ??= "inherit";
      mailbox.mutedInbound ??= false;
      mailbox.mutedOutbound ??= false;
      for (const message of mailbox.messages) {
        if (message.placement === "pending-inject") {
          store.pendingInject.push({ mailboxId: mailbox.mailboxId, messageId: message.id });
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

  async synchronizeAgentMailboxes(): Promise<void> {
    const [projects, environments, layoutsResult] = await Promise.all([
      this.loadProjects(),
      this.loadEnvironments(),
      this.loadPaneLayoutsForReconciliation(),
    ]);
    if (!layoutsResult.available) return;
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
      >
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
      for (const leaf of paneLayoutLeaves(layout.root)) {
        for (const tab of leaf.tabs) {
          if (!isAddressableTab(tab)) continue;
          const tabId = tab.id as string;
          const tabType = tab.type as string;
          const kind = mailboxKind(tabType)!;
          const { agent, locked } = tabAgent(tab);
          const mailboxId = agentMailboxId(environmentId, tabId);
          observed.set(mailboxId, {
            mailboxId,
            projectId: project.id,
            projectName: project.name,
            environmentId,
            environmentName: environment.name,
            environmentStatus: environment.status,
            tabId,
            tabType,
            title: typeof tab.displayTitle === "string" ? tab.displayTitle : null,
            agent,
            kind,
            locked,
          });
        }
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
            incarnationId: randomUUID(),
            injectOverride: "inherit",
            mutedInbound: false,
            mutedOutbound: false,
            messages: current?.messages ?? [],
            revision: (current?.revision ?? 0) + 1,
          };
          changedMailboxIds.add(mailboxId);
          continue;
        }
        const nextMetadata = JSON.stringify(metadata);
        const currentMetadata = JSON.stringify({
          mailboxId: current.mailboxId,
          projectId: current.projectId,
          projectName: current.projectName,
          environmentId: current.environmentId,
          environmentName: current.environmentName,
          environmentStatus: current.environmentStatus,
          tabId: current.tabId,
          tabType: current.tabType,
          title: current.title,
          agent: current.agent,
          kind: current.kind,
          locked: current.locked,
        });
        if (nextMetadata !== currentMetadata) {
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
  }

  private descriptor(mailbox: PersistedMailbox, defaultPolicy: "off" | "idle"): MailboxDescriptor {
    const unreadCount = mailbox.messages.filter(
      (message) =>
        message.toIncarnationId === mailbox.incarnationId &&
        !message.ackedAt &&
        !message.userSeenAt &&
        !message.discardedAt,
    ).length;
    const presence = mailbox.tombstonedAt
      ? "tab_closed"
      : mailbox.environmentStatus !== "running"
        ? "environment_stopped"
        : "unknown";
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
      title: mailbox.title,
      agent: mailbox.agent,
      kind: mailbox.kind,
      presence,
      injectPolicy:
        mailbox.tombstonedAt || mailbox.injectOverride === "off"
          ? "off"
          : mailbox.injectOverride === "idle"
            ? "idle"
            : defaultPolicy,
      mutedInbound: mailbox.mutedInbound,
      mutedOutbound: mailbox.mutedOutbound,
      unreadCount,
      capabilities: agentMailCapabilities(mailbox.tabType, mailbox.agent, mailbox.locked),
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
    } = {},
  ): Promise<{ mailboxes: MailboxDescriptor[]; total: number; offset: number; limit: number }> {
    await this.synchronizeAgentMailboxes();
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
      .sort((a, b) =>
        `${a.projectName}\0${a.environmentName}\0${a.tabId}`.localeCompare(
          `${b.projectName}\0${b.environmentName}\0${b.tabId}`,
        ),
      );
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
    await this.synchronizeAgentMailboxes();
    const store = await this.loadAgentMailStore();
    return {
      revision: store.revision,
      mailboxes: Object.values(store.mailboxes).map((mailbox) => ({
        mailboxId: mailbox.mailboxId,
        projectId: mailbox.projectId,
        environmentId: mailbox.environmentId,
        tabId: mailbox.tabId,
        unreadCount: mailbox.messages.filter(
          (message) =>
            message.toIncarnationId === mailbox.incarnationId &&
            !message.ackedAt &&
            !message.userSeenAt &&
            !message.discardedAt,
        ).length,
        pendingInjectCount: mailbox.messages.filter(
          (message) =>
            message.toIncarnationId === mailbox.incarnationId &&
            message.placement === "pending-inject",
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
    await this.synchronizeAgentMailboxes();
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
    await this.synchronizeAgentMailboxes();
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
    await this.synchronizeAgentMailboxes();
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
          pendingInjectCount: messages.filter(
            (message) =>
              message.toIncarnationId === descriptor.incarnationId &&
              message.placement === "pending-inject",
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
    await this.synchronizeAgentMailboxes();
    const config = await this.loadConfig();
    const settings = normalizeAgentMessagingSettings(config.global.agentMessaging);
    if (!settings.enabled)
      throw new AgentMailError("messaging-disabled", "Agent messaging is disabled");

    return this.enqueueAgentMailMutation(async () => {
      const store = await this.loadAgentMailStore();
      let actor: MailActor;
      let senderScope: string;
      let senderMailbox: PersistedMailbox | undefined;
      if (sender.kind === "tab") {
        senderMailbox = store.mailboxes[agentMailboxId(sender.environmentId, sender.tabId)];
        if (
          !senderMailbox ||
          senderMailbox.tombstonedAt ||
          senderMailbox.projectId !== sender.projectId
        ) {
          throw new AgentMailError("sender-not-found", "Sender tab is not an active mailbox");
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
        actor = {
          kind: "tab",
          projectId: senderMailbox.projectId,
          environmentId: senderMailbox.environmentId,
          tabId: senderMailbox.tabId,
          incarnationId: senderMailbox.incarnationId,
          agent: senderMailbox.agent,
          title: senderMailbox.title,
        };
        senderScope = `tab:${senderMailbox.mailboxId}`;
      } else {
        actor = sender;
        senderScope = sender.kind;
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
        if (sender.kind === "tab") {
          const senderIsParentSource =
            parent.from.kind === "tab" &&
            parent.from.environmentId === sender.environmentId &&
            parent.from.tabId === sender.tabId;
          const senderIsParentRecipient =
            parent.toEnvironmentId === sender.environmentId && parent.toTabId === sender.tabId;
          const senderParticipates = senderIsParentSource || senderIsParentRecipient;
          if (!senderParticipates)
            throw new AgentMailError("policy-denied", "Sender is not a participant in this thread");
          const senderIncarnationMatches = senderIsParentSource
            ? parent.from.kind === "tab" &&
              parent.from.incarnationId === senderMailbox?.incarnationId
            : parent.toIncarnationId === senderMailbox?.incarnationId;
          if (!senderIncarnationMatches) {
            throw new AgentMailError(
              "recipient-superseded",
              "This thread belongs to a prior incarnation of the sender tab",
            );
          }
          const expectedOther =
            parent.from.kind === "tab" &&
            parent.toEnvironmentId === sender.environmentId &&
            parent.toTabId === sender.tabId
              ? agentMailboxId(parent.from.environmentId, parent.from.tabId)
              : agentMailboxId(parent.toEnvironmentId, parent.toTabId);
          if (expectedOther !== destinationId)
            throw new AgentMailError("policy-denied", "A reply cannot redirect the thread");
          const expectedIncarnation =
            parent.from.kind === "tab" &&
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
        sender.kind === "tab"
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
      const shouldScheduleInject =
        effectivePolicy === "idle" &&
        !recipient.mutedInbound &&
        trust !== "cross-project" &&
        trust !== "external" &&
        injectDepth === 0 &&
        agentMailCapabilities(recipient.tabType, recipient.agent, recipient.locked).canInject;
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
        threadDepth: (parent?.threadDepth ?? -1) + 1,
        placement: shouldScheduleInject ? "pending-inject" : "stored",
        ...(shouldScheduleInject
          ? {
              injectRequestId: `mail-inject-${id}`,
              ...(settings.paused ? { placementReason: "paused" } : {}),
            }
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
    if (parent.from.kind !== "tab")
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

  retryAgentMailInject(
    environmentId: string,
    tabId: string,
    messageId: string,
  ): Promise<AgentMailMessage> {
    return this.mutateMessage(environmentId, tabId, messageId, (message) => {
      if (message.placement !== "inject_failed") return false;
      message.placement = "pending-inject";
      delete message.placementReason;
      message.injectRequestId ??= `mail-inject-${message.id}`;
      return true;
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

  async listPendingAgentMailInjects(limit = 100): Promise<PendingAgentMailInject[]> {
    await this.synchronizeAgentMailboxes();
    const [store, config] = await Promise.all([this.loadAgentMailStore(), this.loadConfig()]);
    const settings = normalizeAgentMessagingSettings(config.global.agentMessaging);
    const pending: PendingAgentMailInject[] = [];
    for (const { mailboxId, messageId } of store.pendingInject) {
      const mailbox = store.mailboxes[mailboxId];
      const message = mailbox?.messages.find((candidate) => candidate.id === messageId);
      if (!mailbox || !message || message.placement !== "pending-inject") continue;
      pending.push({ mailbox: this.descriptor(mailbox, settings.defaultInjectPolicy), message });
      if (pending.length >= Math.max(1, Math.min(limit, AGENT_MAIL_MAX_PENDING_INJECTS))) break;
    }
    return pending;
  }

  async listInterruptedAgentMailInjects(): Promise<PendingAgentMailInject[]> {
    await this.synchronizeAgentMailboxes();
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
      message.placementReason = "submitting";
      message.revision += 1;
      mailbox.revision += 1;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      this.announce("agent-mail", mailboxId, mailbox.projectId);
      this.announce("agent-mail-summary", "all");
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
      if (outcome.outcome === "accepted") {
        message.placement = "injected";
        message.injectedAt = new Date().toISOString();
        delete message.placementReason;
      } else if (outcome.outcome === "held") {
        message.placement = "pending-inject";
        message.placementReason = outcome.reason.slice(0, 100);
      } else {
        message.placement = "inject_failed";
        message.placementReason = outcome.reason;
      }
      message.revision += 1;
      mailbox.revision += 1;
      store.revision += 1;
      await this.saveAgentMailStore(store);
      this.announce("agent-mail", mailboxId, mailbox.projectId);
      this.announce("agent-mail-summary", "all");
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
    const environmentIds = (await this.loadEnvironments())
      .filter((environment) => environment.projectId === projectId)
      .map((environment) => environment.id);
    for (const environmentId of environmentIds)
      await this.deleteAgentMailByEnvironment(environmentId);
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
