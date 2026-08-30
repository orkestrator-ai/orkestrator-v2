import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  aggregateAgentActivityState,
  AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS,
  AGENT_ACTIVITY_SOURCES,
  AGENT_ACTIVITY_STATES,
  FRONTEND_AGENT_ACTIVITY_LEASE_MS,
  isAgentActivityTimestamp,
  parseUsableAgentActivityTime,
} from "@orkestrator/protocol/agent-activity";
import {
  AGENT_INTERACTION_JOURNAL_VERSION,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  isAgentInteractionPolicy,
  isAgentInteractionResolutionJournal,
  pruneAgentInteractionResolutionJournal,
  type AgentInteractionOrigin,
  type AgentInteractionPolicy,
  type AgentInteractionResolutionJournal,
} from "@orkestrator/protocol/agent-interactions";
import {
  parseStoredDesktopConnections,
  type StoredDesktopConnections,
} from "@orkestrator/protocol/connections";
import {
  isFeaturePlanningRecord,
  isTerminalFeaturePlanningPhase,
  type FeaturePlanningRecord,
} from "@orkestrator/protocol/feature-planning";
import { parseClaudeTmuxStateKey } from "@orkestrator/protocol/tmux-prompt";
import {
  getReviewInstructionValidationError,
  parseReviewInstruction,
} from "@orkestrator/protocol/review-instruction";
import {
  LEGACY_ENABLED_AGENT_PLATFORMS,
  firstEnabledAgentPlatform,
  isAgentPlatform,
  normalizeAgentPlatforms,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import { isEmptyAgentSettings, type AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import {
  DEFAULT_AGENT_MESSAGING_SETTINGS,
  normalizeAgentMessagingSettings,
} from "@orkestrator/protocol/agent-mail";
import { DEFAULT_CLAUDE_MODE } from "@orkestrator/protocol/startup-launch";
import {
  DEFAULT_DEBUG_LOG_RETENTION_DAYS,
  normalizeDebugLogRetentionDays,
} from "@orkestrator/protocol/debug-logging";
import {
  LEGACY_GLOBAL_AGENT_KEYS,
  LEGACY_REPOSITORY_AGENT_KEYS,
  migrateGlobalAgentSettings,
  migrateRepositoryAgentSettings,
} from "./storage-agent-settings.js";
import {
  PANE_LAYOUT_VERSION,
  paneLayoutRevisionConflictMessage,
} from "@orkestrator/protocol/pane-layout";
import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import {
  isMultiReviewTerminalPhase,
  isMultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import {
  mergePersistedPaneLayouts,
  type PaneLayoutMergeInput,
  type PaneLayoutSelectionIntent,
} from "@orkestrator/protocol/pane-layout-merge";
import { isTabTeardownKind } from "@orkestrator/protocol/tab-teardown";
import {
  RESOURCE_MANIFEST_KINDS,
  type ConditionalResourceSnapshot,
  type ResourceChange,
  type ResourceKind,
  type ResourceManifestKind,
  type ResourceRevisionManifest,
  type ResourceRevisionMap,
  type ResourceSnapshotRevision,
} from "@orkestrator/protocol/resource-events";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import {
  DEFAULT_OPENCODE_MODEL_PROVIDERS,
  migrateOpenCodeModelProviders,
  normalizeOpenCodeModelProviders,
} from "@orkestrator/protocol/native-agent";
import {
  DEFAULT_OPENCODE_MODEL_ID,
  normalizeOpenCodeRepositoryDefaults,
  selectableOpenCodeDefaultModel,
  storedOpenCodeModelIds,
} from "./storage-opencode-models.js";
import {
  DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
  isValidCodexMaxConcurrentThreads,
  MAX_CODEX_CONCURRENT_THREADS,
  resolveCodexMaxConcurrentThreads,
} from "./constants.js";
import { NATIVE_AGENT_SESSION_VERSION } from "./models.js";
import type {
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
  PersistedNativeAgentPendingSteer,
  PersistedComposeDraft,
  PersistedFileDraft,
  PersistedPromptQueue,
  PersistedAgentHandoff,
  RepositoryConfig,
  Session,
  SessionType,
} from "./models.js";

export type JsonRecord = Record<string, unknown>;

export const MAX_FRONTEND_AGENT_ACTIVITY_OBSERVERS = 32;
export const MAX_PANE_LAYOUT_ROOT_BYTES = 256 * 1024;
export const MAX_PANE_LAYOUT_SELECTION_INTENT_BYTES = 64 * 1024;
export const MAX_PANE_LAYOUT_SELECTION_ENTRIES = 1_024;
export const PROMPT_QUEUE_CLAIM_LEASE_MS = 5 * 60 * 1000;
export const MAX_PROMPT_QUEUE_SOURCE_KEY_BYTES = 4 * 1024;
export const MAX_PROMPT_QUEUE_SOURCE_MESSAGE_ID_BYTES = 1024;

export type KanbanComment = {
  id: string;
  text: string;
  createdAt: string;
};

export type KanbanImage = {
  id: string;
  filename: string;
  createdAt: string;
};

export type KanbanStatus = "backlog" | "in-progress" | "review" | "done";

export function assertPaneLayoutRootWithinBounds(root: unknown): void {
  let serializedRoot: string | undefined;
  try {
    serializedRoot = JSON.stringify(root);
  } catch {
    throw new Error("Pane layout root must be JSON serializable");
  }
  if (serializedRoot === undefined) {
    throw new Error("Pane layout root must be JSON serializable");
  }
  if (Buffer.byteLength(serializedRoot, "utf8") > MAX_PANE_LAYOUT_ROOT_BYTES) {
    throw new Error("Pane layout root exceeds the 256 KB limit");
  }
}

export function assertPaneLayoutSelectionIntentWithinBounds(
  selectionIntent: PaneLayoutSelectionIntent | undefined,
): void {
  if (!selectionIntent) return;
  const entries = Object.entries(selectionIntent.activeTabIds ?? {});
  if (entries.length > MAX_PANE_LAYOUT_SELECTION_ENTRIES) {
    throw new Error("Pane layout selection intent exceeds the 1024 entry limit");
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(selectionIntent);
  } catch {
    throw new Error("Pane layout selection intent must be JSON serializable");
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > MAX_PANE_LAYOUT_SELECTION_INTENT_BYTES
  ) {
    throw new Error("Pane layout selection intent exceeds the 64 KB limit");
  }
}

/**
 * Refuses a renderer-supplied layout that belongs to a dead container.
 *
 * A local environment has no container, so its layouts always carry `null`;
 * everything else must name the container the environment is running now.
 */
export function assertPaneLayoutGeneration(
  environment: Environment,
  containerId: string | null,
  source: "write" | "intent",
): void {
  const currentContainerId =
    environment.environmentType === "local" ? null : environment.containerId;
  if (containerId !== currentContainerId) {
    throw new Error(
      `Pane layout ${source} targets stale environment generation: expected ${currentContainerId ?? "local"}, received ${containerId ?? "local"}`,
    );
  }
}

export type MutablePaneLayoutLeaf = {
  kind: "leaf";
  id: string;
  tabs: Array<Record<string, unknown>>;
  activeTabId: string | null;
};

export function paneLayoutLeaves(root: unknown): MutablePaneLayoutLeaf[] {
  const leaves: MutablePaneLayoutLeaf[] = [];
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    if (
      node.kind === "leaf" &&
      typeof node.id === "string" &&
      Array.isArray(node.tabs) &&
      node.tabs.every(isRecord) &&
      (node.activeTabId === null || typeof node.activeTabId === "string")
    ) {
      leaves.push(node as MutablePaneLayoutLeaf);
      return;
    }
    if (node.kind === "split" && Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  };
  visit(root);
  return leaves;
}

export function environmentIsReadyForSetupHandoff(environment: Environment): boolean {
  return (
    environment.setupPhase === "ready" ||
    environment.setupScriptsComplete === true ||
    environment.setupOverride === true
  );
}

/**
 * True when this leaf is still showing the setup terminal (or has no valid
 * selection). A user who already clicked a non-setup tab is left alone.
 *
 * A pane that cannot be resolved fails closed. The alternative — treating an
 * unknown pane as "still on setup" — silently re-activates the startup tab for
 * any layout shape this predicate cannot read, which is the one direction that
 * takes the selection away from the user.
 */
export function selectedTabIsSetupHandoffSource(
  leaf: { tabs: Array<Record<string, unknown>>; activeTabId: string | null } | undefined,
): boolean {
  if (!leaf) return false;
  const selected = leaf.tabs.find((tab) => tab.id === leaf.activeTabId);
  return !selected || selected.isSetupTab === true;
}

/**
 * Keeps a completed setup handoff focused on the surface that follows setup.
 *
 * The renderer adds and selects its setup tab in one optimistic mutation. A
 * very short setup can finish before that mutation reaches the backend, after
 * which the pipeline selects the build tab. Letting the stale mutation rebase
 * normally would add the obsolete setup tab and let its explicit focus intent
 * override the newer backend-owned build selection.
 *
 * A longer setup has a second version of the same race: the setup tab is already
 * durable, but a selection write based on that pre-handoff layout is still in
 * flight when the build or startup-agent tab becomes authoritative. In that
 * case the merge base still has setup selected. Preserve the newer post-setup
 * target until a client has observed it; a later deliberate click on setup is
 * based on the post-handoff layout and remains allowed.
 */
export function suppressLateSetupTabAdditions(
  layout: PaneLayoutMergeInput,
  previous: PersistedPaneLayout | undefined,
  base: PaneLayoutMergeInput,
): PaneLayoutMergeInput {
  const previousLeaves = paneLayoutLeaves(previous?.root);
  const baseLeavesById = new Map(paneLayoutLeaves(base.root).map((leaf) => [leaf.id, leaf]));
  const durableSetupTabIds = new Set(
    previousLeaves.flatMap((leaf) =>
      leaf.tabs.flatMap((tab) =>
        tab.isSetupTab === true && typeof tab.id === "string" ? [tab.id] : [],
      ),
    ),
  );
  const root = JSON.parse(JSON.stringify(layout.root)) as PaneLayoutMergeInput["root"];
  const nextLeaves = paneLayoutLeaves(root);
  const previousLeavesById = new Map(previousLeaves.map((leaf) => [leaf.id, leaf]));
  const previousTabsById = new Map(
    previousLeaves.flatMap((leaf) =>
      leaf.tabs.flatMap((tab) => (typeof tab.id === "string" ? [[tab.id, tab] as const] : [])),
    ),
  );
  let changed = false;
  let removedGlobalFocus = false;

  for (const leaf of nextLeaves) {
    const removedIds = new Set(
      leaf.tabs.flatMap((tab) =>
        tab.isSetupTab === true && typeof tab.id === "string" && !durableSetupTabIds.has(tab.id)
          ? [tab.id]
          : [],
      ),
    );
    if (removedIds.size === 0) continue;
    changed = true;
    const removedActiveTab = leaf.activeTabId !== null && removedIds.has(leaf.activeTabId);
    leaf.tabs = leaf.tabs.flatMap((tab) => {
      if (typeof tab.id !== "string" || !removedIds.has(tab.id)) return [tab];
      const previousTab = previousTabsById.get(tab.id);
      return previousTab
        ? [JSON.parse(JSON.stringify(previousTab)) as Record<string, unknown>]
        : [];
    });
    if (!removedActiveTab) continue;

    removedGlobalFocus ||= layout.activePaneId === leaf.id;
    const remainingIds = new Set(
      leaf.tabs.flatMap((tab) => (typeof tab.id === "string" ? [tab.id] : [])),
    );
    const previousActiveTabId = previousLeavesById.get(leaf.id)?.activeTabId;
    const buildTabId = leaf.tabs.find(
      (tab) => tab.type === "claude-build" && typeof tab.id === "string",
    )?.id;
    const firstTabId = leaf.tabs.find((tab) => typeof tab.id === "string")?.id;
    leaf.activeTabId =
      previousActiveTabId && remainingIds.has(previousActiveTabId)
        ? previousActiveTabId
        : typeof buildTabId === "string"
          ? buildTabId
          : typeof firstTabId === "string"
            ? firstTabId
            : null;
  }

  const nextLeavesById = new Map(nextLeaves.map((leaf) => [leaf.id, leaf]));
  for (const previousLeaf of previousLeaves) {
    const nextLeaf = nextLeavesById.get(previousLeaf.id);
    const baseLeaf = baseLeavesById.get(previousLeaf.id);
    if (!nextLeaf || !baseLeaf || !nextLeaf.activeTabId) continue;
    const selected = nextLeaf.tabs.find((tab) => tab.id === nextLeaf.activeTabId);
    if (selected?.isSetupTab !== true) continue;
    if (baseLeaf.activeTabId !== nextLeaf.activeTabId) continue;
    if (!previousLeaf.activeTabId || previousLeaf.activeTabId === nextLeaf.activeTabId) {
      continue;
    }
    const handoffTarget = nextLeaf.tabs.find(
      (tab) => tab.id === previousLeaf.activeTabId && tab.isSetupTab !== true,
    );
    if (!handoffTarget) continue;
    nextLeaf.activeTabId = previousLeaf.activeTabId;
    changed = true;
    removedGlobalFocus ||= layout.activePaneId === nextLeaf.id;
  }

  if (!changed) return layout;
  const remainingPaneIds = new Set(nextLeaves.map((leaf) => leaf.id));
  return {
    ...layout,
    root,
    activePaneId:
      removedGlobalFocus && previous && remainingPaneIds.has(previous.activePaneId)
        ? previous.activePaneId
        : layout.activePaneId,
  };
}

export type KanbanTask = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  status: KanbanStatus;
  comments: KanbanComment[];
  images: KanbanImage[];
  createdAt: string;
  order: number;
  environmentId?: string;
  buildPipelineId?: string;
  /** Canonical immutable input owned by create_feature_build idempotency. */
  featureBuildRequestHash?: string;
  prUrl?: string;
  prState?: PrState;
  prMergeCommented?: boolean;
};

export type ProjectNotes = {
  projectId: string;
  content: string;
  updatedAt: string;
};

export type FeaturePlanStatus = "collecting" | "confirming" | "stories" | "building" | "built";

export type FeaturePlanMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  modelId?: string;
  stateApplication?: "pending" | "applied" | "superseded";
};

export type FeatureStoryCard = {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  messages: FeaturePlanMessage[];
  createdAt: string;
  updatedAt: string;
};

export type FeaturePlan = {
  id: string;
  projectId: string;
  title: string;
  status: FeaturePlanStatus;
  summary: string;
  messages: FeaturePlanMessage[];
  stories: FeatureStoryCard[];
  createdAt: string;
  updatedAt: string;
  order: number;
  codexEnvironmentId?: string;
  codexSessionId?: string;
  buildTaskId?: string;
  buildPipelineId?: string;
  /**
   * The backend-owned planning exchange currently attached to this plan.
   *
   * Stored inline rather than in its own collection so that applying a reply
   * and clearing the record are one atomic write, and so the record rides the
   * existing `feature-plan` resource-change channel with no second sync path.
   */
  planning?: FeaturePlanningRecord;
};

export type LinearAuth = {
  apiKey: string;
  connectedAt: string;
  viewer?: {
    id: string;
    name: string;
    email?: string;
  };
};

export type LinearCompletionComment = {
  pipelineId: string;
  issueId: string;
  status: "posted" | "failed";
  commentId?: string;
  postedAt?: string;
  error?: string;
  updatedAt: string;
};

export type GitHubCompletionComment = {
  pipelineId: string;
  repositoryOwner: string;
  repositoryName: string;
  issueNumber: number;
  status: "posted" | "failed";
  commentId?: string;
  postedAt?: string;
  error?: string;
  updatedAt: string;
};

export async function resizeKanbanImage(rawBytes: Buffer): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(rawBytes)
    .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
    .webp()
    .toBuffer();
}

