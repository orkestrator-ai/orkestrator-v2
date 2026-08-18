import { getAgentModelCatalogCache } from "@/lib/backend";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { useAgentModelCatalogStore } from "@/stores/agentModelCatalogStore";

/**
 * Rehydrate model pickers from disk before React mounts. Network-backed bridge
 * discovery can then refresh these stores without leaving the first new-
 * environment dialog stuck on the bundled fallback catalogue.
 */
export async function hydrateAgentModelCatalogCache(): Promise<void> {
  const claudeModelsBeforeRead = useClaudeStore.getState().models;
  const codexModelsBeforeRead = useCodexStore.getState().models;
  const cursorModelsBeforeRead = useAgentModelCatalogStore.getState().cursorModels;
  const grokModelsBeforeRead = useAgentModelCatalogStore.getState().grokModels;
  const cache = await getAgentModelCatalogCache();
  if (cache.claude?.models.length && useClaudeStore.getState().models === claudeModelsBeforeRead) {
    useClaudeStore.getState().setModels(cache.claude.models);
  }
  if (cache.codex?.models.length && useCodexStore.getState().models === codexModelsBeforeRead) {
    useCodexStore.getState().setModels(cache.codex.models);
  }
  const currentAcpModels = useAgentModelCatalogStore.getState();
  useAgentModelCatalogStore.setState({
    ...(cache.cursor?.models.length && currentAcpModels.cursorModels === cursorModelsBeforeRead
      ? { cursorModels: cache.cursor.models }
      : {}),
    ...(cache.grok?.models.length && currentAcpModels.grokModels === grokModelsBeforeRead
      ? { grokModels: cache.grok.models }
      : {}),
  });
}
