import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { useCallback } from "react";
import { toast } from "sonner";
import type { AgentModel, AgentModelRef } from "@orkestrator/protocol/native-agent";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { patchGlobalConfig } from "@/lib/backend";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { defineScopedSlot, isAppCommandScope } from "@/lib/node-scope-slots";
import { configTargetsFor, runConfigCommand } from "@/lib/portal/command-node-config";
import { configStore, useConfigStore } from "@/stores/configStore";

const log = createLogger("web.native-agent");

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

/** This client's favourite writes to one node, kept in the order they were made. */
interface FavoriteWriteQueue {
  tail: Promise<void>;
  revision: number;
  pending: number;
  committed: AgentModelRef[] | undefined;
}

const favoriteWrites = defineScopedSlot<FavoriteWriteQueue>("model-favorite-writes", () => ({
  tail: Promise.resolve(),
  revision: 0,
  pending: 0,
  committed: undefined,
}));

/**
 * Saves the favourite list for `scope`'s node. Favourites are an inherited
 * preference, so under a settings parent the patch reaches the command node
 * and the machine gets no write (`runConfigCommand`'s split); a node without
 * the patch command gets the whole-object write its release expects. The
 * app's command scope keeps `patchGlobalConfig`, which is that same path and
 * what suites spy on.
 */
function saveFavoriteModels(scope: NodeScope, favoriteModels: AgentModelRef[]) {
  const patch = { favoriteModels };
  return isAppCommandScope(scope)
    ? patchGlobalConfig(patch)
    : runConfigCommand(configTargetsFor(scope), "patch_global_config", { patch });
}

function persistFavoriteModels(scope: NodeScope, favoriteModels: AgentModelRef[]): void {
  const config = scope.store(configStore);
  const queue = favoriteWrites(scope);
  const state = config.getState();
  const previous = state.config.global.favoriteModels ?? [];
  if (queue.pending === 0) queue.committed = [...previous];
  queue.pending += 1;
  const writeRevision = ++queue.revision;
  state.updateGlobalConfig({ favoriteModels });
  // Only the list travels: the backend merges it onto its current settings, so
  // a favourite click cannot overwrite settings another window changed. The
  // queue still keeps this client's own writes in the order they were made.
  queue.tail = queue.tail.then(async () => {
    try {
      const saved = await saveFavoriteModels(scope, favoriteModels);
      queue.committed = [...(saved.global.favoriteModels ?? favoriteModels)];
      // A later interaction has already become the optimistic state. The
      // older response is still persisted in order, but must not overwrite it.
      if (writeRevision === queue.revision) {
        config.getState().setConfig(saved);
      }
    } catch (error) {
      // A superseded write is not allowed to roll back a newer user action.
      if (writeRevision === queue.revision) {
        config.getState().updateGlobalConfig({
          favoriteModels: queue.committed ?? previous,
        });
        log.warn("model-favorites.persist-failed", { error: formatLogError(error) });
        toast.error("Could not save model favorites");
      }
    } finally {
      queue.pending -= 1;
      if (queue.pending === 0) queue.committed = undefined;
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

  const { scope } = useScopesWithCommandFallback();

  const toggleFavorite = useCallback(
    (model: AgentModel) => {
      const previous = scope.store(configStore).getState().config.global.favoriteModels ?? [];
      const existingIndex = previous.findIndex(
        (favorite) => favorite.platform === model.platform && favorite.modelId === model.id,
      );
      persistFavoriteModels(
        scope,
        existingIndex >= 0
          ? previous.filter((_, index) => index !== existingIndex)
          : [...previous, { platform: model.platform, modelId: model.id }],
      );
    },
    [scope],
  );

  const reorderFavorites = useCallback(
    (favoriteModels: AgentModelRef[]) => {
      const previous = scope.store(configStore).getState().config.global.favoriteModels ?? [];
      if (previous.length !== favoriteModels.length) return;
      const sameOrder = previous.every(
        (favorite, index) =>
          favoriteModelKey(favorite) === favoriteModelKey(favoriteModels[index]!),
      );
      if (sameOrder) return;
      persistFavoriteModels(scope, favoriteModels);
    },
    [scope],
  );

  return { favorites, enabledPlatforms, toggleFavorite, reorderFavorites };
}