export const MAX_JSON_BACKUPS = 5;
export const MAX_PERSISTED_NATIVE_AGENT_PENDING_DISPATCH_BYTES = 32 * 1024 * 1024;
// Worst-case JSON escaping for a 64 KiB instruction plus bounded ids and fields.
export const MAX_PERSISTED_NATIVE_AGENT_PENDING_STEER_BYTES = 400 * 1024;
export const MAX_SESSIONS_PER_ENVIRONMENT = 20;

export const DEFAULT_ALLOWED_DOMAINS = [
  "github.com",
  "api.github.com",
  "registry.npmjs.org",
  "bun.sh",
  "api.anthropic.com",
  "sentry.io",
  "statsig.anthropic.com",
  "statsig.com",
  "marketplace.visualstudio.com",
  "vscode.blob.core.windows.net",
  "update.code.visualstudio.com",
  "mcp.context7.com",
  // Playwright browser downloads. The image ships its own pinned Chromium, so
  // this only matters when a project pins a different Playwright version.
  "cdn.playwright.dev",
];

export function nowIso(): string {
  return new Date().toISOString();
}

export function defaultEnvironmentName(): string {
  const iso = nowIso();
  return [
    iso.slice(0, 4),
    iso.slice(5, 7),
    iso.slice(8, 10),
    "-",
    iso.slice(11, 13),
    iso.slice(14, 16),
    iso.slice(17, 19),
  ].join("");
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isInitialPromptImageAttachment(
  value: unknown,
): value is NonNullable<Environment["initialPromptAttachments"]>[number] {
  return (
    isRecord(value) &&
    isNonBlankString(value.id) &&
    isNonBlankString(value.name) &&
    (value.type === undefined || value.type === "image" || value.type === "file") &&
    (value.previewUrl === undefined || typeof value.previewUrl === "string") &&
    isNonBlankString(value.base64Data)
  );
}

export function isStartupAgentSession(
  value: unknown,
): value is NonNullable<Environment["startupAgentSession"]> {
  return (
    isRecord(value) &&
    value.tabId === "startup-agent" &&
    isAgentPlatform(value.agent) &&
    isOneOf(value.style, ["terminal", "native"]) &&
    isOneOf(value.status, ["starting", "running", "error"]) &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.reasoningEffort === undefined || typeof value.reasoningEffort === "string") &&
    (value.providerSessionId === undefined || isNonBlankString(value.providerSessionId)) &&
    (value.startedAt === undefined ||
      (typeof value.startedAt === "string" && Number.isFinite(Date.parse(value.startedAt)))) &&
    (value.error === undefined || typeof value.error === "string")
  );
}

