import { fallbackReasoningId } from "@orkestrator/protocol/native-agent";
import type {
  AgentConversationMode,
  AgentModel,
  AgentReasoningOption,
  NativeAgentComposerState,
} from "@orkestrator/protocol/native-agent";
import { EMPTY_NATIVE_AGENT_COMPOSER_STATE } from "@orkestrator/protocol/native-agent";

export type AcpProvider = "cursor" | "grok";

export interface AcpComposerPatch {
  modelId?: string;
  reasoningId?: string;
  fastMode?: boolean;
  mode?: AgentConversationMode;
}

export interface AcpConfigOptionValue {
  value: string;
  name: string;
  description?: string;
}

export interface AcpConfigOption {
  configId: string;
  category?: string;
  type: "select" | "boolean";
  currentValue: string | boolean;
  options?: AcpConfigOptionValue[];
}

/**
 * Vendor wire kept inside the ACP adapter. HTTP clients never see this; they
 * receive {@link NativeAgentComposerState} only.
 */
export interface AcpConfigWire {
  configOptions: AcpConfigOption[];
  /** Conversation mode → the agent's own mode id (`agent`, `plan`, `code`, …). */
  availableModeIds: Partial<Record<AgentConversationMode, string>>;
  usesSetModel: boolean;
  currentModelId?: string;
}

export interface AcpNormalizedSessionConfig {
  composer: NativeAgentComposerState;
  wire: AcpConfigWire;
}

export type AcpConfigRpc =
  | {
      method: "session/set_config_option";
      params: {
        sessionId: string;
        configId: string;
        value: string | boolean;
        type?: "boolean";
      };
    }
  | {
      method: "session/set_mode";
      params: { sessionId: string; modeId: string };
    }
  | {
      method: "session/set_model";
      params: {
        sessionId: string;
        modelId: string;
        _meta?: { reasoningEffort: string };
      };
    };

const PLATFORM_LABEL: Record<AcpProvider, string> = {
  cursor: "Cursor",
  grok: "Grok",
};

const CONVERSATION_MODES: Array<{ id: AgentConversationMode; label: string }> = [
  { id: "build", label: "Build" },
  { id: "plan", label: "Plan" },
];

const EMPTY_WIRE: AcpConfigWire = {
  configOptions: [],
  availableModeIds: {},
  usesSetModel: false,
};

/**
 * Bound and deduplicate every catalogue the normalizer produces. The persisted
 * validator enforces the same limits on the way back in, so anything the
 * normalizer emits beyond them would be state this bridge writes and then
 * refuses to read.
 */
export const MAX_CATALOG_MODELS = 512;
export const MAX_REASONING_OPTIONS = 64;

export function emptyComposerState(): NativeAgentComposerState {
  return {
    models: [],
    fastModeEnabled: null,
    fastModeAvailable: false,
    modes: [],
  };
}

/**
 * Turn a `session/new` or `session/load` result into the provider-neutral
 * composer snapshot. Cursor speaks `configOptions` / `modes`; Grok speaks
 * `models.availableModels` plus `_meta.reasoningEffort`. Both collapse here.
 */
export function normalizeAcpSessionConfig(
  provider: AcpProvider,
  result: unknown,
): AcpNormalizedSessionConfig {
  const root = isObject(result) ? result : {};
  const configOptions = parseConfigOptions(root.configOptions);
  const modes = parseAvailableModes(root.modes);
  const grokModels = parseGrokModelCatalog(root.models);
  const usesSetModel = grokModels.models.length > 0;
  const availableModeIds = modeIdMap(modes.available);
  const wire: AcpConfigWire = {
    configOptions,
    availableModeIds,
    usesSetModel,
    currentModelId:
      grokModels.currentModelId ?? optionCurrentString(selectOption(configOptions, "model")),
  };

  const composer = usesSetModel
    ? composerFromGrokModels(provider, grokModels, availableModeIds, modes.currentId, configOptions)
    : composerFromConfigOptions(provider, configOptions, availableModeIds, modes.currentId);

  return { composer: withModes(composer, availableModeIds, modes.currentId), wire };
}

