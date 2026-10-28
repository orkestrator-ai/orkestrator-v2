import {
  AGENT_INTERACTION_KINDS,
  type AgentInteractionKind,
  type AgentInteractionRequest,
} from "./agent-interactions.js";
import { AGENT_PLATFORM_LABELS, isAgentPlatform, type AgentPlatform } from "./agent-platforms.js";
import {
  applyNativeAgentMessagePatch,
  isNativeAgentMessagePatchList,
  type NativeAgentMessagePatch,
} from "./native-agent-transcript-patch.js";
import {
  describeNativeAgentPolicyEffects,
  nativeAgentPolicyEffects,
} from "./native-agent-policy-effects.js";
import type {
  NativeAgentRuntimeSteerJournal,
  NativeAgentSteerRejectedOutcome,
} from "./native-agent-steer-rejection.js";

export * from "./native-agent-steer-rejection.js";
export * from "./native-agent-policy-effects.js";

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
 * Display label for a reasoning or effort id a provider reports without one.
 *
 * Every provider names the same levels (`minimal`, `low`, `high`, `xhigh`,
 * `max`, …), so labels come from this one vocabulary rather than each
 * catalogue: `xhigh` reads "Extra high"; any other id has separators turned
 * into spaces and its first letter capitalised ("max-thinking" → "Max thinking").
 */