export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

export function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Read back the persisted per-source snapshots, discarding any whose state or
 * timestamp no longer parses. A poisoned entry must not be able to pin the
 * aggregate, and dropping it here means every writer sees the same clean view.
 */
export function readAgentActivitySources(
  environment: Environment,
  referenceTime: number,
): NonNullable<Environment["agentActivitySources"]> {
  const sources: NonNullable<Environment["agentActivitySources"]> = {};
  for (const candidateSource of AGENT_ACTIVITY_SOURCES) {
    const snapshot = environment.agentActivitySources?.[candidateSource];
    if (!snapshot || !isOneOf(snapshot.state, AGENT_ACTIVITY_STATES)) continue;
    const snapshotTime = parseUsableAgentActivityTime(snapshot.updatedAt, referenceTime);
    if (!Number.isFinite(snapshotTime)) continue;
    sources[candidateSource] = {
      state: snapshot.state,
      updatedAt: new Date(snapshotTime).toISOString(),
      ...(snapshot.stale === true ? { stale: true } : {}),
    };
  }
  return sources;
}

export function frontendAgentActivityObserverKey(observerId: string): string {
  return createHash("sha256").update(observerId).digest("hex");
}

/**
 * A stable digest of the parts of an environment's activity snapshot that
 * clients render: the aggregate state plus each source's and observer's state.
 * Timestamps and lease expiries are deliberately excluded — a write that only
 * refreshes them (a lease renewal) changes nothing any client displays, so it
 * does not need to be announced. Keys are sorted so map iteration order cannot
 * fake a difference.
 */
export function agentActivityStructureFingerprint(environment: Environment): string {
  const states = (
    record: Partial<Record<string, { state?: unknown } | undefined>> | undefined,
  ): Array<[string, unknown]> =>
    Object.entries(record ?? {})
      .map(([key, snapshot]): [string, unknown] => [
        key,
        snapshot
          ? [snapshot.state, "stale" in snapshot ? snapshot.stale === true : false]
          : undefined,
      ])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({
    state: environment.agentActivityState ?? null,
    sources: states(environment.agentActivitySources),
    observers: states(environment.frontendAgentActivityObservers),
  });
}

export function readFrontendAgentActivityObservers(
  environment: Environment,
  referenceTime: number,
): NonNullable<Environment["frontendAgentActivityObservers"]> {
  const observers: NonNullable<Environment["frontendAgentActivityObservers"]> = {};
  const stored = environment.frontendAgentActivityObservers;
  if (!isRecord(stored)) return observers;

  for (const [observerKey, candidate] of Object.entries(stored)) {
    if (!isRecord(candidate)) continue;
    if (!isOneOf(candidate.state, AGENT_ACTIVITY_STATES)) continue;
    const updatedTime = parseUsableAgentActivityTime(candidate.updatedAt, referenceTime);
    const leaseExpiresAt = candidate.leaseExpiresAt;
    if (
      !Number.isFinite(updatedTime) ||
      !isAgentActivityTimestamp(leaseExpiresAt) ||
      Date.parse(leaseExpiresAt) <= referenceTime
    ) {
      continue;
    }
    observers[observerKey] = {
      state: candidate.state,
      updatedAt: new Date(updatedTime).toISOString(),
      leaseExpiresAt: new Date(Date.parse(leaseExpiresAt)).toISOString(),
    };
  }
  return observers;
}

export function aggregateEnvironmentAgentActivity(
  sources: NonNullable<Environment["agentActivitySources"]>,
  observers: NonNullable<Environment["frontendAgentActivityObservers"]>,
): AgentActivityState {
  return aggregateAgentActivityState({ ...sources, ...observers });
}

export function nextAgentActivityTimestamp(
  previousValue: unknown,
  referenceTime = Date.now(),
): string {
  const previousTime = parseUsableAgentActivityTime(previousValue, referenceTime);
  return new Date(
    Math.max(
      referenceTime,
      Number.isFinite(previousTime) ? previousTime + 1 : Number.NEGATIVE_INFINITY,
    ),
  ).toISOString();
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isCanonicalUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

export function isPortNumber(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 65_535;
}

export function isPortMapping(value: unknown): value is PortMapping {
  return (
    isRecord(value) &&
    isPortNumber(value.containerPort) &&
    isPortNumber(value.hostPort) &&
    (value.protocol === "tcp" || value.protocol === "udp")
  );
}

export function isPersistedLoopedReviewWorkflow(
  value: unknown,
  expectedId?: string,
): value is PersistedLoopedReviewWorkflow {
  return (
    isRecord(value) &&
    isPositiveInteger(value.version) &&
    isNonBlankString(value.id) &&
    (expectedId === undefined || value.id === expectedId) &&
    isNonBlankString(value.environmentId) &&
    isRecord(value.snapshot) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    isPositiveInteger(value.revision) &&
    (value.controllerLease === undefined ||
      (isRecord(value.controllerLease) &&
        isNonBlankString(value.controllerLease.ownerId) &&
        (value.controllerLease.token === undefined ||
          isNonBlankString(value.controllerLease.token)) &&
        typeof value.controllerLease.expiresAt === "string" &&
        Number.isFinite(Date.parse(value.controllerLease.expiresAt))))
  );
}

export function isPersistedMultiReviewWorkflow(
  value: unknown,
  expectedId?: string,
): value is PersistedMultiReviewWorkflow {
  return (
    isRecord(value) &&
    isPositiveInteger(value.version) &&
    isNonBlankString(value.id) &&
    (expectedId === undefined || value.id === expectedId) &&
    isNonBlankString(value.environmentId) &&
    isRecord(value.snapshot) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    isPositiveInteger(value.revision) &&
    (value.controllerLease === undefined ||
      (isRecord(value.controllerLease) &&
        isNonBlankString(value.controllerLease.ownerId) &&
        isNonBlankString(value.controllerLease.token) &&
        typeof value.controllerLease.expiresAt === "string" &&
        Number.isFinite(Date.parse(value.controllerLease.expiresAt))))
  );
}

export function isPersistedPromptQueueClaim(
  value: unknown,
): value is NonNullable<PersistedPromptQueue["outstandingClaim"]> {
  return (
    isRecord(value) &&
    isNonBlankString(value.token) &&
    Object.hasOwn(value, "message") &&
    typeof value.claimedAt === "string" &&
    Number.isFinite(Date.parse(value.claimedAt)) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt))
  );
}

export function isPersistedPromptQueue(
  value: unknown,
  expectedKey?: string,
): value is PersistedPromptQueue {
  return (
    isRecord(value) &&
    isNonBlankString(value.queueKey) &&
    (expectedKey === undefined || value.queueKey === expectedKey) &&
    isNonBlankString(value.environmentId) &&
    promptQueueKeyMatchesEnvironment(value.queueKey, value.environmentId) &&
    Array.isArray(value.messages) &&
    (value.inFlight === undefined ||
      (isRecord(value.inFlight) &&
        Object.hasOwn(value.inFlight, "message") &&
        isNonBlankString(value.inFlight.requestId) &&
        typeof value.inFlight.reservedAt === "string" &&
        Number.isFinite(Date.parse(value.inFlight.reservedAt)) &&
        (value.inFlight.submittingAt === undefined ||
          (typeof value.inFlight.submittingAt === "string" &&
            Number.isFinite(Date.parse(value.inFlight.submittingAt)))) &&
        (value.inFlight.submittedAt === undefined ||
          (typeof value.inFlight.submittedAt === "string" &&
            Number.isFinite(Date.parse(value.inFlight.submittedAt)) &&
            typeof value.inFlight.submittingAt === "string" &&
            Date.parse(value.inFlight.submittedAt) >= Date.parse(value.inFlight.submittingAt))))) &&
    (value.dispatchError === undefined ||
      (isRecord(value.dispatchError) &&
        isNonBlankString(value.dispatchError.requestId) &&
        ((isNonBlankString(value.dispatchError.messageId) &&
          isNonBlankString(value.dispatchError.messageFingerprint) &&
          /^[a-f0-9]{64}$/.test(value.dispatchError.messageFingerprint)) ||
          (value.dispatchError.messageId === undefined &&
            value.dispatchError.messageFingerprint === undefined)) &&
        isNonBlankString(value.dispatchError.message) &&
        typeof value.dispatchError.failedAt === "string" &&
        Number.isFinite(Date.parse(value.dispatchError.failedAt)))) &&
    (value.outstandingClaim === undefined || isPersistedPromptQueueClaim(value.outstandingClaim)) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    isPositiveInteger(value.revision)
  );
}

