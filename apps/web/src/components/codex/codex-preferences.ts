import {
  DEFAULT_CODEX_MODEL,
  type CodexModel,
  type CodexReasoningEffort,
} from "@/lib/codex-client";
import type { AppConfig, GlobalConfig } from "@/types";
import { resolveReasoningId } from "@orkestrator/protocol/native-agent";

const DEFAULT_REASONING_EFFORT: CodexReasoningEffort = "high";

export interface CodexPreferenceSelection {
  model: string;
  reasoningEffort: CodexReasoningEffort;
}

export function getPersistedCodexPreferences(config: AppConfig): CodexPreferenceSelection {
  return {
    model: config.global.codexModel || DEFAULT_CODEX_MODEL,
    reasoningEffort:
      (config.global.codexReasoningEffort as CodexReasoningEffort | undefined) ||
      DEFAULT_REASONING_EFFORT,
  };
}

export function resolveReasoningEffort(
  modelId: string,
  models: CodexModel[],
  storedEffort?: CodexReasoningEffort,
): CodexReasoningEffort {
  const model = models.find((entry) => entry.id === modelId);
  // A model the local catalog does not know still has to offer a real choice,
  // so the placeholder spans both efforts rather than repeating the default.
  const supportedEfforts = model?.reasoningEfforts?.length
    ? model.reasoningEfforts
    : (["medium", "high"] as CodexReasoningEffort[]);

  // `resolveReasoningId` owns the whole policy: a still-supported stored effort
  // wins, otherwise "high" when offered, otherwise the model's advertised
  // default, otherwise the first supported effort. It only returns undefined for
  // an empty catalog, which `supportedEfforts` can never be.
  return (
    (resolveReasoningId(supportedEfforts, storedEffort, model?.defaultReasoningEffort) as
      | CodexReasoningEffort
      | undefined) ?? DEFAULT_REASONING_EFFORT
  );
}

export function resolveCodexPreferenceSelection(options: {
  models: CodexModel[];
  storedModel?: string;
  storedReasoningEffort?: CodexReasoningEffort;
  persistedModel?: string;
  persistedReasoningEffort?: CodexReasoningEffort;
}): CodexPreferenceSelection {
  const { models, storedModel, storedReasoningEffort, persistedModel, persistedReasoningEffort } =
    options;
  const availableModelIds = new Set(models.map((model) => model.id));
  const model =
    storedModel && availableModelIds.has(storedModel)
      ? storedModel
      : persistedModel && availableModelIds.has(persistedModel)
        ? persistedModel
        : (models[0]?.id ?? DEFAULT_CODEX_MODEL);

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
  if (currentPreferences.model === model && currentPreferences.reasoningEffort === effort) {
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
