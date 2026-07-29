// Re-exported rather than redeclared: the renderer orders activity reports
// against the same vocabulary, and two copies of it drift silently.
import type {
  AgentActivitySource,
  AgentActivitySourceSnapshot,
  AgentActivityState,
  FrontendAgentActivityObserverSnapshot,
} from "@orkestrator/protocol/agent-activity";

export type {
  AgentActivitySource,
  AgentActivitySourceSnapshot,
  AgentActivityState,
  FrontendAgentActivityObserverSnapshot,
};

export interface Project {
  id: string;
  name: string;
  gitUrl: string;
  localPath: string | null;
  addedAt: string;
  order: number;
}

export type EnvironmentStatus = "running" | "stopped" | "error" | "creating" | "stopping";
export type PrState = "open" | "merged" | "closed";
export type NetworkAccessMode = "full" | "restricted";
export type EnvironmentType = "containerized" | "local";
export type EnvironmentLifecycleOperation = "deleting" | "merging";
export type PortProtocol = "tcp" | "udp";

export interface PortMapping {
  containerPort: number;
  hostPort: number;
  protocol: PortProtocol;
}

export type DefaultAgent = "claude" | "opencode" | "codex";
export type OpenCodeMode = "terminal" | "native";
export type ClaudeMode = "terminal" | "native";
export type ClaudeNativeBackend = "sdk" | "tmux";
export type CodexMode = "terminal" | "native";
export type AgentStyle = "terminal" | "native";
export type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeModelCatalogEntry {
  id: string;
  resolvedModel?: string;
  name: string;
  description?: string;
  supportsFastMode?: boolean;
  supportsEffort?: boolean;
  supportedEffortLevels?: ClaudeEffortLevel[];
  supportsAdaptiveThinking?: boolean;
  supportsAutoMode?: boolean;
}

export interface ClaudeModelCatalogSnapshot {
  environmentId: string;
  models: ClaudeModelCatalogEntry[];
  source: "sdk" | "last-known-good" | "fallback";
  fetchedAt: string;
  sdkVersion?: string;
  cliVersion?: string;
  stale: boolean;
  error?: string;
}

export interface OpenCodeModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  variants?: string[];
  inputCost?: number;
  outputCost?: number;
  contextWindow?: number;
}

/**
 * Last-known-good OpenCode catalogue for one project configuration.
 *
 * `catalogVersion` is a digest of the normalized model data. Keeping it
 * separate from `updatedAt` lets the backend avoid rewriting the cache when a
 * newly-started OpenCode server reports the same catalogue.
 */
export interface OpenCodeModelCatalogSnapshot {
  schemaVersion: 2;
  projectId: string;
  catalogVersion: string;
  updatedAt: string;
  models: OpenCodeModelCatalogEntry[];
}

export interface InitialPromptImageAttachment {
  id: string;
  name: string;
  previewUrl: string;
  base64Data: string;
}