export const CLAUDE_TMUX_QUEUE_PREFIX = "claude-tmux\0";

export function promptQueueKeyMatchesEnvironment(queueKey: string, environmentId: string): boolean {
  if (!queueKey.startsWith(CLAUDE_TMUX_QUEUE_PREFIX)) return true;
  const target = parseClaudeTmuxStateKey(queueKey.slice(CLAUDE_TMUX_QUEUE_PREFIX.length));
  return target?.environmentId === environmentId;
}

export function assertPromptQueueKeyOwner(queueKey: string, environmentId: string): void {
  if (!promptQueueKeyMatchesEnvironment(queueKey, environmentId)) {
    throw new Error("Prompt queue key does not match its environment owner");
  }
}

export function isPersistedNativeAgentSession(
  value: unknown,
  expectedKey?: string,
): value is PersistedNativeAgentSession {
  return (
    isRecord(value) &&
    value.version === NATIVE_AGENT_SESSION_VERSION &&
    isNonBlankString(value.key) &&
    (expectedKey === undefined || value.key === expectedKey) &&
    isNonBlankString(value.environmentId) &&
    isAgentPlatform(value.agent) &&
    isNonBlankString(value.logicalSessionKey) &&
    isNonBlankString(value.providerSessionId) &&
    (value.origin === "interactive-native" ||
      value.origin === "interactive-tmux" ||
      value.origin === "build-pipeline" ||
      value.origin === "looped-review") &&
    isAgentInteractionPolicy(value.interactionPolicy) &&
    (value.controls === undefined ||
      (isRecord(value.controls) &&
        Object.keys(value.controls).every(
          (key) =>
            key === "modelId" ||
            key === "reasoningId" ||
            key === "fastMode" ||
            key === "mode" ||
            key === "executionProfileId" ||
            key === "includeLocalSettings" ||
            key === "promptSuggestions",
        ) &&
        (value.controls.modelId === undefined || isNonBlankString(value.controls.modelId)) &&
        (value.controls.reasoningId === undefined ||
          isNonBlankString(value.controls.reasoningId)) &&
        (value.controls.fastMode === undefined || typeof value.controls.fastMode === "boolean") &&
        (value.controls.executionProfileId === undefined ||
          value.controls.executionProfileId === null ||
          isNonBlankString(value.controls.executionProfileId)) &&
        (value.controls.includeLocalSettings === undefined ||
          typeof value.controls.includeLocalSettings === "boolean") &&
        (value.controls.promptSuggestions === undefined ||
          typeof value.controls.promptSuggestions === "boolean") &&
        (value.controls.mode === undefined ||
          value.controls.mode === "build" ||
          value.controls.mode === "plan"))) &&
    (value.dispatchedRequestIds === undefined ||
      (Array.isArray(value.dispatchedRequestIds) &&
        value.dispatchedRequestIds.length <= 1_000 &&
        value.dispatchedRequestIds.every(isNonBlankString))) &&
    (value.pendingDispatch === undefined ||
      (isRecord(value.pendingDispatch) &&
        isNonBlankString(value.pendingDispatch.requestId) &&
        isNonBlankString(value.pendingDispatch.prompt) &&
        typeof value.pendingDispatch.createdAt === "string" &&
        Number.isFinite(Date.parse(value.pendingDispatch.createdAt)) &&
        (value.pendingDispatch.model === undefined ||
          isNonBlankString(value.pendingDispatch.model)) &&
        (value.pendingDispatch.reasoningEffort === undefined ||
          isNonBlankString(value.pendingDispatch.reasoningEffort)) &&
        (value.pendingDispatch.mode === undefined ||
          value.pendingDispatch.mode === "plan" ||
          value.pendingDispatch.mode === "build") &&
        (value.pendingDispatch.fastMode === undefined ||
          typeof value.pendingDispatch.fastMode === "boolean") &&
        (value.pendingDispatch.subAgent === undefined ||
          isNonBlankString(value.pendingDispatch.subAgent)) &&
        (value.pendingDispatch.executionAgent === undefined ||
          isNonBlankString(value.pendingDispatch.executionAgent)) &&
        (value.pendingDispatch.includeLocalSettings === undefined ||
          typeof value.pendingDispatch.includeLocalSettings === "boolean") &&
        (value.pendingDispatch.promptSuggestions === undefined ||
          typeof value.pendingDispatch.promptSuggestions === "boolean") &&
        (value.pendingDispatch.schema === undefined || isRecord(value.pendingDispatch.schema)) &&
        (value.pendingDispatch.images === undefined ||
          (Array.isArray(value.pendingDispatch.images) &&
            value.pendingDispatch.images.length <= 64 &&
            value.pendingDispatch.images.every(
              (image) =>
                isRecord(image) && isNonBlankString(image.filename) && isNonBlankString(image.data),
            ))) &&
        (value.pendingDispatch.attachments === undefined ||
          (Array.isArray(value.pendingDispatch.attachments) &&
            value.pendingDispatch.attachments.length <= 64 &&
            value.pendingDispatch.attachments.every(
              (attachment) =>
                isRecord(attachment) &&
                (attachment.type === "image" || attachment.type === "file") &&
                isNonBlankString(attachment.path) &&
                (attachment.dataUrl === undefined || typeof attachment.dataUrl === "string") &&
                (attachment.filename === undefined || typeof attachment.filename === "string"),
            ))) &&
        (() => {
          try {
            return (
              Buffer.byteLength(JSON.stringify(value.pendingDispatch), "utf8") <=
              MAX_PERSISTED_NATIVE_AGENT_PENDING_DISPATCH_BYTES
            );
          } catch {
            return false;
          }
        })())) &&
    (value.pendingSteer === undefined ||
      (isRecord(value.pendingSteer) &&
        isNonBlankString(value.pendingSteer.requestId) &&
        Buffer.byteLength(value.pendingSteer.requestId, "utf8") <= 512 &&
        isNonBlankString(value.pendingSteer.text) &&
        Buffer.byteLength(value.pendingSteer.text, "utf8") <= 64 * 1024 &&
        isNonBlankString(value.pendingSteer.inputDigest) &&
        /^[a-f0-9]{64}$/.test(value.pendingSteer.inputDigest) &&
        isNonBlankString(value.pendingSteer.expectedRunId) &&
        Buffer.byteLength(value.pendingSteer.expectedRunId, "utf8") <= 512 &&
        (value.pendingSteer.state === "prepared" || value.pendingSteer.state === "unknown") &&
        typeof value.pendingSteer.createdAt === "string" &&
        Number.isFinite(Date.parse(value.pendingSteer.createdAt)) &&
        (() => {
          try {
            return (
              Buffer.byteLength(JSON.stringify(value.pendingSteer), "utf8") <=
              MAX_PERSISTED_NATIVE_AGENT_PENDING_STEER_BYTES
            );
          } catch {
            return false;
          }
        })())) &&
    (value.openCodeIncompleteTurnNotice === undefined ||
      (isRecord(value.openCodeIncompleteTurnNotice) &&
        (value.openCodeIncompleteTurnNotice.kind === "failed" ||
          value.openCodeIncompleteTurnNotice.kind === "exhausted") &&
        isNonBlankString(value.openCodeIncompleteTurnNotice.assistantMessageId) &&
        typeof value.openCodeIncompleteTurnNotice.updatedAt === "string" &&
        Number.isFinite(Date.parse(value.openCodeIncompleteTurnNotice.updatedAt)))) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt))
  );
}

/** Restores pre-policy records without changing provider or dispatch identity. */
export function migratePersistedNativeAgentSession(
  value: unknown,
  expectedKey: string,
): PersistedNativeAgentSession | null {
  if (isPersistedNativeAgentSession(value, expectedKey)) return value;
  if (!isRecord(value)) return null;
  if (
    value.version !== undefined ||
    value.origin !== undefined ||
    value.interactionPolicy !== undefined
  ) {
    return null;
  }
  const legacyLoopedReview =
    typeof value.logicalSessionKey === "string" &&
    value.logicalSessionKey.startsWith("looped-review:");
  const migrated = {
    ...value,
    version: NATIVE_AGENT_SESSION_VERSION,
    origin: legacyLoopedReview ? "looped-review" : "interactive-native",
    interactionPolicy: legacyLoopedReview
      ? UNATTENDED_AGENT_INTERACTION_POLICY
      : INTERACTIVE_AGENT_INTERACTION_POLICY,
  };
  return isPersistedNativeAgentSession(migrated, expectedKey) ? migrated : null;
}

