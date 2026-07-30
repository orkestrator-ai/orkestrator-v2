import { getAgentModelCatalogCache } from "@/lib/backend";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";

/**
 * Rehydrate model pickers from disk before React mounts. Network-backed bridge
 * discovery can then refresh these stores without leaving the first new-
 * environment dialog stuck on the bundled fallback catalogue.
 */
export async function hydrateAgentModelCatalogCache(): Promise<void> {
  const claudeModelsBeforeRead = useClaudeStore.getState().models;
  const codexModelsBeforeRead = useCodexStore.getState().models;
  const cache = await getAgentModelCatalogCache();
  if (
    cache.claude?.models.length
    && useClaudeStore.getState().models === claudeModelsBeforeRead
  ) {
    useClaudeStore.getState().setModels(cache.claude.models);
  }
  if (
    cache.codex?.models.length
    && useCodexStore.getState().models === codexModelsBeforeRead
  ) {
    useCodexStore.getState().setModels(cache.codex.models);
  }
}
