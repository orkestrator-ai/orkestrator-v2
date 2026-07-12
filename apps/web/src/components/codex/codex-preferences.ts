import { DEFAULT_CODEX_MODEL, type CodexModel, type CodexReasoningEffort } from "@/lib/codex-client";
import type { AppConfig, GlobalConfig } from "@/types";

const DEFAULT_REASONING_EFFORT: CodexReasoningEffort = "medium";

export interface CodexPreferenceSelection {
  model: string;
  reasoningEffort: CodexReasoningEffort;
}

export function getPersistedCodexPreferences(config: AppConfig): CodexPreferenceSelection {
  return {
    model: config.global.codexModel || DEFAULT_CODEX_MODEL,
    reasoningEffort: (config.global.codexReasoningEffort as CodexReasoningEffort | undefined)
      || DEFAULT_REASONING_EFFORT,
  };
}

export function resolveReasoningEffort(
  modelId: string,
  models: CodexModel[],
  storedEffort?: CodexReasoningEffort,
): CodexReasoningEffort {
  const model = models.find((entry) => entry.id === modelId);
  const supportedEfforts = model?.reasoningEfforts?.length
    ? model.reasoningEfforts
    : ([DEFAULT_REASONING_EFFORT, "high"] as CodexReasoningEffort[]);

  if (storedEffort && supportedEfforts.includes(storedEffort)) {
    return storedEffort;
  }

  if (
    model?.defaultReasoningEffort
    && supportedEfforts.includes(model.defaultReasoningEffort)
  ) {
    return model.defaultReasoningEffort;
  }

  return supportedEfforts[0] ?? DEFAULT_REASONING_EFFORT;
}

export function resolveCodexPreferenceSelection(options: {
  models: CodexModel[];
  storedModel?: string;
  storedReasoningEffort?: CodexReasoningEffort;
  persistedModel?: string;
  persistedReasoningEffort?: CodexReasoningEffort;
}): CodexPreferenceSelection {
  const {
    models,
    storedModel,
    storedReasoningEffort,
    persistedModel,
    persistedReasoningEffort,
  } = options;
  const availableModelIds = new Set(models.map((model) => model.id));
  const model = storedModel && availableModelIds.has(storedModel)
    ? storedModel
    : persistedModel && availableModelIds.has(persistedModel)
      ? persistedModel
      : models[0]?.id ?? DEFAULT_CODEX_MODEL;

  return {
    model,
    reasoningEffort: resolveReasoningEffort(
      model,
      models,
      storedReasoningEffort ?? persistedReasoningEffort,
    ),
  };
}

export async function persistCodexGlobalPreferences(options: {
  config: AppConfig;
  setConfig: (config: AppConfig) => void;
  persistGlobalConfig: (global: GlobalConfig) => Promise<AppConfig>;
  model: string;
  effort: CodexReasoningEffort;
}): Promise<boolean> {
  const { config, setConfig, persistGlobalConfig, model, effort } = options;
  const currentPreferences = getPersistedCodexPreferences(config);
  if (
    currentPreferences.model === model
    && currentPreferences.reasoningEffort === effort
  ) {
    return true;
  }

  const nextGlobal = {
    ...config.global,
    codexModel: model,
    codexReasoningEffort: effort,
  };

  setConfig({ ...config, global: nextGlobal });

  try {
    const updatedConfig = await persistGlobalConfig(nextGlobal);
    setConfig(updatedConfig);
    return true;
  } catch (error) {
    setConfig(config);
    throw error;
  }
}
