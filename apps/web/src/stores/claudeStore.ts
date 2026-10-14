import { create } from "zustand";
import type { ClaudeModel } from "@/lib/claude-types";
import type { ClaudeModelCatalogSnapshot } from "@/types";

/**
 * Claude model catalogue for launchers, settings and Claude Tmux.
 *
 * Claude Native sessions are owned by the backend and rendered from the
 * native-agent projection, so this store holds no session state. `models` is
 * the host-wide catalogue (hydrated from the backend cache at startup);
 * `modelCatalogs` holds per-environment discoveries that take precedence.
 */
interface ClaudeState {
  models: ClaudeModel[];
  modelCatalogs: Map<string, ClaudeModelCatalogSnapshot>;

  setModels: (models: ClaudeModel[], environmentId?: string) => void;
  setModelCatalog: (catalog: ClaudeModelCatalogSnapshot) => void;

  getModels: (environmentId: string) => ClaudeModel[];
  getModelCatalog: (environmentId: string) => ClaudeModelCatalogSnapshot | undefined;
}

export const useClaudeStore = create<ClaudeState>()((set, get) => ({
  models: [],
  modelCatalogs: new Map(),

  setModels: (models, environmentId) =>
    set((state) => {
      if (!environmentId) return { models };
      const next = new Map(state.modelCatalogs);
      next.set(environmentId, {
        environmentId,
        models,
        source: "sdk",
        fetchedAt: new Date().toISOString(),
        stale: false,
      });
      return { modelCatalogs: next };
    }),

  setModelCatalog: (catalog) =>
    set((state) => {
      const next = new Map(state.modelCatalogs);
      next.set(catalog.environmentId, catalog);
      return { modelCatalogs: next };
    }),

  getModels: (environmentId) => get().modelCatalogs.get(environmentId)?.models ?? get().models,
  getModelCatalog: (environmentId) => get().modelCatalogs.get(environmentId),
}));
