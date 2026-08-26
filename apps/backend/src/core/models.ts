// Re-exported rather than redeclared: the renderer orders activity reports
// against the same vocabulary, and two copies of it drift silently.
import type {
  AgentActivitySource,
  AgentActivitySourceSnapshot,
  AgentActivityState,
  FrontendAgentActivityObserverSnapshot,
} from "@orkestrator/protocol/agent-activity";
import type { TabTeardownKind } from "@orkestrator/protocol/tab-teardown";
import type {
  AgentInteractionOrigin,
  AgentInteractionPolicy,
  AgentInteractionResolutionJournal,
  AgentInteractionWorkflowSummary,
} from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import type { AgentModel } from "@orkestrator/protocol/native-agent";

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
export type EnvironmentSetupPhase = "pending" | "running" | "ready" | "failed";
export type PortProtocol = "tcp" | "udp";

export interface PortMapping {
  containerPort: number;
  hostPort: number;
  protocol: PortProtocol;
}

export type DefaultAgent = AgentPlatform;
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

export type CodexReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export interface CodexModelCatalogEntry {
  id: string;
  name: string;
  description?: string;
  reasoningEfforts?: CodexReasoningEffort[];
  reasoningOptions?: Array<{
    effort: CodexReasoningEffort;
    label: string;
    description?: string;
  }>;
  defaultReasoningEffort?: CodexReasoningEffort;
}

export interface PersistedAgentModelCatalog<T> {
  updatedAt: string;
  models: T[];
}

/**
 * Host-wide last-known-good catalogues used before any environment bridge has
 * started. Cursor and Grok persist the provider-neutral models normalized by
 * their ACP bridge. OpenCode remains project-scoped in
 * `opencode-model-catalog.json` because its provider list can differ between
 * repositories.
 */
export interface AgentModelCatalogCache {
  schemaVersion: 1;
  claude?: PersistedAgentModelCatalog<ClaudeModelCatalogEntry>;
  codex?: PersistedAgentModelCatalog<CodexModelCatalogEntry>;
  cursor?: PersistedAgentModelCatalog<AgentModel>;
  grok?: PersistedAgentModelCatalog<AgentModel>;
  pi?: PersistedAgentModelCatalog<AgentModel>;
}

export interface OpenCodeModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  variants?: string[];
  inputCost?: number;
  outputCost?: number;
  contextWindow?: number;
  supportsImageInput?: boolean;
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
  /** Omitted by records written before startup file attachments were supported. */
  type?: "image" | "file";
  /** Ephemeral renderer preview; omitted from durable storage. */
  previewUrl?: string;
  base64Data: string;
}

