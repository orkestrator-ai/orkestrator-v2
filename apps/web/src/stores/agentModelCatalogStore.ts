import { create } from "zustand";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import type { ClaudeModel } from "@/lib/claude-types";
import { CODEX_MODELS, type CodexModel } from "@/lib/codex-models";
import type { ClaudeModelCatalogSnapshot } from "@/types";

/**
 * Model catalogues for launchers, settings, review options and Claude Tmux.
 *
 * Native sessions are owned by the backend and rendered from the native-agent
 * projection, so this store holds no session state. Each platform has its own
 * entry and fallback policy:
 *
 * - Claude: `claudeModels` is the host-wide catalogue (hydrated from the
 *   backend cache at startup) and starts empty. `claudeModelCatalogs` holds
 *   per-environment discoveries; `getClaudeModels(environmentId)` prefers the
 *   environment's catalogue and falls back to the host-wide list.
 * - Codex: `codexModels` starts at the bundled `CODEX_MODELS`, and
 *   `setCodexModels([])` restores it, so the picker is never left empty.
 * - Cursor, Grok and Pi: `setAcpModels` replaces only the platforms present in
 *   the published catalogue and ignores a catalogue with none of them.
 */
interface AgentModelCatalogState {
  claudeModels: ClaudeModel[];
  claudeModelCatalogs: Map<string, ClaudeModelCatalogSnapshot>;
  codexModels: CodexModel[];
  /**
   * Reactive mirrors of the backend-owned, host-wide ACP catalog cache.
   * Persistence remains entirely in the backend; these arrays only let every
   * mounted launcher observe one hydrated snapshot.
   */
  cursorModels: AgentModel[];
  grokModels: AgentModel[];
  piModels: AgentModel[];

  /** Without an environment, replaces the host-wide Claude catalogue. */
  setClaudeModels: (models: ClaudeModel[], environmentId?: string) => void;
  setClaudeModelCatalog: (catalog: ClaudeModelCatalogSnapshot) => void;
  getClaudeModels: (environmentId: string) => ClaudeModel[];
  getClaudeModelCatalog: (environmentId: string) => ClaudeModelCatalogSnapshot | undefined;
  /** An empty catalogue falls back to the bundled models. */
  setCodexModels: (models: CodexModel[]) => void;
  setAcpModels: (models: AgentModel[]) => void;
}

export const useAgentModelCatalogStore = create<AgentModelCatalogState>((set, get) => ({
  claudeModels: [],
  claudeModelCatalogs: new Map(),
  codexModels: CODEX_MODELS,
  cursorModels: [],
  grokModels: [],
  piModels: [],

  setClaudeModels: (models, environmentId) =>
    set((state) => {
      if (!environmentId) return { claudeModels: models };
      const next = new Map(state.claudeModelCatalogs);
      next.set(environmentId, {
        environmentId,
        models,
        source: "sdk",
        fetchedAt: new Date().toISOString(),
        stale: false,
      });
      return { claudeModelCatalogs: next };
    }),
  setClaudeModelCatalog: (catalog) =>
    set((state) => {
      const next = new Map(state.claudeModelCatalogs);
      next.set(catalog.environmentId, catalog);
      return { claudeModelCatalogs: next };
    }),
  getClaudeModels: (environmentId) =>
    get().claudeModelCatalogs.get(environmentId)?.models ?? get().claudeModels,
  getClaudeModelCatalog: (environmentId) => get().claudeModelCatalogs.get(environmentId),

  setCodexModels: (models) => set({ codexModels: models.length > 0 ? models : CODEX_MODELS }),

  setAcpModels: (models) => {
    const cursorModels = models.filter((model) => model.platform === "cursor");
    const grokModels = models.filter((model) => model.platform === "grok");
    const piModels = models.filter((model) => model.platform === "pi");
    if (cursorModels.length === 0 && grokModels.length === 0 && piModels.length === 0) return;
    set((state) => ({
      ...(cursorModels.length > 0 ? { cursorModels } : { cursorModels: state.cursorModels }),
      ...(grokModels.length > 0 ? { grokModels } : { grokModels: state.grokModels }),
      ...(piModels.length > 0 ? { piModels } : { piModels: state.piModels }),
    }));
  },
}));

/** Publish a backend-normalized catalogue to every model-catalog consumer. */
export function syncCachedAcpModels(models: AgentModel[]): void {
  useAgentModelCatalogStore.getState().setAcpModels(models);
}