export function applyConfigOptionUpdate(
  provider: AcpProvider,
  current: AcpNormalizedSessionConfig,
  update: unknown,
): AcpNormalizedSessionConfig {
  const root = isObject(update) ? update : {};
  const nextOptions = Array.isArray(root.configOptions)
    ? parseConfigOptions(root.configOptions)
    : current.wire.configOptions;
  return normalizeAcpSessionConfig(provider, {
    configOptions: nextOptions,
    modes: {
      currentModeId: reverseModeId(current.wire.availableModeIds, current.composer.selectedModeId),
      availableModes: Object.entries(current.wire.availableModeIds).map(([id, modeId]) => ({
        id: modeId,
        name: id === "plan" ? "Plan" : "Build",
      })),
    },
    models: current.wire.usesSetModel
      ? {
          currentModelId: current.composer.selectedModelId,
          availableModels: current.composer.models.map((model) => ({
            modelId: model.id,
            name: model.label,
            description: model.description,
            _meta: {
              supportsReasoningEffort: (model.reasoning?.length ?? 0) > 0,
              reasoningEffort:
                model.id === current.composer.selectedModelId
                  ? current.composer.selectedReasoningId
                  : model.defaultReasoningId,
              reasoningEfforts: model.reasoning?.map((option) => ({ value: option.id })),
              totalContextTokens: model.contextWindow,
            },
          })),
        }
      : undefined,
  });
}

export function applyCurrentModeUpdate(
  current: AcpNormalizedSessionConfig,
  modeId: string,
): AcpNormalizedSessionConfig {
  const selectedModeId = mapModeId(modeId);
  return {
    wire: current.wire,
    composer: {
      ...current.composer,
      selectedModeId,
      modes:
        current.composer.modes.length > 0
          ? current.composer.modes
          : Object.keys(current.wire.availableModeIds).length > 0
            ? CONVERSATION_MODES.filter((mode) => current.wire.availableModeIds[mode.id])
            : [],
    },
  };
}

export function applyGrokModelChange(
  provider: AcpProvider,
  current: AcpNormalizedSessionConfig,
  update: unknown,
): AcpNormalizedSessionConfig {
  const root = isObject(update) ? update : {};
  const modelId =
    typeof root.model_id === "string"
      ? root.model_id
      : typeof root.modelId === "string"
        ? root.modelId
        : current.composer.selectedModelId;
  const effort =
    typeof root.reasoning_effort === "string"
      ? root.reasoning_effort
      : current.composer.selectedReasoningId;
  const models = current.composer.models.map((model) =>
    model.id === modelId && effort
      ? { ...model, defaultReasoningId: model.defaultReasoningId }
      : model,
  );
  const selected = models.find((model) => model.id === modelId) ?? models[0];
  // When the agent exposes an explicit fast toggle, that option is the state —
  // a model id switch says nothing about it.
  const fastOption = selectFastOption(current.wire.configOptions);
  return {
    wire: { ...current.wire, currentModelId: selected?.id },
    composer: {
      ...current.composer,
      models,
      selectedModelId: selected?.id,
      selectedReasoningId:
        effort && selected?.reasoning?.some((option) => option.id === effort)
          ? effort
          : selected?.defaultReasoningId,
      fastModeAvailable: selected?.supportsSpeed === true,
      fastModeEnabled:
        selected?.supportsSpeed !== true
          ? null
          : fastOption
            ? fastModeFromOption(fastOption)
            : isFastModelId(selected.id),
    },
  };
}

/** Replace a Grok model catalogue advertised by a vendor update. */
export function applyGrokCatalogUpdate(
  provider: AcpProvider,
  current: AcpNormalizedSessionConfig,
  update: unknown,
): AcpNormalizedSessionConfig {
  const root = isObject(update) ? update : {};
  const nestedModels = isObject(root.models) ? root.models : undefined;
  const availableModels = Array.isArray(root.availableModels)
    ? root.availableModels
    : Array.isArray(root.models)
      ? root.models
      : Array.isArray(nestedModels?.availableModels)
        ? nestedModels.availableModels
        : undefined;
  if (!availableModels) return applyGrokModelChange(provider, current, root);

  const currentModelId = firstString(
    root.currentModelId,
    root.current_model_id,
    root.modelId,
    root.model_id,
    nestedModels?.currentModelId,
    current.composer.selectedModelId,
  );
  const normalized = normalizeAcpSessionConfig(provider, {
    // A catalogue-only update says nothing about effort or fast mode, so the
    // known config options have to be carried forward; dropping them would
    // strip Cursor's reasoning and speed controls on every model refresh.
    configOptions: current.wire.configOptions,
    models: { currentModelId, availableModels },
    modes: persistedModes(current),
  });
  return normalized.composer.models.length > 0 ? normalized : current;
}

/**
 * Validate durable bridge state before it reaches planner code. The state file
 * is a cache, so malformed configuration must make the loader quarantine it
 * rather than creating a permanently unusable session.
 */
