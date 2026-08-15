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
} from "@orkestrator/protocol/agent-platforms";
import { DEFAULT_CLAUDE_MODE } from "@orkestrator/protocol/startup-launch";
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
  AgentModelConfigKey,
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
} from "./models.js";

export type JsonRecord = Record<string, unknown>;

const MAX_FRONTEND_AGENT_ACTIVITY_OBSERVERS = 32;
const MAX_PANE_LAYOUT_ROOT_BYTES = 256 * 1024;
const MAX_PANE_LAYOUT_SELECTION_INTENT_BYTES = 64 * 1024;
const MAX_PANE_LAYOUT_SELECTION_ENTRIES = 1_024;
const PROMPT_QUEUE_CLAIM_LEASE_MS = 5 * 60 * 1000;
const MAX_PROMPT_QUEUE_SOURCE_KEY_BYTES = 4 * 1024;
const MAX_PROMPT_QUEUE_SOURCE_MESSAGE_ID_BYTES = 1024;

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

function assertPaneLayoutRootWithinBounds(root: unknown): void {
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

function assertPaneLayoutSelectionIntentWithinBounds(
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
    serialized === undefined
    || Buffer.byteLength(serialized, "utf8") > MAX_PANE_LAYOUT_SELECTION_INTENT_BYTES
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
function assertPaneLayoutGeneration(
  environment: Environment,
  containerId: string | null,
  source: "write" | "intent",
): void {
  const currentContainerId = environment.environmentType === "local"
    ? null
    : environment.containerId;
  if (containerId !== currentContainerId) {
    throw new Error(
      `Pane layout ${source} targets stale environment generation: expected ${currentContainerId ?? "local"}, received ${containerId ?? "local"}`,
    );
  }
}

type MutablePaneLayoutLeaf = {
  kind: "leaf";
  id: string;
  tabs: Array<Record<string, unknown>>;
  activeTabId: string | null;
};

function paneLayoutLeaves(root: unknown): MutablePaneLayoutLeaf[] {
  const leaves: MutablePaneLayoutLeaf[] = [];
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    if (
      node.kind === "leaf"
      && typeof node.id === "string"
      && Array.isArray(node.tabs)
      && node.tabs.every(isRecord)
      && (node.activeTabId === null || typeof node.activeTabId === "string")
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
function suppressLateSetupTabAdditions(
  layout: PaneLayoutMergeInput,
  previous: PersistedPaneLayout | undefined,
  base: PaneLayoutMergeInput,
): PaneLayoutMergeInput {
  const previousLeaves = paneLayoutLeaves(previous?.root);
  const baseLeavesById = new Map(paneLayoutLeaves(base.root).map((leaf) => [leaf.id, leaf]));
  const durableSetupTabIds = new Set(
    previousLeaves.flatMap((leaf) => leaf.tabs.flatMap((tab) =>
      tab.isSetupTab === true && typeof tab.id === "string" ? [tab.id] : []
    )),
  );
  const root = JSON.parse(JSON.stringify(layout.root)) as PaneLayoutMergeInput["root"];
  const nextLeaves = paneLayoutLeaves(root);
  const previousLeavesById = new Map(previousLeaves.map((leaf) => [leaf.id, leaf]));
  const previousTabsById = new Map(
    previousLeaves.flatMap((leaf) => leaf.tabs.flatMap((tab) =>
      typeof tab.id === "string" ? [[tab.id, tab] as const] : []
    )),
  );
  let changed = false;
  let removedGlobalFocus = false;

  for (const leaf of nextLeaves) {
    const removedIds = new Set(
      leaf.tabs.flatMap((tab) =>
        tab.isSetupTab === true
          && typeof tab.id === "string"
          && !durableSetupTabIds.has(tab.id)
          ? [tab.id]
          : []
      ),
    );
    if (removedIds.size === 0) continue;
    changed = true;
    const removedActiveTab = leaf.activeTabId !== null && removedIds.has(leaf.activeTabId);
    leaf.tabs = leaf.tabs.flatMap((tab) => {
      if (typeof tab.id !== "string" || !removedIds.has(tab.id)) return [tab];
      const previousTab = previousTabsById.get(tab.id);
      return previousTab ? [JSON.parse(JSON.stringify(previousTab)) as Record<string, unknown>] : [];
    });
    if (!removedActiveTab) continue;

    removedGlobalFocus ||= layout.activePaneId === leaf.id;
    const remainingIds = new Set(
      leaf.tabs.flatMap((tab) => typeof tab.id === "string" ? [tab.id] : []),
    );
    const previousActiveTabId = previousLeavesById.get(leaf.id)?.activeTabId;
    const buildTabId = leaf.tabs.find((tab) =>
      tab.type === "claude-build" && typeof tab.id === "string"
    )?.id;
    const firstTabId = leaf.tabs.find((tab) => typeof tab.id === "string")?.id;
    leaf.activeTabId = previousActiveTabId && remainingIds.has(previousActiveTabId)
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
    activePaneId: removedGlobalFocus
        && previous
        && remainingPaneIds.has(previous.activePaneId)
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
  prUrl?: string;
  prState?: PrState;
  prMergeCommented?: boolean;
};

type ProjectNotes = {
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

type LinearAuth = {
  apiKey: string;
  connectedAt: string;
  viewer?: {
    id: string;
    name: string;
    email?: string;
  };
};

type LinearCompletionComment = {
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

async function resizeKanbanImage(rawBytes: Buffer): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(rawBytes).resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).webp().toBuffer();
}

const MAX_JSON_BACKUPS = 5;
const MAX_PERSISTED_NATIVE_AGENT_PENDING_DISPATCH_BYTES = 32 * 1024 * 1024;
const MAX_SESSIONS_PER_ENVIRONMENT = 20;

const DEFAULT_ALLOWED_DOMAINS = [
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
];

function nowIso(): string {
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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInitialPromptImageAttachment(
  value: unknown,
): value is NonNullable<Environment["initialPromptAttachments"]>[number] {
  return isRecord(value)
    && isNonBlankString(value.id)
    && isNonBlankString(value.name)
    && (value.previewUrl === undefined || typeof value.previewUrl === "string")
    && isNonBlankString(value.base64Data);
}

function isStartupAgentSession(
  value: unknown,
): value is NonNullable<Environment["startupAgentSession"]> {
  return isRecord(value)
    && value.tabId === "startup-agent"
    && isAgentPlatform(value.agent)
    && isOneOf(value.style, ["terminal", "native"])
    && isOneOf(value.status, ["starting", "running", "error"])
    && (value.model === undefined || typeof value.model === "string")
    && (
      value.reasoningEffort === undefined
      || typeof value.reasoningEffort === "string"
    )
    && (
      value.providerSessionId === undefined
      || isNonBlankString(value.providerSessionId)
    )
    && (
      value.startedAt === undefined
      || (
        typeof value.startedAt === "string"
        && Number.isFinite(Date.parse(value.startedAt))
      )
    )
    && (value.error === undefined || typeof value.error === "string");
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Read back the persisted per-source snapshots, discarding any whose state or
 * timestamp no longer parses. A poisoned entry must not be able to pin the
 * aggregate, and dropping it here means every writer sees the same clean view.
 */
function readAgentActivitySources(
  environment: Environment,
  referenceTime: number,
): NonNullable<Environment["agentActivitySources"]> {
  const sources: NonNullable<Environment["agentActivitySources"]> = {};
  for (const candidateSource of AGENT_ACTIVITY_SOURCES) {
    const snapshot = environment.agentActivitySources?.[candidateSource];
    if (!snapshot || !isOneOf(snapshot.state, AGENT_ACTIVITY_STATES)) continue;
    const snapshotTime = parseUsableAgentActivityTime(
      snapshot.updatedAt,
      referenceTime,
    );
    if (!Number.isFinite(snapshotTime)) continue;
    sources[candidateSource] = {
      state: snapshot.state,
      updatedAt: new Date(snapshotTime).toISOString(),
      ...(snapshot.stale === true ? { stale: true } : {}),
    };
  }
  return sources;
}

function frontendAgentActivityObserverKey(observerId: string): string {
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
function agentActivityStructureFingerprint(environment: Environment): string {
  const states = (
    record: Partial<Record<string, { state?: unknown } | undefined>> | undefined,
  ): Array<[string, unknown]> =>
    Object.entries(record ?? {})
      .map(([key, snapshot]): [string, unknown] => [
        key,
        snapshot ? [snapshot.state, "stale" in snapshot ? snapshot.stale === true : false] : undefined,
      ])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({
    state: environment.agentActivityState ?? null,
    sources: states(environment.agentActivitySources),
    observers: states(environment.frontendAgentActivityObservers),
  });
}

function readFrontendAgentActivityObservers(
  environment: Environment,
  referenceTime: number,
): NonNullable<Environment["frontendAgentActivityObservers"]> {
  const observers: NonNullable<
    Environment["frontendAgentActivityObservers"]
  > = {};
  const stored = environment.frontendAgentActivityObservers;
  if (!isRecord(stored)) return observers;

  for (const [observerKey, candidate] of Object.entries(stored)) {
    if (!isRecord(candidate)) continue;
    if (!isOneOf(candidate.state, AGENT_ACTIVITY_STATES)) continue;
    const updatedTime = parseUsableAgentActivityTime(
      candidate.updatedAt,
      referenceTime,
    );
    const leaseExpiresAt = candidate.leaseExpiresAt;
    if (
      !Number.isFinite(updatedTime)
      || !isAgentActivityTimestamp(leaseExpiresAt)
      || Date.parse(leaseExpiresAt) <= referenceTime
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

function aggregateEnvironmentAgentActivity(
  sources: NonNullable<Environment["agentActivitySources"]>,
  observers: NonNullable<Environment["frontendAgentActivityObservers"]>,
): AgentActivityState {
  return aggregateAgentActivityState({ ...sources, ...observers });
}

function nextAgentActivityTimestamp(
  previousValue: unknown,
  referenceTime = Date.now(),
): string {
  const previousTime = parseUsableAgentActivityTime(
    previousValue,
    referenceTime,
  );
  return new Date(Math.max(
    referenceTime,
    Number.isFinite(previousTime)
      ? previousTime + 1
      : Number.NEGATIVE_INFINITY,
  )).toISOString();
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function isPortNumber(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 65_535;
}

function isPortMapping(value: unknown): value is PortMapping {
  return isRecord(value)
    && isPortNumber(value.containerPort)
    && isPortNumber(value.hostPort)
    && (value.protocol === "tcp" || value.protocol === "udp");
}

function isPersistedLoopedReviewWorkflow(
  value: unknown,
  expectedId?: string,
): value is PersistedLoopedReviewWorkflow {
  return isRecord(value)
    && isPositiveInteger(value.version)
    && isNonBlankString(value.id)
    && (expectedId === undefined || value.id === expectedId)
    && isNonBlankString(value.environmentId)
    && isRecord(value.snapshot)
    && typeof value.updatedAt === "string"
    && Number.isFinite(Date.parse(value.updatedAt))
    && isPositiveInteger(value.revision)
    && (
      value.controllerLease === undefined
      || (
        isRecord(value.controllerLease)
        && isNonBlankString(value.controllerLease.ownerId)
        && (
          value.controllerLease.token === undefined
          || isNonBlankString(value.controllerLease.token)
        )
        && typeof value.controllerLease.expiresAt === "string"
        && Number.isFinite(Date.parse(value.controllerLease.expiresAt))
      )
    );
}

function isPersistedMultiReviewWorkflow(
  value: unknown,
  expectedId?: string,
): value is PersistedMultiReviewWorkflow {
  return isRecord(value)
    && isPositiveInteger(value.version)
    && isNonBlankString(value.id)
    && (expectedId === undefined || value.id === expectedId)
    && isNonBlankString(value.environmentId)
    && isRecord(value.snapshot)
    && typeof value.updatedAt === "string"
    && Number.isFinite(Date.parse(value.updatedAt))
    && isPositiveInteger(value.revision)
    && (value.controllerLease === undefined || (
      isRecord(value.controllerLease)
      && isNonBlankString(value.controllerLease.ownerId)
      && isNonBlankString(value.controllerLease.token)
      && typeof value.controllerLease.expiresAt === "string"
      && Number.isFinite(Date.parse(value.controllerLease.expiresAt))
    ));
}

function isPersistedPromptQueueClaim(
  value: unknown,
): value is NonNullable<PersistedPromptQueue["outstandingClaim"]> {
  return isRecord(value)
    && isNonBlankString(value.token)
    && Object.hasOwn(value, "message")
    && typeof value.claimedAt === "string"
    && Number.isFinite(Date.parse(value.claimedAt))
    && typeof value.expiresAt === "string"
    && Number.isFinite(Date.parse(value.expiresAt));
}

function isPersistedPromptQueue(
  value: unknown,
  expectedKey?: string,
): value is PersistedPromptQueue {
  return isRecord(value)
    && isNonBlankString(value.queueKey)
    && (expectedKey === undefined || value.queueKey === expectedKey)
    && isNonBlankString(value.environmentId)
    && promptQueueKeyMatchesEnvironment(value.queueKey, value.environmentId)
    && Array.isArray(value.messages)
    && (
      value.inFlight === undefined
      || (
        isRecord(value.inFlight)
        && Object.hasOwn(value.inFlight, "message")
        && isNonBlankString(value.inFlight.requestId)
        && typeof value.inFlight.reservedAt === "string"
        && Number.isFinite(Date.parse(value.inFlight.reservedAt))
        && (
          value.inFlight.submittingAt === undefined
          || (
            typeof value.inFlight.submittingAt === "string"
            && Number.isFinite(Date.parse(value.inFlight.submittingAt))
          )
        )
        && (
          value.inFlight.submittedAt === undefined
          || (
            typeof value.inFlight.submittedAt === "string"
            && Number.isFinite(Date.parse(value.inFlight.submittedAt))
            && typeof value.inFlight.submittingAt === "string"
            && Date.parse(value.inFlight.submittedAt)
              >= Date.parse(value.inFlight.submittingAt)
          )
        )
      )
    )
    && (
      value.dispatchError === undefined
      || (
        isRecord(value.dispatchError)
        && isNonBlankString(value.dispatchError.requestId)
        && (
          (
            isNonBlankString(value.dispatchError.messageId)
            && isNonBlankString(value.dispatchError.messageFingerprint)
            && /^[a-f0-9]{64}$/.test(value.dispatchError.messageFingerprint)
          )
          || (
            value.dispatchError.messageId === undefined
            && value.dispatchError.messageFingerprint === undefined
          )
        )
        && isNonBlankString(value.dispatchError.message)
        && typeof value.dispatchError.failedAt === "string"
        && Number.isFinite(Date.parse(value.dispatchError.failedAt))
      )
    )
    && (
      value.outstandingClaim === undefined
      || isPersistedPromptQueueClaim(value.outstandingClaim)
    )
    && typeof value.updatedAt === "string"
    && Number.isFinite(Date.parse(value.updatedAt))
    && isPositiveInteger(value.revision);
}

const CLAUDE_TMUX_QUEUE_PREFIX = "claude-tmux\0";

function promptQueueKeyMatchesEnvironment(
  queueKey: string,
  environmentId: string,
): boolean {
  if (!queueKey.startsWith(CLAUDE_TMUX_QUEUE_PREFIX)) return true;
  const target = parseClaudeTmuxStateKey(
    queueKey.slice(CLAUDE_TMUX_QUEUE_PREFIX.length),
  );
  return target?.environmentId === environmentId;
}

function assertPromptQueueKeyOwner(queueKey: string, environmentId: string): void {
  if (!promptQueueKeyMatchesEnvironment(queueKey, environmentId)) {
    throw new Error("Prompt queue key does not match its environment owner");
  }
}

function isPersistedNativeAgentSession(
  value: unknown,
  expectedKey?: string,
): value is PersistedNativeAgentSession {
  return isRecord(value)
    && value.version === NATIVE_AGENT_SESSION_VERSION
    && isNonBlankString(value.key)
    && (expectedKey === undefined || value.key === expectedKey)
    && isNonBlankString(value.environmentId)
    && isAgentPlatform(value.agent)
    && isNonBlankString(value.logicalSessionKey)
    && isNonBlankString(value.providerSessionId)
    && (
      value.origin === "interactive-native"
      || value.origin === "interactive-tmux"
      || value.origin === "build-pipeline"
      || value.origin === "looped-review"
    )
    && isAgentInteractionPolicy(value.interactionPolicy)
    && (
      value.controls === undefined
      || (
        isRecord(value.controls)
        && Object.keys(value.controls).every((key) =>
          key === "modelId"
          || key === "reasoningId"
          || key === "fastMode"
          || key === "mode"
          || key === "executionProfileId"
          || key === "includeLocalSettings"
          || key === "promptSuggestions"
        )
        && (value.controls.modelId === undefined || isNonBlankString(value.controls.modelId))
        && (value.controls.reasoningId === undefined || isNonBlankString(value.controls.reasoningId))
        && (value.controls.fastMode === undefined || typeof value.controls.fastMode === "boolean")
        && (value.controls.executionProfileId === undefined || value.controls.executionProfileId === null || isNonBlankString(value.controls.executionProfileId))
        && (value.controls.includeLocalSettings === undefined || typeof value.controls.includeLocalSettings === "boolean")
        && (value.controls.promptSuggestions === undefined || typeof value.controls.promptSuggestions === "boolean")
        && (
          value.controls.mode === undefined
          || value.controls.mode === "build"
          || value.controls.mode === "plan"
        )
      )
    )
    && (
      value.dispatchedRequestIds === undefined
      || (
        Array.isArray(value.dispatchedRequestIds)
        && value.dispatchedRequestIds.length <= 1_000
        && value.dispatchedRequestIds.every(isNonBlankString)
      )
    )
    && (
      value.pendingDispatch === undefined
      || (
        isRecord(value.pendingDispatch)
        && isNonBlankString(value.pendingDispatch.requestId)
        && isNonBlankString(value.pendingDispatch.prompt)
        && typeof value.pendingDispatch.createdAt === "string"
        && Number.isFinite(Date.parse(value.pendingDispatch.createdAt))
        && (value.pendingDispatch.model === undefined || isNonBlankString(value.pendingDispatch.model))
        && (value.pendingDispatch.reasoningEffort === undefined || isNonBlankString(value.pendingDispatch.reasoningEffort))
        && (value.pendingDispatch.mode === undefined || value.pendingDispatch.mode === "plan" || value.pendingDispatch.mode === "build")
        && (value.pendingDispatch.fastMode === undefined || typeof value.pendingDispatch.fastMode === "boolean")
        && (value.pendingDispatch.subAgent === undefined || isNonBlankString(value.pendingDispatch.subAgent))
        && (value.pendingDispatch.executionAgent === undefined || isNonBlankString(value.pendingDispatch.executionAgent))
        && (value.pendingDispatch.includeLocalSettings === undefined || typeof value.pendingDispatch.includeLocalSettings === "boolean")
        && (value.pendingDispatch.promptSuggestions === undefined || typeof value.pendingDispatch.promptSuggestions === "boolean")
        && (value.pendingDispatch.schema === undefined || isRecord(value.pendingDispatch.schema))
        && (
          value.pendingDispatch.images === undefined
          || (
            Array.isArray(value.pendingDispatch.images)
            && value.pendingDispatch.images.length <= 64
            && value.pendingDispatch.images.every((image) =>
              isRecord(image)
              && isNonBlankString(image.filename)
              && isNonBlankString(image.data)
            )
          )
        )
        && (
          value.pendingDispatch.attachments === undefined
          || (
            Array.isArray(value.pendingDispatch.attachments)
            && value.pendingDispatch.attachments.length <= 64
            && value.pendingDispatch.attachments.every((attachment) =>
              isRecord(attachment)
              && (attachment.type === "image" || attachment.type === "file")
              && isNonBlankString(attachment.path)
              && (attachment.dataUrl === undefined || typeof attachment.dataUrl === "string")
              && (attachment.filename === undefined || typeof attachment.filename === "string")
            )
          )
        )
        && (() => {
          try {
            return Buffer.byteLength(JSON.stringify(value.pendingDispatch), "utf8")
              <= MAX_PERSISTED_NATIVE_AGENT_PENDING_DISPATCH_BYTES;
          } catch {
            return false;
          }
        })()
      )
    )
    && (
      value.openCodeIncompleteTurnNotice === undefined
      || (
        isRecord(value.openCodeIncompleteTurnNotice)
        && (
          value.openCodeIncompleteTurnNotice.kind === "failed"
          || value.openCodeIncompleteTurnNotice.kind === "exhausted"
        )
        && isNonBlankString(
          value.openCodeIncompleteTurnNotice.assistantMessageId,
        )
        && typeof value.openCodeIncompleteTurnNotice.updatedAt === "string"
        && Number.isFinite(Date.parse(value.openCodeIncompleteTurnNotice.updatedAt))
      )
    )
    && typeof value.createdAt === "string"
    && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.updatedAt === "string"
    && Number.isFinite(Date.parse(value.updatedAt));
}

/** Restores pre-policy records without changing provider or dispatch identity. */
function migratePersistedNativeAgentSession(
  value: unknown,
  expectedKey: string,
): PersistedNativeAgentSession | null {
  if (isPersistedNativeAgentSession(value, expectedKey)) return value;
  if (!isRecord(value)) return null;
  if (
    value.version !== undefined
    || value.origin !== undefined
    || value.interactionPolicy !== undefined
  ) {
    return null;
  }
  const legacyLoopedReview = typeof value.logicalSessionKey === "string"
    && value.logicalSessionKey.startsWith("looped-review:");
  const migrated = {
    ...value,
    version: NATIVE_AGENT_SESSION_VERSION,
    origin: legacyLoopedReview ? "looped-review" : "interactive-native",
    interactionPolicy: legacyLoopedReview
      ? UNATTENDED_AGENT_INTERACTION_POLICY
      : INTERACTIVE_AGENT_INTERACTION_POLICY,
  };
  return isPersistedNativeAgentSession(migrated, expectedKey)
    ? migrated
    : null;
}

interface LoadedNativeAgentSessions {
  /** Records this build can read, already migrated in memory. */
  sessions: Record<string, PersistedNativeAgentSession>;
  /** Records this build cannot read, preserved verbatim and never reused. */
  opaque: Record<string, unknown>;
  /** True when at least one readable record was upgraded and needs persisting. */
  migrated: boolean;
}

function resolveNativeAgentInteractionMetadata(input: {
  origin?: AgentInteractionOrigin;
  interactionPolicy?: AgentInteractionPolicy;
}): Pick<PersistedNativeAgentSession, "origin" | "interactionPolicy"> | null {
  const origin = input.origin ?? "interactive-native";
  const interactionPolicy = input.interactionPolicy
    ?? (origin === "build-pipeline" || origin === "looped-review"
      ? UNATTENDED_AGENT_INTERACTION_POLICY
      : INTERACTIVE_AGENT_INTERACTION_POLICY);
  if (
    ![
      "interactive-native",
      "interactive-tmux",
      "build-pipeline",
      "looped-review",
    ].includes(origin)
    || !isAgentInteractionPolicy(interactionPolicy)
    || (
      (origin === "build-pipeline" || origin === "looped-review")
        !== (interactionPolicy.mode === "unattended")
    )
  ) {
    return null;
  }
  return { origin, interactionPolicy };
}

function isPersistedComposeDraft(
  value: unknown,
  expectedKey?: string,
): value is PersistedComposeDraft {
  const source = isRecord(value) ? value.sourcePromptQueue : undefined;
  return isRecord(value)
    && isNonBlankString(value.draftKey)
    && (expectedKey === undefined || value.draftKey === expectedKey)
    && (value.ownerType === "environment" || value.ownerType === "project")
    && isNonBlankString(value.ownerId)
    && Object.hasOwn(value, "value")
    && (
      source === undefined
      || (
        isRecord(source)
        && isNonBlankString(source.queueKey)
        && Buffer.byteLength(source.queueKey, "utf8")
          <= MAX_PROMPT_QUEUE_SOURCE_KEY_BYTES
        && isNonBlankString(source.messageId)
        && Buffer.byteLength(source.messageId, "utf8")
          <= MAX_PROMPT_QUEUE_SOURCE_MESSAGE_ID_BYTES
      )
    )
    && typeof value.updatedAt === "string"
    && Number.isFinite(Date.parse(value.updatedAt))
    && isPositiveInteger(value.revision);
}

function isPersistedFileDraft(
  value: unknown,
  expectedKey?: string,
): value is PersistedFileDraft {
  return isRecord(value)
    && isNonBlankString(value.draftKey)
    && (expectedKey === undefined || value.draftKey === expectedKey)
    && isNonBlankString(value.environmentId)
    && isNonBlankString(value.filePath)
    && typeof value.content === "string"
    && typeof value.originalContent === "string"
    && typeof value.updatedAt === "string"
    && Number.isFinite(Date.parse(value.updatedAt))
    && isPositiveInteger(value.revision);
}

function isPersistedAgentHandoff(
  value: unknown,
  expectedId?: string,
): value is PersistedAgentHandoff {
  return isRecord(value)
    && isPositiveInteger(value.version)
    && isNonBlankString(value.id)
    && (expectedId === undefined || value.id === expectedId)
    && isNonBlankString(value.environmentId)
    && isRecord(value.snapshot)
    && typeof value.createdAt === "string"
    && Number.isFinite(Date.parse(value.createdAt));
}

function isPersistedBuildPipeline(
  value: unknown,
  expectedId?: string,
): value is PersistedBuildPipeline {
  return isRecord(value)
    && isPositiveInteger(value.version)
    && isNonBlankString(value.id)
    && (expectedId === undefined || value.id === expectedId)
    && isNonBlankString(value.projectId)
    // Blank until the pipeline's environment exists; see PersistedBuildPipeline.
    && typeof value.environmentId === "string"
    && isRecord(value.snapshot)
    && typeof value.updatedAt === "string"
    && Number.isFinite(Date.parse(value.updatedAt))
    && isPositiveInteger(value.revision);
}

function activeGitHubBuildReservation(snapshot: unknown): string | null {
  if (!isRecord(snapshot)) return null;
  if (snapshot.phase === "complete" || snapshot.phase === "failed") return null;
  const source = snapshot.source;
  if (
    !isRecord(source)
    || source.type !== "github"
    || !isNonBlankString(source.repositoryOwner)
    || !isNonBlankString(source.repositoryName)
    || !isPositiveInteger(source.issueNumber)
  ) {
    return null;
  }
  return `${source.repositoryOwner.toLowerCase()}/${source.repositoryName.toLowerCase()}#${source.issueNumber}`;
}

function activeBuildAdmissionKey(snapshot: unknown): string | null {
  if (!isRecord(snapshot)) return null;
  if (snapshot.phase === "complete" || snapshot.phase === "failed") return null;
  return isNonBlankString(snapshot.admissionKey)
    ? snapshot.admissionKey
    : null;
}

function isClaudeModelCatalogSnapshot(
  value: unknown,
  environmentId: string,
): value is ClaudeModelCatalogSnapshot {
  if (
    !isRecord(value)
    || value.environmentId !== environmentId
    || !Array.isArray(value.models)
    || !isOneOf(value.source, ["sdk", "last-known-good", "fallback"])
    || typeof value.fetchedAt !== "string"
    || !Number.isFinite(Date.parse(value.fetchedAt))
    || typeof value.stale !== "boolean"
  ) {
    return false;
  }

  const effortLevels = ["low", "medium", "high", "xhigh", "max"] as const;
  return value.models.every((model) => {
    if (!isRecord(model) || !isNonBlankString(model.id) || !isNonBlankString(model.name)) {
      return false;
    }
    const optionalStrings = ["resolvedModel", "description"] as const;
    if (optionalStrings.some((field) => field in model && model[field] != null && typeof model[field] !== "string")) {
      return false;
    }
    const optionalBooleans = [
      "supportsFastMode",
      "supportsEffort",
      "supportsAdaptiveThinking",
      "supportsAutoMode",
    ] as const;
    if (optionalBooleans.some((field) => field in model && model[field] != null && typeof model[field] !== "boolean")) {
      return false;
    }
    return !("supportedEffortLevels" in model)
      || model.supportedEffortLevels == null
      || (
        Array.isArray(model.supportedEffortLevels)
        && model.supportedEffortLevels.every((level) => isOneOf(level, effortLevels))
      );
  })
    && (value.sdkVersion == null || typeof value.sdkVersion === "string")
    && (value.cliVersion == null || typeof value.cliVersion === "string")
    && (value.error == null || typeof value.error === "string");
}

const CODEX_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const satisfies readonly CodexReasoningEffort[];

function normalizeClaudeModelCatalogEntries(
  value: unknown,
): ClaudeModelCatalogEntry[] {
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
          field in candidate
          && candidate[field] != null
          && typeof candidate[field] !== "string",
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
          field in candidate
          && candidate[field] != null
          && typeof candidate[field] !== "boolean",
      )
    ) {
      continue;
    }
    const supportedEffortLevels = candidate.supportedEffortLevels;
    if (
      supportedEffortLevels != null
      && (
        !Array.isArray(supportedEffortLevels)
        || !supportedEffortLevels.every((level) =>
          isOneOf(level, ["low", "medium", "high", "xhigh", "max"] as const)
        )
      )
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

function normalizeCodexModelCatalogEntries(
  value: unknown,
): CodexModelCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  const normalized: CodexModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const id = isNonBlankString(candidate.id) ? candidate.id.trim() : "";
    const name = isNonBlankString(candidate.name) ? candidate.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    if (
      "description" in candidate
      && candidate.description != null
      && typeof candidate.description !== "string"
    ) {
      continue;
    }

    const reasoningEfforts = Array.isArray(candidate.reasoningEfforts)
      ? candidate.reasoningEfforts.filter(
          (effort): effort is CodexReasoningEffort =>
            isOneOf(effort, CODEX_REASONING_EFFORTS),
        )
      : undefined;
    if (
      candidate.reasoningEfforts != null
      && (
        !Array.isArray(candidate.reasoningEfforts)
        || reasoningEfforts!.length !== candidate.reasoningEfforts.length
      )
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
          !isRecord(option)
          || !isOneOf(option.effort, CODEX_REASONING_EFFORTS)
          || !isNonBlankString(option.label)
          || (
            option.description != null
            && typeof option.description !== "string"
          )
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
      ...(defaultReasoningEffort
        ? { defaultReasoningEffort }
        : {}),
    });
  }
  return normalized;
}

function normalizeAcpModelCatalogEntries(
  value: unknown,
  platform: "cursor" | "grok",
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
      (candidate.providerLabel != null && typeof candidate.providerLabel !== "string")
      || (candidate.description != null && typeof candidate.description !== "string")
      || (candidate.defaultReasoningId != null && typeof candidate.defaultReasoningId !== "string")
      || (candidate.supportsSpeed != null && typeof candidate.supportsSpeed !== "boolean")
      || (candidate.supportsMode != null && typeof candidate.supportsMode !== "boolean")
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
          !optionId
          || !optionLabel
          || reasoningIds.has(optionId)
          || (option.description != null && typeof option.description !== "string")
          || (option.annotation != null && typeof option.annotation !== "string")
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
          ...(isNonBlankString(option.annotation)
            ? { annotation: option.annotation.trim() }
            : {}),
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
    });
  }
  return normalized;
}

function parsePersistedAgentModelCatalogCache(
  value: unknown,
): AgentModelCatalogCache {
  const empty: AgentModelCatalogCache = { schemaVersion: 1 };
  if (!isRecord(value) || value.schemaVersion !== 1) return empty;

  const parseCatalog = <T>(
    candidate: unknown,
    normalize: (models: unknown) => T[],
  ) => {
    if (!isRecord(candidate)) return undefined;
    const models = normalize(candidate.models);
    if (models.length === 0) return undefined;
    const updatedAt =
      typeof candidate.updatedAt === "string"
      && Number.isFinite(Date.parse(candidate.updatedAt))
        ? candidate.updatedAt
        : new Date(0).toISOString();
    return { updatedAt, models };
  };

  const claude = parseCatalog(value.claude, normalizeClaudeModelCatalogEntries);
  const codex = parseCatalog(value.codex, normalizeCodexModelCatalogEntries);
  const cursor = parseCatalog(
    value.cursor,
    (models) => normalizeAcpModelCatalogEntries(models, "cursor"),
  );
  const grok = parseCatalog(
    value.grok,
    (models) => normalizeAcpModelCatalogEntries(models, "grok"),
  );
  return {
    schemaVersion: 1,
    ...(claude ? { claude } : {}),
    ...(codex ? { codex } : {}),
    ...(cursor ? { cursor } : {}),
    ...(grok ? { grok } : {}),
  };
}

function validateCodexMaxConcurrentThreads(value: unknown): number {
  if (!isValidCodexMaxConcurrentThreads(value)) {
    throw new Error(
      `codexMaxConcurrentThreads must be an integer between 1 and ${MAX_CODEX_CONCURRENT_THREADS}.`,
    );
  }
  return value;
}

function migrateLegacyReviewInstruction(global: JsonRecord): JsonRecord {
  if (
    global.reviewInstruction === undefined
    && typeof global.reviewPrompt === "string"
    && getReviewInstructionValidationError(global.reviewPrompt) === null
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

function validateConfigReviewInstruction(value: unknown): AppConfig {
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

function validateGlobalReviewInstruction(value: unknown): AppConfig["global"] {
  if (!isRecord(value)) {
    throw new Error("Expected global config to be an object.");
  }
  const global = migrateLegacyReviewInstruction(value);
  parseReviewInstruction(global.reviewInstruction);
  validateCodexMaxConcurrentThreads(global.codexMaxConcurrentThreads);
  return global as unknown as AppConfig["global"];
}

function sanitizePersistedReviewInstruction(config: AppConfig): AppConfig {
  const global = config && isRecord(config.global)
    ? config.global as unknown as JsonRecord
    : null;
  if (!global) {
    return config;
  }

  const migratedGlobal = migrateLegacyReviewInstruction(global);
  const instructionError = getReviewInstructionValidationError(
    migratedGlobal.reviewInstruction,
  );
  if (
    instructionError === null
    && migratedGlobal === global
  ) {
    return config;
  }

  const {
    reviewInstruction: _invalidReviewInstruction,
    ...globalWithoutInvalidInstruction
  } = migratedGlobal;
  const sanitizedGlobal = instructionError === null
    ? migratedGlobal
    : globalWithoutInvalidInstruction;

  return {
    ...config,
    global: sanitizedGlobal as unknown as AppConfig["global"],
  };
}

/**
 * Every place a previously-chosen OpenCode model id is durably stored.
 *
 * These were all selected from a picker that offered every provider OpenCode
 * advertises, so they are what the allowlist migration has to preserve. Ids
 * belonging to another agent contribute nothing: they carry no `provider/model`
 * separator, so they resolve to no provider.
 */
function storedOpenCodeModelIds(
  global: JsonRecord,
  repositories: AppConfig["repositories"] | undefined,
): unknown[] {
  const ids: unknown[] = [global.opencodeModel];
  if (Array.isArray(global.favoriteModels)) {
    for (const favorite of global.favoriteModels) {
      if (isRecord(favorite) && favorite.platform === "opencode") {
        ids.push(favorite.modelId);
      }
    }
  }
  if (isRecord(repositories)) {
    for (const repository of Object.values(repositories)) {
      if (isRecord(repository)) ids.push(repository.defaultModel);
    }
  }
  return ids;
}

function normalizePersistedConfig(config: AppConfig): AppConfig {
  const reviewInstructionSanitized = sanitizePersistedReviewInstruction(config);
  const global = reviewInstructionSanitized && isRecord(reviewInstructionSanitized.global)
    ? reviewInstructionSanitized.global as unknown as JsonRecord
    : null;
  if (!global) return reviewInstructionSanitized;

  const codexMaxConcurrentThreads = resolveCodexMaxConcurrentThreads(
    global.codexMaxConcurrentThreads,
  );
  const hasExplicitGitHubCredentialSource =
    typeof global.useHostGitHubCredentials === "boolean";
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
  const enabledAgentPlatforms = normalizedEnabledAgentPlatforms.length > 0
    ? normalizedEnabledAgentPlatforms
    : [...LEGACY_ENABLED_AGENT_PLATFORMS];
  const defaultAgent = firstEnabledAgentPlatform(
    enabledAgentPlatforms,
    isAgentPlatform(global.defaultAgent) ? global.defaultAgent : undefined,
  );
  const claudeMode = isOneOf(global.claudeMode, ["terminal", "native"])
    ? global.claudeMode
    : DEFAULT_CLAUDE_MODE;
  const favoriteModels = Array.isArray(global.favoriteModels)
    ? global.favoriteModels.flatMap((value) => {
        if (!isRecord(value) || !isAgentPlatform(value.platform)) return [];
        const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
        return modelId ? [{ platform: value.platform, modelId }] : [];
      }).filter((value, index, values) =>
        values.findIndex((candidate) =>
          candidate.platform === value.platform && candidate.modelId === value.modelId
        ) === index
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
  if (
    global.codexMaxConcurrentThreads === codexMaxConcurrentThreads
    && global.useHostGitHubCredentials === useHostGitHubCredentials
    && JSON.stringify(global.enabledAgentPlatforms) === JSON.stringify(enabledAgentPlatforms)
    && global.defaultAgent === defaultAgent
    && global.claudeMode === claudeMode
    && JSON.stringify(global.favoriteModels ?? []) === JSON.stringify(favoriteModels)
    && JSON.stringify(global.openCodeModelProviders)
      === JSON.stringify(openCodeModelProviders)
  ) {
    return reviewInstructionSanitized;
  }

  return {
    ...reviewInstructionSanitized,
    global: {
      ...global,
      codexMaxConcurrentThreads,
      useHostGitHubCredentials,
      enabledAgentPlatforms,
      defaultAgent,
      claudeMode,
      favoriteModels,
      openCodeModelProviders,
    } as unknown as AppConfig["global"],
  };
}

function slugify(value: string, fallback: string, maxLength = 0): string {
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
    version: "1.0.0",
    global: {
      containerResources: { cpuCores: 2, memoryGb: 4 },
      envFilePatterns: [".env", ".env.local"],
      useHostGitHubCredentials: true,
      useHostClaudeCredentials: true,
      allowedDomains: [...DEFAULT_ALLOWED_DOMAINS],
      enabledAgentPlatforms: [...LEGACY_ENABLED_AGENT_PLATFORMS],
      favoriteModels: [],
      defaultAgent: "claude",
      opencodeModel: "opencode/claude-sonnet-5",
      claudeModel: "claude-sonnet-5",
      codexModel: "gpt-5.4",
      // New installs only. An existing config.json already holds a concrete
      // effort, and nothing records whether the user chose it or merely
      // inherited the previous "medium" default, so migrating would overwrite
      // deliberate choices. Existing installs keep their stored value until the
      // user changes it in settings.
      codexReasoningEffort: "high",
      opencodeMode: "terminal",
      openCodeModelProviders: [...DEFAULT_OPENCODE_MODEL_PROVIDERS],
      claudeMode: DEFAULT_CLAUDE_MODE,
      claudeNativeBackend: "sdk",
      claudeNativeFastModeDefault: false,
      codexMode: "native",
      codexNativeFastModeDefault: false,
      codexMaxConcurrentThreads: DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
      terminalAppearance: {
        fontFamily: "FiraCode Nerd Font",
        fontSize: 14,
        backgroundColor: "#141414",
      },
      terminalScrollback: 1000,
      experimentalCodexRawEventLogging: true,
      debugLogging: false,
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
  const rawName =
    options.name?.trim() || defaultEnvironmentName();
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
    networkAccessMode: options.networkAccessMode ?? (environmentType === "local" ? "full" : "restricted"),
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
    defaultAgent: undefined,
    claudeMode: undefined,
    claudeNativeBackend: undefined,
    opencodeMode: undefined,
    codexMode: undefined,
    setupScriptsComplete: false,
    setupPhase: "pending",
    setupOverride: false,
    pendingAgentLaunch: false,
    initialPrompt: options.initialPrompt,
    pendingRenamePrompt: options.pendingRenamePrompt,
  };
}

function createSessionObject(
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

async function exists(filePath: string): Promise<boolean> {
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
function isMissingFileError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

function normalizeOpenCodeModelCatalogEntries(
  models: OpenCodeModelCatalogEntry[],
): OpenCodeModelCatalogEntry[] {
  const byId = new Map<string, OpenCodeModelCatalogEntry[]>();

  for (const candidate of models) {
    if (!candidate || typeof candidate !== "object") continue;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const provider =
      typeof candidate.provider === "string" ? candidate.provider.trim() : "";
    if (!id || !name || !provider) continue;

    const variants = Array.isArray(candidate.variants)
      ? Array.from(new Set(candidate.variants.filter(
          (variant): variant is string =>
            typeof variant === "string" && variant.trim().length > 0,
        ).map((variant) => variant.trim()))).sort((left, right) =>
          left.localeCompare(right)
        )
      : undefined;
    const nonNegativeNumber = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
    const contextWindow =
      typeof candidate.contextWindow === "number" &&
      Number.isSafeInteger(candidate.contextWindow) &&
      candidate.contextWindow > 0
        ? candidate.contextWindow
        : undefined;

    const normalized = {
      id,
      name,
      provider,
      ...(variants?.length ? { variants } : {}),
      ...(nonNegativeNumber(candidate.inputCost) !== undefined
        ? { inputCost: nonNegativeNumber(candidate.inputCost) }
        : {}),
      ...(nonNegativeNumber(candidate.outputCost) !== undefined
        ? { outputCost: nonNegativeNumber(candidate.outputCost) }
        : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(typeof candidate.supportsImageInput === "boolean"
        ? { supportsImageInput: candidate.supportsImageInput }
        : {}),
    };
    const duplicates = byId.get(id) ?? [];
    duplicates.push(normalized);
    byId.set(id, duplicates);
  }

  return Array.from(byId.values())
    .map((duplicates) =>
      duplicates.reduce((selected, candidate) =>
        JSON.stringify(candidate).localeCompare(JSON.stringify(selected)) < 0
          ? candidate
          : selected
      )
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

type PersistedOpenCodeModelCatalogStore = {
  schemaVersion: 2;
  catalogs: Record<string, unknown>;
  legacyUnscoped?: unknown;
};

function normalizeOpenCodeModelCatalogProjectId(projectId: string): string {
  const normalized = projectId.trim();
  if (!normalized) {
    throw new Error("OpenCode model catalogue projectId must be a non-blank string.");
  }
  return normalized;
}

function parseOpenCodeModelCatalogSnapshot(
  projectId: string,
  value: unknown,
): OpenCodeModelCatalogSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.models)) return null;

  const models = normalizeOpenCodeModelCatalogEntries(
    record.models as OpenCodeModelCatalogEntry[],
  );
  if (models.length === 0) return null;

  const updatedAt =
    typeof record.updatedAt === "string" && !Number.isNaN(Date.parse(record.updatedAt))
      ? record.updatedAt
      : new Date(0).toISOString();
  const catalogVersion = createHash("sha256")
    .update(JSON.stringify(models))
    .digest("hex");

  return {
    schemaVersion: 2,
    projectId,
    catalogVersion,
    updatedAt,
    models,
  };
}

function parseOpenCodeModelCatalogStore(
  value: unknown,
): Record<string, OpenCodeModelCatalogSnapshot> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  // Schema 1 was one host-global catalogue. It is deliberately left
  // unassigned: attaching it to whichever project reads first would leak a
  // project-specific opencode.json catalogue into another project.
  if (record.schemaVersion !== 2 || !record.catalogs ||
      typeof record.catalogs !== "object" || Array.isArray(record.catalogs)) {
    return {};
  }

  const catalogs = Object.create(null) as Record<
    string,
    OpenCodeModelCatalogSnapshot
  >;
  for (const [rawProjectId, candidate] of Object.entries(
    record.catalogs as Record<string, unknown>,
  )) {
    const projectId = rawProjectId.trim();
    if (!projectId || Object.hasOwn(catalogs, projectId)) continue;
    const snapshot = parseOpenCodeModelCatalogSnapshot(projectId, candidate);
    if (snapshot) catalogs[projectId] = snapshot;
  }
  return catalogs;
}

function getUnscopedLegacyOpenCodeModelCatalog(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion === 1) return value;
  if (record.schemaVersion === 2 && Object.hasOwn(record, "legacyUnscoped")) {
    return record.legacyUnscoped;
  }
  return undefined;
}

export type ResourceChangeListener = (change: ResourceChange) => void;

/**
 * A planning mutation arrived for an exchange that is no longer attached.
 *
 * Distinguished from a generic failure so the service can drop the work
 * silently instead of marking a live exchange failed: whatever replaced this
 * record is now the authority.
 */
export class FeaturePlanningFenceError extends Error {
  constructor(readonly featureId: string, readonly operationId: string) {
    super(`Feature planning exchange ${operationId} is no longer attached`);
    this.name = "FeaturePlanningFenceError";
  }
}

export class StorageService {
  private readonly dataDir: string;
  /** Process identity: client revision knowledge never crosses this boundary. */
  private readonly resourceGeneration = randomBytes(16).toString("hex");
  private writeQueue = Promise.resolve();
  private projectMutationQueue: Promise<unknown> = Promise.resolve();
  private readonly projectCreationMutationQueues = new Map<string, Promise<unknown>>();
  private environmentMutationQueue: Promise<unknown> = Promise.resolve();
  private configMutationQueue: Promise<unknown> = Promise.resolve();
  private openCodeModelCatalogMutationQueue: Promise<unknown> = Promise.resolve();
  private agentModelCatalogMutationQueue: Promise<unknown> = Promise.resolve();
  private githubCompletionCommentMutationQueue: Promise<unknown> = Promise.resolve();
  private featurePlanMutation: Promise<unknown> = Promise.resolve();
  private paneLayoutMutation: Promise<unknown> = Promise.resolve();
  private loopedReviewMutation: Promise<unknown> = Promise.resolve();
  private multiReviewMutation: Promise<unknown> = Promise.resolve();
  private buildPipelineMutation: Promise<unknown> = Promise.resolve();
  private nativeAgentSessionMutation: Promise<unknown> = Promise.resolve();
  private agentInteractionJournalMutation: Promise<unknown> = Promise.resolve();
  private promptQueueMutation: Promise<unknown> = Promise.resolve();
  private promptQueueClaimRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private composeDraftMutation: Promise<unknown> = Promise.resolve();
  private fileDraftMutation: Promise<unknown> = Promise.resolve();
  private kanbanMutation: Promise<unknown> = Promise.resolve();
  private agentHandoffMutation: Promise<unknown> = Promise.resolve();
  private changeListener: ResourceChangeListener | null = null;
  private changeRevision = 0;
  /**
   * Parsed-JSON read cache for the hot stores, keyed by file path and
   * validated against an (inode, size, mtime) fingerprint on every read.
   *
   * Other backend processes may share this data directory — that is what the
   * cross-process mutation lock files exist for — so the cache can never
   * simply trust itself. A cheap `fs.stat` per read replaces the full
   * read-and-parse in the steady state while still observing every foreign
   * write: our own atomic writes rename a fresh temp file into place (new
   * inode), and an in-place foreign write moves size/mtime.
   */
  private readonly jsonReadCache = new Map<string, { fingerprint: string; value: unknown }>();
  private readonly promptQueueClaimLeaseMs: number;

  constructor(
    dataDir: string,
    options: { promptQueueClaimLeaseMs?: number } = {},
  ) {
    this.dataDir = dataDir;
    this.promptQueueClaimLeaseMs =
      options.promptQueueClaimLeaseMs ?? PROMPT_QUEUE_CLAIM_LEASE_MS;
    if (
      !Number.isFinite(this.promptQueueClaimLeaseMs)
      || this.promptQueueClaimLeaseMs <= 0
    ) {
      throw new Error("Prompt queue claim lease must be positive");
    }
  }

  /**
   * Installs the sink that broadcasts persistent mutations to connected
   * clients. Kept as a setter rather than a constructor argument because the
   * gateway that ultimately delivers these does not exist yet when the backend
   * builds its storage service.
   */
  setResourceChangeListener(listener: ResourceChangeListener | null): void {
    this.changeListener = listener;
  }

  /**
   * Announces a committed mutation. Called only after the write has landed, so
   * a client that refetches in response is guaranteed to observe the new value
   * rather than race the write it was told about.
   */
  private announce(resource: ResourceKind, id: string, projectId?: string): void {
    const listener = this.changeListener;
    if (!listener) return;
    this.changeRevision += 1;
    try {
      listener({ resource, id, revision: this.changeRevision, ...(projectId ? { projectId } : {}) });
    } catch (error) {
      // A broken client transport must never fail the mutation that succeeded.
      console.error("[Storage] Resource change listener threw:", error);
    }
  }

  /**
   * Publish a changed provider-authoritative native-session projection.
   *
   * Unlike the durable identity record, transcript and turn state live in the
   * provider. The native runtime first commits the new bounded projection to
   * its cache and only then calls this method, preserving the same
   * announce-after-commit ordering as file-backed resources.
   */
  announceNativeAgentSessionProjection(environmentId: string): void {
    this.announce("native-agent-session", environmentId);
  }

  getDataDir(): string {
    return this.dataDir;
  }

  getLogDirectory(): string {
    return path.join(this.dataDir, "logs");
  }

  private file(name: string): string {
    return path.join(this.dataDir, name);
  }

  private projectsFile(): string {
    return this.file("projects.json");
  }

  private environmentsFile(): string {
    return this.file("environments.json");
  }

  private configFile(): string {
    return this.file("config.json");
  }

  private agentPlatformsFile(): string {
    return this.file("agent-platforms.json");
  }

  private openCodeModelCatalogFile(): string {
    return this.file("opencode-model-catalog.json");
  }

  private agentModelCatalogFile(): string {
    return this.file("agent-model-catalog.json");
  }

  private sessionsFile(): string {
    return this.file("sessions.json");
  }

  private paneLayoutsFile(): string {
    return this.file("pane-layouts.json");
  }

  private loopedReviewsFile(): string {
    return this.file("looped-reviews.json");
  }

  private multiReviewsFile(): string {
    return this.file("multi-reviews.json");
  }

  private buildPipelinesFile(): string {
    return this.file("build-pipelines.json");
  }

  private nativeAgentSessionsFile(): string {
    return this.file("native-agent-sessions.json");
  }

  private agentInteractionJournalFile(): string {
    return this.file("agent-interaction-resolution-journal.json");
  }

  private promptQueuesFile(): string {
    return this.file("prompt-queues.json");
  }

  private composeDraftsFile(): string {
    return this.file("compose-drafts.json");
  }

  private fileDraftsFile(): string {
    return this.file("file-drafts.json");
  }

  private agentHandoffsFile(): string {
    return this.file("agent-handoffs.json");
  }

  private kanbanFile(): string {
    return this.file("kanban.json");
  }

  private projectNotesFile(): string {
    return this.file("project-notes.json");
  }

  private featurePlansFile(): string {
    return this.file("feature-plans.json");
  }

  private resourceManifestFile(resource: ResourceManifestKind): string {
    switch (resource) {
      case "project": return this.projectsFile();
      case "environment": return this.environmentsFile();
      case "session": return this.sessionsFile();
      case "config": return this.configFile();
      case "kanban": return this.kanbanFile();
      case "project-notes": return this.projectNotesFile();
      case "feature-plan": return this.featurePlansFile();
      case "pane-layout": return this.paneLayoutsFile();
      case "looped-review": return this.loopedReviewsFile();
      case "multi-review": return this.multiReviewsFile();
      case "build-pipeline": return this.buildPipelinesFile();
      case "prompt-queue": return this.promptQueuesFile();
    }
  }

  /**
   * Returns an opaque, content-free revision for one authoritative store.
   *
   * The JSON writer atomically renames a fresh inode into place. Combining the
   * inode with size and timestamps therefore detects both this process's writes
   * and writes made by another backend sharing the same data directory, without
   * reading or hashing user content.
   */
  async getResourceSnapshotRevision(
    resource: ResourceManifestKind,
  ): Promise<ResourceSnapshotRevision> {
    const filePath = this.resourceManifestFile(resource);
    let fingerprint: string;
    try {
      const stat = await fs.stat(filePath, { bigint: true });
      fingerprint = [
        resource,
        stat.ino,
        stat.size,
        stat.mtimeNs,
        stat.ctimeNs,
      ].join(":");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fingerprint = `${resource}:missing`;
    }
    return createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
  }

  getResourceGeneration(): string {
    return this.resourceGeneration;
  }

  async getResourceRevisionManifest(
    knownGeneration?: string,
    knownRevisions: Partial<ResourceRevisionMap> = {},
  ): Promise<ResourceRevisionManifest> {
    const entries = await Promise.all(
      RESOURCE_MANIFEST_KINDS.map(async (resource) => [
        resource,
        await this.getResourceSnapshotRevision(resource),
      ] as const),
    );
    const current = Object.fromEntries(entries) as ResourceRevisionMap;
    const reset = knownGeneration !== this.resourceGeneration;
    const revisions: Partial<ResourceRevisionMap> = {};
    for (const resource of RESOURCE_MANIFEST_KINDS) {
      if (reset || knownRevisions[resource] !== current[resource]) {
        revisions[resource] = current[resource];
      }
    }
    return { generation: this.resourceGeneration, reset, revisions };
  }

  /**
   * Revision-aware wrapper for existing snapshot commands. Their legacy shape
   * remains unchanged unless the caller supplies manifest knowledge.
   */
  async readConditionalResourceSnapshot<T>(
    resource: ResourceManifestKind,
    knownGeneration: string,
    knownRevision: ResourceSnapshotRevision,
    load: () => Promise<T> | T,
  ): Promise<ConditionalResourceSnapshot<T>> {
    const revision = await this.getResourceSnapshotRevision(resource);
    if (
      knownGeneration === this.resourceGeneration
      && knownRevision === revision
    ) {
      return {
        status: "unchanged",
        generation: this.resourceGeneration,
        revision,
      };
    }
    const snapshot = await load();
    // Deliberately publish the pre-read revision. If a concurrent writer lands
    // during the read, the next event/manifest comparison still sees a mismatch
    // instead of incorrectly blessing a potentially older body as current.
    return {
      status: "changed",
      generation: this.resourceGeneration,
      revision,
      snapshot,
    };
  }

  private linearAuthFile(): string {
    return this.file("linear-auth.json");
  }

  private linearCompletionCommentsFile(): string {
    return this.file("linear-completion-comments.json");
  }

  private githubCompletionCommentsFile(): string {
    return this.file("github-completion-comments.json");
  }

  private githubCompletionCommentLockTarget(pipelineId: string): string {
    const key = createHash("sha256").update(pipelineId).digest("hex");
    return this.file(path.join("github-completion-comment-locks", key));
  }

  private buffersDir(): string {
    return path.join(this.dataDir, "buffers");
  }

  private bufferFile(sessionId: string): string {
    return path.join(this.buffersDir(), `${sessionId}.txt`);
  }

  private kanbanImagesDir(): string {
    return path.join(this.dataDir, "kanban-images");
  }

  private kanbanImageFile(imageId: string): string {
    if (!isCanonicalUuid(imageId)) {
      throw new Error("Kanban image ID is invalid");
    }
    return path.join(this.kanbanImagesDir(), `${imageId}.webp`);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.recoverExpiredPromptQueueClaims();
  }

  private async writeAtomic(
    filePath: string,
    contents: string,
    makeBackup = true,
    mode?: number,
    refreshRecoveryBackup = false,
  ): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    const recoveryTempPath = refreshRecoveryBackup
      ? path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.recovery.${randomUUID()}.tmp`,
      )
      : null;

    await this.enqueueWrite(async () => {
      await fs.writeFile(tempPath, contents, mode === undefined ? undefined : { mode });
      if (recoveryTempPath) {
        // Volatile environment updates deliberately do not rotate five
        // historical backups, but they still need one current, valid recovery
        // point. Write the same validated snapshot to .bak.1 before publishing
        // the primary so corruption cannot roll structural fields back.
        await fs.writeFile(
          recoveryTempPath,
          contents,
          mode === undefined ? undefined : { mode },
        );
      }
      if (mode !== undefined) {
        await fs.chmod(tempPath, mode);
      }
      if (mode !== undefined && await exists(filePath)) {
        // Backups of sensitive files must inherit the restricted mode too.
        await fs.chmod(filePath, mode);
      }
      if (makeBackup && await exists(filePath)) {
        await this.rotateBackups(filePath, mode);
      }
      if (recoveryTempPath) {
        await fs.rename(recoveryTempPath, this.backupPath(filePath, 1));
      }
      await fs.rename(tempPath, filePath);
      // The next read must re-validate against the file we just renamed in.
      this.jsonReadCache.delete(filePath);
      if (mode !== undefined) {
        await fs.chmod(filePath, mode);
      }
    }).catch(async (error) => {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      if (recoveryTempPath) {
        await fs.rm(recoveryTempPath, { force: true }).catch(() => undefined);
      }
      throw error;
    });
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private enqueueEnvironmentMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireEnvironmentMutationLock();
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.environmentMutationQueue.then(run, run);
    this.environmentMutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Serializes every projects.json read-modify-write in this process and across
   * backend processes sharing the same data directory.
   */
  private enqueueProjectMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.projectsFile(),
        "project storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.projectMutationQueue.then(run, run);
    this.projectMutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Reserves one canonical local path for the complete repository creation
   * transaction. The hashed lock filename avoids putting user paths in storage
   * or logs while still coordinating backend processes that share dataDir.
   *
   * The timings are sized for the critical section rather than for a JSON
   * write: creation spans `git init`, a commit, `gh repo create` and a push,
   * whose timeouts total 310s. A waiter must therefore outlast a legitimate
   * holder, and the stale threshold must survive a holder whose event loop
   * stalls — otherwise two backends enter and one rolls back the other's work.
   */
  private static readonly PROJECT_CREATION_LOCK_STALE_MS = 90_000;
  private static readonly PROJECT_CREATION_LOCK_TIMEOUT_MS = 360_000;

  async withProjectCreationLock<T>(
    canonicalProjectPath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = createHash("sha256").update(canonicalProjectPath).digest("hex");
    const target = this.file(path.join("project-creation-locks", key));
    const previous = this.projectCreationMutationQueues.get(key) ?? Promise.resolve();
    const run = async () => {
      const release = await this.acquireMutationLock(target, "project creation", {
        staleMs: StorageService.PROJECT_CREATION_LOCK_STALE_MS,
        acquireTimeoutMs: StorageService.PROJECT_CREATION_LOCK_TIMEOUT_MS,
      });
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = previous.then(run, run);
    const settled = next.then(() => undefined, () => undefined);
    this.projectCreationMutationQueues.set(key, settled);
    void settled.finally(() => {
      if (this.projectCreationMutationQueues.get(key) === settled) {
        this.projectCreationMutationQueues.delete(key);
      }
    });
    return next;
  }

  private enqueueConfigMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireConfigMutationLock();
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.configMutationQueue.then(run, run);
    this.configMutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private enqueueGitHubCompletionCommentMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.githubCompletionCommentsFile(),
        "GitHub completion comment storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.githubCompletionCommentMutationQueue.then(run, run);
    this.githubCompletionCommentMutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private enqueueLoopedReviewMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.loopedReviewsFile(),
        "looped review workflow storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.loopedReviewMutation.then(run, run);
    this.loopedReviewMutation = next.then(() => undefined, () => undefined);
    return next;
  }

  private enqueueMultiReviewMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.multiReviewsFile(),
        "multi review workflow storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.multiReviewMutation.then(run, run);
    this.multiReviewMutation = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Serializes build pipeline writes across backend processes sharing this data
   * directory. The cross-process lock matters more here than the in-process
   * queue: two renderers driving the same pipeline is precisely the race the
   * compare-and-swap revision exists to reject, and it can only reject it if the
   * read-modify-write is atomic.
   */
  private enqueueBuildPipelineMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.buildPipelinesFile(),
        "build pipeline storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.buildPipelineMutation.then(run, run);
    this.buildPipelineMutation = next.then(() => undefined, () => undefined);
    return next;
  }

  private enqueueNativeAgentSessionMutation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.nativeAgentSessionsFile(),
        "native agent session storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.nativeAgentSessionMutation.then(run, run);
    this.nativeAgentSessionMutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private enqueueAgentInteractionJournalMutation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.agentInteractionJournalFile(),
        "agent interaction journal storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.agentInteractionJournalMutation.then(run, run);
    this.agentInteractionJournalMutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private enqueuePaneLayoutMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.paneLayoutsFile(),
        "pane layout storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.paneLayoutMutation.then(run, run);
    this.paneLayoutMutation = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * `staleMs` and `acquireTimeoutMs` must both exceed the critical section they
   * guard. The defaults suit a JSON read-modify-write; a caller that holds the
   * lock across child processes has to raise them, or a waiter will steal the
   * lock from a live holder whose event loop merely stalled (machine sleep is
   * the realistic case) and both will enter at once.
   */
  private async acquireMutationLock(
    targetPath: string,
    description: string,
    options: { staleMs?: number; acquireTimeoutMs?: number } = {},
  ): Promise<() => Promise<void>> {
    const staleMs = options.staleMs ?? 15_000;
    const acquireTimeoutMs = options.acquireTimeoutMs ?? 20_000;
    const heartbeatMs = Math.max(1_000, Math.floor(staleMs / 3));
    const lockPath = `${targetPath}.lock`;
    const token = randomUUID();
    const deadline = Date.now() + acquireTimeoutMs;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });

    while (true) {
      try {
        const handle = await fs.open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(token, "utf8");
        } catch (error) {
          await handle.close();
          await fs.rm(lockPath, { force: true });
          throw error;
        }
        const heartbeat = setInterval(() => {
          void handle.utimes(new Date(), new Date()).catch(() => undefined);
        }, heartbeatMs);
        heartbeat.unref();
        return async () => {
          clearInterval(heartbeat);
          await handle.close();
          const currentToken = await fs.readFile(lockPath, "utf8").catch(() => null);
          if (currentToken === token) await fs.rm(lockPath, { force: true });
        };
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "EEXIST") throw error;
        const stat = await fs.stat(lockPath).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > staleMs) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for ${description} lock`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  private async acquireConfigMutationLock(): Promise<() => Promise<void>> {
    return this.acquireMutationLock(this.configFile(), "configuration storage");
  }

  private async acquireEnvironmentMutationLock(): Promise<() => Promise<void>> {
    return this.acquireMutationLock(
      this.environmentsFile(),
      "environment storage",
    );
  }

  private backupPath(filePath: string, index: number): string {
    return path.join(path.dirname(filePath), `${path.basename(filePath)}.bak.${index}`);
  }

  private async rotateBackups(filePath: string, mode?: number): Promise<void> {
    for (let index = MAX_JSON_BACKUPS - 1; index >= 1; index -= 1) {
      const current = this.backupPath(filePath, index);
      const next = this.backupPath(filePath, index + 1);
      if (await exists(next)) await fs.rm(next, { force: true });
      if (await exists(current)) {
        if (mode !== undefined) await fs.chmod(current, mode);
        await fs.rename(current, next);
      }
    }

    const first = this.backupPath(filePath, 1);
    if (await exists(first)) await fs.rm(first, { force: true });
    await fs.copyFile(filePath, first);
    if (mode !== undefined) await fs.chmod(first, mode);
  }

  /**
   * Newest-first walk of the retained backups. Returns a box rather than the
   * value itself so callers can tell "recovered `null`/`[]` from a backup"
   * apart from "no backup was readable".
   */
  private async recoverJsonFromBackups<T>(filePath: string): Promise<{ value: T } | null> {
    for (let index = 1; index <= MAX_JSON_BACKUPS; index += 1) {
      const backup = this.backupPath(filePath, index);
      if (!await exists(backup)) continue;
      try {
        return { value: JSON.parse(await fs.readFile(backup, "utf8")) as T };
      } catch {
        continue;
      }
    }
    return null;
  }

  private async loadJson<T>(filePath: string, fallback: () => T): Promise<T> {
    if (!await exists(filePath)) return fallback();

    try {
      const raw = await fs.readFile(filePath, "utf8");
      if (!raw.trim()) return fallback();
      return JSON.parse(raw) as T;
    } catch {
      const recovered = await this.recoverJsonFromBackups<T>(filePath);
      return recovered ? recovered.value : fallback();
    }
  }

  /**
   * Stat-validated cached variant of {@link loadJson} for the stores that are
   * read on nearly every command. Returns a clone so callers can mutate the
   * result (every mutation path does) without corrupting the cached value.
   *
   * The stat happens *before* the read: if a foreign write lands in between,
   * the fresh content is cached under the stale fingerprint, which merely
   * costs one extra re-read on the next access — never a stale result.
   *
   * Only a genuinely absent file yields the fallback; see the stat catch.
   */
  private async loadJsonCached<T>(filePath: string, fallback: () => T): Promise<T> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      this.jsonReadCache.delete(filePath);
      if (!isMissingFileError(error)) {
        // A stat that fails for a reason other than "not there" is no evidence
        // that the store is empty. Handing back the fallback would show the
        // user zero environments while their data sits intact on disk, and the
        // next mutation would load that empty list, append to it and persist it
        // over the real file. Take the same backup ladder a corrupt primary
        // takes, and surface the failure when nothing is readable.
        const recovered = await this.recoverJsonFromBackups<T>(filePath);
        if (recovered) return recovered.value;
        throw error;
      }
      return fallback();
    }
    const fingerprint = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = this.jsonReadCache.get(filePath);
    if (cached && cached.fingerprint === fingerprint) {
      return structuredClone(cached.value) as T;
    }
    const value = await this.loadJson(filePath, fallback);
    this.jsonReadCache.set(filePath, { fingerprint, value: structuredClone(value) });
    return value;
  }

  /**
   * `backup: false` skips the five-file backup rotation. Reserved for
   * high-churn writes that only refresh volatile activity fields (lease
   * renewals, activity timestamps): rotating backups on every one of those
   * costs ~13 extra fs operations per write and makes every retained backup a
   * copy of a snapshot that differs only in timestamps. Structural mutations
   * must keep the default so the backups stay useful for corruption recovery.
   */
  private async saveJson(
    filePath: string,
    value: unknown,
    options: { backup?: boolean } = {},
  ): Promise<void> {
    await this.writeAtomic(
      filePath,
      `${JSON.stringify(value, null, 2)}\n`,
      options.backup ?? true,
      undefined,
      options.backup === false,
    );
  }

  private async saveSensitiveJson(
    filePath: string,
    value: unknown,
    options: { backup?: boolean } = {},
  ): Promise<void> {
    await this.writeAtomic(
      filePath,
      `${JSON.stringify(value, null, 2)}\n`,
      options.backup ?? true,
      0o600,
      options.backup === false,
    );
  }

  /**
   * Removes records from every retained backup of a sensitive JSON file.
   *
   * Rotating the primary file leaves the deleted records readable in its
   * backups, so a delete that is meant to remove user content — prompt text,
   * pasted attachments, review findings — is not complete until the backups
   * agree. Call while still holding the file's mutation lock.
   *
   * `keep` receives each stored entry; anything it rejects is dropped, so a
   * caller passes the same predicate it used on the primary file.
   */
  private async scrubSensitiveJsonBackups(
    filePath: string,
    keep: (storedId: string, record: unknown) => boolean,
  ): Promise<void> {
    await this.transformSensitiveJsonBackups(filePath, (parsed) => Object.fromEntries(
      Object.entries(parsed).filter(([storedId, record]) => keep(storedId, record)),
    ));
  }

  /** Rewrites every retained sensitive backup while preserving its record shape. */
  private async transformSensitiveJsonBackups(
    filePath: string,
    transform: (records: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    for (let index = 1; index <= MAX_JSON_BACKUPS; index += 1) {
      const backup = this.backupPath(filePath, index);
      if (!await exists(backup)) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(backup, "utf8")) as Record<string, unknown>;
        if (!isRecord(parsed)) throw new Error("Backup is not a record");
        const sanitized = transform(parsed);
        await this.writeAtomic(
          backup,
          `${JSON.stringify(sanitized, null, 2)}\n`,
          false,
          0o600,
        );
      } catch {
        // A corrupt backup cannot be proven free of the deleted records.
        await fs.rm(backup, { force: true });
      }
    }
  }

  private async scrubPendingNativeAgentDispatchBackups(
    key: string,
    requestId: string,
  ): Promise<void> {
    await this.transformSensitiveJsonBackups(this.nativeAgentSessionsFile(), (records) => {
      const stored = records[key];
      if (!isRecord(stored)) return records;
      const pending = stored.pendingDispatch;
      if (!isRecord(pending) || pending.requestId !== requestId) return records;
      return {
        ...records,
        [key]: { ...stored, pendingDispatch: undefined },
      };
    });
  }

  async loadProjects(): Promise<Project[]> {
    const projects = await this.loadJsonCached<Project[]>(this.projectsFile(), () => []);
    return projects.sort((a, b) => a.order - b.order);
  }

  /**
   * `validate` runs inside the projects.json critical section, so a caller that
   * must reject against the *current* stored set — a duplicate local path, say
   * — cannot be raced by a concurrent writer between its own check and this
   * insert.
   */
  async addProject(
    project: Project,
    validate?: (projects: Project[]) => void | Promise<void>,
  ): Promise<Project> {
    const added = await this.enqueueProjectMutation(async () => {
      const projects = await this.loadProjects();
      if (projects.some((candidate) => candidate.gitUrl === project.gitUrl)) {
        throw new Error(`Duplicate project URL: ${project.gitUrl}`);
      }
      if (validate) await validate(projects);

      project.order = Math.max(-1, ...projects.map((item) => item.order)) + 1;
      projects.push(project);
      await this.saveJson(this.projectsFile(), projects);
      return project;
    });
    this.announce("project", project.id);
    return added;
  }

  async removeProject(projectId: string): Promise<void> {
    await this.enqueueProjectMutation(async () => {
      const projects = await this.loadProjects();
      const filtered = projects.filter((project) => project.id !== projectId);
      if (filtered.length === projects.length) throw new Error(`Project not found: ${projectId}`);
      await this.saveJson(this.projectsFile(), filtered);
    });
    await this.deleteComposeDraftsByProject(projectId);
    this.announce("project", projectId);
  }

  async getProject(projectId: string): Promise<Project | null> {
    return (await this.loadProjects()).find((project) => project.id === projectId) ?? null;
  }

  async updateProject(projectId: string, updates: Partial<Pick<Project, "name" | "localPath">>): Promise<Project> {
    const project = await this.enqueueProjectMutation(async () => {
      const projects = await this.loadProjects();
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      if (typeof updates.name === "string") project.name = updates.name;
      if ("localPath" in updates) project.localPath = updates.localPath ?? null;
      await this.saveJson(this.projectsFile(), projects);
      return project;
    });
    this.announce("project", projectId);
    return project;
  }

  async reorderProjects(projectIds: string[]): Promise<Project[]> {
    const projects = await this.enqueueProjectMutation(async () => {
      const projects = await this.loadProjects();
      const provided = new Set(projectIds);
      for (const [index, id] of projectIds.entries()) {
        const project = projects.find((candidate) => candidate.id === id);
        if (project) project.order = index;
      }

      let order = projectIds.length;
      for (const project of projects) {
        if (!provided.has(project.id)) project.order = order++;
      }

      await this.saveJson(this.projectsFile(), projects);
      return projects.sort((a, b) => a.order - b.order);
    });
    for (const project of projects) this.announce("project", project.id);
    return projects;
  }

  async loadEnvironments(): Promise<Environment[]> {
    const environments = await this.loadJsonCached<Environment[]>(this.environmentsFile(), () => []);
    // One-release migration for records written before setupPhase existed.
    // The backend remains authoritative even before the next mutation persists
    // the normalized fields.
    for (const environment of environments) {
      environment.setupPhase ??= environment.setupScriptsComplete ? "ready" : "pending";
      environment.setupOverride ??= false;
    }
    return environments.sort((a, b) => a.order - b.order);
  }

  private async saveEnvironments(
    environments: Environment[],
    options: { backup?: boolean } = {},
  ): Promise<void> {
    // Launch attachments can contain full base64 image payloads. Treat the
    // complete environment store and every rotated backup as sensitive.
    await this.saveSensitiveJson(this.environmentsFile(), environments, options);
  }

  /**
   * Removes superseded launch attachments (or a deleted environment record)
   * from every retained environment backup. This runs while the environment
   * mutation lock is held, after the authoritative primary write commits.
   */
  private async scrubEnvironmentBackups(
    environmentId: string,
    removeEnvironment: boolean,
  ): Promise<void> {
    for (let index = 1; index <= MAX_JSON_BACKUPS; index += 1) {
      const backup = this.backupPath(this.environmentsFile(), index);
      if (!await exists(backup)) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(backup, "utf8")) as unknown;
        if (!Array.isArray(parsed)) throw new Error("Backup is not an array");
        const sanitized = removeEnvironment
          ? parsed.filter((candidate) =>
              !isRecord(candidate) || candidate.id !== environmentId
            )
          : parsed.map((candidate) => {
              if (!isRecord(candidate) || candidate.id !== environmentId) {
                return candidate;
              }
              const copy = { ...candidate };
              delete copy.initialPromptAttachments;
              return copy;
            });
        await this.writeAtomic(
          backup,
          `${JSON.stringify(sanitized, null, 2)}\n`,
          false,
          0o600,
        );
      } catch {
        // A corrupt backup cannot be proven free of the removed payload.
        await fs.rm(backup, { force: true });
      }
    }
  }

  async getEnvironmentsByProject(projectId: string): Promise<Environment[]> {
    return (await this.loadEnvironments()).filter((environment) => environment.projectId === projectId);
  }

  async getEnvironment(environmentId: string): Promise<Environment | null> {
    return (await this.loadEnvironments()).find((environment) => environment.id === environmentId) ?? null;
  }

  async addEnvironment(environment: Environment): Promise<Environment> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      environment.order =
        Math.max(-1, ...environments.filter((item) => item.projectId === environment.projectId).map((item) => item.order)) + 1;
      environments.push(environment);
      await this.saveEnvironments(environments);
      this.announce("environment", environment.id, environment.projectId);
      return environment;
    });
  }

  async removeEnvironment(environmentId: string): Promise<void> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const removed = environments.find((environment) => environment.id === environmentId);
      const filtered = environments.filter((environment) => environment.id !== environmentId);
      if (filtered.length === environments.length) {
        // A previous attempt may have committed the primary removal and then
        // failed while sanitizing retained backups. Keep deletion idempotent so
        // retrying can finish the privacy cleanup before preserving the public
        // not-found contract.
        await this.scrubEnvironmentBackups(environmentId, true);
        throw new Error(`Environment not found: ${environmentId}`);
      }
      await this.saveEnvironments(filtered);
      await this.scrubEnvironmentBackups(environmentId, true);
      this.announce("environment", environmentId, removed?.projectId);
    });
  }

  async updateEnvironment(environmentId: string, updates: JsonRecord): Promise<Environment> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      const beforeJson = JSON.stringify(environment);

      if (isNonBlankString(updates.name)) environment.name = updates.name;
      if (isNonBlankString(updates.branch)) environment.branch = updates.branch;
      if ("status" in updates && isOneOf(updates.status, ["running", "stopped", "error", "creating", "stopping"])) {
        environment.status = updates.status;
        if (updates.status === "stopped" || updates.status === "error") {
          // Idempotent: re-stopping an environment whose activity is already
          // fully cleared must not bump the activity token, or the repeated
          // update could never take the equality bail-out below.
          const alreadyCleared =
            environment.agentActivityState === "idle"
            && isRecord(environment.agentActivitySources)
            && Object.keys(environment.agentActivitySources).length === 0
            && isRecord(environment.frontendAgentActivityObservers)
            && Object.keys(environment.frontendAgentActivityObservers).length === 0;
          if (!alreadyCleared) {
            environment.agentActivityState = "idle";
            environment.agentActivitySources = {};
            environment.frontendAgentActivityObservers = {};
            environment.agentActivityUpdatedAt = nextAgentActivityTimestamp(
              environment.agentActivityUpdatedAt,
            );
          }
        }
      }
      if ("environmentType" in updates && isOneOf(updates.environmentType, ["containerized", "local"])) {
        environment.environmentType = updates.environmentType;
      }

      const optionalStringFields = [
        "worktreePath",
        "initialPrompt",
        "initialAgentModel",
        "initialReasoningEffort",
        "prRecheckAfterAgentCompletionArmedAt",
        "pendingRenamePrompt",
        "createdFromCommit",
        "lastActivityAt",
        "deletionRequestedAt",
        "cleanupAfterMergeRequestedAt",
        "cleanupAfterMergeError",
        "lifecycleOperationStartedAt",
        "setupSessionId",
        "setupStartedAt",
        "setupCompletedAt",
      ] as const;
      for (const field of optionalStringFields) {
        if (field in updates) {
          const value = updates[field];
          if (value === null || value === undefined || typeof value === "string") {
            (environment as unknown as Record<string, unknown>)[field] = value ?? undefined;
          }
        }
      }
      if ("lifecycleError" in updates) {
        const value = updates.lifecycleError;
        if (value === null || value === undefined || typeof value === "string") {
          // Cleared as an explicit `null`, not `undefined`. Renderers merge
          // snapshots field-by-field and `JSON.stringify` drops undefined keys
          // entirely, so a cleared failure would arrive as an absent key and
          // leave the stale message on screen.
          environment.lifecycleError = value ?? null;
        }
      }
      if ("lifecycleOperation" in updates) {
        if (updates.lifecycleOperation == null) {
          environment.lifecycleOperation = undefined;
        } else if (
          updates.lifecycleOperation === "deleting"
          || updates.lifecycleOperation === "merging"
        ) {
          environment.lifecycleOperation = updates.lifecycleOperation;
        }
      }

      if ("containerId" in updates && (updates.containerId == null || typeof updates.containerId === "string")) {
        environment.containerId = updates.containerId ?? null;
      }
      if ("prUrl" in updates && (updates.prUrl == null || typeof updates.prUrl === "string")) {
        environment.prUrl = updates.prUrl ?? null;
      }
      if ("prState" in updates) {
        if (updates.prState == null) environment.prState = null;
        else if (isOneOf(updates.prState, ["open", "merged", "closed"])) environment.prState = updates.prState;
      }
      if ("hasMergeConflicts" in updates) {
        if (updates.hasMergeConflicts == null) environment.hasMergeConflicts = null;
        else if (typeof updates.hasMergeConflicts === "boolean") environment.hasMergeConflicts = updates.hasMergeConflicts;
      }
      if ("allowedDomains" in updates) environment.allowedDomains = Array.isArray(updates.allowedDomains) ? updates.allowedDomains.filter((value): value is string => typeof value === "string") : undefined;
      if ("portMappings" in updates) {
        if (updates.portMappings == null) environment.portMappings = undefined;
        else if (Array.isArray(updates.portMappings) && updates.portMappings.every(isPortMapping)) {
          environment.portMappings = updates.portMappings;
        }
      }

      const pidFields = [
        "opencodePid",
        "claudeBridgePid",
        "codexBridgePid",
        "cursorBridgePid",
        "grokBridgePid",
      ] as const;
      for (const field of pidFields) {
        if (!(field in updates)) continue;
        const value = updates[field];
        if (value == null) environment[field] = undefined;
        else if (isPositiveInteger(value)) environment[field] = value;
      }

      const portFields = [
        "localOpencodePort",
        "localClaudePort",
        "localCodexPort",
        "localCursorPort",
        "localGrokPort",
        "entryPort",
        "hostEntryPort",
      ] as const;
      for (const field of portFields) {
        if (!(field in updates)) continue;
        const value = updates[field];
        if (value == null) environment[field] = undefined;
        else if (isPortNumber(value)) environment[field] = value;
      }

      if ("hasUnreadWork" in updates) {
        if (updates.hasUnreadWork == null) environment.hasUnreadWork = false;
        else if (typeof updates.hasUnreadWork === "boolean") {
          environment.hasUnreadWork = updates.hasUnreadWork;
        }
      }
      if ("setupScriptsComplete" in updates) {
        if (updates.setupScriptsComplete == null) environment.setupScriptsComplete = false;
        else if (typeof updates.setupScriptsComplete === "boolean") {
          environment.setupScriptsComplete = updates.setupScriptsComplete;
        }
      }
      if ("setupPhase" in updates && isOneOf(updates.setupPhase, ["pending", "running", "ready", "failed"])) {
        environment.setupPhase = updates.setupPhase;
      }
      if ("setupOverride" in updates && typeof updates.setupOverride === "boolean") {
        environment.setupOverride = updates.setupOverride;
      }
      if ("tabTeardownIntents" in updates) {
        const intents = updates.tabTeardownIntents;
        if (intents === undefined || intents === null) {
          environment.tabTeardownIntents = undefined;
        } else if (isRecord(intents) && Object.values(intents).every((intent) =>
          isRecord(intent)
          && isNonBlankString(intent.tabId)
          && isTabTeardownKind(intent.kind)
          && isNonBlankString(intent.createdAt)
          && (intent.sessionId === undefined || typeof intent.sessionId === "string")
          && (intent.persistentSessionId === undefined || typeof intent.persistentSessionId === "string")
        )) {
          environment.tabTeardownIntents = intents as Environment["tabTeardownIntents"];
        } else {
          throw new Error("Tab teardown intents are malformed");
        }
      }
      if ("pendingAgentLaunch" in updates && typeof updates.pendingAgentLaunch === "boolean") {
        environment.pendingAgentLaunch = updates.pendingAgentLaunch;
      }
      if ("initialPromptAttachments" in updates) {
        if (updates.initialPromptAttachments == null) {
          environment.initialPromptAttachments = undefined;
        } else if (
          Array.isArray(updates.initialPromptAttachments)
          && updates.initialPromptAttachments.every(isInitialPromptImageAttachment)
        ) {
          const serialized = JSON.stringify(updates.initialPromptAttachments);
          if (Buffer.byteLength(serialized, "utf8") > 32 * 1024 * 1024) {
            throw new Error("Initial prompt attachments exceed the 32 MB limit");
          }
          environment.initialPromptAttachments = updates.initialPromptAttachments.map(
            ({ previewUrl: _previewUrl, ...attachment }) => attachment,
          );
        } else {
          throw new Error("Initial prompt attachments are malformed");
        }
      }
      if ("startupAgentSession" in updates) {
        if (updates.startupAgentSession == null) {
          environment.startupAgentSession = undefined;
        } else if (isStartupAgentSession(updates.startupAgentSession)) {
          environment.startupAgentSession = updates.startupAgentSession;
        } else {
          throw new Error("Startup agent session is malformed");
        }
      }
      if ("claudeModelCatalog" in updates) {
        if (updates.claudeModelCatalog == null) {
          environment.claudeModelCatalog = undefined;
        } else if (isClaudeModelCatalogSnapshot(updates.claudeModelCatalog, environmentId)) {
          environment.claudeModelCatalog = updates.claudeModelCatalog;
        }
      }
      if ("networkAccessMode" in updates && (updates.networkAccessMode === "full" || updates.networkAccessMode === "restricted")) {
        environment.networkAccessMode = updates.networkAccessMode;
      }
      if ("defaultAgent" in updates) {
        if (updates.defaultAgent == null) environment.defaultAgent = undefined;
        else if (isAgentPlatform(updates.defaultAgent)) environment.defaultAgent = updates.defaultAgent;
      }
      if ("claudeMode" in updates) {
        if (updates.claudeMode == null) environment.claudeMode = undefined;
        else if (isOneOf(updates.claudeMode, ["terminal", "native"])) environment.claudeMode = updates.claudeMode;
      }
      if ("claudeNativeBackend" in updates) {
        if (updates.claudeNativeBackend == null) environment.claudeNativeBackend = undefined;
        else if (isOneOf(updates.claudeNativeBackend, ["sdk", "tmux"])) environment.claudeNativeBackend = updates.claudeNativeBackend;
      }
      if ("opencodeMode" in updates) {
        if (updates.opencodeMode == null) environment.opencodeMode = undefined;
        else if (isOneOf(updates.opencodeMode, ["terminal", "native"])) environment.opencodeMode = updates.opencodeMode;
      }
      if ("codexMode" in updates) {
        if (updates.codexMode == null) environment.codexMode = undefined;
        else if (isOneOf(updates.codexMode, ["terminal", "native"])) environment.codexMode = updates.codexMode;
      }

      // A merge that changed nothing persists nothing. Rewriting the whole
      // store — and announcing a change that makes every client refetch every
      // project — for a field-equal record is pure churn.
      if (JSON.stringify(environment) === beforeJson) {
        // Attachment cleanup is a retryable two-step operation: the primary
        // may already be clean while a retained backup still contains the
        // payload. Explicit attachment updates must therefore finish scrubbing
        // even when the primary record no longer changes.
        if ("initialPromptAttachments" in updates) {
          await this.scrubEnvironmentBackups(environmentId, false);
        }
        return environment;
      }

      await this.saveEnvironments(environments);
      if ("initialPromptAttachments" in updates) {
        await this.scrubEnvironmentBackups(environmentId, false);
      }
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  /**
   * Journals one teardown against the latest environment snapshot while the
   * environment mutation lock is held. Whole-map updates from command callers
   * can otherwise overwrite a sibling teardown that was added concurrently.
   */
  async setTabTeardownIntent(
    environmentId: string,
    intent: NonNullable<Environment["tabTeardownIntents"]>[string],
  ): Promise<Environment> {
    if (
      !isNonBlankString(intent.tabId)
      || !isTabTeardownKind(intent.kind)
      || !isNonBlankString(intent.createdAt)
      || (intent.sessionId !== undefined && !isNonBlankString(intent.sessionId))
      || (
        intent.persistentSessionId !== undefined
        && !isNonBlankString(intent.persistentSessionId)
      )
    ) {
      throw new Error("Tab teardown intent is malformed");
    }
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      environment.tabTeardownIntents = {
        ...environment.tabTeardownIntents,
        [intent.tabId]: intent,
      };
      await this.saveEnvironments(environments);
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  /** Clears only the intent this caller completed, preserving newer retries. */
  async clearTabTeardownIntent(
    environmentId: string,
    tabId: string,
    expectedCreatedAt: string,
  ): Promise<Environment> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      const current = environment.tabTeardownIntents?.[tabId];
      if (!current || current.createdAt !== expectedCreatedAt) return environment;
      const intents = { ...environment.tabTeardownIntents };
      delete intents[tabId];
      environment.tabTeardownIntents = Object.keys(intents).length > 0
        ? intents
        : undefined;
      await this.saveEnvironments(environments);
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  /**
   * Atomically arms conflict-resolution reconciliation against the latest PR
   * fields. Serializing the predicate with the write prevents an older Resolve
   * click from re-arming an intent after a concurrent monitor check already
   * proved the PR mergeable.
   */
  async armPrRecheckAfterAgentCompletion(
    environmentId: string,
  ): Promise<{ environment: Environment; armedAt: string | null }> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      if (
        !environment.prUrl
        || environment.prState !== "open"
        || environment.hasMergeConflicts !== true
      ) return { environment, armedAt: null };

      const now = Date.now();
      const previous = environment.prRecheckAfterAgentCompletionArmedAt
        ? Date.parse(environment.prRecheckAfterAgentCompletionArmedAt)
        : Number.NEGATIVE_INFINITY;
      environment.prRecheckAfterAgentCompletionArmedAt = new Date(
        Number.isFinite(previous) && previous >= now ? previous + 1 : now,
      ).toISOString();
      await this.saveEnvironments(environments);
      this.announce("environment", environmentId, environment.projectId);
      return {
        environment,
        armedAt: environment.prRecheckAfterAgentCompletionArmedAt,
      };
    });
  }

  /** Clears only the exact Resolve request whose tab launch failed. */
  async disarmPrRecheckAfterAgentCompletion(
    environmentId: string,
    armedAt: string,
  ): Promise<Environment> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      if (environment.prRecheckAfterAgentCompletionArmedAt !== armedAt) return environment;

      environment.prRecheckAfterAgentCompletionArmedAt = undefined;
      await this.saveEnvironments(environments);
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  /**
   * Clears the backend-to-renderer startup-session projection only after the
   * matching pane tab has been persisted. The identity checks keep a delayed
   * acknowledgement from an old renderer from consuming a newer launch.
   */
  async acknowledgeStartupAgentSession(
    environmentId: string,
    providerSessionId: string | undefined,
    startedAt: string | undefined,
  ): Promise<Environment> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      const startupSession = environment.startupAgentSession;
      if (!startupSession) return environment;
      if (
        providerSessionId !== undefined
        && startupSession.providerSessionId !== providerSessionId
      ) {
        return environment;
      }
      if (startedAt !== undefined && startupSession.startedAt !== startedAt) {
        return environment;
      }
      environment.startupAgentSession = undefined;
      await this.saveEnvironments(environments);
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  async recordEnvironmentActivity(environmentId: string, occurredAt: string): Promise<Environment> {
    const activityTime = Date.parse(occurredAt);
    if (!Number.isFinite(activityTime)) {
      throw new Error("occurredAt must be a valid ISO timestamp");
    }
    const normalizedActivityAt = new Date(activityTime).toISOString();

    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);

      const previousTime = environment.lastActivityAt
        ? Date.parse(environment.lastActivityAt)
        : Number.NEGATIVE_INFINITY;
      if (Number.isFinite(previousTime) && previousTime >= activityTime) {
        return environment;
      }

      environment.lastActivityAt = normalizedActivityAt;
      // Activity timestamps churn constantly and are reconstructed from live
      // observation anyway; rotating five backups for each refresh is waste.
      await this.saveEnvironments(environments, { backup: false });
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  /**
   * Persist the aggregate agent state observed by a frontend or backend
   * monitor. Timestamp ordering makes reports idempotent and prevents a
   * delayed client from replacing a newer observation.
   */
  async setEnvironmentAgentActivity(
    environmentId: string,
    state: AgentActivityState,
    occurredAt: string,
    source: AgentActivitySource = "frontend",
    observerId?: string,
    stale = false,
  ): Promise<Environment> {
    if (!isOneOf(state, AGENT_ACTIVITY_STATES)) {
      throw new Error("state must be idle, working, or waiting");
    }
    if (!isAgentActivityTimestamp(occurredAt)) {
      throw new Error("occurredAt must be a valid ISO timestamp");
    }
    const occurredTime = Date.parse(occurredAt);
    if (occurredTime > Date.now() + AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS) {
      throw new Error("occurredAt must not be more than 5 minutes in the future");
    }
    if (!isOneOf(source, AGENT_ACTIVITY_SOURCES)) {
      throw new Error(
        "source must be frontend, claude-terminal, claude-tmux, native-agent, or multi-review",
      );
    }
    if (
      observerId !== undefined
      && (
        source !== "frontend"
        || !isNonBlankString(observerId)
        || observerId.length > 256
      )
    ) {
      throw new Error(
        "observerId must be a non-blank string of at most 256 characters for frontend activity",
      );
    }

    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);
      const structureBefore = agentActivityStructureFingerprint(environment);
      const previousAggregate = environment.agentActivityState ?? "idle";

      const referenceTime = Date.now();
      const sources = readAgentActivitySources(environment, referenceTime);
      const observers = readFrontendAgentActivityObservers(
        environment,
        referenceTime,
      );

      const observerKey = observerId
        ? frontendAgentActivityObserverKey(observerId)
        : undefined;
      if (
        observerKey
        && !observers[observerKey]
        && Object.keys(observers).length >= MAX_FRONTEND_AGENT_ACTIVITY_OBSERVERS
      ) {
        throw new Error("too many frontend agent activity observers");
      }
      const previousSource = observerKey
        ? observers[observerKey]
        : sources[source];
      const previousTime = previousSource
        ? Date.parse(previousSource.updatedAt)
        : observerKey
          ? Number.NEGATIVE_INFINITY
          : parseUsableAgentActivityTime(
            environment.agentActivityUpdatedAt,
            referenceTime,
          );
      let acceptedOccurredTime = occurredTime;
      if (Number.isFinite(previousTime) && previousTime >= occurredTime) {
        if (source === "frontend" || previousTime > occurredTime) {
          return environment;
        }
        // Backend polling is serialized, so arrival order is authoritative even
        // if two observations share a millisecond. Keep its per-source token
        // monotonic instead of dropping a real terminal transition. Strictly
        // older tokens remain stale and are still rejected.
        acceptedOccurredTime = previousTime + 1;
      }
      const normalizedOccurredAt = new Date(acceptedOccurredTime).toISOString();

      if (observerKey) {
        observers[observerKey] = {
          state,
          updatedAt: normalizedOccurredAt,
          leaseExpiresAt: new Date(
            referenceTime + FRONTEND_AGENT_ACTIVITY_LEASE_MS,
          ).toISOString(),
        };
      } else {
        sources[source] = {
          state,
          updatedAt: normalizedOccurredAt,
          ...(stale ? { stale: true } : {}),
        };
      }

      environment.agentActivitySources = sources;
      environment.frontendAgentActivityObservers = observers;
      environment.agentActivityState = aggregateEnvironmentAgentActivity(
        sources,
        observers,
      );
      const nextAggregate = environment.agentActivityState;
      const aggregateTime = parseUsableAgentActivityTime(
        environment.agentActivityUpdatedAt,
        referenceTime,
      );
      environment.agentActivityUpdatedAt = new Date(Math.max(
        acceptedOccurredTime,
        Number.isFinite(aggregateTime)
          ? aggregateTime
          : Number.NEGATIVE_INFINITY,
      )).toISOString();
      const activityTransition = previousAggregate !== nextAggregate && (
        nextAggregate === "working"
        || nextAggregate === "waiting"
        || (previousAggregate === "working" && nextAggregate === "idle")
      );
      const completionTransition = previousAggregate === "working"
        && (nextAggregate === "idle" || nextAggregate === "waiting");
      if (activityTransition) {
        const previousLastActivityAt = Date.parse(environment.lastActivityAt ?? "");
        environment.lastActivityAt = new Date(Math.max(
          acceptedOccurredTime,
          Number.isFinite(previousLastActivityAt)
            ? previousLastActivityAt
            : Number.NEGATIVE_INFINITY,
        )).toISOString();
      }
      if (completionTransition) environment.hasUnreadWork = true;
      // The lease itself must persist (its expiry is enforced from disk), but
      // the backup rotation is skipped: only volatile activity fields changed.
      await this.saveEnvironments(environments, { backup: completionTransition });
      // A pure lease renewal — same aggregate, same per-source and observer
      // states, only timestamps refreshed — is not announced. Announcing it
      // made every connected client refetch every project on each renewal
      // (every ~10s per environment). The renewing renderer already applies
      // the returned record from this call's response, so it does not need
      // the broadcast; genuine state transitions still announce below.
      if (agentActivityStructureFingerprint(environment) !== structureBefore) {
        this.announce("environment", environmentId, environment.projectId);
      }
      return environment;
    });
  }

  /** Remove expired renderer leases and publish each changed aggregate. */
  async expireFrontendAgentActivityLeases(
    referenceTime = Date.now(),
  ): Promise<string[]> {
    // Cheap pre-check outside the cross-process lock: with no observer leases
    // on record there is nothing that could expire, and this sweep runs every
    // 15 seconds forever. The read is stat-validated, so a lease written by
    // another process is still seen; one added between this check and the
    // next sweep is simply handled by the next sweep.
    const snapshot = await this.loadEnvironments();
    const hasObserverLeases = snapshot.some((environment) => {
      const observers = environment.frontendAgentActivityObservers;
      return isRecord(observers) && Object.keys(observers).length > 0;
    });
    if (!hasObserverLeases) return [];

    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const changed: string[] = [];
      for (const environment of environments) {
        const storedObservers = environment.frontendAgentActivityObservers;
        if (!isRecord(storedObservers) || Object.keys(storedObservers).length === 0) {
          continue;
        }
        const observers = readFrontendAgentActivityObservers(
          environment,
          referenceTime,
        );
        if (Object.keys(observers).length === Object.keys(storedObservers).length) {
          continue;
        }
        const sources = readAgentActivitySources(environment, referenceTime);
        environment.agentActivitySources = sources;
        environment.frontendAgentActivityObservers = observers;
        environment.agentActivityState = aggregateEnvironmentAgentActivity(
          sources,
          observers,
        );
        environment.agentActivityUpdatedAt = nextAgentActivityTimestamp(
          environment.agentActivityUpdatedAt,
          referenceTime,
        );
        changed.push(environment.id);
      }
      if (changed.length === 0) return changed;
      await this.saveEnvironments(environments, { backup: false });
      for (const environmentId of changed) {
        this.announce(
          "environment",
          environmentId,
          environments.find((environment) => environment.id === environmentId)?.projectId,
        );
      }
      return changed;
    });
  }

  /**
   * Drop every renderer-reported activity source. Backend startup is the one
   * moment where every pre-existing renderer lease is provably stale.
   */
  async clearFrontendAgentActivity(): Promise<string[]> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const referenceTime = Date.now();
      const changed: string[] = [];
      for (const environment of environments) {
        const hasLegacyFrontend = Boolean(
          environment.agentActivitySources?.frontend,
        );
        const hasObservers = isRecord(
          environment.frontendAgentActivityObservers,
        ) && Object.keys(environment.frontendAgentActivityObservers).length > 0;
        if (!hasLegacyFrontend && !hasObservers) continue;
        const sources = readAgentActivitySources(environment, referenceTime);
        delete sources.frontend;
        environment.agentActivitySources = sources;
        environment.frontendAgentActivityObservers = {};
        environment.agentActivityState = aggregateEnvironmentAgentActivity(
          sources,
          {},
        );
        environment.agentActivityUpdatedAt = nextAgentActivityTimestamp(
          environment.agentActivityUpdatedAt,
          referenceTime,
        );
        changed.push(environment.id);
      }
      if (changed.length === 0) return changed;
      await this.saveEnvironments(environments, { backup: false });
      for (const environmentId of changed) {
        this.announce(
          "environment",
          environmentId,
          environments.find((environment) => environment.id === environmentId)?.projectId,
        );
      }
      return changed;
    });
  }

  async recordEnvironmentCompletion(
    environmentId: string,
    occurredAt: string,
  ): Promise<Environment> {
    const activityTime = Date.parse(occurredAt);
    if (!Number.isFinite(activityTime)) {
      throw new Error("occurredAt must be a valid ISO timestamp");
    }
    const normalizedActivityAt = new Date(activityTime).toISOString();

    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);

      const previousTime = environment.lastActivityAt
        ? Date.parse(environment.lastActivityAt)
        : Number.NEGATIVE_INFINITY;
      if (Number.isFinite(previousTime) && previousTime >= activityTime) {
        return environment;
      }

      environment.lastActivityAt = normalizedActivityAt;
      environment.hasUnreadWork = true;
      await this.saveEnvironments(environments);
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  /**
   * Persist one backend-observed session completion independently of the
   * environment-wide activity aggregate. Several native tabs can share the
   * `native-agent` source, so one tab may complete while a sibling keeps that
   * aggregate `working`.
   *
   * Backend observations are serialized but may share a millisecond with the
   * preceding working edge. Advance the durable token on a collision rather
   * than dropping a real completion as stale. Callers must invoke this exactly
   * once per observed per-session transition.
   */
  async recordEnvironmentSessionCompletion(
    environmentId: string,
    occurredAt: string,
  ): Promise<Environment> {
    if (!isAgentActivityTimestamp(occurredAt)) {
      throw new Error("occurredAt must be a valid ISO timestamp");
    }
    const occurredTime = Date.parse(occurredAt);

    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);

      const previousTime = Date.parse(environment.lastActivityAt ?? "");
      const acceptedTime = Number.isFinite(previousTime) && previousTime >= occurredTime
        ? previousTime + 1
        : occurredTime;
      environment.lastActivityAt = new Date(acceptedTime).toISOString();
      environment.hasUnreadWork = true;
      await this.saveEnvironments(environments);
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  async setEnvironmentUnread(
    environmentId: string,
    unread: boolean,
    expectedLastActivityAt?: string | null,
  ): Promise<Environment> {
    if (
      expectedLastActivityAt !== undefined
      && expectedLastActivityAt !== null
      && typeof expectedLastActivityAt !== "string"
    ) {
      throw new Error("expectedLastActivityAt must be a string or null");
    }
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find((candidate) => candidate.id === environmentId);
      if (!environment) throw new Error(`Environment not found: ${environmentId}`);

      if (
        !unread
        && expectedLastActivityAt !== undefined
        && (environment.lastActivityAt ?? null) !== expectedLastActivityAt
      ) {
        return environment;
      }
      if (environment.hasUnreadWork === unread) return environment;

      environment.hasUnreadWork = unread;
      await this.saveEnvironments(environments);
      this.announce("environment", environmentId, environment.projectId);
      return environment;
    });
  }

  async reorderEnvironments(projectId: string, environmentIds: string[]): Promise<Environment[]> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const provided = new Set(environmentIds);
      for (const [index, id] of environmentIds.entries()) {
        const environment = environments.find((candidate) => candidate.id === id && candidate.projectId === projectId);
        if (environment) environment.order = index;
      }

      let order = environmentIds.length;
      for (const environment of environments) {
        if (environment.projectId === projectId && !provided.has(environment.id)) environment.order = order++;
      }

      await this.saveEnvironments(environments);
      const reordered = environments
        .filter((environment) => environment.projectId === projectId)
        .sort((a, b) => a.order - b.order);
      for (const environment of reordered) {
        this.announce("environment", environment.id, environment.projectId);
      }
      return reordered;
    });
  }

  async loadConfig(): Promise<AppConfig> {
    const configExists = await fs.access(this.configFile()).then(
      () => true,
      () => false,
    );
    const config = await this.loadJsonCached<AppConfig>(this.configFile(), defaultConfig);
    const normalized = normalizePersistedConfig(config);
    if (configExists) return normalized;
    const sidecar = await this.loadJson<unknown>(
      this.agentPlatformsFile(),
      () => null,
    );
    if (!sidecar || !isRecord(sidecar)) return normalized;
    const enabledAgentPlatforms = normalizeAgentPlatforms(sidecar.enabled, []);
    return enabledAgentPlatforms.length === 0
      ? normalized
      : {
          ...normalized,
          global: {
            ...normalized.global,
            enabledAgentPlatforms,
            defaultAgent: firstEnabledAgentPlatform(
              enabledAgentPlatforms,
              normalized.global.defaultAgent,
            ),
          },
        };
  }

  async saveConfig(
    config: AppConfig,
    options: { preserveCredentials?: boolean } = {},
  ): Promise<void> {
    const validated = validateConfigReviewInstruction(config);
    await this.enqueueConfigMutation(async () => {
      const current = options.preserveCredentials ? await this.loadConfig() : null;
      const next = current
        ? {
            ...validated,
            global: {
              ...validated.global,
              ...(current.global.githubToken
                ? { githubToken: current.global.githubToken }
                : {}),
              ...(current.global.anthropicApiKey
                ? { anthropicApiKey: current.global.anthropicApiKey }
                : {}),
              ...(current.global.cursorApiKey
                ? { cursorApiKey: current.global.cursorApiKey }
                : {}),
            },
          }
        : validated;
      await this.saveJson(this.configFile(), next);
    });
    this.announce("config", "app");
  }

  async getAgentModelCatalogCache(): Promise<AgentModelCatalogCache> {
    const persisted = await this.loadJson<unknown>(
      this.agentModelCatalogFile(),
      () => null,
    );
    return parsePersistedAgentModelCatalogCache(persisted);
  }

  async cacheAgentModelCatalog(
    agent: "claude",
    models: ClaudeModelCatalogEntry[],
  ): Promise<AgentModelCatalogCache>;
  async cacheAgentModelCatalog(
    agent: "codex",
    models: CodexModelCatalogEntry[],
  ): Promise<AgentModelCatalogCache>;
  async cacheAgentModelCatalog(
    agent: "cursor" | "grok",
    models: AgentModel[],
  ): Promise<AgentModelCatalogCache>;
  async cacheAgentModelCatalog(
    agent: "claude" | "codex" | "cursor" | "grok",
    models: ClaudeModelCatalogEntry[] | CodexModelCatalogEntry[] | AgentModel[],
  ): Promise<AgentModelCatalogCache> {
    const normalizedModels = agent === "claude"
      ? normalizeClaudeModelCatalogEntries(models)
      : agent === "codex"
        ? normalizeCodexModelCatalogEntries(models)
        : normalizeAcpModelCatalogEntries(models, agent);
    if (normalizedModels.length === 0) {
      throw new Error(`${agent} model catalogue must contain at least one valid model.`);
    }

    const run = async () => {
      const release = await this.acquireMutationLock(
        this.agentModelCatalogFile(),
        "Agent model catalogue storage",
      );
      try {
        const current = await this.getAgentModelCatalogCache();
        const existing = current[agent];
        if (existing && JSON.stringify(existing.models) === JSON.stringify(normalizedModels)) {
          return current;
        }
        const next: AgentModelCatalogCache = {
          ...current,
          [agent]: {
            updatedAt: new Date().toISOString(),
            models: normalizedModels,
          },
        };
        await this.saveJson(this.agentModelCatalogFile(), next);
        return next;
      } finally {
        await release();
      }
    };

    const next = this.agentModelCatalogMutationQueue.then(run, run);
    this.agentModelCatalogMutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async getOpenCodeModelCatalog(
    projectId: string,
  ): Promise<OpenCodeModelCatalogSnapshot | null> {
    const normalizedProjectId = normalizeOpenCodeModelCatalogProjectId(projectId);
    const store = await this.loadJson<unknown>(
      this.openCodeModelCatalogFile(),
      () => null,
    );
    return parseOpenCodeModelCatalogStore(store)[normalizedProjectId] ?? null;
  }

  async cacheOpenCodeModelCatalog(
    projectId: string,
    models: OpenCodeModelCatalogEntry[],
  ): Promise<OpenCodeModelCatalogSnapshot> {
    const normalizedProjectId = normalizeOpenCodeModelCatalogProjectId(projectId);
    const normalizedModels = normalizeOpenCodeModelCatalogEntries(models);
    if (normalizedModels.length === 0) {
      throw new Error("OpenCode model catalogue must contain at least one model.");
    }

    const catalogVersion = createHash("sha256")
      .update(JSON.stringify(normalizedModels))
      .digest("hex");

    const run = async () => {
      const release = await this.acquireMutationLock(
        this.openCodeModelCatalogFile(),
        "OpenCode model catalogue storage",
      );
      try {
        const persisted = await this.loadJson<unknown>(
          this.openCodeModelCatalogFile(),
          () => null,
        );
        const catalogs = parseOpenCodeModelCatalogStore(persisted);
        const current = catalogs[normalizedProjectId];
        if (current?.catalogVersion === catalogVersion) return current;

        const snapshot: OpenCodeModelCatalogSnapshot = {
          schemaVersion: 2,
          projectId: normalizedProjectId,
          catalogVersion,
          updatedAt: new Date().toISOString(),
          models: normalizedModels,
        };
        catalogs[normalizedProjectId] = snapshot;
        const legacyUnscoped =
          getUnscopedLegacyOpenCodeModelCatalog(persisted);
        const store: PersistedOpenCodeModelCatalogStore = {
          schemaVersion: 2,
          catalogs,
          ...(legacyUnscoped === undefined
            ? {}
            : { legacyUnscoped }),
        };
        await this.saveJson(this.openCodeModelCatalogFile(), store);
        return snapshot;
      } finally {
        await release();
      }
    };

    const next = this.openCodeModelCatalogMutationQueue.then(run, run);
    this.openCodeModelCatalogMutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async getDesktopConnections(): Promise<StoredDesktopConnections> {
    const config = await this.loadConfig();
    if (config.desktopConnections === undefined) return { activeConnectionId: "local", connections: [] };
    try {
      return parseStoredDesktopConnections(config.desktopConnections);
    } catch {
      console.warn("[Storage] Ignoring malformed desktop connection settings.");
      return { activeConnectionId: "local", connections: [] };
    }
  }

  async saveDesktopConnections(desktopConnections: StoredDesktopConnections): Promise<void> {
    const validated = parseStoredDesktopConnections(desktopConnections);
    await this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      config.desktopConnections = validated;
      await this.saveJson(this.configFile(), config);
    });
    this.announce("config", "app");
  }

  async getRepositoryConfig(projectId: string): Promise<RepositoryConfig> {
    const config = await this.loadConfig();
    return config.repositories[projectId] ?? defaultRepositoryConfig();
  }

  async updateRepositoryConfig(projectId: string, repoConfig: RepositoryConfig): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      config.repositories[projectId] = { ...defaultRepositoryConfig(), ...repoConfig };
      await this.saveJson(this.configFile(), config);
      this.announce("config", "app");
      return config;
    });
  }

  /**
   * Update user-editable repository settings without accepting a stale renderer
   * echo for state owned by successful environment creation.
   */
  async updateRepositorySettings(
    projectId: string,
    repoConfig: RepositoryConfig,
  ): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      const current = config.repositories[projectId] ?? defaultRepositoryConfig();
      const userSettings = { ...repoConfig };
      delete userSettings.lastEnvironmentType;
      delete userSettings.lastEnvironmentAgentSelection;
      config.repositories[projectId] = {
        ...defaultRepositoryConfig(),
        ...userSettings,
        ...(current.lastEnvironmentType !== undefined
          ? { lastEnvironmentType: current.lastEnvironmentType }
          : {}),
        ...(current.lastEnvironmentAgentSelection !== undefined
          ? {
              lastEnvironmentAgentSelection:
                current.lastEnvironmentAgentSelection,
            }
          : {}),
      };
      await this.saveJson(this.configFile(), config);
      this.announce("config", "app");
      return config;
    });
  }

  /** Atomically patch backend-owned repository state under the config lock. */
  async patchRepositoryConfig(
    projectId: string,
    updates: Partial<RepositoryConfig>,
  ): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      const current = config.repositories[projectId] ?? defaultRepositoryConfig();
      config.repositories[projectId] = {
        ...defaultRepositoryConfig(),
        ...current,
        ...updates,
      };
      await this.saveJson(this.configFile(), config);
      this.announce("config", "app");
      return config;
    });
  }

  async updateGlobalConfig(
    globalConfig: AppConfig["global"],
    options: { preserveCredentials?: boolean } = {},
  ): Promise<AppConfig> {
    const reviewValidated = validateGlobalReviewInstruction(globalConfig);
    const enabledAgentPlatforms = normalizeAgentPlatforms(
      reviewValidated.enabledAgentPlatforms,
      [],
    );
    if (enabledAgentPlatforms.length === 0) {
      throw new Error("Select at least one agent platform");
    }
    const validated: AppConfig["global"] = {
      ...reviewValidated,
      enabledAgentPlatforms,
      defaultAgent: firstEnabledAgentPlatform(
        enabledAgentPlatforms,
        isAgentPlatform(reviewValidated.defaultAgent)
          ? reviewValidated.defaultAgent
          : undefined,
      ),
    };
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      config.global = options.preserveCredentials
        ? {
            ...validated,
            ...(config.global.githubToken
              ? { githubToken: config.global.githubToken }
              : {}),
            ...(config.global.anthropicApiKey
              ? { anthropicApiKey: config.global.anthropicApiKey }
              : {}),
            ...(config.global.cursorApiKey
              ? { cursorApiKey: config.global.cursorApiKey }
              : {}),
          }
        : validated;
      await this.saveJson(this.configFile(), config);
      this.announce("config", "app");
      return config;
    });
  }

  async updateAgentModelDefault(
    key: AgentModelConfigKey,
    modelId: string,
  ): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      config.global[key] = modelId;
      await this.saveJson(this.configFile(), config);
      // Same announcement every other config mutation makes: other clients
      // rehydrate their model defaults from the authoritative snapshot rather
      // than only learning about the change through the window that made it.
      this.announce("config", "app");
      return config;
    });
  }

  async setGitHubToken(token: string | null): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      if (token === null) delete config.global.githubToken;
      else config.global.githubToken = token;
      await this.saveJson(this.configFile(), config);
      this.announce("config", "app");
      return config;
    });
  }

  async setCursorApiKey(apiKey: string | null): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      if (apiKey === null) delete config.global.cursorApiKey;
      else config.global.cursorApiKey = apiKey;
      await this.saveJson(this.configFile(), config);
      this.announce("config", "app");
      return config;
    });
  }

  async setAnthropicApiKey(apiKey: string | null): Promise<AppConfig> {
    return this.enqueueConfigMutation(async () => {
      const config = await this.loadConfig();
      if (apiKey === null) delete config.global.anthropicApiKey;
      else config.global.anthropicApiKey = apiKey;
      await this.saveJson(this.configFile(), config);
      this.announce("config", "app");
      return config;
    });
  }

  async createSession(environmentId: string, containerId: string, tabId: string, sessionType: SessionType): Promise<Session> {
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
    if (!await exists(filePath)) return { available: true, layouts: {} };
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
        throw new Error(
          paneLayoutRevisionConflictMessage(expectedRevision, currentRevision),
        );
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
      const sameGeneration = previous
        && previous.version === desired.version
        && previous.containerId === desired.containerId;
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
        environment.setupPhase === "ready"
        || environment.setupScriptsComplete === true
        || environment.setupOverride === true
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
        ? JSON.parse(JSON.stringify(previous.root)) as unknown
        : { kind: "leaf", id: "default", tabs: [], activeTabId: null };

      type Leaf = { kind: "leaf"; id: string; tabs: Array<Record<string, unknown>>; activeTabId: string | null };
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
      const existing = leaves.find((leaf) => leaf.tabs.some((tab) => {
        const build = tab.buildTabData;
        return tab.type === "claude-build"
          && build !== null
          && typeof build === "object"
          && !Array.isArray(build)
          && (build as Record<string, unknown>).taskId === input.taskId;
      }));
      const target = existing
        ?? leaves.find((leaf) => leaf.id === previous?.activePaneId)
        ?? leaves[0]!;
      const existingTab = existing?.tabs.find((tab) => {
        const build = tab.buildTabData as Record<string, unknown> | undefined;
        return tab.type === "claude-build" && build?.taskId === input.taskId;
      });
      const tabId = typeof existingTab?.id === "string" && existingTab.id.length > 0
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
   * Publish the native surface for a backend-owned environment launch.
   *
   * The pane is published before provider startup and updated with provider
   * identity later. The launch intent is not consumed until both have
   * converged. That keeps a renderer which was unmounted during setup from
   * being the only process capable of creating the tab. `existingOnly` is used
   * at startup to repair the historical Cursor/Grok bug without resurrecting a
   * tab the user deliberately closed.
   */
  async ensureStartupNativeAgentTab(input: {
    environmentId: string;
    agent: BuildPipelineAgent;
    providerSessionId?: string;
    existingOnly?: boolean;
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
        ? JSON.parse(JSON.stringify(previous.root)) as unknown
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
        leaf.tabs.some((tab) => tab.id === "startup-agent")
      );
      if (input.existingOnly && !existingLeaf) return null;
      const target = existingLeaf
        ?? leaves.find((leaf) => leaf.id === previous?.activePaneId)
        ?? leaves[0]!;
      const existingIndex = target.tabs.findIndex((tab) => tab.id === "startup-agent");
      const nativeAgentData = {
        platform: input.agent,
        environmentId: input.environmentId,
        ...(environment.environmentType === "local"
          ? { isLocal: true }
          : {
              isLocal: false,
              ...(environment.containerId ? { containerId: environment.containerId } : {}),
            }),
        ...(input.providerSessionId ? { sessionId: input.providerSessionId } : {}),
      };
      const tab = {
        id: "startup-agent",
        type: "agent-native",
        nativeAgentData,
      };
      if (existingIndex >= 0) target.tabs[existingIndex] = tab;
      else {
        target.tabs.push(tab);
        if (!input.existingOnly) target.activeTabId = "startup-agent";
      }

      const unchanged = previous
        && (input.existingOnly || previous.activePaneId === target.id)
        && JSON.stringify(previous.root) === JSON.stringify(root);
      if (unchanged) return previous;

      const saved: PersistedPaneLayout = {
        version: PANE_LAYOUT_VERSION,
        environmentId: input.environmentId,
        containerId: environment.containerId,
        activePaneId: input.existingOnly && previous
          ? previous.activePaneId
          : target.id,
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

  async getLoopedReviewWorkflow(
    workflowId: string,
  ): Promise<PersistedLoopedReviewWorkflow | null> {
    if (!isNonBlankString(workflowId)) {
      throw new Error("Looped review workflow ID must not be blank");
    }
    const workflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
      this.loopedReviewsFile(),
      () => ({}),
    );
    const workflow = workflows[workflowId];
    return isPersistedLoopedReviewWorkflow(workflow, workflowId)
      ? workflow
      : null;
  }

  async listLoopedReviewWorkflows(
    environmentId: string,
  ): Promise<PersistedLoopedReviewWorkflow[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Looped review environment ID must not be blank");
    }
    const workflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
      this.loopedReviewsFile(),
      () => ({}),
    );
    return Object.entries(workflows)
      .filter(([workflowId, workflow]) =>
        isPersistedLoopedReviewWorkflow(workflow, workflowId)
        && workflow.environmentId === environmentId
      )
      .map(([, workflow]) => workflow)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  /** Backend supervisors must restore work even when no renderer is mounted. */
  async listAllLoopedReviewWorkflows(): Promise<PersistedLoopedReviewWorkflow[]> {
    const workflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
      this.loopedReviewsFile(),
      () => ({}),
    );
    return Object.entries(workflows)
      .filter(([workflowId, workflow]) => isPersistedLoopedReviewWorkflow(workflow, workflowId))
      .map(([, workflow]) => workflow)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  async saveLoopedReviewWorkflow(
    workflowId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
    expectedRevision?: number,
    controllerFence?: { ownerId: string; token: string },
    options?: {
      /**
       * Rejects the write when the *stored* record has already reached this
       * version. Evaluated inside the mutation queue so it cannot be overtaken
       * by a concurrent backend adoption between the caller's read and its
       * write, which a caller-side check inevitably can be.
       */
      rejectStoredVersionAtLeast?: number;
    },
  ): Promise<PersistedLoopedReviewWorkflow> {
    if (!isNonBlankString(workflowId)) {
      throw new Error("Looped review workflow ID must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Looped review environment ID must not be blank");
    }
    if (!isPositiveInteger(version)) {
      throw new Error("Looped review workflow version must be a positive integer");
    }
    if (!isRecord(snapshot)) {
      throw new Error("Looped review snapshot must be a JSON object");
    }
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Looped review expected revision must be a non-negative integer");
    }
    if (
      controllerFence !== undefined
      && (
        !isNonBlankString(controllerFence.ownerId)
        || !isNonBlankString(controllerFence.token)
      )
    ) {
      throw new Error("Looped review controller fence is invalid");
    }
    let serializedSnapshot: string | undefined;
    try {
      serializedSnapshot = JSON.stringify(snapshot);
    } catch {
      throw new Error("Looped review snapshot must be JSON serializable");
    }
    if (serializedSnapshot === undefined) {
      throw new Error("Looped review snapshot must be JSON serializable");
    }
    // Review packages intentionally retain complete diffs and changed-file
    // contents. Reject over-sized snapshots explicitly; never truncate them.
    if (Buffer.byteLength(serializedSnapshot, "utf8") > 32 * 1024 * 1024) {
      throw new Error("Looped review snapshot exceeds the 32 MB limit");
    }

    return this.enqueueLoopedReviewMutation(async () => {
      if (!await this.getEnvironment(environmentId)) {
        throw new Error(`Environment not found: ${environmentId}`);
      }
      const storedWorkflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
        this.loopedReviewsFile(),
        () => ({}),
      );
      const workflows = Object.fromEntries(
        Object.entries(storedWorkflows).filter(([storedId, workflow]) =>
          isPersistedLoopedReviewWorkflow(workflow, storedId)
        ),
      ) as Record<string, PersistedLoopedReviewWorkflow>;
      const previous = workflows[workflowId];
      if (previous && previous.environmentId !== environmentId) {
        throw new Error("Looped review workflow belongs to another environment");
      }
      if (options?.rejectStoredVersionAtLeast !== undefined
        && (previous?.version ?? 0) >= options.rejectStoredVersionAtLeast) {
        throw new Error("Backend-owned looped reviews can only be changed through workflow commands");
      }
      if (controllerFence) {
        const lease = previous?.controllerLease;
        if (
          lease?.ownerId !== controllerFence.ownerId
          || lease.token !== controllerFence.token
          || Date.parse(lease.expiresAt) <= Date.now()
        ) {
          throw new Error("Looped review controller lease conflict");
        }
      }
      if (
        expectedRevision !== undefined
        && (previous?.revision ?? 0) !== expectedRevision
      ) {
        throw new Error("Looped review workflow revision conflict");
      }
      const saved: PersistedLoopedReviewWorkflow = {
        version,
        id: workflowId,
        environmentId,
        snapshot,
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
        ...(previous?.controllerLease
          ? { controllerLease: previous.controllerLease }
          : {}),
      };
      workflows[workflowId] = saved;
      await this.saveSensitiveJson(this.loopedReviewsFile(), workflows);
      this.announce("looped-review", workflowId);
      return saved;
    });
  }

  async claimLoopedReviewController(
    workflowId: string,
    ownerId: string,
    leaseMs: number,
  ): Promise<{ granted: boolean; token: string; expiresAt: string }> {
    if (!isNonBlankString(workflowId) || !isNonBlankString(ownerId)) {
      throw new Error("Looped review controller identity must not be blank");
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 2_000 || leaseMs > 60_000) {
      throw new Error("Looped review controller lease is invalid");
    }
    return this.enqueueLoopedReviewMutation(async () => {
      const workflows = await this.loadJson<
        Record<string, PersistedLoopedReviewWorkflow>
      >(this.loopedReviewsFile(), () => ({}));
      const workflow = workflows[workflowId];
      if (!isPersistedLoopedReviewWorkflow(workflow, workflowId)) {
        throw new Error(`Looped review workflow not found: ${workflowId}`);
      }
      const now = Date.now();
      const currentExpiry = workflow.controllerLease
        ? Date.parse(workflow.controllerLease.expiresAt)
        : 0;
      if (
        workflow.controllerLease
        && workflow.controllerLease.ownerId !== ownerId
        && currentExpiry > now
      ) {
        return {
          granted: false,
          token: "",
          expiresAt: workflow.controllerLease.expiresAt,
        };
      }
      const heldLease =
        workflow.controllerLease?.ownerId === ownerId
        && currentExpiry > now
        && isNonBlankString(workflow.controllerLease.token)
          ? workflow.controllerLease
          : null;
      // Re-granting an unexpired lease to its own holder is the overwhelmingly
      // common path: every advance claims before it reads, and the poll runs
      // once a second for every non-terminal workflow — including ones merely
      // paused or failed. Writing here would rewrite the whole looped-review
      // file (and rotate five backups of it) each time, and these snapshots
      // legitimately hold complete diffs and file contents. Only pay for the
      // write once the lease is actually close to expiring.
      if (heldLease && currentExpiry - now >= leaseMs / 2) {
        return { granted: true, token: heldLease.token, expiresAt: heldLease.expiresAt };
      }
      const token = heldLease ? heldLease.token : randomUUID();
      const expiresAt = new Date(now + leaseMs).toISOString();
      workflows[workflowId] = {
        ...workflow,
        controllerLease: { ownerId, token, expiresAt },
      };
      await this.saveSensitiveJson(this.loopedReviewsFile(), workflows);
      return { granted: true, token, expiresAt };
    });
  }

  async validateLoopedReviewController(
    workflowId: string,
    ownerId: string,
    token: string,
  ): Promise<boolean> {
    if (
      !isNonBlankString(workflowId)
      || !isNonBlankString(ownerId)
      || !isNonBlankString(token)
    ) {
      return false;
    }
    return this.enqueueLoopedReviewMutation(async () => {
      const workflows = await this.loadJson<
        Record<string, PersistedLoopedReviewWorkflow>
      >(this.loopedReviewsFile(), () => ({}));
      const workflow = workflows[workflowId];
      if (!isPersistedLoopedReviewWorkflow(workflow, workflowId)) return false;
      const lease = workflow.controllerLease;
      return lease?.ownerId === ownerId
        && lease.token === token
        && Date.parse(lease.expiresAt) > Date.now();
    });
  }

  async releaseLoopedReviewController(
    workflowId: string,
    ownerId: string,
    token: string,
  ): Promise<void> {
    if (
      !isNonBlankString(workflowId)
      || !isNonBlankString(ownerId)
      || !isNonBlankString(token)
    ) {
      return;
    }
    await this.enqueueLoopedReviewMutation(async () => {
      const workflows = await this.loadJson<
        Record<string, PersistedLoopedReviewWorkflow>
      >(this.loopedReviewsFile(), () => ({}));
      const workflow = workflows[workflowId];
      if (
        !isPersistedLoopedReviewWorkflow(workflow, workflowId)
        || workflow.controllerLease?.ownerId !== ownerId
        || workflow.controllerLease.token !== token
      ) {
        return;
      }
      const { controllerLease: _lease, ...released } = workflow;
      workflows[workflowId] = released;
      await this.saveSensitiveJson(this.loopedReviewsFile(), workflows);
    });
  }

  async deleteLoopedReviewWorkflow(workflowId: string): Promise<void> {
    if (!isNonBlankString(workflowId)) {
      throw new Error("Looped review workflow ID must not be blank");
    }
    await this.enqueueLoopedReviewMutation(async () => {
      const storedWorkflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
        this.loopedReviewsFile(),
        () => ({}),
      );
      const workflows = Object.fromEntries(
        Object.entries(storedWorkflows).filter(([storedId, workflow]) =>
          isPersistedLoopedReviewWorkflow(workflow, storedId)
        ),
      ) as Record<string, PersistedLoopedReviewWorkflow>;
      if (!(workflowId in workflows)) return;
      delete workflows[workflowId];
      await this.saveSensitiveJson(this.loopedReviewsFile(), workflows);
      this.announce("looped-review", workflowId);
    });
  }

  async deleteLoopedReviewWorkflowsByEnvironment(
    environmentId: string,
  ): Promise<void> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Looped review environment ID must not be blank");
    }
    await this.enqueueLoopedReviewMutation(async () => {
      const storedWorkflows = await this.loadJson<Record<string, PersistedLoopedReviewWorkflow>>(
        this.loopedReviewsFile(),
        () => ({}),
      );
      const workflows = Object.fromEntries(
        Object.entries(storedWorkflows).filter(([storedId, workflow]) =>
          isPersistedLoopedReviewWorkflow(workflow, storedId)
          && workflow.environmentId !== environmentId
        ),
      ) as Record<string, PersistedLoopedReviewWorkflow>;
      const removedIds = Object.entries(storedWorkflows)
        .filter(([storedId, workflow]) =>
          isPersistedLoopedReviewWorkflow(workflow, storedId)
          && workflow.environmentId === environmentId,
        )
        .map(([storedId]) => storedId);
      if (removedIds.length === 0) return;

      await this.saveSensitiveJson(this.loopedReviewsFile(), workflows);
      for (const removedId of removedIds) this.announce("looped-review", removedId);

      // Rotating the primary file creates a backup containing the deleted
      // workflow. Scrub every retained backup before releasing the mutation
      // lock so environment deletion removes all persisted review evidence.
      await this.scrubSensitiveJsonBackups(
        this.loopedReviewsFile(),
        (storedId, workflow) =>
          isPersistedLoopedReviewWorkflow(workflow, storedId)
          && workflow.environmentId !== environmentId,
      );
    });
  }

  async getMultiReviewWorkflow(
    workflowId: string,
  ): Promise<PersistedMultiReviewWorkflow | null> {
    if (!isNonBlankString(workflowId)) throw new Error("Multi review workflow ID must not be blank");
    const workflows = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
      this.multiReviewsFile(), () => ({}),
    );
    const workflow = workflows[workflowId];
    return isPersistedMultiReviewWorkflow(workflow, workflowId) ? workflow : null;
  }

  async listMultiReviewWorkflows(
    environmentId: string,
  ): Promise<PersistedMultiReviewWorkflow[]> {
    if (!isNonBlankString(environmentId)) throw new Error("Multi review environment ID must not be blank");
    const workflows = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
      this.multiReviewsFile(), () => ({}),
    );
    return Object.entries(workflows)
      .filter(([id, workflow]) => isPersistedMultiReviewWorkflow(workflow, id)
        && workflow.environmentId === environmentId)
      .map(([, workflow]) => workflow)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  async listAllMultiReviewWorkflows(): Promise<PersistedMultiReviewWorkflow[]> {
    const workflows = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
      this.multiReviewsFile(), () => ({}),
    );
    return Object.entries(workflows)
      .filter(([id, workflow]) => isPersistedMultiReviewWorkflow(workflow, id))
      .map(([, workflow]) => workflow)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  async saveMultiReviewWorkflow(
    workflowId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
    expectedRevision?: number,
    controllerFence?: { ownerId: string; token: string },
  ): Promise<PersistedMultiReviewWorkflow> {
    if (!isNonBlankString(workflowId) || !isNonBlankString(environmentId)) {
      throw new Error("Multi review workflow identity must not be blank");
    }
    if (!isPositiveInteger(version) || !isRecord(snapshot)) {
      throw new Error("Multi review workflow is invalid");
    }
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Multi review expected revision must be a non-negative integer");
    }
    const serialized = JSON.stringify(snapshot);
    if (Buffer.byteLength(serialized, "utf8") > 32 * 1024 * 1024) {
      throw new Error("Multi review snapshot exceeds the 32 MB limit");
    }
    return this.enqueueMultiReviewMutation(async () => {
      if (!await this.getEnvironment(environmentId)) throw new Error(`Environment not found: ${environmentId}`);
      const stored = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
        this.multiReviewsFile(), () => ({}),
      );
      const workflows = Object.fromEntries(Object.entries(stored).filter(([id, value]) =>
        isPersistedMultiReviewWorkflow(value, id))) as Record<string, PersistedMultiReviewWorkflow>;
      const previous = workflows[workflowId];
      if (previous && previous.environmentId !== environmentId) {
        throw new Error("Multi review workflow belongs to another environment");
      }
      if (controllerFence) {
        const lease = previous?.controllerLease;
        if (lease?.ownerId !== controllerFence.ownerId
          || lease.token !== controllerFence.token
          || Date.parse(lease.expiresAt) <= Date.now()) {
          throw new Error("Multi review controller lease conflict");
        }
      }
      if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) {
        throw new Error("Multi review workflow revision conflict");
      }
      const saved: PersistedMultiReviewWorkflow = {
        version, id: workflowId, environmentId, snapshot, updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
        ...(previous?.controllerLease ? { controllerLease: previous.controllerLease } : {}),
      };
      workflows[workflowId] = saved;
      await this.saveSensitiveJson(this.multiReviewsFile(), workflows);
      this.announce("multi-review", workflowId);
      return saved;
    });
  }

  /**
   * Creates the sole active Multi Review for an environment in the same
   * cross-process critical section that writes the record. A separate
   * list-then-save sequence would let two renderer clients launch competing
   * fix workflows against the same worktree.
   */
  async createMultiReviewWorkflowIfNoActive(
    workflowId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
  ): Promise<PersistedMultiReviewWorkflow | null> {
    if (!isNonBlankString(workflowId) || !isNonBlankString(environmentId)) {
      throw new Error("Multi review workflow identity must not be blank");
    }
    if (!isPositiveInteger(version) || !isRecord(snapshot)) {
      throw new Error("Multi review workflow is invalid");
    }
    const serialized = JSON.stringify(snapshot);
    if (Buffer.byteLength(serialized, "utf8") > 32 * 1024 * 1024) {
      throw new Error("Multi review snapshot exceeds the 32 MB limit");
    }
    return this.enqueueMultiReviewMutation(async () => {
      if (!await this.getEnvironment(environmentId)) {
        throw new Error(`Environment not found: ${environmentId}`);
      }
      const stored = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
        this.multiReviewsFile(), () => ({}),
      );
      const workflows = Object.fromEntries(Object.entries(stored).filter(([id, value]) =>
        isPersistedMultiReviewWorkflow(value, id))) as Record<string, PersistedMultiReviewWorkflow>;
      if (workflows[workflowId]) throw new Error(`Multi review workflow already exists: ${workflowId}`);
      const hasActive = Object.values(workflows).some((workflow) =>
        workflow.environmentId === environmentId
        && isMultiReviewWorkflow(workflow.snapshot)
        && !isMultiReviewTerminalPhase(workflow.snapshot.phase));
      if (hasActive) return null;
      const saved: PersistedMultiReviewWorkflow = {
        version, id: workflowId, environmentId, snapshot, updatedAt: nowIso(), revision: 1,
      };
      workflows[workflowId] = saved;
      await this.saveSensitiveJson(this.multiReviewsFile(), workflows);
      this.announce("multi-review", workflowId);
      return saved;
    });
  }

  async claimMultiReviewController(
    workflowId: string,
    ownerId: string,
    leaseMs: number,
  ): Promise<{ granted: boolean; token: string; expiresAt: string }> {
    if (!isNonBlankString(workflowId) || !isNonBlankString(ownerId)
      || !Number.isSafeInteger(leaseMs) || leaseMs < 2_000 || leaseMs > 60_000) {
      throw new Error("Multi review controller lease is invalid");
    }
    return this.enqueueMultiReviewMutation(async () => {
      const workflows = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
        this.multiReviewsFile(), () => ({}),
      );
      const workflow = workflows[workflowId];
      if (!isPersistedMultiReviewWorkflow(workflow, workflowId)) {
        throw new Error(`Multi review workflow not found: ${workflowId}`);
      }
      const now = Date.now();
      const expiry = workflow.controllerLease ? Date.parse(workflow.controllerLease.expiresAt) : 0;
      if (workflow.controllerLease && workflow.controllerLease.ownerId !== ownerId && expiry > now) {
        return { granted: false, token: "", expiresAt: workflow.controllerLease.expiresAt };
      }
      const held = workflow.controllerLease?.ownerId === ownerId && expiry > now
        ? workflow.controllerLease : undefined;
      if (held && expiry - now >= leaseMs / 2) {
        return { granted: true, token: held.token, expiresAt: held.expiresAt };
      }
      const token = held?.token ?? randomUUID();
      const expiresAt = new Date(now + leaseMs).toISOString();
      workflows[workflowId] = {
        ...workflow, controllerLease: { ownerId, token, expiresAt },
      };
      await this.saveSensitiveJson(this.multiReviewsFile(), workflows);
      return { granted: true, token, expiresAt };
    });
  }

  async validateMultiReviewController(
    workflowId: string,
    ownerId: string,
    token: string,
  ): Promise<boolean> {
    if (!isNonBlankString(workflowId) || !isNonBlankString(ownerId)
      || !isNonBlankString(token)) return false;
    return this.enqueueMultiReviewMutation(async () => {
      const workflows = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
        this.multiReviewsFile(), () => ({}),
      );
      const workflow = workflows[workflowId];
      if (!isPersistedMultiReviewWorkflow(workflow, workflowId)) return false;
      const lease = workflow.controllerLease;
      return lease?.ownerId === ownerId
        && lease.token === token
        && Date.parse(lease.expiresAt) > Date.now();
    });
  }

  async releaseMultiReviewController(
    workflowId: string,
    ownerId: string,
    token: string,
  ): Promise<void> {
    await this.enqueueMultiReviewMutation(async () => {
      const workflows = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
        this.multiReviewsFile(), () => ({}),
      );
      const workflow = workflows[workflowId];
      if (!isPersistedMultiReviewWorkflow(workflow, workflowId)
        || workflow.controllerLease?.ownerId !== ownerId
        || workflow.controllerLease.token !== token) return;
      const { controllerLease: _lease, ...released } = workflow;
      workflows[workflowId] = released;
      await this.saveSensitiveJson(this.multiReviewsFile(), workflows);
    });
  }

  async deleteMultiReviewWorkflow(workflowId: string): Promise<void> {
    await this.enqueueMultiReviewMutation(async () => {
      const workflows = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
        this.multiReviewsFile(), () => ({}),
      );
      if (!(workflowId in workflows)) return;
      delete workflows[workflowId];
      await this.saveSensitiveJson(this.multiReviewsFile(), workflows);
      this.announce("multi-review", workflowId);
    });
  }

  async deleteMultiReviewWorkflowsByEnvironment(environmentId: string): Promise<void> {
    await this.enqueueMultiReviewMutation(async () => {
      const stored = await this.loadJson<Record<string, PersistedMultiReviewWorkflow>>(
        this.multiReviewsFile(), () => ({}),
      );
      const removed = Object.entries(stored)
        .filter(([id, workflow]) => isPersistedMultiReviewWorkflow(workflow, id)
          && workflow.environmentId === environmentId)
        .map(([id]) => id);
      if (removed.length === 0) return;
      const workflows = Object.fromEntries(Object.entries(stored).filter(([id, workflow]) =>
        isPersistedMultiReviewWorkflow(workflow, id)
        && workflow.environmentId !== environmentId));
      await this.saveSensitiveJson(this.multiReviewsFile(), workflows);
      for (const id of removed) this.announce("multi-review", id);
      await this.scrubSensitiveJsonBackups(
        this.multiReviewsFile(),
        (id, workflow) => isPersistedMultiReviewWorkflow(workflow, id)
          && workflow.environmentId !== environmentId,
      );
    });
  }

  private async loadAgentInteractionResolutionJournal(): Promise<
    AgentInteractionResolutionJournal
  > {
    const stored = await this.loadJson<unknown>(
      this.agentInteractionJournalFile(),
      () => ({ version: AGENT_INTERACTION_JOURNAL_VERSION, entries: [] }),
    );
    if (!isAgentInteractionResolutionJournal(stored)) {
      throw new Error("Stored agent interaction resolution journal is invalid");
    }
    return stored;
  }

  /**
   * Reads under the same lock the writers take. Cleanup is not idempotent
   * against a concurrent update — it reclaims claims by wall-clock age — so an
   * unsynchronized read could return a journal that disagrees with the one an
   * in-flight update is about to persist.
   */
  async getAgentInteractionResolutionJournal(): Promise<
    AgentInteractionResolutionJournal
  > {
    return this.enqueueAgentInteractionJournalMutation(async () =>
      pruneAgentInteractionResolutionJournal(
        await this.loadAgentInteractionResolutionJournal(),
      )
    );
  }

  /**
   * Serializes cross-process journal transitions under one file lock. Callers
   * cannot persist request or answer content because the protocol guard accepts
   * only bounded identities, fences, timestamps, states, and outcomes.
   */
  async updateAgentInteractionResolutionJournal(
    update: (
      journal: AgentInteractionResolutionJournal,
    ) => AgentInteractionResolutionJournal,
  ): Promise<AgentInteractionResolutionJournal> {
    return this.enqueueAgentInteractionJournalMutation(async () => {
      const current = pruneAgentInteractionResolutionJournal(
        await this.loadAgentInteractionResolutionJournal(),
      );
      const next = pruneAgentInteractionResolutionJournal(update(current));
      if (!isAgentInteractionResolutionJournal(next)) {
        throw new Error("Agent interaction resolution journal update is invalid");
      }
      await this.saveSensitiveJson(this.agentInteractionJournalFile(), next);
      return next;
    });
  }

  /**
   * Splits the store into records this build understands and records it does
   * not. Both halves matter: an unreadable record must never be reused, reused
   * as a mapping, or quietly discarded — the latter would destroy a session a
   * newer build wrote and the user could still downgrade back into.
   *
   * Failing the *whole file* on one bad record would take down every native
   * tab in every environment, and would block the environment deletion that is
   * the user's only way to clear it. So the refusal is scoped to the key.
   */
  private async loadNativeAgentSessions(): Promise<LoadedNativeAgentSessions> {
    const stored = await this.loadJson<unknown>(
      this.nativeAgentSessionsFile(),
      () => ({}),
    );
    if (!isRecord(stored)) {
      throw new Error("Stored native agent sessions are invalid");
    }
    const sessions: Record<string, PersistedNativeAgentSession> = {};
    const opaque: Record<string, unknown> = {};
    let migratedAny = false;
    for (const [storedKey, session] of Object.entries(stored)) {
      const migrated = migratePersistedNativeAgentSession(session, storedKey);
      if (!migrated) {
        opaque[storedKey] = session;
        continue;
      }
      if (!isPersistedNativeAgentSession(session, storedKey)) migratedAny = true;
      sessions[storedKey] = migrated;
    }
    return { sessions, opaque, migrated: migratedAny };
  }

  /**
   * Writes the readable records back while preserving every unreadable one
   * byte-for-byte. Persisting `sessions` alone would erase them.
   */
  private async saveNativeAgentSessions(
    sessions: Record<string, PersistedNativeAgentSession>,
    opaque: Record<string, unknown>,
  ): Promise<void> {
    await this.saveSensitiveJson(this.nativeAgentSessionsFile(), {
      ...opaque,
      ...sessions,
    });
  }

  private assertReadableNativeAgentSession(
    loaded: LoadedNativeAgentSessions,
    key: string,
  ): void {
    if (key in loaded.opaque) {
      throw new Error(
        "Stored native agent session metadata is invalid or uses an unsupported version",
      );
    }
  }

  async getNativeAgentSession(
    key: string,
  ): Promise<PersistedNativeAgentSession | null> {
    if (!isNonBlankString(key)) {
      throw new Error("Native agent session key must not be blank");
    }
    // Read without the cross-process lock. `getOrCreateNativeAgentSession`
    // deliberately holds that lock across an external provider create, so
    // taking it here would make a routine tab reattach wait on — and, past the
    // 20s lock deadline, fail against — an unrelated session being created.
    // Only a load that actually migrated something needs to write.
    const loaded = await this.loadNativeAgentSessions();
    if (!loaded.migrated) {
      this.assertReadableNativeAgentSession(loaded, key);
      return loaded.sessions[key] ?? null;
    }
    return this.enqueueNativeAgentSessionMutation(async () => {
      const current = await this.loadNativeAgentSessions();
      if (current.migrated) {
        await this.saveNativeAgentSessions(current.sessions, current.opaque);
      }
      this.assertReadableNativeAgentSession(current, key);
      return current.sessions[key] ?? null;
    });
  }

  /**
   * Backend-owned native session catalogue used by background reconcilers.
   * Keep this internal to the backend command surface: provider session IDs are
   * sensitive implementation details and never need to reach a renderer.
   */
  async listNativeAgentSessions(): Promise<PersistedNativeAgentSession[]> {
    return Object.values((await this.loadNativeAgentSessions()).sessions);
  }

  /**
   * Creates a provider session while holding the same cross-process lock that
   * publishes its logical mapping. OpenCode cannot accept a caller-supplied
   * session id, so releasing the lock between the read and external create
   * would allow two backend processes to create two real provider sessions.
   */
  async getOrCreateNativeAgentSession(
    input: Pick<
      PersistedNativeAgentSession,
      "key" | "environmentId" | "agent" | "logicalSessionKey"
    > & Partial<Pick<
      PersistedNativeAgentSession,
      "origin" | "interactionPolicy" | "controls"
    >>,
    createProviderSession: () => Promise<string>,
  ): Promise<PersistedNativeAgentSession> {
    const interactionMetadata = resolveNativeAgentInteractionMetadata(input);
    if (
      !isNonBlankString(input.key)
      || !isNonBlankString(input.environmentId)
      || !isNonBlankString(input.logicalSessionKey)
      || !isAgentPlatform(input.agent)
      || !interactionMetadata
    ) {
      throw new Error("Native agent session input is invalid");
    }

    return this.enqueueNativeAgentSessionMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(
        input.environmentId,
        "Native agent session",
      );
      const loaded = await this.loadNativeAgentSessions();
      const { sessions, opaque, migrated } = loaded;
      this.assertReadableNativeAgentSession(loaded, input.key);
      const existing = sessions[input.key];
      if (existing) {
        if (
          existing.environmentId !== input.environmentId
          || existing.agent !== input.agent
          || existing.logicalSessionKey !== input.logicalSessionKey
          || (input.origin !== undefined && existing.origin !== input.origin)
          || (
            input.interactionPolicy !== undefined
            && existing.interactionPolicy.mode !== input.interactionPolicy.mode
          )
        ) {
          throw new Error("Native agent session key collision");
        }
        if (migrated) await this.saveNativeAgentSessions(sessions, opaque);
        return existing;
      }

      const providerSessionId = await createProviderSession();
      if (!isNonBlankString(providerSessionId)) {
        throw new Error("Provider returned an invalid native session ID");
      }
      await this.assertEnvironmentAcceptsBackgroundState(
        input.environmentId,
        "Native agent session",
      );
      const now = nowIso();
      const saved: PersistedNativeAgentSession = {
        ...input,
        ...interactionMetadata,
        version: NATIVE_AGENT_SESSION_VERSION,
        providerSessionId,
        createdAt: now,
        updatedAt: now,
      };
      sessions[input.key] = saved;
      await this.saveNativeAgentSessions(sessions, opaque);
      this.announce("native-agent-session", input.environmentId);
      return saved;
    });
  }

  async adoptNativeAgentSession(
    input: Pick<
      PersistedNativeAgentSession,
      | "key"
      | "environmentId"
      | "agent"
      | "logicalSessionKey"
      | "providerSessionId"
    > & Partial<Pick<
      PersistedNativeAgentSession,
      "origin" | "interactionPolicy" | "controls"
    >> & { expectedProviderSessionId?: string },
  ): Promise<PersistedNativeAgentSession> {
    const interactionMetadata = resolveNativeAgentInteractionMetadata(input);
    if (
      !isNonBlankString(input.key)
      || !isNonBlankString(input.environmentId)
      || !isNonBlankString(input.logicalSessionKey)
      || !isNonBlankString(input.providerSessionId)
      || !isAgentPlatform(input.agent)
      || !interactionMetadata
      || (
        input.expectedProviderSessionId !== undefined
        && !isNonBlankString(input.expectedProviderSessionId)
      )
    ) {
      throw new Error("Native agent session adoption input is invalid");
    }
    return this.enqueueNativeAgentSessionMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(
        input.environmentId,
        "Native agent session",
      );
      const loaded = await this.loadNativeAgentSessions();
      const { sessions, opaque, migrated } = loaded;
      this.assertReadableNativeAgentSession(loaded, input.key);
      const existing = sessions[input.key];
      if (existing) {
        if (
          existing.environmentId !== input.environmentId
          || existing.agent !== input.agent
          || existing.logicalSessionKey !== input.logicalSessionKey
          || (input.origin !== undefined && existing.origin !== input.origin)
          || (
            input.interactionPolicy !== undefined
            && existing.interactionPolicy.mode !== input.interactionPolicy.mode
          )
        ) {
          throw new Error("Native agent session key collision");
        }
        if (existing.providerSessionId === input.providerSessionId) {
          /*
           * Resuming in place still reaches the provider with new controls, so
           * returning early without recording them would leave storage
           * disagreeing with the live session and reconstruct the tab with the
           * old model/mode after a restart. Only the controls can change here:
           * the provider session, identity and dispatch records are unchanged.
           */
          const controls = input.controls
            ? { ...existing.controls, ...input.controls }
            : existing.controls;
          if (
            input.controls
            && JSON.stringify(controls) !== JSON.stringify(existing.controls)
          ) {
            const updated: PersistedNativeAgentSession = {
              ...existing,
              controls,
              updatedAt: nowIso(),
            };
            sessions[input.key] = updated;
            await this.saveNativeAgentSessions(sessions, opaque);
            this.announce("native-agent-session", input.environmentId);
            return updated;
          }
          if (migrated) await this.saveNativeAgentSessions(sessions, opaque);
          return existing;
        }
        if (existing.providerSessionId !== input.expectedProviderSessionId) {
          throw new Error("Native agent session provider collision");
        }
      } else if (input.expectedProviderSessionId !== undefined) {
        throw new Error("Native agent session replacement target was not found");
      }

      const now = nowIso();
      const {
        expectedProviderSessionId: _expectedProviderSessionId,
        ...identity
      } = input;
      const saved: PersistedNativeAgentSession = {
        ...identity,
        ...(existing
          ? {
              origin: existing.origin,
              interactionPolicy: existing.interactionPolicy,
              controls: input.controls
                ? { ...existing.controls, ...input.controls }
                : existing.controls,
            }
          : interactionMetadata),
        version: NATIVE_AGENT_SESSION_VERSION,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      sessions[input.key] = saved;
      await this.saveNativeAgentSessions(sessions, opaque);
      if (existing?.pendingDispatch) {
        await this.scrubPendingNativeAgentDispatchBackups(
          input.key,
          existing.pendingDispatch.requestId,
        );
      }
      this.announce("native-agent-session", input.environmentId);
      return saved;
    });
  }

  async updateNativeAgentSessionControls(
    key: string,
    expectedProviderSessionId: string,
    update: import("@orkestrator/protocol/native-agent").NativeAgentControlUpdate,
  ): Promise<PersistedNativeAgentSession> {
    if (!isNonBlankString(key) || !isNonBlankString(expectedProviderSessionId)) {
      throw new Error("Native agent control update identity is invalid");
    }
    return this.enqueueNativeAgentSessionMutation(async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions, opaque } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const existing = sessions[key];
      if (!existing || existing.providerSessionId !== expectedProviderSessionId) {
        throw new Error("Native agent control update target is stale");
      }
      const controls = { ...existing.controls, ...update };
      const updated: PersistedNativeAgentSession = {
        ...existing,
        controls,
        updatedAt: nowIso(),
      };
      sessions[key] = updated;
      await this.saveNativeAgentSessions(sessions, opaque);
      this.announce("native-agent-session", existing.environmentId);
      return updated;
    });
  }

  async invalidateNativeAgentSession(
    key: string,
    providerSessionId: string,
  ): Promise<boolean> {
    if (!isNonBlankString(key) || !isNonBlankString(providerSessionId)) {
      throw new Error("Native agent session identity must not be blank");
    }
    return this.enqueueNativeAgentSessionMutation(async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions, opaque, migrated } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const existing = sessions[key];
      if (!existing || existing.providerSessionId !== providerSessionId) {
        if (migrated) await this.saveNativeAgentSessions(sessions, opaque);
        return false;
      }
      delete sessions[key];
      await this.saveNativeAgentSessions(sessions, opaque);
      await this.scrubSensitiveJsonBackups(
        this.nativeAgentSessionsFile(),
        (storedKey) => storedKey !== key,
      );
      this.announce("native-agent-session", existing.environmentId);
      return true;
    });
  }

  async deleteNativeAgentSessionsByEnvironment(
    environmentId: string,
  ): Promise<void> {
    if (!isNonBlankString(environmentId)) return;
    await this.enqueueNativeAgentSessionMutation(async () => {
      // Deliberately does not refuse an unreadable record. This is the path a
      // user takes to clear one, so it must always complete; unreadable records
      // are simply carried across untouched, since nothing here can prove which
      // environment they belong to.
      const { sessions, opaque, migrated } = await this.loadNativeAgentSessions();
      const retained = Object.fromEntries(
        Object.entries(sessions).filter(
          ([, session]) => session.environmentId !== environmentId,
        ),
      );
      const removed =
        Object.keys(retained).length !== Object.keys(sessions).length;
      if (migrated || removed) {
        await this.saveNativeAgentSessions(retained, opaque);
      }
      // Only a real deletion is worth waking every client for.
      if (removed) this.announce("native-agent-session", environmentId);

      // Rotating the primary file leaves the deleted environment's logical keys,
      // provider session ids and dispatch journal readable in its backups. Scrub
      // unconditionally, as every sibling delete-by-environment does: a prior
      // failed delete may have removed the primary record while leaving a backup.
      await this.scrubSensitiveJsonBackups(
        this.nativeAgentSessionsFile(),
        (storedKey, session) => {
          const readable = migratePersistedNativeAgentSession(session, storedKey);
          if (readable) return readable.environmentId !== environmentId;
          // An unreadable backup record still names its environment in the
          // clear often enough to attribute. Keep the ones that provably belong
          // elsewhere; drop the rest, because a backup that cannot be proven
          // free of the deleted environment's content is not safe to retain.
          return isRecord(session)
            && isNonBlankString(session.environmentId)
            && session.environmentId !== environmentId;
        },
      );
    });
  }

  async dispatchNativeAgentPromptOnce(
    key: string,
    requestId: string,
    dispatch: (
      session: PersistedNativeAgentSession,
    ) => Promise<void | {
      dispatched: false;
      openCodeIncompleteTurnNotice?:
        PersistedNativeAgentSession["openCodeIncompleteTurnNotice"] | null;
    }>,
    pendingDispatch?: PersistedNativeAgentPendingDispatch,
  ): Promise<{
    session: PersistedNativeAgentSession;
    dispatched: boolean;
  }> {
    if (!isNonBlankString(key) || !isNonBlankString(requestId)) {
      throw new Error("Native agent dispatch key must not be blank");
    }
    if (pendingDispatch) {
      let serialized: string;
      try {
        serialized = JSON.stringify(pendingDispatch);
      } catch {
        throw new Error("Pending native agent dispatch must be JSON serializable");
      }
      if (
        Buffer.byteLength(serialized, "utf8")
          > MAX_PERSISTED_NATIVE_AGENT_PENDING_DISPATCH_BYTES
      ) {
        throw new Error("Pending native agent dispatch exceeds the 32 MB limit");
      }
    }
    return this.enqueueNativeAgentSessionMutation(async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions, opaque, migrated } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      let session = sessions[key];
      if (!session) throw new Error("Native agent session was not found");
      if (
        session.pendingDispatch
        && session.pendingDispatch.requestId !== requestId
      ) {
        throw new Error(
          `Native agent dispatch ${session.pendingDispatch.requestId} is still awaiting recovery`,
        );
      }
      if (session.dispatchedRequestIds?.includes(requestId)) {
        if (session.pendingDispatch?.requestId === requestId) {
          session = { ...session, pendingDispatch: undefined, updatedAt: nowIso() };
          sessions[key] = session;
          await this.saveNativeAgentSessions(sessions, opaque);
          await this.scrubPendingNativeAgentDispatchBackups(key, requestId);
        }
        if (migrated) await this.saveNativeAgentSessions(sessions, opaque);
        return { session, dispatched: false };
      }

      if (pendingDispatch) {
        if (pendingDispatch.requestId !== requestId) {
          throw new Error("Pending native agent dispatch request ID mismatch");
        }
        session = {
          ...session,
          pendingDispatch,
          updatedAt: nowIso(),
        };
        sessions[key] = session;
        // Persist before touching the provider. A crash or lost acknowledgement
        // can then replay this exact request through the same idempotency key.
        await this.saveNativeAgentSessions(sessions, opaque);
      }

      // Keep the cross-process lock until the provider has acknowledged this
      // stable request id. If the process dies after provider acceptance but
      // before this write, recovery retries the same id rather than inventing a
      // second turn.
      const outcome = await dispatch(session);
      if (outcome?.dispatched === false) {
        if (outcome.openCodeIncompleteTurnNotice === undefined) {
          if (migrated) await this.saveNativeAgentSessions(sessions, opaque);
          return { session, dispatched: false };
        }
        const updated: PersistedNativeAgentSession = {
          ...session,
          pendingDispatch: undefined,
          ...(outcome.openCodeIncompleteTurnNotice === null
            ? { openCodeIncompleteTurnNotice: undefined }
            : {
                openCodeIncompleteTurnNotice:
                  outcome.openCodeIncompleteTurnNotice,
              }),
          updatedAt: nowIso(),
        };
        sessions[key] = updated;
        await this.saveNativeAgentSessions(sessions, opaque);
        await this.scrubPendingNativeAgentDispatchBackups(key, requestId);
        this.announce("native-agent-session", session.environmentId);
        return { session: updated, dispatched: false };
      }
      const updated: PersistedNativeAgentSession = {
        ...session,
        // Any successfully accepted prompt supersedes a prior recovery notice.
        openCodeIncompleteTurnNotice: undefined,
        pendingDispatch: undefined,
        dispatchedRequestIds: [
          ...(session.dispatchedRequestIds ?? []).slice(-999),
          requestId,
        ],
        updatedAt: nowIso(),
      };
      sessions[key] = updated;
      await this.saveNativeAgentSessions(sessions, opaque);
      await this.scrubPendingNativeAgentDispatchBackups(key, requestId);
      this.announce("native-agent-session", session.environmentId);
      return { session: updated, dispatched: true };
    });
  }

  async clearPendingNativeAgentDispatch(
    key: string,
    requestId: string,
  ): Promise<boolean> {
    if (!isNonBlankString(key) || !isNonBlankString(requestId)) {
      throw new Error("Pending native agent dispatch identity must not be blank");
    }
    return this.enqueueNativeAgentSessionMutation(async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions, opaque, migrated } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (!session || session.pendingDispatch?.requestId !== requestId) {
        if (migrated) await this.saveNativeAgentSessions(sessions, opaque);
        return false;
      }
      sessions[key] = {
        ...session,
        pendingDispatch: undefined,
        updatedAt: nowIso(),
      };
      await this.saveNativeAgentSessions(sessions, opaque);
      await this.scrubPendingNativeAgentDispatchBackups(key, requestId);
      this.announce("native-agent-session", session.environmentId);
      return true;
    });
  }

  async setOpenCodeIncompleteTurnNotice(
    key: string,
    providerSessionId: string,
    notice: PersistedNativeAgentSession["openCodeIncompleteTurnNotice"] | null,
  ): Promise<boolean> {
    if (
      !isNonBlankString(key)
      || !isNonBlankString(providerSessionId)
      || (
        notice !== null
        && (
          !notice
          || !isNonBlankString(notice.assistantMessageId)
          || !["failed", "exhausted"].includes(notice.kind)
          || !Number.isFinite(Date.parse(notice.updatedAt))
        )
      )
    ) {
      throw new Error("OpenCode incomplete-turn notice is invalid");
    }
    return this.enqueueNativeAgentSessionMutation(async () => {
      const loaded = await this.loadNativeAgentSessions();
      const { sessions, opaque, migrated } = loaded;
      this.assertReadableNativeAgentSession(loaded, key);
      const session = sessions[key];
      if (!session || session.providerSessionId !== providerSessionId) {
        if (migrated) await this.saveNativeAgentSessions(sessions, opaque);
        return false;
      }
      if (notice === null && session.openCodeIncompleteTurnNotice === undefined) {
        if (migrated) await this.saveNativeAgentSessions(sessions, opaque);
        return true;
      }
      const updated: PersistedNativeAgentSession = {
        ...session,
        openCodeIncompleteTurnNotice: notice ?? undefined,
        updatedAt: nowIso(),
      };
      sessions[key] = updated;
      await this.saveNativeAgentSessions(sessions, opaque);
      this.announce("native-agent-session", session.environmentId);
      return true;
    });
  }

  /**
   * Orders outbound provider work against environment deletion intent across
   * processes. The callback intentionally runs while the environment file lock
   * is held so deletion either becomes visible first or waits for the accepted
   * provider operation to finish.
   */
  async runWithLiveEnvironment<T>(
    environmentId: string,
    label: string,
    operation: (environment: Environment) => Promise<T>,
  ): Promise<T> {
    if (!isNonBlankString(environmentId)) {
      throw new Error(`${label} environment ID must not be blank`);
    }
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      const environment = environments.find(
        (candidate) => candidate.id === environmentId,
      );
      if (!environment) {
        throw new Error(`${label} environment not found: ${environmentId}`);
      }
      if (environment.deletionRequestedAt) {
        throw new Error(`${label} environment is being deleted: ${environmentId}`);
      }
      return operation(environment);
    });
  }

  private enqueuePromptQueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.promptQueuesFile(),
        "prompt queue storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.promptQueueMutation.then(run, run);
    this.promptQueueMutation = next.then(() => undefined, () => undefined);
    return next;
  }

  private validatePromptQueueMessages(messages: unknown): asserts messages is unknown[] {
    if (!Array.isArray(messages)) {
      throw new Error("Prompt queue messages must be an array");
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(messages);
    } catch {
      throw new Error("Prompt queue messages must be JSON serializable");
    }
    if (serialized === undefined) {
      throw new Error("Prompt queue messages must be JSON serializable");
    }
    // Queued prompts carry pasted image attachments, so the ceiling has to be
    // generous; it exists to stop a runaway client, not to bound normal use.
    if (Buffer.byteLength(serialized, "utf8") > 32 * 1024 * 1024) {
      throw new Error("Prompt queue exceeds the 32 MB limit");
    }
  }

  private validatePromptQueueMessage(message: unknown): asserts message is Record<string, unknown> {
    if (!isRecord(message) || !isNonBlankString(message.id)) {
      throw new Error("Prompt queue message must have a non-blank ID");
    }
    this.validatePromptQueueMessages([message]);
  }

  private async savePromptQueueMutation(
    queues: Record<string, PersistedPromptQueue>,
    queueKey: string,
    environmentId: string,
    messages: unknown[],
    previous?: PersistedPromptQueue,
    outstandingClaim: PersistedPromptQueue["outstandingClaim"] | null
      = previous?.outstandingClaim ?? null,
  ): Promise<PersistedPromptQueue> {
    this.validatePromptQueueMessages(messages);
    const failedMessageStillUnchanged = previous?.dispatchError !== undefined
      && messages.some((candidate) =>
        isRecord(candidate)
        && candidate.id === previous.dispatchError?.messageId
        && this.promptQueueMessageFingerprint(candidate)
          === previous.dispatchError?.messageFingerprint
      );
    const saved: PersistedPromptQueue = {
      queueKey,
      environmentId,
      messages,
      ...(previous?.inFlight ? { inFlight: previous.inFlight } : {}),
      ...(failedMessageStillUnchanged
        ? { dispatchError: previous!.dispatchError }
        : {}),
      ...(outstandingClaim ? { outstandingClaim } : {}),
      updatedAt: nowIso(),
      revision: (previous?.revision ?? 0) + 1,
    };
    queues[queueKey] = saved;
    await this.saveSensitiveJson(this.promptQueuesFile(), queues);
    this.announce("prompt-queue", environmentId);
    this.schedulePromptQueueClaimRecovery(queues);
    return saved;
  }

  private schedulePromptQueueClaimRecovery(
    queues: Record<string, PersistedPromptQueue>,
  ): void {
    if (this.promptQueueClaimRecoveryTimer) {
      clearTimeout(this.promptQueueClaimRecoveryTimer);
      this.promptQueueClaimRecoveryTimer = null;
    }
    const nextExpiry = Object.values(queues).reduce<number | null>((soonest, queue) => {
      if (!queue.outstandingClaim) return soonest;
      const expiry = Date.parse(queue.outstandingClaim.expiresAt);
      if (!Number.isFinite(expiry)) return soonest;
      return soonest === null || expiry < soonest ? expiry : soonest;
    }, null);
    if (nextExpiry === null) return;
    this.promptQueueClaimRecoveryTimer = setTimeout(() => {
      this.promptQueueClaimRecoveryTimer = null;
      void this.recoverExpiredPromptQueueClaims().catch(() => {
        // A future read, mutation, or backend restart retries recovery. Avoid
        // logging queue errors because their values may contain prompt data.
      });
    }, Math.max(0, nextExpiry - Date.now()));
    this.promptQueueClaimRecoveryTimer.unref?.();
  }

  private async recoverExpiredPromptQueueClaims(): Promise<void> {
    await this.enqueuePromptQueueMutation(async () => {
      const queues = await this.loadPromptQueues();
      const now = Date.now();
      const changedEnvironmentIds = new Set<string>();
      let changed = false;
      for (const queue of Object.values(queues)) {
        const claim = queue.outstandingClaim;
        if (!claim || Date.parse(claim.expiresAt) > now) continue;
        const messageId = isRecord(claim.message) ? claim.message.id : undefined;
        queue.messages = [
          claim.message,
          ...queue.messages.filter((candidate) =>
            messageId === undefined
            || !isRecord(candidate)
            || candidate.id !== messageId
          ),
        ];
        delete queue.outstandingClaim;
        queue.updatedAt = nowIso();
        queue.revision += 1;
        changedEnvironmentIds.add(queue.environmentId);
        changed = true;
      }
      if (changed) {
        await this.saveSensitiveJson(this.promptQueuesFile(), queues);
        for (const environmentId of changedEnvironmentIds) {
          this.announce("prompt-queue", environmentId);
        }
      }
      this.schedulePromptQueueClaimRecovery(queues);
    });
  }

  private async assertEnvironmentAcceptsBackgroundState(
    environmentId: string,
    label: string,
  ): Promise<Environment> {
    const environment = await this.getEnvironment(environmentId);
    if (!environment) {
      throw new Error(`${label} environment not found: ${environmentId}`);
    }
    if (environment.deletionRequestedAt) {
      throw new Error(`${label} environment is being deleted: ${environmentId}`);
    }
    return environment;
  }

  private async loadPromptQueues(): Promise<Record<string, PersistedPromptQueue>> {
    const stored = await this.loadJson<Record<string, PersistedPromptQueue>>(
      this.promptQueuesFile(),
      () => ({}),
    );
    return Object.fromEntries(
      Object.entries(stored).flatMap(([storedKey, queue]) => {
        if (!isPersistedPromptQueue(queue, storedKey)) return [];
        if (
          !queue.dispatchError
          || (
            isNonBlankString(queue.dispatchError.messageId)
            && isNonBlankString(queue.dispatchError.messageFingerprint)
          )
        ) {
          return [[storedKey, queue]];
        }

        // Records written by the first dispatch-error implementation did not
        // identify the rejected queue item. Upgrade those in memory from the
        // restored message so the first subsequent mutation gets the same
        // edit/removal semantics as a newly written record.
        const failedMessage = queue.messages.find((candidate) =>
          isRecord(candidate)
          && candidate.id === queue.dispatchError?.requestId
        );
        if (!isRecord(failedMessage) || !isNonBlankString(failedMessage.id)) {
          const { dispatchError: _dispatchError, ...withoutError } = queue;
          return [[storedKey, withoutError as PersistedPromptQueue]];
        }
        return [[storedKey, {
          ...queue,
          dispatchError: {
            ...queue.dispatchError,
            messageId: failedMessage.id,
            messageFingerprint: this.promptQueueMessageFingerprint(failedMessage),
          },
        }]];
      }),
    ) as Record<string, PersistedPromptQueue>;
  }

  async getPromptQueue(queueKey: string): Promise<PersistedPromptQueue | null> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    return (await this.loadPromptQueues())[queueKey] ?? null;
  }

  async listPromptQueues(environmentId: string): Promise<PersistedPromptQueue[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    return Object.values(await this.loadPromptQueues())
      .filter((queue) => queue.environmentId === environmentId);
  }

  async listAllPromptQueues(): Promise<PersistedPromptQueue[]> {
    return Object.values(await this.loadPromptQueues());
  }

  /**
   * Replaces a tab's queue wholesale under a compare-and-swap revision.
   *
   * Whole-list writes rather than per-item operations because the contended
   * operation is "take the head and send it": two clients doing that must not
   * both win, and a revision check is the cheapest way to guarantee exactly one
   * does. The queue is a handful of messages, so rewriting it costs nothing.
   */
  async savePromptQueue(
    queueKey: string,
    environmentId: string,
    messages: unknown[],
    expectedRevision?: number,
  ): Promise<PersistedPromptQueue> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    assertPromptQueueKeyOwner(queueKey, environmentId);
    this.validatePromptQueueMessages(messages);
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Prompt queue expected revision must be a non-negative integer");
    }

    return this.enqueuePromptQueueMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Prompt queue");
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (previous && previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      if (
        expectedRevision !== undefined
        && (previous?.revision ?? 0) !== expectedRevision
      ) {
        throw new Error("Prompt queue revision conflict");
      }
      return this.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        messages,
        previous,
      );
    });
  }

  /**
   * Appends one prompt atomically.
   *
   * Renderers never replace the queue: they submit intent-level mutations and
   * consume the returned snapshot. This preserves concurrent appends from
   * multiple clients instead of letting the last whole-list write win.
   */
  async enqueuePromptQueueMessage(
    queueKey: string,
    environmentId: string,
    message: unknown,
  ): Promise<PersistedPromptQueue> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    assertPromptQueueKeyOwner(queueKey, environmentId);
    this.validatePromptQueueMessage(message);

    return this.enqueuePromptQueueMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Prompt queue");
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (previous && previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      if (
        (
          isRecord(previous?.outstandingClaim?.message)
          && previous.outstandingClaim.message.id === message.id
        )
        || previous?.messages.some((candidate) =>
          isRecord(candidate) && candidate.id === message.id
        )
      ) {
        return previous;
      }
      return this.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        [...(previous?.messages ?? []), message],
        previous,
      );
    });
  }

  /**
   * Inserts a previously claimed prompt back at the head when a renderer
   * discovers that its agent sender is no longer ready.
   */
  async requeuePromptQueueMessage(
    queueKey: string,
    environmentId: string,
    message: unknown,
  ): Promise<PersistedPromptQueue> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    assertPromptQueueKeyOwner(queueKey, environmentId);
    this.validatePromptQueueMessage(message);

    return this.enqueuePromptQueueMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Prompt queue");
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (previous && previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      if (
        previous?.outstandingClaim
        && isRecord(previous.outstandingClaim.message)
        && previous.outstandingClaim.message.id === message.id
      ) {
        return this.savePromptQueueMutation(
          queues,
          queueKey,
          environmentId,
          [message, ...previous.messages.filter((candidate) =>
            !isRecord(candidate) || candidate.id !== message.id
          )],
          previous,
          null,
        );
      }
      if (previous?.messages.some((candidate) =>
        isRecord(candidate) && candidate.id === message.id
      )) {
        return previous;
      }
      return this.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        [message, ...(previous?.messages ?? [])],
        previous,
      );
    });
  }

  async removePromptQueueMessage(
    queueKey: string,
    environmentId: string,
    messageId: string,
  ): Promise<{ removed: unknown | null; queue: PersistedPromptQueue | null }> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    if (!isNonBlankString(messageId)) {
      throw new Error("Prompt queue message ID must not be blank");
    }

    return this.enqueuePromptQueueMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Prompt queue");
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous) return { removed: null, queue: null };
      if (previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      const index = previous.messages.findIndex((candidate) =>
        isRecord(candidate) && candidate.id === messageId
      );
      if (index < 0) return { removed: null, queue: previous };
      const messages = [...previous.messages];
      const [removed] = messages.splice(index, 1);
      const queue = await this.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        messages,
        previous,
      );
      return { removed: removed ?? null, queue };
    });
  }

  async movePromptQueueMessage(
    queueKey: string,
    environmentId: string,
    messageId: string,
    direction: "up" | "down",
  ): Promise<PersistedPromptQueue | null> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    if (!isNonBlankString(messageId)) {
      throw new Error("Prompt queue message ID must not be blank");
    }
    if (direction !== "up" && direction !== "down") {
      throw new Error("Prompt queue move direction must be up or down");
    }

    return this.enqueuePromptQueueMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Prompt queue");
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous) return null;
      if (previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      const index = previous.messages.findIndex((candidate) =>
        isRecord(candidate) && candidate.id === messageId
      );
      const target = direction === "up" ? index - 1 : index + 1;
      if (index < 0 || target < 0 || target >= previous.messages.length) {
        return previous;
      }
      const messages = [...previous.messages];
      [messages[index], messages[target]] = [messages[target], messages[index]];
      return this.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        messages,
        previous,
      );
    });
  }

  async claimPromptQueueHead(
    queueKey: string,
    environmentId: string,
    expectedMessageId: string,
  ): Promise<{
    claimed: unknown | null;
    claimToken: string | null;
    queue: PersistedPromptQueue | null;
  }> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    assertPromptQueueKeyOwner(queueKey, environmentId);
    if (!isNonBlankString(expectedMessageId)) {
      throw new Error("Expected prompt message ID must not be blank");
    }
    return this.enqueuePromptQueueMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Prompt queue");
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (previous && previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      if (previous?.dispatchError) {
        return { claimed: null, claimToken: null, queue: previous };
      }

      let current = previous;
      if (current?.outstandingClaim) {
        const expiresAt = Date.parse(current.outstandingClaim.expiresAt);
        if (expiresAt > Date.now()) {
          return { claimed: null, claimToken: null, queue: current };
        }
        const recoveredMessage = current.outstandingClaim.message;
        const recoveredId = isRecord(recoveredMessage) ? recoveredMessage.id : undefined;
        const recoveredMessages = [
          recoveredMessage,
          ...current.messages.filter((candidate) =>
            recoveredId === undefined
            || !isRecord(candidate)
            || candidate.id !== recoveredId
          ),
        ];
        current = await this.savePromptQueueMutation(
          queues,
          queueKey,
          environmentId,
          recoveredMessages,
          current,
          null,
        );
      }

      const messages = current?.messages ?? [];
      const head = messages[0];
      if (
        !isRecord(head)
        || head.id !== expectedMessageId
      ) {
        return { claimed: null, claimToken: null, queue: current ?? null };
      }

      const claimedAt = new Date();
      const claimToken = randomUUID();
      const saved = await this.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        messages.slice(1),
        current,
        {
          token: claimToken,
          message: head,
          claimedAt: claimedAt.toISOString(),
          expiresAt: new Date(
            claimedAt.getTime() + this.promptQueueClaimLeaseMs,
          ).toISOString(),
        },
      );
      return { claimed: head, claimToken, queue: saved };
    });
  }

  async reservePromptQueueHeadForDispatch(
    queueKey: string,
  ): Promise<PersistedPromptQueue["inFlight"] | null> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    return this.enqueuePromptQueueMutation(async () => {
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous) return null;
      if (previous.dispatchError) return null;
      if (previous.inFlight) return previous.inFlight;
      if (previous.outstandingClaim) return null;
      const message = previous.messages[0];
      if (!isRecord(message) || !isNonBlankString(message.id)) return null;
      const inFlight = {
        message,
        requestId:
          isNonBlankString(message.requestId) ? message.requestId : message.id,
        reservedAt: nowIso(),
      };
      const saved: PersistedPromptQueue = {
        ...previous,
        messages: previous.messages.slice(1),
        inFlight,
        updatedAt: nowIso(),
        revision: previous.revision + 1,
      };
      queues[queueKey] = saved;
      await this.saveSensitiveJson(this.promptQueuesFile(), queues);
      this.announce("prompt-queue", previous.environmentId);
      return inFlight;
    });
  }

  async acknowledgePromptQueueDispatch(
    queueKey: string,
    requestId: string,
  ): Promise<PersistedPromptQueue | null> {
    return this.enqueuePromptQueueMutation(async () => {
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous?.inFlight || previous.inFlight.requestId !== requestId) {
        return previous ?? null;
      }
      const { inFlight: _inFlight, ...withoutInFlight } = previous;
      const saved: PersistedPromptQueue = {
        ...withoutInFlight,
        updatedAt: nowIso(),
        revision: previous.revision + 1,
      };
      queues[queueKey] = saved;
      await this.saveSensitiveJson(this.promptQueuesFile(), queues);
      this.announce("prompt-queue", previous.environmentId);
      return saved;
    });
  }

  /**
   * Durably fences an in-flight prompt before crossing the irreversible tmux
   * submit boundary. If the backend dies after this write, recovery must treat
   * the outcome as ambiguous rather than submitting the prompt again.
   */
  async markPromptQueueDispatchSubmitting(
    queueKey: string,
    requestId: string,
  ): Promise<PersistedPromptQueue | null> {
    return this.markPromptQueueDispatchBoundary(queueKey, requestId, "submittingAt");
  }

  /** Records that tmux accepted a fenced prompt so acknowledgement can retry safely. */
  async markPromptQueueDispatchSubmitted(
    queueKey: string,
    requestId: string,
  ): Promise<PersistedPromptQueue | null> {
    return this.markPromptQueueDispatchBoundary(queueKey, requestId, "submittedAt");
  }

  private markPromptQueueDispatchBoundary(
    queueKey: string,
    requestId: string,
    field: "submittingAt" | "submittedAt",
  ): Promise<PersistedPromptQueue | null> {
    if (!isNonBlankString(queueKey) || !isNonBlankString(requestId)) {
      throw new Error("Prompt queue dispatch identity must not be blank");
    }
    return this.enqueuePromptQueueMutation(async () => {
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous?.inFlight || previous.inFlight.requestId !== requestId) {
        return previous ?? null;
      }
      if (field === "submittedAt" && previous.inFlight.submittingAt === undefined) {
        throw new Error("Prompt queue dispatch was not fenced before submission");
      }
      if (previous.inFlight[field] !== undefined) return previous;
      const saved: PersistedPromptQueue = {
        ...previous,
        inFlight: {
          ...previous.inFlight,
          [field]: nowIso(),
        },
        updatedAt: nowIso(),
        revision: previous.revision + 1,
      };
      queues[queueKey] = saved;
      await this.saveSensitiveJson(this.promptQueuesFile(), queues);
      this.announce("prompt-queue", previous.environmentId);
      return saved;
    });
  }

  async failPromptQueueDispatch(
    queueKey: string,
    requestId: string,
    message = "Queued prompt was rejected. Edit it or retry explicitly.",
  ): Promise<PersistedPromptQueue | null> {
    if (
      !isNonBlankString(queueKey)
      || !isNonBlankString(requestId)
      || !isNonBlankString(message)
    ) {
      throw new Error("Prompt queue failure identity must not be blank");
    }
    return this.enqueuePromptQueueMutation(async () => {
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous?.inFlight || previous.inFlight.requestId !== requestId) {
        return previous ?? null;
      }
      const { inFlight, ...withoutInFlight } = previous;
      if (!isRecord(inFlight.message) || !isNonBlankString(inFlight.message.id)) {
        return previous;
      }
      const saved: PersistedPromptQueue = {
        ...withoutInFlight,
        messages: [inFlight.message, ...previous.messages],
        dispatchError: {
          requestId,
          messageId: inFlight.message.id,
          messageFingerprint: this.promptQueueMessageFingerprint(inFlight.message),
          message,
          failedAt: nowIso(),
        },
        updatedAt: nowIso(),
        revision: previous.revision + 1,
      };
      queues[queueKey] = saved;
      await this.saveSensitiveJson(this.promptQueuesFile(), queues);
      this.announce("prompt-queue", previous.environmentId);
      return saved;
    });
  }

  async retryPromptQueueDispatch(
    queueKey: string,
  ): Promise<PersistedPromptQueue | null> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    return this.enqueuePromptQueueMutation(async () => {
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous?.dispatchError) return previous ?? null;
      const { dispatchError: _dispatchError, ...withoutError } = previous;
      const saved: PersistedPromptQueue = {
        ...withoutError,
        updatedAt: nowIso(),
        revision: previous.revision + 1,
      };
      queues[queueKey] = saved;
      await this.saveSensitiveJson(this.promptQueuesFile(), queues);
      this.announce("prompt-queue", previous.environmentId);
      return saved;
    });
  }

  private promptQueueMessageFingerprint(message: unknown): string {
    return createHash("sha256").update(JSON.stringify(message)).digest("hex");
  }

  async acknowledgePromptQueueClaim(
    queueKey: string,
    environmentId: string,
    claimToken: string,
  ): Promise<PersistedPromptQueue | null> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    if (!isNonBlankString(claimToken)) {
      throw new Error("Prompt queue claim token must not be blank");
    }
    return this.enqueuePromptQueueMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Prompt queue");
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous) return null;
      if (previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      if (!previous.outstandingClaim) return previous;
      if (previous.outstandingClaim.token !== claimToken) {
        throw new Error("Prompt queue claim token does not match");
      }
      return this.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        previous.messages,
        previous,
        null,
      );
    });
  }

  async rejectPromptQueueClaim(
    queueKey: string,
    environmentId: string,
    claimToken: string,
  ): Promise<PersistedPromptQueue | null> {
    if (!isNonBlankString(queueKey)) {
      throw new Error("Prompt queue key must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    if (!isNonBlankString(claimToken)) {
      throw new Error("Prompt queue claim token must not be blank");
    }
    return this.enqueuePromptQueueMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Prompt queue");
      const queues = await this.loadPromptQueues();
      const previous = queues[queueKey];
      if (!previous) return null;
      if (previous.environmentId !== environmentId) {
        throw new Error("Prompt queue belongs to another environment");
      }
      if (!previous.outstandingClaim) return previous;
      if (previous.outstandingClaim.token !== claimToken) {
        throw new Error("Prompt queue claim token does not match");
      }
      const message = previous.outstandingClaim.message;
      const messageId = isRecord(message) ? message.id : undefined;
      return this.savePromptQueueMutation(
        queues,
        queueKey,
        environmentId,
        [
          message,
          ...previous.messages.filter((candidate) =>
            messageId === undefined
            || !isRecord(candidate)
            || candidate.id !== messageId
          ),
        ],
        previous,
        null,
      );
    });
  }

  /**
   * Moves one queued message into an authoritative compose draft without a
   * loss window. The draft is committed before the queue removal while both
   * stores are locked. Bounded provenance on the draft makes a retry finish
   * the removal after a process death or queue-write failure, while unrelated
   * existing drafts remain protected.
   */
  async transferPromptQueueMessageToComposeDraft(
    queueKey: string,
    environmentId: string,
    messageId: string,
    draftKey: string,
    ownerType: "environment" | "project",
    ownerId: string,
    expectedDraftRevision?: number,
  ): Promise<{
    removed: unknown | null;
    queue: PersistedPromptQueue | null;
    draft: PersistedComposeDraft | null;
  }> {
    if (!isNonBlankString(queueKey)) throw new Error("Prompt queue key must not be blank");
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    if (!isNonBlankString(messageId)) {
      throw new Error("Prompt queue message ID must not be blank");
    }
    if (Buffer.byteLength(queueKey, "utf8") > MAX_PROMPT_QUEUE_SOURCE_KEY_BYTES) {
      throw new Error("Prompt queue transfer key is too large");
    }
    if (
      Buffer.byteLength(messageId, "utf8")
      > MAX_PROMPT_QUEUE_SOURCE_MESSAGE_ID_BYTES
    ) {
      throw new Error("Prompt queue transfer message ID is too large");
    }
    if (!isNonBlankString(draftKey)) throw new Error("Compose draft key must not be blank");
    if (ownerType !== "environment" && ownerType !== "project") {
      throw new Error("Compose draft owner type is invalid");
    }
    if (!isNonBlankString(ownerId)) throw new Error("Compose draft owner ID must not be blank");
    if (expectedDraftRevision !== undefined && !isNonNegativeInteger(expectedDraftRevision)) {
      throw new Error("Compose draft expected revision must be a non-negative integer");
    }
    return this.enqueuePromptQueueMutation(async () =>
      this.enqueueComposeDraftMutation(async () => {
        const environment = await this.assertEnvironmentAcceptsBackgroundState(
          environmentId,
          "Prompt queue",
        );
        if (
          (ownerType === "environment" && ownerId !== environmentId)
          || (ownerType === "project" && ownerId !== environment.projectId)
        ) {
          throw new Error("Compose draft owner does not own the prompt queue");
        }
        const queues = await this.loadPromptQueues();
        const previousQueue = queues[queueKey];
        if (!previousQueue) {
          return { removed: null, queue: null, draft: null };
        }
        if (previousQueue.environmentId !== environmentId) {
          throw new Error("Prompt queue belongs to another environment");
        }
        const messageIndex = previousQueue.messages.findIndex((candidate) =>
          isRecord(candidate) && candidate.id === messageId
        );
        if (messageIndex < 0) {
          return { removed: null, queue: previousQueue, draft: null };
        }
        const authoritativeMessage = previousQueue.messages[messageIndex];
        if (
          !isRecord(authoritativeMessage)
          || typeof authoritativeMessage.text !== "string"
          || !Array.isArray(authoritativeMessage.attachments)
        ) {
          throw new Error(
            "Queued prompt must have text and attachments before transfer",
          );
        }
        const value = {
          text: authoritativeMessage.text,
          mentions: [],
          attachments: authoritativeMessage.attachments,
        };

        const drafts = await this.loadComposeDrafts();
        const previousDraft = drafts[draftKey];
        let draft: PersistedComposeDraft;
        if (previousDraft) {
          if (
            previousDraft.ownerType !== ownerType
            || previousDraft.ownerId !== ownerId
          ) {
            throw new Error("Compose draft belongs to another owner");
          }
          if (
            previousDraft.sourcePromptQueue?.queueKey !== queueKey
            || previousDraft.sourcePromptQueue.messageId !== messageId
          ) {
            throw new Error("Compose draft already exists");
          }
          draft = previousDraft;
        } else {
          if (expectedDraftRevision !== undefined && expectedDraftRevision !== 0) {
            throw new Error("Compose draft revision conflict");
          }
          draft = {
            draftKey,
            ownerType,
            ownerId,
            value,
            sourcePromptQueue: { queueKey, messageId },
            updatedAt: nowIso(),
            revision: 1,
          };
          drafts[draftKey] = draft;
          await this.saveSensitiveJson(this.composeDraftsFile(), drafts);
          this.announce("compose-draft", ownerId);
        }

        const messages = [...previousQueue.messages];
        const [removed] = messages.splice(messageIndex, 1);
        const queue = await this.savePromptQueueMutation(
          queues,
          queueKey,
          environmentId,
          messages,
          previousQueue,
        );
        return { removed: removed ?? null, queue, draft };
      })
    );
  }

  async deletePromptQueuesByEnvironment(environmentId: string): Promise<string[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Prompt queue environment ID must not be blank");
    }
    return this.enqueuePromptQueueMutation(async () => {
      const queues = await this.loadPromptQueues();
      const removedKeys = Object.values(queues)
        .filter((queue) => queue.environmentId === environmentId)
        .map((queue) => queue.queueKey);
      if (removedKeys.length > 0) {
        for (const key of removedKeys) delete queues[key];
        await this.saveSensitiveJson(this.promptQueuesFile(), queues);
        this.announce("prompt-queue", environmentId);
      }
      this.schedulePromptQueueClaimRecovery(queues);

      // Queued prompts carry user-authored text and pasted attachments, and
      // rotating the primary file leaves them readable in its backups. Always
      // scrub, even when the current primary has no matching record: a prior
      // failed delete may have removed the primary while leaving a backup.
      await this.scrubSensitiveJsonBackups(
        this.promptQueuesFile(),
        (storedKey, queue) =>
          isPersistedPromptQueue(queue, storedKey)
          && queue.environmentId !== environmentId,
      );
      return removedKeys;
    });
  }

  private enqueueComposeDraftMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.composeDraftsFile(),
        "compose draft storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.composeDraftMutation.then(run, run);
    this.composeDraftMutation = next.then(() => undefined, () => undefined);
    return next;
  }

  private validComposeDrafts(
    stored: unknown,
  ): Record<string, PersistedComposeDraft> {
    if (!isRecord(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(([storedKey, draft]) =>
        isPersistedComposeDraft(draft, storedKey)
      ),
    ) as Record<string, PersistedComposeDraft>;
  }

  private async loadComposeDrafts(): Promise<Record<string, PersistedComposeDraft>> {
    const stored = await this.loadJson<unknown>(this.composeDraftsFile(), () => ({}));
    return this.validComposeDrafts(stored);
  }

  async getComposeDraft(draftKey: string): Promise<PersistedComposeDraft | null> {
    if (!isNonBlankString(draftKey)) throw new Error("Compose draft key must not be blank");
    return (await this.loadComposeDrafts())[draftKey] ?? null;
  }

  async listComposeDrafts(
    ownerType: "environment" | "project",
    ownerId: string,
  ): Promise<PersistedComposeDraft[]> {
    if (ownerType !== "environment" && ownerType !== "project") {
      throw new Error("Compose draft owner type is invalid");
    }
    if (!isNonBlankString(ownerId)) {
      throw new Error("Compose draft owner ID must not be blank");
    }
    return Object.values(await this.loadComposeDrafts())
      .filter((draft) => draft.ownerType === ownerType && draft.ownerId === ownerId);
  }

  async saveComposeDraft(
    draftKey: string,
    ownerType: "environment" | "project",
    ownerId: string,
    value: unknown,
    expectedRevision?: number,
  ): Promise<PersistedComposeDraft> {
    if (!isNonBlankString(draftKey)) throw new Error("Compose draft key must not be blank");
    if (ownerType !== "environment" && ownerType !== "project") {
      throw new Error("Compose draft owner type is invalid");
    }
    if (!isNonBlankString(ownerId)) {
      throw new Error("Compose draft owner ID must not be blank");
    }
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Compose draft expected revision must be a non-negative integer");
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new Error("Compose draft value must be JSON serializable");
    }
    if (
      serialized === undefined
      || Buffer.byteLength(serialized, "utf8") > 32 * 1024 * 1024
    ) {
      throw new Error("Compose draft exceeds the 32 MB limit");
    }

    return this.enqueueComposeDraftMutation(async () => {
      if (ownerType === "environment") {
        await this.assertEnvironmentAcceptsBackgroundState(ownerId, "Compose draft");
      } else if (!await this.getProject(ownerId)) {
        throw new Error(`Compose draft project not found: ${ownerId}`);
      }
      const drafts = await this.loadComposeDrafts();
      const previous = drafts[draftKey];
      if (
        previous
        && (previous.ownerType !== ownerType || previous.ownerId !== ownerId)
      ) {
        throw new Error("Compose draft belongs to another owner");
      }
      if (
        expectedRevision !== undefined
        && (previous?.revision ?? 0) !== expectedRevision
      ) {
        throw new Error("Compose draft revision conflict");
      }
      const saved: PersistedComposeDraft = {
        draftKey,
        ownerType,
        ownerId,
        value,
        ...(previous?.sourcePromptQueue
          ? { sourcePromptQueue: previous.sourcePromptQueue }
          : {}),
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
      };
      drafts[draftKey] = saved;
      await this.saveSensitiveJson(this.composeDraftsFile(), drafts);
      this.announce("compose-draft", ownerId);
      return saved;
    });
  }

  async deleteComposeDraft(
    draftKey: string,
    expectedRevision?: number,
  ): Promise<void> {
    if (!isNonBlankString(draftKey)) throw new Error("Compose draft key must not be blank");
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Compose draft expected revision must be a non-negative integer");
    }
    await this.enqueueComposeDraftMutation(async () => {
      const stored = await this.loadJson<unknown>(this.composeDraftsFile(), () => ({}));
      const drafts = this.validComposeDrafts(stored);
      const previous = drafts[draftKey];
      if (
        previous
        && expectedRevision !== undefined
        && previous.revision !== expectedRevision
      ) {
        throw new Error("Compose draft revision conflict");
      }
      const hasStoredKey = isRecord(stored) && Object.hasOwn(stored, draftKey);
      if (hasStoredKey) {
        delete drafts[draftKey];
        await this.saveSensitiveJson(this.composeDraftsFile(), drafts);
      }
      if (previous) {
        this.announce("compose-draft", previous.ownerId);
      }
      // Always scrub backups, including when the primary no longer contains
      // the key. A prior interrupted delete may have committed the primary
      // write without sanitizing the retained copies.
      await this.scrubSensitiveJsonBackups(
        this.composeDraftsFile(),
        (storedKey, draft) =>
          storedKey !== draftKey && isPersistedComposeDraft(draft, storedKey),
      );
    });
  }

  async deleteComposeDraftsByEnvironment(environmentId: string): Promise<void> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Compose draft environment ID must not be blank");
    }
    await this.enqueueComposeDraftMutation(async () => {
      const drafts = await this.loadComposeDrafts();
      const keys = Object.values(drafts)
        .filter((draft) =>
          draft.ownerType === "environment" && draft.ownerId === environmentId
        )
        .map((draft) => draft.draftKey);
      for (const key of keys) delete drafts[key];
      if (keys.length > 0) {
        await this.saveSensitiveJson(this.composeDraftsFile(), drafts);
        this.announce("compose-draft", environmentId);
      }
      await this.scrubSensitiveJsonBackups(
        this.composeDraftsFile(),
        (storedKey, draft) =>
          isPersistedComposeDraft(draft, storedKey)
          && (
            draft.ownerType !== "environment"
            || draft.ownerId !== environmentId
          ),
      );
    });
  }

  async deleteComposeDraftsByProject(projectId: string): Promise<void> {
    if (!isNonBlankString(projectId)) {
      throw new Error("Compose draft project ID must not be blank");
    }
    await this.enqueueComposeDraftMutation(async () => {
      const drafts = await this.loadComposeDrafts();
      const keys = Object.values(drafts)
        .filter((draft) => draft.ownerType === "project" && draft.ownerId === projectId)
        .map((draft) => draft.draftKey);
      for (const key of keys) delete drafts[key];
      if (keys.length > 0) {
        await this.saveSensitiveJson(this.composeDraftsFile(), drafts);
        this.announce("compose-draft", projectId);
      }
      await this.scrubSensitiveJsonBackups(
        this.composeDraftsFile(),
        (storedKey, draft) =>
          isPersistedComposeDraft(draft, storedKey)
          && (draft.ownerType !== "project" || draft.ownerId !== projectId),
      );
    });
  }

  private enqueueFileDraftMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.fileDraftsFile(),
        "file draft storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.fileDraftMutation.then(run, run);
    this.fileDraftMutation = next.then(() => undefined, () => undefined);
    return next;
  }

  private validFileDrafts(stored: unknown): Record<string, PersistedFileDraft> {
    if (!isRecord(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(([storedKey, draft]) =>
        isPersistedFileDraft(draft, storedKey)
      ),
    ) as Record<string, PersistedFileDraft>;
  }

  private async loadFileDrafts(): Promise<Record<string, PersistedFileDraft>> {
    const stored = await this.loadJson<unknown>(this.fileDraftsFile(), () => ({}));
    return this.validFileDrafts(stored);
  }

  async getFileDraft(draftKey: string): Promise<PersistedFileDraft | null> {
    if (!isNonBlankString(draftKey)) throw new Error("File draft key must not be blank");
    return (await this.loadFileDrafts())[draftKey] ?? null;
  }

  async saveFileDraft(
    draftKey: string,
    environmentId: string,
    filePath: string,
    content: string,
    originalContent: string,
    expectedRevision?: number,
  ): Promise<PersistedFileDraft> {
    if (!isNonBlankString(draftKey)) throw new Error("File draft key must not be blank");
    if (!isNonBlankString(environmentId)) {
      throw new Error("File draft environment ID must not be blank");
    }
    if (!isNonBlankString(filePath)) throw new Error("File draft path must not be blank");
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("File draft expected revision must be a non-negative integer");
    }
    const size = Buffer.byteLength(content, "utf8") + Buffer.byteLength(originalContent, "utf8");
    if (size > 32 * 1024 * 1024) throw new Error("File draft exceeds the 32 MB limit");

    return this.enqueueFileDraftMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "File draft");
      const drafts = await this.loadFileDrafts();
      const previous = drafts[draftKey];
      if (
        previous
        && (
          previous.environmentId !== environmentId
          || previous.filePath !== filePath
        )
      ) {
        throw new Error("File draft key belongs to another file");
      }
      if (
        expectedRevision !== undefined
        && (previous?.revision ?? 0) !== expectedRevision
      ) {
        throw new Error("File draft revision conflict");
      }
      const saved: PersistedFileDraft = {
        draftKey,
        environmentId,
        filePath,
        content,
        originalContent,
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
      };
      drafts[draftKey] = saved;
      await this.saveSensitiveJson(this.fileDraftsFile(), drafts);
      this.announce("file-draft", environmentId);
      return saved;
    });
  }

  async deleteFileDraft(
    draftKey: string,
    expectedRevision?: number,
  ): Promise<void> {
    if (!isNonBlankString(draftKey)) throw new Error("File draft key must not be blank");
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("File draft expected revision must be a non-negative integer");
    }
    await this.enqueueFileDraftMutation(async () => {
      const stored = await this.loadJson<unknown>(this.fileDraftsFile(), () => ({}));
      const drafts = this.validFileDrafts(stored);
      const previous = drafts[draftKey];
      if (
        previous
        && expectedRevision !== undefined
        && previous.revision !== expectedRevision
      ) {
        throw new Error("File draft revision conflict");
      }
      const hasStoredKey = isRecord(stored) && Object.hasOwn(stored, draftKey);
      if (hasStoredKey) {
        delete drafts[draftKey];
        await this.saveSensitiveJson(this.fileDraftsFile(), drafts);
      }
      if (previous) {
        this.announce("file-draft", previous.environmentId);
      }
      await this.scrubSensitiveJsonBackups(
        this.fileDraftsFile(),
        (storedKey, draft) =>
          storedKey !== draftKey && isPersistedFileDraft(draft, storedKey),
      );
    });
  }

  async deleteFileDraftsByEnvironment(environmentId: string): Promise<void> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("File draft environment ID must not be blank");
    }
    await this.enqueueFileDraftMutation(async () => {
      const drafts = await this.loadFileDrafts();
      const keys = Object.values(drafts)
        .filter((draft) => draft.environmentId === environmentId)
        .map((draft) => draft.draftKey);
      for (const key of keys) delete drafts[key];
      if (keys.length > 0) {
        await this.saveSensitiveJson(this.fileDraftsFile(), drafts);
        this.announce("file-draft", environmentId);
      }
      await this.scrubSensitiveJsonBackups(
        this.fileDraftsFile(),
        (storedKey, draft) =>
          isPersistedFileDraft(draft, storedKey)
          && draft.environmentId !== environmentId,
      );
    });
  }

  private enqueueAgentHandoffMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.agentHandoffsFile(),
        "agent handoff storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.agentHandoffMutation.then(run, run);
    this.agentHandoffMutation = next.then(() => undefined, () => undefined);
    return next;
  }

  private async loadAgentHandoffEntries(): Promise<Record<string, unknown>> {
    const stored = await this.loadJson<unknown>(
      this.agentHandoffsFile(),
      () => ({}),
    );
    return isRecord(stored) ? stored : {};
  }

  private async loadAgentHandoffs(): Promise<Record<string, PersistedAgentHandoff>> {
    const stored = await this.loadAgentHandoffEntries();
    return Object.fromEntries(
      Object.entries(stored).filter(([storedId, handoff]) =>
        isPersistedAgentHandoff(handoff, storedId)
      ),
    ) as Record<string, PersistedAgentHandoff>;
  }

  async getAgentHandoff(handoffId: string): Promise<PersistedAgentHandoff | null> {
    if (!isNonBlankString(handoffId)) {
      throw new Error("Agent handoff ID must not be blank");
    }
    return (await this.loadAgentHandoffs())[handoffId] ?? null;
  }

  async saveAgentHandoff(
    handoffId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
  ): Promise<PersistedAgentHandoff> {
    if (!isNonBlankString(handoffId)) {
      throw new Error("Agent handoff ID must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Agent handoff environment ID must not be blank");
    }
    if (!isPositiveInteger(version)) {
      throw new Error("Agent handoff version must be a positive integer");
    }
    if (!isRecord(snapshot)) {
      throw new Error("Agent handoff snapshot must be an object");
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(snapshot);
    } catch {
      throw new Error("Agent handoff snapshot must be JSON serializable");
    }
    if (Buffer.byteLength(serialized, "utf8") > 32 * 1024 * 1024) {
      throw new Error("Agent handoff exceeds the 32 MB limit");
    }

    return this.enqueueAgentHandoffMutation(async () => {
      await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Agent handoff");
      const handoffs = await this.loadAgentHandoffs();
      const previous = handoffs[handoffId];
      if (previous) {
        if (previous.environmentId !== environmentId) {
          throw new Error("Agent handoff belongs to another environment");
        }
        // Handoffs are immutable. Returning the committed record makes a retry
        // idempotent without allowing a second client to replace its contents.
        return previous;
      }
      const saved: PersistedAgentHandoff = {
        version,
        id: handoffId,
        environmentId,
        snapshot,
        createdAt: nowIso(),
      };
      handoffs[handoffId] = saved;
      await this.saveSensitiveJson(this.agentHandoffsFile(), handoffs);
      return saved;
    });
  }

  private async assertAgentHandoffBackupOwnership(
    handoffId: string,
    environmentId: string,
  ): Promise<void> {
    for (let index = 1; index <= MAX_JSON_BACKUPS; index += 1) {
      const backup = this.backupPath(this.agentHandoffsFile(), index);
      if (!await exists(backup)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await fs.readFile(backup, "utf8"));
      } catch {
        // The scrub that follows removes corrupt backups because their content
        // cannot be proven free of the targeted handoff.
        continue;
      }
      if (!isRecord(parsed)) continue;
      const candidate = parsed[handoffId];
      if (
        isRecord(candidate)
        && isNonBlankString(candidate.environmentId)
        && candidate.environmentId !== environmentId
      ) {
        throw new Error("Agent handoff belongs to another environment");
      }
    }
  }

  /**
   * Deletes one handoff after its destination tab no longer references it.
   *
   * The environment id is required even though handoff ids are globally unique:
   * it prevents a stale or malformed client from deleting another environment's
   * transcript. Backups are scrubbed even when the primary no longer contains
   * the record so retrying a partially completed cleanup finishes the privacy
   * boundary rather than reporting success with retained content.
   */
  async deleteAgentHandoff(
    handoffId: string,
    environmentId: string,
  ): Promise<boolean> {
    if (!isNonBlankString(handoffId)) {
      throw new Error("Agent handoff ID must not be blank");
    }
    if (!isNonBlankString(environmentId)) {
      throw new Error("Agent handoff environment ID must not be blank");
    }
    return this.enqueueAgentHandoffMutation(async () => {
      const handoffs = await this.loadAgentHandoffEntries();
      const stored = handoffs[handoffId];
      if (
        isRecord(stored)
        && isNonBlankString(stored.environmentId)
        && stored.environmentId !== environmentId
      ) {
        throw new Error("Agent handoff belongs to another environment");
      }
      await this.assertAgentHandoffBackupOwnership(handoffId, environmentId);
      const existed = Object.prototype.hasOwnProperty.call(handoffs, handoffId);
      delete handoffs[handoffId];
      // Always rewrite an existing file: a corrupt primary may have fallen back
      // to a backup, and an idempotent retry still needs to replace that
      // unreadable primary. Do not *create* one — a client deleting a stale
      // reference on an installation that never used the feature should leave no
      // trace, and there is nothing to recover when no file exists.
      if (await exists(this.agentHandoffsFile())) {
        await this.saveSensitiveJson(this.agentHandoffsFile(), handoffs);
      }
      await this.scrubSensitiveJsonBackups(
        this.agentHandoffsFile(),
        (storedId) => storedId !== handoffId,
      );
      return existed;
    });
  }

  /**
   * Reconciles stored handoffs against the ids a pane layout still references.
   *
   * Deletion at tab close is a best-effort renderer call: a backend restart, a
   * lock timeout or a kill between the layout update and the request drops it
   * silently, and the id is gone from the layout by then, so nothing would ever
   * retry. Without this sweep those transcripts stay on disk permanently,
   * unreachable and unremovable short of deleting the environment. Called after
   * pane-layout hydration, when `referencedHandoffIds` is authoritative.
   */
  async pruneAgentHandoffs(
    environmentId: string,
    referencedHandoffIds: string[],
  ): Promise<string[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Agent handoff environment ID must not be blank");
    }
    const referenced = new Set(referencedHandoffIds.filter(isNonBlankString));
    return this.enqueueAgentHandoffMutation(async () => {
      const stored = await this.loadAgentHandoffEntries();
      const isOrphan = (storedId: string, handoff: unknown): boolean =>
        isRecord(handoff)
        && handoff.environmentId === environmentId
        && !referenced.has(storedId);
      const removedIds = Object.entries(stored)
        .filter(([storedId, handoff]) => isOrphan(storedId, handoff))
        .map(([storedId]) => storedId);
      if (removedIds.length === 0) return [];
      const retained = Object.fromEntries(
        Object.entries(stored).filter(([storedId, handoff]) => !isOrphan(storedId, handoff)),
      );
      await this.saveSensitiveJson(this.agentHandoffsFile(), retained);
      await this.scrubSensitiveJsonBackups(
        this.agentHandoffsFile(),
        (storedId, handoff) => !isOrphan(storedId, handoff),
      );
      return removedIds;
    });
  }

  async deleteAgentHandoffsByEnvironment(environmentId: string): Promise<string[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Agent handoff environment ID must not be blank");
    }
    return this.enqueueAgentHandoffMutation(async () => {
      const stored = await this.loadAgentHandoffEntries();
      const removedIds = Object.entries(stored)
        .filter(([, handoff]) =>
          isRecord(handoff) && handoff.environmentId === environmentId
        )
        .map(([storedId]) => storedId);
      const handoffs = Object.fromEntries(
        Object.entries(stored).filter(([storedId, handoff]) =>
          isPersistedAgentHandoff(handoff, storedId)
          && handoff.environmentId !== environmentId
        ),
      );
      // Rewrite even if no valid record matched. Invalid primary entries cannot
      // be proven free of content from the environment being deleted.
      if (await exists(this.agentHandoffsFile())) {
        await this.saveSensitiveJson(this.agentHandoffsFile(), handoffs);
      }
      await this.scrubSensitiveJsonBackups(
        this.agentHandoffsFile(),
        (storedId, handoff) =>
          isPersistedAgentHandoff(handoff, storedId)
          && handoff.environmentId !== environmentId,
      );
      return removedIds;
    });
  }

  private async loadBuildPipelines(): Promise<Record<string, PersistedBuildPipeline>> {
    const stored = await this.loadJson<Record<string, PersistedBuildPipeline>>(
      this.buildPipelinesFile(),
      () => ({}),
    );
    return Object.fromEntries(
      Object.entries(stored).filter(([storedId, pipeline]) =>
        isPersistedBuildPipeline(pipeline, storedId)
      ),
    ) as Record<string, PersistedBuildPipeline>;
  }

  async getBuildPipeline(pipelineId: string): Promise<PersistedBuildPipeline | null> {
    if (!isNonBlankString(pipelineId)) {
      throw new Error("Build pipeline ID must not be blank");
    }
    return (await this.loadBuildPipelines())[pipelineId] ?? null;
  }

  async listBuildPipelines(projectId: string): Promise<PersistedBuildPipeline[]> {
    if (!isNonBlankString(projectId)) {
      throw new Error("Build pipeline project ID must not be blank");
    }
    return Object.values(await this.loadBuildPipelines())
      .filter((pipeline) => pipeline.projectId === projectId)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  /** Backend supervisors use this to re-arm every active pipeline on startup. */
  async listAllBuildPipelines(): Promise<PersistedBuildPipeline[]> {
    return Object.values(await this.loadBuildPipelines())
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  async saveBuildPipeline(
    pipelineId: string,
    projectId: string,
    environmentId: string,
    version: number,
    snapshot: unknown,
    expectedRevision?: number,
  ): Promise<PersistedBuildPipeline> {
    if (!isNonBlankString(pipelineId)) {
      throw new Error("Build pipeline ID must not be blank");
    }
    if (!isNonBlankString(projectId)) {
      throw new Error("Build pipeline project ID must not be blank");
    }
    if (typeof environmentId !== "string") {
      throw new Error("Build pipeline environment ID must be a string");
    }
    if (!isPositiveInteger(version)) {
      throw new Error("Build pipeline version must be a positive integer");
    }
    if (!isRecord(snapshot)) {
      throw new Error("Build pipeline snapshot must be a JSON object");
    }
    if (expectedRevision !== undefined && !isNonNegativeInteger(expectedRevision)) {
      throw new Error("Build pipeline expected revision must be a non-negative integer");
    }
    let serializedSnapshot: string | undefined;
    try {
      serializedSnapshot = JSON.stringify(snapshot);
    } catch {
      throw new Error("Build pipeline snapshot must be JSON serializable");
    }
    if (serializedSnapshot === undefined) {
      throw new Error("Build pipeline snapshot must be JSON serializable");
    }
    // Task snapshots embed base64 attachment data and structured review reports
    // retain full findings. Reject an over-sized snapshot rather than truncating
    // it: a silently trimmed task is a pipeline that builds the wrong thing.
    if (Buffer.byteLength(serializedSnapshot, "utf8") > 32 * 1024 * 1024) {
      throw new Error("Build pipeline snapshot exceeds the 32 MB limit");
    }

    return this.enqueueBuildPipelineMutation(async () => {
      if (environmentId) {
        await this.assertEnvironmentAcceptsBackgroundState(environmentId, "Build pipeline");
      }
      const pipelines = await this.loadBuildPipelines();
      const previous = pipelines[pipelineId];
      if (previous && previous.projectId !== projectId) {
        throw new Error("Build pipeline belongs to another project");
      }
      if (
        expectedRevision !== undefined
        && (previous?.revision ?? 0) !== expectedRevision
      ) {
        throw new Error("Build pipeline revision conflict");
      }
      const admissionKey = activeBuildAdmissionKey(snapshot);
      if (!previous && expectedRevision === 0 && admissionKey) {
        const admitted = Object.values(pipelines).find(
          (pipeline) =>
            activeBuildAdmissionKey(pipeline.snapshot) === admissionKey,
        );
        if (admitted) return admitted;
      }
      const reservation = activeGitHubBuildReservation(snapshot);
      if (
        reservation
        && Object.values(pipelines).some((pipeline) =>
          pipeline.id !== pipelineId
          && activeGitHubBuildReservation(pipeline.snapshot) === reservation
        )
      ) {
        throw new Error(`An active build already exists for ${reservation}`);
      }
      const saved: PersistedBuildPipeline = {
        version,
        id: pipelineId,
        projectId,
        environmentId,
        snapshot,
        updatedAt: nowIso(),
        revision: (previous?.revision ?? 0) + 1,
      };
      pipelines[pipelineId] = saved;
      await this.saveSensitiveJson(this.buildPipelinesFile(), pipelines);
      this.announce("build-pipeline", pipelineId);
      return saved;
    });
  }

  async deleteBuildPipeline(pipelineId: string): Promise<void> {
    if (!isNonBlankString(pipelineId)) {
      throw new Error("Build pipeline ID must not be blank");
    }
    await this.enqueueBuildPipelineMutation(async () => {
      const pipelines = await this.loadBuildPipelines();
      if (pipelineId in pipelines) {
        delete pipelines[pipelineId];
        await this.saveSensitiveJson(this.buildPipelinesFile(), pipelines);
        this.announce("build-pipeline", pipelineId);
      }
      await this.scrubSensitiveJsonBackups(
        this.buildPipelinesFile(),
        (storedId, pipeline) =>
          storedId !== pipelineId && isPersistedBuildPipeline(pipeline, storedId),
      );
    });
  }

  async deleteBuildPipelinesByEnvironment(
    environmentId: string,
    linkedPipelineId?: string,
  ): Promise<string[]> {
    if (!isNonBlankString(environmentId)) {
      throw new Error("Build pipeline environment ID must not be blank");
    }
    if (
      linkedPipelineId !== undefined
      && linkedPipelineId !== ""
      && !isNonBlankString(linkedPipelineId)
    ) {
      throw new Error("Linked build pipeline ID must not be blank");
    }
    return this.enqueueBuildPipelineMutation(async () => {
      const pipelines = await this.loadBuildPipelines();
      const linkedId = isNonBlankString(linkedPipelineId) ? linkedPipelineId : null;
      const removedIds = Object.values(pipelines)
        .filter((pipeline) =>
          pipeline.environmentId === environmentId || pipeline.id === linkedId
        )
        .map((pipeline) => pipeline.id);
      if (removedIds.length > 0) {
        for (const removedId of removedIds) delete pipelines[removedId];
        await this.saveSensitiveJson(this.buildPipelinesFile(), pipelines);
        for (const removedId of removedIds) this.announce("build-pipeline", removedId);
      }
      const removedIdSet = new Set(removedIds);
      if (linkedId) removedIdSet.add(linkedId);

      // Task snapshots embed base64 attachments and full review findings, so
      // the same backup scrub the looped review path performs applies here.
      // Check both ownership forms because a newly-created pipeline deliberately
      // has a blank environmentId until create_environment links it.
      await this.scrubSensitiveJsonBackups(
        this.buildPipelinesFile(),
        (storedId, pipeline) =>
          isPersistedBuildPipeline(pipeline, storedId)
          && pipeline.environmentId !== environmentId
          && !removedIdSet.has(storedId),
      );
      return removedIds;
    });
  }

  async deletePaneLayout(
    environmentId: string,
    expectedRevision?: number,
  ): Promise<void> {
    if (
      expectedRevision !== undefined
      && !isNonNegativeInteger(expectedRevision)
    ) {
      throw new Error("Pane layout expected revision must be a non-negative integer");
    }
    return this.enqueuePaneLayoutMutation(async () => {
      const layouts = await this.loadJson<Record<string, PersistedPaneLayout>>(
        this.paneLayoutsFile(),
        () => ({}),
      );
      const currentRevision = layouts[environmentId]?.revision ?? 0;
      if (
        expectedRevision !== undefined
        && currentRevision !== expectedRevision
      ) {
        throw new Error(
          paneLayoutRevisionConflictMessage(expectedRevision, currentRevision),
        );
      }
      if (!(environmentId in layouts)) return;
      delete layouts[environmentId];
      await this.saveJson(this.paneLayoutsFile(), layouts);
      this.announce("pane-layout", environmentId);
    });
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    return sessions.find((session) => session.id === sessionId) ?? null;
  }

  async getSessionsByEnvironment(environmentId: string): Promise<Session[]> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    return sessions.filter((session) => session.environmentId === environmentId).sort((a, b) => a.order - b.order);
  }

  async updateSession(sessionId: string, updates: Partial<Session>): Promise<Session> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    Object.assign(session, updates);
    await this.saveJson(this.sessionsFile(), sessions);
    this.announce("session", session.environmentId);
    return session;
  }

  async removeSession(sessionId: string): Promise<void> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const removed = sessions.find((session) => session.id === sessionId);
    const filtered = sessions.filter((session) => session.id !== sessionId);
    if (filtered.length === sessions.length) throw new Error(`Session not found: ${sessionId}`);
    await this.saveJson(this.sessionsFile(), filtered);
    await this.deleteSessionBuffer(sessionId);
    if (removed) this.announce("session", removed.environmentId);
  }

  async removeSessionsByEnvironment(environmentId: string): Promise<string[]> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const removed = sessions.filter((session) => session.environmentId === environmentId).map((session) => session.id);
    await this.saveJson(this.sessionsFile(), sessions.filter((session) => session.environmentId !== environmentId));
    await Promise.all(removed.map((sessionId) => this.deleteSessionBuffer(sessionId)));
    if (removed.length > 0) this.announce("session", environmentId);
    return removed;
  }

  async disconnectEnvironmentSessions(environmentId: string): Promise<Session[]> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const updated: Session[] = [];
    for (const session of sessions) {
      if (session.environmentId === environmentId && session.status === "connected") {
        session.status = "disconnected";
        updated.push(session);
      }
    }
    await this.saveJson(this.sessionsFile(), sessions);
    if (updated.length > 0) this.announce("session", environmentId);
    return updated;
  }

  async reorderSessions(environmentId: string, sessionIds: string[]): Promise<Session[]> {
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const provided = new Set(sessionIds);
    for (const [index, id] of sessionIds.entries()) {
      const session = sessions.find((candidate) => candidate.id === id && candidate.environmentId === environmentId);
      if (session) session.order = index;
    }
    let order = sessionIds.length;
    for (const session of sessions) {
      if (session.environmentId === environmentId && !provided.has(session.id)) session.order = order++;
    }
    await this.saveJson(this.sessionsFile(), sessions);
    this.announce("session", environmentId);
    return this.getSessionsByEnvironment(environmentId);
  }

  async saveSessionBuffer(sessionId: string, buffer: string): Promise<void> {
    await fs.mkdir(this.buffersDir(), { recursive: true });
    const maxBufferSize = 500 * 1024;
    const contents = buffer.length > maxBufferSize ? buffer.slice(buffer.length - maxBufferSize) : buffer;
    await fs.writeFile(this.bufferFile(sessionId), contents);
  }

  async loadSessionBuffer(sessionId: string): Promise<string | null> {
    const filePath = this.bufferFile(sessionId);
    if (!await exists(filePath)) return null;
    return fs.readFile(filePath, "utf8");
  }

  async deleteSessionBuffer(sessionId: string): Promise<void> {
    await fs.rm(this.bufferFile(sessionId), { force: true });
  }

  async cleanupOrphanedBuffers(): Promise<string[]> {
    if (!await exists(this.buffersDir())) return [];
    const sessions = await this.loadJson<Session[]>(this.sessionsFile(), () => []);
    const liveBufferFiles = new Set(sessions.map((session) => `${session.id}.txt`));
    const deleted: string[] = [];
    for (const entry of await fs.readdir(this.buffersDir())) {
      const sessionId = path.basename(entry, path.extname(entry));
      if (!liveBufferFiles.has(entry)) {
        await fs.rm(path.join(this.buffersDir(), entry), { force: true });
        deleted.push(sessionId);
      }
    }
    return deleted;
  }

  async getKanbanTasks(projectId: string): Promise<KanbanTask[]> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    return tasks.filter((task) => task.projectId === projectId);
  }

  async getKanbanTask(taskId: string): Promise<KanbanTask | null> {
    const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
    return tasks.find((task) => task.id === taskId) ?? null;
  }

  /**
   * Serializes the complete Kanban read-modify-write transaction both within
   * this service instance and across backend processes sharing the data
   * directory. Background PR reconciliation and foreground edits otherwise
   * risk saving independent stale snapshots over each other.
   */
  private enqueueKanbanMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      const release = await this.acquireMutationLock(
        this.kanbanFile(),
        "Kanban storage",
      );
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this.kanbanMutation.then(run, run);
    this.kanbanMutation = next.then(() => undefined, () => undefined);
    return next;
  }

  private async removeKanbanImageFilesBestEffort(imageIds: string[]): Promise<void> {
    await Promise.all(imageIds.map(async (imageId) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await fs.rm(this.kanbanImageFile(imageId), { force: true });
          return;
        } catch {
          if (attempt === 1) {
            // The authoritative metadata no longer references this image.
            // Keep the committed mutation successful; after the bounded
            // retries the remaining orphan is safe to remove later.
            console.warn("[Storage] Failed to clean up an orphaned Kanban image");
          }
        }
      }
    }));
  }

  async addKanbanTask(
    projectId: string,
    title: string,
    description: string,
    initial: {
      acceptanceCriteria?: string;
      status?: KanbanStatus;
    } = {},
  ): Promise<KanbanTask> {
    const status = initial.status ?? "backlog";
    if (!isOneOf(status, ["backlog", "in-progress", "review", "done"])) {
      throw new Error("Kanban task status is invalid");
    }
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
      const task: KanbanTask = {
        id: randomUUID(),
        projectId,
        title,
        description,
        acceptanceCriteria: initial.acceptanceCriteria ?? "",
        status,
        comments: [],
        images: [],
        createdAt: nowIso(),
        order: Math.max(-1, ...tasks.filter((candidate) => candidate.projectId === projectId && candidate.status === status).map((candidate) => candidate.order)) + 1,
        prMergeCommented: false,
      };
      tasks.push(task);
      await this.saveJson(this.kanbanFile(), tasks);
      this.announce("kanban", projectId);
      return task;
    });
  }

  async updateKanbanTask(
    taskId: string,
    updates: Partial<KanbanTask>,
    expectedProjectId?: string,
  ): Promise<KanbanTask> {
    if (
      updates.status !== undefined
      && !isOneOf(updates.status, ["backlog", "in-progress", "review", "done"])
    ) {
      throw new Error("Kanban task status is invalid");
    }
    if (
      updates.prState !== undefined
      && !isOneOf(updates.prState, ["open", "merged", "closed"])
    ) {
      throw new Error("Kanban task pull request state is invalid");
    }
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (
        !task
        || (expectedProjectId !== undefined && task.projectId !== expectedProjectId)
      ) {
        throw new Error(`Kanban task not found: ${taskId}`);
      }

      const oldStatus = task.status;
      Object.assign(task, updates);
      if (updates.status && updates.status !== oldStatus) {
        task.order = Math.max(-1, ...tasks.filter((candidate) => candidate.projectId === task.projectId && candidate.status === updates.status && candidate.id !== taskId).map((candidate) => candidate.order)) + 1;
      }
      await this.saveJson(this.kanbanFile(), tasks);
      this.announce("kanban", task.projectId);
      return task;
    });
  }

  async deleteKanbanTask(taskId: string): Promise<void> {
    await this.enqueueKanbanMutation(async () => {
      const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Kanban task not found: ${taskId}`);
      await this.saveJson(this.kanbanFile(), tasks.filter((candidate) => candidate.id !== taskId));
      this.announce("kanban", task.projectId);
      await this.removeKanbanImageFilesBestEffort(task.images.map((image) => image.id));
    });
  }

  async addKanbanComment(
    taskId: string,
    text: string,
    expectedProjectId?: string,
  ): Promise<KanbanTask> {
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (
        !task
        || (expectedProjectId !== undefined && task.projectId !== expectedProjectId)
      ) {
        throw new Error(`Kanban task not found: ${taskId}`);
      }
      task.comments.push({ id: randomUUID(), text, createdAt: nowIso() });
      await this.saveJson(this.kanbanFile(), tasks);
      this.announce("kanban", task.projectId);
      return task;
    });
  }

  async deleteKanbanComment(taskId: string, commentId: string): Promise<KanbanTask> {
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Kanban task not found: ${taskId}`);
      task.comments = task.comments.filter((comment) => comment.id !== commentId);
      await this.saveJson(this.kanbanFile(), tasks);
      this.announce("kanban", task.projectId);
      return task;
    });
  }

  async addKanbanImage(taskId: string, filename: string, data: string): Promise<KanbanTask> {
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Kanban task not found: ${taskId}`);

      const rawBytes = Buffer.from(data, "base64");
      const webpBytes = await resizeKanbanImage(rawBytes);
      await fs.mkdir(this.kanbanImagesDir(), { recursive: true });
      const image: KanbanImage = { id: randomUUID(), filename, createdAt: nowIso() };
      await fs.writeFile(this.kanbanImageFile(image.id), webpBytes);
      task.images.push(image);
      try {
        await this.saveJson(this.kanbanFile(), tasks);
      } catch (error) {
        await fs.rm(this.kanbanImageFile(image.id), { force: true });
        throw error;
      }
      this.announce("kanban", task.projectId);
      return task;
    });
  }

  async deleteKanbanImage(taskId: string, imageId: string): Promise<KanbanTask> {
    return this.enqueueKanbanMutation(async () => {
      const tasks = await this.loadJson<KanbanTask[]>(this.kanbanFile(), () => []);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Kanban task not found: ${taskId}`);
      if (!isCanonicalUuid(imageId)) {
        throw new Error("Kanban image ID is invalid");
      }
      if (!task.images.some((image) => image.id === imageId)) {
        throw new Error(`Kanban image not found on task: ${imageId}`);
      }
      task.images = task.images.filter((image) => image.id !== imageId);
      await this.saveJson(this.kanbanFile(), tasks);
      this.announce("kanban", task.projectId);
      await this.removeKanbanImageFilesBestEffort([imageId]);
      return task;
    });
  }

  async getKanbanImageData(imageId: string): Promise<string> {
    if (!isCanonicalUuid(imageId)) {
      throw new Error("Kanban image ID is invalid");
    }
    return (await fs.readFile(this.kanbanImageFile(imageId))).toString("base64");
  }

  async getProjectNotes(projectId: string): Promise<ProjectNotes> {
    const notes = await this.loadJson<ProjectNotes[]>(this.projectNotesFile(), () => []);
    return notes.find((note) => note.projectId === projectId) ?? { projectId, content: "", updatedAt: nowIso() };
  }

  async saveProjectNotes(projectId: string, content: string): Promise<ProjectNotes> {
    const notes = await this.loadJson<ProjectNotes[]>(this.projectNotesFile(), () => []);
    let note = notes.find((candidate) => candidate.projectId === projectId);
    if (!note) {
      note = { projectId, content, updatedAt: nowIso() };
      notes.push(note);
    } else {
      note.content = content;
      note.updatedAt = nowIso();
    }
    await this.saveJson(this.projectNotesFile(), notes);
    this.announce("project-notes", projectId);
    return note;
  }

  async getFeaturePlans(projectId: string): Promise<FeaturePlan[]> {
    const plans = await this.loadJson<FeaturePlan[]>(this.featurePlansFile(), () => []);
    return plans
      .filter((plan) => plan.projectId === projectId)
      .sort((a, b) => a.order - b.order);
  }

  // Serializes the entire load -> mutate -> save cycle for feature plans so that
  // concurrent flows (e.g. a feature-chat poll and a story refinement happening at
  // the same time) cannot clobber each other via stale read-modify-write races.
  // The mutator runs against the freshly loaded array; if it throws, nothing is
  // saved and the next queued mutation still proceeds.
  private mutateFeaturePlans<T>(
    mutator: (plans: FeaturePlan[]) => T,
    affectedProjectId: (result: T) => string,
  ): Promise<T> {
    const run = this.featurePlanMutation.then(async () => {
      const plans = await this.loadJson<FeaturePlan[]>(this.featurePlansFile(), () => []);
      const result = mutator(plans);
      await this.saveJson(this.featurePlansFile(), plans);
      this.announce("feature-plan", affectedProjectId(result));
      return result;
    });
    this.featurePlanMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  async createFeaturePlan(projectId: string): Promise<FeaturePlan> {
    return this.mutateFeaturePlans((plans) => {
      const now = nowIso();
      const plan: FeaturePlan = {
        id: randomUUID(),
        projectId,
        title: "new feature",
        status: "collecting",
        summary: "",
        messages: [{
          id: randomUUID(),
          role: "assistant",
          content: "Tell me about the new feature",
          createdAt: now,
        }],
        stories: [],
        createdAt: now,
        updatedAt: now,
        order: Math.max(-1, ...plans.filter((candidate) => candidate.projectId === projectId).map((candidate) => candidate.order)) + 1,
      };
      plans.push(plan);
      return plan;
    }, (plan) => plan.projectId);
  }

  async updateFeaturePlan(featureId: string, updates: Partial<FeaturePlan>): Promise<FeaturePlan> {
    return this.mutateFeaturePlans((plans) => {
      const plan = plans.find((candidate) => candidate.id === featureId);
      if (!plan) throw new Error(`Feature plan not found: ${featureId}`);

      const originalId = plan.id;
      const originalProjectId = plan.projectId;
      const originalCreatedAt = plan.createdAt;
      const originalOrder = plan.order;
      const originalPlanning = plan.planning;
      Object.assign(plan, updates);
      plan.id = originalId;
      plan.projectId = originalProjectId;
      plan.createdAt = originalCreatedAt;
      plan.order = originalOrder;
      if (originalPlanning === undefined) {
        delete plan.planning;
      } else {
        plan.planning = originalPlanning;
      }
      plan.updatedAt = nowIso();
      return plan;
    }, (plan) => plan.projectId);
  }

  async claimFeaturePlanBuild(
    featureId: string,
    taskId: string,
  ): Promise<{ claimed: boolean; feature: FeaturePlan }> {
    return this.mutateFeaturePlans((plans) => {
      const plan = plans.find((candidate) => candidate.id === featureId);
      if (!plan) throw new Error(`Feature plan not found: ${featureId}`);

      if (plan.status === "building" && plan.buildTaskId === taskId) {
        return { claimed: true, feature: plan };
      }
      if (
        plan.status === "building"
        || Boolean(plan.buildTaskId)
        || Boolean(plan.buildPipelineId)
      ) {
        return { claimed: false, feature: plan };
      }

      plan.status = "building";
      plan.buildTaskId = taskId;
      plan.updatedAt = nowIso();
      return { claimed: true, feature: plan };
    }, (result) => result.feature.projectId);
  }

  async appendFeaturePlanMessage(
    featureId: string,
    role: FeaturePlanMessage["role"],
    content: string,
    stateApplication?: FeaturePlanMessage["stateApplication"],
    modelId?: string,
  ): Promise<FeaturePlan> {
    return this.mutateFeaturePlans((plans) => {
      const plan = plans.find((candidate) => candidate.id === featureId);
      if (!plan) throw new Error(`Feature plan not found: ${featureId}`);

      plan.messages.push({
        id: randomUUID(),
        role,
        content,
        createdAt: nowIso(),
        ...(modelId ? { modelId } : {}),
        ...(stateApplication ? { stateApplication } : {}),
      });
      plan.updatedAt = nowIso();
      return plan;
    }, (plan) => plan.projectId);
  }

  async appendFeatureStoryMessage(
    featureId: string,
    storyId: string,
    role: FeaturePlanMessage["role"],
    content: string,
    stateApplication?: FeaturePlanMessage["stateApplication"],
    modelId?: string,
  ): Promise<FeaturePlan> {
    return this.mutateFeaturePlans((plans) => {
      const plan = plans.find((candidate) => candidate.id === featureId);
      if (!plan) throw new Error(`Feature plan not found: ${featureId}`);
      const story = plan.stories.find((candidate) => candidate.id === storyId);
      if (!story) throw new Error(`Feature story not found: ${storyId}`);

      story.messages.push({
        id: randomUUID(),
        role,
        content,
        createdAt: nowIso(),
        ...(modelId ? { modelId } : {}),
        ...(stateApplication ? { stateApplication } : {}),
      });
      story.updatedAt = nowIso();
      plan.updatedAt = nowIso();
      return plan;
    }, (plan) => plan.projectId);
  }

  /** Every plan across every project, for backend sweeps that are not project-scoped. */
  async listAllFeaturePlans(): Promise<FeaturePlan[]> {
    return await this.loadJson<FeaturePlan[]>(this.featurePlansFile(), () => []);
  }

  async getFeaturePlan(featureId: string): Promise<FeaturePlan | null> {
    const plans = await this.loadJson<FeaturePlan[]>(this.featurePlansFile(), () => []);
    return plans.find((candidate) => candidate.id === featureId) ?? null;
  }

  /**
   * Every plan carrying a planning record the backend still has to advance.
   *
   * Records that fail validation are ignored rather than repaired here: the
   * service quarantines them, because a record this cannot read is one no
   * amount of ticking will move.
   */
  async listActiveFeaturePlanning(): Promise<FeaturePlanningRecord[]> {
    const plans = await this.loadJson<FeaturePlan[]>(this.featurePlansFile(), () => []);
    const active: FeaturePlanningRecord[] = [];
    for (const plan of plans) {
      const record = plan.planning;
      if (!isFeaturePlanningRecord(record)) continue;
      if (isTerminalFeaturePlanningPhase(record.phase)) continue;
      active.push(record);
    }
    return active;
  }

  /**
   * Attaches a planning record, refusing when one is already in flight.
   *
   * This is the interlock that stops a second window — or a reload that resets
   * a renderer latch — from dispatching a second turn into the same session.
   */
  async startFeaturePlanning(
    record: FeaturePlanningRecord,
  ): Promise<{ started: boolean; feature: FeaturePlan }> {
    if (!isFeaturePlanningRecord(record)) {
      throw new Error("Feature planning record is invalid");
    }
    return this.mutateFeaturePlans((plans) => {
      const plan = plans.find((candidate) => candidate.id === record.featureId);
      if (!plan) throw new Error(`Feature plan not found: ${record.featureId}`);
      const existing = plan.planning;
      if (isFeaturePlanningRecord(existing) && !isTerminalFeaturePlanningPhase(existing.phase)) {
        return { started: false, feature: plan };
      }
      plan.planning = { ...record, projectId: plan.projectId };
      plan.updatedAt = nowIso();
      return { started: true, feature: plan };
    }, (result) => result.feature.projectId);
  }

  /**
   * Runs `mutator` against the plan and its planning record in one serialized
   * write, then bumps the record's revision.
   *
   * The `operationId` is a fence: a mutation for an exchange that has already
   * been replaced must not land, or a superseded turn's reply would overwrite
   * the current one.
   */
  async mutateFeaturePlanning<T>(
    featureId: string,
    operationId: string,
    mutator: (plan: FeaturePlan, record: FeaturePlanningRecord) => T,
  ): Promise<{ result: T; feature: FeaturePlan }> {
    return this.mutateFeaturePlans((plans) => {
      const plan = plans.find((candidate) => candidate.id === featureId);
      if (!plan) throw new Error(`Feature plan not found: ${featureId}`);
      const record = plan.planning;
      if (!isFeaturePlanningRecord(record) || record.operationId !== operationId) {
        throw new FeaturePlanningFenceError(featureId, operationId);
      }
      const result = mutator(plan, record);
      // Re-read: the mutator may have replaced the record wholesale.
      const updated = plan.planning;
      if (isFeaturePlanningRecord(updated) && updated.operationId === operationId) {
        updated.backendRevision += 1;
        updated.updatedAt = nowIso();
      }
      plan.updatedAt = nowIso();
      return { result, feature: plan };
    }, (outcome) => outcome.feature.projectId);
  }

  /**
   * Detaches a finished exchange. A mismatched fence is a no-op, not an error:
   * the exchange it would have cleared has already been replaced.
   */
  async clearFeaturePlanning(
    featureId: string,
    operationId: string,
  ): Promise<FeaturePlan> {
    return this.mutateFeaturePlans((plans) => {
      const plan = plans.find((candidate) => candidate.id === featureId);
      if (!plan) throw new Error(`Feature plan not found: ${featureId}`);
      if (plan.planning?.operationId !== operationId) return plan;
      delete plan.planning;
      plan.updatedAt = nowIso();
      return plan;
    }, (plan) => plan.projectId);
  }

  async getLinearAuth(): Promise<LinearAuth | null> {
    const auth = await this.loadJson<LinearAuth | null>(this.linearAuthFile(), () => null);
    return auth?.apiKey ? auth : null;
  }

  async saveLinearAuth(apiKey: string, viewer?: LinearAuth["viewer"]): Promise<LinearAuth> {
    const auth: LinearAuth = {
      apiKey,
      connectedAt: nowIso(),
      viewer,
    };
    await this.writeAtomic(this.linearAuthFile(), `${JSON.stringify(auth, null, 2)}\n`, false, 0o600);
    return auth;
  }

  async clearLinearAuth(): Promise<void> {
    await fs.rm(this.linearAuthFile(), { force: true });
  }

  async getLinearCompletionComment(pipelineId: string): Promise<LinearCompletionComment | null> {
    const comments = await this.loadJson<LinearCompletionComment[]>(this.linearCompletionCommentsFile(), () => []);
    return comments.find((comment) => comment.pipelineId === pipelineId) ?? null;
  }

  async saveLinearCompletionComment(
    record: Omit<LinearCompletionComment, "updatedAt"> & { updatedAt?: string },
  ): Promise<LinearCompletionComment> {
    const comments = await this.loadJson<LinearCompletionComment[]>(this.linearCompletionCommentsFile(), () => []);
    const nextRecord: LinearCompletionComment = {
      ...record,
      updatedAt: record.updatedAt ?? nowIso(),
    };
    const index = comments.findIndex((comment) => comment.pipelineId === record.pipelineId);
    if (index >= 0) comments[index] = nextRecord;
    else comments.push(nextRecord);
    await this.saveJson(this.linearCompletionCommentsFile(), comments);
    return nextRecord;
  }

  async getGitHubCompletionComment(pipelineId: string): Promise<GitHubCompletionComment | null> {
    const comments = await this.loadJson<GitHubCompletionComment[]>(
      this.githubCompletionCommentsFile(),
      () => [],
    );
    return comments.find((comment) => comment.pipelineId === pipelineId) ?? null;
  }

  /**
   * Serialize the complete scan/post/persist transaction for one GitHub-backed
   * pipeline across backend processes sharing this data directory.
   */
  async withGitHubCompletionCommentLock<T>(
    pipelineId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!pipelineId.trim()) throw new Error("GitHub completion pipeline ID is required");
    const release = await this.acquireMutationLock(
      this.githubCompletionCommentLockTarget(pipelineId),
      "GitHub completion comment posting",
    );
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async saveGitHubCompletionComment(
    record: Omit<GitHubCompletionComment, "updatedAt"> & { updatedAt?: string },
  ): Promise<GitHubCompletionComment> {
    return this.enqueueGitHubCompletionCommentMutation(async () => {
      const comments = await this.loadJson<GitHubCompletionComment[]>(
        this.githubCompletionCommentsFile(),
        () => [],
      );
      const nextRecord: GitHubCompletionComment = {
        ...record,
        updatedAt: record.updatedAt ?? nowIso(),
      };
      const index = comments.findIndex((comment) => comment.pipelineId === record.pipelineId);
      if (index >= 0) comments[index] = nextRecord;
      else comments.push(nextRecord);
      await this.saveJson(this.githubCompletionCommentsFile(), comments);
      return nextRecord;
    });
  }

  async setAllEnvironmentStatusesForContainer(containerId: string, status: EnvironmentStatus): Promise<void> {
    return this.enqueueEnvironmentMutation(async () => {
      const environments = await this.loadEnvironments();
      let changed = false;
      for (const environment of environments) {
        if (environment.containerId === containerId) {
          environment.status = status;
          changed = true;
        }
      }
      if (changed) await this.saveEnvironments(environments);
    });
  }
}

export function parseUpdateObject(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}
