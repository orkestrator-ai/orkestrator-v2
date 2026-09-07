import {
  AGENT_INTERACTION_KINDS,
  type AgentInteractionKind,
  type AgentInteractionRequest,
} from "./agent-interactions.js";
import { isAgentPlatform, type AgentPlatform } from "./agent-platforms.js";

/** Provider-neutral identity for one native-agent tab. */
export interface NativeAgentTabData {
  /** Locked on first dispatch. Undefined is the durable, unassigned state. */
  platform?: AgentPlatform;
  environmentId: string;
  containerId?: string;
  hostPort?: number;
  sessionId?: string;
  /** A backend-owned resume target must fail rather than create an empty replacement. */
  requireExistingResumeSession?: boolean;
  isLocal?: boolean;
}

export function isNativeAgentTabData(value: unknown): value is NativeAgentTabData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const optionalString = (field: string) =>
    data[field] === undefined || typeof data[field] === "string";
  return (
    (data.platform === undefined || isAgentPlatform(data.platform)) &&
    typeof data.environmentId === "string" &&
    data.environmentId.length > 0 &&
    optionalString("containerId") &&
    optionalString("sessionId") &&
    (data.requireExistingResumeSession === undefined ||
      typeof data.requireExistingResumeSession === "boolean") &&
    (data.hostPort === undefined ||
      (Number.isSafeInteger(data.hostPort) && (data.hostPort as number) > 0)) &&
    (data.isLocal === undefined || typeof data.isLocal === "boolean")
  );
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

function reasoningOptionIds(options: readonly string[] | readonly { id: string }[]): string[] {
  return options.map((option) => (typeof option === "string" ? option : option.id));
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
  /** Alternate provider ids which select this same model. */
  aliases?: string[];
  /** Provider-neutral, model-specific controls rendered by the shared composer. */
  parameters?: AgentModelParameter[];
}

