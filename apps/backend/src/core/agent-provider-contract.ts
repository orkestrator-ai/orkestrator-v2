import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import type {
  AgentInteractionApplyOutcome,
  AgentInteractionKind,
  AgentInteractionOrigin,
  AgentInteractionPolicy,
  AgentInteractionProvider,
  AgentInteractionResolution,
  AgentInteractionSnapshot,
} from "@orkestrator/protocol/agent-interactions";
import type {
  AgentModel,
  NativeAgentBackgroundTaskSummary,
  NativeAgentComposerState,
  NativeAgentContextUsage,
  NativeAgentExecutionPolicy,
  NativeAgentControlUpdate,
  NativeAgentForkOutcome,
  NativeAgentNotice,
  NativeAgentQueueSnapshot,
  NativeAgentAuthStatus,
  NativeAgentMcpServer,
  NativeAgentMcpServerAction,
  NativeAgentReadiness,
  NativeAgentRateLimitWindow,
  NativeAgentResumeEntry,
  NativeAgentRuntimeNotice,
  NativeAgentRuntimeSummary,
  NativeAgentSessionAction,
  NativeAgentSessionActionOutcome,
  NativeAgentSlashCommand,
  NativeAgentTurnActivity,
  NativeAgentTurnPhase,
} from "@orkestrator/protocol/native-agent";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { NativeAgentBridgeCommandInvocation } from "@orkestrator/protocol/agent-command-catalogue";
import type { NativeAgentCommandRefreshOutcome } from "@orkestrator/protocol/native-agent";
import type { PromptAttachment } from "./prompt-attachments.js";

export type ProviderStatus = "running" | "blocked" | "idle" | "error" | "missing";
export type ProviderActivityState = AgentActivityState | "missing";

export interface ProviderActivityObservation {
  state: ProviderActivityState;
  /** Content-free provider item ids that require attention in this session. */
  asyncQuestionItemIds?: string[];
  /** The composer can accept input even if background work keeps `state` working. */
  readyForInput?: boolean;
}
export type ProviderExecutionMode = "plan" | "build";
export type ProviderAgent = AgentInteractionProvider;

export interface ProviderSessionObservation {
  status: ProviderStatus;
  /** Request-scoped completion proof; never evidence of prompt dispatch. */
  turnSettled?: boolean;
  /** Cumulative session consumption only; context-window occupancy is not interchangeable. */
  contextUsage?: NativeAgentContextUsage;
  /** A terminal provider is still reconciling its exact cumulative total. */
  usagePending?: boolean;
  /**
   * This idle turn still has live background work or a retained continuation
   * for the current request. The composer can take input, but a workflow
   * awaiting this turn's result must keep supervising it.
   */
  backgroundWorkLive?: boolean;
  /** Released Claude dispatches whose query is still awaiting its root continuation. */
  retainedContinuationRequestIds?: string[];
}

export interface ProviderPromptImage {
  filename: string;
  data: string;
}

export interface ProviderSessionRegistration {
  origin: AgentInteractionOrigin;
  interactionPolicy: AgentInteractionPolicy;
  /** Backend-owned leaf-review identity, reconstructed from durable workflow state. */
  reviewerSession?: boolean;
  phase?: string;
  workflowId?: string;
  provider?: ProviderAgent;
  fence?: string | number;
}

export interface ProviderInteractionObservationEvent {
  sessionId: string;
  interactionId: string;
  kind: AgentInteractionKind;
  registration: ProviderSessionRegistration;
  state: "detected" | "withdrawn";
  providerState?: "running" | "error";
}

export interface AgentInteractionProviderCapability {
  listPendingInteractions(sessionId: string): Promise<AgentInteractionSnapshot>;
  resolveInteraction(
    sessionId: string,
    interactionId: string,
    resolution: AgentInteractionResolution,
  ): Promise<AgentInteractionApplyOutcome>;
  watchInteractions?(sessionId: string, onRevision: (revision: number) => void): () => void;
}

export class PromptRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptRejectedError";
  }
}

export class ProviderUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderUnavailableError";
  }
}

/**
 * The request provably never reached the provider.
 *
 * This is a strict subset of "unavailable": the transport failed while opening
 * the connection, so no byte of the request was written. That distinction is
 * the difference between a retryable rejection and a dispatch whose outcome is
 * genuinely unknown — see `AmbiguousPromptDispatchError`. Only failures that
 * can be proven to precede the first written byte may use this class; anything
 * that could have been observed by the provider stays ambiguous.
 */
