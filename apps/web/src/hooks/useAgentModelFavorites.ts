import { useCallback } from "react";
import { toast } from "sonner";
import type { AgentModel, AgentModelRef } from "@orkestrator/protocol/native-agent";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { updateGlobalConfig as persistGlobalConfig } from "@/lib/backend";
import { useConfigStore } from "@/stores/configStore";

const EMPTY_FAVORITE_MODELS: AgentModelRef[] = [];
const DEFAULT_ENABLED_PLATFORMS: AgentPlatform[] = ["claude", "codex", "opencode"];

export function useAgentModelFavorites() {
  const favorites = useConfigStore(
    (state) => state.config.global.favoriteModels ?? EMPTY_FAVORITE_MODELS,
  );
  const enabledPlatforms = useConfigStore(
    (state): AgentPlatform[] => state.config.global.enabledAgentPlatforms ?? DEFAULT_ENABLED_PLATFORMS,
  );

  const toggleFavorite = useCallback((model: AgentModel) => {
    const state = useConfigStore.getState();
    const previous = state.config.global.favoriteModels ?? [];
    const existingIndex = previous.findIndex(
      (favorite) => favorite.platform === model.platform && favorite.modelId === model.id,
    );
    const favoriteModels = existingIndex >= 0
      ? previous.filter((_, index) => index !== existingIndex)
      : [...previous, { platform: model.platform, modelId: model.id }];
    state.updateGlobalConfig({ favoriteModels });
    void persistGlobalConfig({ ...state.config.global, favoriteModels })
      .then((config) => useConfigStore.getState().setConfig(config))
      .catch((error) => {
        useConfigStore.getState().updateGlobalConfig({ favoriteModels: previous });
        console.warn("[AgentModelPicker] Failed to persist favorites:", error);
        toast.error("Could not save model favorites");
      });
  }, []);

  return { favorites, enabledPlatforms, toggleFavorite };
}