export function parsePersistedAcpSessionConfig(
  provider: AcpProvider,
  value: unknown,
): AcpNormalizedSessionConfig | null {
  if (!isObject(value) || !isObject(value.composer) || !isObject(value.wire)) return null;
  const composer = parsePersistedComposer(provider, value.composer);
  const wire = parsePersistedWire(value.wire);
  return composer && wire ? { composer, wire } : null;
}

export function parsePersistedComposerState(
  provider: AcpProvider,
  value: unknown,
): NativeAgentComposerState | null {
  return isObject(value) ? parsePersistedComposer(provider, value) : null;
}

/**
 * Translate a normalized composer patch into the ACP RPCs this provider
 * actually understands. Callers issue them in order and re-normalize from the
 * last response / follow-up `session/update`.
 */
export function planComposerApply(
  sessionId: string,
  current: AcpNormalizedSessionConfig,
  patch: AcpComposerPatch,
): AcpConfigRpc[] {
  const calls: AcpConfigRpc[] = [];
  const modelOption = selectOption(current.wire.configOptions, "model");
  const thoughtOption = selectOption(current.wire.configOptions, "thought_level");
  const fastOption = selectFastOption(current.wire.configOptions);
  const nextModelId = patch.modelId ?? current.composer.selectedModelId;
  const nextReasoningId = patch.reasoningId ?? current.composer.selectedReasoningId;
  const nextFast = patch.fastMode ?? current.composer.fastModeEnabled === true;

  if (
    patch.mode &&
    current.wire.availableModeIds[patch.mode] &&
    patch.mode !== current.composer.selectedModeId
  ) {
    calls.push({
      method: "session/set_mode",
      params: { sessionId, modeId: current.wire.availableModeIds[patch.mode]! },
    });
  }

  // Whether the config-option surface will carry the change. Catalogue updates
  // can move the active model without refreshing an option's `currentValue`, so
  // the composer snapshot — not that retained value — decides whether a change
  // is still required. A stale option list that lacks the requested id must
  // still fall through to `session/set_model` rather than drop the change.
  let modelSentAsOption = false;
  let reasoningSentAsOption = false;

  if (modelOption && patch.modelId && patch.modelId !== current.composer.selectedModelId) {
    const value = resolveSelectValue(modelOption, patch.modelId);
    if (value !== undefined) {
      calls.push({
        method: "session/set_config_option",
        params: { sessionId, configId: modelOption.configId, value },
      });
      modelSentAsOption = true;
    }
  }

  if (
    thoughtOption &&
    patch.reasoningId &&
    patch.reasoningId !== current.composer.selectedReasoningId
  ) {
    const value = resolveSelectValue(thoughtOption, patch.reasoningId);
    if (value !== undefined) {
      calls.push({
        method: "session/set_config_option",
        params: { sessionId, configId: thoughtOption.configId, value },
      });
      reasoningSentAsOption = true;
    }
  }

  if (
    fastOption &&
    patch.fastMode !== undefined &&
    patch.fastMode !== optionIsEnabled(fastOption)
  ) {
    if (fastOption.type === "boolean") {
      calls.push({
        method: "session/set_config_option",
        params: {
          sessionId,
          configId: fastOption.configId,
          type: "boolean",
          value: patch.fastMode,
        },
      });
    } else {
      const value =
        resolveSelectValue(fastOption, patch.fastMode ? "fast" : "normal") ??
        (patch.fastMode ? "true" : "false");
      calls.push({
        method: "session/set_config_option",
        params: { sessionId, configId: fastOption.configId, value },
      });
    }
  }

  // An agent that offers both surfaces (Cursor) is already served by the
  // config-option calls above; repeating the change as `session/set_model`
  // would re-send effort in a `_meta` field Cursor does not read, and race the
  // `session/update` the config option is about to produce.
  const needsSetModel =
    current.wire.usesSetModel &&
    ((!modelSentAsOption &&
      patch.modelId !== undefined &&
      patch.modelId !== current.composer.selectedModelId) ||
      (!reasoningSentAsOption &&
        patch.reasoningId !== undefined &&
        patch.reasoningId !== current.composer.selectedReasoningId) ||
      (patch.fastMode !== undefined &&
        current.composer.fastModeAvailable &&
        !fastOption &&
        !modelOption));
  if (needsSetModel && nextModelId) {
    const modelId =
      patch.fastMode !== undefined && current.composer.fastModeAvailable && !fastOption
        ? (siblingFastModelId(nextModelId, current.composer.models, nextFast) ?? nextModelId)
        : nextModelId;
    const selected = current.composer.models.find((model) => model.id === modelId);
    // Effort rides along only for agents whose model catalogue owns it. Where a
    // `thought_level` option exists it is the effort surface, and its values are
    // not the `_meta.reasoningEffort` vocabulary this field carries.
    const carry =
      !thoughtOption &&
      nextReasoningId &&
      selected?.reasoning?.some((option) => option.id === nextReasoningId)
        ? nextReasoningId
        : undefined;
    calls.push({
      method: "session/set_model",
      params: {
        sessionId,
        modelId,
        ...(carry ? { _meta: { reasoningEffort: carry } } : {}),
      },
    });
  } else if (
    !current.wire.usesSetModel &&
    !modelOption &&
    patch.modelId &&
    patch.modelId !== current.composer.selectedModelId
  ) {
    // Cursor sometimes advertises an empty `configOptions[model]` list. The
    // startup `--model` flag is the documented pin; `session/set_model` is the
    // in-session attempt when a catalog id is still known.
    calls.push({
      method: "session/set_model",
      params: { sessionId, modelId: patch.modelId },
    });
  }

  return calls;
}