export function reasoningOptionLabel(id: string): string {
  if (id === "xhigh") return "Extra high";
  return id.replace(/[-_]+/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
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

/**
 * Provider-neutral model catalog entry consumed by renderer presentation.
 *
 * Reasoning and speed stay first-class fields (`reasoning`,
 * `defaultReasoningId`, `supportsSpeed`) rather than moving onto
 * {@link AgentModelParameter} descriptors. Every provider has both axes, so
 * they are not provider-only controls, and they are read far beyond the
 * session composer: launch dialogs, Build and Multi Review stages, settings
 * defaults, the public API and coordinator launch defaults all pick an effort
 * and a speed before any session (and so any backend composer state) exists,
 * and they persist the choice as `reasoningId` / `fastMode`, not as a
 * parameter value. Each provider maps its own vocabulary onto them (OpenCode
 * variants and Grok effort onto `reasoning`; Cursor's `fast` parameter onto
 * `supportsSpeed`), and the renderer renders the two fields without branching
 * on which provider or axis it is. `parameters` carries the axes only some
 * providers have; those render generically and are filtered only through
 * {@link isSuppressedComposerParameter}.
 */
export interface AgentModel {
  platform: AgentPlatform;
  id: string;
  label: string;
  /** Provider label shown beneath the model name; defaults to the platform. */
  providerLabel?: string;
  description?: string;
  /** The model's reasoning/effort axis, shared by every provider. */
  reasoning?: AgentReasoningOption[];
  defaultReasoningId?: string;
  /** The model's speed (fast-mode) axis, shared by every provider. */
  supportsSpeed?: boolean;
  supportsMode?: boolean;
  /** Provider context-window size, used by the shared usage meter. */
  contextWindow?: number;
  /** False only when the provider explicitly says this model rejects images. */
  supportsImageInput?: boolean;
  /** Alternate provider ids which select this same model. */
  aliases?: string[];
  /** Concrete provider id behind a catalogue alias. */
  resolvedModel?: string;
  /** Provider-neutral, model-specific controls rendered by the shared composer. */
  parameters?: AgentModelParameter[];
  /**
   * False when the model's provider was reported as not connected the last
   * time it was checked, before any live report was available. The row stays
   * selectable because that report can be stale; a live catalogue omits such
   * models instead, and dispatch still checks the live report.
   */
  connected?: boolean;
  /**
   * True on the model a new session with no model chosen starts on, when a
   * saved or configured default chose it. Only Pi reports it today: its
   * tabs start on Pi's own saved default, which a ChatGPT-backed login needs
   * because the first catalogue model can be one it refuses. Launch defaults
   * prefer it over the first entry (`sessionDefaultModel` in `model-id.ts`).
   */
  sessionDefault?: boolean;
}

export interface AgentModelParameter {
  id: string;
  label: string;
  kind: "select" | "toggle";
  options?: Array<{ id: string; label: string; description?: string }>;
  defaultValue?: string | boolean;
  scope: "session" | "turn";
}

/**
 * A configured default model replaced, for one resolution, by one the runtime
 * can serve. The configuration itself is never rewritten.
 */
export interface NativeAgentModelSubstitution {
  /** The configured model the runtime reports it cannot currently serve. */
  requestedModelId: string;
  /** The model used instead. */
  modelId: string;
  /** User-facing explanation of the substitution. */
  message: string;
}

/** Bounded shape check for a persisted {@link NativeAgentModelSubstitution}. */
export function isNativeAgentModelSubstitution(
  value: unknown,
): value is NativeAgentModelSubstitution {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { requestedModelId, modelId, message } = value as Record<string, unknown>;
  const bounded = (field: unknown, max: number) =>
    typeof field === "string" && field.length > 0 && field.length <= max;
  return bounded(requestedModelId, 512) && bounded(modelId, 512) && bounded(message, 2048);
}

/** The model a runtime will actually use for a configured default, set or not. */
export interface NativeAgentDefaultModelResolution {
  /** Absent when the runtime has nothing to offer, which leaves its own default. */
  modelId?: string;
  /** Present when a configured model the runtime cannot serve was replaced. */
  substitution?: NativeAgentModelSubstitution;
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
 * A picker row for a `provider/model` id that is not yet in a live or cached
 * catalogue.
 *
 * The platform is explicit so a Pi or Cursor slash-id cannot be tagged as
 * OpenCode and then filtered out of a platform-locked picker.
 */
export function synthesizedNativeAgentModel(
  modelId: string,
  platform: AgentPlatform,
): AgentModel | null {
  const trimmed = modelId.trim();
  const providerId = openCodeModelProviderId(trimmed);
  const localId = openCodeModelLocalId(trimmed);
  if (!providerId || !localId) return null;
  return {
    platform,
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
 * A picker row for an OpenCode id that is not yet in a live or cached catalogue.
 *
 * Favourites and TUI recents have to be selectable before an OpenCode server
 * has listed models, otherwise they render as disabled placeholders whose
 * first line is the raw id and whose second line is the generic "OpenCode"
 * platform name.
 */
export function synthesizedOpenCodeAgentModel(modelId: string): AgentModel | null {
  return synthesizedNativeAgentModel(modelId, "opencode");
}

function nonBlankModelId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Host-authoritative composer model id.
 *
 * Catalog default and `models[0]` are last resorts. A stored or last-used id
 * must survive a connected-catalog refresh that temporarily omits it — that
 * refresh is what used to snap OpenCode sessions onto Nemotron Ultra Free.
 */
export function resolveNativeComposerModelId(input: {
  providerControlsModelId?: string;
  sessionControlsModelId?: string;
  lastAssistantModelId?: string;
  sessionModelId?: string;
  inferredModelId?: string;
  catalogDefaultModelId?: string;
  firstCatalogModelId?: string;
}): string | undefined {
  return (
    nonBlankModelId(input.providerControlsModelId) ??
    nonBlankModelId(input.sessionControlsModelId) ??
    nonBlankModelId(input.lastAssistantModelId) ??
    nonBlankModelId(input.sessionModelId) ??
    nonBlankModelId(input.inferredModelId) ??
    nonBlankModelId(input.catalogDefaultModelId) ??
    nonBlankModelId(input.firstCatalogModelId)
  );
}

/**
 * Resolve the picker row for a selected id without substituting another model.
 *
 * A known `provider/model` id that is missing from the live catalogue is
 * synthesized for the given platform. Synthesis never invents an OpenCode row
 * for another agent. An id that cannot be synthesized falls back to
 * `models[0]` so reasoning updates still have a catalogue row to validate.
 */
export function resolveNativeComposerSelectedModel(
  models: readonly AgentModel[],
  selectedModelId?: string,
  platform?: AgentPlatform,
): AgentModel | undefined {
  const id = nonBlankModelId(selectedModelId);
  if (id) {
    const found = models.find((model) => model.id === id);
    if (found) return found;
    if (platform) {
      const synthesized = synthesizedNativeAgentModel(id, platform);
      if (synthesized) return synthesized;
    }
    return models[0];
  }
  return models[0];
}

/** Include a synthesized current selection in the catalogue the picker renders. */
export function withResolvedNativeComposerModel(
  models: readonly AgentModel[],
  selectedModelId?: string,
  platform?: AgentPlatform,
): { models: AgentModel[]; selectedModel?: AgentModel; selectedModelId?: string } {
  const id = nonBlankModelId(selectedModelId);
  const selectedModel = resolveNativeComposerSelectedModel(models, id, platform);
  if (selectedModel) {
    return {
      models: models.some((model) => model.id === selectedModel.id)
        ? [...models]
        : [...models, selectedModel],
      selectedModel,
      selectedModelId: selectedModel.id,
    };
  }
  return {
    models: [...models],
    ...(id ? { selectedModelId: id } : {}),
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
 *
 * `signIn` names where the user signs in. An older bridge or backend omits it,
 * so the renderer falls back to reading the platform's auth status.
 */
export type NativeAgentReadiness =
  | { state: "ready" }
  | { state: "authentication-required"; message: string; signIn?: NativeAgentSignInRoute };

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
  /** The provider's own approval modes, capped by the session's execution policy. */
  approvalModes?: NativeAgentApprovalModeOption[];
  selectedApprovalModeId?: string;
  /**
   * Set when the *current* combination of model, reasoning, speed and
   * parameters bills above the provider's standard rate. Computed by the
   * bridge from its provider's own rule and recomputed on every publication;
   * absent means standard or unknown, never premium.
   */
  selectionPricing?: NativeAgentSelectionPricing;
}

/**
 * Whether a selection or a run billed at the provider's standard rate or a
 * premium one (Cursor Max mode, Claude long-context pricing, Codex priority
 * credit rates). Provider-neutral: the provider's own name for it belongs in
 * {@link NativeAgentSelectionPricing.label}.
 */
export type NativeAgentPricingTier = "standard" | "premium";

/**
 * A premium-rate selection, described for display. Attached to the composer
 * rather than to a parameter option because it is usually a property of the
 * combination (Cursor: every catalogue variant matching the chosen parameters
 * is Max mode), not of any one value.
 */
export interface NativeAgentSelectionPricing {
  tier: "premium";
  /** Short provider-supplied badge text, e.g. "Max mode". */
  label: string;
  /** One sentence on why the selection is premium, for a tooltip. */
  description?: string;
}

export function isNativeAgentPricingTier(value: unknown): value is NativeAgentPricingTier {
  return value === "standard" || value === "premium";
}

/**
 * Read a bridge's `selectionPricing` defensively. Bridge payloads are
 * untrusted, so anything other than a premium tier with a non-blank label is
 * dropped and the text is bounded.
 */
export function normalizeNativeAgentSelectionPricing(
  value: unknown,
): NativeAgentSelectionPricing | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.tier !== "premium" || typeof record.label !== "string") return undefined;
  const label = record.label.trim().slice(0, 64);
  if (!label) return undefined;
  const description =
    typeof record.description === "string" ? record.description.trim().slice(0, 512) : "";
  return { tier: "premium", label, ...(description ? { description } : {}) };
}

/**
 * How much an approval mode lets the agent do before it asks.
 *
 * Ordered from most to least supervised. The renderer picks each option's
 * icon from it, and the execution policy caps a session by it, so a provider
 * mode is placed by what it does rather than by what its SDK calls it.
 */
export const NATIVE_AGENT_APPROVAL_MODE_KINDS = [
  "ask",
  "auto-edits",
  "auto-review",
  "auto-approve",
] as const;
export type NativeAgentApprovalModeKind = (typeof NATIVE_AGENT_APPROVAL_MODE_KINDS)[number];

export interface NativeAgentApprovalModeOption {
  /** The SDK's own value, forwarded to the bridge unchanged. */
  id: string;
  label: string;
  description: string;
  kind: NativeAgentApprovalModeKind;
  /** Set when the session's execution policy does not allow this mode. */
  disabled?: boolean;
}

/**
 * Approval modes each SDK offers, in its own vocabulary.
 *
 * Claude's are `permissionMode` values; `plan` lives on the build/plan axis and
 * `dontAsk` is the read-only turn's mode, so neither is offered here. Codex's
 * are `approvalPolicy` values, plus `auto-review`: `on-request` with approvals
 * routed to Codex's reviewer agent rather than to the user.
 */
const NATIVE_AGENT_APPROVAL_MODES: Readonly<
  Partial<Record<AgentPlatform, readonly NativeAgentApprovalModeOption[]>>
> = Object.freeze({
  claude: [
    {
      id: "default",
      label: "Ask",
      description: "Ask before editing files or running commands",
      kind: "ask",
    },
    {
      id: "acceptEdits",
      label: "Accept edits",
      description: "Apply file edits without asking; ask before running commands",
      kind: "auto-edits",
    },
    {
      id: "auto",
      label: "Auto",
      description: "A model reviews each action, approving safe ones and blocking risky ones",
      kind: "auto-review",
    },
    {
      id: "bypassPermissions",
      label: "Bypass",
      description: "Approve everything without asking",
      kind: "auto-approve",
    },
  ],
  codex: [
    {
      id: "untrusted",
      label: "Untrusted",
      description: "Ask before running any command Codex does not trust",
      kind: "ask",
    },
    {
      id: "on-request",
      label: "On request",
      description: "Work in a sandbox; Codex asks before stepping outside it",
      kind: "ask",
    },
    {
      id: "auto-review",
      label: "Auto review",
      description: "Work in a sandbox; a reviewer agent decides when Codex may step outside it",
      kind: "auto-review",
    },
    {
      id: "never",
      label: "Full access",
      description: "Never ask; run everything",
      kind: "auto-approve",
    },
  ],
});

/**
 * What Codex's sandbox-edge modes do in a container, where the vendor sandbox
 * is off on purpose and there is no edge to ask at. Under an `ask` policy the
 * bridge runs `on-request` as `untrusted` so the policy still holds
 * (`codexApprovalConfig`); under `auto-approve` the pick is the user's own
 * narrowing and runs as Codex defines it, which never asks there. The text
 * says so rather than quietly turning one mode into another the picker
 * already offers.
 */
const CODEX_CONTAINER_APPROVAL_DESCRIPTIONS: Readonly<
  Record<"ask" | "auto-approve", Readonly<Record<string, string>>>
> = Object.freeze({
  ask: {
    "on-request":
      "Codex has no sandbox of its own in a container, so this asks before any command Codex does not trust, like Untrusted",
  },
  "auto-approve": {
    "on-request":
      "Codex has no sandbox of its own in a container, so this never asks; choose Untrusted to approve commands",
    "auto-review":
      "Codex has no sandbox of its own in a container, so the reviewer is never consulted and everything runs",
  },
});

/**
 * The approval modes a session can choose from, or none when its policy leaves
 * no choice. `deny` already refuses everything, and an `ask` policy keeps a
 * person in the loop, so only the asking modes stay selectable under it. A
 * Codex session in a container describes the modes that only ask at a sandbox
 * edge as what they do there.
 */
export function nativeAgentApprovalModes(
  agent: AgentPlatform,
  policy:
    | (Pick<NativeAgentExecutionPolicy, "approvals"> &
        Partial<Pick<NativeAgentExecutionPolicy, "sandbox">>)
    | undefined,
): NativeAgentApprovalModeOption[] {
  const modes = NATIVE_AGENT_APPROVAL_MODES[agent];
  if (!modes || policy?.approvals === "deny") return [];
  const containerDescriptions =
    agent === "codex" && policy?.sandbox === "container"
      ? CODEX_CONTAINER_APPROVAL_DESCRIPTIONS[policy.approvals === "ask" ? "ask" : "auto-approve"]
      : undefined;
  return modes.map((mode) => {
    const description = containerDescriptions?.[mode.id] ?? mode.description;
    return policy?.approvals === "ask" && mode.kind !== "ask"
      ? { ...mode, description, disabled: true }
      : { ...mode, description };
  });
}

/**
 * The mode a session runs in until someone picks one: what the policy alone
 * implied before approval modes were selectable, so nothing changes for a
 * session that never touches the control.
 */
export function defaultNativeAgentApprovalMode(
  agent: AgentPlatform,
  policy: Pick<NativeAgentExecutionPolicy, "approvals"> | undefined,
): string | undefined {
  const modes = nativeAgentApprovalModes(agent, policy);
  if (modes.length === 0) return undefined;
  if (agent === "claude") return policy?.approvals === "ask" ? "default" : "bypassPermissions";
  if (agent === "codex") return policy?.approvals === "ask" ? "on-request" : "never";
  return modes.find((mode) => !mode.disabled)?.id;
}

/** The selectable mode `requested` names, or the policy's default. */
export function resolveNativeAgentApprovalMode(
  agent: AgentPlatform,
  policy: Pick<NativeAgentExecutionPolicy, "approvals"> | undefined,
  requested: string | undefined,
): string | undefined {
  const selectable = nativeAgentApprovalModes(agent, policy).some(
    (mode) => mode.id === requested && !mode.disabled,
  );
  return selectable ? requested : defaultNativeAgentApprovalMode(agent, policy);
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
 * The `kind` a bridge puts on its refusal of a prompt request id that an
 * earlier bridge process recorded and never confirmed. The bridge cannot tell
 * whether that turn ran, and will never run the id again.
 */
export const DISPATCH_OUTCOME_LOST_KIND = "dispatch-outcome-lost";

/**
 * What `GET /session/:id/dispatch?requestId=` answers.
 *
 * `dispatched` is an explicit positive from the bridge's own dispatch journal.
 * `lost` is the read-only twin of the prompt route's 410
 * {@link DISPATCH_OUTCOME_LOST_KIND}: an earlier bridge process recorded the id
 * and this one cannot tell whether its turn ran, so it will refuse the id for
 * good. `absent` is the only negative, and an assertion like the other two:
 * the bridge can prove this id never reached it and that a prompt sent under
 * it now would be its first delivery. A bridge answers it only while its
 * journal is complete for the session (loaded cleanly, written before every
 * handover, nothing evicted or skipped since the session began). Everything
 * else is `unknown`. Older bridges never answer `lost` or `absent`, and an
 * older backend reads `absent` as `unknown`.
 */
export type BridgePromptDispatchStatus = "dispatched" | "unknown" | "lost" | "absent";

/** How long a retired dispatch stays visible on its native agent session. */
export const NATIVE_AGENT_RETIRED_DISPATCH_TTL_MS = 24 * 60 * 60 * 1000;

/** What the user is told when a bridge can no longer say whether a prompt ran. */
export function dispatchOutcomeLostMessage(platform: AgentPlatform): string {
  return `${AGENT_PLATFORM_LABELS[platform] ?? platform} could not confirm this message, so it may not have run. Check the conversation and send it again if it did not.`;
}

/** Notice identity for a retired dispatch, so a dismissal sticks to that request. */
export function dispatchOutcomeLostOccurrenceId(requestId: string): string {
  return `${DISPATCH_OUTCOME_LOST_KIND}:${requestId}`;
}

/**
 * A parked dispatch the backend resolved on its own because the provider
 * reported its outcome lost (`BridgePromptDispatchStatus` `lost`). Content-free
 * apart from the fixed {@link dispatchOutcomeLostMessage}. A renderer whose
 * draft still holds `requestId` drops that id, keeps the text and shows
 * `message`, exactly as for a retry answered with `requestIdRetired`.
 */
export interface NativeAgentRetiredDispatch {
  requestId: string;
  retiredAt: string;
  message: string;
}

/**
 * A dispatch may have reached the provider even when its HTTP response was
 * lost. Callers must reconcile `unknown`; they must never retry it blindly.
 */
export type NativeAgentDispatchOutcome =
  | { outcome: "accepted"; requestId: string }
  | {
      outcome: "rejected";
      error: string;
      /**
       * The provider recorded this request id before a bridge restart and
       * cannot say whether it ran, so it will refuse the id from now on. Any
       * parked record for it is cleared; the draft needs a new id to run it.
       */
      requestIdRetired?: true;
    }
  | {
      outcome: "unknown";
      requestId: string;
      error?: string;
      /**
       * Where the ambiguity was observed. `transport` means the dispatch call
       * itself failed before it reached the backend's durable bookkeeping, so
       * no recoverable record was created and the caller must surface the
       * failure instead of waiting for a card that will never arrive. Absent
       * (or `provider`) means the backend parked a recoverable dispatch.
       */
      origin?: "provider" | "transport";
    };

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
  /**
   * `reconciling` while the backend may still confirm the dispatch against the
   * provider's own journal, so the record is not yet a choice the user has to
   * make. `action-required` once that reconciliation window has elapsed, when
   * only retry or discard can resolve it. Absent means the backend predates
   * this field, where every recoverable dispatch expected a decision.
   */
  status?: "reconciling" | "action-required";
}

export type NativeAgentTurnPhase =
  "idle" | "running" | "blocked" | "cancelling" | "recovering" | "error";

/**
 * What the provider reports it is doing inside a running turn, when that is
 * not visible from the transcript. Advisory: it refines the running indicator
 * and never decides the phase.
 */
export interface NativeAgentTurnActivity {
  /** The provider is compacting the conversation's context. */
  compacting?: boolean;
  /**
   * Running estimate of tokens spent in the current thinking block. An
   * approximation for progress display, not billed usage.
   */
  thinkingTokens?: number;
}

export interface NativeAgentTurnState {
  phase: NativeAgentTurnPhase;
  startedAt?: number;
  error?: string;
  /** Present only while the turn is running and the provider reported one. */
  activity?: NativeAgentTurnActivity;
  /**
   * The backend announces every change to this session's idle view: activity
   * transitions and, for a provider whose idle view can change without one
   * (Claude background tasks, Codex async questions), content revisions from
   * the provider's no-touch activity read. Set only while the provider
   * reports those revisions, so a view of an older bridge keeps its baseline
   * cadence. See `NATIVE_QUIET_BACKOFF_CONTENT_REVISION_PLATFORMS`.
   */
  quietObservation?: true;
}

/**
 * Normalize a provider's turn activity, or `undefined` when it says nothing.
 * Shared by every backend read so the full and progressive projections agree.
 */
export function normalizeNativeAgentTurnActivity(value: {
  compacting?: unknown;
  thinkingTokens?: unknown;
}): NativeAgentTurnActivity | undefined {
  const compacting = value.compacting === true;
  // Quantized: the estimate moves on every thinking delta, and each distinct
  // value is a new projection revision. The indicator shows it approximately.
  const step = typeof value.thinkingTokens === "number" && value.thinkingTokens >= 1_000 ? 100 : 10;
  const thinkingTokens =
    typeof value.thinkingTokens === "number" &&
    Number.isFinite(value.thinkingTokens) &&
    value.thinkingTokens > 0
      ? Math.max(step, Math.round(value.thinkingTokens / step) * step)
      : undefined;
  if (!compacting && thinkingTokens === undefined) return undefined;
  return {
    ...(compacting ? { compacting } : {}),
    ...(thinkingTokens === undefined ? {} : { thinkingTokens }),
  };
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

/**
 * Parameter controls a provider surfaces in its model catalogue but that the
 * compact input bar must not show.
 *
 * Claude's thinking and context choices are settings-backed session defaults,
 * and Cursor's variant is a retired pre-combined parameter cross product. An
 * entry needs a descriptor that actually produces it: a suppression for a
 * control nothing advertises is removed rather than kept "just in case".
 *
 * This table is the single definition of that policy. Every projection path
 * and every renderer filters through {@link isSuppressedComposerParameter} so
 * the two cannot drift apart; a control suppressed on one read must not
 * reappear on another.
 */
export const SUPPRESSED_COMPOSER_PARAMETERS: Readonly<
  Partial<Record<AgentPlatform, readonly string[]>>
> = Object.freeze({
  claude: Object.freeze(["parameter:thinking", "parameter:context1m"]),
  cursor: Object.freeze(["parameter:variant"]),
});

/** True when `controlId` must be hidden for `platform`. */
export function isSuppressedComposerParameter(platform: string, controlId: string): boolean {
  return SUPPRESSED_COMPOSER_PARAMETERS[platform as AgentPlatform]?.includes(controlId) === true;
}

/** Drop every control {@link isSuppressedComposerParameter} rejects. */
export function withoutSuppressedComposerControls<TControl extends { readonly id: string }>(
  platform: string,
  controls: readonly TControl[],
): TControl[] {
  return controls.filter((control) => !isSuppressedComposerParameter(platform, control.id));
}

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
    /**
     * Where a prompt's plan/build mode applies. `turn`: the mode rides on one
     * prompt and the next prompt chooses its own. `session`: sending a mode
     * changes the session's persisted mode, so backend-authored prompts must
     * not send one unless it equals the session's current mode.
     */
    modeScope?: "turn" | "session";
    executionProfile?: boolean;
    localSettings?: boolean;
    promptSuggestions?: boolean;
  };
  /**
   * Environment-owned sessions of this platform receive the per-tab agent
   * tools credential (agent tools MCP server) with each dispatch.
   */
  agentTools?: boolean;
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
    /**
     * A conversation can be taken out of the resume list and put back
     * (Codex `thread/archive` / `thread/unarchive`). Archive keeps the
     * provider's history; it is never a delete.
     */
    archive?: boolean;
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
    // Every bridge-backed platform takes the per-tab agent tools credential;
    // OpenCode's SDK path does not (see its override below).
    agentTools: true,
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
      // Cursor applies a prompt's mode as a composer patch and Grok through ACP
      // `session/set_mode`: both persist on the session.
      composer: { ...capabilities.composer, modeScope: "session" },
      // `speed` and `mode` stay true because both agents really do own them:
      // Cursor drives fast through a `model_config` config option, Grok through
      // a sibling `…-fast` model id, and both announce session modes. They are
      // per-build, not per-platform, so the flag means "this platform may offer
      // it" and the live composer's `fastModeAvailable` / `modes` decides.
      // Grok compacts through its own `/compact`, which the ACP bridge runs as
      // a selected command; a session whose live inventory lacks it answers
      // the action 422 `command-unavailable`.
      actions: agent === "cursor" ? { steer: true, rewindMessages: true } : { compact: true },
      // Cursor's SDK exposes no approval hook at all, so a Cursor tab never
      // raises anything. Grok's ACP wire does: it answers
      // `session/request_permission` for tool calls. Reporting the empty set
      // rather than omitting the field lets the renderer say "this agent does
      // not ask" instead of showing a list that looks like it is still loading.
      interactions: {
        kinds:
          agent === "cursor"
            ? []
            : ["question", "plan-approval", "command-approval", "file-approval", "permission"],
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
        // Claude's permission mode rides on each prompt request.
        modeScope: "turn",
      },
      actions: { compact: true, rewindFiles: true, steer: true },
      // Questions through `AskUserQuestion`, plan approvals through
      // `ExitPlanMode`, tool approvals through `canUseTool` (raised only
      // under an `ask` execution policy), and MCP elicitations through
      // `onElicitation`. Host dialogs are not offered: the bridge declares no
      // `supportedDialogKinds`, so the CLI never sends one.
      interactions: {
        kinds: [
          "question",
          "plan-approval",
          "command-approval",
          "file-approval",
          "permission",
          "mcp-form",
          "mcp-url",
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
      agentTools: false,
      // No `share`: OpenCode 1.19.1 discontinued session sharing upstream.
      actions: { compact: true, undo: true, redo: true },
      // `permission.asked` and the v2-only `question.asked`. No MCP
      // elicitation surface on the v1 wire this repo uses. Every OpenCode
      // permission, a bash or edit approval included, is mapped as
      // `permission` (`opencode-interactions.ts`), so the command and file
      // kinds are not claimed.
      interactions: { kinds: ["question", "permission"] },
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
      // Pi asks only under an `ask` execution policy, so this is what the
      // platform *may* raise. The live session reports the empty set under any
      // other policy — see `publicInteractionKinds` in the bridge.
      interactions: { kinds: ["command-approval", "file-approval"] },
    };
  }
  return {
    ...capabilities,
    attachments: { files: false, images: true },
    // Codex binds its collaboration mode to the thread and persists it.
    composer: { ...capabilities.composer, modeScope: "session" },
    actions: { compact: true, steer: true, review: true, rewindMessages: true, archive: true },
    // Codex: questions (`request_user_input`), MCP elicitations in both form
    // and url modes, and command/file approvals through
    // `item/permissions/requestApproval`. Every turn runs in Codex's Default
    // collaboration mode, which refuses `request_user_input` unless the
    // thread turns on `default_mode_request_user_input`; the bridge does for
    // every session someone watches (`codexRequestUserInputConfig`), never for
    // a pipeline.
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

/**
 * `rejected` is only ever a verified, definitive steer refusal for the same
 * request id (see `native-agent-steer-rejection.ts`); ambiguity stays `unknown`.
 */
export type NativeAgentSessionActionOutcome =
  | {
      outcome: "applied" | "idle" | "mismatch" | "unknown";
      shareUrl?: string;
      preview?: unknown;
      requestId?: string;
    }
  | NativeAgentSteerRejectedOutcome;

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

/**
 * Id prefix of an inline error row in a native-agent transcript. The renderer
 * styles a message whose id starts with this as an error alert rather than an
 * assistant reply, and treats it as display-only.
 */
export const NATIVE_INLINE_ERROR_MESSAGE_ID_PREFIX = "error-";

/**
 * Id of a durable inline error row a provider writes into its own transcript
 * for a failed message: `error-<source>-<messageId>`. The source segment keeps
 * provider rows apart from the renderer's own `error-` rows. Persisted and
 * rendered ids depend on this shape, so it must not change.
 */
export function providerInlineErrorMessageId(source: string, messageId: string): string {
  return `${NATIVE_INLINE_ERROR_MESSAGE_ID_PREFIX}${source}-${messageId}`;
}

/** Whether a transcript row is an inline error row (see the prefix above). */
export function isNativeInlineErrorMessageId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith(NATIVE_INLINE_ERROR_MESSAGE_ID_PREFIX);
}

export interface NativeAgentAsyncQuestionResponse {
  itemId: string;
  requestId: string;
  state: "queued" | "dispatching" | "sent" | "failed";
}

/**
 * Provider-neutral names for rows of a context-window breakdown. A bridge maps
 * its provider's own row ids onto these; a row it cannot place carries no id,
 * and readers then fall back to the provider's display `name`. `reserved` is
 * the compaction reserve; the `deferred-` rows are tool schemas the provider
 * holds outside the window, so they do not count toward its use.
 */
export const NATIVE_AGENT_CONTEXT_CATEGORY_IDS = [
  "system-prompt",
  "tools",
  "deferred-tools",
  "mcp-tools",
  "deferred-mcp-tools",
  "mcp-instructions",
  "agents",
  "memory",
  "skills",
  "messages",
  "reserved",
  "free-space",
] as const;

export type NativeAgentContextCategoryId = (typeof NATIVE_AGENT_CONTEXT_CATEGORY_IDS)[number];

export function isNativeAgentContextCategoryId(
  value: unknown,
): value is NativeAgentContextCategoryId {
  return (NATIVE_AGENT_CONTEXT_CATEGORY_IDS as readonly unknown[]).includes(value);
}

export interface NativeAgentContextCategory {
  /** Stable row identity; match on this, never on the English `name`. */
  id?: NativeAgentContextCategoryId;
  name: string;
  tokens: number;
  color?: string;
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
  contextCategories?: NativeAgentContextCategory[];
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
  /**
   * When the bridge finalized this turn, ISO-8601.
   *
   * Providers republish their recent turns on every usage read, and several
   * bridges restore them across a restart, so the moment a consumer first sees
   * a turn can be long after it ran. Anything bucketing usage by time has to
   * read this rather than its own clock. A bridge that cannot date a turn
   * leaves it unset.
   */
  at?: string;
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
  /** The rate the provider says this run actually billed at; absent when unreported. */
  pricingTier?: NativeAgentPricingTier;
}

export interface NativeAgentAccountUsageWindow {
  window: string;
  label?: string;
  /** Provider-reported token consumption for this account window. */
  tokens?: number;
  usedPercent?: number;
  resetsAt?: string;
  /** Length of the quota period, used to place the current-time marker. */
  windowMinutes?: number;
  spendUsd?: number;
  creditsRemaining?: number;
  /** Provider-formatted balance when credits are not a plain numeric count. */
  creditBalance?: string;
  limitUsd?: number;
}

export type NativeAgentExecutionPolicyId =
  "interactive-host" | "interactive-container" | "coordinator-read-only" | "pipeline";

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
  "web.search",
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
  /**
   * Provider-neutral denials each bridge translates into its own tool names.
   *
   * `allow` carves an exception out of a broader denial and is never a grant on
   * its own. Today the only exception is `web.search` under a `network`
   * denial: hosted search stays available while commands, hosted page fetches
   * and every other route to the internet stay off. A bridge that predates
   * `allow` ignores it and keeps search off, which is the safe direction.
   */
  capabilityPolicy?: { deny: NativeAgentCapability[]; allow?: NativeAgentCapability[] };
  networkAccess: "restricted" | "full";
  /** Outer firewall retained when an optional provider sandbox runs in a container. */
  containerNetworkAccess?: "restricted" | "full";
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
    (policy.containerNetworkAccess === undefined ||
      policy.containerNetworkAccess === "restricted" ||
      policy.containerNetworkAccess === "full") &&
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
        capabilityPolicy.deny.every(isNativeAgentCapability) &&
        (capabilityPolicy.allow === undefined ||
          (Array.isArray(capabilityPolicy.allow) &&
            capabilityPolicy.allow.every(isNativeAgentCapability)))))
  );
}

