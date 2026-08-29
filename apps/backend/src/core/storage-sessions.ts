import * as shared from "./storage-shared.js";
import { MAX_TABS_PER_ENVIRONMENT } from "@orkestrator/protocol/pane-layout";
import {
  MAX_SESSIONS_PER_ENVIRONMENT,
  PANE_LAYOUT_VERSION,
  assertPaneLayoutGeneration,
  assertPaneLayoutRootWithinBounds,
  assertPaneLayoutSelectionIntentWithinBounds,
  createSessionObject,
  environmentIsReadyForSetupHandoff,
  exists,
  fs,
  isNonNegativeInteger,
  isRecord,
  mergePersistedPaneLayouts,
  nowIso,
  paneLayoutLeaves,
  paneLayoutRevisionConflictMessage,
  selectedTabIsSetupHandoffSource,
  suppressLateSetupTabAdditions,
} from "./storage-shared.js";
type AgentInteractionOrigin = shared.AgentInteractionOrigin;
type AgentInteractionPolicy = shared.AgentInteractionPolicy;
type AgentInteractionResolutionJournal = shared.AgentInteractionResolutionJournal;
type StoredDesktopConnections = shared.StoredDesktopConnections;
type FeaturePlanningRecord = shared.FeaturePlanningRecord;
type BuildPipelineAgent = shared.BuildPipelineAgent;
type PaneLayoutMergeInput = shared.PaneLayoutMergeInput;
type PaneLayoutSelectionIntent = shared.PaneLayoutSelectionIntent;
type ConditionalResourceSnapshot<T> = shared.ConditionalResourceSnapshot<T>;
type ResourceChange = shared.ResourceChange;
type ResourceKind = shared.ResourceKind;
type ResourceManifestKind = shared.ResourceManifestKind;
type ResourceRevisionManifest = shared.ResourceRevisionManifest;
type ResourceRevisionMap = shared.ResourceRevisionMap;
type ResourceSnapshotRevision = shared.ResourceSnapshotRevision;
type AgentModel = shared.AgentModel;
type AgentActivityState = shared.AgentActivityState;
type AgentActivitySource = shared.AgentActivitySource;
type AgentModelCatalogCache = shared.AgentModelCatalogCache;
type AppConfig = shared.AppConfig;
type ClaudeModelCatalogSnapshot = shared.ClaudeModelCatalogSnapshot;
type ClaudeModelCatalogEntry = shared.ClaudeModelCatalogEntry;
type CodexModelCatalogEntry = shared.CodexModelCatalogEntry;
type CodexReasoningEffort = shared.CodexReasoningEffort;
type Environment = shared.Environment;
type EnvironmentStatus = shared.EnvironmentStatus;
type EnvironmentType = shared.EnvironmentType;
type OpenCodeModelCatalogEntry = shared.OpenCodeModelCatalogEntry;
type OpenCodeModelCatalogSnapshot = shared.OpenCodeModelCatalogSnapshot;
type PortMapping = shared.PortMapping;
type PrState = shared.PrState;
type Project = shared.Project;
type PersistedPaneLayout = shared.PersistedPaneLayout;
type PersistedLoopedReviewWorkflow = shared.PersistedLoopedReviewWorkflow;
type PersistedMultiReviewWorkflow = shared.PersistedMultiReviewWorkflow;
type PersistedBuildPipeline = shared.PersistedBuildPipeline;
type PersistedNativeAgentSession = shared.PersistedNativeAgentSession;
type PersistedNativeAgentPendingDispatch = shared.PersistedNativeAgentPendingDispatch;
type PersistedComposeDraft = shared.PersistedComposeDraft;
type PersistedFileDraft = shared.PersistedFileDraft;
type PersistedPromptQueue = shared.PersistedPromptQueue;
type PersistedAgentHandoff = shared.PersistedAgentHandoff;
type RepositoryConfig = shared.RepositoryConfig;
type Session = shared.Session;
type SessionType = shared.SessionType;
type JsonRecord = shared.JsonRecord;
type KanbanComment = shared.KanbanComment;
type KanbanImage = shared.KanbanImage;
type KanbanStatus = shared.KanbanStatus;
type MutablePaneLayoutLeaf = shared.MutablePaneLayoutLeaf;
type KanbanTask = shared.KanbanTask;
type ProjectNotes = shared.ProjectNotes;
type FeaturePlanStatus = shared.FeaturePlanStatus;
type FeaturePlanMessage = shared.FeaturePlanMessage;
type FeatureStoryCard = shared.FeatureStoryCard;
type FeaturePlan = shared.FeaturePlan;
type LinearAuth = shared.LinearAuth;
type LinearCompletionComment = shared.LinearCompletionComment;
type GitHubCompletionComment = shared.GitHubCompletionComment;
type LoadedNativeAgentSessions = shared.LoadedNativeAgentSessions;
type PersistedOpenCodeModelCatalogStore = shared.PersistedOpenCodeModelCatalogStore;
type ResourceChangeListener = shared.ResourceChangeListener;