export function mergeComposerCatalog(
  provider: AcpProvider,
  catalogs: NativeAgentComposerState[],
): AgentModel[] {
  const byId = new Map<string, AgentModel>();
  for (const catalog of catalogs) {
    for (const model of catalog.models) {
      if (!byId.has(model.id)) byId.set(model.id, { ...model, platform: provider });
    }
  }
  return [...byId.values()];
}

function composerFromConfigOptions(
  provider: AcpProvider,
  configOptions: AcpConfigOption[],
  availableModeIds: AcpConfigWire["availableModeIds"],
  currentModeId: string | undefined,
): NativeAgentComposerState {
  const modelOption = selectOption(configOptions, "model");
  const thoughtOption = selectOption(configOptions, "thought_level");
  const fastOption = selectFastOption(configOptions);
  const { options: reasoning, selectedId } = reasoningFromOptions(thoughtOption);
  const selectedReasoningId = selectedId ?? reasoning[0]?.id;
  const models = (modelOption?.options ?? []).map((option): AgentModel => {
    const fastSibling = hasFastSibling(option.value, modelOption?.options ?? []);
    return {
      platform: provider,
      id: option.value,
      label: option.name || option.value,
      description: option.description,
      providerLabel: PLATFORM_LABEL[provider],
      reasoning: reasoning.length > 0 ? reasoning : undefined,
      defaultReasoningId: selectedReasoningId,
      supportsSpeed: Boolean(fastOption) || fastSibling,
      supportsMode: Object.keys(availableModeIds).length > 0,
    };
  });
  const selectedModelId = optionCurrentString(modelOption) || models[0]?.id;
  const selected = models.find((model) => model.id === selectedModelId) ?? models[0];
  const fastModeAvailable = Boolean(fastOption) || selected?.supportsSpeed === true;
  const fastModeEnabled = fastOption
    ? fastModeFromOption(fastOption)
    : selected
      ? isFastModelId(selected.id)
      : null;
  return {
    models,
    selectedModelId: selected?.id,
    selectedReasoningId: reasoning.length > 0 ? selectedReasoningId : undefined,
    fastModeEnabled: fastModeAvailable ? fastModeEnabled : null,
    fastModeAvailable,
    selectedModeId: mapModeId(currentModeId),
    modes:
      Object.keys(availableModeIds).length > 0
        ? CONVERSATION_MODES.filter((mode) => availableModeIds[mode.id])
        : [],
  };
}

/**
 * Cursor advertises `models.availableModels` *and* `configOptions`, but its
 * catalogue entries carry no `_meta.reasoningEfforts` — effort and fast mode
 * live in the `thought_level` / `model_config` config options instead. So the
 * catalogue path has to fall back to those options, otherwise selecting a model
 * by id silently costs the user the reasoning and speed controls the agent
 * really does support. Grok, which sends no config options, is unaffected.
 */