export interface Environment {
  id: string;
  projectId: string;
  /** Persisted association used to recover a build pipeline after renderer remount. */
  buildPipelineId?: string;
  /**
   * Set before durable child state is removed.
   *
   * Queue and pipeline writes reject an environment carrying this marker, so a
   * delayed renderer write cannot recreate state after deletion cleanup has
   * passed. The marker intentionally remains when cleanup fails: a retry may
   * continue deletion, but background work must not resume in the meantime.
   */
  deletionRequestedAt?: string;
  /**
   * Persisted before dispatching a merge whose confirmed success must be
   * followed by environment deletion. The backend owns reconciliation so the
   * follow-up survives renderer reloads and inactive environments.
   */
  cleanupAfterMergeRequestedAt?: string;
  /** Last backend cleanup failure retained for rehydration and manual retry. */
  cleanupAfterMergeError?: string;
  /** Backend-owned long-running operation currently affecting this environment. */
  lifecycleOperation?: EnvironmentLifecycleOperation;
  lifecycleOperationStartedAt?: string;
  name: string;
  branch: string;
  containerId: string | null;
  status: EnvironmentStatus;
  prUrl: string | null;
  prState: PrState | null;
  hasMergeConflicts: boolean | null;
  createdAt: string;
  /** Last prompt dispatch or agent completion/waiting transition. */
  lastActivityAt?: string;
  /** Backend-owned aggregate agent activity shared by every frontend. */
  agentActivityState?: AgentActivityState;
  /** Last-write-wins timestamp for the aggregate activity snapshot. */
  agentActivityUpdatedAt?: string;
  /** Backend-internal observations used to derive the aggregate state. */
  agentActivitySources?: Partial<
    Record<AgentActivitySource, AgentActivitySourceSnapshot>
  >;
  /**
   * Renderer observations keyed by a hash of the renderer's opaque token.
   * Entries are leased so a crashed renderer cannot pin the aggregate forever.
   */
  frontendAgentActivityObservers?: Record<
    string,
    FrontendAgentActivityObserverSnapshot
  >;
  createdFromCommit?: string;
  networkAccessMode: NetworkAccessMode;
  allowedDomains?: string[];
  order: number;
  portMappings?: PortMapping[];
  entryPort?: number;
  hostEntryPort?: number;
  environmentType: EnvironmentType;
  worktreePath?: string;
  opencodePid?: number;
  claudeBridgePid?: number;
  codexBridgePid?: number;
  localOpencodePort?: number;
  localClaudePort?: number;
  localCodexPort?: number;
  /** Last backend-owned Claude model catalog for this environment. */
  claudeModelCatalog?: ClaudeModelCatalogSnapshot;
  defaultAgent?: DefaultAgent;
  claudeMode?: ClaudeMode;
  claudeNativeBackend?: ClaudeNativeBackend;
  opencodeMode?: OpenCodeMode;
  codexMode?: CodexMode;
  setupScriptsComplete?: boolean;
  /**
   * Agent work finished here and no client has opened it since.
   *
   * A fact about the environment, not about one window: whichever client opens
   * it clears the badge everywhere, because the work has now been seen.
   */
  hasUnreadWork?: boolean;
  /** Durable intent to open the configured agent once setup is ready. */
  pendingAgentLaunch?: boolean;
  /** One-shot model for the agent tab created from pendingAgentLaunch. */
  initialAgentModel?: string;
  /** One-shot reasoning effort for the agent tab created from pendingAgentLaunch. */
  initialReasoningEffort?: string;
  initialPrompt?: string;
  /** Images waiting to be written into the workspace before the first prompt. */
  initialPromptAttachments?: InitialPromptImageAttachment[];
  /** Prompt awaiting a backend-owned rename after the environment starts. */
  pendingRenamePrompt?: string;
}

export type SessionType = "plain" | "claude" | "opencode" | "codex" | "root";
export type SessionStatus = "connected" | "disconnected";

export interface Session {
  id: string;
  environmentId: string;
  containerId: string;
  tabId: string;
  sessionType: SessionType;
  status: SessionStatus;
  createdAt: string;
  lastActivityAt: string;
  name?: string;
  order: number;
  hasLaunchedCommand?: boolean;
}

export const PANE_LAYOUT_VERSION = 1;

/**
 * Versioned pane/tab layout persisted by the backend for restore-on-connect.
 * The backend deliberately treats `root` as opaque; the frontend owns the
 * PaneNode schema and validates it before installing a restored layout.
 */
export interface PersistedPaneLayout {
  version: number;
  environmentId: string;
  containerId: string | null;
  activePaneId: string;
  root: unknown;
  updatedAt: string;
  revision: number;
}

/**
 * Versioned looped-review workflow persisted by the backend.
 *
 * The backend owns durability and compare-and-swap revisions while the web
 * application owns and runtime-validates the workflow snapshot schema. Keeping
 * the snapshot opaque here lets the workflow evolve without coupling backend
 * releases to every report-contract field.
 */
export interface PersistedLoopedReviewWorkflow {
  version: number;
  id: string;
  environmentId: string;
  snapshot: unknown;
  updatedAt: string;
  revision: number;
}

/**
 * A build pipeline as the backend stores it.
 *
 * Unlike the generic workflow records above, build pipelines are interpreted
 * and advanced by the backend supervisor. Renderers receive this snapshot as a
 * read model and cannot write backend-owned records.
 *
 * `environmentId` is blank between a pipeline being created and its environment
 * existing. That window is exactly when a crash used to orphan the pipeline, so
 * the record must be storable before it can be linked.
 */
