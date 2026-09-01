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
  NativeAgentControlUpdate,
  NativeAgentForkOutcome,
  NativeAgentNotice,
  NativeAgentRateLimitWindow,
  NativeAgentResumeEntry,
  NativeAgentRuntimeSummary,
  NativeAgentSessionAction,
  NativeAgentSessionActionOutcome,
  NativeAgentSlashCommand,
  NativeAgentTurnPhase,
} from "@orkestrator/protocol/native-agent";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { PromptAttachment } from "./prompt-attachments.js";

export type ProviderStatus = "running" | "blocked" | "idle" | "error" | "missing";
export type ProviderActivityState = AgentActivityState | "missing";
export type ProviderExecutionMode = "plan" | "build";
export type ProviderAgent = AgentInteractionProvider;

export interface ProviderSessionObservation {
  status: ProviderStatus;
  /** Cumulative session consumption only; context-window occupancy is not interchangeable. */
  contextUsage?: NativeAgentContextUsage;
  /** A terminal provider is still reconciling its exact cumulative total. */
  usagePending?: boolean;
}

export interface ProviderPromptImage {
  filename: string;
  data: string;
}

export interface ProviderSessionRegistration {
  origin: AgentInteractionOrigin;
  interactionPolicy: AgentInteractionPolicy;
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
  provider: Pick<AgentSessionProvider, "status" | "observeSession">,
  sessionId: string,
): Promise<ProviderSessionObservation & { error?: string }> {
  try {
    return provider.observeSession
      ? await provider.observeSession(sessionId)
      : { status: await provider.status(sessionId) };
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
  clientSessionKey?: string;
  mode?: ProviderExecutionMode;
  model?: string;
  effort?: string;
  fastMode?: boolean;
  interaction?: ProviderSessionRegistration;
}

export interface ProviderSendOptions {
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
  allowProviderCommands?: boolean;
}

export interface ProviderInteractiveSnapshot {
  status: ProviderStatus;
  messages: unknown[];
  title?: string;
  shareUrl?: string | null;
  composer?: NativeAgentComposerState;
  controls?: NativeAgentControlUpdate;
  providerRevision?: number;
  providerGeneration?: string | number;
  phase?: NativeAgentTurnPhase;
  turnStartedAt?: number;
  contextUsage?: NativeAgentContextUsage;
  rateLimits?: NativeAgentRateLimitWindow[];
  runtime?: NativeAgentRuntimeSummary;
  notices?: NativeAgentNotice[];
  backgroundTasks?: NativeAgentBackgroundTaskSummary[];
  suggestedPrompt?: string;
  completionBlockedByBackgroundTasks?: boolean;
  error?: string;
}

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
  prepareDispatch?(sessionId: string): Promise<void>;
  /**
   * Ask whether the provider already holds this request id.
   *
   * Read-only. It exists so an ambiguous dispatch can be settled from the
   * provider's own durable journal instead of being parked for the user.
   */
  dispatchStatus?(sessionId: string, requestId: string): Promise<ProviderDispatchStatus>;
  status(sessionId: string): Promise<ProviderStatus>;
  /**
   * Read lifecycle and cumulative usage from one authoritative provider
   * snapshot. Providers should implement this only when both values come from
   * the same upstream read; callers otherwise fall back to status().
   */
  observeSession?(sessionId: string): Promise<ProviderSessionObservation>;
  /**
   * Authoritative activity including input parked at the provider. Optional so
   * narrow test providers and non-interactive integrations can fall back to
   * the coarser status contract.
   */
  activity?(sessionId: string): Promise<ProviderActivityState>;
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
  abort(sessionId: string): Promise<void>;
  /** Close the provider-side session and release any process attached to it. */
  closeSession?(sessionId: string): Promise<void>;
  dispose?(): Promise<void> | void;
}

/**
 * Interactive, provider-neutral session surface consumed by NativeAgentService.
 * Build-pipeline callers retain the deliberately smaller interface above.
 */
export interface NativeAgentRuntimeProvider extends AgentSessionProvider {
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
  resumeSession?(sessionId: string, controls?: NativeAgentControlUpdate): Promise<string>;
  forkSession?(sessionId: string, messageId?: string): Promise<NativeAgentForkOutcome>;
  slashCommands?(): Promise<NativeAgentSlashCommand[]>;
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