export interface AgentModelParameter {
  id: string;
  label: string;
  kind: "select" | "toggle";
  options?: Array<{ id: string; label: string; description?: string }>;
  defaultValue?: string | boolean;
  scope: "session" | "turn";
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
 * The model half of `providerID/modelID`. Empty when the id names no provider.
 */
export function openCodeModelLocalId(modelId: string): string {
  const providerId = openCodeModelProviderId(modelId);
  return providerId ? modelId.slice(providerId.length + 1) : "";
}

/**
 * First-line picker label for an OpenCode model.
 *
 * OpenCode often reports `name` as the fully qualified id (`opencode-go/deepseek-v4-flash`).
 * The provider belongs on the second line, so that prefix is stripped when present.
 */
export function openCodeModelDisplayLabel(modelId: string, name?: string | null): string {
  const localId = openCodeModelLocalId(modelId);
  const raw = name?.trim() || localId || modelId;
  const providerId = openCodeModelProviderId(modelId);
  if (!providerId) return raw;
  const prefix = `${providerId}/`;
  if (!raw.toLowerCase().startsWith(prefix.toLowerCase())) return raw;
  // A name that is nothing but the prefix would strip to an empty label, so
  // fall back rather than render a blank row.
  return raw.slice(prefix.length) || localId || raw;
}

/**
 * A picker row for an OpenCode id that is not yet in a live or cached catalogue.
 *
 * Favourites and TUI recents have to be selectable before an OpenCode server
 * has listed models, otherwise they render as disabled placeholders whose
 * first line is the raw id and whose second line is the generic "OpenCode"
 * platform name.
 */
export function synthesizedOpenCodeAgentModel(modelId: string): AgentModel | null {
  const trimmed = modelId.trim();
  const providerId = openCodeModelProviderId(trimmed);
  const localId = openCodeModelLocalId(trimmed);
  if (!providerId || !localId) return null;
  return {
    platform: "opencode",
    id: trimmed,
    label: openCodeModelDisplayLabel(trimmed),
    providerLabel: providerId,
    reasoning: [{ id: DEFAULT_REASONING_ID, label: "Default" }],
    defaultReasoningId: DEFAULT_REASONING_ID,
    supportsSpeed: false,
    supportsMode: false,
  };
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
  return providers.length > 0 ? providers : [...DEFAULT_OPENCODE_MODEL_PROVIDERS];
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
  return isSelectableOpenCodeProvider(openCodeModelProviderId(modelId), allowedProviders);
}

/**
 * A cache key identifying the allowlist a catalogue was filtered against.
 *
 * Nothing constrains the shape of a stored provider id, so joining on a
 * separator would collide `["a,b"]` with `["a","b"]` and serve one list's
 * catalogue to the other.
 */
export function openCodeModelProvidersKey(allowedProviders: readonly string[]): string {
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
export function migrateOpenCodeModelProviders(storedModelIds: readonly unknown[]): string[] {
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
 * Whether the provider can accept a prompt from this session right now.
 *
 * Optional on projections for compatibility with older bridges. A missing
 * value therefore means "unknown", never "ready" or "blocked". Credential
 * material and provider-specific account details must not be attached here.
 */
export type NativeAgentReadiness =
  | { state: "ready" }
  | { state: "authentication-required"; message: string };

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
  /** Current values for the selected model's generic parameter descriptors. */
  parameterValues?: Record<string, string | boolean>;
  /** True when the provider can make the current selections its future defaults. */
  persistedDefaults?: boolean;
}

export const EMPTY_NATIVE_AGENT_COMPOSER_STATE: NativeAgentComposerState = {
  models: [],
  fastModeEnabled: null,
  fastModeAvailable: false,
  modes: [],
};

/**
 * The only execution-profile ids selectable before a provider lists its agents.
 *
 * Every other id has to be checked against `executionProfiles`, because it is
 * forwarded verbatim as the provider's `agent` name. These two are exempt: they
 * are OpenCode's built-in primary agents, so a client can offer them while
 * `app.agents` is still in flight, and the launcher must offer them because the
 * opening prompt is dispatched before any session exists to list against.
 *
 * Shared so the renderer's fallback pair and the backend's guard cannot drift —
 * a widened list on one side would otherwise be silently rejected or silently
 * accepted by the other.
 */
export const FALLBACK_EXECUTION_PROFILE_IDS = ["build", "plan"] as const;

export type FallbackExecutionProfileId = (typeof FALLBACK_EXECUTION_PROFILE_IDS)[number];

export function isFallbackExecutionProfileId(id: string): boolean {
  return (FALLBACK_EXECUTION_PROFILE_IDS as readonly string[]).includes(id);
}

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
  /** Omitted by older backends, where every recoverable dispatch was a prompt. */
  kind?: "prompt" | "steer";
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

export type NativeAgentComposerControl = NativeAgentSelectControl | NativeAgentToggleControl;

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
    rewindMessages?: boolean;
    branches?: boolean;
  };
  /**
   * The interaction kinds this platform can raise.
   *
   * Absent means "not reported"; present-and-empty means "this agent never
   * asks", which is a different and more useful answer — it lets the renderer
   * say so rather than showing an empty pending-interactions list that looks
   * like a loading state forever. Cursor's SDK has no approval hook at all, so
   * it is the empty case.
   */
  interactions?: { kinds: AgentInteractionKind[] };
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
    interactions: { kinds: [...AGENT_INTERACTION_KINDS] },
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
export function nativeAgentCapabilities(agent: AgentPlatform): NativeAgentCapabilities {
  const capabilities = richNativeAgentCapabilities();
  if (agent === "cursor" || agent === "grok") {
    return {
      ...capabilities,
      // Cursor's SDK bridge and Grok's ACP bridge read inline image content
      // blocks; neither takes files.
      attachments: { files: false, images: true },
      fork: false,
      slashCommands: agent === "grok",
      // `speed` and `mode` stay true because both agents really do own them:
      // Cursor drives fast through a `model_config` config option, Grok through
      // a sibling `…-fast` model id, and both announce session modes. They are
      // per-build, not per-platform, so the flag means "this platform may offer
      // it" and the live composer's `fastModeAvailable` / `modes` decides.
      actions: agent === "cursor" ? { steer: true, rewindMessages: true } : {},
      // Cursor's SDK exposes no approval hook at all, so a Cursor tab never
      // raises anything. Grok's ACP wire does: it answers
      // `session/request_permission` for tool calls. Reporting the empty set
      // rather than omitting the field lets the renderer say "this agent does
      // not ask" instead of showing a list that looks like it is still loading.
      interactions: {
        kinds: agent === "cursor" ? [] : ["command-approval", "file-approval", "permission"],
      },
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
      actions: { compact: true, rewindFiles: true, steer: true },
      // Questions through `AskUserQuestion`, plan approvals through
      // `ExitPlanMode`, tool approvals through `canUseTool`, and MCP
      // elicitations and host dialogs through the SDK's own callbacks.
      interactions: {
        kinds: [
          "question",
          "plan-approval",
          "command-approval",
          "file-approval",
          "permission",
          "mcp-form",
          "mcp-url",
          "elicitation",
        ],
      },
    };
  }
  if (agent === "opencode") {
    return {
      ...capabilities,
      composer: {
        ...capabilities.composer,
        // No fast surface anywhere in the SDK; both OpenCode catalogues report
        // `supportsSpeed: false` for every model.
        speed: false,
        // OpenCode has primary agents, not a Claude/Codex permission mode.
        // Plan/Build on the compose bar is the execution-profile picker, whose
        // selection is sent as the SDK `agent` name.
        mode: false,
        executionProfile: true,
      },
      actions: { compact: true, undo: true, redo: true, share: true },
      // `permission.asked` and the v2-only `question.asked`. No MCP
      // elicitation surface on the v1 wire this repo uses.
      interactions: { kinds: ["question", "permission", "command-approval", "file-approval"] },
    };
  }
  if (agent === "pi") {
    return {
      ...capabilities,
      composer: {
        ...capabilities.composer,
        // Pi's reasoning axis is its thinking level, which every provider it
        // fronts exposes. There is no speed toggle anywhere in the SDK, and
        // "no forced features like plan mode" is Pi's stated design — modes
        // are something an extension adds, not something the harness ships,
        // so claiming one here would offer a control nothing can honour.
        speed: false,
        mode: false,
      },
      actions: { compact: true, steer: true, rewindMessages: true, branches: true },
      // Pi's approval gate is off unless `PI_BRIDGE_REQUIRE_APPROVAL=1`, so
      // this is what the platform *may* raise. The live session reports the
      // empty set when the gate is off — see the bridge's status projection.
      interactions: { kinds: ["command-approval", "file-approval"] },
    };
  }
  return {
    ...capabilities,
    attachments: { files: false, images: true },
    actions: { compact: true, steer: true, review: true, rewindMessages: true },
    // Codex: `item/tool/requestUserInput` questions, MCP elicitations in both
    // form and url modes, and command/file approvals through
    // `item/permissions/requestApproval`.
    interactions: {
      kinds: ["question", "command-approval", "file-approval", "permission", "mcp-form", "mcp-url"],
    },
  };
}

export type NativeAgentSessionAction =
  | { kind: "compact"; modelId?: string }
  | { kind: "rewind-files"; messageId: string; dryRun?: boolean }
  | { kind: "undo"; messageId?: string }
  | { kind: "redo" }
  | { kind: "share" }
  | { kind: "unshare" }
  | { kind: "steer"; text: string }
  | { kind: "review" }
  | { kind: "rewind-messages"; messageId: string }
  | { kind: "switch-branch"; entryId: string };

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

export const NATIVE_ASYNC_QUESTION_REQUEST_PREFIX = "async-question:";

/** Stable idempotency key used when an async Codex question becomes a user message. */
export function nativeAsyncQuestionRequestId(itemId: string): string {
  return `${NATIVE_ASYNC_QUESTION_REQUEST_PREFIX}${encodeURIComponent(itemId)}`;
}

export function nativeAsyncQuestionItemId(requestId: string): string | undefined {
  if (!requestId.startsWith(NATIVE_ASYNC_QUESTION_REQUEST_PREFIX)) return undefined;
  try {
    const itemId = decodeURIComponent(requestId.slice(NATIVE_ASYNC_QUESTION_REQUEST_PREFIX.length));
    return itemId || undefined;
  } catch {
    return undefined;
  }
}

export interface NativeAgentAsyncQuestionResponse {
  itemId: string;
  requestId: string;
  state: "queued" | "dispatching" | "sent" | "failed";
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
  source?: "claude" | "opencode" | "codex" | "cursor" | "grok" | "pi" | "heuristic" | "provider";
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
  /** Bounded, non-secret descriptions of permission denials from the provider. */
  permissionDenialDetails?: Array<{
    toolName: string;
    toolUseId?: string;
    reason?: string;
  }>;
  /** Newest last. Providers and the backend retain at most twenty entries. */
  turns?: NativeAgentTurnUsage[];
  /** Account-level quota or billing windows reported by the provider. */
  account?: NativeAgentAccountUsageWindow[];
  linesAdded?: number;
  linesRemoved?: number;
}

export interface NativeAgentTurnUsage {
  turnId: string;
  costUsd?: number;
  /** Cursor's undiscounted price, retained separately from charged cost. */
  rawCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  apiDurationMs?: number;
  ttftMs?: number;
  numTurns?: number;
  toolCalls?: number;
  requestId?: string;
  modelId?: string;
}

export interface NativeAgentAccountUsageWindow {
  window: string;
  label?: string;
  /** Provider-reported token consumption for this account window. */
  tokens?: number;
  usedPercent?: number;
  resetsAt?: string;
  spendUsd?: number;
  creditsRemaining?: number;
  limitUsd?: number;
}

export type NativeAgentExecutionPolicyId =
  | "interactive-host"
  | "interactive-container"
  | "coordinator-read-only"
  | "pipeline";

/**
 * A thing an agent can do, named independently of any provider's tool names.
 *
 * `toolPolicy` cannot serve this purpose: it is the user-editable override
 * surface and its strings are passed to a provider verbatim, so the same list
 * means "Write, Edit" on one bridge and nothing at all on another. A capability
 * is translated by each bridge into whatever its own SDK calls that operation,
 * which is what lets one coordinator policy hold across every platform.
 */
export const NATIVE_AGENT_CAPABILITIES = [
  "file.write",
  "file.patch",
  "shell",
  "shell.mutate",
  "network",
] as const;
export type NativeAgentCapability = (typeof NATIVE_AGENT_CAPABILITIES)[number];

export function isNativeAgentCapability(value: unknown): value is NativeAgentCapability {
  return (
    typeof value === "string" && (NATIVE_AGENT_CAPABILITIES as readonly string[]).includes(value)
  );
}

export interface NativeAgentExecutionPolicy {
  id: NativeAgentExecutionPolicyId;
  sandbox: "provider" | "container" | "none";
  approvals: "ask" | "auto-approve" | "deny";
  projectResources: boolean;
  toolPolicy?: { allow?: string[]; deny?: string[] };
  /** Provider-neutral denials each bridge translates into its own tool names. */
  capabilityPolicy?: { deny: NativeAgentCapability[] };
  networkAccess: "restricted" | "full";
  /** Provider caveat when one policy axis cannot be enforced exactly. */
  note?: string;
}

/** User-editable axes layered over the backend's environment/origin defaults. */
export type NativeAgentExecutionPolicyOverride = Partial<
  Pick<
    NativeAgentExecutionPolicy,
    "sandbox" | "approvals" | "projectResources" | "toolPolicy" | "networkAccess"
  >
>;

export function isNativeAgentExecutionPolicy(value: unknown): value is NativeAgentExecutionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  // `null` is neither absent nor an object. Reading `.deny` off it throws a
  // TypeError out of a type guard that runs on request bodies at every bridge's
  // trust boundary, turning a rejection into an unhandled error.
  const isPlainObject = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
  if (policy.toolPolicy !== undefined && !isPlainObject(policy.toolPolicy)) return false;
  if (policy.capabilityPolicy !== undefined && !isPlainObject(policy.capabilityPolicy))
    return false;
  const toolPolicy = policy.toolPolicy as Record<string, unknown> | undefined;
  const capabilityPolicy = policy.capabilityPolicy as Record<string, unknown> | undefined;
  return (
    (policy.id === "interactive-host" ||
      policy.id === "interactive-container" ||
      policy.id === "coordinator-read-only" ||
      policy.id === "pipeline") &&
    (policy.sandbox === "provider" ||
      policy.sandbox === "container" ||
      policy.sandbox === "none") &&
    (policy.approvals === "ask" ||
      policy.approvals === "auto-approve" ||
      policy.approvals === "deny") &&
    typeof policy.projectResources === "boolean" &&
    (policy.networkAccess === "restricted" || policy.networkAccess === "full") &&
    (policy.note === undefined || typeof policy.note === "string") &&
    (toolPolicy === undefined ||
      ((toolPolicy.allow === undefined ||
        (Array.isArray(toolPolicy.allow) &&
          toolPolicy.allow.every((item) => typeof item === "string"))) &&
        (toolPolicy.deny === undefined ||
          (Array.isArray(toolPolicy.deny) &&
            toolPolicy.deny.every((item) => typeof item === "string"))))) &&
    (capabilityPolicy === undefined ||
      (Array.isArray(capabilityPolicy.deny) &&
        capabilityPolicy.deny.every(isNativeAgentCapability)))
  );
}