export interface PersistedBuildPipeline {
  version: number;
  id: string;
  projectId: string;
  environmentId: string;
  snapshot: unknown;
  updatedAt: string;
  revision: number;
}

/**
 * Prompts a user has committed to sending but which have not been dispatched
 * yet, for one agent tab.
 *
 * The queue lives here rather than in a renderer because a queued prompt is a
 * user decision, not a view: it must survive a reload, be visible to every
 * client, and still drain when the tab that queued it is closed. The message
 * body is opaque — each agent carries different attachment and mode fields, and
 * the backend has no reason to understand any of them.
 */
export interface PersistedPromptQueue {
  queueKey: string;
  environmentId: string;
  messages: unknown[];
  updatedAt: string;
  revision: number;
}

/**
 * Unsent user input owned by an environment or project.
 *
 * `value` is intentionally opaque: terminal/native composers and feature
 * conversations carry different attachment and mention shapes. The backend
 * owns durability and revisions while each frontend validates its own value.
 */
export interface PersistedComposeDraft {
  draftKey: string;
  ownerType: "environment" | "project";
  ownerId: string;
  value: unknown;
  updatedAt: string;
  revision: number;
}

/** A recoverable unsaved text-file buffer. */
export interface PersistedFileDraft {
  draftKey: string;
  environmentId: string;
  filePath: string;
  content: string;
  originalContent: string;
  updatedAt: string;
  revision: number;
}

/**
 * Immutable provider-to-provider conversation handoff.
 *
 * The backend owns the sensitive, durable envelope while the renderer owns and
 * validates the provider-neutral snapshot schema. Keeping the snapshot opaque
 * avoids coupling backend storage to the three native message wire formats.
 */
export interface PersistedAgentHandoff {
  version: number;
  id: string;
  environmentId: string;
  snapshot: unknown;
  createdAt: string;
}

export interface RepositoryConfig {
  defaultBranch: string;
  prBaseBranch: string;
  lastEnvironmentType?: EnvironmentType;
  defaultPortMappings?: PortMapping[];
  filesToCopy?: string[];
  defaultModel?: string;
  defaultEffort?: string;
  entryPort?: number;
  defaultAgent?: DefaultAgent;
  agentStyle?: AgentStyle;
  claudeNativeBackend?: ClaudeNativeBackend;
}

export type AgentModelConfigKey = "claudeModel" | "codexModel" | "opencodeModel";

export interface AppConfig {
  version: string;
  desktopConnections?: import("@orkestrator/protocol/connections").StoredDesktopConnections;
  global: {
    containerResources: { cpuCores: number; memoryGb: number };
    envFilePatterns: string[];
    anthropicApiKey?: string;
    githubToken?: string;
    /** Reuse the host's active `gh auth login` token for container GitHub access. */
    useHostGitHubCredentials?: boolean;
    allowedDomains: string[];
    preferredEditor?: "vscode" | "cursor";
    defaultAgent: DefaultAgent;
    opencodeModel: string;
    claudeModel?: string;
    codexModel: string;
    codexReasoningEffort:
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | "max"
      | "ultra";
    opencodeMode: OpenCodeMode;
    claudeMode: ClaudeMode;
    claudeNativeBackend: ClaudeNativeBackend;
    claudeNativeFastModeDefault?: boolean;
    codexMode: CodexMode;
    codexNativeFastModeDefault?: boolean;
    /** Maximum concurrently open spawned-agent threads per native Codex session. */
    codexMaxConcurrentThreads: number;
    terminalAppearance: {
      fontFamily: string;
      fontSize: number;
      backgroundColor: string;
    };
    terminalScrollback: number;
    experimentalCodexRawEventLogging?: boolean;
    debugLogging?: boolean;
    webClientEnabled?: boolean;
    /** Editable preference embedded inside Orkestrator's fixed review contract. */
    reviewInstruction?: string;
  };
  repositories: Record<string, RepositoryConfig>;
}