export interface LoadedNativeAgentSessions {
  /** Records this build can read, already migrated in memory. */
  sessions: Record<string, PersistedNativeAgentSession>;
  /** Records this build cannot read, preserved verbatim and never reused. */
  opaque: Record<string, unknown>;
  /** True when at least one readable record was upgraded and needs persisting. */
  migrated: boolean;
}

export function resolveNativeAgentInteractionMetadata(input: {
  origin?: AgentInteractionOrigin;
  interactionPolicy?: AgentInteractionPolicy;
}): Pick<PersistedNativeAgentSession, "origin" | "interactionPolicy"> | null {
  const origin = input.origin ?? "interactive-native";
  const interactionPolicy =
    input.interactionPolicy ??
    (origin === "build-pipeline" || origin === "looped-review"
      ? UNATTENDED_AGENT_INTERACTION_POLICY
      : INTERACTIVE_AGENT_INTERACTION_POLICY);
  if (
    !["interactive-native", "interactive-tmux", "build-pipeline", "looped-review"].includes(
      origin,
    ) ||
    !isAgentInteractionPolicy(interactionPolicy) ||
    (origin === "build-pipeline" || origin === "looped-review") !==
      (interactionPolicy.mode === "unattended")
  ) {
    return null;
  }
  return { origin, interactionPolicy };
}

export function isPersistedComposeDraft(
  value: unknown,
  expectedKey?: string,
): value is PersistedComposeDraft {
  const source = isRecord(value) ? value.sourcePromptQueue : undefined;
  return (
    isRecord(value) &&
    isNonBlankString(value.draftKey) &&
    (expectedKey === undefined || value.draftKey === expectedKey) &&
    (value.ownerType === "environment" || value.ownerType === "project") &&
    isNonBlankString(value.ownerId) &&
    Object.hasOwn(value, "value") &&
    (source === undefined ||
      (isRecord(source) &&
        isNonBlankString(source.queueKey) &&
        Buffer.byteLength(source.queueKey, "utf8") <= MAX_PROMPT_QUEUE_SOURCE_KEY_BYTES &&
        isNonBlankString(source.messageId) &&
        Buffer.byteLength(source.messageId, "utf8") <= MAX_PROMPT_QUEUE_SOURCE_MESSAGE_ID_BYTES)) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    isPositiveInteger(value.revision)
  );
}

export function isPersistedFileDraft(
  value: unknown,
  expectedKey?: string,
): value is PersistedFileDraft {
  return (
    isRecord(value) &&
    isNonBlankString(value.draftKey) &&
    (expectedKey === undefined || value.draftKey === expectedKey) &&
    isNonBlankString(value.environmentId) &&
    isNonBlankString(value.filePath) &&
    typeof value.content === "string" &&
    typeof value.originalContent === "string" &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    isPositiveInteger(value.revision)
  );
}

export function isPersistedAgentHandoff(
  value: unknown,
  expectedId?: string,
): value is PersistedAgentHandoff {
  return (
    isRecord(value) &&
    isPositiveInteger(value.version) &&
    isNonBlankString(value.id) &&
    (expectedId === undefined || value.id === expectedId) &&
    isNonBlankString(value.environmentId) &&
    isRecord(value.snapshot) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt))
  );
}

export function isPersistedBuildPipeline(
  value: unknown,
  expectedId?: string,
): value is PersistedBuildPipeline {
  return (
    isRecord(value) &&
    isPositiveInteger(value.version) &&
    isNonBlankString(value.id) &&
    (expectedId === undefined || value.id === expectedId) &&
    isNonBlankString(value.projectId) &&
    // Blank until the pipeline's environment exists; see PersistedBuildPipeline.
    typeof value.environmentId === "string" &&
    isRecord(value.snapshot) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    isPositiveInteger(value.revision)
  );
}

export function activeGitHubBuildReservation(snapshot: unknown): string | null {
  if (!isRecord(snapshot)) return null;
  if (snapshot.phase === "complete" || snapshot.phase === "failed") return null;
  const source = snapshot.source;
  if (
    !isRecord(source) ||
    source.type !== "github" ||
    !isNonBlankString(source.repositoryOwner) ||
    !isNonBlankString(source.repositoryName) ||
    !isPositiveInteger(source.issueNumber)
  ) {
    return null;
  }
  return `${source.repositoryOwner.toLowerCase()}/${source.repositoryName.toLowerCase()}#${source.issueNumber}`;
}

export function activeBuildAdmissionKey(snapshot: unknown): string | null {
  if (!isRecord(snapshot)) return null;
  if (snapshot.phase === "complete" || snapshot.phase === "failed") return null;
  return isNonBlankString(snapshot.admissionKey) ? snapshot.admissionKey : null;
}

export function isClaudeModelCatalogSnapshot(
  value: unknown,
  environmentId: string,
): value is ClaudeModelCatalogSnapshot {
  if (
    !isRecord(value) ||
    value.environmentId !== environmentId ||
    !Array.isArray(value.models) ||
    !isOneOf(value.source, ["sdk", "last-known-good", "fallback"]) ||
    typeof value.fetchedAt !== "string" ||
    !Number.isFinite(Date.parse(value.fetchedAt)) ||
    typeof value.stale !== "boolean"
  ) {
    return false;
  }

  const effortLevels = ["low", "medium", "high", "xhigh", "max"] as const;
  return (
    value.models.every((model) => {
      if (!isRecord(model) || !isNonBlankString(model.id) || !isNonBlankString(model.name)) {
        return false;
      }
      const optionalStrings = ["resolvedModel", "description"] as const;
      if (
        optionalStrings.some(
          (field) => field in model && model[field] != null && typeof model[field] !== "string",
        )
      ) {
        return false;
      }
      const optionalBooleans = [
        "supportsFastMode",
        "supportsEffort",
        "supportsAdaptiveThinking",
        "supportsAutoMode",
      ] as const;
      if (
        optionalBooleans.some(
          (field) => field in model && model[field] != null && typeof model[field] !== "boolean",
        )
      ) {
        return false;
      }
      return (
        !("supportedEffortLevels" in model) ||
        model.supportedEffortLevels == null ||
        (Array.isArray(model.supportedEffortLevels) &&
          model.supportedEffortLevels.every((level) => isOneOf(level, effortLevels)))
      );
    }) &&
    (value.sdkVersion == null || typeof value.sdkVersion === "string") &&
    (value.cliVersion == null || typeof value.cliVersion === "string") &&
    (value.error == null || typeof value.error === "string")
  );
}

export const CODEX_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const satisfies readonly CodexReasoningEffort[];

export function normalizeClaudeModelCatalogEntries(value: unknown): ClaudeModelCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  const normalized: ClaudeModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const id = isNonBlankString(candidate.id) ? candidate.id.trim() : "";
    const name = isNonBlankString(candidate.name) ? candidate.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;

    const optionalStrings = ["resolvedModel", "description"] as const;
    if (
      optionalStrings.some(
        (field) =>
          field in candidate && candidate[field] != null && typeof candidate[field] !== "string",
      )
    ) {
      continue;
    }
    const optionalBooleans = [
      "supportsFastMode",
      "supportsEffort",
      "supportsAdaptiveThinking",
      "supportsAutoMode",
    ] as const;
    if (
      optionalBooleans.some(
        (field) =>
          field in candidate && candidate[field] != null && typeof candidate[field] !== "boolean",
      )
    ) {
      continue;
    }
    const supportedEffortLevels = candidate.supportedEffortLevels;
    if (
      supportedEffortLevels != null &&
      (!Array.isArray(supportedEffortLevels) ||
        !supportedEffortLevels.every((level) =>
          isOneOf(level, ["low", "medium", "high", "xhigh", "max"] as const),
        ))
    ) {
      continue;
    }

    seen.add(id);
    normalized.push({
      id,
      ...(isNonBlankString(candidate.resolvedModel)
        ? { resolvedModel: candidate.resolvedModel.trim() }
        : {}),
      name,
      ...(isNonBlankString(candidate.description)
        ? { description: candidate.description.trim() }
        : {}),
      ...(typeof candidate.supportsFastMode === "boolean"
        ? { supportsFastMode: candidate.supportsFastMode }
        : {}),
      ...(typeof candidate.supportsEffort === "boolean"
        ? { supportsEffort: candidate.supportsEffort }
        : {}),
      ...(Array.isArray(supportedEffortLevels)
        ? { supportedEffortLevels: [...supportedEffortLevels] }
        : {}),
      ...(typeof candidate.supportsAdaptiveThinking === "boolean"
        ? { supportsAdaptiveThinking: candidate.supportsAdaptiveThinking }
        : {}),
      ...(typeof candidate.supportsAutoMode === "boolean"
        ? { supportsAutoMode: candidate.supportsAutoMode }
        : {}),
    });
  }
  return normalized;
}