export interface StartupAgentSessionSnapshot {
  tabId: "startup-agent";
  agent: DefaultAgent;
  style: AgentStyle;
  model?: string;
  reasoningEffort?: string;
  providerSessionId?: string;
  status: "starting" | "running" | "error";
  startedAt?: string;
  error?: string;
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
  /**
   * Sanitized failure from the most recent backend-owned lifecycle operation.
   *
   * This is intentionally safe to persist and render — it is always one of the
   * fixed `ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES` values. Detailed subprocess
   * output and command arguments remain backend-only because they may contain
   * repository credentials or private host paths.
   *
   * Cleared as an explicit `null` so the absence of a failure survives JSON
   * serialization and field-by-field snapshot merges in the renderer.
   */
  lifecycleError?: string | null;
  name: string;
  branch: string;
  containerId: string | null;
  status: EnvironmentStatus;
  prUrl: string | null;
  prState: PrState | null;
  hasMergeConflicts: boolean | null;
  /**
   * Durable backend intent armed by the Resolve action.
   *
   * Agent completion asks the PR monitor for an immediate authoritative check;
   * the intent remains armed while GitHub still reports conflicts so an
   * unrelated concurrent turn cannot consume it.
   */
  prRecheckAfterAgentCompletionArmedAt?: string;
  createdAt: string;
  /** Last prompt dispatch or agent completion/waiting transition. */
  lastActivityAt?: string;
  /** Backend-owned aggregate agent activity shared by every frontend. */
  agentActivityState?: AgentActivityState;
  /** Last-write-wins timestamp for the aggregate activity snapshot. */
  agentActivityUpdatedAt?: string;
  /** Backend-internal observations used to derive the aggregate state. */
  agentActivitySources?: Partial<Record<AgentActivitySource, AgentActivitySourceSnapshot>>;
  /**
   * Renderer observations keyed by a hash of the renderer's opaque token.
   * Entries are leased so a crashed renderer cannot pin the aggregate forever.
   */
  frontendAgentActivityObservers?: Record<string, FrontendAgentActivityObserverSnapshot>;
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
  cursorBridgePid?: number;
  grokBridgePid?: number;
  piBridgePid?: number;
  localOpencodePort?: number;
  localClaudePort?: number;
  localCodexPort?: number;
  localCursorPort?: number;
  localGrokPort?: number;
  localPiPort?: number;
  /** Last backend-owned Claude model catalog for this environment. */
  claudeModelCatalog?: ClaudeModelCatalogSnapshot;
  /**
   * This environment's agent overrides — the narrowest of the three tiers.
   *
   * An absent field means "inherit from the repository, then the application",
   * which is what the settings panes write when a control returns to Inherit.
   *
   * Supersedes `defaultAgent`, `claudeMode`, `claudeNativeBackend`,
   * `opencodeMode` and `codexMode`, which the backend folds onto this shape on
   * load (`storage-agent-settings.ts`) and then deletes from the record.
   */
  agentSettings?: AgentSettingsTier;
  setupScriptsComplete?: boolean;
  /** Single backend-owned setup lifecycle projection. */
  setupPhase?: EnvironmentSetupPhase;
  /** Persisted acknowledgement that lets the user proceed after a setup failure. */
  setupOverride?: boolean;
  setupSessionId?: string;
  setupStartedAt?: string;
  setupCompletedAt?: string;
  /** Durable cleanup work written before a tab's external resources are closed. */
  tabTeardownIntents?: Record<
    string,
    {
      tabId: string;
      kind: TabTeardownKind;
      sessionId?: string;
      persistentSessionId?: string;
      createdAt: string;
    }
  >;
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
  /** Attachments waiting to be delivered or written before the first prompt. */
  initialPromptAttachments?: InitialPromptImageAttachment[];
  /** Backend-owned result of consuming pendingAgentLaunch. */
  startupAgentSession?: StartupAgentSessionSnapshot;
  /** Prompt awaiting a backend-owned rename after the environment starts. */
  pendingRenamePrompt?: string;
}

/** Stable renderer-facing projection used by environment list commands. */
export type ClientEnvironment = Omit<
  Environment,
  | "agentActivitySources"
  | "frontendAgentActivityObservers"
  | "prRecheckAfterAgentCompletionArmedAt"
  | "initialPromptAttachments"
  | "claudeModelCatalog"
  | "opencodePid"
  | "claudeBridgePid"
  | "codexBridgePid"
  | "cursorBridgePid"
  | "grokBridgePid"
  | "piBridgePid"
  | "pendingRenamePrompt"
  | "tabTeardownIntents"
> & {
  /**
   * Whether the stripped `initialPromptAttachments` array holds anything.
   *
   * The bodies are excluded from list hydration because they are base64
   * payloads, but the renderer still has to know whether a targeted detail read is
   * worth making — and whether failing that read should block a launch. Without
   * this flag every launch with a stored prompt pays for the read and is
   * blocked by any transient failure, including the common no-attachment case.
   */
  hasInitialPromptAttachments?: boolean;
};

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
}

/** Version 2 makes pane and tab selection authoritative in this record. */
export { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

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
  controllerLease?: {
    ownerId: string;
    token: string;
    expiresAt: string;
  };
}

