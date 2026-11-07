import type { MultiReviewWorkflowRecord } from "@orkestrator/protocol/contract/domains/multi-review";
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
import type { EnvironmentContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";
import type {
  AgentInteractionResolutionJournal,
  AgentInteractionWorkflowSummary,
} from "@orkestrator/protocol/agent-interactions";
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

// The model catalogues: the `agent-servers` domain's schemas' types (plan
// items 7009 and 7010).
import type { ClaudeModelCatalogSnapshot } from "@orkestrator/protocol/contract/domains/agent-servers";
export type {
  AgentModelCatalogCache,
  ClaudeEffortLevel,
  ClaudeModelCatalogEntry,
  ClaudeModelCatalogSnapshot,
  CodexModelCatalogEntry,
  CodexReasoningEffort,
  OpenCodeModelCatalogEntry,
  OpenCodeModelCatalogSnapshot,
  PersistedAgentModelCatalog,
} from "@orkestrator/protocol/contract/domains/agent-servers";

/**
 * How a source's work ended, when it knows: `failed` rings `agent_failed`, and
 * `none` means nothing completed, so going idle rings nothing. Absent, the
 * source's working-to-idle edge says the work finished.
 */
export type AgentActivityCompletionOutcome = "failed" | "none";

/** The port fields the stored record keeps narrower than the client form. */
type StoredPortField =
  | "entryPort"
  | "hostEntryPort"
  | "localOpencodePort"
  | "localClaudePort"
  | "localCodexPort"
  | "localCursorPort"
  | "localGrokPort"
  | "localPiPort";

/**
 * The stored environment record, backend-private: the protocol's
 * `ClientEnvironment` (plan items 7003 and 7010; the field documentation is
 * there) plus what the backend keeps to itself (process ids, the durable
 * container lifecycle record, activity sources, teardown intents, the
 * startup prompt's attachments and presentation). `ClientEnvironment` and
 * `EnvironmentDetail` are what a client receives.
 */
export interface Environment extends Omit<
  ClientEnvironment,
  "containerLifecycle" | "hasInitialPromptAttachments" | StoredPortField
> {
  /**
   * Ports as stored: a number or absent. The client form also admits `null`
   * (a projection of a released port).
   */
  entryPort?: number;
  hostEntryPort?: number;
  localOpencodePort?: number;
  localClaudePort?: number;
  localCodexPort?: number;
  localCursorPort?: number;
  localGrokPort?: number;
  localPiPort?: number;
  /** Idempotency key for an externally requested environment launch. */
  controlRequestId?: string;
  /**
   * SHA-256 of the canonical creation intent that first used
   * `controlRequestId`. Absent on legacy records, which cannot detect a
   * changed payload and converge as before.
   */
  controlRequestFingerprint?: string;
  /**
   * Durable container lifecycle record: runtime/storage identity, the one
   * unresolved operation and recent outcomes. Backend-private; clients receive
   * `ContainerLifecycleSnapshot`. Always read through `parseContainerLifecycle`
   * because a newer backend may have written a version this one cannot read.
   */
  containerLifecycle?: EnvironmentContainerLifecycle;
  /** Backend-owned generation that prevents a later rename from reusing branch history. */
  branchRevision?: number;
  /**
   * Durable backend intent armed by the Resolve action.
   *
   * Agent completion asks the PR monitor for an immediate authoritative check;
   * the intent remains armed while GitHub still reports conflicts so an
   * unrelated concurrent turn cannot consume it.
   */
  prRecheckAfterAgentCompletionArmedAt?: string;
  /** Backend-internal observations used to derive the aggregate state. */
  agentActivitySources?: Partial<Record<AgentActivitySource, AgentActivitySourceSnapshot>>;
  /**
   * Renderer observations keyed by a hash of the renderer's opaque token.
   * Entries are leased so a crashed renderer cannot pin the aggregate forever.
   */
  frontendAgentActivityObservers?: Record<string, FrontendAgentActivityObserverSnapshot>;
  opencodePid?: number;
  claudeBridgePid?: number;
  codexBridgePid?: number;
  cursorBridgePid?: number;
  grokBridgePid?: number;
  piBridgePid?: number;
  /** Last backend-owned Claude model catalog for this environment. */
  claudeModelCatalog?: ClaudeModelCatalogSnapshot;
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
  /** One-shot conversation mode for the agent tab created from pendingAgentLaunch. */
  initialConversationMode?: "plan" | "build";
  /** Backend-authenticated display treatment for the initial provider echo. */
  initialPromptPresentation?: TrustedUserPromptPresentation;
  /** Attachments waiting to be delivered or written before the first prompt. */
  initialPromptAttachments?: InitialPromptImageAttachment[];
  /** Prompt awaiting a backend-owned rename after the environment starts. */
  pendingRenamePrompt?: string;
}

/** Version 2 makes pane and tab selection authoritative in this record. */
export { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

/**
 * Durable envelope for a backend-owned Multi Review workflow: the
 * `multi-review` domain's record (plan items 7007 and 7010) plus the
 * controller lease, which never leaves the backend
 * (`stripWorkflowRendererSecrets`).
 */
export type PersistedMultiReviewWorkflow = Omit<MultiReviewWorkflowRecord, "snapshot"> & {
  snapshot: unknown;
  controllerLease?: {
    ownerId: string;
    token: string;
    expiresAt: string;
  };
};

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

// The native agent session and prompt queue records and their parts: the
// `native-sessions` domain's schemas' types (plan item 7010). Fields the
// backend reads through its own validating reader (`retiredDispatch`,
// `signInResend`, `goal`, `resumeIdentity`, `backendTitle`, ...) are typed
// there but not checked by a decode, so a malformed value reads as absent.
import type {
  IncompleteTurnNotice,
  NativeAgentJobReceipt,
  NativeAgentSessionBackendTitle,
  PersistedNativeAgentSession,
  PersistedPromptQueue,
} from "@orkestrator/protocol/contract/domains/native-sessions";
export type {
  IncompleteTurnNotice,
  NativeAgentJobReceipt,
  NativeAgentProvider,
  NativeAgentSessionBackendTitle,
  PersistedNativeAgentPendingDispatch,
  PersistedNativeAgentPendingSteer,
  PersistedNativeAgentRetiredDispatch,
  PersistedNativeAgentSession,
  PersistedNativeAgentSignInResend,
  PersistedNativeAgentTurnOutcome,
  PersistedPromptQueue,
} from "@orkestrator/protocol/contract/domains/native-sessions";

export const NATIVE_AGENT_SESSION_VERSION = 1 as const;

/** What a backend-owned native job does when its agent finishes (Resolve's PR refresh). */
export type NativeAgentJobCompletionAction = "refresh-pr-after-agent-completion";

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

/** A session's incomplete-turn notice, independent of its persisted field name. */
export function sessionIncompleteTurnNotice(
  session: Pick<PersistedNativeAgentSession, "openCodeIncompleteTurnNotice">,
): IncompleteTurnNotice | undefined {
  return session.openCodeIncompleteTurnNotice;
}

/** Content-free exact-once interaction records owned by backend workflows. */
export type PersistedAgentInteractionResolutionJournal = AgentInteractionResolutionJournal;
export type PersistedAgentInteractionWorkflowSummary = AgentInteractionWorkflowSummary;

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