/**
 * Whether a policy denies the agent the network outright.
 *
 * Stronger than `networkAccess: "restricted"`, which only narrows what a
 * sandboxed command may reach: a denied network also takes away the
 * provider-hosted tools that reach the internet without running a command on
 * this machine (web fetch, and web search unless `allow` names it). Those run
 * on the vendor's servers, so no sandbox or firewall here can stop them; each
 * bridge has to remove them from the agent's toolset.
 */
export function nativeAgentPolicyDeniesNetwork(
  policy: NativeAgentExecutionPolicy | undefined,
): boolean {
  return policy?.capabilityPolicy?.deny.includes("network") === true;
}

/**
 * Whether a policy takes hosted web search away.
 *
 * Search is denied by name, or by a `network` denial that does not list
 * `web.search` in `allow`. Hosted page fetches have no exception: under a
 * `network` denial they are always off, because a fetched URL can carry data
 * out to whoever owns the page.
 */
export function nativeAgentPolicyDeniesWebSearch(
  policy: NativeAgentExecutionPolicy | undefined,
): boolean {
  const capabilities = policy?.capabilityPolicy;
  if (!capabilities) return false;
  if (capabilities.deny.includes("web.search")) return true;
  return capabilities.deny.includes("network") && !capabilities.allow?.includes("web.search");
}