export class ProviderUnreachableError extends ProviderUnavailableError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderUnreachableError";
  }
}

/**
 * Provider setup failed before the prompt request was written.
 *
 * MCP registration and permission preparation happen outside the prompt
 * request. A failure here is unambiguously retryable: callers may reset a
 * durable `dispatching` marker and send the same request id again.
 */
export class ProviderDispatchPreparationError extends ProviderUnavailableError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderDispatchPreparationError";
  }
}

export class ProviderSessionFailedError extends Error {
  readonly agent: ProviderAgent;
  readonly detail: string;

  constructor(agent: ProviderAgent, detail: string) {
    super(`The ${agent} session failed: ${detail}`);
    this.name = "ProviderSessionFailedError";
    this.agent = agent;
    this.detail = detail;
  }
}

export async function readProviderStatus(
  provider: Pick<AgentSessionProvider, "status" | "observeSession" | "settleTurn">,
  sessionId: string,
  requestId?: string,
): Promise<ProviderSessionObservation & { error?: string }> {
  try {
    const observation = provider.observeSession
      ? await provider.observeSession(sessionId)
      : { status: await provider.status(sessionId) };
    if (
      requestId &&
      observation.status === "idle" &&
      observation.retainedContinuationRequestIds?.includes(requestId)
    ) {
      return { ...observation, backgroundWorkLive: true };
    }
    // Only workflow owners supply a durable request id. UI/status observers
    // must never change another caller's turn permissions.
    if (requestId && (observation.status === "idle" || observation.status === "error")) {
      const settled = await provider.settleTurn?.(sessionId, requestId);
      // Keep lifecycle truthful: an unproven completion is NOT positive
      // evidence of a dispatch, especially while a prompt is parked.
      if (settled !== undefined) return { ...observation, turnSettled: settled };
    }
    return observation;
  } catch (error) {
    if (error instanceof ProviderSessionFailedError) {
      return { status: "error", error: error.detail };
    }
    throw error;
  }
}

export class AmbiguousPromptDispatchError extends ProviderUnavailableError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AmbiguousPromptDispatchError";
  }
}

/**
 * What a provider can still prove about one dispatch request id.
 *
 * `dispatched` is an assertion, not a guess: the provider holds a durable
 * record that this exact id was accepted. Everything else — no record, a record
 * that predates a provider restart, an unreadable journal — is `unknown`, so a
 * lost record can never be mistaken for a prompt that was never sent.
 */
export type ProviderDispatchStatus = "dispatched" | "unknown";
/** Steering additionally reports positive evidence that a queued instruction was removed. */
export type ProviderSteerDispatchStatus = ProviderDispatchStatus | "absent";

/** The provider run a backend-owned steer may still target. */
export type ProviderActiveSteerRun =
  | { state: "running"; runId: string }
  | { state: "idle" }
  | { state: "unknown" }
  | { state: "unsupported" };

/**
 * Private action shape used only after the backend has persisted admission.
 * The public renderer action deliberately carries neither identity nor a run.
 */
export type ProviderNativeAgentSessionAction =
  | Exclude<NativeAgentSessionAction, { kind: "steer" }>
  | {
      kind: "steer";
      text: string;
      requestId: string;
      expectedRunId: string;
    };

export interface ProviderCreateSessionOptions {
  /** Explicit tool restriction for providers without a native read-only mode. */
  readOnly?: boolean;
  /**
   * Backend-owned identity for one leaf review session.
   *
   * OpenCode persists this marker with the session so a recreated provider can
   * distinguish a reviewer from a coordinator before temporarily granting the
   * reviewer's constrained shell rules.
   */
  reviewerSession?: boolean;
  clientSessionKey?: string;
  mode?: ProviderExecutionMode;
  model?: string;
  effort?: string;
  fastMode?: boolean;
  /** Tab-scoped Orkestrator MCP credential for bridges with per-session config. */
  agentMcp?: { url: string; token: string; design?: boolean };
  interaction?: ProviderSessionRegistration;
  /** Immutable backend-owned execution policy for this provider session. */
  policy?: NativeAgentExecutionPolicy;
}