/** Stable, provider-neutral copy for the agent information panel. */
export function describeNativeAgentExecutionPolicy(policy: NativeAgentExecutionPolicy): string {
  const sandbox =
    policy.sandbox === "container"
      ? "Container sandbox"
      : policy.sandbox === "provider"
        ? "Provider sandbox"
        : "No sandbox";
  const approvals =
    policy.approvals === "ask"
      ? "approvals on request"
      : policy.approvals === "deny"
        ? "approvals denied"
        : "approvals off";
  return `${sandbox}, ${approvals}, project rules ${policy.projectResources ? "on" : "off"}, ${policy.networkAccess} network`;
}

export interface NativeAgentRateLimitWindow {
  label: string;
  usedPercent?: number;
  resetsAt?: string;
  windowMinutes?: number;
}

export interface NativeAgentRuntimeNoticeOccurrence {
  /** Redacted, bounded provider diagnostic text. */
  detail?: string;
  receivedAt?: string;
}

export const NATIVE_AGENT_NOTICE_SEVERITIES = ["info", "warning", "error"] as const;
export type NativeAgentNoticeSeverity = (typeof NATIVE_AGENT_NOTICE_SEVERITIES)[number];

/**
 * Who said it.
 *
 * `provider` is the agent's own diagnostic, reported verbatim within its
 * bounds; `bridge` is Orkestrator's own observation about the provider, such as
 * an event shape it did not recognise. The distinction matters because only the
 * first is something the user can act on with the vendor.
 */