/**
 * Stable, provider-neutral copy for the agent information panel, rendered from
 * the policy's effects so the conformance suite can hold every adapter to it.
 */
export function describeNativeAgentExecutionPolicy(policy: NativeAgentExecutionPolicy): string {
  return describeNativeAgentPolicyEffects(nativeAgentPolicyEffects(policy));
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
  /** Stable identity for one currently authoritative runtime condition. */
  id?: string;
  /** Short provider-owned object name, such as the MCP server that failed. */
  subject?: string;
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
  /** Steer-history occupancy, counts and limits only (Cursor today). */
  steer?: NativeAgentRuntimeSteerJournal;
}

export type NativeAgentMcpServerAction = "reconnect" | "enable" | "disable" | "sign-in";

export interface NativeAgentMcpServer {
  id: string;
  name: string;
  status: "connected" | "connecting" | "failed" | "needs-auth" | "disabled" | "unknown";
  scope?: "user" | "project" | "local" | "orkestrator" | "plugin";
  transport?: "stdio" | "sse" | "http";
  toolCount?: number;
  tools?: string[];
  /** Provider error text, redacted and bounded by the adapter. */
  error?: string;
  /**
   * What the user can do outside Orkestrator about this server's state, when
   * no action here can (OpenCode's MCP sign-in). Short, user-facing, never a
   * credential.
   */
  hint?: string;
  actions: NativeAgentMcpServerAction[];
}