export function normalizeCodexModelCatalogEntries(value: unknown): CodexModelCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  const normalized: CodexModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const id = isNonBlankString(candidate.id) ? candidate.id.trim() : "";
    const name = isNonBlankString(candidate.name) ? candidate.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    if (
      "description" in candidate &&
      candidate.description != null &&
      typeof candidate.description !== "string"
    ) {
      continue;
    }

    const reasoningEfforts = Array.isArray(candidate.reasoningEfforts)
      ? candidate.reasoningEfforts.filter((effort): effort is CodexReasoningEffort =>
          isOneOf(effort, CODEX_REASONING_EFFORTS),
        )
      : undefined;
    if (
      candidate.reasoningEfforts != null &&
      (!Array.isArray(candidate.reasoningEfforts) ||
        reasoningEfforts!.length !== candidate.reasoningEfforts.length)
    ) {
      continue;
    }
    const defaultReasoningEffort =
      candidate.defaultReasoningEffort == null
        ? undefined
        : isOneOf(candidate.defaultReasoningEffort, CODEX_REASONING_EFFORTS)
          ? candidate.defaultReasoningEffort
          : null;
    if (defaultReasoningEffort === null) continue;

    let reasoningOptions: CodexModelCatalogEntry["reasoningOptions"];
    if (candidate.reasoningOptions != null) {
      if (!Array.isArray(candidate.reasoningOptions)) continue;
      reasoningOptions = [];
      let invalid = false;
      for (const option of candidate.reasoningOptions) {
        if (
          !isRecord(option) ||
          !isOneOf(option.effort, CODEX_REASONING_EFFORTS) ||
          !isNonBlankString(option.label) ||
          (option.description != null && typeof option.description !== "string")
        ) {
          invalid = true;
          break;
        }
        reasoningOptions.push({
          effort: option.effort,
          label: option.label.trim(),
          ...(isNonBlankString(option.description)
            ? { description: option.description.trim() }
            : {}),
        });
      }
      if (invalid) continue;
    }

    seen.add(id);
    normalized.push({
      id,
      name,
      ...(isNonBlankString(candidate.description)
        ? { description: candidate.description.trim() }
        : {}),
      ...(reasoningEfforts ? { reasoningEfforts: [...reasoningEfforts] } : {}),
      ...(reasoningOptions ? { reasoningOptions } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    });
  }
  return normalized;
}

export function normalizeAcpModelCatalogEntries(
  value: unknown,
  platform: "cursor" | "grok" | "pi",
): AgentModel[] {
  if (!Array.isArray(value)) return [];
  const normalized: AgentModel[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate) || candidate.platform !== platform) continue;
    const id = isNonBlankString(candidate.id) ? candidate.id.trim() : "";
    const label = isNonBlankString(candidate.label) ? candidate.label.trim() : "";
    if (!id || !label || seen.has(id)) continue;
    if (
      (candidate.providerLabel != null && typeof candidate.providerLabel !== "string") ||
      (candidate.description != null && typeof candidate.description !== "string") ||
      (candidate.defaultReasoningId != null && typeof candidate.defaultReasoningId !== "string") ||
      (candidate.supportsSpeed != null && typeof candidate.supportsSpeed !== "boolean") ||
      (candidate.supportsMode != null && typeof candidate.supportsMode !== "boolean") ||
      (candidate.contextWindow != null &&
        (typeof candidate.contextWindow !== "number" ||
          !Number.isSafeInteger(candidate.contextWindow) ||
          candidate.contextWindow <= 0)) ||
      (candidate.supportsImageInput != null && typeof candidate.supportsImageInput !== "boolean")
    ) {
      continue;
    }
    let reasoning: AgentModel["reasoning"];
    if (candidate.reasoning != null) {
      if (!Array.isArray(candidate.reasoning)) continue;
      reasoning = [];
      const reasoningIds = new Set<string>();
      let invalid = false;
      for (const option of candidate.reasoning) {
        if (!isRecord(option)) {
          invalid = true;
          break;
        }
        const optionId = isNonBlankString(option.id) ? option.id.trim() : "";
        const optionLabel = isNonBlankString(option.label) ? option.label.trim() : "";
        if (
          !optionId ||
          !optionLabel ||
          reasoningIds.has(optionId) ||
          (option.description != null && typeof option.description !== "string") ||
          (option.annotation != null && typeof option.annotation !== "string")
        ) {
          invalid = true;
          break;
        }
        reasoningIds.add(optionId);
        reasoning.push({
          id: optionId,
          label: optionLabel,
          ...(isNonBlankString(option.description)
            ? { description: option.description.trim() }
            : {}),
          ...(isNonBlankString(option.annotation) ? { annotation: option.annotation.trim() } : {}),
        });
      }
      if (invalid) continue;
    }

    seen.add(id);
    normalized.push({
      platform,
      id,
      label,
      ...(isNonBlankString(candidate.providerLabel)
        ? { providerLabel: candidate.providerLabel.trim() }
        : {}),
      ...(isNonBlankString(candidate.description)
        ? { description: candidate.description.trim() }
        : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(isNonBlankString(candidate.defaultReasoningId)
        ? { defaultReasoningId: candidate.defaultReasoningId.trim() }
        : {}),
      ...(typeof candidate.supportsSpeed === "boolean"
        ? { supportsSpeed: candidate.supportsSpeed }
        : {}),
      ...(typeof candidate.supportsMode === "boolean"
        ? { supportsMode: candidate.supportsMode }
        : {}),
      ...(typeof candidate.contextWindow === "number"
        ? { contextWindow: candidate.contextWindow }
        : {}),
      ...(typeof candidate.supportsImageInput === "boolean"
        ? { supportsImageInput: candidate.supportsImageInput }
        : {}),
    });
  }
  return normalized;
}

export function parsePersistedAgentModelCatalogCache(value: unknown): AgentModelCatalogCache {
  const empty: AgentModelCatalogCache = { schemaVersion: 1 };
  if (!isRecord(value) || value.schemaVersion !== 1) return empty;

  const parseCatalog = <T>(candidate: unknown, normalize: (models: unknown) => T[]) => {
    if (!isRecord(candidate)) return undefined;
    const models = normalize(candidate.models);
    if (models.length === 0) return undefined;
    const updatedAt =
      typeof candidate.updatedAt === "string" && Number.isFinite(Date.parse(candidate.updatedAt))
        ? candidate.updatedAt
        : new Date(0).toISOString();
    return { updatedAt, models };
  };

  const claude = parseCatalog(value.claude, normalizeClaudeModelCatalogEntries);
  const codex = parseCatalog(value.codex, normalizeCodexModelCatalogEntries);
  const cursor = parseCatalog(value.cursor, (models) =>
    normalizeAcpModelCatalogEntries(models, "cursor"),
  );
  const grok = parseCatalog(value.grok, (models) =>
    normalizeAcpModelCatalogEntries(models, "grok"),
  );
  const pi = parseCatalog(value.pi, (models) => normalizeAcpModelCatalogEntries(models, "pi"));
  return {
    schemaVersion: 1,
    ...(claude ? { claude } : {}),
    ...(codex ? { codex } : {}),
    ...(cursor ? { cursor } : {}),
    ...(grok ? { grok } : {}),
    ...(pi ? { pi } : {}),
  };
}

export function validateCodexMaxConcurrentThreads(value: unknown): number {
  if (!isValidCodexMaxConcurrentThreads(value)) {
    throw new Error(
      `codexMaxConcurrentThreads must be an integer between 1 and ${MAX_CODEX_CONCURRENT_THREADS}.`,
    );
  }
  return value;
}

export function migrateLegacyReviewInstruction(global: JsonRecord): JsonRecord {
  if (
    global.reviewInstruction === undefined &&
    typeof global.reviewPrompt === "string" &&
    getReviewInstructionValidationError(global.reviewPrompt) === null
  ) {
    const { reviewPrompt, ...rest } = global;
    return {
      ...rest,
      reviewInstruction: reviewPrompt,
    };
  }

  if ("reviewPrompt" in global) {
    const { reviewPrompt: _legacyReviewPrompt, ...rest } = global;
    return rest;
  }
  return global;
}

