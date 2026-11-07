import type { BuildPipelineRecord } from "@orkestrator/protocol/contract/domains/pipelines";
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
import type { EnvironmentContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";
import type {
  AgentInteractionOrigin,
  AgentInteractionPolicy,
  AgentInteractionResolutionJournal,
  AgentInteractionWorkflowSummary,
} from "@orkestrator/protocol/agent-interactions";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import type { TrustedUserPromptPresentation } from "@orkestrator/protocol/review-evidence-frames";
// The environment vocabularies are the protocol schemas' types (plan item 7003).
// The environment model: the protocol schemas' types (plan items 7003 and
// 7010). `Environment` below is the stored record, backend-private; what a
// client receives is `ClientEnvironment`.
import type {
  ClientEnvironment,
  EnvironmentStatus,
  PrState,
  NetworkAccessMode,
  EnvironmentType,
  EnvironmentLifecycleOperation,
  EnvironmentSetupPhase,
  InitialPromptImageAttachment,
  PortMapping,
  PortProtocol,
  EnvironmentUnreadReason,
  StartupAgentSessionSnapshot,
  WorktreeMoveRecord,
  WorktreeMoveSubmodule,
} from "@orkestrator/protocol/contract/domains/environments";
export type {
  ClientEnvironment,
  EnvironmentStatus,
  PrState,
  NetworkAccessMode,
  EnvironmentType,
  EnvironmentLifecycleOperation,
  EnvironmentSetupPhase,
  InitialPromptImageAttachment,
  PortMapping,
  PortProtocol,
  EnvironmentUnreadReason,
  StartupAgentSessionSnapshot,
  WorktreeMoveRecord,
  WorktreeMoveSubmodule,
};
// The settings model: the `config` domain's schemas' types (plan items 7005
// and 7010). The stored settings, credentials included, are `AppConfig` here;
// the renderer's view (credentials redacted) is the protocol's `AppConfig`.
export type {
  AgentLaunchMode as AgentStyle,
  AgentLaunchMode as ClaudeMode,
  AgentLaunchMode as CodexMode,
  AgentLaunchMode as OpenCodeMode,
  ClaudeNativeBackend,
  RepositoryConfig,
  StoredAppConfig as AppConfig,
} from "@orkestrator/protocol/contract/domains/config";
export type { AgentPlatform as DefaultAgent } from "@orkestrator/protocol/agent-platforms";
// The terminal session record, the pane layout and the drafts: the
// `native-sessions` domain's schemas' types (plan item 7010).
export type {
  PersistedAgentHandoff,
  PersistedComposeDraft,
  PersistedFileDraft,
  PersistedPaneLayout,
  Session,
  SessionStatus,
  SessionType,
} from "@orkestrator/protocol/contract/domains/native-sessions";

export type {
  AgentActivitySource,
  AgentActivitySourceSnapshot,
  AgentActivityState,
  FrontendAgentActivityObserverSnapshot,
};

/** One registered project: the protocol schema's type (plan item 7005). */
export type { Project } from "@orkestrator/protocol/contract/domains/projects";

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

/**
 * How a source's work ended, when it knows: `failed` rings `agent_failed`, and
 * `none` means nothing completed, so going idle rings nothing. Absent, the
 * source's working-to-idle edge says the work finished.
 */
export type AgentActivityCompletionOutcome = "failed" | "none";

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
   * Why the last delete of this tombstoned environment failed. The tombstone
   * stays, so a restart still retries; this is what stops it reading as running.
   * Cleared when a delete starts.
   */
  deletionError?: string;
  /**
   * The step the running (or last failed) delete reached. Rows show it while a
   * delete is running, so a slow one says what it is waiting for.
   */
  deletionStep?: import("@orkestrator/protocol/node-summaries").EnvironmentDeletionStep;
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
  /**
   * Delete this environment once auto-merge has merged its pull request (the
   * Integrate dialog's "Auto-merge & Cleanup"). Only meaningful while
   * `autoMerge` is on, and cleared with it.
   */
  autoMergeCleanup?: boolean;
  /** PR-specific authorization and freshness fence. */
  autoMergePrUrl?: string | null;
  autoMergeEnabledAt?: string | null;
  /** Last automatic attempt failure, cleared after recovery. */
  autoMergeError?: string | null;
  /** Recoverable Resolve identity, retained across pre-dispatch failures. */
  autoMergeResolveRequestId?: string;
  autoMergeResolveCompletedAt?: string;
  autoMergeResolveAttempts?: number;
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
  /**
   * Setup was held, not run: a local environment's `setupLocal` commands
   * differ from the default branch's and from every hash approved for the
   * project on this machine (`setup-approval.ts`). Recorded with
   * `setupPhase: "failed"`, so every reader that waits on setup stops; the
   * user approves the commands or skips setup.
   */
  setupApprovalRequired?: boolean;
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

/** Version 2 makes pane and tab selection authoritative in this record. */
export { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

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
 * the record must be storable before it can be linked. The shape is the
 * `pipelines` contract domain's `BuildPipelineRecord` (plan item 7007).
 */
export type PersistedBuildPipeline = BuildPipelineRecord;

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
  /**
   * `usage-limit` for a failed turn that stopped on the account's plan
   * allowance: from the bridge's structured `errorCode` when it sent one,
   * otherwise from the error text. Absent on every other outcome and on
   * outcomes recorded before it, which readers classify by `error`
   * (`usageLimitFailure`). An older backend ignores the field.
   */
  failureKind?: import("@orkestrator/protocol/agent-usage-limits").TurnFailureKind;
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
