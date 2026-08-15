import { create } from "zustand";
import type { AgentModel } from "@orkestrator/protocol/native-agent";

interface AgentModelCatalogState {
  /**
   * Reactive mirrors of the backend-owned, host-wide ACP catalog cache.
   * Persistence remains entirely in the backend; these arrays only let every
   * mounted launcher observe one hydrated snapshot.
   */
  cursorModels: AgentModel[];
  grokModels: AgentModel[];
  setAcpModels: (models: AgentModel[]) => void;
}

export const useAgentModelCatalogStore = create<AgentModelCatalogState>((set) => ({
  cursorModels: [],
  grokModels: [],
  setAcpModels: (models) => {
    const cursorModels = models.filter((model) => model.platform === "cursor");
    const grokModels = models.filter((model) => model.platform === "grok");
    if (cursorModels.length === 0 && grokModels.length === 0) return;
    set((state) => ({
      ...(cursorModels.length > 0 ? { cursorModels } : { cursorModels: state.cursorModels }),
      ...(grokModels.length > 0 ? { grokModels } : { grokModels: state.grokModels }),
    }));
  },
}));

/** Publish a backend-normalized catalogue to every model-catalog consumer. */
export function syncCachedAcpModels(models: AgentModel[]): void {
  useAgentModelCatalogStore.getState().setAcpModels(models);
}
