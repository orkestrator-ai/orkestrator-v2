import { STARTUP_AGENT_TAB_ID } from "@orkestrator/protocol/tab-initial-prompt";
import { randomUUID } from "node:crypto";
import {
  AGENT_MAIL_DEFAULT_LIST_LIMIT,
  AGENT_MAIL_MAX_LIST_LIMIT,
  AGENT_MAIL_MAX_MAILBOXES,
  AgentMailError,
  agentMailCapabilities,
  agentMailNeedsAttention,
  agentMailboxId,
  isAgentMailBudgetHeld,
  normalizeAgentMessagingSettings,
  resolveTabDisplayName,
  sharedConnectionMayActAs,
  type AgentMailMailboxSnapshot,
  type AgentMailMailboxBatchSnapshot,
  type AgentMailInboxSnapshot,
  type AgentMailSendInput,
  type AgentMailMessage,
  type AgentMailSummarySnapshot,
  type MailboxDescriptor,
  type MailboxKind,
  type MailboxPipelineWorker,
} from "@orkestrator/protocol/agent-mail";
import { isAgentPlatform, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  PIPELINE_WORKER_TAB_TYPE,
  describePipelineWorkers,
  pipelineWorkerEnded,
  type PipelineWorker,
} from "@orkestrator/protocol/pipeline-worker-mail";
import { paneLayoutLeaves } from "./storage-shared.js";
import {
  coordinatorConversationRunnable,
  coordinatorMainConversation,
  coordinatorRuntimeId,
  type CoordinatorWorkflowAssociation,
  type CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import type { StorageContext } from "./storage-context.js";
import type { StorageRepositories } from "./storage-repositories.js";
import {
  AgentMailStore,
  countsAsPendingInject,
  metadataMessage,
  promoteStoredMessages,
  type AgentMailSender,
  type PersistedMailbox,
} from "./storage-agent-mail-store.js";

const TERMINAL_TYPES = new Set(["claude", "codex", "opencode"]);

const WORKFLOW_TYPES = new Set(["claude-build", "multi-review"]);

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

/** What a worker mailbox records about its worker. */
function pipelineWorkerMetadata(worker: PipelineWorker): MailboxPipelineWorker {
  return {
    pipelineId: worker.pipelineId,
    sessionKey: worker.sessionKey,
    step: worker.step,
    round: worker.round,
    ...(worker.slot !== undefined ? { slot: worker.slot } : {}),
    label: worker.label,
    ...(worker.model ? { model: worker.model } : {}),
    status: worker.status,
  };
}

function pipelineWorkerDisplayName(worker: PipelineWorker): string {
  return `${worker.label} · round ${worker.round}${
    worker.step === "review" && worker.slot && !/\d/.test(worker.label)
      ? ` · reviewer ${worker.slot}`
      : ""
  }`;
}

/** Equality for synced mailbox metadata; the worker record is the one object field. */
function sameMetadataValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || !left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Mail for a worker that will never read it again: expire it, keep it readable. */
export type ExpiredPipelineWorkerMail = {
  mailbox: Pick<
    PersistedMailbox,
    "mailboxId" | "projectId" | "environmentId" | "tabId" | "displayName"
  > & {
    pipelineWorker: MailboxPipelineWorker;
  };
  message: AgentMailMessage;
};

function expirePipelineWorkerMail(
  store: { pendingInject: Array<{ mailboxId: string; messageId: string }> },
  mailbox: PersistedMailbox,
  worker: MailboxPipelineWorker,
  expired: ExpiredPipelineWorkerMail[],
): boolean {
  let changed = false;
  const reason = `worker-${pipelineWorkerEnded(worker.status) ? worker.status : "ended"}`;
  for (const message of mailbox.messages) {
    if (message.toIncarnationId !== mailbox.incarnationId || message.ackedAt || message.discardedAt)
      continue;
    const queued =
      message.placement === "pending-inject" ||
      message.placement === "stored" ||
      // A claim in flight settles through its own dispatch outcome.
      (message.placement === "inject-held" && message.placementReason !== "submitting");
    if (!queued) continue;
    message.placement = "expired";
    message.placementReason = reason;
    message.revision += 1;
    const index = store.pendingInject.findIndex(
      (entry) => entry.mailboxId === mailbox.mailboxId && entry.messageId === message.id,
    );
    if (index >= 0) store.pendingInject.splice(index, 1);
    expired.push({
      mailbox: {
        mailboxId: mailbox.mailboxId,
        projectId: mailbox.projectId,
        environmentId: mailbox.environmentId,
        tabId: mailbox.tabId,
        displayName: mailbox.displayName,
        pipelineWorker: worker,
      },
      message: structuredClone(message),
    });
    changed = true;
  }
  return changed;
}

function isAddressableTab(tab: Record<string, unknown>): boolean {
  if (typeof tab.id !== "string" || typeof tab.type !== "string") return false;
  if (tab.isReviewTab === true || WORKFLOW_TYPES.has(tab.type)) return false;
  return mailboxKind(tab.type) !== null;
}

/**
 * The mailbox directory: one mailbox per addressable agent tab and open
 * coordinator conversation, synchronised from pane layouts and coordinator
 * workspaces, with the descriptors and snapshots readers list.
 */
export class AgentMailboxDirectory {
  constructor(
    private readonly context: StorageContext,
    private readonly repos: StorageRepositories,
    private readonly store: AgentMailStore,
  ) {}

  private readonly agentMailLayoutRevisions = new Map<string, number>();

  /** Per environment, the pipeline workers and statuses the last sync published. */
  private pipelineWorkerFingerprints = new Map<string, string>();

  private static workerFingerprint(workers: readonly PipelineWorker[]): string {
    return workers.map((worker) => `${worker.address}=${worker.status}`).join(",");
  }

  /** Every workflow's workers: build pipelines' and Multi Review reviewers'. */
  private async workflowWorkers(environmentId?: string) {
    const [pipelines, reviews] = await Promise.all([
      this.repos.buildPipelines.listBuildPipelineWorkers(environmentId),
      this.repos.reviews.listMultiReviewWorkers(environmentId),
    ]);
    return [...pipelines, ...reviews];
  }

  private async pipelineWorkerFingerprintsByEnvironment(
    environmentId?: string,
  ): Promise<Map<string, string>> {
    const fingerprints = new Map<string, string>();
    for (const entry of await this.workflowWorkers(environmentId)) {
      const previous = fingerprints.get(entry.environmentId);
      const next = `${entry.pipelineId}:${entry.terminal ? "ended" : "live"}:${AgentMailboxDirectory.workerFingerprint(entry.workers)}`;
      fingerprints.set(entry.environmentId, previous ? `${previous};${next}` : next);
    }
    return fingerprints;
  }

  /** Whether a build pipeline's workers changed since the directory last published them. */
  async pipelineWorkerMailboxesStale(): Promise<boolean> {
    const current = await this.pipelineWorkerFingerprintsByEnvironment();
    if (current.size !== this.pipelineWorkerFingerprints.size) return true;
    for (const [environmentId, fingerprint] of current) {
      if (this.pipelineWorkerFingerprints.get(environmentId) !== fingerprint) return true;
    }
    return false;
  }

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

  setAgentMailRuntimeProvider(provider: AgentMailboxDirectory["agentMailRuntimeProvider"]): void {
    this.agentMailRuntimeProvider = provider;
  }

  /** The tab a sender naming only `environmentId` would reach (see `recipientTab`). */
  resolveAgentMailRecipientTab(sender: AgentMailSender, environmentId: string): Promise<string> {
    return this.recipientTab(sender, {
      requestId: "resolve",
      toEnvironmentId: environmentId,
      toTabId: "",
      body: "",
    });
  }

  /**
   * The tab to deliver to when a sender named only an environment.
   *
   * A coordinator means the tab it is waiting on; otherwise the environment's
   * only agent tab, then the agent it was launched with. Guessing between
   * several tabs is refused with their ids, so the sender can choose.
   */
  async recipientTab(sender: AgentMailSender, input: AgentMailSendInput): Promise<string> {
    await this.ensureAgentMailDirectoryFresh([input.toEnvironmentId]);
    // A pipeline environment runs one worker per stage session, several at
    // once during review. Which one is running changes under the sender, so
    // nothing picks one for it: the sender names a worker.
    const pipelines = (
      await this.repos.buildPipelines.listBuildPipelineWorkers(input.toEnvironmentId)
    ).filter((entry) => !entry.terminal);
    if (pipelines.length > 0) {
      const workers = pipelines.flatMap((entry) => entry.workers);
      const others = await this.listAgentMailPullTabIds(input.toEnvironmentId);
      throw new AgentMailError(
        "recipient-not-found",
        `That environment runs a build pipeline; nothing is routed to "whichever worker is running". Pass toTabId naming one worker${
          workers.length > 0
            ? `. Workers: ${describePipelineWorkers(workers)}`
            : ", once one has started (none has yet)"
        }${others.length > 0 ? `. Other agent tabs: ${others.join(", ")}` : ""}.`,
      );
    }
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
    if (tabs.includes(STARTUP_AGENT_TAB_ID)) return STARTUP_AGENT_TAB_ID;
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

  /**
   * Resolve an environment credential only when it has one unambiguous agent
   * identity. This intentionally scans the authoritative store rather than a
   * paginated project directory: authorization must never depend on which
   * mailbox happened to land on the first page.
   */
  async resolveUniqueAgentMailPullTabId(environmentId: string): Promise<string | null> {
    if (!environmentId.trim()) return null;
    const store = await this.store.snapshot();
    let tabId: string | null = null;
    for (const mailbox of Object.values(store.mailboxes)) {
      if (
        mailbox.environmentId !== environmentId ||
        mailbox.tombstonedAt ||
        // A pipeline worker is reached only through its own turn credential,
        // never claimed by an environment-wide one.
        mailbox.kind === "pipeline" ||
        !agentMailCapabilities(mailbox.tabType, mailbox.agent, mailbox.locked).canPull
      ) {
        continue;
      }
      if (tabId !== null) return null;
      tabId = mailbox.tabId;
    }
    return tabId;
  }

  /**
   * The environment's live pull-capable mailboxes. Pipeline workers are left
   * out unless asked for: an environment-wide credential may not claim one,
   * and a send naming only the environment never resolves to one.
   * `sharedConnection` keeps only the mailboxes an environment-wide
   * connection may act as (`sharedConnectionMayActAs`).
   */
  async listAgentMailPullTabIds(
    environmentId: string,
    options: { includePipelineWorkers?: boolean; sharedConnection?: boolean } = {},
  ): Promise<string[]> {
    if (!environmentId.trim()) return [];
    const store = await this.store.snapshot();
    return Object.values(store.mailboxes)
      .filter(
        (mailbox) =>
          mailbox.environmentId === environmentId &&
          !mailbox.tombstonedAt &&
          (options.includePipelineWorkers === true || mailbox.kind !== "pipeline") &&
          !(mailbox.pipelineWorker && pipelineWorkerEnded(mailbox.pipelineWorker.status)) &&
          (options.sharedConnection !== true ||
            sharedConnectionMayActAs(mailbox.tabType, mailbox.agent)) &&
          agentMailCapabilities(mailbox.tabType, mailbox.agent, mailbox.locked).canPull,
      )
      .sort((a, b) => (a.tabOrdinal ?? 0) - (b.tabOrdinal ?? 0) || a.tabId.localeCompare(b.tabId))
      .map((mailbox) => mailbox.tabId);
  }

  async synchronizeAgentMailboxes(): Promise<void> {
    const [
      projects,
      environments,
      layoutsResult,
      coordinators,
      coordinatorWorkflows,
      config,
      pipelineWorkerSets,
    ] = await Promise.all([
      this.repos.projects.loadProjects(),
      this.repos.projects.loadEnvironments(),
      this.repos.sessions.loadPaneLayoutsForReconciliation(),
      this.repos.coordinators.listCoordinatorWorkspaces(),
      this.repos.coordinators.listAllCoordinatorWorkflowAssociations(),
      this.repos.config.loadConfig(),
      this.workflowWorkers(),
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
    const observeTab = (
      environment: (typeof environments)[number],
      project: (typeof projects)[number],
      tab: Record<string, unknown>,
      tabOrdinal: number,
    ) => {
      const environmentId = environment.id;
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
    };
    const tabCounts = new Map<string, number>();
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
          if (isAddressableTab(tab)) observeTab(environment, project, tab, tabOrdinal);
        }
      }
      tabCounts.set(environmentId, tabOrdinal);
    }
    // The job tab lands when setup finishes, but its agent is addressable from
    // the moment it is promised: mail sent during setup waits for it, as it
    // always has, rather than being refused for a tab that is on its way.
    for (const environment of environments) {
      if (!environment.pendingAgentLaunch || environment.deletionRequestedAt) continue;
      if (observed.has(agentMailboxId(environment.id, STARTUP_AGENT_TAB_ID))) continue;
      const project = projectById.get(environment.projectId);
      if (!project) continue;
      observeTab(
        environment,
        project,
        {
          id: STARTUP_AGENT_TAB_ID,
          type: "agent-native",
          nativeAgentData: {
            environmentId: environment.id,
            ...(environment.initialAgentPlatform
              ? { platform: environment.initialAgentPlatform }
              : {}),
          },
        },
        (tabCounts.get(environment.id) ?? 0) + 1,
      );
    }
    // One mailbox per build pipeline worker of a pipeline still running. A
    // worker that has ended keeps its mailbox (with its final status) while
    // its pipeline runs, so a send to it is refused by name; a finished or
    // removed pipeline's workers are tombstoned below.
    const endedWorkers = new Map<string, MailboxPipelineWorker>();
    const pipelineWorkerFingerprints = new Map<string, string>();
    for (const entry of pipelineWorkerSets) {
      const previous = pipelineWorkerFingerprints.get(entry.environmentId);
      const fingerprint = `${entry.pipelineId}:${entry.terminal ? "ended" : "live"}:${AgentMailboxDirectory.workerFingerprint(entry.workers)}`;
      pipelineWorkerFingerprints.set(
        entry.environmentId,
        previous ? `${previous};${fingerprint}` : fingerprint,
      );
      const environment = environmentById.get(entry.environmentId);
      const project = environment ? projectById.get(environment.projectId) : undefined;
      for (const [index, worker] of entry.workers.entries()) {
        const mailboxId = agentMailboxId(entry.environmentId, worker.address);
        if (entry.terminal || !environment || environment.deletionRequestedAt || !project) {
          endedWorkers.set(mailboxId, pipelineWorkerMetadata(worker));
          continue;
        }
        const displayName = pipelineWorkerDisplayName(worker);
        observed.set(mailboxId, {
          mailboxId,
          projectId: project.id,
          projectName: project.name,
          environmentId: entry.environmentId,
          environmentName: environment.name,
          environmentStatus: environment.status,
          tabId: worker.address,
          tabType: PIPELINE_WORKER_TAB_TYPE,
          title: displayName,
          displayName,
          // After every pane tab, in the order the pipeline started them.
          tabOrdinal: 1_000 + index,
          agent: worker.agent,
          kind: "pipeline",
          locked: true,
          coordinatorOrigin: coordinatorOrigins.get(entry.environmentId),
          logicalSessionKey: worker.sessionKey,
          pipelineWorker: pipelineWorkerMetadata(worker),
        });
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
          environmentStatus: coordinatorConversationRunnable(workspace, conversation)
            ? "running"
            : "stopped",
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

    const expired: ExpiredPipelineWorkerMail[] = [];
    await this.store.enqueue(async () => {
      const store = await this.store.load();
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
          ([key, value]) => !sameMetadataValue(current[key as keyof PersistedMailbox], value),
        );
        if (changed) {
          Object.assign(current, metadata);
          current.revision += 1;
          changedMailboxIds.add(mailboxId);
        }
      }
      // Durable recovery: assignment and mailbox publication are separate writes.
      // Retry even when metadata already matches, including after a restart. Only
      // mail stored because no agent could receive it belongs to this recovery.
      const settings = normalizeAgentMessagingSettings(config.global.agentMessaging);
      if (settings.enabled) {
        for (const mailboxId of observed.keys()) {
          const mailbox = store.mailboxes[mailboxId];
          if (mailbox && promoteStoredMessages(store, mailbox, settings, "awaiting-agent") > 0) {
            mailbox.revision += 1;
            changedMailboxIds.add(mailboxId);
          }
        }
      }
      // A worker that has ended never reads its queue: that mail expires and
      // its sender is told, rather than waiting for a turn that will not come
      // or going to some other worker.
      for (const mailboxId of observed.keys()) {
        const mailbox = store.mailboxes[mailboxId];
        const worker = mailbox?.pipelineWorker;
        if (
          mailbox &&
          worker &&
          pipelineWorkerEnded(worker.status) &&
          expirePipelineWorkerMail(store, mailbox, worker, expired)
        ) {
          mailbox.revision += 1;
          changedMailboxIds.add(mailboxId);
        }
      }
      for (const [mailboxId, mailbox] of Object.entries(store.mailboxes)) {
        if (observed.has(mailboxId)) continue;
        if (mailbox.tombstonedAt) {
          // Reconciliation may have returned a proven-unsent claim since closure.
          if (
            mailbox.kind === "pipeline" &&
            mailbox.pipelineWorker &&
            expirePipelineWorkerMail(store, mailbox, mailbox.pipelineWorker, expired)
          ) {
            mailbox.revision += 1;
            changedMailboxIds.add(mailboxId);
          }
          continue;
        }
        if (mailbox.kind === "pipeline" && mailbox.pipelineWorker) {
          // Its pipeline finished or was removed: keep the final status so a
          // later send is refused with it, and expire what it never read.
          const worker = endedWorkers.get(mailboxId) ?? {
            ...mailbox.pipelineWorker,
            status: pipelineWorkerEnded(mailbox.pipelineWorker.status)
              ? mailbox.pipelineWorker.status
              : ("cancelled" as const),
          };
          mailbox.pipelineWorker = worker;
          expirePipelineWorkerMail(store, mailbox, worker, expired);
        }
        mailbox.tombstonedAt = now;
        mailbox.injectOverride = "off";
        mailbox.revision += 1;
        for (const message of mailbox.messages) {
          // Worker claims remain journaled until their own outcome is known.
          if (mailbox.kind === "pipeline") continue;
          if (message.placement !== "pending-inject" && message.placement !== "inject-held")
            continue;
          // A closed main's budget-held mail keeps its hold: the next main
          // takes it over still held (`moveClosedCoordinatorMail`), so only
          // the user's Resume releases it, never replacing the main (2900).
          if (
            mailbox.ownerKind === "coordinator" &&
            mailbox.coordinatorRole !== "side" &&
            isAgentMailBudgetHeld(message)
          )
            continue;
          message.placement = "undeliverable";
          message.placementReason = "tab-closed";
          message.revision += 1;
        }
        changedMailboxIds.add(mailboxId);
      }
      if (changedMailboxIds.size === 0) return;
      store.revision += 1;
      await this.store.save(store);
      this.context.changes.announce("agent-mail-summary", "all");
      for (const mailboxId of changedMailboxIds) {
        this.context.changes.announce(
          "agent-mail",
          mailboxId,
          store.mailboxes[mailboxId]?.projectId,
        );
      }
    });
    this.pipelineWorkerFingerprints = pipelineWorkerFingerprints;
    if (expired.length > 0) {
      // Each sender is told; a failed notice leaves the message expired.
      await this.repos.agentMail.notifyExpiredPipelineWorkerMail(expired).catch(() => undefined);
    }
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

  async ensureAgentMailDirectoryFresh(environmentIds: string[]): Promise<void> {
    for (const environmentId of new Set(environmentIds.filter(Boolean))) {
      const layout = await this.repos.sessions.getPaneLayout(environmentId);
      const revision = layout?.revision ?? -1;
      // A worker gets its mailbox the moment its session starts, and refuses
      // mail the moment it ends: neither waits for a pane-layout change.
      const workers =
        (await this.pipelineWorkerFingerprintsByEnvironment(environmentId)).get(environmentId) ??
        "";
      if (
        this.agentMailLayoutRevisions.get(environmentId) !== revision ||
        (this.pipelineWorkerFingerprints.get(environmentId) ?? "") !== workers
      ) {
        await this.synchronizeAgentMailboxes();
        return;
      }
    }
  }

  descriptor(mailbox: PersistedMailbox, defaultPolicy: "off" | "idle"): MailboxDescriptor {
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
    const worker = mailbox.pipelineWorker;
    const presence =
      mailbox.tombstonedAt || (worker && pipelineWorkerEnded(worker.status))
        ? "tab_closed"
        : mailbox.environmentStatus !== "running"
          ? "environment_stopped"
          : (runtime?.presence ??
            (worker ? (worker.status === "running" ? "working" : "idle") : "unknown"));
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
      ...(worker ? { pipelineWorker: worker } : {}),
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
      this.store.snapshot(),
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
    const store = await this.store.snapshot();
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
            message.toIncarnationId === mailbox.incarnationId &&
            agentMailNeedsAttention(
              message,
              agentMailCapabilities(mailbox.tabType, mailbox.agent, mailbox.locked),
            ),
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
      this.store.snapshot(),
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
      this.store.snapshot(),
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
      this.store.snapshot(),
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
              agentMailNeedsAttention(message, descriptor.capabilities),
          ).length,
          revision,
        })),
      },
    };
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
    return this.store.enqueue(async () => {
      const store = await this.store.load();
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
      if (!delivered && deliversWhenIdle()) promoteStoredMessages(store, mailbox, settings, "all");
      else if (!routed && routesWake()) promoteStoredMessages(store, mailbox, settings, "routed");
      mailbox.revision += 1;
      store.revision += 1;
      await this.store.save(store);
      this.context.changes.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      this.context.changes.announce("agent-mail-summary", "all");
      return this.descriptor(mailbox, defaultPolicy);
    });
  }
}