import { StorageConfig } from "./storage-config.ts";

export type StorageLayerTypes = [
  AgentInteractionOrigin,
  AgentInteractionPolicy,
  AgentInteractionResolutionJournal,
  StoredDesktopConnections,
  FeaturePlanningRecord,
  BuildPipelineAgent,
  PaneLayoutMergeInput,
  PaneLayoutSelectionIntent,
  ConditionalResourceSnapshot<unknown>,
  ResourceChange,
  ResourceKind,
  ResourceManifestKind,
  ResourceRevisionManifest,
  ResourceRevisionMap,
  ResourceSnapshotRevision,
  AgentModel,
  AgentActivityState,
  AgentActivitySource,
  AgentModelCatalogCache,
  AppConfig,
  ClaudeModelCatalogSnapshot,
  ClaudeModelCatalogEntry,
  CodexModelCatalogEntry,
  CodexReasoningEffort,
  Environment,
  EnvironmentStatus,
  EnvironmentType,
  OpenCodeModelCatalogEntry,
  OpenCodeModelCatalogSnapshot,
  PortMapping,
  PrState,
  Project,
  PersistedPaneLayout,
  PersistedLoopedReviewWorkflow,
  PersistedMultiReviewWorkflow,
  PersistedBuildPipeline,
  PersistedNativeAgentSession,
  PersistedNativeAgentPendingDispatch,
  PersistedComposeDraft,
  PersistedFileDraft,
  PersistedPromptQueue,
  PersistedAgentHandoff,
  RepositoryConfig,
  Session,
  SessionType,
  JsonRecord,
  KanbanComment,
  KanbanImage,
  KanbanStatus,
  MutablePaneLayoutLeaf,
  KanbanTask,
  ProjectNotes,
  FeaturePlanStatus,
  FeaturePlanMessage,
  FeatureStoryCard,
  FeaturePlan,
  LinearAuth,
  LinearCompletionComment,
  GitHubCompletionComment,
  LoadedNativeAgentSessions,
  PersistedOpenCodeModelCatalogStore,
  ResourceChangeListener,
];

export abstract class StorageSessions extends StorageConfig {
  async createSession(
    environmentId: string,
    containerId: string,
    tabId: string,
    sessionType: SessionType,
  ): Promise<Session> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const session = createSessionObject(environmentId, containerId, tabId, sessionType);
    const envSessions = sessions.filter((candidate) => candidate.environmentId === environmentId);
    session.order = Math.max(-1, ...envSessions.map((candidate) => candidate.order)) + 1;

    if (envSessions.length >= MAX_SESSIONS_PER_ENVIRONMENT) {
      const oldestDisconnected = envSessions
        .filter((candidate) => candidate.status === "disconnected")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (oldestDisconnected) {
        const index = sessions.findIndex((candidate) => candidate.id === oldestDisconnected.id);
        if (index >= 0) sessions.splice(index, 1);
        await this.deleteSessionBuffer(oldestDisconnected.id);
      }
    }