export interface ProviderSendOptions {
  /** Per-turn mutation boundary; independent of plan/build response semantics. */
  readOnly?: boolean;
  /**
   * OpenCode reviewer exception: allow a constrained set of read-only shell
   * commands under this backend policy while readOnly disables mutation tools.
   * Resupplied on dispatch, but applied only to a durably marked reviewer.
   */
  reviewShellPolicy?: NativeAgentExecutionPolicy;
  /** Exact workflow-result MCP tool to expose for this turn, when present. */
  workflowResultTool?: string;
  requestId: string;
  attachments?: PromptAttachment[];
  images?: ProviderPromptImage[];
  schema?: JsonSchema;
  mode?: ProviderExecutionMode;
  fastMode?: boolean;
  subAgent?: string;
  executionAgent?: string;
  includeLocalSettings?: boolean;
  promptSuggestions?: boolean;
  model?: string;
  effort?: string;
  parameterValues?: Record<string, string | boolean>;
  persistDefaults?: boolean;
  /**
   * False is literal intent: the provider must not interpret the prompt as a
   * command. Providers without a native suppression mechanism are guarded by
   * the backend before dispatch (see `literalCommandSuppression`).
   */
  allowProviderCommands?: boolean;
  /**
   * The command the backend resolved against this provider's own enhanced
   * catalogue. Only ever set for a descriptor that came from that catalogue;
   * the provider revalidates it against its private registry and refuses
   * (never downgrades to plain text) when it no longer matches.
   */
  command?: NativeAgentBridgeCommandInvocation;
  /** Scoped Orkestrator MCP connection for providers with a qualified delivery path. */
  agentMcp?: {
    design?: boolean;
    url: string;
    token: string;
    /** Signed one-attempt argument for providers using a persistent MCP broker. */
    workflowResultCapability?: string;
  };
}

export type ProviderPrepareDispatchOptions = {
  /**
   * The tab-scoped Orkestrator MCP credential this turn will use.
   *
   * Supplied so a warm-up attach can connect the right identity instead of
   * the process-env one, which would force the prompt to rebuild the
   * session. Best-effort, like the attach itself.
   */
  agentMcp?: ProviderSendOptions["agentMcp"];
  /** Exact workflow-result MCP tool this turn will expose, when present. */
  workflowResultTool?: string;
};

export interface ProviderInteractiveSnapshot {
  status: ProviderStatus;
  messages: unknown[];
  /** Stable provider identity accepted by list/resume, when distinct from the live handle. */
  resumableSessionId?: string;
  /** False when the provider supplied only a bounded transcript tail. */
  messagesComplete?: boolean;
  title?: string;
  shareUrl?: string | null;
  composer?: NativeAgentComposerState;
  /**
   * Provider-owned session model, distinct from the catalog default that
   * `composer.selectedModelId` may still advertise.
   */
  sessionModelId?: string;
  sessionReasoningId?: string;
  readiness?: NativeAgentReadiness;
  controls?: NativeAgentControlUpdate;
  providerRevision?: number;
  providerGeneration?: string | number;
  /**
   * The bridge's own command-inventory revision, when it tracks one. A change
   * tells the backend its cached catalogue is out of date — push freshness
   * carried by a read the projection already makes, never a new poll.
   */
  commandCatalogueRevision?: number;
  phase?: NativeAgentTurnPhase;
  turnStartedAt?: number;
  /** What the provider reports doing inside the running turn, when it does. */
  turnActivity?: NativeAgentTurnActivity;
  contextUsage?: NativeAgentContextUsage;
  policy?: NativeAgentExecutionPolicy;
  rateLimits?: NativeAgentRateLimitWindow[];
  runtime?: NativeAgentRuntimeSummary;
  /** False when optional runtime health could not be read for this snapshot. */
  runtimeHealthAuthoritative?: boolean;
  providerQueue?: NativeAgentQueueSnapshot;
  /**
   * The interaction kinds this *session* can raise, when the provider reports.
   *
   * Overrides the platform table: a Pi session with its approval gate off
   * raises nothing, and the table says only what the platform may raise.
   * Absent leaves the table standing; present-and-empty is a real "never asks".
   */
  interactionKinds?: string[];
  notices?: NativeAgentNotice[];
  backgroundTasks?: NativeAgentBackgroundTaskSummary[];
  suggestedPrompt?: string;
  completionBlockedByBackgroundTasks?: boolean;
  error?: string;
}

