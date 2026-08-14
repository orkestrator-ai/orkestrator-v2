import type { AgentInteractionRequest } from "./agent-interactions.js";
import { isAgentPlatform, type AgentPlatform } from "./agent-platforms.js";

/** Provider-neutral identity for one native-agent tab. */
export interface NativeAgentTabData {
  /** Locked on first dispatch. Undefined is the durable, unassigned state. */
  platform?: AgentPlatform;
  environmentId: string;
  containerId?: string;
  hostPort?: number;
  sessionId?: string;
  isLocal?: boolean;
}

export function isNativeAgentTabData(value: unknown): value is NativeAgentTabData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const optionalString = (field: string) =>
    data[field] === undefined || typeof data[field] === "string";
  return (data.platform === undefined || isAgentPlatform(data.platform))
    && typeof data.environmentId === "string"
    && data.environmentId.length > 0
    && optionalString("containerId")
    && optionalString("sessionId")
    && (data.hostPort === undefined
      || (Number.isSafeInteger(data.hostPort) && (data.hostPort as number) > 0))
    && (data.isLocal === undefined || typeof data.isLocal === "boolean");
}

export interface AgentReasoningOption {
  id: string;
  label: string;
  description?: string;
  annotation?: string;
}

/** Provider-neutral model catalog entry consumed by renderer presentation. */
export interface AgentModel {
  platform: AgentPlatform;
  id: string;
  label: string;
  /** Provider label shown beneath the model name; defaults to the platform. */
  providerLabel?: string;
  description?: string;
  reasoning?: AgentReasoningOption[];
  defaultReasoningId?: string;
  supportsSpeed?: boolean;
  supportsMode?: boolean;
  /** Provider context-window size, used by the shared usage meter. */
  contextWindow?: number;
  /** False only when the provider explicitly says this model rejects images. */
  supportsImageInput?: boolean;
}

export interface AgentModelRef {
  platform: AgentPlatform;
  modelId: string;
}

export type AgentConversationMode = "build" | "plan";

/**
 * Provider-neutral composer snapshot. ACP adapters normalize vendor wire
 * (`configOptions`, `models._meta`, `session/set_model`) into this shape before
 * any renderer or backend catalog consumer sees it.
 */
export interface NativeAgentComposerState {
  models: AgentModel[];
  selectedModelId?: string;
  selectedReasoningId?: string;
  fastModeEnabled: boolean | null;
  fastModeAvailable: boolean;
  selectedModeId?: AgentConversationMode;
  modes: Array<{ id: AgentConversationMode; label: string }>;
  executionProfiles?: Array<{ id: string; label: string; description?: string; modelId?: string }>;
  selectedExecutionProfileId?: string;
  includeLocalSettings?: boolean;
  promptSuggestionsEnabled?: boolean;
}

export const EMPTY_NATIVE_AGENT_COMPOSER_STATE: NativeAgentComposerState = {
  models: [],
  fastModeEnabled: null,
  fastModeAvailable: false,
  modes: [],
};

export type NativeAgentConnectionState = "connecting" | "connected" | "error";

/**
 * A dispatch may have reached the provider even when its HTTP response was
 * lost. Callers must reconcile `unknown`; they must never retry it blindly.
 */
export type NativeAgentDispatchOutcome =
  | { outcome: "accepted"; requestId: string }
  | { outcome: "rejected"; error: string }
  | { outcome: "unknown"; requestId: string; error?: string };

export type NativeAgentTurnPhase =
  | "idle"
  | "running"
  | "blocked"
  | "cancelling"
  | "recovering"
  | "error";

export interface NativeAgentTurnState {
  phase: NativeAgentTurnPhase;
  startedAt?: number;
  error?: string;
}