export function validateConfigReviewInstruction(value: unknown): AppConfig {
  if (!isRecord(value) || !isRecord(value.global)) {
    throw new Error("Expected config.global to be an object.");
  }
  const global = migrateLegacyReviewInstruction(value.global);
  parseReviewInstruction(global.reviewInstruction);
  validateCodexMaxConcurrentThreads(global.codexMaxConcurrentThreads);
  return {
    ...value,
    global,
  } as unknown as AppConfig;
}

export function validateGlobalReviewInstruction(value: unknown): AppConfig["global"] {
  if (!isRecord(value)) {
    throw new Error("Expected global config to be an object.");
  }
  const global = migrateLegacyReviewInstruction(value);
  parseReviewInstruction(global.reviewInstruction);
  validateCodexMaxConcurrentThreads(global.codexMaxConcurrentThreads);
  return global as unknown as AppConfig["global"];
}

export function sanitizePersistedReviewInstruction(config: AppConfig): AppConfig {
  const global =
    config && isRecord(config.global) ? (config.global as unknown as JsonRecord) : null;
  if (!global) {
    return config;
  }

  const migratedGlobal = migrateLegacyReviewInstruction(global);
  const instructionError = getReviewInstructionValidationError(migratedGlobal.reviewInstruction);
  if (instructionError === null && migratedGlobal === global) {
    return config;
  }

  const { reviewInstruction: _invalidReviewInstruction, ...globalWithoutInvalidInstruction } =
    migratedGlobal;
  const sanitizedGlobal =
    instructionError === null ? migratedGlobal : globalWithoutInvalidInstruction;

  return {
    ...config,
    global: sanitizedGlobal as unknown as AppConfig["global"],
  };
}

// The OpenCode model helpers moved to their own module, but this one is where
// `storage-shared.ts` and every existing caller reach for them, so the surface
// stays here.
export {
  DEFAULT_OPENCODE_MODEL_ID,
  normalizeOpenCodeRepositoryDefaults,
  selectableOpenCodeDefaultModel,
  storedOpenCodeModelIds,
};

export function normalizePersistedConfig(config: AppConfig): AppConfig {
  const reviewInstructionSanitized = sanitizePersistedReviewInstruction(config);
  const global =
    reviewInstructionSanitized && isRecord(reviewInstructionSanitized.global)
      ? (reviewInstructionSanitized.global as unknown as JsonRecord)
      : null;
  if (!global) return reviewInstructionSanitized;

  const codexMaxConcurrentThreads = resolveCodexMaxConcurrentThreads(
    global.codexMaxConcurrentThreads,
  );
  const debugLogRetentionDays = normalizeDebugLogRetentionDays(global.debugLogRetentionDays);
  const agentMessaging = normalizeAgentMessagingSettings(
    global.agentMessaging,
    config.schemaVersion === 2
      ? { ...DEFAULT_AGENT_MESSAGING_SETTINGS }
      : { ...DEFAULT_AGENT_MESSAGING_SETTINGS, enabled: false },
  );
  const hasExplicitGitHubCredentialSource = typeof global.useHostGitHubCredentials === "boolean";
  const hasLegacyGitHubToken =
    typeof global.githubToken === "string" && global.githubToken.trim().length > 0;
  // Before the source selector existed, a stored PAT was the user's explicit
  // GitHub credential. Preserve that choice during migration instead of
  // silently replacing it with the host's potentially broader `gh` token.
  const useHostGitHubCredentials = hasExplicitGitHubCredentialSource
    ? global.useHostGitHubCredentials
    : !hasLegacyGitHubToken;
  const normalizedEnabledAgentPlatforms = normalizeAgentPlatforms(
    global.enabledAgentPlatforms,
    LEGACY_ENABLED_AGENT_PLATFORMS,
  );
  const enabledAgentPlatforms =
    normalizedEnabledAgentPlatforms.length > 0
      ? normalizedEnabledAgentPlatforms
      : [...LEGACY_ENABLED_AGENT_PLATFORMS];
  const favoriteModels = Array.isArray(global.favoriteModels)
    ? global.favoriteModels
        .flatMap((value) => {
          if (!isRecord(value) || !isAgentPlatform(value.platform)) return [];
          const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
          return modelId ? [{ platform: value.platform, modelId }] : [];
        })
        .filter(
          (value, index, values) =>
            values.findIndex(
              (candidate) =>
                candidate.platform === value.platform && candidate.modelId === value.modelId,
            ) === index,
        )
    : [];
  // An explicitly stored list is the user's own; an explicitly empty one is
  // them opting into every provider and must survive normalization. Anything
  // else is a pre-existing install being migrated onto the managed pair, which
  // has to keep the providers that install already selected from.
  const openCodeModelProviders = Array.isArray(global.openCodeModelProviders)
    ? normalizeOpenCodeModelProviders(global.openCodeModelProviders)
    : migrateOpenCodeModelProviders(
        storedOpenCodeModelIds(global, reviewInstructionSanitized.repositories),
      );
  // Fold every tier onto the shared agent-settings shape before anything else
  // reads a model or a mode. Downstream normalization below operates on the
  // migrated block only, so there is exactly one shape in play from here on.
  const migratedGlobal = migrateGlobalAgentSettings(global);
  const agentSettings: AgentSettingsTier = {
    ...migratedGlobal,
    // The default agent has to be one the user still has enabled. A stored
    // agent for a platform they since turned off would name a launch surface
    // that no longer exists.
    defaultAgent: firstEnabledAgentPlatform(enabledAgentPlatforms, migratedGlobal.defaultAgent),
    platforms: {
      ...migratedGlobal.platforms,
      opencode: {
        ...migratedGlobal.platforms?.opencode,
        ...(() => {
          const model = selectableOpenCodeDefaultModel(
            migratedGlobal.platforms?.opencode?.model,
            favoriteModels,
            openCodeModelProviders,
          );
          return typeof model === "string" && model ? { model } : {};
        })(),
      },
    },
  };

  const globalDefaultAgent = agentSettings.defaultAgent ?? "claude";
  const migratedRepositories = migrateRepositories(
    reviewInstructionSanitized.repositories,
    globalDefaultAgent,
  );
  // A repository default outranks the global one everywhere it is read, so the
  // repointing has to reach it too or the unreachable id simply survives one
  // level down. Identity is preserved when nothing moved.
  const repositories = normalizeOpenCodeRepositoryDefaults(
    migratedRepositories,
    favoriteModels,
    openCodeModelProviders,
  );

  const nextGlobal = stripLegacyKeys(
    { ...global, agentSettings },
    LEGACY_GLOBAL_AGENT_KEYS,
  ) as unknown as AppConfig["global"];

  if (
    repositories === reviewInstructionSanitized.repositories &&
    global.codexMaxConcurrentThreads === codexMaxConcurrentThreads &&
    global.debugLogRetentionDays === debugLogRetentionDays &&
    global.useHostGitHubCredentials === useHostGitHubCredentials &&
    JSON.stringify(global.enabledAgentPlatforms) === JSON.stringify(enabledAgentPlatforms) &&
    JSON.stringify(global.favoriteModels ?? []) === JSON.stringify(favoriteModels) &&
    JSON.stringify(global.openCodeModelProviders) === JSON.stringify(openCodeModelProviders) &&
    JSON.stringify(global.agentSettings) === JSON.stringify(agentSettings) &&
    JSON.stringify(global.agentMessaging) === JSON.stringify(agentMessaging) &&
    config.schemaVersion === 2
  ) {
    return reviewInstructionSanitized;
  }

  return {
    ...reviewInstructionSanitized,
    schemaVersion: 2,
    repositories,
    global: {
      ...nextGlobal,
      codexMaxConcurrentThreads,
      debugLogRetentionDays,
      useHostGitHubCredentials,
      enabledAgentPlatforms,
      favoriteModels,
      openCodeModelProviders,
      agentMessaging,
    } as unknown as AppConfig["global"],
  };
}

/** Drop keys a migration has consumed, so only one shape reaches disk. */
function stripLegacyKeys(record: JsonRecord, keys: readonly string[]): JsonRecord {
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}

function migrateRepositories(
  repositories: AppConfig["repositories"],
  globalDefaultAgent: AgentPlatform,
): AppConfig["repositories"] {
  if (!isRecord(repositories)) return repositories;
  let changed = false;
  const next: JsonRecord = {};
  for (const [id, repository] of Object.entries(repositories)) {
    if (!isRecord(repository)) {
      next[id] = repository;
      continue;
    }
    const migrated = migrateRepositoryAgentSettings(repository, globalDefaultAgent);
    // An empty tier means "inherit everything", which absence already says, so
    // it is omitted rather than written as a `{}` every repository would carry.
    const agentSettings = isEmptyAgentSettings(migrated) ? undefined : migrated;
    if (JSON.stringify(repository.agentSettings) === JSON.stringify(agentSettings)) {
      next[id] = repository;
      continue;
    }
    changed = true;
    const stripped = stripLegacyKeys({ ...repository }, LEGACY_REPOSITORY_AGENT_KEYS);
    if (agentSettings) stripped.agentSettings = agentSettings;
    else delete stripped.agentSettings;
    next[id] = stripped;
  }
  return changed ? (next as AppConfig["repositories"]) : repositories;
}

