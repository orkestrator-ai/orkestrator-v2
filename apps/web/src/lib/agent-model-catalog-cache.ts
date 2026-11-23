import { getAgentModelCatalogCache } from "@/lib/backend";
import { backendApiForScope } from "@/lib/backend/client";
import { createConfigIntegrationsApi } from "@/lib/backend/config-integrations";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope } from "@/lib/node-scope-slots";
import type { StoreApi } from "zustand";
import { CODEX_MODELS } from "@/lib/codex-models";
import {
  agentModelCatalogStore,
  type AgentModelCatalogState,
} from "@/stores/agentModelCatalogStore";

type ModelField =
  "claudeModels" | "codexModels" | "cursorModels" | "grokModels" | "piModels" | "antigravityModels";
type AppliedRead = {
  models: AgentModelCatalogState[ModelField];
  request: number;
  confirmedAt: number | null;
};
const cacheReads = new WeakMap<
  StoreApi<AgentModelCatalogState>,
  { request: number; applied: Partial<Record<ModelField, AppliedRead>> }
>();

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
  let reads = cacheReads.get(store);
  if (!reads) {
    reads = { request: 0, applied: {} };
    cacheReads.set(store, reads);
  }
  const { applied } = reads;
  const request = ++reads.request;
  const cache = await backendApiForScope(scope, createConfigIntegrationsApi, {
    getAgentModelCatalogCache,
  }).getAgentModelCatalogCache(undefined, readOptions);
  if (scope.disposed) return;

  const current = store.getState();
  function modelsFromCache<K extends ModelField>(
    field: K,
    entry: { models: AgentModelCatalogState[K]; updatedAt: string } | undefined,
  ): AgentModelCatalogState[K] {
    const models = current[field];
    const previous = applied[field];
    const lastRead = previous?.models === models ? previous : undefined;
    // A live publication during this read wins. Concurrent cache reads can
    // still advance the same platform, using the backend's confirmation time.
    if (models !== before[field] && !lastRead) return models;
    if (!entry?.models.length) return models;
    const confirmedAt = Date.parse(entry.updatedAt) || 0;
    if (lastRead) {
      if (lastRead.confirmedAt === null) {
        if (request < lastRead.request) return models;
      } else if (
        confirmedAt < lastRead.confirmedAt ||
        (confirmedAt === lastRead.confirmedAt && request < lastRead.request)
      ) {
        return models;
      }
    }
    applied[field] = { models: entry.models, confirmedAt, request };
    return entry.models;
  }

  let codexModels = modelsFromCache("codexModels", cache.codex);
  const lastCodexRead = applied.codexModels;
  // A new login may have no saved Codex catalogue yet. Clear the old cached
  // rows if this read has not been overtaken by another publication.
  if (
    !cache.codex?.models.length &&
    lastCodexRead?.confirmedAt != null &&
    lastCodexRead.models === current.codexModels &&
    current.codexModels === before.codexModels &&
    request > lastCodexRead.request
  ) {
    codexModels = CODEX_MODELS;
    applied.codexModels = { models: codexModels, confirmedAt: null, request };
  }

  store.setState({
    claudeModels: modelsFromCache("claudeModels", cache.claude),
    codexModels,
    cursorModels: modelsFromCache("cursorModels", cache.cursor),
    grokModels: modelsFromCache("grokModels", cache.grok),
    piModels: modelsFromCache("piModels", cache.pi),
    antigravityModels: modelsFromCache("antigravityModels", cache.antigravity),
  });
}