export const NATIVE_AGENT_NOTICE_SOURCES = ["provider", "bridge"] as const;
export type NativeAgentNoticeSource = (typeof NATIVE_AGENT_NOTICE_SOURCES)[number];

export interface NativeAgentRuntimeNotice {
  message: string;
  method?: string;
  count?: number;
  /**
   * Defaults to `warning` when a provider omits it, which is what every notice
   * predating this field was.
   */
  severity?: NativeAgentNoticeSeverity;
  /** Defaults to `bridge`, matching every notice predating this field. */
  source?: NativeAgentNoticeSource;
  /** Most recent redacted occurrences, bounded by the provider projection. */
  occurrences?: NativeAgentRuntimeNoticeOccurrence[];
}

/**
 * What a bridge saw and did not understand.
 *
 * An SDK that adds a variant must not be able to make an event vanish without
 * a trace: every bridge counts what it dropped and keeps the *names* of the
 * most recent kinds. Names only — a payload can hold prompts, file contents or
 * credentials, and this travels to the renderer and the logs.
 */
export interface NativeAgentRuntimeDrift {
  unknownEvents: number;
  unknownKinds: string[];
}

/** Longest drift-kind list any projection carries. */
export const MAX_NATIVE_AGENT_DRIFT_KINDS = 16;

/** Longest a single drift kind name may be. */
export const MAX_NATIVE_AGENT_DRIFT_KIND_LENGTH = 128;

/** Bounded runtime inventory for the agent-information panel. */
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
  notices?: NativeAgentRuntimeNotice[];
  drift?: NativeAgentRuntimeDrift;
  /** Live normalized MCP inventory; the numeric field remains the badge count. */
  mcp?: NativeAgentMcpServer[];
}

export type NativeAgentMcpServerAction = "reconnect" | "enable" | "disable" | "sign-in";

