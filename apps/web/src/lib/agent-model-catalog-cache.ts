import { getAgentModelCatalogCache } from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createConfigIntegrationsApi } from "@/lib/backend/config-integrations";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope } from "@/lib/node-scope-slots";
import { agentModelCatalogStore } from "@/stores/agentModelCatalogStore";

/**
 * Rehydrate model pickers from disk before React mounts. When Pi has no durable
 * entry yet, the backend may use a short-lived, environment-free bridge to seed
 * it; startup still bounds this call and lets the stores update when it settles.
 * `seed` also downloads any enabled platform's missing catalogue (a first run).
 *
 * The cache is `scope`'s node's, read from that node into that scope's store
 * (plan item 3003); with no `scope`, the app's command scope (startup).
 */
export async function hydrateAgentModelCatalogCache(
  options: { seed?: boolean; scope?: NodeScope } = {},
): Promise<void> {
  const { scope = appCommandScope(), ...readOptions } = options;
  // Held across the await: the scope may be disposed by the time it answers.
  const store = scope.store(agentModelCatalogStore);
  const before = store.getState();
  const claudeModelsBeforeRead = before.claudeModels;
  const codexModelsBeforeRead = before.codexModels;
  const cursorModelsBeforeRead = before.cursorModels;
  const grokModelsBeforeRead = before.grokModels;
  const piModelsBeforeRead = before.piModels;
  const cache = await backendApiForScope(scope, createConfigIntegrationsApi, {
    getAgentModelCatalogCache,
  }).getAgentModelCatalogCache(undefined, readOptions);
  if (cache.claude?.models.length && store.getState().claudeModels === claudeModelsBeforeRead) {
    store.getState().setClaudeModels(cache.claude.models);
  }
  if (cache.codex?.models.length && store.getState().codexModels === codexModelsBeforeRead) {
    store.getState().setCodexModels(cache.codex.models);
  }
  const currentAcpModels = store.getState();
  store.setState({
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
