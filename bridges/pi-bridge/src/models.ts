/**
 * Model discovery, normalized into the composer contract every platform shares.
 *
 * Pi fronts fifteen-odd providers, so a model is identified by a *pair* —
 * provider plus model id — where the shared composer has one flat string. The
 * pair is encoded as `provider/modelId`, split on the first slash only, because
 * the model half routinely contains slashes of its own
 * (`openrouter/anthropic/claude-opus-4-5`). That is the same encoding
 * Orkestrator already uses for OpenCode, so a user moving between the two
 * pickers sees one convention rather than two.
 *
 * Pi's reasoning axis is its *thinking level*, which is the same low/medium/
 * high/xhigh/max ladder the Codex picker shows, so an application-level effort
 * default carries over without translation. There is no speed axis and no
 * conversation mode: Pi ships "primitives, not features", so plan mode is
 * something an extension adds rather than something the harness has, and
 * offering either control here would show a switch nothing can honour.
 */
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { AgentModel, NativeAgentComposerState } from "@orkestrator/protocol/native-agent";
import { CATALOG_TIMEOUT_MS, MAX_MODEL_ID_BYTES, MAX_MODELS } from "./config.js";
import { modelRuntime } from "./runtime.js";
import { withTimeout } from "./timeout.js";

/**
 * The ladder Pi itself defines, in order.
 *
 * `off` is a real selection rather than "let the model decide" — it disables
 * reasoning outright — so it is offered as its own option instead of being
 * folded into the shared `default` id, which every other platform uses to mean
 * the opposite.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Pi's own default when neither the model nor the user's settings name one. */
export const DEFAULT_THINKING_LEVEL: PiThinkingLevel = "medium";

const THINKING_LABELS: Readonly<Record<PiThinkingLevel, string>> = Object.freeze({
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
});

let catalogCache: AgentModel[] | null = null;
let catalogProbe: Promise<AgentModel[]> | null = null;
/** See {@link catalogReadFailed}: an empty catalogue is not always an answer. */
let lastCatalogReadFailed = false;
/**
 * The thinking-level preferences the *last* catalogue read was built against.
 *
 * Held beside the cache so a session that attaches after a bare `/global/models`
 * read rebuilds the catalogue with its own settings, rather than serving a
 * default that was resolved without them.
 */
let catalogDefaults: ThinkingLevelDefaults | undefined;

export function emptyComposer(): NativeAgentComposerState {
  return {
    models: [],
    // Pi exposes no speed axis on any provider it fronts.
    fastModeEnabled: null,
    fastModeAvailable: false,
    // No plan/build split either: `nativeAgentCapabilities("pi")` reports
    // `mode: false`, and an empty list is what tells a live composer the same.
    modes: [],
  };
}

/** Encode a provider/model pair as the flat id the composer contract takes. */
export function composeModelId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/**
 * Reconcile a composer with the model and thinking level Pi actually accepted.
 *
 * Requested selections are not authoritative: an old provider can disappear,
 * `resolveModel` can fall back, and `setModel` can reject after credentials
 * change. Keeping the reconciliation pure makes every caller use the same
 * provider/model encoding and makes the silent-fallback case directly testable.
 */
export function reconcileComposerSelection(
  composer: NativeAgentComposerState,
  model: Pick<Model<Api>, "provider" | "id"> | undefined,
  reasoningId: string | undefined,
): NativeAgentComposerState {
  const selectedModelId = model
    ? composeModelId(model.provider, model.id)
    : composer.selectedModelId;
  return {
    ...composer,
    ...(selectedModelId ? { selectedModelId } : {}),
    ...(reasoningId ? { selectedReasoningId: reasoningId } : {}),
  };
}

/** The provider half of `provider/modelId`, or "" when the id names none. */
export function modelProviderId(id: string): string {
  const separator = id.indexOf("/");
  return separator > 0 ? id.slice(0, separator) : "";
}

/** The model half of `provider/modelId`, or "" when the id names no provider. */
export function modelLocalId(id: string): string {
  const providerId = modelProviderId(id);
  return providerId ? id.slice(providerId.length + 1) : "";
}

/**
 * Read the model catalogue, memoized for the life of the bridge process.
 *
 * Only a non-empty result is cached. Caching an empty one would pin an
 * unauthenticated or offline moment for the life of the process, so a provider
 * the user signs into *after* the first read could never appear.
 */