export interface NativeAgentMcpServer {
  id: string;
  name: string;
  status: "connected" | "connecting" | "failed" | "needs-auth" | "disabled" | "unknown";
  scope?: "user" | "project" | "orkestrator" | "plugin";
  transport?: "stdio" | "sse" | "http";
  toolCount?: number;
  tools?: string[];
  /** Provider error text, redacted and bounded by the adapter. */
  error?: string;
  actions: NativeAgentMcpServerAction[];
}

export type NativeAgentAuthState =
  | "signed-in"
  | "signed-out"
  | "needs-auth"
  | "expired"
  | "unknown";

export interface NativeAgentAuthStatus {
  state: NativeAgentAuthState;
  account?: { label: string; plan?: string; expiresAt?: string };
  providers?: Array<{
    id: string;
    label: string;
    state: NativeAgentAuthState;
    method?: "api-key" | "oauth" | "subscription";
  }>;
  signIn?: { kind: "browser-url" | "device-code" | "terminal" | "none"; hint?: string };
  signOut?: boolean;
}

export type NativeAgentNotice = {
  /**
   * Stable identity for this occurrence while it remains authoritative.
   * Renderers use it to distinguish a newly reported notice from one the user
   * already dismissed, even when both occurrences have the same message.
   */
  occurrenceId?: string;
} & (
  | { kind: "recovery"; message: string }
  | { kind: "incomplete-turn"; message: string }
  | { kind: "error"; message: string }
  | { kind: "stopped"; message: string }
  | { kind: "warning"; message: string }
  | { kind: "auth"; state: NativeAgentAuthState; message: string }
  /**
   * A provider advisory that belongs in the tab rather than only in the health
   * panel — a deprecation, a rerouted model, a configuration warning. The user
   * is reading the transcript, not the panel, when the thing it is about
   * happens.
   */
  | { kind: "advisory"; message: string; severity: NativeAgentNoticeSeverity }
);

export interface NativeAgentBackgroundTaskSummary {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "killed" | "paused";
  description?: string;
  /**
   * The tool call that launched this task, when the provider reported one.
   *
   * This is what lets the renderer join a live task onto its transcript row and
   * present one card per task, rather than a separate provider-specific list
   * beside the transcript. The id recovered from launch output is only a
   * fallback: it exists solely in the tool result's prose.
   */
  toolUseId?: string;
  /**
   * When the provider started this task, as an ISO timestamp.
   *
   * Only the card for a task the transcript cannot show needs this, and only
   * when there is no transcript row to take a clock from either — a tab that
   * resumed into a task already running. Unlike `settledAt` it says nothing
   * about where the card belongs; it is what the card's own header reads.
   */
  startedAt?: string;
  /**
   * When the provider reported this task terminal, as an ISO timestamp.
   *
   * A long-running child is presented at the bottom of the transcript while it
   * runs, which is nowhere near the row that launched it. This is what says
   * where it belongs once it stops: the transcript position it had reached when
   * it settled, rather than the launch row it would otherwise snap back to.
   *
   * Deliberately backend-owned. The renderer could observe the same transition,
   * but only for the transitions it was mounted for — so the position would
   * differ between tabs, and reset on reload. Absent for a task that is still
   * live, and for one whose terminal edge predates this field.
   */
  settledAt?: string;
}

export const BACKGROUND_TASK_ID_MAX_LENGTH = 512;

/**
 * How much of a tool result is scanned for a launch id.
 *
 * The note Claude appends is the first thing in the result, so a bounded scan
 * finds it. The bound is what stops projection parsing a multi-megabyte result
 * merely to decorate one transcript row.
 */
export const BACKGROUND_TASK_LAUNCH_SCAN_CHARS = 4_096;

/*
 * Claude emits three different notes when a command ends up in the background,
 * and all three carry the same durable id:
 *   "Command running in background with ID: <id>. …"
 *   "Command was manually backgrounded by user with ID: <id>"
 *   "…timeout and was moved to the background (ID: <id>). …"
 * Matching only the first would leave Ctrl+B and timeout-backgrounded commands
 * unnamed and unlabelled after a transcript rehydration.
 */
const BACKGROUND_TASK_LAUNCH_ID_PATTERN =
  /\bbackground(?:ed by user)?\s*(?:with ID:|\(ID:)\s*([^\s.)]+)/i;

/*
 * Only a shell row's result may name a task the launch arguments did not.
 * Without this, any tool whose output happens to quote the note — a Read of
 * this very file, most obviously — would be mistaken for a launch.
 */
const BACKGROUND_CAPABLE_SHELL_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "terminal",
  "run_command",
  "runcommand",
  "run_terminal_cmd",
  "execute_command",
]);

function boundedBackgroundTaskId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return id && id.length <= BACKGROUND_TASK_ID_MAX_LENGTH ? id : undefined;
}

/** True for a shell tool whose result can report a task id its arguments omitted. */
export function isBackgroundCapableShellTool(toolName: unknown): boolean {
  return (
    typeof toolName === "string" &&
    BACKGROUND_CAPABLE_SHELL_TOOL_NAMES.has(toolName.trim().toLowerCase())
  );
}

/**
 * True for a tool row that could own a background task, and is therefore worth
 * scanning for a launch id.
 *
 * An explicit `run_in_background` argument is the common case. A shell row is
 * the other one: Claude backgrounds a running command on Ctrl+B and on a
 * foreground timeout, neither of which can change the arguments the command
 * was launched with, so the argument alone cannot decide this.
 */
