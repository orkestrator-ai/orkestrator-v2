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
    currentModelId: grokModels.currentModelId
      ?? optionCurrentString(selectOption(configOptions, "model")),
  };

  const composer = usesSetModel
    ? composerFromGrokModels(provider, grokModels, availableModeIds, modes.currentId)
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
              reasoningEffort: model.id === current.composer.selectedModelId
                ? current.composer.selectedReasoningId
                : model.defaultReasoningId,
              reasoningEfforts: model.reasoning?.map((option) => ({ value: option.id })),
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
      modes: current.composer.modes.length > 0
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
  const modelId = typeof root.model_id === "string"
    ? root.model_id
    : typeof root.modelId === "string"
      ? root.modelId
      : current.composer.selectedModelId;
  const effort = typeof root.reasoning_effort === "string"
    ? root.reasoning_effort
    : current.composer.selectedReasoningId;
  const models = current.composer.models.map((model) => (
    model.id === modelId && effort
      ? { ...model, defaultReasoningId: model.defaultReasoningId }
      : model
  ));
  const selected = models.find((model) => model.id === modelId) ?? models[0];
  return {
    wire: { ...current.wire, currentModelId: selected?.id },
    composer: {
      ...current.composer,
      models,
      selectedModelId: selected?.id,
      selectedReasoningId: effort && selected?.reasoning?.some((option) => option.id === effort)
        ? effort
        : selected?.defaultReasoningId,
      fastModeAvailable: selected?.supportsSpeed === true,
      fastModeEnabled: selected?.supportsSpeed === true
        ? isFastModelId(selected.id)
        : null,
    },
  };
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

  if (patch.mode && current.wire.availableModeIds[patch.mode]
    && patch.mode !== current.composer.selectedModeId) {
    calls.push({
      method: "session/set_mode",
      params: { sessionId, modeId: current.wire.availableModeIds[patch.mode]! },
    });
  }

  if (modelOption && patch.modelId && patch.modelId !== optionCurrentString(modelOption)) {
    const value = resolveSelectValue(modelOption, patch.modelId);
    if (value !== undefined) {
      calls.push({
        method: "session/set_config_option",
        params: { sessionId, configId: modelOption.configId, value },
      });
    }
  }

  if (thoughtOption && patch.reasoningId
    && patch.reasoningId !== optionCurrentString(thoughtOption)) {
    const value = resolveSelectValue(thoughtOption, patch.reasoningId);
    if (value !== undefined) {
      calls.push({
        method: "session/set_config_option",
        params: { sessionId, configId: thoughtOption.configId, value },
      });
    }
  }

  if (fastOption && patch.fastMode !== undefined
    && patch.fastMode !== optionIsEnabled(fastOption)) {
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
      const value = resolveSelectValue(fastOption, patch.fastMode ? "fast" : "normal")
        ?? (patch.fastMode ? "true" : "false");
      calls.push({
        method: "session/set_config_option",
        params: { sessionId, configId: fastOption.configId, value },
      });
    }
  }

  const needsSetModel = current.wire.usesSetModel && (
    (patch.modelId !== undefined && patch.modelId !== current.composer.selectedModelId)
    || (patch.reasoningId !== undefined && patch.reasoningId !== current.composer.selectedReasoningId)
    || (
      patch.fastMode !== undefined
      && current.composer.fastModeAvailable
      && !fastOption
      && !modelOption
    )
  );
  if (needsSetModel && nextModelId) {
    const modelId = patch.fastMode !== undefined && current.composer.fastModeAvailable && !fastOption
      ? siblingFastModelId(nextModelId, current.composer.models, nextFast) ?? nextModelId
      : nextModelId;
    const selected = current.composer.models.find((model) => model.id === modelId);
    const carry = nextReasoningId
      && selected?.reasoning?.some((option) => option.id === nextReasoningId)
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
    !current.wire.usesSetModel
    && !modelOption
    && patch.modelId
    && patch.modelId !== current.composer.selectedModelId
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
  const reasoning = thoughtOption
    ? (thoughtOption.options ?? []).map((option) => reasoningOption(option.value, option.name))
    : [];
  const selectedReasoningId = optionCurrentString(thoughtOption)
    ?? reasoning[0]?.id;
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
  const selectedModelId = optionCurrentString(modelOption)
    || models[0]?.id;
  const selected = models.find((model) => model.id === selectedModelId) ?? models[0];
  const fastModeAvailable = Boolean(fastOption) || selected?.supportsSpeed === true;
  const fastModeEnabled = fastOption
    ? fastOption.type === "boolean"
      ? fastOption.currentValue === true
      : isFastValue(optionCurrentString(fastOption) ?? "")
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
    modes: Object.keys(availableModeIds).length > 0
      ? CONVERSATION_MODES.filter((mode) => availableModeIds[mode.id])
      : [],
  };
}