/** Transcript-only provider read. Optional metadata must never be fetched here. */
export interface ProviderTranscriptSnapshot {
  messages: unknown[];
  /** Absolute position of the first message within the current history epoch. */
  historyStartIndex?: number;
  /** Parts omitted from the first retained message by the provider's byte bound. */
  omittedParts?: number;
  /** False when the provider supplied only a bounded retained tail. */
  complete?: boolean;
  title?: string;
  revision?: number;
  generation?: string | number;
  /** Stable across ordinary edits; changes when history continuity resets. */
  historyEpoch?: string;
  /** A bridge/backend cache may be displayed while exact recovery continues. */
  freshness?: "cached" | "current";
  /** Provider/bridge conditional token; scoped to this source session/window. */
  sourceToken?: string;
}

/**
 * Action-critical provider state without transcript or catalogue discovery.
 * This intentionally reuses the established normalized fields while making a
 * message array impossible to attach by accident.
 */
export type ProviderSessionStateSnapshot = Omit<ProviderInteractiveSnapshot, "messages">;

/** Provider operations shared by workflows and interactive native-agent tabs. */
export interface AgentSessionProvider {
  readonly agent: ProviderAgent;
  /**
   * Register a session restored from durable workflow state. Providers that
   * monitor environment-wide event streams must ignore requests for every
   * session not registered here or created through createSession().
   */
  registerSession?(sessionId: string, interaction?: ProviderSessionRegistration): void;
  createSession(
    phase: string,
    label: string,
    options?: ProviderCreateSessionOptions,
  ): Promise<string>;
  send(sessionId: string, prompt: string, options: ProviderSendOptions): Promise<void>;
  /**
   * Do the provider's cold-start work *before* the at-most-once dispatch window
   * opens.
   *
   * Attaching an agent process can take longer than a prompt request is allowed
   * to, and every second of it is spent inside the window where a lost
   * acknowledgement becomes an ambiguous dispatch the user has to resolve by
   * hand. Failing here is unambiguous by construction — nothing was journaled
   * and no prompt was written — so callers may treat it as a plain rejection.
   *
   * Optional, and best-effort: a provider that has no cold start omits it, and
   * a failure must never block the dispatch that follows, because the prompt
   * request performs the same work itself.
   */
  prepareDispatch?(sessionId: string, options?: ProviderPrepareDispatchOptions): Promise<void>;
  /**
   * Ask whether the provider already holds this request id.
   *
   * Read-only. It exists so an ambiguous dispatch can be settled from the
   * provider's own durable journal instead of being parked for the user.
   */
  dispatchStatus?(sessionId: string, requestId: string): Promise<ProviderDispatchStatus>;
  /**
   * Settle a completed request's temporary permissions. Returns false while
   * completion is unproven; stale requests are successful no-ops. Status-only
   * observers must not call this; the backend workflow supplies its request id.
   */
  settleTurn?(sessionId: string, requestId: string): Promise<boolean>;
  status(sessionId: string): Promise<ProviderStatus>;
  /**
   * Read lifecycle and cumulative usage from one authoritative provider
   * snapshot. Providers should implement this only when both values come from
   * the same upstream read; callers otherwise fall back to status().
   */
  observeSession?(sessionId: string): Promise<ProviderSessionObservation>;
  /**
   * Ask the provider for its most detailed usage/account snapshot.
   * Optional because several providers expose usage only on ordinary status reads.
   */
  refreshUsage?(sessionId: string): Promise<NativeAgentContextUsage | undefined>;
  /**
   * Authoritative activity including input parked at the provider. Optional so
   * narrow test providers and non-interactive integrations can fall back to
   * the coarser status contract.
   */
  activity?(sessionId: string): Promise<ProviderActivityState>;
  /**
   * Activity plus content-free attention metadata from the same no-touch read.
   * The background reconciler prefers this when available.
   */
  observeActivity?(sessionId: string): Promise<ProviderActivityObservation>;
  /**
   * Read authoritative activity for several sessions from one provider
   * snapshot. Providers whose upstream API is session-scoped may omit this and
   * let callers fall back to activity()/status() per session.
   */
  activityBatch?(sessionIds: readonly string[]): Promise<Map<string, ProviderActivityState>>;
  /**
   * Derive cumulative session usage from an already-read transcript. The
   * function must never reinterpret current context occupancy as consumption.
   */
  usageFromMessages?(messages: readonly unknown[]): NativeAgentContextUsage | undefined;
  /** Minimum transcript tail needed by usageFromMessages; undefined means all messages. */
  readonly usageMessageLimit?: number;
  readonly interactions?: AgentInteractionProviderCapability;
  messages(sessionId: string, options?: { limit?: number }): Promise<unknown[]>;
  structured<T>(sessionId: string, requestId: string): Promise<StructuredOutputResult<T> | null>;
  /** Request a graceful interrupt of the active turn. */
  abort(sessionId: string): Promise<void>;
  /** Escalate a turn which did not settle after the bounded grace period. */
  hardAbort?(sessionId: string): Promise<void>;
  /**
   * Ordinary, non-destructive close: stop this session's owned work, deny what
   * is parked, and release the runtime resources and mapping held for it. The
   * vendor conversation is always retained and stays resumable. Resolves only
   * on affirmative evidence the close happened (or that nothing was held);
   * rejects when it cannot be confirmed, so a durable caller can retry. It must
   * never fall back to an operation that deletes history. There is deliberately
   * no provider-neutral "delete history" operation: permanent deletion is a
   * separately named, provider-specific action.
   */
  closeSession?(sessionId: string): Promise<void>;
  /**
   * Forget in-memory registration for a session another path has already
   * closed (tab teardown). Synchronous, local only, and a no-op for unknown ids.
   */
  releaseSession?(sessionId: string): void;
  dispose?(): Promise<void> | void;
}

