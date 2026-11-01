import type { StartupAgentTabId } from "@orkestrator/protocol/tab-initial-prompt";
// Re-exported rather than redeclared: the renderer orders activity reports
// against the same vocabulary, and two copies of it drift silently.
import type {
  AgentActivitySource,
  AgentActivitySourceSnapshot,
  AgentActivityState,
  FrontendAgentActivityObserverSnapshot,
} from "@orkestrator/protocol/agent-activity";
import type { TabTeardownKind } from "@orkestrator/protocol/tab-teardown";
import type { GitHubPullRequestMergeability } from "@orkestrator/protocol/github-pull-requests";
import type {
  EnvironmentDiffBaseline,
  EnvironmentDiffBaseOverride,
} from "@orkestrator/protocol/diff-stats";
import type {
  ContainerLifecycleSnapshot,
  EnvironmentContainerLifecycle,
} from "@orkestrator/protocol/container-lifecycle";
import type {
  AgentInteractionOrigin,
  AgentInteractionPolicy,
  AgentInteractionResolutionJournal,
  AgentInteractionWorkflowSummary,
} from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  CoordinatorResearchMcpServer,
  CoordinatorWebResearch,
} from "@orkestrator/protocol/coordinator-web-research";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import type { TrustedUserPromptPresentation } from "@orkestrator/protocol/review-evidence-frames";

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
  /**
   * Sidebar folder this project is grouped under, or null/absent for the root
   * level. The name is the folder's whole identity — see
   * `@orkestrator/protocol/project-folders`.
   */
  folder?: string | null;
  /**
   * Sidebar icon: a small raster image as a base64 data URL, or absent for
   * the default. See `@orkestrator/protocol/project-icon`.
   */
  icon?: string | null;
}

export type EnvironmentStatus = "running" | "stopped" | "error" | "creating" | "stopping";
export type PrState = "open" | "merged" | "closed";
export type NetworkAccessMode = "full" | "restricted";
export type EnvironmentType = "containerized" | "local";
export type EnvironmentLifecycleOperation = "deleting" | "merging" | "moving";
/**
 * Durable progress of an environment move. `moving`: the worktree may still
 * be at `from` (git renames it atomically; a copy to another disk goes to
 * `staging` first). `copied`: the copy is complete at `to` and Git points
 * at it. `committed`: storage also points at `to`; provider relocation and
 * source cleanup remain retryable, and filesystem rollback is forbidden.
 */
export interface WorktreeMoveRecord {
  from: string;
  to: string;
  staging?: string;
  phase: "moving" | "copied" | "committed";
  fromCanonical?: string;
  fromRoot?: string;
  removeSource?: boolean;
  sourceIdentity?: { dev: number; ino: number };
  sourceCleaned?: boolean;
  /**
   * Submodules whose git dir lives outside the worktree (under the
   * repository's `.git/worktrees/<name>/modules`). A copy re-links each one.
   */
  submodules?: WorktreeMoveSubmodule[];
  startedAt: string;
}
export interface WorktreeMoveSubmodule {
  /** Path relative to the worktree root. */
  path: string;
  /** Absolute git dir of the submodule checkout. */
  gitDir: string;
}
export type EnvironmentSetupPhase = "pending" | "running" | "ready" | "failed";
export type PortProtocol = "tcp" | "udp";

export interface PortMapping {
  containerPort: number;
  /** A fixed host port (1-65535), or 0 when `hostPortMode` is "auto". */
  hostPort: number;
  protocol: PortProtocol;
  /**
   * "auto": Docker assigns an ephemeral loopback host port at creation, so
   * environments never compete for 3000/5173. Preview services follow the
   * actual binding. Absent means a fixed `hostPort`.
   */
  hostPortMode?: "auto";
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
  "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

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
  /**
   * Providers OpenCode last reported as connected, so a read made before any
   * bridge is running can tell a model this login can serve from one it
   * cannot. Absent when OpenCode never reported connectivity for this project.
   * `models` deliberately stays unfiltered by it: a provider connected later
   * must still be known once the next bridge reports it.
   */
  connectedProviderIds?: string[];
  /** When {@link connectedProviderIds} was last observed to change. */
  connectedProvidersCheckedAt?: string;
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
  tabId: StartupAgentTabId;
  agent: DefaultAgent;
  style: AgentStyle;
  model?: string;
  reasoningEffort?: string;
  providerSessionId?: string;
  status: "starting" | "running" | "error";
  startedAt?: string;
  error?: string;
}