function composerFromGrokModels(
  provider: AcpProvider,
  catalog: GrokModelCatalog,
  availableModeIds: AcpConfigWire["availableModeIds"],
  currentModeId: string | undefined,
): NativeAgentComposerState {
  const models = catalog.models.map((entry): AgentModel => {
    const reasoning = entry.reasoningEfforts.map((id) => reasoningOption(id));
    const fastSibling = catalog.models.some((candidate) => (
      candidate.modelId !== entry.modelId
      && sameModelFamily(candidate.modelId, entry.modelId)
      && isFastModelId(candidate.modelId) !== isFastModelId(entry.modelId)
    ));
    return {
      platform: provider,
      id: entry.modelId,
      label: entry.name || entry.modelId,
      description: entry.description,
      providerLabel: PLATFORM_LABEL[provider],
      reasoning: reasoning.length > 0 ? reasoning : undefined,
      defaultReasoningId: entry.reasoningEffort ?? reasoning[0]?.id,
      supportsSpeed: fastSibling,
      supportsMode: Object.keys(availableModeIds).length > 0,
    };
  });
  const selected = models.find((model) => model.id === catalog.currentModelId) ?? models[0];
  const selectedReasoning = catalog.models.find((entry) => entry.modelId === selected?.id);
  return {
    models,
    selectedModelId: selected?.id,
    selectedReasoningId: selectedReasoning?.reasoningEffort
      ?? selected?.defaultReasoningId,
    fastModeEnabled: selected?.supportsSpeed ? isFastModelId(selected.id) : null,
    fastModeAvailable: selected?.supportsSpeed === true,
    selectedModeId: mapModeId(currentModeId),
    modes: Object.keys(availableModeIds).length > 0
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
        return [{
          id: candidate.id,
          name: typeof candidate.name === "string" ? candidate.name : candidate.id,
        }];
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
  if (normalized === "agent" || normalized === "code" || normalized === "build" || normalized === "agentic") {
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

function parseConfigOptions(value: unknown): AcpConfigOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isObject(candidate)) return [];
    const configId = typeof candidate.configId === "string"
      ? candidate.configId
      : typeof candidate.id === "string"
        ? candidate.id
        : "";
    if (!configId) return [];
    const type = candidate.type === "boolean" ? "boolean" as const : "select" as const;
    const currentValue = type === "boolean"
      ? candidate.currentValue === true
      : typeof candidate.currentValue === "string"
        ? candidate.currentValue
        : typeof candidate.currentValue === "boolean"
          ? candidate.currentValue
          : "";
    const options = Array.isArray(candidate.options)
      ? candidate.options.flatMap((option) => {
          if (!isObject(option)) return [];
          const optionValue = typeof option.value === "string"
            ? option.value
            : typeof option.id === "string"
              ? option.id
              : "";
          if (!optionValue) return [];
          return [{
            value: optionValue,
            name: typeof option.name === "string" ? option.name : optionValue,
            ...(typeof option.description === "string" ? { description: option.description } : {}),
          }];
        })
      : undefined;
    return [{
      configId,
      ...(typeof candidate.category === "string" ? { category: candidate.category } : {}),
      type,
      currentValue,
      ...(options ? { options } : {}),
    }];
  });
}

interface GrokModelEntry {
  modelId: string;
  name: string;
  description?: string;
  reasoningEffort?: string;
  reasoningEfforts: string[];
}

interface GrokModelCatalog {
  currentModelId?: string;
  models: GrokModelEntry[];
}

function parseGrokModelCatalog(value: unknown): GrokModelCatalog {
  if (!isObject(value)) return { models: [] };
  const list = Array.isArray(value.availableModels) ? value.availableModels : [];
  const models = list.flatMap((candidate) => {
    if (!isObject(candidate)) return [];
    const modelId = typeof candidate.modelId === "string"
      ? candidate.modelId
      : typeof candidate.id === "string"
        ? candidate.id
        : "";
    if (!modelId) return [];
    const meta = isObject(candidate._meta) ? candidate._meta : {};
    const reasoningEfforts = Array.isArray(meta.reasoningEfforts)
      ? meta.reasoningEfforts.flatMap((entry) => {
          if (typeof entry === "string") return [entry];
          if (isObject(entry) && typeof entry.value === "string") return [entry.value];
          return [];
        })
      : [];
    return [{
      modelId,
      name: typeof candidate.name === "string" ? candidate.name : modelId,
      ...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
      ...(typeof meta.reasoningEffort === "string" ? { reasoningEffort: meta.reasoningEffort } : {}),
      reasoningEfforts,
    }];
  });
  return {
    currentModelId: typeof value.currentModelId === "string" ? value.currentModelId : undefined,
    models,
  };
}

function selectOption(
  options: AcpConfigOption[],
  category: string,
): AcpConfigOption | undefined {
  return options.find((option) => option.category === category)
    ?? options.find((option) => option.configId === category);
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
  return options.find((option) =>
    option.category === "model_config"
    && /fast|speed|variant/i.test(option.configId)
  ) ?? options.find((option) => option.category === "model_config" && option.type === "boolean")
    ?? options.find((option) => /fast|speed/i.test(option.configId));
}

function resolveSelectValue(option: AcpConfigOption, requested: string): string | undefined {
  if (!option.options || option.options.length === 0) return requested;
  if (option.options.some((entry) => entry.value === requested)) return requested;
  const byName = option.options.find((entry) => entry.name === requested);
  return byName?.value;
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
  return options.some((option) => (
    option.value !== id
    && sameModelFamily(option.value, id)
    && isFastModelId(option.value) !== isFastModelId(id)
  ));
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
  return models.find((model) => (
    sameModelFamily(model.id, modelId) && isFastModelId(model.id) === fast
  ))?.id;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export { EMPTY_NATIVE_AGENT_COMPOSER_STATE };