/**
 * Interactive, provider-neutral session surface consumed by NativeAgentService.
 * Build-pipeline callers retain the deliberately smaller interface above.
 */
export interface NativeAgentRuntimeProvider extends AgentSessionProvider {
  /** Highest-priority bounded display read; never performs optional discovery. */
  transcriptSnapshot?(
    sessionId: string,
    options: { limit: number; targetBytes: number; knownSourceToken?: string },
  ): Promise<ProviderTranscriptSnapshot | { unchanged: true; sourceToken: string }>;
  /** Action-critical state read; never fetches transcript or optional discovery. */
  sessionStateSnapshot?(sessionId: string): Promise<ProviderSessionStateSnapshot>;
  /** Live, bounded model discovery for launch surfaces without a session yet. */
  modelCatalog?(): Promise<AgentModel[]>;
  /**
   * Backend-only bounded discovery for the durable OpenCode cache. Unlike
   * `modelCatalog`, this retains an unfiltered bounded source catalogue so a
   * later allowlist expansion can work before another bridge is started. It
   * must never be returned directly to a renderer.
   *
   * "Unfiltered" covers provider connectivity as well as the allowlist: a
   * provider the user authenticates *after* this cache was written must still
   * be offered by launch dialogs before another bridge starts.
   */
  rawModelCatalog?(): Promise<AgentModel[]>;
  interactiveSnapshot?(sessionId: string): Promise<ProviderInteractiveSnapshot>;
  updateInteractiveControls?(
    sessionId: string,
    update: NativeAgentControlUpdate,
  ): Promise<NativeAgentComposerState | undefined>;
  listResumableSessions?(): Promise<NativeAgentResumeEntry[]>;
  resumeSession?(
    sessionId: string,
    controls?: NativeAgentControlUpdate,
    policy?: NativeAgentExecutionPolicy,
  ): Promise<string>;
  forkSession?(sessionId: string, messageId?: string): Promise<NativeAgentForkOutcome>;
  slashCommands?(sessionId?: string): Promise<NativeAgentSlashCommand[]>;
  /**
   * Catalogue read with freshness and execution identity. Preferred over
   * {@link slashCommands}. Must never touch liveness, hydrate a transcript or
   * re-attach an idle session.
   */
  commandCatalogue?(sessionId?: string): Promise<ProviderCommandCatalogue>;
  /** Explicit command refresh; reports what it actually did. */
  refreshCommands?(sessionId?: string): Promise<ProviderCommandRefreshResult>;
  mcpServers?(sessionId: string): Promise<NativeAgentMcpServer[]>;
  mcpServerAction?(
    sessionId: string,
    serverId: string,
    action: NativeAgentMcpServerAction,
  ): Promise<{ url?: string }>;
  /**
   * Bridge-level MCP configuration reload that never starts an agent process:
   * `not-running` when nothing is running to reload, `unsupported` when the
   * bridge predates the route. Session-free, so it survives a bridge restart.
   */
  reloadMcpConfiguration?(): Promise<"reloaded" | "not-running" | "unsupported">;
  authStatus?(): Promise<NativeAgentAuthStatus>;
  beginSignIn?(): Promise<{ url?: string; code?: string }>;
  signOut?(): Promise<void>;
  setSessionTitle?(sessionId: string, title: string): Promise<void>;
  /** Drop provider-side model/command caches so the next read re-discovers. */
  refreshCatalog?(): Promise<void> | void;
  stopBackgroundTask?(sessionId: string, taskId: string): Promise<void>;
  dismissSuggestedPrompt?(sessionId: string): Promise<void>;
  /** User-initiated authoritative snapshot used before opening a steer barrier. */
  activeSteerRun?(sessionId: string): Promise<ProviderActiveSteerRun>;
  /** No-touch runtime qualification for this exact bridge/session surface. */
  steerSupported?(sessionId: string): Promise<boolean>;
  /** No-touch reconciliation; never attaches, hydrates, or changes liveness. */
  steerStatus?(sessionId: string, requestId: string): Promise<ProviderSteerDispatchStatus>;
  performSessionAction?(
    sessionId: string,
    action: ProviderNativeAgentSessionAction,
  ): Promise<NativeAgentSessionActionOutcome>;
  /**
   * Bounded inventory, drift and provider diagnostics for one session.
   *
   * Every bridge answers this, including for a session it does not have: an
   * unknown session is `{ summary: {}, notices: [] }` in band, never a 404,
   * because the backend reads a 404 on a shared route as "this bridge predates
   * the route" and fails the environment. A provider with nothing to say
   * returns an empty summary rather than omitting the method.
   */
  runtimeHealth?(sessionId: string): Promise<ProviderRuntimeHealth>;
  /**
   * Which saved MCP configuration the session's live runtime was built from,
   * read from the same no-touch `/session/:id/runtime-health` route. Backend
   * only: the digests are unkeyed hashes of files that can hold secrets, so
   * this never feeds a projection. `undefined` when the bridge reports none —
   * an older bridge, or nothing loaded yet.
   */
  mcpConfigEvidence?(sessionId: string): Promise<ProviderMcpConfigEvidence | undefined>;
}