/**
 * How a source's work ended, when it knows: `failed` rings `agent_failed`, and
 * `none` means nothing completed, so going idle rings nothing. Absent, the
 * source's working-to-idle edge says the work finished.
 */
export type AgentActivityCompletionOutcome = "failed" | "none";

/**
 * Content-free cause of an environment's unread badge.
 *
 * - `agent_finished`: an agent turn ended.
 * - `agent_failed`: an agent turn ended with the provider's terminal error
 *   (a refused login, a provider error, a restart mid-turn), not an answer.
 * - `agent_ready`: no longer recorded; rows written before the readiness bell
 *   was retired may still carry it (the composer was free while background
 *   work continued).
 * - `agent_waiting`: an agent stopped to wait on the user (approval, plan, prompt).
 * - `agent_question`: an agent asked a question that needs an answer.
 * - `terminal_finished`: a terminal-hosted agent finished.
 * - `marked_unread`: a client marked the environment unread.
 */
export type EnvironmentUnreadReason =
  | "agent_finished"
  | "agent_failed"
  | "agent_ready"
  | "agent_waiting"
  | "agent_question"
  | "terminal_finished"
  | "marked_unread";

export interface Environment {
  /** Monotonic fence for mail-triggered starts across explicit stop transitions. */
  stopGeneration?: number;
  id: string;
  projectId: string;
  /** Idempotency key for an externally requested environment launch. */
  controlRequestId?: string;
  /**
   * SHA-256 of the canonical creation intent that first used
   * `controlRequestId`. Absent on legacy records, which cannot detect a
   * changed payload and converge as before.
   */
  controlRequestFingerprint?: string;
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
  /**
   * Durable container lifecycle record: runtime/storage identity, the one
   * unresolved operation and recent outcomes. Backend-private; clients receive
   * `ContainerLifecycleSnapshot`. Always read through `parseContainerLifecycle`
   * because a newer backend may have written a version this one cannot read.
   */
  containerLifecycle?: EnvironmentContainerLifecycle;
  /**
   * Per-environment resource budget; overrides the global default. Absent
   * inherits; a `null` field is explicitly unrestricted.
   */
  containerResourceLimits?: import("@orkestrator/protocol/container-resources").ContainerResourceLimits;
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
  /** Backend-owned generation that prevents a later rename from reusing branch history. */
  branchRevision?: number;
  containerId: string | null;
  status: EnvironmentStatus;
  prUrl: string | null;
  /** Actual PR base observed by the backend, independent of repository defaults. */
  prBaseBranch?: string | null;
  prState: PrState | null;
  hasMergeConflicts: boolean | null;
  /**
   * GitHub's merge state from the PR monitor's last reading (see
   * `@orkestrator/protocol/pr-merge-readiness`). Cleared whenever `prUrl`
   * changes, so it never describes a predecessor PR. Absent on records
   * written before it existed.
   */
  prMergeability?: GitHubPullRequestMergeability | null;
  /**
   * Durable backend intent armed by the Resolve action.
   *
   * Agent completion asks the PR monitor for an immediate authoritative check;
   * the intent remains armed while GitHub still reports conflicts so an
   * unrelated concurrent turn cannot consume it.
   */
  prRecheckAfterAgentCompletionArmedAt?: string;
  /**
   * The user asked the backend to merge this environment's open pull request
   * as soon as GitHub reports it ready, and to launch Resolve when it
   * conflicts (`pr-auto-merge.ts`). Absent means off.
   */
  autoMerge?: boolean;
  /** PR-specific authorization and freshness fence. */
  autoMergePrUrl?: string | null;
  autoMergeEnabledAt?: string | null;
  /** Last automatic attempt failure, cleared after recovery. */
  autoMergeError?: string | null;
  /** Recoverable Resolve identity, retained across pre-dispatch failures. */
  autoMergeResolveRequestId?: string;
  createdAt: string;
  /** Last prompt dispatch or agent completion/waiting transition. */
  lastActivityAt?: string;
  /** Last backend-observed native session completion, even if another session is working. */
  agentSessionCompletedAt?: string;
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
  /**
   * Where the branch now leaves its target branch, once it has taken in newer
   * target history. Backend-owned (`diff-baseline.ts`); read through
   * `environmentBaselineCommit`. Cleared as an explicit `null`.
   */
  diffBaseline?: EnvironmentDiffBaseline | null;
  /**
   * A commit the user chose to measure changes from instead of `diffBaseline`
   * (`diff-base-override.ts`). Cleared as an explicit `null`.
   */
  diffBaseOverride?: EnvironmentDiffBaseOverride | null;
  /** Immutable source selected by a coordinator delegation. */
  delegationBaseBranch?: string;
  delegationBaseCommit?: string;
  networkAccessMode: NetworkAccessMode;
  allowedDomains?: string[];
  /**
   * Providers whose credentials the user removed from this environment. They
   * are left out of staged inputs and credential syncs until allowed again.
   */
  revokedInputProviders?: AgentPlatform[];
  order: number;
  portMappings?: PortMapping[];
  entryPort?: number;
  hostEntryPort?: number;
  environmentType: EnvironmentType;
  worktreePath?: string;
  /**
   * The folder the worktree was created in. Chosen when the environment is
   * created, or recorded from the default when the worktree is made; deletion
   * removes the worktree only from inside it.
   */
  worktreeBaseDir?: string;
  /**
   * A move of the worktree to another folder that has started and not yet
   * settled. Startup recovery adopts a completed move or abandons the rest.
   */
  worktreeMove?: WorktreeMoveRecord;
  /**
   * Marks the project home: a local environment whose `worktreePath` is the
   * project's own checkout. Never a disposable workspace — see
   * `project-home-environment.ts` for the paths that must honour it.
   */
  projectHome?: boolean;
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
      /** Backend-captured resume identity, durable before provider close. */
      resumableSessionId?: string;
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
  /** What most recently lit `hasUnreadWork`; cleared with it. */
  unreadReason?: EnvironmentUnreadReason;
  /** Bounded content-free dedupe keys for agent events that requested attention. */
  agentAttentionKeys?: string[];
  /** Durable intent to open the configured agent once setup is ready. */
  pendingAgentLaunch?: boolean;
  /** One-shot agent selected for pendingAgentLaunch. */
  initialAgentPlatform?: AgentPlatform;
  /** One-shot model for the agent tab created from pendingAgentLaunch. */
  initialAgentModel?: string;
  /** One-shot reasoning effort for the agent tab created from pendingAgentLaunch. */
  initialReasoningEffort?: string;
  /**
   * One-shot Fast/Normal choice for the agent tab created from
   * pendingAgentLaunch.
   *
   * Separate from the platform tier's `fastMode` for the same reason the two
   * fields above are: a launcher may pick a speed for this one run without
   * that becoming the environment's durable setting. Absent means the tier
   * decides.
   */
  initialFastMode?: boolean;
  /** One-shot conversation mode for the agent tab created from pendingAgentLaunch. */
  initialConversationMode?: "plan" | "build";
  initialPrompt?: string;
  /** Backend-authenticated display treatment for the initial provider echo. */
  initialPromptPresentation?: TrustedUserPromptPresentation;
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
  | "initialPromptPresentation"
  | "initialConversationMode"
  | "claudeModelCatalog"
  | "opencodePid"
  | "claudeBridgePid"
  | "codexBridgePid"
  | "cursorBridgePid"
  | "grokBridgePid"
  | "piBridgePid"
  | "pendingRenamePrompt"
  | "tabTeardownIntents"
  | "controlRequestId"
  | "controlRequestFingerprint"
  | "branchRevision"
  | "containerLifecycle"
> & {
  /** Safe projection of the durable container lifecycle record. */
  containerLifecycle?: ContainerLifecycleSnapshot;
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

/** Content-free outcome of an automatic incomplete-turn recovery. */
export interface IncompleteTurnNotice {
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
  /** Provider proved this mail send was refused; cleanup may be retried safely. */
  mailRefused?: true;
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
  /**
   * The resolved command intent. A retry reuses it verbatim, so a command
   * that was selected (or typed and resolved) can never come back as text.
   */
  command?: import("@orkestrator/protocol/native-agent").NativeAgentCommandIntent;
  /**
   * The "Continue in…" handoff this request carries. A confirmation of the
   * parked request records it delivered; a retry re-sends the same carrier.
   */
  agentHandoffId?: string;
  createdAt: string;
}

/**
 * A prompt held for re-sending after a Claude sign-in. Everything a dispatch
 * needs to send the same prompt again; the resend gets its own request id,
 * derived from the refused one, so it is journaled at most once.
 */
export interface PersistedNativeAgentSignInResend {
  /** The refused request. The session's latest dispatch must still be this one. */
  requestId: string;
  providerSessionId: string;
  prompt: string;
  attachments?: PersistedNativeAgentPendingDispatch["attachments"];
  model?: string;
  reasoningEffort?: string;
  mode?: "plan" | "build";
  fastMode?: boolean;
  subAgent?: string;
  includeLocalSettings?: boolean;
  promptSuggestions?: boolean;
  recordedAt: string;
}

/**
 * One steering instruction whose provider admission is still unresolved.
 *
 * Unlike an ordinary prompt, the backend owns this request id. The renderer
 * contributes only the text; keeping the exact run and input here is what lets
 * any later renderer retry or discard the same operation after a restart.
 */
export interface PersistedNativeAgentPendingSteer {
  requestId: string;
  text: string;
  inputDigest: string;
  expectedRunId: string;
  state: "prepared" | "unknown";
  /** Source reservation survives until delivery or definitive non-delivery. */
  sourceQueue?: true;
  queueSettlement?: "applied" | "restore" | "discard";
  createdAt: string;
}

/** What a backend-owned native job does when its agent finishes (Resolve's PR refresh). */
export type NativeAgentJobCompletionAction = "refresh-pr-after-agent-completion";

/**
 * Durable mapping between a logical UI tab and the provider session that owns
 * its transcript. The backend creates this mapping atomically, so any number of
 * renderers asking for the same tab receive the same provider session.
 */
export interface PersistedNativeAgentSession {
  version: typeof NATIVE_AGENT_SESSION_VERSION;
  key: string;
  environmentId: string;
  /** Explicit durable owner. Records written before v2 migrate to environment ownership. */
  owner?: import("@orkestrator/protocol/coordinator").AgentSessionOwner;
  /** Immutable backend-owned execution policy; renderer inputs never replace it. */
  executionPolicy?: "coordinator-read-only";
  /** Immutable normalized policy passed to the provider when this session was created. */
  policy?: import("@orkestrator/protocol/native-agent").NativeAgentExecutionPolicy;
  agent: NativeAgentProvider;
  logicalSessionKey: string;
  providerSessionId: string;
  origin: AgentInteractionOrigin;
  interactionPolicy: AgentInteractionPolicy;
  /** Provider-neutral interactive choices that survive renderer/backend restarts. */
  controls?: import("@orkestrator/protocol/native-agent").NativeAgentControlUpdate;
  /**
   * Observed OpenCode model written only when host controls have no modelId.
   * Ranks below a live provider session model so a later TUI change can win.
   */
  inferredComposerSelection?: { modelId: string; reasoningId?: string };
  /** Exact backend-authored frame that may be hidden on the first matching user echo. */
  initialPromptPresentation?: TrustedUserPromptPresentation;
  dispatchedRequestIds?: string[];
  /**
   * The mode the newest accepted turn was sent in. A prompt can state its own
   * mode without changing `controls`, so a continuation of that turn reads it here.
   */
  lastDispatchedTurn?: { requestId: string; mode?: "plan" | "build" };
  /** Retained only while the provider outcome is ambiguous. */
  pendingDispatch?: PersistedNativeAgentPendingDispatch;
  /** Retained until an ambiguous steer is authoritatively reconciled or discarded. */
  pendingSteer?: PersistedNativeAgentPendingSteer;
  /**
   * The last parked dispatch the backend retired because the provider reported
   * its outcome lost. Content-free; renderers rehydrate it to release the
   * draft's request id. Replaced by the next retirement, cleared by the next
   * accepted dispatch, and ignored by readers once
   * `NATIVE_AGENT_RETIRED_DISPATCH_TTL_MS` has passed. Deliberately not
   * validated with the session record: a malformed value reads as absent
   * rather than making the session unreadable.
   */
  retiredDispatch?: PersistedNativeAgentRetiredDispatch;
  /**
   * Content-free authoritative recovery outcome rehydrated by every tab.
   *
   * The field keeps the name it was first persisted under, when OpenCode was
   * the only platform with turn recovery, so sessions earlier versions wrote
   * (and the legacy JSON import carries over) read unchanged. Storage writes it; everything else reads it
   * through {@link sessionIncompleteTurnNotice}.
   */
  openCodeIncompleteTurnNotice?: IncompleteTurnNotice;
  /**
   * Bounded, content-free outcomes of recent turns keyed by the request id that
   * started them, recorded from provider status reads the backend already
   * makes. Lets observers settle a turn as failed without reading transcripts.
   */
  turnOutcomes?: PersistedNativeAgentTurnOutcome[];
  /**
   * "Continue in…" handoffs this session's journal delivered, written in the
   * same record update that journals the carrying request as dispatched.
   * Read through `deliveredAgentHandoffIds` (`native-agent-handoffs.ts`): like
   * `retiredDispatch`, a malformed value reads as absent.
   */
  deliveredAgentHandoffIds?: string[];
  /**
   * A prompt Claude refused because it was not signed in, held to be sent
   * again once a sign-in succeeds (`native-agent-sign-in-resend.ts`). Read
   * through `sessionSignInResend`; a malformed value reads as absent.
   */
  signInResend?: PersistedNativeAgentSignInResend;
  /** Last applied activity for a request; settled roots may still own background work. */
  activityTurn?: {
    providerSessionId: string;
    requestId?: string;
    state: "active" | "settled";
  };
  /**
   * The session's goal (`plans/goals.md`). Read through `sessionGoal`: like
   * `retiredDispatch`, a malformed value reads as absent rather than making the
   * session unreadable.
   */
  goal?: import("@orkestrator/protocol/native-agent-goal").NativeAgentGoal;
  /** The last few ended goals, without their check output. */
  goalHistory?: import("@orkestrator/protocol/native-agent-goal").NativeAgentGoal[];
  /**
   * Bounded request ids whose turn was still active when a stop was requested.
   * A provider reports a stopped turn as idle, so this is the only durable
   * evidence that the turn did not finish on its own.
   */
  interruptedRequestIds?: string[];
  /**
   * The identity a later resume of this conversation names (Codex's thread id),
   * as the provider last reported it for `providerSessionId`. Lets tab
   * teardown keep a resumable identity when the open session can no longer be
   * read. Deliberately not validated with the session record: read it only
   * through {@link nativeAgentSessionResumeIdentity}, where a malformed or
   * stale value reads as absent.
   */
  resumeIdentity?: { providerSessionId: string; resumableSessionId: string };
  /**
   * The title the backend chose for `providerSessionId` (generated, or the
   * first-message fallback when no generator could run), and whether the
   * provider has accepted it. Unpushed, it outranks the provider's own title,
   * so a failed push never loses it; Cursor and Grok have no setter, so there
   * it is always authoritative. Deliberately not validated with the session
   * record: read it only through {@link nativeAgentSessionBackendTitle}, where
   * a malformed or stale value reads as absent.
   */
  backendTitle?: NativeAgentSessionBackendTitle;
  createdAt: string;
  updatedAt: string;
}

export interface NativeAgentSessionBackendTitle {
  providerSessionId: string;
  title: string;
  source: "generated" | "fallback";
  /** The provider confirmed it holds this title. */
  pushed?: boolean;
}

/** Bytes a stored backend title may hold; a longer one reads as absent. */
const MAX_BACKEND_TITLE_LENGTH = 512;

/** The recorded backend title, only while it still describes the mapped session. */
export function nativeAgentSessionBackendTitle(
  session: Pick<PersistedNativeAgentSession, "providerSessionId" | "backendTitle">,
): NativeAgentSessionBackendTitle | undefined {
  const value: unknown = session.backendTitle;
  if (!value || typeof value !== "object") return undefined;
  const { providerSessionId, title, source, pushed } = value as Record<string, unknown>;
  if (providerSessionId !== session.providerSessionId) return undefined;
  if (typeof title !== "string" || !title.trim() || title.length > MAX_BACKEND_TITLE_LENGTH) {
    return undefined;
  }
  if (source !== "generated" && source !== "fallback") return undefined;
  return { providerSessionId, title, source, ...(pushed === true ? { pushed: true } : {}) };
}

/** The recorded resume identity, only while it still describes the mapped session. */
export function nativeAgentSessionResumeIdentity(
  session: Pick<PersistedNativeAgentSession, "providerSessionId" | "resumeIdentity">,
): string | undefined {
  const identity: unknown = session.resumeIdentity;
  if (!identity || typeof identity !== "object") return undefined;
  const { providerSessionId, resumableSessionId } = identity as Record<string, unknown>;
  return providerSessionId === session.providerSessionId &&
    typeof resumableSessionId === "string" &&
    resumableSessionId.trim()
    ? resumableSessionId.trim()
    : undefined;
}

export interface PersistedNativeAgentRetiredDispatch {
  requestId: string;
  retiredAt: string;
}

/** A session's incomplete-turn notice, independent of its persisted field name. */
export function sessionIncompleteTurnNotice(
  session: Pick<PersistedNativeAgentSession, "openCodeIncompleteTurnNotice">,
): IncompleteTurnNotice | undefined {
  return session.openCodeIncompleteTurnNotice;
}

export interface PersistedNativeAgentTurnOutcome {
  requestId: string;
  outcome: "completed" | "failed";
  /** Bounded provider error detail for a failed turn. */
  error?: string;
  observedAt: string;
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
export interface NativeAgentJobReceipt {
  requestId: string;
  /** Coalesced presses follow the original admission, including its eventual settlement. */
  dispatchRequestId?: string;
  fingerprint: string;
  status: "accepted" | "unknown";
  queued?: true;
}

export interface PersistedPromptQueue {
  /** Bounded job request bindings, published before dispatch and kept after queue settlement. */
  jobReceipts?: NativeAgentJobReceipt[];
  /** Only older backends write this lease; retain exclusion until settlement or expiry. */
  outstandingClaim?: {
    token: string;
    message: Record<string, unknown>;
    claimedAt: string;
    expiresAt: string;
  };
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
    /** Manual steering reservations must never drain as ordinary prompts. */
    steer?: true;
    /**
     * A steer reservation taken from behind the head: the id of the item that
     * was ahead of it, so a restored steer returns to its slot rather than
     * jumping the queue. Absent (or no longer queued) restores to the head.
     */
    restoreAfterId?: string;
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
   * Bounded tombstones for backend-authored items (typed `origin`) that left
   * `messages` without being reserved — i.e. removed or replaced
   * before dispatch. Lets the owner tell "removed" from "already sent".
   */
  removedOrigins?: Array<{ requestId: string; removedAt: string }>;
  updatedAt: string;
  revision: number;
}

/** Whether a job's accepted prompt still occupies this conversation or its queue. */
export function nativeAgentJobReceiptIsActive(
  receipt: NativeAgentJobReceipt,
  session: PersistedNativeAgentSession | null,
  queue: PersistedPromptQueue | null | undefined,
): boolean {
  const requestId = receipt.dispatchRequestId ?? receipt.requestId;
  if (
    [...(queue?.messages ?? []), queue?.outstandingClaim?.message, queue?.inFlight?.message].some(
      (message) =>
        message &&
        typeof message === "object" &&
        ((message as Record<string, unknown>).requestId === requestId ||
          (message as Record<string, unknown>).id === requestId),
    )
  )
    return true;
  if (
    session?.pendingDispatch?.requestId === requestId ||
    session?.pendingSteer?.requestId === requestId
  )
    return true;
  if (session?.turnOutcomes?.some((outcome) => outcome.requestId === requestId)) return false;
  if (session?.dispatchedRequestIds?.includes(requestId))
    return session.dispatchedRequestIds.at(-1) === requestId;
  // A removed waiting item is consumed. An unconfirmed direct admission stays fenced.
  return !receipt.queued;
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
   * Bounded provenance written by the retired queue-to-draft transfer command.
   * Nothing sets it any more; drafts persisted by older versions still carry
   * it, so it is validated on load and kept on save.
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
  /** Versioned persisted-config migration discriminator. */
  schemaVersion?: number;
  version: string;
  desktopConnections?: import("@orkestrator/protocol/connections").StoredDesktopConnections;
  global: {
    /**
     * Resource budget enforced on new container runtimes (Settings →
     * Container). Absent means the built-in default for the daemon
     * (`builtInResourceDefault`); all-`null` limits mean unrestricted.
     * Written only by `setContainerResourceLimits`. (The older
     * `containerResources` value was never applied and is not read.)
     */
    containerResourceLimits?: import("@orkestrator/protocol/container-resources").ContainerResourceLimits;
    /** Agent systems installed and exposed in launch/review surfaces. */
    enabledAgentPlatforms?: AgentPlatform[];
    /**
     * Which runtime runs new Multi Reviews (item 301). Absent means
     * `bespoke`; `ORKESTRATOR_MULTI_REVIEW_ENGINE` overrides it for testing.
     */
    multiReviewEngine?: import("@orkestrator/protocol/multi-review").MultiReviewEngine;
    /**
     * Weakest read-only guarantee a coordinator conversation may run under.
     *
     * Absent means `provider-configured`: platforms whose boundary the
     * provider or the OS holds, plus those told to deny mutations without a
     * way for Orkestrator to verify it. `advisory` stays opt-in because there
     * nothing outside the agent's own cooperation stops a write.
     */
    coordinatorProviderTiers?: "enforced" | "provider-configured" | "advisory";
    /** Internal marker for the one-time coordinator safety-default migration. */
    coordinatorProviderTierDefaultVersion?: number;
    /**
     * Web research a coordinator may do. Absent means the product default
     * (`search-and-mcp`). Commands and hosted page fetches stay off in every
     * mode; see `@orkestrator/protocol/coordinator-web-research`.
     */
    coordinatorWebResearch?: CoordinatorWebResearch;
    /** Remote research MCP servers; absent means the default list (Context7). */
    coordinatorResearchMcpServers?: CoordinatorResearchMcpServer[];
    favoriteModels?: Array<{ platform: AgentPlatform; modelId: string }>;
    containerResources: { cpuCores: number; memoryGb: number };
    envFilePatterns: string[];
    anthropicApiKey?: string;
    /** Cursor API key forwarded to containerized Cursor Agent processes. */
    cursorApiKey?: string;
    /** OpenCode Zen (Go) plan key, used to read plan usage in Settings. */
    openCodeZenApiKey?: string;
    githubToken?: string;
    /** Reuse the host's active `gh auth login` token for container GitHub access. */
    useHostGitHubCredentials?: boolean;
    /**
     * The user asked not to be reminded at startup to set up the GitHub CLI.
     * Written only by `setGitHubCliReminderDismissed`; the settings form never
     * sends it.
     */
    githubCliReminderDismissed?: boolean;
    /** Optional absolute SSH-agent socket path. Absent means auto-detect from the desktop session. */
    sshAgentSocketPath?: string;
    /**
     * Auto-merge waits for failing or pending checks GitHub does not require.
     * True or absent waits for all checks; false merges once GitHub allows it.
     * Required checks still block. Read by `PrAutoMergeController` on this machine.
     */
    autoMergeRequireChecks?: boolean;
    /**
     * Absolute directory new projects are cloned into on this machine, for
     * example when a project is copied here from another machine. Absent
     * means the most common parent of the existing projects, else `~/Projects`.
     */
    defaultProjectsDirectory?: string;
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
     * that had no UI at all. Platform speed is `platforms[agent].fastMode`, the
     * same Fast/Normal axis the model picker exposes. Each action default can
     * override that with its own `fastMode` so PR and Consolidation need not
     * share one Fast choice. A legacy `*NativeFastModeDefault` key is migrated
     * when it is still present; an earlier release may already have stripped it
     * before this field existed.
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
    /**
     * Longest a Claude native session may keep a background shell command
     * running, in hours. Absent means the Claude CLI's own 2-hour ceiling.
     */
    claudeBackgroundCommandLimitHours?: number;
    /** Which agent logins may write session titles. Absent is `any-signed-in`. */
    sessionTitleGeneration?: import("@orkestrator/protocol/session-title-generation").SessionTitleGenerationPolicy;
    terminalAppearance: {
      fontFamily: string;
      fontSize: number;
      backgroundColor: string;
    };
    terminalScrollback: number;
    terminalHistoryEnabled?: boolean;
    terminalHistoryRetentionMb?: number;
    terminalHistoryGlobalRetentionMb?: number;
    terminalHistoryRetentionDays?: number;
    experimentalCodexRawEventLogging?: boolean;
    /**
     * Experimental gate for scheduled jobs. Off (or absent) hides Settings →
     * Schedules, refuses the schedule commands and public actions, withholds
     * the agent and coordinator schedule tools and stops schedules firing;
     * stored schedules are kept.
     */
    experimentalScheduling?: boolean;
    /**
     * Experimental gate for graphs in the web UI. Off (or absent) hides the
     * action bar's Graphs and Run graph… buttons and a ticket's Run graph…;
     * the graph commands, tools and already-open graph tabs are unaffected.
     */
    experimentalGraphs?: boolean;
    debugLogging?: boolean;
    /** Number of days production application logs remain on disk. */
    debugLogRetentionDays?: number;
    webClientEnabled?: boolean;
    /** Audible cues for background events that need the user's attention. */
    notificationSounds?: import("@orkestrator/protocol/notification-sounds").NotificationSoundSettings;
    /** Editable preference embedded inside Orkestrator's fixed review contract. */
    reviewInstruction?: string;
    /**
     * Reviewer focus presets the launchers offer (`review-lens.ts`). Absent
     * means the shipped five; a stored list, even an empty one, is the user's.
     */
    reviewLensPresets?: import("@orkestrator/protocol/review-lens").ReviewLensPreset[];
    agentMessaging?: import("@orkestrator/protocol/agent-mail").AgentMessagingSettings;
    /** The automatic-account ticks; see `updateAgentAccountAutoSwitchSettings`. */
    agentAccountAutoSwitch?: import("@orkestrator/protocol/agent-account-auto-switch").AgentAccountAutoSwitchSettings;
    /**
     * Backend-owned rollout gate for tool-mode workflow results. Internal
     * operations setting rather than a user-facing transport choice; changes
     * affect attempts admitted after the change only.
     */
    workflowResultTools?: import("@orkestrator/protocol/workflow-results").WorkflowResultToolsSettings;
    /**
     * Backend-owned rollout gate and kill switch for MCP configuration
     * management. Absent means everything enabled. Turning it off never edits
     * a saved provider file.
     */
    mcpManagement?: import("@orkestrator/protocol/mcp-management").McpManagementRolloutSettings;
    /**
     * Backend rollout switch for web annotations (`enabled` / `read-only` /
     * `disabled`). `ORKESTRATOR_WEB_ANNOTATIONS_MODE` overrides it.
     */
    webAnnotations?: import("@orkestrator/protocol/web-annotations").WebAnnotationRolloutSettings;
    /**
     * Where new environment and development-profile worktrees are created.
     * Written only by `update_worktree_locations`, so a settings-form save
     * never clears it.
     */
    worktreeLocations?: import("@orkestrator/protocol/disk-usage").WorktreeLocationSettings;
  };
  repositories: Record<string, RepositoryConfig>;
}