export async function listModels(defaults?: ThinkingLevelDefaults): Promise<AgentModel[]> {
  // A read that can resolve the user's own thinking-level preferences beats a
  // cached one that could not, so it rebuilds rather than serving the weaker
  // answer for the life of the process.
  if (catalogCache && (catalogDefaults !== undefined || defaults === undefined)) {
    return catalogCache;
  }
  catalogProbe ??= (async () => {
    try {
      const runtime = await modelRuntime();
      const available = await withTimeout(
        runtime.getAvailable(),
        CATALOG_TIMEOUT_MS,
        "Pi catalogue read timed out",
      );
      const models = available
        .slice(0, MAX_MODELS)
        .map((model) =>
          normalizeAgentModel(model, defaults, runtime.getProvider(model.provider)?.name),
        )
        .filter((model) => model.id.length > 0);
      if (models.length > 0) {
        catalogCache = models;
        catalogDefaults = defaults;
      }
      lastCatalogReadFailed = false;
      return models;
    } catch (error) {
      lastCatalogReadFailed = true;
      throw error;
    } finally {
      catalogProbe = null;
    }
  })();
  // A rebuild that fails falls back to the catalogue already held rather than
  // to nothing. The rebuild path is reached when a *better* answer is
  // available — a caller that can resolve the user's thinking-level defaults —
  // so a timeout there would otherwise empty a model picker that was working a
  // moment ago.
  return catalogProbe.catch(() => catalogCache ?? []);
}

/**
 * Whether the most recently *completed* catalogue probe failed.
 *
 * `listModels` answers a failed probe with the catalogue it already held, or
 * with `[]` when it held none — so an empty list on its own cannot tell "this
 * account has no models" from "the read timed out". Callers that would act
 * destructively on emptiness, such as clearing an open session's picker, have
 * to know which one it was.
 *
 * One flag is enough because one probe is: `catalogProbe` is shared, so every
 * concurrent caller is reading the same result this describes.
 */
export function catalogReadFailed(): boolean {
  return lastCatalogReadFailed;
}

/** Drop the memo so the next read re-discovers. */
export function refreshModels(): void {
  catalogCache = null;
  catalogDefaults = undefined;
  // The old verdict described a read whose result has just been discarded.
  // Leaving it set would let the *next* caller attribute a stale failure to a
  // probe that has not run yet.
  lastCatalogReadFailed = false;
}

/**
 * One SDK model as the shared catalogue entry.
 *
 * Exported because the reasoning axis it derives is the part most likely to be
 * wrong in a way nothing else notices — a level offered that the model then
 * clamps away produces a successful turn that simply thought less than asked.
 */