/** Durable envelope for a backend-owned Multi Review workflow. */
export interface PersistedMultiReviewWorkflow {
  version: number;
  id: string;
  environmentId: string;
  snapshot: unknown;
  updatedAt: string;
  revision: number;
  controllerLease?: {
    ownerId: string;
    token: string;
    expiresAt: string;
  };
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

export type NativeAgentProvider = "claude" | "codex" | "opencode" | "cursor" | "grok" | "pi";
export const NATIVE_AGENT_SESSION_VERSION = 1 as const;

export interface OpenCodeIncompleteTurnNotice {
  kind: "failed" | "exhausted";
  assistantMessageId: string;
  updatedAt: string;
}

/**
 * Exact replay data for a dispatch whose provider acknowledgement was lost.
 * This lives only in the backend's sensitive store; projections expose the
 * request id and timestamp, never prompt or attachment content.
 */
export interface PersistedNativeAgentPendingDispatch {
  requestId: string;
  prompt: string;
  images?: Array<{ filename: string; data: string }>;
  attachments?: Array<{
    type: "image" | "file";
    path: string;
    dataUrl?: string;
    filename?: string;
  }>;
  schema?: Record<string, unknown>;
  mode?: "plan" | "build";
  fastMode?: boolean;
  subAgent?: string;
  executionAgent?: string;
  includeLocalSettings?: boolean;
  promptSuggestions?: boolean;
  model?: string;
  reasoningEffort?: string;
  createdAt: string;
}

/**
 * Durable mapping between a logical UI tab and the provider session that owns
 * its transcript. The backend creates this mapping atomically, so any number of
 * renderers asking for the same tab receive the same provider session.
 */
export interface PersistedNativeAgentSession {
  version: typeof NATIVE_AGENT_SESSION_VERSION;
  key: string;
  environmentId: string;
  agent: NativeAgentProvider;
  logicalSessionKey: string;
  providerSessionId: string;
  origin: AgentInteractionOrigin;
  interactionPolicy: AgentInteractionPolicy;
  /** Provider-neutral interactive choices that survive renderer/backend restarts. */
  controls?: import("@orkestrator/protocol/native-agent").NativeAgentControlUpdate;
  dispatchedRequestIds?: string[];
  /** Retained only while the provider outcome is ambiguous. */
  pendingDispatch?: PersistedNativeAgentPendingDispatch;
  /** Content-free authoritative outcome rehydrated by every OpenCode tab. */
  openCodeIncompleteTurnNotice?: OpenCodeIncompleteTurnNotice;
  createdAt: string;
  updatedAt: string;
}

/** Content-free exact-once interaction records owned by backend workflows. */
export type PersistedAgentInteractionResolutionJournal = AgentInteractionResolutionJournal;
export type PersistedAgentInteractionWorkflowSummary = AgentInteractionWorkflowSummary;

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
  /**
   * A backend-owned dispatch lease. The item remains durable here until the
   * provider acknowledges its stable request id, so a backend restart cannot
   * lose a prompt between dequeue and network dispatch.
   */
  inFlight?: {
    message: unknown;
    requestId: string;
    reservedAt: string;
    /** Persisted immediately before crossing the irreversible tmux boundary. */
    submittingAt?: string;
    /** Persisted after tmux accepted the prompt, before queue acknowledgement. */
    submittedAt?: string;
  };
  /**
   * Terminal provider rejection. The original message is restored to the head
   * of `messages`; this marker prevents unattended retries until a caller
   * explicitly clears it.
   */
  dispatchError?: {
    requestId: string;
    /** Stable identity of the restored queue item that was rejected. */
    messageId: string;
    /**
     * SHA-256 of the rejected message's JSON representation. Queue saves keep
     * the latch only while this exact item is still present unchanged.
     */
    messageFingerprint: string;
    message: string;
    failedAt: string;
  };
  /**
   * A durable, exclusive claim on the message currently being handed to an
   * agent. The message stays here until the renderer acknowledges that the
   * bridge accepted it, so a renderer crash cannot silently discard it.
   */
  outstandingClaim?: {
    token: string;
    message: unknown;
    claimedAt: string;
    expiresAt: string;
  };
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
  /**
   * Bounded provenance for an idempotent queue-to-draft transfer. Ordinary
   * draft saves never set this field.
   */
  sourcePromptQueue?: {
    queueKey: string;
    messageId: string;
  };
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
  /**
   * Legacy last-create state retained for config and older-client compatibility.
   * Current create dialogs ignore it and resolve every control from Settings.
   *
   * @deprecated
   */
  lastEnvironmentAgentSelection?: {
    platform: DefaultAgent;
    mode: AgentStyle;
  };
  defaultPortMappings?: PortMapping[];
  filesToCopy?: string[];
  entryPort?: number;
  /**
   * This repository's agent overrides — the middle tier.
   *
   * Supersedes `defaultAgent`, `agentStyle` (which only Claude ever read),
   * `claudeNativeBackend`, and the single `defaultModel`/`defaultEffort` pair
   * two consumers disagreed about. An absent field means "inherit from the
   * application".
   */
  agentSettings?: AgentSettingsTier;
}