export function isBackgroundTaskLaunchCandidate(part: {
  toolName?: unknown;
  toolArgs?: unknown;
}): boolean {
  const args = part.toolArgs;
  const explicit =
    Boolean(args) &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    (args as Record<string, unknown>).run_in_background === true;
  return explicit || isBackgroundCapableShellTool(part.toolName);
}

/**
 * Recover the opaque background-task id a tool result reports, if any.
 *
 * Shared by the projection (which runs it before moving the result behind a
 * detail reference, since the renderer would otherwise never see the text) and
 * by the renderer itself (which still receives inline results from optimistic
 * and bridge-direct messages). One implementation so the two sides cannot
 * disagree about which rows own a task.
 */
export function recoverBackgroundTaskLaunchId(part: {
  toolName?: unknown;
  toolArgs?: unknown;
  toolOutput?: unknown;
}): string | undefined {
  const output = part.toolOutput;
  if (typeof output !== "string" || !output) return undefined;
  if (!isBackgroundTaskLaunchCandidate(part)) return undefined;

  const textMatch = output
    .slice(0, BACKGROUND_TASK_LAUNCH_SCAN_CHARS)
    .match(BACKGROUND_TASK_LAUNCH_ID_PATTERN);
  const textId = boundedBackgroundTaskId(textMatch?.[1]);
  if (textId) return textId;

  if (output.length > BACKGROUND_TASK_LAUNCH_SCAN_CHARS) return undefined;
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    return boundedBackgroundTaskId(record.backgroundTaskId ?? record.task_id ?? record.taskId);
  } catch {
    return undefined;
  }
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
  parentId?: string;
  branchLabel?: string;
}

export interface NativeAgentForkOutcome {
  sessionId: string;
  title?: string;
  /** Provider-selected editable prompt when a fork begins before a user entry. */
  draft?: string;
}

export interface NativeAgentSlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  source: NativeAgentSlashCommandSource;
  aliases?: string[];
  scope?: "global" | "session";
}

export type NativeAgentSlashCommandSource =
  | "builtin"
  | "project"
  | "user"
  | "plugin"
  | "skill"
  | "template"
  | "extension"
  | "orkestrator"
  | "unknown";

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
  /** False when the authoritative source has no older page it can serve. */
  canLoadEarlier?: boolean;
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
  parameterValues?: Record<string, string | boolean>;
  /** Persist the supplied selections where the provider supports defaults. */
  persistDefaults?: boolean;
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
  /** Authoritative provider admission state, when the bridge can report it. */
  readiness?: NativeAgentReadiness;
  capabilities: NativeAgentCapabilities;
  queue?: NativeAgentQueueSnapshot;
  /** Content-free durable delivery state for transcript-native async questions. */
  asyncQuestionResponses?: NativeAgentAsyncQuestionResponse[];
  contextUsage?: NativeAgentContextUsage;
  /** Backend-owned policy actually supplied to the provider session. */
  policy?: NativeAgentExecutionPolicy;
  /** Provider limits can arrive before the first token-usage snapshot. */
  rateLimits?: NativeAgentRateLimitWindow[];
  runtime?: NativeAgentRuntimeSummary;
  auth?: NativeAgentAuthStatus;
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

/** Current provider-neutral remote synchronization protocol. */
export const NATIVE_AGENT_SYNC_VERSION = 1 as const;

/** The fixed tail carried by the live synchronization surface. */
export interface NativeAgentLiveWindow {
  /** Maximum number of newest messages. */
  messages: number;
  /** Soft encoded-byte target. A single message may exceed it up to the hard limit. */
  targetBytes: number;
}

export const DEFAULT_NATIVE_AGENT_LIVE_WINDOW = {
  messages: 100,
  targetBytes: 512 * 1024,
} as const satisfies NativeAgentLiveWindow;
export const NATIVE_AGENT_SYNC_MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
export const NATIVE_AGENT_SYNC_MAX_PAGE_BYTES = 16 * 1024 * 1024 + 64 * 1024;

export type NativeAgentProjectionField =
  | "sessionId"
  | "title"
  | "shareUrl"
  | "cursor"
  | "messageWindow"
  | "composer"
  | "readiness"
  | "queue"
  | "asyncQuestionResponses"
  | "contextUsage"
  | "rateLimits"
  | "runtime"
  | "notices"
  | "recoverableDispatch"
  | "backgroundTasks"
  | "suggestedPrompt"
  | "completionBlockedByBackgroundTasks"
  | "turnBoundaries"
  | "slashCommands";

export interface NativeAgentProjectionDelta<TMessage = unknown> {
  messageUpserts: TMessage[];
  /** Present only when the ordered membership of the live tail changed. */
  liveMessageIds?: string[];
  /** Authoritative removals from the conversation, not ordinary tail eviction. */
  deletedMessageIds: string[];
  /** Complete replacements for changed non-message projection fields. */
  setFields: Partial<
    Omit<NativeAgentSessionProjection<TMessage>, "messages" | "revision" | "generation">
  >;
  /** Optional fields that ceased to exist. */
  unsetFields: NativeAgentProjectionField[];
  /** Target projection authority installed atomically with the operations. */
  revision: number;
  generation: string | number;
  cursor?: string;
}

