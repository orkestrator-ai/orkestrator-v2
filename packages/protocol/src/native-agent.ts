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

/**
 * Catalog option meaning "leave this to the model / agent default".
 *
 * OpenCode injects this as a real choice; launch dialogs do too. When it is
 * present, it is the app default — do not substitute "high".
 */
export const DEFAULT_REASONING_ID = "default";

/**
 * Concrete effort used when a catalog has no `default` option.
 *
 * Last-selected values and inherited settings still win over this.
 */
export const FALLBACK_REASONING_ID = "high";

function reasoningOptionIds(
  options: readonly string[] | readonly { id: string }[],
): string[] {
  return options.map((option) => typeof option === "string" ? option : option.id);
}

/**
 * Reasoning id to use when nothing else (last selection, inherited setting,
 * live agent state) has already chosen one.
 *
 * Prefers an explicit "default" option when the catalog offers one; otherwise
 * "high" when that effort exists; otherwise the catalog's advertised default
 * when it is still offered; otherwise the first remaining option.
 */
export function fallbackReasoningId(
  options: readonly string[] | readonly { id: string }[],
  advertisedDefault?: string,
): string | undefined {
  const ids = reasoningOptionIds(options);
  if (ids.includes(DEFAULT_REASONING_ID)) return DEFAULT_REASONING_ID;
  if (ids.includes(FALLBACK_REASONING_ID)) return FALLBACK_REASONING_ID;
  if (advertisedDefault && ids.includes(advertisedDefault)) return advertisedDefault;
  return ids[0];
}

/**
 * Keep a still-supported preference (last selected or inherited), otherwise
 * apply {@link fallbackReasoningId}.
 */
export function resolveReasoningId(
  options: readonly string[] | readonly { id: string }[],
  preferred?: string,
  advertisedDefault?: string,
): string | undefined {
  const ids = reasoningOptionIds(options);
  if (preferred && ids.includes(preferred)) return preferred;
  return fallbackReasoningId(ids, advertisedDefault);
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

/**
 * Provider catalogues Orkestrator selects from by default. OpenCode advertises
 * every provider it knows about — thousands of models — but only these two are
 * the managed catalogues Orkestrator ships against.
 */
export const DEFAULT_OPENCODE_MODEL_PROVIDERS: readonly string[] = Object.freeze([
  "opencode",
  "opencode-go",
]);

/** Upper bound on the configured allowlist, so config cannot unbound a scan. */
export const MAX_OPENCODE_MODEL_PROVIDERS = 64;

/**
 * OpenCode model ids are `providerID/modelID` and the model half may itself
 * contain slashes, so the provider is only ever the first segment.
 */
export function openCodeModelProviderId(modelId: string): string {
  const separator = modelId.indexOf("/");
  return separator > 0 ? modelId.slice(0, separator) : "";
}

/**
 * Coerce a stored/user-supplied allowlist into canonical form. An absent or
 * unusable value falls back to the default pair; an explicitly empty list is
 * preserved so "show everything" stays expressible.
 */
export function normalizeOpenCodeModelProviders(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_OPENCODE_MODEL_PROVIDERS];
  // An empty array is the user's explicit opt-in to OpenCode's full catalogue.
  // A non-empty array that normalizes to nothing is malformed config, not that
  // opt-in, and must retain the managed default rather than fail open.
  if (value.length === 0) return [];
  const providers: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    // Provider ids are matched case-insensitively but stored as typed, so a
    // stray "OpenCode" cannot silently select nothing.
    const id = entry.trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    providers.push(id);
    if (providers.length >= MAX_OPENCODE_MODEL_PROVIDERS) break;
  }
  return providers.length > 0
    ? providers
    : [...DEFAULT_OPENCODE_MODEL_PROVIDERS];
}

/**
 * Whether a provider id is selectable. An empty allowlist means unrestricted,
 * which is the only way to opt back into OpenCode's full catalogue.
 */
export function isSelectableOpenCodeProvider(
  providerId: string,
  allowedProviders: readonly string[],
): boolean {
  if (allowedProviders.length === 0) return true;
  return allowedProviders.includes(providerId.trim().toLowerCase());
}

/** Whether a `providerID/modelID` belongs to a selectable provider. */
export function isSelectableOpenCodeModelId(
  modelId: string,
  allowedProviders: readonly string[],
): boolean {
  return isSelectableOpenCodeProvider(
    openCodeModelProviderId(modelId),
    allowedProviders,
  );
}

/**
 * A cache key identifying the allowlist a catalogue was filtered against.
 *
 * Nothing constrains the shape of a stored provider id, so joining on a
 * separator would collide `["a,b"]` with `["a","b"]` and serve one list's
 * catalogue to the other.
 */
export function openCodeModelProvidersKey(
  allowedProviders: readonly string[],
): string {
  return JSON.stringify(allowedProviders);
}

/**
 * Seed the allowlist for an install that predates it.
 *
 * The managed pair is the baseline, but any OpenCode model already stored as a
 * default or favourite was chosen from a picker that offered every provider.
 * Dropping those providers would leave the user pointed at a model no picker
 * will list, so each one is preserved alongside the managed pair.
 */