/** See {@link NativeAgentRuntimeProvider.mcpConfigEvidence}. */
export interface ProviderMcpConfigEvidence {
  /**
   * `sha256:<base64url>`, `absent` or `excluded` per reported file. `local`
   * repeats Claude's `user` digest only when that query also loaded the
   * private-local map inside the same file (its source scope was `all`).
   */
  sources: { user?: string; project?: string; local?: string };
  /** When the runtime read that configuration. */
  observedAt: string;
  /** `process` when the bridge reports one load for every session (Grok). */
  scope: "session" | "process";
}

export type ProviderMcpConfigEvidenceRead =
  | { state: "evidence"; evidence: ProviderMcpConfigEvidence }
  | { state: "none" }
  | { state: "not-running" };

export interface ProviderCommandCatalogue {
  /** Descriptors carry execution identity negotiated with this provider. */
  enhanced: boolean;
  commands: NativeAgentSlashCommand[];
  /**
   * `ready` is authoritative (including empty). `stale` is a retained list the
   * provider could not refresh. `unsupported` means the integration exposes no
   * provider commands. `missing` means the provider does not hold the session.
   */
  status: "ready" | "stale" | "unsupported" | "missing";
  truncated?: boolean;
  revision?: number;
  generation?: string;
  freshness?: "push" | "ttl";
}

export interface ProviderCommandRefreshResult {
  outcome: NativeAgentCommandRefreshOutcome;
  message?: string;
}

export interface ProviderRuntimeHealth {
  summary: NativeAgentRuntimeSummary;
  notices: NativeAgentRuntimeNotice[];
  /** Whether the empty/non-empty result came from a successful provider read. */
  authoritative?: boolean;
}

export interface BridgeConnection {
  agent: ProviderAgent;
  baseUrl: string;
  authToken: string;
  directory?: string;
  model?: string;
  effort?: string;
  fastMode?: boolean;
  requestTimeoutMs?: number;
}

export interface ProviderCommonDependencies {
  stageImages?: (images: readonly ProviderPromptImage[]) => Promise<PromptAttachment[]>;
  autoAnswerRequests?: boolean;
  onInteractionObservation?: (event: ProviderInteractionObservationEvent) => void | Promise<void>;
}
