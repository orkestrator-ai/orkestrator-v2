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
import type {
  JsonSchema,
  StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";
import type { PromptAttachment } from "./prompt-attachments.js";

export type ProviderStatus = "running" | "blocked" | "idle" | "error" | "missing";
export type ProviderActivityState = AgentActivityState | "missing";
export type ProviderExecutionMode = "plan" | "build";
export type ProviderAgent = AgentInteractionProvider;

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
  watchInteractions?(
    sessionId: string,
    onRevision: (revision: number) => void,
  ): () => void;
}

export class PromptRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptRejectedError";
  }
}

export class ProviderUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined
      ? undefined
      : { cause: options.cause });
    this.name = "ProviderUnavailableError";
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
  provider: Pick<AgentSessionProvider, "status">,
  sessionId: string,
): Promise<{ status: ProviderStatus; error?: string }> {
  try {
    return { status: await provider.status(sessionId) };
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
  registerSession?(
    sessionId: string,
    interaction?: ProviderSessionRegistration,
  ): void;
  createSession(
    phase: string,
    label: string,
    options?: ProviderCreateSessionOptions,
  ): Promise<string>;
  send(
    sessionId: string,
    prompt: string,
    options: ProviderSendOptions,
  ): Promise<void>;
  status(sessionId: string): Promise<ProviderStatus>;
  activity?(sessionId: string): Promise<ProviderActivityState>;
  activityBatch?(
    sessionIds: readonly string[],
  ): Promise<Map<string, ProviderActivityState>>;
  readonly interactions?: AgentInteractionProviderCapability;
  messages(sessionId: string, options?: { limit?: number }): Promise<unknown[]>;
  structured<T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T> | null>;
  abort(sessionId: string): Promise<void>;
  dispose?(): Promise<void> | void;
}

export interface NativeAgentRuntimeProvider extends AgentSessionProvider {
  modelCatalog?(): Promise<AgentModel[]>;
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
  ): Promise<string>;
  forkSession?(
    sessionId: string,
    messageId?: string,
  ): Promise<NativeAgentForkOutcome>;
  slashCommands?(): Promise<NativeAgentSlashCommand[]>;
  refreshCatalog?(): Promise<void> | void;
  stopBackgroundTask?(sessionId: string, taskId: string): Promise<void>;
  dismissSuggestedPrompt?(sessionId: string): Promise<void>;
  performSessionAction?(
    sessionId: string,
    action: NativeAgentSessionAction,
  ): Promise<NativeAgentSessionActionOutcome>;
}

export interface BridgeConnection {
  agent: ProviderAgent;
  baseUrl: string;
  authToken: string;
  directory?: string;
  model?: string;
  effort?: string;
  requestTimeoutMs?: number;
}

export interface ProviderCommonDependencies {
  stageImages?: (
    images: readonly ProviderPromptImage[],
  ) => Promise<PromptAttachment[]>;
  autoAnswerRequests?: boolean;
  onInteractionObservation?: (
    event: ProviderInteractionObservationEvent,
  ) => void | Promise<void>;
}