export function migrateOpenCodeModelProviders(
  storedModelIds: readonly unknown[],
): string[] {
  const providers = [...DEFAULT_OPENCODE_MODEL_PROVIDERS];
  for (const candidate of storedModelIds) {
    if (typeof candidate !== "string") continue;
    const providerId = openCodeModelProviderId(candidate.trim().toLowerCase());
    if (!providerId || providers.includes(providerId)) continue;
    providers.push(providerId);
  }
  // Normalize rather than return directly so the migrated list is bounded by
  // the same cap as a user-edited one.
  return normalizeOpenCodeModelProviders(providers);
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

/**
 * A provider may have accepted this request even though Orkestrator did not
 * receive the acknowledgement. The backend retains the exact dispatch and
 * exposes only this content-free descriptor; retrying is a backend intent so
 * every renderer/provider uses the same idempotent recovery path.
 */
export interface NativeAgentRecoverableDispatch {
  requestId: string;
  createdAt: string;
}

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

/**
 * Every capability the richest provider offers, as a fresh object graph.
 *
 * Built per call rather than spread from one shared literal: a spread copies
 * the top level only, so `attachments`, `composer` and `actions` would stay
 * aliased across every caller and one renderer mutation would rewrite the
 * backend's table too.
 */
function richNativeAgentCapabilities(): NativeAgentCapabilities {
  return {
    attachments: { files: true, images: true },
    queue: true,
    resume: true,
    fork: true,
    slashCommands: true,
    backgroundTasks: false,
    composer: {
      provider: true,
      model: true,
      reasoning: true,
      speed: true,
      mode: true,
      executionProfile: false,
      localSettings: false,
      promptSuggestions: false,
    },
    actions: { compact: true },
  };
}

/**
 * The single capability table for every native agent.
 *
 * The renderer decides whether the composer may enqueue, and the backend
 * decides whether a projection carries a queue, from this one function. They
 * used to hold private copies: a table that said `queue: true` on one side and
 * `false` on the other would enqueue a prompt the queue list could never show,
 * so the divergence was invisible until a user hit it.
 */
export function nativeAgentCapabilities(
  agent: AgentPlatform,
): NativeAgentCapabilities {
  const capabilities = richNativeAgentCapabilities();
  if (agent === "cursor" || agent === "grok") {
    return {
      ...capabilities,
      // Both ACP agents read inline image content blocks; neither takes files.
      attachments: { files: false, images: true },
      fork: false,
      slashCommands: false,
      actions: {},
    };
  }
  if (agent === "claude") {
    return {
      ...capabilities,
      backgroundTasks: true,
      composer: {
        ...capabilities.composer,
        executionProfile: true,
        localSettings: true,
        promptSuggestions: true,
      },
      actions: { compact: true, rewindFiles: true },
    };
  }
  if (agent === "opencode") {
    return {
      ...capabilities,
      composer: {
        ...capabilities.composer,
        speed: false,
        executionProfile: true,
      },
      actions: { compact: true, undo: true, redo: true, share: true },
    };
  }
  return {
    ...capabilities,
    attachments: { files: false, images: true },
    actions: { compact: true, steer: true, review: true },
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
  | { kind: "error"; message: string }
  | { kind: "stopped"; message: string }
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
  /**
   * Provider-reported liveness, normalized so the shared picker can badge a
   * session it would be resuming mid-turn. Providers that cannot report it
   * leave it undefined rather than guessing `idle`.
   */
  status?: "idle" | "running" | "error";
  /** Short trailing detail, e.g. "12 messages". Already bounded by the adapter. */
  detail?: string;
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

/**
 * How much of a transcript the projection is carrying.
 *
 * The projection is deliberately bounded, so a long session is windowed to its
 * newest messages. The renderer needs to know that happened: silently dropping
 * history reads as data loss, and the "load earlier" affordance has to know
 * whether there is anything earlier to load.
 */
export interface NativeAgentMessageWindow {
  /** Messages the projection was allowed to carry. */
  limit: number;
  /** True when the provider had more messages or parts than the window carries. */
  truncated: boolean;
  /** Why the authoritative projection omitted earlier transcript content. */
  truncationReason?: "count" | "bytes";
  /** Whole messages omitted from the front of this projection. */
  omittedMessages?: number;
  /** Parts omitted from the front of the oldest retained message. */
  omittedParts?: number;
}

/** Heavy tool fields fetched only after the user expands a transcript row. */
export interface NativeAgentToolDetails {
  detailRef: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: {
    filePath?: string;
    additions?: number;
    deletions?: number;
    before?: string;
    after?: string;
    diff?: string;
  };
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
  /** Present whenever the transcript is windowed; absent means "everything". */
  messageWindow?: NativeAgentMessageWindow;
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
  /** Content-free marker for an idempotent backend-owned retry. */
  recoverableDispatch?: NativeAgentRecoverableDispatch;
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