export function normalizeAgentModel(
  model: Model<Api>,
  defaults?: ThinkingLevelDefaults,
  providerLabel?: string,
): AgentModel {
  const reasoning = reasoningOptions(model);
  return {
    platform: "pi",
    id: boundId(composeModelId(model.provider, model.id)),
    label: model.name?.trim() || model.id,
    providerLabel: providerLabel?.trim() || model.provider,
    ...(reasoning.length > 0
      ? { reasoning, defaultReasoningId: defaultThinkingLevel(model, reasoning, defaults) }
      : {}),
    // Neither axis exists anywhere in Pi.
    supportsSpeed: false,
    supportsMode: false,
    ...(model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
    // Pi publishes the accepted input modalities per model, so image support is
    // read rather than assumed — an image sent to a text-only model is rejected
    // by the provider mid-turn.
    supportsImageInput: Array.isArray(model.input) ? model.input.includes("image") : false,
  };
}

/**
 * The thinking levels this model actually accepts.
 *
 * Delegated to Pi's own `getSupportedThinkingLevels` rather than read off
 * `thinkingLevelMap` here, because the rule is not the obvious one: a level is
 * unsupported when its mapping is `null`, *and* `xhigh` and `max` additionally
 * require an explicit mapping — an absent key excludes them. Reimplementing
 * that offered "Extra high" and "Max" on models that have neither, and Pi then
 * silently clamped the turn down to something else. The picker said one thing
 * and the run did another, with nothing in between to notice.
 *
 * A model with no reasoning at all reports `["off"]`, which is Pi's answer too:
 * the axis exists and has exactly one honest value.
 */
function reasoningOptions(model: Model<Api>): Array<{ id: string; label: string }> {
  return getSupportedThinkingLevels(model)
    .filter((level): level is PiThinkingLevel =>
      (THINKING_LEVELS as readonly string[]).includes(level),
    )
    .map((level) => ({ id: level, label: THINKING_LABELS[level] }));
}

/**
 * Where a fresh session's thinking level comes from.
 *
 * Pi resolves this itself as per-model setting → global default → `medium`, and
 * both settings are what `/thinking` writes. Reading the same order here is
 * what makes a level chosen in a Pi terminal tab show up pre-selected in the
 * model picker, instead of the two surfaces disagreeing about the same stored
 * preference.
 */
function defaultThinkingLevel(
  model: Model<Api>,
  reasoning: ReadonlyArray<{ id: string }>,
  settings: ThinkingLevelDefaults | undefined,
): string {
  const preferred =
    settings?.perModel(model.provider, model.id) ?? settings?.global() ?? DEFAULT_THINKING_LEVEL;
  const clamped = clampThinkingLevel(model, preferred as ModelThinkingLevel);
  return reasoning.some((option) => option.id === clamped) ? clamped : reasoning[0]!.id;
}

/**
 * The two thinking-level preferences Pi persists, as plain lookups.
 *
 * Passed in rather than read here so this module stays free of a settings
 * manager: the catalogue is also built during a bare `/global/models` read,
 * where no session — and therefore no workspace settings — exists yet.
 */
export interface ThinkingLevelDefaults {
  perModel(providerId: string, modelId: string): string | undefined;
  global(): string | undefined;
}

/**
 * Resolve a composer selection to the SDK model object.
 *
 * Returns undefined rather than throwing when the id names nothing: a stale
 * selection is a routine state (a provider signed out, a catalogue moved on),
 * and callers fall back to the first available model rather than failing the
 * session that was merely opened.
 */
export async function resolveModel(modelId: string | undefined): Promise<Model<Api> | undefined> {
  const runtime = await modelRuntime();
  const trimmed = modelId?.trim();
  if (trimmed) {
    const providerId = modelProviderId(trimmed);
    const localId = modelLocalId(trimmed);
    const resolved = providerId
      ? (runtime.getModel(providerId, localId) as Model<Api> | undefined)
      : undefined;
    if (resolved) return resolved;
  }
  const available = await withTimeout(
    runtime.getAvailable(),
    CATALOG_TIMEOUT_MS,
    "Pi model availability read timed out",
  ).catch(() => []);
  return available[0] as Model<Api> | undefined;
}

/**
 * Coerce a composer reasoning id to a level this model will accept.
 *
 * Clamped against the model rather than merely validated against the ladder,
 * so a selection carried over from another platform — or from a model that had
 * `max` when this one does not — resolves to Pi's own nearest supported level
 * instead of being sent and silently reinterpreted.
 */
export function thinkingLevel(
  reasoningId: string | undefined,
  model?: Model<Api>,
): ModelThinkingLevel {
  const trimmed = reasoningId?.trim();
  const requested = (THINKING_LEVELS as readonly string[]).includes(trimmed ?? "")
    ? (trimmed as ModelThinkingLevel)
    : DEFAULT_THINKING_LEVEL;
  return model ? clampThinkingLevel(model, requested) : requested;
}

/**
 * Fill in a composer with the live catalogue, preserving any explicit choice.
 *
 * A selection the catalogue does not contain is kept rather than corrected:
 * the user chose it, the catalogue read may have been partial, and the runtime
 * is the authority on whether the pair is valid.
 */
export async function hydrateComposer(
  composer: NativeAgentComposerState,
  defaults?: ThinkingLevelDefaults,
): Promise<NativeAgentComposerState> {
  const models = await listModels(defaults);
  const selectedModelId = composer.selectedModelId ?? models[0]?.id;
  const selected = models.find((model) => model.id === selectedModelId);
  return {
    ...composer,
    models,
    ...(selectedModelId ? { selectedModelId } : {}),
    selectedReasoningId: composer.selectedReasoningId ?? selected?.defaultReasoningId ?? undefined,
    fastModeAvailable: false,
  };
}

function boundId(value: string): string {
  const trimmed = value?.trim() ?? "";
  return Buffer.byteLength(trimmed) > MAX_MODEL_ID_BYTES ? "" : trimmed;
}