function composerFromGrokModels(
  provider: AcpProvider,
  catalog: GrokModelCatalog,
  availableModeIds: AcpConfigWire["availableModeIds"],
  currentModeId: string | undefined,
  configOptions: AcpConfigOption[] = [],
): NativeAgentComposerState {
  const shared = reasoningFromOptions(selectOption(configOptions, "thought_level"));
  const fastOption = selectFastOption(configOptions);
  const models = catalog.models.map((entry): AgentModel => {
    const own = entry.reasoningEfforts.map((id) => reasoningOption(id));
    // A live config option is Cursor's authoritative reasoning surface. The
    // catalogue metadata may have been reconstructed from an older composer
    // snapshot by `applyConfigOptionUpdate`, so allowing it to win here would
    // freeze obsolete values and discard the option's vendor-provided labels.
    const reasoning = shared.options.length > 0 ? shared.options : own;
    const fastSibling = catalog.models.some(
      (candidate) =>
        candidate.modelId !== entry.modelId &&
        sameModelFamily(candidate.modelId, entry.modelId) &&
        isFastModelId(candidate.modelId) !== isFastModelId(entry.modelId),
    );
    return {
      platform: provider,
      id: entry.modelId,
      label: entry.name || entry.modelId,
      description: entry.description,
      providerLabel: PLATFORM_LABEL[provider],
      reasoning: reasoning.length > 0 ? reasoning : undefined,
      defaultReasoningId:
        shared.options.length > 0
          ? (shared.selectedId ?? fallbackReasoningId(reasoning))
          : (entry.reasoningEffort ?? fallbackReasoningId(reasoning)),
      supportsSpeed: fastSibling || Boolean(fastOption),
      supportsMode: Object.keys(availableModeIds).length > 0,
      ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
    };
  });
  const selected = models.find((model) => model.id === catalog.currentModelId) ?? models[0];
  const selectedReasoning = catalog.models.find((entry) => entry.modelId === selected?.id);
  const fastState = fastModeFromOption(fastOption);
  return {
    models,
    selectedModelId: selected?.id,
    // The config option is the agent's live effort state, so it outranks a
    // per-model default carried over from the previous snapshot.
    selectedReasoningId:
      shared.selectedId ?? selectedReasoning?.reasoningEffort ?? selected?.defaultReasoningId,
    fastModeEnabled: fastOption
      ? fastState
      : selected?.supportsSpeed
        ? isFastModelId(selected.id)
        : null,
    fastModeAvailable: selected?.supportsSpeed === true,
    selectedModeId: mapModeId(currentModeId),
    modes:
      Object.keys(availableModeIds).length > 0
        ? CONVERSATION_MODES.filter((mode) => availableModeIds[mode.id])
        : [],
  };
}

function withModes(
  composer: NativeAgentComposerState,
  availableModeIds: AcpConfigWire["availableModeIds"],
  currentModeId: string | undefined,
): NativeAgentComposerState {
  if (composer.modes.length > 0) {
    return { ...composer, selectedModeId: composer.selectedModeId ?? mapModeId(currentModeId) };
  }
  const modes = CONVERSATION_MODES.filter((mode) => availableModeIds[mode.id]);
  if (modes.length === 0) return composer;
  return {
    ...composer,
    modes,
    selectedModeId: mapModeId(currentModeId),
    models: composer.models.map((model) => ({ ...model, supportsMode: true })),
  };
}

interface ParsedMode {
  id: string;
  name: string;
}

function parseAvailableModes(value: unknown): { currentId?: string; available: ParsedMode[] } {
  if (!isObject(value)) return { available: [] };
  const available = Array.isArray(value.availableModes)
    ? value.availableModes.flatMap((candidate) => {
        if (!isObject(candidate) || typeof candidate.id !== "string") return [];
        return [
          {
            id: candidate.id,
            name: typeof candidate.name === "string" ? candidate.name : candidate.id,
          },
        ];
      })
    : [];
  return {
    currentId: typeof value.currentModeId === "string" ? value.currentModeId : undefined,
    available,
  };
}

function modeIdMap(available: ParsedMode[]): AcpConfigWire["availableModeIds"] {
  const mapped: AcpConfigWire["availableModeIds"] = {};
  for (const mode of available) {
    const conversation = mapModeId(mode.id);
    if (conversation && !mapped[conversation]) mapped[conversation] = mode.id;
  }
  return mapped;
}

function mapModeId(modeId: string | undefined): AgentConversationMode | undefined {
  if (!modeId) return undefined;
  const normalized = modeId.trim().toLowerCase();
  if (
    normalized === "agent" ||
    normalized === "code" ||
    normalized === "build" ||
    normalized === "agentic"
  ) {
    return "build";
  }
  if (normalized === "plan" || normalized === "architect" || normalized === "ask") {
    return "plan";
  }
  return undefined;
}

function reverseModeId(
  availableModeIds: AcpConfigWire["availableModeIds"],
  selected: AgentConversationMode | undefined,
): string | undefined {
  return selected ? availableModeIds[selected] : undefined;
}

