import { useCallback } from "react";
import { toast } from "sonner";
import type { AgentModel, AgentModelRef } from "@orkestrator/protocol/native-agent";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { updateGlobalConfig as persistGlobalConfig } from "@/lib/backend";
import { useConfigStore } from "@/stores/configStore";

const EMPTY_FAVORITE_MODELS: AgentModelRef[] = [];
const DEFAULT_ENABLED_PLATFORMS: AgentPlatform[] = ["claude", "codex", "opencode"];

/** Stable id for a favourite row across the picker and drag-and-drop. */
export function favoriteModelKey(favorite: AgentModelRef): string {
  return `${favorite.platform}:${favorite.modelId}`;
}

/**
 * Move one favourite to another favourite's index. Returns `null` when the
 * ids do not both exist or the order would not change.
 */
export function reorderFavoriteModels(
  favorites: AgentModelRef[],
  activeKey: string,
  overKey: string,
): AgentModelRef[] | null {
  if (activeKey === overKey) return null;
  const oldIndex = favorites.findIndex((favorite) => favoriteModelKey(favorite) === activeKey);
  const newIndex = favorites.findIndex((favorite) => favoriteModelKey(favorite) === overKey);
  if (oldIndex < 0 || newIndex < 0) return null;
  const next = [...favorites];
  const [removed] = next.splice(oldIndex, 1);
  if (!removed) return null;
  next.splice(newIndex, 0, removed);
  return next;
}

function persistFavoriteModels(favoriteModels: AgentModelRef[]): void {
  const state = useConfigStore.getState();
  const previous = state.config.global.favoriteModels ?? [];
  state.updateGlobalConfig({ favoriteModels });
  void persistGlobalConfig({ ...state.config.global, favoriteModels })
    .then((config) => useConfigStore.getState().setConfig(config))
    .catch((error) => {
      useConfigStore.getState().updateGlobalConfig({ favoriteModels: previous });
      console.warn("[AgentModelPicker] Failed to persist favorites:", error);
      toast.error("Could not save model favorites");
    });
}

export function useAgentModelFavorites() {
  const favorites = useConfigStore(
    (state) => state.config.global.favoriteModels ?? EMPTY_FAVORITE_MODELS,
  );
  const enabledPlatforms = useConfigStore(
    (state): AgentPlatform[] => state.config.global.enabledAgentPlatforms ?? DEFAULT_ENABLED_PLATFORMS,
  );

  const toggleFavorite = useCallback((model: AgentModel) => {
    const previous = useConfigStore.getState().config.global.favoriteModels ?? [];
    const existingIndex = previous.findIndex(
      (favorite) => favorite.platform === model.platform && favorite.modelId === model.id,
    );
    persistFavoriteModels(
      existingIndex >= 0
        ? previous.filter((_, index) => index !== existingIndex)
        : [...previous, { platform: model.platform, modelId: model.id }],
    );
  }, []);

  const reorderFavorites = useCallback((favoriteModels: AgentModelRef[]) => {
    const previous = useConfigStore.getState().config.global.favoriteModels ?? [];
    if (previous.length !== favoriteModels.length) return;
    const sameOrder = previous.every(
      (favorite, index) => favoriteModelKey(favorite) === favoriteModelKey(favoriteModels[index]!),
    );
    if (sameOrder) return;
    persistFavoriteModels(favoriteModels);
  }, []);

  return { favorites, enabledPlatforms, toggleFavorite, reorderFavorites };
}