export interface AppConfig {
  version: string;
  desktopConnections?: import("@orkestrator/protocol/connections").StoredDesktopConnections;
  global: {
    /** Agent systems installed and exposed in launch/review surfaces. */
    enabledAgentPlatforms?: AgentPlatform[];
    favoriteModels?: Array<{ platform: AgentPlatform; modelId: string }>;
    containerResources: { cpuCores: number; memoryGb: number };
    envFilePatterns: string[];
    anthropicApiKey?: string;
    /** Cursor API key forwarded to containerized Cursor Agent processes. */
    cursorApiKey?: string;
    githubToken?: string;
    /** Reuse the host's active `gh auth login` token for container GitHub access. */
    useHostGitHubCredentials?: boolean;
    /**
     * Deliver the host's Claude Code OAuth credential into containers.
     *
     * Defaults to on, which is what keeps a container agent signed in. Turning
     * it off keeps a long-lived host token out of environments that run
     * untrusted repository code, at the cost of an in-container `claude /login`.
     */
    useHostClaudeCredentials?: boolean;
    allowedDomains: string[];
    preferredEditor?: "vscode" | "cursor";
    /**
     * Application-wide agent defaults — the widest of the three tiers, and the
     * only one with a shipped fallback beneath it.
     *
     * Supersedes `defaultAgent`, the three `*Mode` fields,
     * `claudeNativeBackend`, `actionDefaults`, and the four model/effort fields
     * that had no UI at all. The two `*NativeFastModeDefault` fields are
     * dropped rather than migrated: speed is a per-session choice made in the
     * model picker, and OpenCode expresses it as a `-fast` model id rather than
     * a toggle.
     */
    agentSettings?: AgentSettingsTier;
    /**
     * OpenCode provider catalogues offered in model pickers. Filtering happens
     * in the backend so the renderer never receives the full OpenCode
     * catalogue. An empty list means unrestricted.
     */
    openCodeModelProviders?: string[];
    /** Maximum concurrently open spawned-agent threads per native Codex session. */
    codexMaxConcurrentThreads: number;
    terminalAppearance: {
      fontFamily: string;
      fontSize: number;
      backgroundColor: string;
    };
    terminalScrollback: number;
    experimentalCodexRawEventLogging?: boolean;
    /**
     * Run Cursor sessions on the SDK bridge instead of the ACP one.
     *
     * Experimental and off by default: the two bridges are separate processes
     * with separate session stores, so switching this changes which engine a
     * new Cursor session is created on. Existing sessions stay with the bridge
     * that created them.
     */
    experimentalCursorSdkBridge?: boolean;
    debugLogging?: boolean;
    /** Number of days production application logs remain on disk. */
    debugLogRetentionDays?: number;
    webClientEnabled?: boolean;
    /** Editable preference embedded inside Orkestrator's fixed review contract. */
    reviewInstruction?: string;
  };
  repositories: Record<string, RepositoryConfig>;
}