/**
 * OpenCode completes an MCP OAuth sign-in only when the request that started
 * it waits for the browser's callback (`mcp.auth.authenticate`, or the CLI's
 * `opencode mcp auth`). A sign-in started with `mcp.auth.start` alone has no
 * waiter, and OpenCode's callback server (127.0.0.1:19876 by default) refuses
 * the browser's redirect as an unknown state (traced in OpenCode 1.19.4). The
 * CLI runs the whole flow and stores the token where the server reads it.
 */
export const OPENCODE_MCP_SIGN_IN_GUIDANCE =
  "Sign in from a terminal where this environment's OpenCode runs: opencode mcp auth <server>, then reconnect the server.";

export type NativeAgentAuthState =
  "signed-in" | "signed-out" | "needs-auth" | "expired" | "unknown";

export const NATIVE_AGENT_SIGN_IN_KINDS = [
  "browser-url",
  "device-code",
  "terminal",
  "none",
] as const;

/**
 * How a platform is signed in to. `browser-url` and `device-code` run from the
 * tab (`beginSignIn`); `terminal` needs the platform's own CLI; `none` has no
 * flow Orkestrator can start. `hint` is short user-facing text naming the
 * route, never a credential.
 */
export interface NativeAgentSignInRoute {
  kind: (typeof NATIVE_AGENT_SIGN_IN_KINDS)[number];
  hint?: string;
}

export interface NativeAgentAuthStatus {
  state: NativeAgentAuthState;
  /**
   * Live login owned by this environment/provider's bridge; never log or persist to disk.
   * Null confirms no pending login; absent means the bridge predates this snapshot.
   */
  pendingSignIn?: NativeAgentPendingSignIn | null;
  account?: { label: string; plan?: string; expiresAt?: string };
  providers?: Array<{
    id: string;
    label: string;
    state: NativeAgentAuthState;
    method?: "api-key" | "oauth" | "subscription";
  }>;
  signIn?: NativeAgentSignInRoute;
  signOut?: boolean;
}

export interface NativeAgentPendingSignIn {
  url: string;
  code: string;
  expiresAt: number;
}

export const NATIVE_AGENT_PENDING_SIGN_IN_TTL_MS = 15 * 60_000;

/** Keep only the bounded, expiring display fields of a live device login. */
export function normalizePendingSignIn(
  value: unknown,
  now = Date.now(),
): NativeAgentPendingSignIn | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { url, code, expiresAt } = value as Record<string, unknown>;
  if (
    typeof url !== "string" ||
    url.length > 4096 ||
    typeof code !== "string" ||
    !code.trim() ||
    code.length > 512 ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + NATIVE_AGENT_PENDING_SIGN_IN_TTL_MS
  )
    return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  } catch {
    return undefined;
  }
  return { url, code, expiresAt };
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
   * Every background task card reads this as the start of its elapsed timer:
   * live cards tick from it, and settled ones freeze at the distance between it
   * and `settledAt`. The transcript row that launched the task supplies a
   * fallback clock, so omitting this degrades the timer rather than removing it
   * — except for a card the transcript cannot show at all, which has no row to
   * fall back to and reads this as its own header too.
   *
   * Unlike `settledAt` it says nothing about where the card belongs.
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
  /** Why a failed or killed task ended, as the provider or bridge reported it. */
  error?: string;
  /** The provider's one-line report from the task's terminal edge. */
  summary?: string;
  /**
   * Where the provider wrote the task's full output, on the backend host.
   *
   * A path, not content: the file lives outside the workspace, so the renderer
   * can point at it but not read it through the workspace file tools.
   */
  outputFile?: string;
  /** Latest usage the provider reported for the task. */
  usage?: NativeAgentBackgroundTaskUsage;
  /**
   * The role of the agent running this task, when the task is an agent: the
   * provider's own name for the agent type or profile (a built-in such as
   * `general-purpose`, or a user-defined agent's name).
   *
   * `main-session` is reserved for the conversation's own root agent moved to
   * the background, rather than a child it delegated to. Absent for tasks that
   * are not agents (shell commands) and for providers that do not report one.
   * Display text only: it is not an identifier and does not select behavior.
   */
  agentRole?: string;
  /** What sort of work the task is, when the provider says. */
  kind?: NativeAgentBackgroundTaskKind;
  /**
   * The task whose agent launched this one. Absent when the conversation's own
   * agent launched it, or the launcher is not itself a task. The parent may
   * have ended or fallen out of the snapshot, so an unknown id means no parent.
   */
  parentTaskId?: string;
  /** The prompt an agent or workflow task was started with. */
  prompt?: string;
  /**
   * The command a shell task runs. A shell launched by a delegated agent has
   * no row in this transcript, so this is the only place it is named.
   */
  command?: string;
  /** The last part of a shell task's output, when the provider reported it. */
  outputTail?: string;
  /** The workflow's own name, for a workflow task. */
  workflowName?: string;
  /** Housekeeping the provider asks hosts to keep out of the transcript. */
  ambient?: boolean;
  /** The tool the task's agent most recently ran. */
  lastToolName?: string;
  /** The provider's live one-line status for the task. */
  progressSummary?: string;
  /** Total time the task spent paused, in milliseconds. */
  pausedMs?: number;
  /**
   * Why the task ended other than by completing, failing or being stopped:
   * `process-restart` is a task orphaned when the provider process restarted.
   * `resume-cleanup` is a task from an earlier provider process that the
   * provider settled when resuming, which this session never saw run.
   */
  endReason?: "process-restart" | "resume-cleanup";
}

export type NativeAgentBackgroundTaskKind =
  "shell" | "agent" | "workflow" | "remote-agent" | "mcp" | "teammate" | "other";

export interface NativeAgentBackgroundTaskUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
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
  /** Source composer selection to persist when adopting the new session. */
  controls?: NativeAgentControlUpdate;
  title?: string;
  /** Provider-selected editable prompt when a fork begins before a user entry. */
  draft?: string;
}

/**
 * One command a composer can offer.
 *
 * The first six fields are the legacy display record every client understands.
 * The rest are the additive execution descriptor (catalogue version 1): they
 * say *how* the command runs, not just what it is called. A descriptor without
 * an `id` came from a legacy source and carries no execution authority of its
 * own — see `agent-command-catalogue.ts`.
 */
export interface NativeAgentSlashCommand {
  /** Display name, preserving the provider's spelling and namespace. */
  name: string;
  description?: string;
  argumentHint?: string;
  /** Provenance category used for picker grouping; `unknown` stays unknown. */
  source: NativeAgentSlashCommandSource;
  /** Alternative spellings that resolve to this same binding. */
  aliases?: string[];
  /** Lifetime of the row, never ownership. See {@link origin} for that. */
  scope?: "global" | "session";
  /**
   * Opaque identity within one provider/environment/session authority.
   * Stable across description edits and row reordering. A lookup key, never a
   * permission grant: the executor revalidates it against its own registry.
   */
  id?: string;
  /** Exact text a picker inserts; `$name` for a Codex skill. Defaults to `name`. */
  insertText?: string;
  executionKind?: NativeAgentCommandExecutionKind;
  /** Verified ownership, when the provider actually reports it. */
  origin?: NativeAgentCommandOrigin;
  availability?: NativeAgentCommandAvailability;
  inputPolicy?: NativeAgentCommandInputPolicy;
  /**
   * Changes when the command's execution meaning changes (a different skill
   * path, template file or provider command), never for presentation edits.
   * A selection made against one revision is refused against another.
   */
  bindingRevision?: string;
  /** True when the provider distinguishes spellings that differ only in case. */
  caseSensitive?: boolean;
}

/**
 * How an enabled command executes. A closed set: each value names a routing
 * path the executor implements, never arbitrary code.
 *
 * - `provider-prompt`: canonical text through the provider's prompt transport
 *   (Claude SDK query, ACP `session/prompt`, Pi `session.prompt`).
 * - `provider-command`: a separate provider command API (OpenCode
 *   `session.command`).
 * - `structured-skill`: an explicit structured skill input (Codex app-server).
 * - `bridge-template`: an Orkestrator-owned compatibility template the bridge
 *   expands before dispatch (Codex prompt files).
 * - `bridge-local`: answered by the bridge without a model turn (Codex `/help`).
 * - `session-action`: an Orkestrator runtime action (`/steer`, `/compact`).
 */
