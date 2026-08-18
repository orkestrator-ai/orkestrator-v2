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

/**
 * Replaces only the visible subset of a filtered favourite list, preserving
 * hidden entries in their original slots.
 */
export function mergeReorderedFavoriteModels(
  allFavorites: AgentModelRef[],
  visibleFavorites: AgentModelRef[],
  reorderedVisibleFavorites: AgentModelRef[],
): AgentModelRef[] | null {
  if (visibleFavorites.length !== reorderedVisibleFavorites.length) return null;

  const visibleKeys = visibleFavorites.map(favoriteModelKey);
  const reorderedKeys = reorderedVisibleFavorites.map(favoriteModelKey);
  const visibleKeySet = new Set(visibleKeys);
  const reorderedKeySet = new Set(reorderedKeys);
  if (
    visibleKeySet.size !== visibleKeys.length ||
    reorderedKeySet.size !== reorderedKeys.length ||
    visibleKeySet.size !== reorderedKeySet.size ||
    visibleKeys.some((key) => !reorderedKeySet.has(key)) ||
    allFavorites.filter((favorite) => visibleKeySet.has(favoriteModelKey(favorite))).length !==
      visibleFavorites.length
  ) {
    return null;
  }

  let visibleIndex = 0;
  return allFavorites.map((favorite) =>
    visibleKeySet.has(favoriteModelKey(favorite))
      ? reorderedVisibleFavorites[visibleIndex++]!
      : favorite,
  );
}

let favoriteWriteTail = Promise.resolve();
let favoriteWriteRevision = 0;
let favoriteWritePending = 0;
let favoriteWriteCommitted: AgentModelRef[] | undefined;

function persistFavoriteModels(favoriteModels: AgentModelRef[]): void {
  const state = useConfigStore.getState();
  const previous = state.config.global.favoriteModels ?? [];
  if (favoriteWritePending === 0) favoriteWriteCommitted = [...previous];
  favoriteWritePending += 1;
  const writeRevision = ++favoriteWriteRevision;
  const global = { ...state.config.global, favoriteModels };
  state.updateGlobalConfig({ favoriteModels });
  favoriteWriteTail = favoriteWriteTail.then(async () => {
    try {
      const config = await persistGlobalConfig(global);
      favoriteWriteCommitted = [...(config.global.favoriteModels ?? favoriteModels)];
      // A later interaction has already become the optimistic state. The
      // older response is still persisted in order, but must not overwrite it.
      if (writeRevision === favoriteWriteRevision) {
        useConfigStore.getState().setConfig(config);
      }
    } catch (error) {
      // A superseded write is not allowed to roll back a newer user action.
      if (writeRevision === favoriteWriteRevision) {
        useConfigStore.getState().updateGlobalConfig({
          favoriteModels: favoriteWriteCommitted ?? previous,
        });
        console.warn("[AgentModelPicker] Failed to persist favorites:", error);
        toast.error("Could not save model favorites");
      }
    } finally {
      favoriteWritePending -= 1;
      if (favoriteWritePending === 0) favoriteWriteCommitted = undefined;
    }
  });
}

export function useAgentModelFavorites() {
  const favorites = useConfigStore(
    (state) => state.config.global.favoriteModels ?? EMPTY_FAVORITE_MODELS,
  );
  const enabledPlatforms = useConfigStore(
    (state): AgentPlatform[] =>
      state.config.global.enabledAgentPlatforms ?? DEFAULT_ENABLED_PLATFORMS,
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