    sessions.push(session);
    await this.saveJson(this.sessionsFile(), sessions);
    this.announce("session", environmentId);
    return session;
  }

  async getPaneLayout(environmentId: string): Promise<PersistedPaneLayout | null> {
    const layouts = await this.loadJsonCached<Record<string, PersistedPaneLayout>>(
      this.paneLayoutsFile(),
      () => ({}),
    );
    return layouts[environmentId] ?? null;
  }

  /** Remove every parent, reviewer, and adopted fix tab owned by one Multi Review. */
  async removeMultiReviewTabs(environmentId: string, workflowId: string): Promise<string[]> {
    return this.enqueuePaneLayoutMutation(async () => {
      const layouts = await this.loadJson<Record<string, PersistedPaneLayout>>(
        this.paneLayoutsFile(),
        () => ({}),
      );
      const previous = layouts[environmentId];
      if (!previous) return [];
      const root = JSON.parse(JSON.stringify(previous.root)) as unknown;
      const removed: string[] = [];
      for (const leaf of paneLayoutLeaves(root)) {
        const retained = leaf.tabs.filter((tab) => {
          const tabId = typeof tab.id === "string" ? tab.id : "";
          const reviewData = isRecord(tab.multiReviewTabData) ? tab.multiReviewTabData : undefined;
          const fixTabPrefix = `multi-review-fix:${workflowId}`;
          const owned =
            reviewData?.workflowId === workflowId ||
            tabId === fixTabPrefix ||
            tabId.startsWith(`${fixTabPrefix}:`);
          if (owned && tabId) removed.push(tabId);
          return !owned;
        });
        if (retained.length === leaf.tabs.length) continue;
        leaf.tabs = retained;
        if (!retained.some((tab) => tab.id === leaf.activeTabId)) {
          const fallbackId = retained.at(-1)?.id;
          leaf.activeTabId = typeof fallbackId === "string" ? fallbackId : null;
        }
      }
      if (removed.length === 0) return [];
      const saved: PersistedPaneLayout = {
        ...previous,
        root,
        updatedAt: nowIso(),
        revision: previous.revision + 1,
      };
      assertPaneLayoutRootWithinBounds(saved.root);
      layouts[environmentId] = saved;
      await this.saveJson(this.paneLayoutsFile(), layouts, { backup: false });
      this.announce("pane-layout", environmentId);
      return removed;
    });
  }

  /**
   * Loads the layout store once for destructive reconciliation. An absent file
   * is a valid empty store; a present file that cannot be parsed (including
   * from a retained backup) is unavailable, never evidence that every tab was
   * deleted.
   */
  async loadPaneLayoutsForReconciliation(): Promise<{
    available: boolean;
    layouts: Record<string, PersistedPaneLayout>;
  }> {
    const filePath = this.paneLayoutsFile();
    if (!(await exists(filePath))) return { available: true, layouts: {} };
    try {
      const raw = await fs.readFile(filePath, "utf8");
      if (!raw.trim()) throw new Error("Pane layout store is empty");
      const layouts = JSON.parse(raw) as unknown;
      if (!isRecord(layouts)) throw new Error("Pane layout store is not a record");
      return {
        available: true,
        layouts: layouts as Record<string, PersistedPaneLayout>,
      };
    } catch {
      const recovered = await this.recoverJsonFromBackups<unknown>(filePath);
      if (!recovered || !isRecord(recovered.value)) {
        return { available: false, layouts: {} };
      }
      return {
        available: true,
        layouts: recovered.value as Record<string, PersistedPaneLayout>,
      };
    }
  }

  async savePaneLayout(
    environmentId: string,
    layout: Pick<PersistedPaneLayout, "version" | "containerId" | "activePaneId" | "root">,
    expectedRevision: number,
  ): Promise<PersistedPaneLayout> {
    if (!isNonNegativeInteger(expectedRevision)) {
      throw new Error("Pane layout expected revision must be a non-negative integer");
    }
    assertPaneLayoutRootWithinBounds(layout.root);

    return this.enqueuePaneLayoutMutation(async () => {
      const environment = await this.getEnvironment(environmentId);
      if (!environment) {
        throw new Error(`Environment not found: ${environmentId}`);
      }
      // The CAS token alone does not make this write current: a renderer holding
      // a layout from a previous container generation can still read the latest
      // revision and overwrite the live tree with dead tabs. Without this guard
      // the invariant applyPaneLayoutIntent enforces is bypassable by pointing
      // the same renderer at save_pane_layout instead.
      assertPaneLayoutGeneration(environment, layout.containerId, "write");

      const layouts = await this.loadJson<Record<string, PersistedPaneLayout>>(
        this.paneLayoutsFile(),
        () => ({}),
      );
      const previous = layouts[environmentId];
      const currentRevision = previous?.revision ?? 0;
      if (currentRevision !== expectedRevision) {
        throw new Error(paneLayoutRevisionConflictMessage(expectedRevision, currentRevision));
      }
      const saved: PersistedPaneLayout = {
        version: layout.version,
        environmentId,
        containerId: layout.containerId,
        activePaneId: layout.activePaneId,
        root: layout.root,
        updatedAt: nowIso(),
        revision: currentRevision + 1,
      };
      layouts[environmentId] = saved;
      // Selection changes make this a high-churn record. Keep one current
      // recovery snapshot without rotating five near-identical historical
      // backups for every focus change.
      await this.saveJson(this.paneLayoutsFile(), layouts, { backup: false });
      this.announce("pane-layout", environmentId);
      return saved;
    });
  }

  /**
   * Applies one optimistic renderer mutation against the latest durable tree.
   * The read, three-way rebase, revision increment, and write share the pane
   * mutation queue, so concurrent windows cannot race a renderer-side CAS
   * retry or lose the mutation during a renderer crash.
   */
  async applyPaneLayoutIntent(
    environmentId: string,
    base: PaneLayoutMergeInput,
    desired: PaneLayoutMergeInput,
    selectionIntent?: PaneLayoutSelectionIntent,
  ): Promise<PersistedPaneLayout> {
    assertPaneLayoutRootWithinBounds(base.root);
    assertPaneLayoutRootWithinBounds(desired.root);
    assertPaneLayoutSelectionIntentWithinBounds(selectionIntent);
    return this.enqueuePaneLayoutMutation(async () => {
      const environment = await this.getEnvironment(environmentId);
      if (!environment) {
        throw new Error(`Environment not found: ${environmentId}`);
      }
      // Both sides of the three-way merge come from the untrusted renderer. A
      // current `desired` with a dead `base` still merges against `previous`,
      // which resurrects the tabs that ancestor carried.
      assertPaneLayoutGeneration(environment, desired.containerId, "intent");
      assertPaneLayoutGeneration(environment, base.containerId, "intent");
      const layouts = await this.loadJson<Record<string, PersistedPaneLayout>>(
        this.paneLayoutsFile(),
        () => ({}),
      );
      const previous = layouts[environmentId];
      const sameGeneration =
        previous &&
        previous.version === desired.version &&
        previous.containerId === desired.containerId;
      let next = sameGeneration
        ? mergePersistedPaneLayouts(
            base,
            desired,
            {
              version: previous.version,
              containerId: previous.containerId,
              activePaneId: previous.activePaneId,
              root: previous.root,
            } as PaneLayoutMergeInput,
            { selectionIntent },
          )
        : desired;
      if (
        environment.setupPhase === "ready" ||
        environment.setupScriptsComplete === true ||
        environment.setupOverride === true
      ) {
        next = suppressLateSetupTabAdditions(next, previous, base);
      }
      assertPaneLayoutRootWithinBounds(next.root);
      const saved: PersistedPaneLayout = {
        ...next,
        environmentId,
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
      };
      layouts[environmentId] = saved;
      await this.saveJson(this.paneLayoutsFile(), layouts, { backup: false });
      this.announce("pane-layout", environmentId);
      return saved;
    });
  }

  /** Add the backend-owned build surface before start_build_pipeline returns. */
  async ensureBuildPipelineTab(input: {
    pipelineId: string;
    taskId: string;
    environmentId: string;
    isLocal: boolean;
  }): Promise<PersistedPaneLayout> {
    return this.enqueuePaneLayoutMutation(async () => {
      const environment = await this.getEnvironment(input.environmentId);
      if (!environment) throw new Error(`Environment not found: ${input.environmentId}`);
      const layouts = await this.loadJson<Record<string, PersistedPaneLayout>>(
        this.paneLayoutsFile(),
        () => ({}),
      );
      const previous = layouts[input.environmentId];
      const root = previous
        ? (JSON.parse(JSON.stringify(previous.root)) as unknown)
        : { kind: "leaf", id: "default", tabs: [], activeTabId: null };

      type Leaf = {
        kind: "leaf";
        id: string;
        tabs: Array<Record<string, unknown>>;
        activeTabId: string | null;
      };
      const leaves: Leaf[] = [];
      const visit = (node: unknown): void => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return;
        const record = node as Record<string, unknown>;
        if (record.kind === "leaf" && typeof record.id === "string" && Array.isArray(record.tabs)) {
          leaves.push(record as unknown as Leaf);
          return;
        }
        if (record.kind === "split" && Array.isArray(record.children)) {
          for (const child of record.children) visit(child);
        }
      };
      visit(root);
      if (leaves.length === 0) throw new Error("Persisted pane layout has no leaf pane");
      const existing = leaves.find((leaf) =>
        leaf.tabs.some((tab) => {
          const build = tab.buildTabData;
          return (
            tab.type === "claude-build" &&
            build !== null &&
            typeof build === "object" &&
            !Array.isArray(build) &&
            (build as Record<string, unknown>).taskId === input.taskId
          );
        }),
      );
      const target =
        existing ?? leaves.find((leaf) => leaf.id === previous?.activePaneId) ?? leaves[0]!;
      const existingTab = existing?.tabs.find((tab) => {
        const build = tab.buildTabData as Record<string, unknown> | undefined;
        return tab.type === "claude-build" && build?.taskId === input.taskId;
      });
      const tabId =
        typeof existingTab?.id === "string" && existingTab.id.length > 0
          ? existingTab.id
          : `build-${input.pipelineId}`;
      const buildTabData = {
        environmentId: input.environmentId,
        pipelineId: input.pipelineId,
        taskId: input.taskId,
        isLocal: input.isLocal,
      };
      if (existingTab) {
        existingTab.id = tabId;
        existingTab.buildTabData = buildTabData;
      } else {
        target.tabs.push({
          id: tabId,
          type: "claude-build",
          buildTabData,
        });
      }
      target.activeTabId = tabId;
      const saved: PersistedPaneLayout = {
        version: PANE_LAYOUT_VERSION,
        environmentId: input.environmentId,
        containerId: environment.containerId,
        activePaneId: target.id,
        root,
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
      };
      assertPaneLayoutRootWithinBounds(saved.root);
      layouts[input.environmentId] = saved;
      await this.saveJson(this.paneLayoutsFile(), layouts, { backup: false });
      this.announce("pane-layout", input.environmentId);
      return saved;
    });
  }

  /**
   * Publish a backend-owned native agent tab for an independently launched job.
   *
   * The request id which produced `tabId` is stable, so retrying an MCP call
   * converges on this same tab instead of opening a duplicate. The provider
   * session is bound in a later call because a cold bridge may take long enough
   * for the client transport to disappear; either side of that boundary is
   * therefore safe to replay.
   */
  async ensureNativeAgentJobTab(input: {
    environmentId: string;
    tabId: string;
    agent: BuildPipelineAgent;
    providerSessionId?: string;
    title?: string;
    isReviewTab?: boolean;
    activate?: boolean;
  }): Promise<PersistedPaneLayout> {
    return this.enqueuePaneLayoutMutation(async () => {
      const environment = await this.getEnvironment(input.environmentId);
      if (!environment) throw new Error(`Environment not found: ${input.environmentId}`);
      const layouts = await this.loadJson<Record<string, PersistedPaneLayout>>(
        this.paneLayoutsFile(),
        () => ({}),
      );
      const previous = layouts[input.environmentId];
      const root = previous
        ? (JSON.parse(JSON.stringify(previous.root)) as unknown)
        : { kind: "leaf", id: "default", tabs: [], activeTabId: null };
      const leaves = paneLayoutLeaves(root);
      if (leaves.length === 0) throw new Error("Persisted pane layout has no leaf pane");

      const existingLeaf = leaves.find((leaf) => leaf.tabs.some((tab) => tab.id === input.tabId));
      const existingTab = existingLeaf?.tabs.find((tab) => tab.id === input.tabId);
      if (existingTab && existingTab.type !== "agent-native") {
        throw new Error(`Tab ID is already in use: ${input.tabId}`);
      }
      const existingPlatform = isRecord(existingTab?.nativeAgentData)
        ? existingTab.nativeAgentData.platform
        : undefined;
      if (existingPlatform !== undefined && existingPlatform !== input.agent) {
        throw new Error(`Tab belongs to a different agent platform: ${input.tabId}`);
      }
      if (!existingTab) {
        const tabCount = leaves.reduce((count, leaf) => count + leaf.tabs.length, 0);
        if (tabCount >= MAX_TABS_PER_ENVIRONMENT) {
          throw new Error(
            `Environment already has the maximum of ${MAX_TABS_PER_ENVIRONMENT} tabs`,
          );
        }
      }

      const target =
        existingLeaf ?? leaves.find((leaf) => leaf.id === previous?.activePaneId) ?? leaves[0]!;
      const previousNativeAgentData = isRecord(existingTab?.nativeAgentData)
        ? existingTab.nativeAgentData
        : {};
      const nativeAgentData: Record<string, unknown> = {
        ...previousNativeAgentData,
        platform: input.agent,
        environmentId: input.environmentId,
        isLocal: environment.environmentType === "local",
      };
      if (environment.environmentType === "local") {
        delete nativeAgentData.containerId;
      } else if (environment.containerId) {
        nativeAgentData.containerId = environment.containerId;
      }
      if (input.providerSessionId) nativeAgentData.sessionId = input.providerSessionId;

      const tab: Record<string, unknown> = {
        ...existingTab,
        id: input.tabId,
        type: "agent-native",
        nativeAgentData,
        ...(input.title?.trim() ? { displayTitle: input.title.trim() } : {}),
        ...(input.isReviewTab === true ? { isReviewTab: true } : {}),
      };
      if (existingTab) Object.assign(existingTab, tab);
      else target.tabs.push(tab);
      const activateNewTab = input.activate === true && !existingTab;
      if (!target.activeTabId || activateNewTab) target.activeTabId = input.tabId;

      const saved: PersistedPaneLayout = {
        version: PANE_LAYOUT_VERSION,
        environmentId: input.environmentId,
        containerId: environment.environmentType === "local" ? null : environment.containerId,
        activePaneId: activateNewTab ? target.id : (previous?.activePaneId ?? target.id),
        root,
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
      };
      assertPaneLayoutRootWithinBounds(saved.root);
      layouts[input.environmentId] = saved;
      await this.saveJson(this.paneLayoutsFile(), layouts, { backup: false });
      this.announce("pane-layout", input.environmentId);
      return saved;
    });
  }

  /**
   * Publish the native surface for a backend-owned environment launch.
   *
   * The pane is published before provider startup and updated with provider
   * identity later. The launch intent is not consumed until both have
   * converged. That keeps a renderer which was unmounted during setup from
   * being the only process capable of creating the tab. `existingOnly` is used
   * at startup to repair the historical Cursor/Grok bug without resurrecting a
   * tab the user deliberately closed, and `upgradeOnly` keeps that repair off a
   * tab that already holds the native identity.
   *
   * The existing tab is merged into, never replaced: it carries user state this
   * method does not own (`displayTitle`, `agentHandoffId`, the one-shot
   * `initial*` selections) plus `nativeAgentData.hostPort`, and a wholesale
   * rewrite silently discarded all of it on every backend start.
   *
   * Creating the tab selects it. Republishing does not, with one exception: the
   * publish that binds a provider session to a still-setup-focused tab is the
   * post-setup handoff — the same moment `ensureBuildPipelineTab` moves
   * selection onto the build surface. Every other republish leaves the
   * selection alone, because the renderer may be watching the setup terminal
   * and the reconcile sweep runs every two seconds for the whole launch.
   */
  async ensureStartupNativeAgentTab(input: {
    environmentId: string;
    agent: BuildPipelineAgent;
    providerSessionId?: string;
    existingOnly?: boolean;
    upgradeOnly?: boolean;
  }): Promise<PersistedPaneLayout | null> {
    return this.enqueuePaneLayoutMutation(async () => {
      const environment = await this.getEnvironment(input.environmentId);
      if (!environment) throw new Error(`Environment not found: ${input.environmentId}`);
      const layouts = await this.loadJson<Record<string, PersistedPaneLayout>>(
        this.paneLayoutsFile(),
        () => ({}),
      );
      const previous = layouts[input.environmentId];
      if (input.existingOnly && !previous) return null;

      const root = previous
        ? (JSON.parse(JSON.stringify(previous.root)) as unknown)
        : {
            kind: "leaf",
            id: "default",
            tabs: [{ id: "default", type: "plain", isSetupTab: true }],
            activeTabId: "default",
          };
      type Leaf = {
        kind: "leaf";
        id: string;
        tabs: Array<Record<string, unknown>>;
        activeTabId: string | null;
      };
      const leaves: Leaf[] = [];
      const visit = (node: unknown): void => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return;
        const record = node as Record<string, unknown>;
        if (record.kind === "leaf" && typeof record.id === "string" && Array.isArray(record.tabs)) {
          leaves.push(record as unknown as Leaf);
          return;
        }
        if (record.kind === "split" && Array.isArray(record.children)) {
          for (const child of record.children) visit(child);
        }
      };
      visit(root);
      if (leaves.length === 0) throw new Error("Persisted pane layout has no leaf pane");

      const existingLeaf = leaves.find((leaf) =>
        leaf.tabs.some((tab) => tab.id === "startup-agent"),
      );
      if (input.existingOnly && !existingLeaf) return null;
      const target =
        existingLeaf ?? leaves.find((leaf) => leaf.id === previous?.activePaneId) ?? leaves[0]!;
      const existingIndex = target.tabs.findIndex((tab) => tab.id === "startup-agent");
      const existingTab = existingIndex >= 0 ? target.tabs[existingIndex]! : undefined;
      if (input.upgradeOnly && existingTab?.type === "agent-native") return previous ?? null;

      const previousNativeAgentData =
        existingTab?.nativeAgentData &&
        typeof existingTab.nativeAgentData === "object" &&
        !Array.isArray(existingTab.nativeAgentData)
          ? (existingTab.nativeAgentData as Record<string, unknown>)
          : undefined;
      const nativeAgentData: Record<string, unknown> = {
        ...previousNativeAgentData,
        platform: input.agent,
        environmentId: input.environmentId,
      };
      if (environment.environmentType === "local") {
        nativeAgentData.isLocal = true;
        // A worktree environment has no container, so a stale id carried over
        // from a previous Docker incarnation must not survive the merge.
        delete nativeAgentData.containerId;
      } else {
        nativeAgentData.isLocal = false;
        if (environment.containerId) nativeAgentData.containerId = environment.containerId;
        else delete nativeAgentData.containerId;
      }
      if (input.providerSessionId) nativeAgentData.sessionId = input.providerSessionId;

      const tab: Record<string, unknown> = {
        ...existingTab,
        id: "startup-agent",
        type: "agent-native",
        nativeAgentData,
      };
      // The tab is definitively a native agent surface now, so payloads that
      // belong to the other tab kinds cannot apply. Everything else the tab
      // carried is user state and is preserved by the spread above.
      for (const foreign of [
        "fileData",
        "claudeTmuxData",
        "buildTabData",
        "loopedReviewTabData",
        "multiReviewTabData",
        "browserData",
        "initialCommands",
      ])
        delete tab[foreign];
      if (existingIndex >= 0) target.tabs[existingIndex] = tab;
      else target.tabs.push(tab);

      // The handoff is driven by the publish that first binds a provider session
      // to the tab, never by "setup is ready" on its own. Readiness stays true
      // for the life of the environment and `isSetupTab` is never cleared, so a
      // state-only condition would re-steal the selection on every two-second
      // reconcile sweep — and every ten-second launch retry — for as long as the
      // launch stays pending. Binding a session id happens once per launch, and
      // the launch intent is consumed immediately afterwards.
      const previousProviderSessionId =
        typeof previousNativeAgentData?.sessionId === "string"
          ? previousNativeAgentData.sessionId
          : undefined;
      const bindsNewProviderSession =
        input.providerSessionId !== undefined &&
        previousProviderSessionId !== input.providerSessionId;
      // Resolved from the same leaf list as `target` so both reads see one
      // parse of one tree, and a hit can be compared by reference.
      const focusedLeaf = previous
        ? leaves.find((leaf) => leaf.id === previous.activePaneId)
        : undefined;
      const shouldActivateStartupAgent =
        !input.existingOnly &&
        (existingIndex < 0 ||
          (bindsNewProviderSession &&
            environmentIsReadyForSetupHandoff(environment) &&
            // Both panes must consent: the startup agent's own pane is the one
            // whose selection changes, and the focused pane is where the user is
            // actually looking. Either one holding a deliberately chosen tab
            // means this is no longer a setup handoff.
            selectedTabIsSetupHandoffSource(target) &&
            (focusedLeaf === target || selectedTabIsSetupHandoffSource(focusedLeaf))));
      if (shouldActivateStartupAgent) target.activeTabId = "startup-agent";

      // Pane focus follows the tab handoff and nothing else. Unconditionally
      // pointing it at the startup agent's pane moved the user's focus to that
      // pane on every republish, and — because a mismatch also defeated the
      // `unchanged` check below — did it on every sweep in a split layout.
      const nextActivePaneId =
        !previous || shouldActivateStartupAgent ? target.id : previous.activePaneId;

      const unchanged =
        previous &&
        previous.activePaneId === nextActivePaneId &&
        JSON.stringify(previous.root) === JSON.stringify(root);
      if (unchanged) return previous;

      const saved: PersistedPaneLayout = {
        version: PANE_LAYOUT_VERSION,
        environmentId: input.environmentId,
        containerId: environment.containerId,
        activePaneId: nextActivePaneId,
        root,
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
      };
      assertPaneLayoutRootWithinBounds(saved.root);
      layouts[input.environmentId] = saved;
      await this.saveJson(this.paneLayoutsFile(), layouts, { backup: false });
      this.announce("pane-layout", input.environmentId);
      return saved;
    });
  }
}