export const NATIVE_AGENT_COMMAND_EXECUTION_KINDS = [
  "provider-prompt",
  "provider-command",
  "structured-skill",
  "bridge-template",
  "bridge-local",
  "session-action",
] as const;
export type NativeAgentCommandExecutionKind = (typeof NATIVE_AGENT_COMMAND_EXECUTION_KINDS)[number];

export const NATIVE_AGENT_COMMAND_ORIGINS = [
  "project",
  "user",
  "system",
  "admin",
  "plugin",
  "orkestrator",
  "unknown",
] as const;
export type NativeAgentCommandOrigin = (typeof NATIVE_AGENT_COMMAND_ORIGINS)[number];

/** Bounded, allowlisted reasons a listed command cannot run. */
export const NATIVE_AGENT_COMMAND_UNAVAILABLE_REASONS = [
  "disabled",
  "shadowed",
  "reserved-name",
  "ambiguous",
  "requires-interactive-ui",
  "requires-shell-execution",
  "session-changing",
  "unqualified",
  "unsupported",
  "update-required",
] as const;
export type NativeAgentCommandUnavailableReason =
  (typeof NATIVE_AGENT_COMMAND_UNAVAILABLE_REASONS)[number];

export interface NativeAgentCommandAvailability {
  state: "available" | "unavailable";
  reason?: NativeAgentCommandUnavailableReason;
  /** Short, user-facing explanation. Never a raw provider error. */
  message?: string;
}

export interface NativeAgentCommandInputPolicy {
  /** Absent means optional. */
  arguments?: "none" | "optional" | "required";
  /** Absent means the provider's ordinary attachment support applies. */
  attachments?: "none" | "images" | "any";
  /**
   * When a command may run relative to the agent's turn.
   * `queue` waits behind a running turn like a prompt; `idle` refuses while
   * the agent is busy; `running` exists only relative to a live turn.
   */
  busy?: "queue" | "idle" | "running";
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
 * Whether a command list is authoritative, and how fresh it is.
 *
 * `ready` with an empty list is a real "this session has no commands";
 * `unsupported` is "this integration exposes no provider catalogue". Neither
 * may be produced by a failed read: failures are `unavailable` (nothing
 * retained) or `stale` (a previous list retained for display only).
 */
export const NATIVE_AGENT_COMMAND_CATALOGUE_STATUSES = [
  "loading",
  "ready",
  "stale",
  "unavailable",
  "unsupported",
] as const;
export type NativeAgentCommandCatalogueStatus =
  (typeof NATIVE_AGENT_COMMAND_CATALOGUE_STATUSES)[number];

/** What an explicit refresh actually did. Never claims a reload it did not do. */
export const NATIVE_AGENT_COMMAND_REFRESH_OUTCOMES = [
  "reloaded",
  "reread",
  "deferred",
  "unsupported",
  "failed",
] as const;
export type NativeAgentCommandRefreshOutcome =
  (typeof NATIVE_AGENT_COMMAND_REFRESH_OUTCOMES)[number];

export const NATIVE_AGENT_COMMAND_CATALOGUE_ERROR_CODES = [
  "timeout",
  "unreachable",
  "rejected",
  "malformed",
  "too-large",
  "provider-error",
  /** The bridge is older than catalogue version 1: its session route answered 404. */
  "outdated-bridge",
] as const;
export type NativeAgentCommandCatalogueErrorCode =
  (typeof NATIVE_AGENT_COMMAND_CATALOGUE_ERROR_CODES)[number];

export interface NativeAgentCommandCatalogueState {
  status: NativeAgentCommandCatalogueStatus;
  /** Advances only when commands or status meaningfully change. */
  revision: number;
  /**
   * True when descriptors carry execution identity negotiated with the
   * bridge. False for a legacy list, whose rows run as ordinary prompt text.
   */
  enhanced: boolean;
  /** How the backend learns about changes; `ttl` means events are not guaranteed. */
  freshness?: "push" | "ttl";
  fetchedAt?: string;
  truncated?: boolean;
  /**
   * The provider lists more commands once its session attaches (first turn
   * or an explicit refresh); the rows are what it could read before that.
   * Only ever set on a `stale` list.
   */
  attachPending?: boolean;
  error?: { code: NativeAgentCommandCatalogueErrorCode; message?: string };
  lastRefresh?: { outcome: NativeAgentCommandRefreshOutcome; at: string; message?: string };
}

/**
 * How a composer submission should be interpreted.
 *
 * - `literal`: ordinary text. Never matched against commands.
 * - `typed`: resolve a leading command token against the authoritative
 *   catalogue; unknown tokens stay ordinary text.
 * - `selected`: the user picked this descriptor. Binding, not a hint — if it
 *   is gone or changed, the submission fails instead of becoming a prompt.
 */
export type NativeAgentCommandIntent =
  | { kind: "literal" }
  | { kind: "typed" }
  | { kind: "selected"; commandId: string; bindingRevision?: string };

/** Content-free record of what a dispatch resolved to, kept for retries. */
export interface NativeAgentResolvedCommandRecord {
  intent: NativeAgentCommandIntent;
  commandId?: string;
  name?: string;
  executionKind?: NativeAgentCommandExecutionKind;
  bindingRevision?: string;
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
  /** False when the authoritative source has no older page it can serve. */
  canLoadEarlier?: boolean;
}

/** Heavy tool fields fetched only after the user expands a transcript row. */
export interface NativeAgentToolDetails {
  detailRef: string;
  toolOutput?: string;
  toolError?: string;
  /**
   * An inline `data:` URL for image bytes resolved on demand.
   *
   * `projectionPart` strips a `fileUrl` that names a staged workspace file, but
   * a provider that persists the bytes inline (OpenCode's pasted attachments)
   * has no path to re-read. Moving the bytes here keeps them out of every live
   * transcript read and lets the renderer fetch the image on demand. The same
   * field carries a provider-reported local image after the backend resolves
   * its opaque, session-scoped exact-path reference.
   */
  fileDataUrl?: string;
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
  /** An id from the composer's `approvalModes`. */
  approvalMode?: string;
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
  /** False when optional runtime health was unavailable for this projection. */
  runtimeHealthAuthoritative?: boolean;
  notices?: NativeAgentNotice[];
  /** Content-free marker for an idempotent backend-owned retry. */
  recoverableDispatch?: NativeAgentRecoverableDispatch;
  /** The last parked dispatch the backend retired on its own; absent from older backends. */
  retiredDispatch?: NativeAgentRetiredDispatch;
  backgroundTasks?: NativeAgentBackgroundTaskSummary[];
  suggestedPrompt?: string;
  completionBlockedByBackgroundTasks?: boolean;
  /**
   * Rows saying how the last turn ended (`native-terminal:` ids), from the
   * progressive state view. Shown after `messages` with
   * `withNativeTerminalMessages` (`native-terminal-rows.ts`); a full
   * projection carries them in `messages` instead.
   */
  terminalMessages?: TMessage[];
  turnBoundaries?: NativeAgentTurnBoundary[];
  slashCommands?: NativeAgentSlashCommand[];
  /** Freshness of {@link slashCommands}; absent from a legacy backend. */
  slashCommandCatalogue?: NativeAgentCommandCatalogueState;
  /** Monotonic within one runtime generation. */
  revision: number;
  /** Changes whenever the provider transport authority is replaced. */
  generation: string | number;
  cursor?: string;
}

/** Current provider-neutral remote synchronization protocol. */
export const NATIVE_AGENT_SYNC_VERSION = 1 as const;

/** Additive transcript/state/discovery synchronization protocol. */
export const NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION = 1 as const;

/**
 * Identity common to independently delivered view domains.
 *
 * Tokens are deliberately omitted from this descriptor. They are cache
 * validators, not authority, and each domain advances on its own schedule.
 */
export interface NativeAgentViewIdentity {
  backendInstanceId: string;
  environmentId: string;
  platform: AgentPlatform;
  logicalSessionKey: string;
  providerSessionId: string;
  sourceGeneration: string | number;
}

export type NativeAgentTranscriptFreshness = "cached" | "current" | "empty";

export interface NativeAgentTranscriptView<TMessage = unknown> {
  identity: NativeAgentViewIdentity;
  freshness: NativeAgentTranscriptFreshness;
  messages: TMessage[];
  messageWindow?: NativeAgentMessageWindow;
  title?: string;
  providerRevision?: number;
  historyCursor?: string;
  /**
   * `direct` when `historyCursor` pages this view's own `historyEpoch`
   * straight from the provider (`get_native_agent_message_page` answers with
   * the same epoch). Absent: the cursor belongs to the joined sync-v1 paging
   * namespace, as before.
   */
  historyPaging?: NativeAgentHistoryPaging;
  historyEpoch: string;
  historyComplete: boolean;
  /**
   * Rows from before `messages` that changed recently, newest change first. A
   * row is one model response, so a late tool result or subagent report can
   * land on a row newer ones have pushed out of the live window. A consumer
   * replaces its own copy of each and never inserts one it does not hold.
   */
  revisedMessages?: TMessage[];
  /** Changed recovery signal invalidates retained history, which remains pageable. */
  historyReconciliationToken?: string;
}

/** Bound on `revisedMessages`, per view and per delta. */
export const NATIVE_AGENT_REVISED_MESSAGES_MAX = 64;

export type NativeAgentHistoryPaging = "direct";

/** Action-critical state which is safe to apply without transcript/discovery. */
export interface NativeAgentSessionStateView {
  identity: NativeAgentViewIdentity;
  connection: NativeAgentConnectionState;
  turn: NativeAgentTurnState;
  interactions: AgentInteractionRequest[];
  composerControls: NativeAgentComposerControl[];
  /** Selected values are authoritative; catalogue rows may arrive later. */
  composer?: NativeAgentComposerState;
  readiness?: NativeAgentReadiness;
  capabilities: NativeAgentCapabilities;
  queue?: NativeAgentQueueSnapshot;
  asyncQuestionResponses?: NativeAgentAsyncQuestionResponse[];
  contextUsage?: NativeAgentContextUsage;
  policy?: NativeAgentExecutionPolicy;
  rateLimits?: NativeAgentRateLimitWindow[];
  /** False when runtime-backed notices could not be refreshed for this state. */
  runtimeHealthAuthoritative?: boolean;
  /**
   * Authoritative session notices, including an empty array when every prior
   * condition has cleared. Keeping these in the state domain lets a recovered
   * connection retire a notice without waiting for an unrelated transcript or
   * discovery refresh.
   */
  notices: NativeAgentNotice[];
  recoverableDispatch?: NativeAgentRecoverableDispatch;
  retiredDispatch?: NativeAgentRetiredDispatch;
  backgroundTasks?: NativeAgentBackgroundTaskSummary[];
  suggestedPrompt?: string;
  completionBlockedByBackgroundTasks?: boolean;
  /**
   * System rows for the provider's terminal state: its turn error and its
   * `error`/`stopped` notices, which `notices` leaves out. The transcript view
   * never reads session state, so without these a failed turn's reason never
   * reached a progressive reader. Absent when there is none, and from older
   * backends.
   */
  terminalMessages?: unknown[];
  shareUrl?: string | null;
  title?: string;
}

export const NATIVE_AGENT_DISCOVERY_SECTIONS = ["models", "commands", "mcp", "runtime"] as const;
export type NativeAgentDiscoverySection = (typeof NATIVE_AGENT_DISCOVERY_SECTIONS)[number];
export type NativeAgentDiscoveryAvailability = "loading" | "ready" | "stale" | "unavailable";

export interface NativeAgentDiscoverySectionState<T> {
  availability: NativeAgentDiscoveryAvailability;
  /** Present for ready/stale, including successful empty arrays. */
  value?: T;
  revision: number;
  truncated?: boolean;
  error?: string;
}

export interface NativeAgentDiscoveryView {
  identity: NativeAgentViewIdentity;
  sections: {
    models?: NativeAgentDiscoverySectionState<AgentModel[]>;
    commands?: NativeAgentDiscoverySectionState<NativeAgentSlashCommand[]> & {
      /** Richer freshness than `availability`; absent from a legacy backend. */
      catalogue?: NativeAgentCommandCatalogueState;
    };
    mcp?: NativeAgentDiscoverySectionState<NativeAgentMcpServer[]>;
    runtime?: NativeAgentDiscoverySectionState<{
      summary: NativeAgentRuntimeSummary;
      notices: NativeAgentRuntimeNotice[];
    }>;
  };
}

export type NativeAgentDomainUpdate<T> =
  | {
      viewVersion: typeof NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION;
      status: "snapshot";
      token: string;
      value: T;
      resetReason?: "initial" | "forced" | "unknown-token" | "expired" | "identity-changed";
    }
  | {
      viewVersion: typeof NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION;
      status: "unchanged";
      token: string;
      identity: NativeAgentViewIdentity;
    }
  | {
      viewVersion: typeof NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION;
      status: "missing";
    }
  | {
      viewVersion: typeof NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION;
      status: "unavailable";
      retryable: boolean;
      error?: string;
      identity?: NativeAgentViewIdentity;
    };

/** Message-only delta for an already-held progressive transcript snapshot. */
export interface NativeAgentTranscriptDelta<TMessage = unknown> {
  messageUpserts: TMessage[];
  /**
   * Part-level patches against the base view's version of each message; only
   * sent to a client that negotiated `NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION`.
   * A message is either upserted or patched, never both.
   */
  messagePatches?: NativeAgentMessagePatch[];
  /** Present only when the ordered membership of the live tail changed. */
  liveMessageIds?: string[];
  deletedMessageIds: string[];
  freshness: NativeAgentTranscriptFreshness;
  historyEpoch: string;
  historyComplete: boolean;
  historyCursor?: string;
  historyPaging?: NativeAgentHistoryPaging;
  title?: string;
  messageWindow?: NativeAgentMessageWindow;
  providerRevision?: number;
  /** Newly changed older rows since the base; absence clears transient notes. */
  revisedMessages?: TMessage[];
  /** Changed recovery signal invalidates retained history, which remains pageable. */
  historyReconciliationToken?: string;
}

export type NativeAgentTranscriptUpdate<TMessage = unknown> =
  | NativeAgentDomainUpdate<NativeAgentTranscriptView<TMessage>>
  | {
      viewVersion: typeof NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION;
      status: "delta";
      baseToken: string;
      token: string;
      identity: NativeAgentViewIdentity;
      delta: NativeAgentTranscriptDelta<TMessage>;
    };
export type NativeAgentSessionStateUpdate = NativeAgentDomainUpdate<NativeAgentSessionStateView>;
export type NativeAgentDiscoveryUpdate = NativeAgentDomainUpdate<NativeAgentDiscoveryView>;

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
  | "runtimeHealthAuthoritative"
  | "notices"
  | "recoverableDispatch"
  | "retiredDispatch"
  | "backgroundTasks"
  | "suggestedPrompt"
  | "completionBlockedByBackgroundTasks"
  | "turnBoundaries"
  | "slashCommands"
  | "slashCommandCatalogue";

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
  "runtimeHealthAuthoritative",
  "notices",
  "recoverableDispatch",
  "retiredDispatch",
  "backgroundTasks",
  "suggestedPrompt",
  "completionBlockedByBackgroundTasks",
  "turnBoundaries",
  "slashCommands",
  "slashCommandCatalogue",
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
  "runtimeHealthAuthoritative",
  "notices",
  "recoverableDispatch",
  "retiredDispatch",
  "backgroundTasks",
  "suggestedPrompt",
  "completionBlockedByBackgroundTasks",
  "turnBoundaries",
  "slashCommands",
  "slashCommandCatalogue",
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
      !(typeof candidate.generation === "number" && Number.isSafeInteger(candidate.generation))) ||
    (candidate.runtimeHealthAuthoritative !== undefined &&
      typeof candidate.runtimeHealthAuthoritative !== "boolean")
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

