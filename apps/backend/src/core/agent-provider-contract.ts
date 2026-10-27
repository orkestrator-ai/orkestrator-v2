import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import type {
  AgentInteractionApplyOutcome,
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
  NativeAgentDefaultModelResolution,
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
  /** A released root turn still owes a response, independently of composer readiness. */
  completionPending?: boolean;
  /**
   * Opaque revision of what the session view shows beyond its activity
   * (`SessionActivityObservation.contentRevision`). A bridge that reports it
   * lets the backend announce a change to an idle session's view.
   */
  contentRevision?: string;
}

/**
 * One session's answer from {@link NativeAgentRuntimeProvider.observeActivityBatch}.
 * `unavailable`: the bridge could not read it — uncertainty, never evidence of
 * idleness or deletion. `deferred`: it did not fit the batch response budget
 * and must be read through the single-session route.
 */
export type ProviderActivityBatchEntry = ProviderActivityObservation | "unavailable" | "deferred";
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
  /**
   * Set beside `status: "error"` when the provider itself stopped the turn
   * partway, not the model: `restart` means a provider restart cut it short
   * and the same session can continue it. The Codex and Claude bridges report
   * one; an unknown value is dropped, so that turn fails as before.
   */
  interruption?: ProviderTurnInterruption;
  /**
   * The request id of the turn `interruption` cut short, when the provider
   * knows it. Session status is per session, not per request: until the next
   * turn starts, the notice still describes the earlier one. A bridge that
   * predates this field leaves it unset, and the notice is then taken to be
   * about whichever request the caller is watching, as before.
   */
  interruptedRequestId?: string;
}

/** A provider-caused stop of a turn the same session can continue. */
export type ProviderTurnInterruption = "restart";

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

export interface AgentInteractionProviderCapability {
  listPendingInteractions(sessionId: string): Promise<AgentInteractionSnapshot>;
  resolveInteraction(
    sessionId: string,
    interactionId: string,
    resolution: AgentInteractionResolution,
  ): Promise<AgentInteractionApplyOutcome>;
  watchInteractions?(sessionId: string, onRevision: (revision: number) => void): () => void;
  /**
   * Pause (`held`) or resume a request's deadline where it is enforced.
   * Absent where no provider deadline exists to pause (OpenCode).
   */
  holdInteraction?(
    sessionId: string,
    interactionId: string,
    held: boolean,
  ): Promise<AgentInteractionApplyOutcome>;
}

export class PromptRejectedError extends Error {
  /**
   * The bridge restored a claim for this request id without its outcome and cannot say
   * whether its turn ran. It refuses the id for good, so retrying it can never
   * succeed; a resend needs a new id.
   */
  readonly requestIdRetired: boolean;

  constructor(message: string, options?: { requestIdRetired?: boolean }) {
    super(message);
    this.name = "PromptRejectedError";
    this.requestIdRetired = options?.requestIdRetired === true;
  }
}

export class ProviderUnavailableError extends Error {
  /** Delay the next dispatch while a request's terminal evidence is still settling. */
  readonly retryAfterMs?: number;

