import { getAgentModelCatalogCache } from "@/lib/backend";
import { useAgentModelCatalogStore } from "@/stores/agentModelCatalogStore";

/**
 * Rehydrate model pickers from disk before React mounts. When Pi has no durable
 * entry yet, the backend may use a short-lived, environment-free bridge to seed
 * it; startup still bounds this call and lets the stores update when it settles.
 * `seed` also downloads any enabled platform's missing catalogue (a first run).
 */
export async function hydrateAgentModelCatalogCache(
  options: { seed?: boolean } = {},
): Promise<void> {
  const claudeModelsBeforeRead = useAgentModelCatalogStore.getState().claudeModels;
  const codexModelsBeforeRead = useAgentModelCatalogStore.getState().codexModels;
  const cursorModelsBeforeRead = useAgentModelCatalogStore.getState().cursorModels;
  const grokModelsBeforeRead = useAgentModelCatalogStore.getState().grokModels;
  const piModelsBeforeRead = useAgentModelCatalogStore.getState().piModels;
  const cache = await getAgentModelCatalogCache(undefined, options);
  if (
    cache.claude?.models.length &&
    useAgentModelCatalogStore.getState().claudeModels === claudeModelsBeforeRead
  ) {
    useAgentModelCatalogStore.getState().setClaudeModels(cache.claude.models);
  }
  if (
    cache.codex?.models.length &&
    useAgentModelCatalogStore.getState().codexModels === codexModelsBeforeRead
  ) {
    useAgentModelCatalogStore.getState().setCodexModels(cache.codex.models);
  }
  const currentAcpModels = useAgentModelCatalogStore.getState();
  useAgentModelCatalogStore.setState({
    ...(cache.cursor?.models.length && currentAcpModels.cursorModels === cursorModelsBeforeRead
      ? { cursorModels: cache.cursor.models }
      : {}),
    ...(cache.grok?.models.length && currentAcpModels.grokModels === grokModelsBeforeRead
      ? { grokModels: cache.grok.models }
      : {}),
    ...(cache.pi?.models.length && currentAcpModels.piModels === piModelsBeforeRead
      ? { piModels: cache.pi.models }
      : {}),
  });
}