function isNativeAgentViewIdentity(value: unknown): value is NativeAgentViewIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.backendInstanceId === "string" &&
    candidate.backendInstanceId.length > 0 &&
    candidate.backendInstanceId.length <= 128 &&
    typeof candidate.environmentId === "string" &&
    candidate.environmentId.length > 0 &&
    candidate.environmentId.length <= 4_096 &&
    isAgentPlatform(candidate.platform) &&
    typeof candidate.logicalSessionKey === "string" &&
    candidate.logicalSessionKey.length > 0 &&
    candidate.logicalSessionKey.length <= 4_096 &&
    typeof candidate.providerSessionId === "string" &&
    candidate.providerSessionId.length > 0 &&
    candidate.providerSessionId.length <= 4_096 &&
    (typeof candidate.sourceGeneration === "string" ||
      (typeof candidate.sourceGeneration === "number" &&
        Number.isSafeInteger(candidate.sourceGeneration)))
  );
}

function isNativeAgentDomainEnvelope(value: unknown): value is NativeAgentDomainUpdate<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.viewVersion !== NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION) return false;
  if (candidate.status === "missing") return true;
  if (candidate.status === "unavailable") {
    return (
      typeof candidate.retryable === "boolean" &&
      (candidate.error === undefined ||
        (typeof candidate.error === "string" && candidate.error.length <= 4_096)) &&
      (candidate.identity === undefined || isNativeAgentViewIdentity(candidate.identity))
    );
  }
  if (
    (candidate.status !== "snapshot" && candidate.status !== "unchanged") ||
    typeof candidate.token !== "string" ||
    candidate.token.length === 0 ||
    candidate.token.length > 1_024
  ) {
    return false;
  }
  return candidate.status === "snapshot"
    ? candidate.value !== undefined
    : isNativeAgentViewIdentity(candidate.identity);
}

function isRevisedMessageList(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > NATIVE_AGENT_REVISED_MESSAGES_MAX) return false;
  return value.every((message) => {
    const id = (message as { id?: unknown })?.id;
    return typeof id === "string" && id.length > 0 && id.length <= 4_096;
  });
}