  constructor(message: string, options?: { cause?: unknown; retryAfterMs?: number }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderUnavailableError";
    this.retryAfterMs = options?.retryAfterMs;
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
  readonly interruption?: ProviderTurnInterruption;
  /** See {@link ProviderSessionObservation.interruptedRequestId}. */
  readonly interruptedRequestId?: string;

  constructor(
    agent: ProviderAgent,
    detail: string,
    options: { interruption?: ProviderTurnInterruption; interruptedRequestId?: string } = {},
  ) {
    super(`The ${agent} session failed: ${detail}`);
    this.name = "ProviderSessionFailedError";
    this.agent = agent;
    this.detail = detail;
    if (options.interruption) this.interruption = options.interruption;
    if (options.interruption && options.interruptedRequestId) {
      this.interruptedRequestId = options.interruptedRequestId;
    }
  }
}

/**
 * Whether a restart notice is about an earlier request than `requestId`.
 *
 * Bridges clear the notice when the next turn starts, so a notice naming
 * another request, while the provider confirms `requestId` is still pending,
 * means its own turn was accepted and has not started yet. Both halves are
 * needed: a name can be stale (Claude rewrites its turn-in-flight mark after
 * the turn starts, so a bridge killed in between restores the previous
 * request's name), and a provider that restarted no longer holds the request
 * it lost. Anything short of both reads the notice at face value.
 */
async function interruptionSuperseded(
  provider: Pick<AgentSessionProvider, "dispatchStatus">,
  sessionId: string,
  observation: Pick<ProviderSessionObservation, "status" | "interruption" | "interruptedRequestId">,
  requestId: string | undefined,
): Promise<boolean> {
  if (
    requestId === undefined ||
    observation.status !== "error" ||
    observation.interruption === undefined ||
    observation.interruptedRequestId === undefined ||
    observation.interruptedRequestId === requestId ||
    !provider.dispatchStatus
  ) {
    return false;
  }
  const accepted = await provider
    .dispatchStatus(sessionId, requestId)
    .catch(() => "unknown" as const);
  return accepted === "pending";
}

/**
 * The superseded notice read as what it says about `requestId`: its turn has
 * not settled. Idle rather than error, so no caller fails or continues the
 * request on another turn's outcome; `turnSettled: false` makes every workflow
 * owner wait for the turn instead of reading its result.
 */
function supersededInterruption(
  observation: ProviderSessionObservation,
): ProviderSessionObservation {
  const superseded: ProviderSessionObservation = {
    ...observation,
    status: "idle",
    turnSettled: false,
  };
  delete superseded.interruption;
  delete superseded.interruptedRequestId;
  return superseded;
}

export async function readProviderStatus(
  provider: Pick<
    AgentSessionProvider,
    "status" | "observeSession" | "settleTurn" | "dispatchStatus"
  >,
  sessionId: string,
  requestId?: string,
): Promise<ProviderSessionObservation & { error?: string }> {
  try {
    const observation = provider.observeSession
      ? await provider.observeSession(sessionId)
      : { status: await provider.status(sessionId) };
    if (await interruptionSuperseded(provider, sessionId, observation, requestId)) {
      return supersededInterruption(observation);
    }
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
      const failed: ProviderSessionObservation = {
        status: "error",
        ...(error.interruption ? { interruption: error.interruption } : {}),
        ...(error.interruptedRequestId ? { interruptedRequestId: error.interruptedRequestId } : {}),
      };
      if (await interruptionSuperseded(provider, sessionId, failed, requestId)) {
        return supersededInterruption(failed);
      }
      const settled = requestId ? await provider.settleTurn?.(sessionId, requestId) : undefined;
      return {
        ...failed,
        ...(settled !== undefined ? { turnSettled: settled } : {}),
        error: error.detail,
      };
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
 * record that this exact id was accepted, including a completed request.
 * `pending` additionally proves the accepted request has not finished yet;
 * only that stronger evidence can supersede another request's restart notice.
 * `lost` is the other assertion: an
 * earlier provider process recorded the id, this one cannot tell whether its
 * turn ran, and it will refuse the id for good (the read-only twin of a prompt
 * refused with `requestIdRetired`). Neither is "never sent". `absent` is the
 * only negative and an assertion too: the provider can prove the id never
 * reached it and that a send under it now would be its first delivery, so a
 * recovered `dispatching` request may be re-sent under the same id (0223). A
 * provider answers it only while its journal is complete for the session.
 * Everything else — no record, an unreadable or incomplete journal, a provider
 * that predates `lost` or `absent` — is `unknown`, so a lost record can never
 * be mistaken for a prompt that was never sent.
 */
export type ProviderDispatchStatus = "dispatched" | "pending" | "unknown" | "lost" | "absent";
/**
 * Steering reports positive evidence that a queued instruction was removed,
 * and never `lost`: a steer journal has no retired state.
 */
export type ProviderSteerDispatchStatus = "dispatched" | "unknown" | "absent";

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
  /**
   * Artifact-only `scopeCapability` for this turn, for providers whose
   * Orkestrator tool connection is environment-wide. Delivered to the agent
   * as trusted dispatch instructions; never logged or shown in transcripts.
   */
  artifactGrant?: string;
  /**
   * The result key of the attempt `workflowResultTool` belongs to. Bridges that
   * gate tools themselves (Grok, Pi) let that attempt's tools through a
   * read-only turn only for calls naming this key.
   */
  workflowResultKey?: string;
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
   * The session's approval mode, in the provider's own vocabulary. Absent
   * means the execution policy alone decides, as it always did.
   */
  approvalMode?: string;
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
    /**
     * A backend workflow turn's artifact-only connection: the bridge adds an
     * `orkestrator-artifacts` MCP server at this connection's origin
     * (`/artifact-mcp`) authenticated by `token`, the turn's artifact grant.
     * Never logged or shown in transcripts.
     */
    artifacts?: { token: string };
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
  /** Compact transcript evidence for body-free progressive state reads. */
  lastAssistantModelId?: string;
  lastAssistantReasoningId?: string;
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
  /**
   * Whole messages the provider's byte bound dropped ahead of this window. Set
   * only for a byte trim: one oversized turn can leave a short tail that is
   * nonetheless missing real, pageable history.
   */
  byteOmittedMessages?: number;
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
  /**
   * `summary` when the provider already replaced large bodies with detail
   * locators before windowing (bridge transcript v2). The window then measures
   * lightweight rows, so a short one is not a sign of a raw artifact having
   * pushed messages out, and details resolve through `transcriptDetail`.
   */
  representation?: "summary";
  /**
   * Provider page cursor for history before the first message, scoped to
   * `historyEpoch`. A provider that pages by message rather than by absolute
   * position (OpenCode) sends one without `historyStartIndex`.
   */
  historyCursor?: string;
  /**
   * Rows from before `messages` that changed recently, newest change first,
   * in the same representation as `messages`. A row is one model response,
   * so a late tool result or subagent report can land on a row newer ones
   * have pushed out of the window; readers replace their copies of these.
   */
  revisedMessages?: unknown[];
  /** Changed recovery signal invalidates retained history, which remains pageable. */
  historyReconciliationToken?: string;
}

/** One provider-served history page, positioned within a history epoch. */
export type ProviderTranscriptPage =
  | {
      status: "page";
      messages: unknown[];
      /** Absent when the provider pages by message rather than by position. */
      historyStartIndex?: number;
      /** Cursor for the page before this one; absent when this page starts history. */
      historyCursor?: string;
      /** True when nothing before this page was ever lost. */
      complete: boolean;
      truncated: boolean;
      historyEpoch: string;
      /** Absent when the page carries bodies inline rather than detail locators. */
      representation?: "summary";
    }
  /** The cursor's epoch or generation is gone; the reader must start over. */
  | { status: "expired" };

/** Exact detail behind a summary locator, or why it cannot be served. */
export type ProviderTranscriptDetail =
  | {
      status: "ok";
      detail: {
        toolOutput?: string;
        toolError?: string;
        toolDiff?: Record<string, unknown>;
        fileDataUrl?: string;
      };
    }
  | { status: "missing" | "expired" | "too-large" };

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
   * provider's own durable journal instead of being parked for the user:
   * `dispatched` and `pending` confirm it, `lost` retires it, `absent` lets the
   * caller re-send it under the same id, `unknown` leaves it parked.
   */
  dispatchStatus?(sessionId: string, requestId: string): Promise<ProviderDispatchStatus>;
  /**
   * Settle a completed request's temporary permissions. Returns false while
   * completion is unproven; stale requests are successful no-ops. Status-only
   * observers must not call this; the backend workflow supplies its request id.
   */
  settleTurn?(sessionId: string, requestId: string): Promise<boolean>;
  /**
   * The terminal error recorded for one request's turn, or null when that
   * turn visibly finished without one. For providers whose lifecycle reads
   * idle after a failed turn because the failure is kept in the transcript
   * instead (OpenCode). Throws while no finished answer is visible, so an
   * early idle read is never taken as success.
   */
  turnTerminalError?(sessionId: string, requestId: string): Promise<string | null>;
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
  /** No-touch bounded shell output; never hydrates or attaches a session. */
  humanPromptOutput?(
    sessionId: string,
  ): Promise<{ messages?: unknown; backgroundTasks?: unknown } | null>;
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
   * {@link observeActivity} for a bounded set of sessions (at most
   * `SESSION_ACTIVITY_BATCH_LIMITS.maxSessions` batchable ids) in one no-touch
   * read, carrying the complete per-session observation. Every requested id is
   * answered. Resolves `"unsupported"` when the bridge predates the batch
   * route; callers then read each session individually. A rejection (timeout,
   * 5xx, malformed answer) is not evidence about any session: callers fall
   * back to individual reads for that sweep only.
   */
  observeActivityBatch?(
    sessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, ProviderActivityBatchEntry> | "unsupported">;
  /**
   * This provider's canonical change-evidence producer (a bridge spool or the
   * backend OpenCode adapter), pulled by change tracking after each activity
   * read. See docs/architecture/change-tracking.md.
   */
  changeEvidenceSource?(environmentId: string): ChangeEvidenceSourceLike | null;
  /**
   * Whether this provider's backend-held event stream is connected right now,
   * so a turn started by anyone else will be reported through
   * `ProviderCommonDependencies.onObservationHint`. Only a provider that
   * answers `true` here may have its stably idle sessions observed less than
   * every sweep; absent or `false` keeps the full cadence.
   */
  observationStreamLive?(): boolean;
  /**
   * Derive cumulative session usage from an already-read transcript. The
   * function must never reinterpret current context occupancy as consumption.
   */
  usageFromMessages?(messages: readonly unknown[]): NativeAgentContextUsage | undefined;
  /** Minimum transcript tail needed by usageFromMessages; undefined means all messages. */
  readonly usageMessageLimit?: number;
  /** Largest `messages` limit the provider accepts; undefined means no ceiling. */
  readonly messageReadLimit?: number;
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
    options: {
      limit: number;
      targetBytes: number;
      knownSourceToken?: string;
      /**
       * Ask for lightweight summaries where the provider supports them. Only
       * the native projection, which resolves detail locators, may ask: other
       * consumers render the bodies inline.
       */
      representation?: "summary";
    },
  ): Promise<ProviderTranscriptSnapshot | { unchanged: true; sourceToken: string }>;
  /**
   * The exact body behind a summary part's locator. Undefined when this
   * provider connection does not serve details (an older bridge).
   */
  transcriptDetail?(
    sessionId: string,
    locator: string,
  ): Promise<ProviderTranscriptDetail | undefined>;
  /**
   * History before a snapshot's `historyCursor`, served directly by the
   * provider. Undefined when this provider connection cannot page.
   */
  transcriptPage?(
    sessionId: string,
    options: { cursor: string; limit: number; targetBytes: number },
  ): Promise<ProviderTranscriptPage | undefined>;
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
  /**
   * Providers the runtime reports as able to serve a prompt right now, or
   * undefined when it does not report connectivity. Backend-only: it is
   * persisted beside the durable catalogue so reads made before a bridge starts
   * know which providers were connected.
   */
  connectedModelProviders?(): Promise<string[] | undefined>;
  /**
   * The model to run for a configured default, set or unset: a set model the
   * runtime positively reports it cannot serve is replaced, and an unset one
   * resolves to the runtime's effective default. Callers resolve at session or
   * stage creation and never write the answer back to the user's
   * configuration.
   */
  resolveDefaultModel?(modelId: string | undefined): Promise<NativeAgentDefaultModelResolution>;
  interactiveSnapshot?(sessionId: string): Promise<ProviderInteractiveSnapshot>;
  updateInteractiveControls?(
    sessionId: string,
    update: NativeAgentControlUpdate,
  ): Promise<NativeAgentComposerState | undefined>;
  listResumableSessions?(): Promise<NativeAgentResumeEntry[]>;
  /**
   * Restate trusted session-held permissions before dispatch and after restart.
   * Process-held authority is refreshed by the launcher instead.
   */
  synchronizeSessionPolicy?(sessionId: string, policy: NativeAgentExecutionPolicy): Promise<void>;
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
   * bridge predates the route, `busy` when the provider itself refused
   * because work is running (OpenCode's directory instance is only disposed
   * while idle). Session-free, so it survives a bridge restart.
   */
  reloadMcpConfiguration?(): Promise<"reloaded" | "not-running" | "unsupported" | "busy">;
  authStatus?(): Promise<NativeAgentAuthStatus>;
  /**
   * `deviceCode` asks for a flow without a loopback callback, for a browser
   * that is not on the agent's machine. A platform without one ignores it.
   */
  beginSignIn?(options?: { deviceCode?: boolean }): Promise<{ url?: string; code?: string }>;
  /**
   * Abandon the sign-in `beginSignIn` started, releasing the provider's side
   * of it. `cancelled` is false when nothing was open or the platform has no
   * cancel; either way the pending sign-in is gone afterwards.
   */
  cancelSignIn?(): Promise<{ cancelled: boolean }>;
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
   * this never feeds a projection. `unsupported` is a bridge too old to
   * report; `none` is a current bridge with nothing loaded yet, or a failed read.
   */
  mcpConfigEvidence?(sessionId: string): Promise<ProviderMcpConfigReport>;
}

/** One `/runtime-health` read, as MCP apply evidence. */
export type ProviderMcpConfigReport =
  | { state: "evidence"; evidence: ProviderMcpConfigEvidence }
  | { state: "none" }
  /** The bridge answered without the MCP configuration report: it predates it. */
  | { state: "unsupported" };

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
  /**
   * Servers the configuration dropped that the runtime still runs (Claude: a
   * CLI kept alive by background work that could not unload them). Absent
   * when there are none or the bridge predates the field.
   */
  staleServers?: string[];
}

export type ProviderMcpConfigEvidenceRead = ProviderMcpConfigReport | { state: "not-running" };

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
  /** A `stale` list the provider completes when its session attaches. */
  attachPending?: boolean;
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
  accountId?: string;
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
  /**
   * Content-free hint that an owned session's activity or pending input may
   * have changed (`sessionId`), or that the event stream lost continuity
   * (`undefined`). Hints only make the next observation due; they are never
   * applied as activity themselves. Must not throw or await.
   */
  onObservationHint?: (sessionId: string | undefined) => void;
}

/**
 * Structural twin of change tracking's `EvidenceSource`, declared here so the
 * provider contract does not import the change-tracking service.
 */
export interface ChangeEvidenceSourceLike {
  sourceKey: string;
  environmentId: string;
  provider: string;
  read(
    cursor: number,
    epoch: string | null,
  ): Promise<
    import("@orkestrator/protocol/change-evidence").ChangeEvidenceReadResponse | "unsupported"
  >;
  body(id: string): Promise<Uint8Array | null>;
  ack(
    request: import("@orkestrator/protocol/change-evidence").ChangeEvidenceAckRequest,
  ): Promise<void>;
}