export function slugify(value: string, fallback: string, maxLength = 0): string {
  let out = "";
  let lastHyphen = false;

  for (const char of value) {
    if (/^[a-zA-Z0-9_]$/.test(char)) {
      out += char.toLowerCase();
      lastHyphen = false;
    } else if (char === "-" || char === " " || char === "." || char === "/") {
      if (!lastHyphen && out.length > 0) {
        out += "-";
        lastHyphen = true;
      }
    }
  }

  out = out.replace(/^-+/, "").replace(/-+$/, "");
  if (maxLength > 0 && out.length > maxLength) {
    out = out.slice(0, maxLength).replace(/-+$/, "");
  }
  return out || fallback;
}

export function sanitizeEnvironmentName(value: string): string {
  return slugify(value, "env", 100);
}

export function sanitizeBranchName(value: string): string {
  return slugify(value, "env");
}

export function extractRepoName(gitUrl: string): string {
  const trimmed = gitUrl.trim().replace(/\.git$/, "");
  const slashPart = trimmed.split("/").filter(Boolean).at(-1);
  if (slashPart) return slashPart;
  const colonPart = trimmed.split(":").filter(Boolean).at(-1);
  return colonPart || trimmed;
}

export function defaultConfig(): AppConfig {
  return {
    schemaVersion: 2,
    version: "1.0.0",
    global: {
      containerResources: { cpuCores: 2, memoryGb: 4 },
      envFilePatterns: [".env", ".env.local"],
      useHostGitHubCredentials: true,
      useHostClaudeCredentials: true,
      allowedDomains: [...DEFAULT_ALLOWED_DOMAINS],
      enabledAgentPlatforms: [...LEGACY_ENABLED_AGENT_PLATFORMS],
      favoriteModels: [],
      agentMessaging: { ...DEFAULT_AGENT_MESSAGING_SETTINGS },
      agentSettings: {
        defaultAgent: "claude",
        platforms: {
          claude: {
            mode: DEFAULT_CLAUDE_MODE,
            model: "claude-sonnet-5",
            claudeNativeBackend: "sdk",
          },
          // New installs only. An existing config.json already holds a concrete
          // effort, and nothing records whether the user chose it or merely
          // inherited the previous "medium" default, so migrating would
          // overwrite deliberate choices. Existing installs keep their stored
          // value until the user changes it in settings.
          codex: { mode: "native", model: "gpt-5.4", reasoningEffort: "high" },
          opencode: { mode: "terminal", model: DEFAULT_OPENCODE_MODEL_ID },
          grok: { mode: "terminal" },
        },
      },
      openCodeModelProviders: [...DEFAULT_OPENCODE_MODEL_PROVIDERS],
      codexMaxConcurrentThreads: DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
      terminalAppearance: {
        fontFamily: "FiraCode Nerd Font",
        fontSize: 14,
        backgroundColor: "#0e1014",
      },
      terminalScrollback: 1000,
      experimentalCodexRawEventLogging: true,
      debugLogging: false,
      debugLogRetentionDays: DEFAULT_DEBUG_LOG_RETENTION_DAYS,
      webClientEnabled: true,
    },
    repositories: {},
  };
}

export function defaultRepositoryConfig(): RepositoryConfig {
  return {
    defaultBranch: "main",
    prBaseBranch: "main",
  };
}

export function createProject(gitUrl: string, localPath?: string): Project {
  return {
    id: randomUUID(),
    name: extractRepoName(gitUrl),
    gitUrl,
    localPath: localPath ?? null,
    addedAt: nowIso(),
    order: 0,
  };
}

export function createEnvironment(
  projectId: string,
  options: {
    name?: string;
    buildPipelineId?: string;
    networkAccessMode?: "full" | "restricted";
    initialPrompt?: string;
    portMappings?: PortMapping[];
    environmentType?: EnvironmentType;
    entryPort?: number;
    pendingRenamePrompt?: string;
  } = {},
): Environment {
  const rawName = options.name?.trim() || defaultEnvironmentName();
  const name = sanitizeEnvironmentName(rawName);
  const environmentType = options.environmentType ?? "containerized";
  const createdAt = nowIso();

  return {
    id: randomUUID(),
    projectId,
    buildPipelineId: options.buildPipelineId,
    name,
    branch: sanitizeBranchName(name),
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt,
    // Creation is itself recent environment activity. Persisting the same
    // timestamp makes a new environment immediately lead the activity view.
    lastActivityAt: createdAt,
    agentActivityState: "idle",
    agentActivityUpdatedAt: createdAt,
    createdFromCommit: undefined,
    networkAccessMode:
      options.networkAccessMode ?? (environmentType === "local" ? "full" : "restricted"),
    allowedDomains: undefined,
    order: 0,
    portMappings: options.portMappings,
    entryPort: options.entryPort,
    hostEntryPort: undefined,
    environmentType,
    worktreePath: undefined,
    opencodePid: undefined,
    claudeBridgePid: undefined,
    codexBridgePid: undefined,
    cursorBridgePid: undefined,
    grokBridgePid: undefined,
    localOpencodePort: undefined,
    localClaudePort: undefined,
    localCodexPort: undefined,
    localCursorPort: undefined,
    localGrokPort: undefined,
    agentSettings: undefined,
    setupScriptsComplete: false,
    setupPhase: "pending",
    setupOverride: false,
    pendingAgentLaunch: false,
    initialPrompt: options.initialPrompt,
    pendingRenamePrompt: options.pendingRenamePrompt,
  };
}

export function createSessionObject(
  environmentId: string,
  containerId: string,
  tabId: string,
  sessionType: SessionType,
): Session {
  const now = nowIso();
  return {
    id: randomUUID(),
    environmentId,
    containerId,
    tabId,
    sessionType,
    status: "connected",
    createdAt: now,
    lastActivityAt: now,
    order: 0,
  };
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * True only for "the path is not there" (ENOENT, or ENOTDIR for a parent that
 * is not a directory). Every other errno — EACCES, EIO, EMFILE — means the
 * file may well exist and hold data we simply could not look at, which is a
 * very different thing from an empty store.
 */
export function isMissingFileError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

export {
  fs,
  path,
  createHash,
  randomBytes,
  randomUUID,
  aggregateAgentActivityState,
  AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS,
  AGENT_ACTIVITY_SOURCES,
  AGENT_ACTIVITY_STATES,
  FRONTEND_AGENT_ACTIVITY_LEASE_MS,
  isAgentActivityTimestamp,
  parseUsableAgentActivityTime,
  AGENT_INTERACTION_JOURNAL_VERSION,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  isAgentInteractionPolicy,
  isAgentInteractionResolutionJournal,
  pruneAgentInteractionResolutionJournal,
  parseStoredDesktopConnections,
  isFeaturePlanningRecord,
  isTerminalFeaturePlanningPhase,
  parseClaudeTmuxStateKey,
  getReviewInstructionValidationError,
  parseReviewInstruction,
  LEGACY_ENABLED_AGENT_PLATFORMS,
  firstEnabledAgentPlatform,
  isAgentPlatform,
  normalizeAgentPlatforms,
  DEFAULT_CLAUDE_MODE,
  PANE_LAYOUT_VERSION,
  paneLayoutRevisionConflictMessage,
  isMultiReviewTerminalPhase,
  isMultiReviewWorkflow,
  mergePersistedPaneLayouts,
  isTabTeardownKind,
  RESOURCE_MANIFEST_KINDS,
  DEFAULT_OPENCODE_MODEL_PROVIDERS,
  migrateOpenCodeModelProviders,
  normalizeOpenCodeModelProviders,
  DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
  isValidCodexMaxConcurrentThreads,
  MAX_CODEX_CONCURRENT_THREADS,
  resolveCodexMaxConcurrentThreads,
  NATIVE_AGENT_SESSION_VERSION,
};

export type {
  AgentInteractionOrigin,
  AgentInteractionPolicy,
  AgentInteractionResolutionJournal,
  StoredDesktopConnections,
  FeaturePlanningRecord,
  BuildPipelineAgent,
  PaneLayoutMergeInput,
  PaneLayoutSelectionIntent,
  ConditionalResourceSnapshot,
  ResourceChange,
  ResourceKind,
  ResourceManifestKind,
  ResourceRevisionManifest,
  ResourceRevisionMap,
  ResourceSnapshotRevision,
  AgentModel,
  PersistedNativeAgentPendingSteer,
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
};