export interface NativeAgentSelectOption {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface NativeAgentSelectControl {
  kind: "select" | "segmented";
  id: string;
  label: string;
  value?: string;
  options: NativeAgentSelectOption[];
  disabled?: boolean;
}

export interface NativeAgentToggleControl {
  kind: "toggle";
  id: string;
  label: string;
  value: boolean;
  description?: string;
  disabled?: boolean;
}

export type NativeAgentComposerControl =
  | NativeAgentSelectControl
  | NativeAgentToggleControl;

export interface NativeAgentCapabilities {
  attachments: {
    files: boolean;
    images: boolean;
  };
  queue: boolean;
  resume: boolean;
  fork: boolean;
  slashCommands: boolean;
  backgroundTasks: boolean;
  composer: {
    provider: boolean;
    model: boolean;
    reasoning: boolean;
    speed: boolean;
    mode: boolean;
    executionProfile?: boolean;
    localSettings?: boolean;
    promptSuggestions?: boolean;
  };
  /** Platform-specific behavior exposed through the shared session surface. */
  actions?: {
    compact?: boolean;
    rewindFiles?: boolean;
    undo?: boolean;
    redo?: boolean;
    share?: boolean;
    steer?: boolean;
    review?: boolean;
  };
}

export type NativeAgentSessionAction =
  | { kind: "compact"; modelId?: string }
  | { kind: "rewind-files"; messageId: string; dryRun?: boolean }
  | { kind: "undo"; messageId?: string }
  | { kind: "redo" }
  | { kind: "share" }
  | { kind: "unshare" }
  | { kind: "steer"; text: string; requestId: string }
  | { kind: "review" };

export interface NativeAgentSessionActionOutcome {
  outcome: "applied" | "idle" | "mismatch" | "unknown";
  shareUrl?: string;
  preview?: unknown;
  requestId?: string;
}

/** Durable queue state projected with an interactive native session. */
export interface NativeAgentQueueSnapshot<TItem = unknown> {
  items: TItem[];
  inFlightRequestId?: string;
  blocked?: {
    messageId?: string;
    error: string;
    attempts?: number;
  };
}

export interface NativeAgentContextUsage {
  usedTokens: number;
  maximumTokens?: number;
  percentage?: number;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  lastTurnTokens?: number;
  sessionTokens?: number;
  costUsd?: number;
  durationMs?: number;
  apiDurationMs?: number;
  estimated?: boolean;
  source?: "claude" | "opencode" | "codex" | "heuristic" | "provider";
  updatedAt?: string;
  rateLimits?: Array<{
    label: string;
    usedPercent?: number;
    resetsAt?: string;
    windowMinutes?: number;
  }>;
  credits?: {
    hasCredits?: boolean;
    unlimited?: boolean;
    balance?: string;
  };
  contextCategories?: Array<{ name: string; tokens: number; color?: string }>;
  permissionDenials?: number;
  linesAdded?: number;
  linesRemoved?: number;
}

export interface NativeAgentRateLimitWindow {
  label: string;
  usedPercent?: number;
  resetsAt?: string;
  windowMinutes?: number;
}

/** Bounded, content-free runtime inventory for the agent-information panel. */
export interface NativeAgentRuntimeSummary {
  mcpServers?: number;
  plugins?: number;
  commands?: number;
  skills?: number;
  hooks?: number;
  lspServers?: number;
  formatters?: number;
  todos?: number;
  files?: number;
  state?: string;
  version?: string;
  notices?: Array<{ message: string; count?: number }>;
}

export type NativeAgentNotice =
  | { kind: "recovery"; message: string }
  | { kind: "incomplete-turn"; message: string }
  | { kind: "warning"; message: string };

export interface NativeAgentBackgroundTaskSummary {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "killed" | "paused";
  description?: string;
}

export interface NativeAgentTurnBoundary {
  turnId: string;
  messageId?: string;
  resumable: boolean;
  forkable: boolean;
}

export interface NativeAgentResumeEntry {
  sessionId: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface NativeAgentForkOutcome {
  sessionId: string;
  title?: string;
}

export interface NativeAgentSlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

export interface NativeAgentControlUpdate {
  modelId?: string;
  reasoningId?: string;
  fastMode?: boolean;
  mode?: AgentConversationMode;
  executionProfileId?: string | null;
  includeLocalSettings?: boolean;
  promptSuggestions?: boolean;
}

/**
 * Provider-neutral state consumed by native-agent presentation components.
 * Provider wire payloads and credentials must never be attached to this shape.
 */
export interface NativeAgentSessionProjection<TMessage = unknown> {
  platform: AgentPlatform;
  environmentId: string;
  sessionId?: string;
  title?: string;
  /**
   * Authoritative provider sharing state. `null` means the provider confirmed
   * that the session is private; `undefined` means sharing is unsupported or
   * the provider could not report it.
   */
  shareUrl?: string | null;
  connection: NativeAgentConnectionState;
  turn: NativeAgentTurnState;
  messages: TMessage[];
  interactions: AgentInteractionRequest[];
  composerControls: NativeAgentComposerControl[];
  /** Rich, provider-neutral model metadata used by the common model picker. */
  composer?: NativeAgentComposerState;
  capabilities: NativeAgentCapabilities;
  queue?: NativeAgentQueueSnapshot;
  contextUsage?: NativeAgentContextUsage;
  /** Provider limits can arrive before the first token-usage snapshot. */
  rateLimits?: NativeAgentRateLimitWindow[];
  runtime?: NativeAgentRuntimeSummary;
  notices?: NativeAgentNotice[];
  backgroundTasks?: NativeAgentBackgroundTaskSummary[];
  suggestedPrompt?: string;
  completionBlockedByBackgroundTasks?: boolean;
  turnBoundaries?: NativeAgentTurnBoundary[];
  slashCommands?: NativeAgentSlashCommand[];
  /** Monotonic within one runtime generation. */
  revision: number;
  /** Changes whenever the provider transport authority is replaced. */
  generation: string | number;
  cursor?: string;
}