function persistedModes(current: AcpNormalizedSessionConfig): Record<string, unknown> {
  return {
    currentModeId: reverseModeId(current.wire.availableModeIds, current.composer.selectedModeId),
    availableModes: Object.entries(current.wire.availableModeIds).map(([id, modeId]) => ({
      id: modeId,
      name: id === "plan" ? "Plan" : "Build",
    })),
  };
}

function parseConfigOptions(value: unknown): AcpConfigOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isObject(candidate)) return [];
    const configId =
      typeof candidate.configId === "string"
        ? candidate.configId
        : typeof candidate.id === "string"
          ? candidate.id
          : "";
    if (!configId) return [];
    const type = candidate.type === "boolean" ? ("boolean" as const) : ("select" as const);
    const currentValue =
      type === "boolean"
        ? candidate.currentValue === true
        : typeof candidate.currentValue === "string"
          ? candidate.currentValue
          : typeof candidate.currentValue === "boolean"
            ? candidate.currentValue
            : "";
    const seenValues = new Set<string>();
    const options = Array.isArray(candidate.options)
      ? candidate.options.flatMap((option) => {
          if (!isObject(option)) return [];
          const optionValue =
            typeof option.value === "string"
              ? option.value
              : typeof option.id === "string"
                ? option.id
                : "";
          // Model ids come straight from here, and a duplicate would fail the
          // persisted validator on the next bridge start.
          if (!optionValue || seenValues.has(optionValue) || seenValues.size >= MAX_CATALOG_MODELS)
            return [];
          seenValues.add(optionValue);
          return [
            {
              value: optionValue,
              name: typeof option.name === "string" ? option.name : optionValue,
              ...(typeof option.description === "string"
                ? { description: option.description }
                : {}),
            },
          ];
        })
      : undefined;
    return [
      {
        configId,
        ...(typeof candidate.category === "string" ? { category: candidate.category } : {}),
        type,
        currentValue,
        ...(options ? { options } : {}),
      },
    ];
  });
}

interface GrokModelEntry {
  modelId: string;
  name: string;
  description?: string;
  reasoningEffort?: string;
  reasoningEfforts: string[];
  /** `_meta.totalContextTokens`; the only context-window size Grok advertises. */
  contextWindow?: number;
}

interface GrokModelCatalog {
  currentModelId?: string;
  models: GrokModelEntry[];
}

function parseGrokModelCatalog(value: unknown): GrokModelCatalog {
  if (!isObject(value)) return { models: [] };
  const list = Array.isArray(value.availableModels) ? value.availableModels : [];
  const seen = new Set<string>();
  const models = list.flatMap((candidate) => {
    if (!isObject(candidate)) return [];
    const modelId =
      typeof candidate.modelId === "string"
        ? candidate.modelId
        : typeof candidate.id === "string"
          ? candidate.id
          : "";
    // A duplicate id would survive normalization but fail the persisted
    // validator, so the bridge would write state it cannot load back.
    if (!modelId || seen.has(modelId) || seen.size >= MAX_CATALOG_MODELS) return [];
    seen.add(modelId);
    const meta = isObject(candidate._meta) ? candidate._meta : {};
    const seenEfforts = new Set<string>();
    const reasoningEfforts = Array.isArray(meta.reasoningEfforts)
      ? meta.reasoningEfforts.flatMap((entry) => {
          const effort =
            typeof entry === "string"
              ? entry
              : isObject(entry) && typeof entry.value === "string"
                ? entry.value
                : "";
          if (!effort || seenEfforts.has(effort) || seenEfforts.size >= MAX_REASONING_OPTIONS)
            return [];
          seenEfforts.add(effort);
          return [effort];
        })
      : [];
    const contextWindow = positiveInteger(meta.totalContextTokens);
    return [
      {
        modelId,
        name: typeof candidate.name === "string" ? candidate.name : modelId,
        ...(typeof candidate.description === "string"
          ? { description: candidate.description }
          : {}),
        ...(typeof meta.reasoningEffort === "string"
          ? { reasoningEffort: meta.reasoningEffort }
          : {}),
        reasoningEfforts,
        ...(contextWindow === undefined ? {} : { contextWindow }),
      },
    ];
  });
  return {
    currentModelId: typeof value.currentModelId === "string" ? value.currentModelId : undefined,
    models,
  };
}