export type NativeAgentProjectionUpdate<TMessage = unknown> =
  | {
      syncVersion: typeof NATIVE_AGENT_SYNC_VERSION;
      status: "snapshot";
      token: string;
      projection: NativeAgentSessionProjection<TMessage>;
      historyCursor?: string;
      historyEpoch: string;
      historyComplete: boolean;
      resetReason?: "initial" | "forced" | "unknown-token" | "expired" | "identity-changed";
    }
  | {
      syncVersion: typeof NATIVE_AGENT_SYNC_VERSION;
      status: "unchanged";
      token: string;
    }
  | {
      syncVersion: typeof NATIVE_AGENT_SYNC_VERSION;
      status: "delta";
      baseToken: string;
      token: string;
      delta: NativeAgentProjectionDelta<TMessage>;
      historyCursor?: string;
      historyEpoch: string;
      historyComplete: boolean;
    }
  | {
      syncVersion: typeof NATIVE_AGENT_SYNC_VERSION;
      status: "missing";
    };

export interface NativeAgentMessagePage<TMessage = unknown> {
  syncVersion: typeof NATIVE_AGENT_SYNC_VERSION;
  messages: TMessage[];
  historyEpoch: string;
  nextCursor?: string;
  /** False when the provider supplied only a bounded tail. */
  complete: boolean;
  truncated: boolean;
}

const PROJECTION_FIELD_SET: ReadonlySet<string> = new Set([
  "platform",
  "environmentId",
  "sessionId",
  "title",
  "shareUrl",
  "cursor",
  "connection",
  "turn",
  "messageWindow",
  "interactions",
  "composerControls",
  "composer",
  "readiness",
  "capabilities",
  "queue",
  "asyncQuestionResponses",
  "contextUsage",
  "rateLimits",
  "runtime",
  "notices",
  "recoverableDispatch",
  "backgroundTasks",
  "suggestedPrompt",
  "completionBlockedByBackgroundTasks",
  "turnBoundaries",
  "slashCommands",
]);
const OPTIONAL_PROJECTION_FIELD_SET: ReadonlySet<string> = new Set([
  "sessionId",
  "title",
  "shareUrl",
  "cursor",
  "messageWindow",
  "composer",
  "readiness",
  "queue",
  "asyncQuestionResponses",
  "contextUsage",
  "rateLimits",
  "runtime",
  "notices",
  "recoverableDispatch",
  "backgroundTasks",
  "suggestedPrompt",
  "completionBlockedByBackgroundTasks",
  "turnBoundaries",
  "slashCommands",
]);

export function isNativeAgentSessionProjection(
  value: unknown,
): value is NativeAgentSessionProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    !isAgentPlatform(candidate.platform) ||
    typeof candidate.environmentId !== "string" ||
    candidate.environmentId.length === 0 ||
    !Array.isArray(candidate.messages) ||
    candidate.messages.length > 4_096 ||
    !Array.isArray(candidate.interactions) ||
    !Array.isArray(candidate.composerControls) ||
    !candidate.capabilities ||
    typeof candidate.capabilities !== "object" ||
    !candidate.turn ||
    typeof candidate.turn !== "object" ||
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision as number) < 0 ||
    (typeof candidate.generation !== "string" &&
      !(typeof candidate.generation === "number" && Number.isSafeInteger(candidate.generation)))
  ) {
    return false;
  }
  const messageIds = new Set<string>();
  for (const message of candidate.messages) {
    const id = (message as { id?: unknown })?.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 4_096 || messageIds.has(id)) {
      return false;
    }
    messageIds.add(id);
  }
  return (
    candidate.connection === "connecting" ||
    candidate.connection === "connected" ||
    candidate.connection === "error"
  );
}

