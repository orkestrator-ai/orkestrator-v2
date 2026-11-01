import { STARTUP_AGENT_TAB_ID } from "@orkestrator/protocol/tab-initial-prompt";
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
import type { TicketKind, TicketSections } from "@orkestrator/protocol/ticket-sections";
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
  type ScopedResourceRevisionManifest,
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

/*
 * The base of the shared storage surface: the JSON guards and record types
 * every repository uses, and the protocol names they read through
 * `storage-shared.ts`. The topic modules (`storage-shared-pane-layout.ts`,
 * `-agent-activity`, `-records`, `-native-sessions`, `-model-catalogs`,
 * `-config`) build on this one; it imports none of them, and callers reach
 * all of them through `storage-shared.ts`.
 */

export type JsonRecord = Record<string, unknown>;

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

export type KanbanTask = {
  id: string;
  projectId: string;
  title: string;
  /**
   * Mirror of every section except the acceptance criteria, as markdown. Kept
   * for readers that predate sections; `sections` is authoritative. See
   * `@orkestrator/protocol/ticket-sections`.
   */
  description: string;
  /** Mirror of the acceptance criteria as a markdown list. */
  acceptanceCriteria: string;
  /** Absent on tickets written before kinds existed: a feature ticket. */
  kind?: TicketKind;
  /** Absent on legacy rows; reads derive it from the text mirrors. */
  sections?: TicketSections;
  /** Fingerprint of the mirrors `sections` was written with. */
  sectionsBasis?: string;
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
export const MAX_SESSIONS_PER_ENVIRONMENT = 20;

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
    value.tabId === STARTUP_AGENT_TAB_ID &&
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
  if (!isRecord(value)) return false;
  // Automatic allocation is explicit; a 0 host port is valid only in that mode.
  const hostPortValid =
    value.hostPortMode === "auto"
      ? value.hostPort === 0
      : value.hostPortMode === undefined && isPortNumber(value.hostPort);
  return (
    isPortNumber(value.containerPort) &&
    hostPortValid &&
    (value.protocol === "tcp" || value.protocol === "udp")
  );
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
  ScopedResourceRevisionManifest,
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