function parsePersistedComposer(
  provider: AcpProvider,
  value: Record<string, unknown>,
): NativeAgentComposerState | null {
  if (
    !Array.isArray(value.models) ||
    value.models.length > MAX_CATALOG_MODELS ||
    !Array.isArray(value.modes) ||
    value.modes.length > CONVERSATION_MODES.length ||
    typeof value.fastModeAvailable !== "boolean" ||
    !(typeof value.fastModeEnabled === "boolean" || value.fastModeEnabled === null)
  )
    return null;

  const models: AgentModel[] = [];
  const modelIds = new Set<string>();
  for (const candidate of value.models) {
    if (!isObject(candidate) || candidate.platform !== provider) return null;
    const id = boundedString(candidate.id, 1_024);
    const label = boundedString(candidate.label, 4_096);
    if (!id || !label || modelIds.has(id)) return null;
    modelIds.add(id);
    let reasoning: AgentReasoningOption[] | undefined;
    if (candidate.reasoning !== undefined) {
      if (!Array.isArray(candidate.reasoning) || candidate.reasoning.length > MAX_REASONING_OPTIONS)
        return null;
      reasoning = [];
      const reasoningIds = new Set<string>();
      for (const option of candidate.reasoning) {
        if (!isObject(option)) return null;
        const optionId = boundedString(option.id, 256);
        const optionLabel = boundedString(option.label, 1_024);
        if (!optionId || !optionLabel || reasoningIds.has(optionId)) return null;
        reasoningIds.add(optionId);
        const description = optionalBoundedString(option.description, 4_096);
        const annotation = optionalBoundedString(option.annotation, 1_024);
        if (description === null || annotation === null) return null;
        reasoning.push({
          id: optionId,
          label: optionLabel,
          ...(description ? { description } : {}),
          ...(annotation ? { annotation } : {}),
        });
      }
    }
    const providerLabel = optionalBoundedString(candidate.providerLabel, 1_024);
    const description = optionalBoundedString(candidate.description, 4_096);
    const defaultReasoningId = optionalBoundedString(candidate.defaultReasoningId, 256);
    if (providerLabel === null || description === null || defaultReasoningId === null) return null;
    if (
      (candidate.supportsSpeed !== undefined && typeof candidate.supportsSpeed !== "boolean") ||
      (candidate.supportsMode !== undefined && typeof candidate.supportsMode !== "boolean")
    )
      return null;
    const contextWindow = positiveInteger(candidate.contextWindow);
    if (candidate.contextWindow !== undefined && contextWindow === undefined) return null;
    models.push({
      platform: provider,
      id,
      label,
      ...(providerLabel ? { providerLabel } : {}),
      ...(description ? { description } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(defaultReasoningId ? { defaultReasoningId } : {}),
      ...(typeof candidate.supportsSpeed === "boolean"
        ? { supportsSpeed: candidate.supportsSpeed }
        : {}),
      ...(typeof candidate.supportsMode === "boolean"
        ? { supportsMode: candidate.supportsMode }
        : {}),
      ...(contextWindow === undefined ? {} : { contextWindow }),
    });
  }

  const modes: NativeAgentComposerState["modes"] = [];
  const modeIds = new Set<AgentConversationMode>();
  for (const candidate of value.modes) {
    if (!isObject(candidate) || (candidate.id !== "build" && candidate.id !== "plan")) return null;
    const label = boundedString(candidate.label, 1_024);
    if (!label || modeIds.has(candidate.id)) return null;
    modeIds.add(candidate.id);
    modes.push({ id: candidate.id, label });
  }

  const selectedModelId = optionalBoundedString(value.selectedModelId, 1_024);
  const selectedReasoningId = optionalBoundedString(value.selectedReasoningId, 256);
  if (selectedModelId === null || selectedReasoningId === null) return null;
  if (
    value.selectedModeId !== undefined &&
    value.selectedModeId !== "build" &&
    value.selectedModeId !== "plan"
  ) {
    return null;
  }
  return {
    models,
    ...(selectedModelId ? { selectedModelId } : {}),
    ...(selectedReasoningId ? { selectedReasoningId } : {}),
    fastModeEnabled: value.fastModeEnabled,
    fastModeAvailable: value.fastModeAvailable,
    ...(value.selectedModeId ? { selectedModeId: value.selectedModeId } : {}),
    modes,
  };
}

function parsePersistedWire(value: Record<string, unknown>): AcpConfigWire | null {
  if (
    !Array.isArray(value.configOptions) ||
    value.configOptions.length > 64 ||
    !isObject(value.availableModeIds) ||
    typeof value.usesSetModel !== "boolean"
  )
    return null;
  const configOptions = parseConfigOptions(value.configOptions);
  if (configOptions.length !== value.configOptions.length) return null;
  const availableModeIds: AcpConfigWire["availableModeIds"] = {};
  for (const mode of ["build", "plan"] as const) {
    const modeId = optionalBoundedString(value.availableModeIds[mode], 256);
    if (modeId === null) return null;
    if (modeId) availableModeIds[mode] = modeId;
  }
  const currentModelId = optionalBoundedString(value.currentModelId, 1_024);
  if (currentModelId === null) return null;
  return {
    configOptions,
    availableModeIds,
    usesSetModel: value.usesSetModel,
    ...(currentModelId ? { currentModelId } : {}),
  };
}

function selectOption(options: AcpConfigOption[], category: string): AcpConfigOption | undefined {
  return (
    options.find((option) => option.category === category) ??
    options.find((option) => option.configId === category)
  );
}

function optionCurrentString(option: AcpConfigOption | undefined): string | undefined {
  return option && typeof option.currentValue === "string" ? option.currentValue : undefined;
}

function optionIsEnabled(option: AcpConfigOption): boolean {
  if (option.currentValue === true) return true;
  const current = optionCurrentString(option);
  return current !== undefined && isFastValue(current);
}

function selectFastOption(options: AcpConfigOption[]): AcpConfigOption | undefined {
  return (
    options.find(
      (option) => option.category === "model_config" && /fast|speed|variant/i.test(option.configId),
    ) ??
    options.find((option) => option.category === "model_config" && option.type === "boolean") ??
    options.find((option) => /fast|speed/i.test(option.configId))
  );
}

function resolveSelectValue(option: AcpConfigOption, requested: string): string | undefined {
  if (!option.options || option.options.length === 0) return requested;
  if (option.options.some((entry) => entry.value === requested)) return requested;
  const byName = option.options.find((entry) => entry.name === requested);
  return byName?.value;
}

function reasoningFromOptions(thoughtOption: AcpConfigOption | undefined): {
  options: AgentReasoningOption[];
  selectedId?: string;
} {
  if (!thoughtOption) return { options: [] };
  const options = (thoughtOption.options ?? [])
    .slice(0, MAX_REASONING_OPTIONS)
    .map((option) => reasoningOption(option.value, option.name));
  const current = optionCurrentString(thoughtOption);
  return { options, ...(current ? { selectedId: current } : {}) };
}

function fastModeFromOption(fastOption: AcpConfigOption | undefined): boolean {
  if (!fastOption) return false;
  return fastOption.type === "boolean"
    ? fastOption.currentValue === true
    : isFastValue(optionCurrentString(fastOption) ?? "");
}

function reasoningOption(id: string, label?: string): AgentReasoningOption {
  return { id, label: label && label !== id ? label : effortLabel(id) };
}

function effortLabel(effort: string): string {
  if (effort === "xhigh") return "Extra high";
  return effort.replace(/[-_]+/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

function isFastModelId(id: string): boolean {
  return /(?:^|[-_[\]])fast(?:$|[\],])/i.test(id) || /\[fast\s*=\s*true\]/i.test(id);
}

function isFastValue(value: string): boolean {
  return value === "fast" || value === "true" || isFastModelId(value);
}

function hasFastSibling(id: string, options: AcpConfigOptionValue[]): boolean {
  return options.some(
    (option) =>
      option.value !== id &&
      sameModelFamily(option.value, id) &&
      isFastModelId(option.value) !== isFastModelId(id),
  );
}

function sameModelFamily(left: string, right: string): boolean {
  return stripFastDecorators(left) === stripFastDecorators(right);
}

function stripFastDecorators(id: string): string {
  return id
    .replace(/\[fast\s*=\s*(true|false)\]/gi, "")
    .replace(/[-_]fast$/i, "")
    .replace(/fast[-_]/i, "")
    .trim();
}

function siblingFastModelId(
  modelId: string,
  models: AgentModel[],
  fast: boolean,
): string | undefined {
  if (isFastModelId(modelId) === fast) return modelId;
  return models.find(
    (model) => sameModelFamily(model.id, modelId) && isFastModelId(model.id) === fast,
  )?.id;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function boundedString(value: unknown, maximumBytes: number): string | undefined {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maximumBytes
    ? value
    : undefined;
}

/** Vendor token counts, kept sane enough that a garbage value cannot render. */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function optionalBoundedString(value: unknown, maximumBytes: number): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && Buffer.byteLength(value) <= maximumBytes ? value : null;
}

export { EMPTY_NATIVE_AGENT_COMPOSER_STATE };