function isNativeAgentTranscriptDelta(value: unknown): value is NativeAgentTranscriptDelta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    !Array.isArray(candidate.messageUpserts) ||
    candidate.messageUpserts.length > 4_096 ||
    !Array.isArray(candidate.deletedMessageIds) ||
    candidate.deletedMessageIds.length > 4_096 ||
    (candidate.freshness !== "cached" &&
      candidate.freshness !== "current" &&
      candidate.freshness !== "empty") ||
    typeof candidate.historyEpoch !== "string" ||
    candidate.historyEpoch.length === 0 ||
    candidate.historyEpoch.length > 128 ||
    typeof candidate.historyComplete !== "boolean" ||
    (candidate.historyCursor !== undefined &&
      (typeof candidate.historyCursor !== "string" || candidate.historyCursor.length > 1_024)) ||
    (candidate.historyPaging !== undefined && candidate.historyPaging !== "direct") ||
    (candidate.liveMessageIds !== undefined &&
      (!Array.isArray(candidate.liveMessageIds) || candidate.liveMessageIds.length > 4_096)) ||
    (candidate.messagePatches !== undefined &&
      !isNativeAgentMessagePatchList(candidate.messagePatches)) ||
    (candidate.historyReconciliationToken !== undefined &&
      (typeof candidate.historyReconciliationToken !== "string" ||
        candidate.historyReconciliationToken.length > 128)) ||
    !isRevisedMessageList(candidate.revisedMessages)
  ) {
    return false;
  }
  const deleted = candidate.deletedMessageIds;
  return deleted.every((id) => typeof id === "string" && id.length > 0 && id.length <= 4_096);
}

export function applyNativeAgentTranscriptDelta<TMessage>(
  current: NativeAgentTranscriptView<TMessage>,
  delta: NativeAgentTranscriptDelta<TMessage>,
): NativeAgentTranscriptView<TMessage> | null {
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
  // Patches address the base view's version of their message, so they apply
  // before any upsert and fail the whole delta if a base is missing.
  const patched = new Set<string>();
  for (const patch of delta.messagePatches ?? []) {
    const base = currentMessages.get(patch.id);
    if (base === undefined || patched.has(patch.id)) return null;
    const next = applyNativeAgentMessagePatch(base, patch);
    if (next === null) return null;
    currentMessages.set(patch.id, next);
    patched.add(patch.id);
  }
  for (const message of delta.messageUpserts) {
    const id = (message as { id?: unknown })?.id;
    if (typeof id !== "string" || patched.has(id)) return null;
    currentMessages.set(id, message);
  }
  const order =
    delta.liveMessageIds ?? current.messages.map((message) => (message as { id: string }).id);
  if (new Set(order).size !== order.length || order.some((id) => !currentMessages.has(id))) {
    return null;
  }
  const ordered = new Set(order);
  for (const message of delta.messageUpserts) {
    if (!ordered.has((message as { id: string }).id)) return null;
  }
  for (const patch of delta.messagePatches ?? []) {
    if (!ordered.has(patch.id)) return null;
  }
  return {
    ...current,
    freshness: delta.freshness,
    messages: order.map((id) => currentMessages.get(id)!),
    historyEpoch: delta.historyEpoch,
    historyComplete: delta.historyComplete,
    /*
     * A delta mirrors whatever cursor its view carries, including none, so the
     * omission is authoritative for this view rather than a field the sender
     * chose to save bytes on. Retaining the previous cursor made a view whose
     * boundary had gone away look perpetually pageable.
     *
     * The reasons a cursor goes away are not all "history was fully read": the
     * backend also stops minting one when its paging cache has not been
     * populated for this session. Consumers therefore must not treat a cleared
     * cursor here as proof that nothing earlier exists — that question belongs
     * to `historyComplete` and to whatever paging state the consumer owns.
     */
    historyCursor: delta.historyCursor,
    // Mirrors the cursor it describes, so it is authoritative in the same way.
    historyPaging: delta.historyPaging,
    ...(delta.title === undefined ? {} : { title: delta.title }),
    ...(delta.messageWindow === undefined ? {} : { messageWindow: delta.messageWindow }),
    ...(delta.providerRevision === undefined ? {} : { providerRevision: delta.providerRevision }),
    // Authoritative like the cursor: a delta without revised rows clears them.
    revisedMessages: delta.revisedMessages,
    historyReconciliationToken: delta.historyReconciliationToken,
  };
}

export function isNativeAgentTranscriptUpdate(
  value: unknown,
): value is NativeAgentTranscriptUpdate {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    if (
      candidate.viewVersion === NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION &&
      candidate.status === "delta"
    ) {
      return (
        typeof candidate.baseToken === "string" &&
        candidate.baseToken.length > 0 &&
        candidate.baseToken.length <= 1_024 &&
        typeof candidate.token === "string" &&
        candidate.token.length > 0 &&
        candidate.token.length <= 1_024 &&
        isNativeAgentViewIdentity(candidate.identity) &&
        isNativeAgentTranscriptDelta(candidate.delta)
      );
    }
  }
  if (!isNativeAgentDomainEnvelope(value)) return false;
  if (value.status !== "snapshot") return true;
  const transcript = value.value as unknown as Record<string, unknown>;
  if (
    !transcript ||
    typeof transcript !== "object" ||
    Array.isArray(transcript) ||
    !isNativeAgentViewIdentity(transcript.identity) ||
    (transcript.freshness !== "cached" &&
      transcript.freshness !== "current" &&
      transcript.freshness !== "empty") ||
    !Array.isArray(transcript.messages) ||
    transcript.messages.length > 4_096 ||
    typeof transcript.historyEpoch !== "string" ||
    transcript.historyEpoch.length === 0 ||
    transcript.historyEpoch.length > 128 ||
    typeof transcript.historyComplete !== "boolean" ||
    (transcript.historyCursor !== undefined &&
      (typeof transcript.historyCursor !== "string" || transcript.historyCursor.length > 1_024)) ||
    (transcript.historyPaging !== undefined && transcript.historyPaging !== "direct") ||
    (transcript.historyReconciliationToken !== undefined &&
      (typeof transcript.historyReconciliationToken !== "string" ||
        transcript.historyReconciliationToken.length > 128)) ||
    !isRevisedMessageList(transcript.revisedMessages)
  ) {
    return false;
  }
  const ids = new Set<string>();
  return transcript.messages.every((message) => {
    const id = (message as { id?: unknown })?.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 4_096 || ids.has(id)) {
      return false;
    }
    ids.add(id);
    return true;
  });
}

export function isNativeAgentSessionStateUpdate(
  value: unknown,
): value is NativeAgentSessionStateUpdate {
  if (!isNativeAgentDomainEnvelope(value)) return false;
  if (value.status !== "snapshot") return true;
  const state = value.value as unknown as Record<string, unknown>;
  return Boolean(
    state &&
    typeof state === "object" &&
    !Array.isArray(state) &&
    isNativeAgentViewIdentity(state.identity) &&
    (state.connection === "connecting" ||
      state.connection === "connected" ||
      state.connection === "error") &&
    state.turn &&
    typeof state.turn === "object" &&
    !Array.isArray(state.turn) &&
    Array.isArray(state.interactions) &&
    state.interactions.length <= 512 &&
    Array.isArray(state.composerControls) &&
    state.composerControls.length <= 512 &&
    Array.isArray(state.notices) &&
    state.notices.length <= 512 &&
    (state.runtimeHealthAuthoritative === undefined ||
      typeof state.runtimeHealthAuthoritative === "boolean") &&
    state.capabilities &&
    typeof state.capabilities === "object" &&
    !Array.isArray(state.capabilities),
  );
}

export function isNativeAgentDiscoveryUpdate(value: unknown): value is NativeAgentDiscoveryUpdate {
  if (!isNativeAgentDomainEnvelope(value)) return false;
  if (value.status !== "snapshot") return true;
  const discovery = value.value as unknown as Record<string, unknown>;
  if (
    !discovery ||
    typeof discovery !== "object" ||
    Array.isArray(discovery) ||
    !isNativeAgentViewIdentity(discovery.identity) ||
    !discovery.sections ||
    typeof discovery.sections !== "object" ||
    Array.isArray(discovery.sections)
  ) {
    return false;
  }
  const sections = discovery.sections as Record<string, unknown>;
  if (
    Object.keys(sections).some((key) => !NATIVE_AGENT_DISCOVERY_SECTIONS.includes(key as never))
  ) {
    return false;
  }
  return Object.values(sections).every((section) => {
    if (!section || typeof section !== "object" || Array.isArray(section)) return false;
    const candidate = section as Record<string, unknown>;
    return (
      (candidate.availability === "loading" ||
        candidate.availability === "ready" ||
        candidate.availability === "stale" ||
        candidate.availability === "unavailable") &&
      Number.isSafeInteger(candidate.revision) &&
      (candidate.revision as number) >= 0 &&
      (candidate.error === undefined ||
        (typeof candidate.error === "string" && candidate.error.length <= 4_096))
    );
  });
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