export function isNativeAgentProjectionUpdate(
  value: unknown,
): value is NativeAgentProjectionUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.syncVersion !== NATIVE_AGENT_SYNC_VERSION || typeof candidate.status !== "string") {
    return false;
  }
  if (candidate.status === "missing") return true;
  if (
    typeof candidate.token !== "string" ||
    candidate.token.length === 0 ||
    candidate.token.length > 1024
  ) {
    return false;
  }
  if (candidate.status === "unchanged") return true;
  if (candidate.status === "snapshot") {
    return Boolean(
      isNativeAgentSessionProjection(candidate.projection) &&
      typeof candidate.historyEpoch === "string" &&
      candidate.historyEpoch.length > 0 &&
      candidate.historyEpoch.length <= 128 &&
      typeof candidate.historyComplete === "boolean" &&
      (candidate.historyCursor === undefined ||
        (typeof candidate.historyCursor === "string" && candidate.historyCursor.length <= 1024)) &&
      (candidate.resetReason === undefined ||
        ["initial", "forced", "unknown-token", "expired", "identity-changed"].includes(
          candidate.resetReason as string,
        )),
    );
  }
  if (
    candidate.status !== "delta" ||
    typeof candidate.baseToken !== "string" ||
    candidate.baseToken.length === 0 ||
    candidate.baseToken.length > 1024 ||
    (candidate.historyCursor !== undefined &&
      (typeof candidate.historyCursor !== "string" || candidate.historyCursor.length > 1024))
  ) {
    return false;
  }
  const delta = candidate.delta as Record<string, unknown> | undefined;
  if (!delta || typeof delta !== "object") return false;
  if (
    !Array.isArray(delta.messageUpserts) ||
    !Array.isArray(delta.deletedMessageIds) ||
    !delta.setFields ||
    typeof delta.setFields !== "object" ||
    Array.isArray(delta.setFields) ||
    !Array.isArray(delta.unsetFields) ||
    delta.messageUpserts.length > 1024 ||
    delta.deletedMessageIds.length > 1024 ||
    delta.unsetFields.length > 64 ||
    (delta.liveMessageIds !== undefined && !Array.isArray(delta.liveMessageIds))
  ) {
    return false;
  }
  const operationCount =
    delta.messageUpserts.length +
    delta.deletedMessageIds.length +
    delta.unsetFields.length +
    (Array.isArray(delta.liveMessageIds) ? delta.liveMessageIds.length : 0) +
    Object.keys(delta.setFields as object).length;
  const upsertIds = delta.messageUpserts.map((message) => (message as { id?: unknown })?.id);
  const liveMessageIds = Array.isArray(delta.liveMessageIds) ? delta.liveMessageIds : [];
  if (
    upsertIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 4_096) ||
    new Set(upsertIds).size !== upsertIds.length ||
    delta.deletedMessageIds.some(
      (id) => typeof id !== "string" || id.length === 0 || id.length > 4_096,
    ) ||
    new Set(delta.deletedMessageIds).size !== delta.deletedMessageIds.length ||
    liveMessageIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 4_096) ||
    new Set(liveMessageIds).size !== liveMessageIds.length
  ) {
    return false;
  }
  return (
    typeof candidate.historyEpoch === "string" &&
    candidate.historyEpoch.length > 0 &&
    candidate.historyEpoch.length <= 128 &&
    typeof candidate.historyComplete === "boolean" &&
    operationCount <= 1024 &&
    Number.isSafeInteger(delta.revision) &&
    (delta.revision as number) >= 0 &&
    (typeof delta.generation === "string" || typeof delta.generation === "number") &&
    Object.keys(delta.setFields as object).length <= 64 &&
    Object.keys(delta.setFields as object).every((field) => PROJECTION_FIELD_SET.has(field)) &&
    delta.unsetFields.every(
      (field) => typeof field === "string" && OPTIONAL_PROJECTION_FIELD_SET.has(field),
    )
  );
}

export function isNativeAgentMessagePage(value: unknown): value is NativeAgentMessagePage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.syncVersion === NATIVE_AGENT_SYNC_VERSION &&
    Array.isArray(candidate.messages) &&
    candidate.messages.length <= 200 &&
    typeof candidate.historyEpoch === "string" &&
    candidate.historyEpoch.length > 0 &&
    candidate.historyEpoch.length <= 128 &&
    (candidate.nextCursor === undefined ||
      (typeof candidate.nextCursor === "string" && candidate.nextCursor.length <= 1024)) &&
    typeof candidate.complete === "boolean" &&
    typeof candidate.truncated === "boolean"
  ) {
    const ids = candidate.messages.map((message) => (message as { id?: unknown })?.id);
    return (
      ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 4_096) &&
      new Set(ids).size === ids.length
    );
  }
  return false;
}

/** Pure, fail-closed application of one exact-base projection delta. */
export function applyNativeAgentProjectionDelta<TMessage>(
  current: NativeAgentSessionProjection<TMessage>,
  delta: NativeAgentProjectionDelta<TMessage>,
): NativeAgentSessionProjection<TMessage> | null {
  const currentMessages = new Map<string, TMessage>();
  for (const message of current.messages) {
    const id = (message as { id?: unknown })?.id;
    if (typeof id !== "string" || currentMessages.has(id)) return null;
    currentMessages.set(id, message);
  }
  for (const id of delta.deletedMessageIds) {
    if (typeof id !== "string") return null;
    currentMessages.delete(id);
  }
  for (const message of delta.messageUpserts) {
    const id = (message as { id?: unknown })?.id;
    if (typeof id !== "string") return null;
    currentMessages.set(id, message);
  }
  const order =
    delta.liveMessageIds ?? current.messages.map((message) => (message as { id: string }).id);
  if (new Set(order).size !== order.length || order.some((id) => !currentMessages.has(id)))
    return null;
  // An upsert the resolved order never mentions has no defined position. Its
  // membership change is exactly what `liveMessageIds` exists to describe, so a
  // delta that omits it is ambiguous rather than empty — appending or dropping
  // would both invent an ordering the sender never sent. Fail closed and let
  // the caller recover from an authoritative snapshot.
  const ordered = new Set(order);
  for (const message of delta.messageUpserts) {
    if (!ordered.has((message as { id: string }).id)) return null;
  }
  const next = {
    ...current,
    ...delta.setFields,
    messages: order.map((id) => currentMessages.get(id)!),
    revision: delta.revision,
    generation: delta.generation,
    ...(delta.cursor === undefined ? {} : { cursor: delta.cursor }),
  } as NativeAgentSessionProjection<TMessage>;
  for (const field of delta.unsetFields) delete (next as unknown as Record<string, unknown>)[field];
  return next;
}
