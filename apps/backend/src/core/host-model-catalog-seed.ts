import { normalizeAgentPlatforms, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { CommandContext } from "./commands-context.js";
import { asCachedCodexModels } from "./commands-validation.js";
import type {
  HostCatalog,
  refreshHostModelCatalog as RefreshHostModelCatalog,
} from "./host-model-catalog-refresh.js";

// Reserved scope for host-only conversations with no project configuration.
export const HOST_OPENCODE_CATALOG_SCOPE = "host:opencode";

/**
 * Forget recorded failures for a platform in this backend, for example because
 * the user just signed in.
 */
export function resetHostModelCatalogSeedCooldown(
  context: CommandContext,
  agent: AgentPlatform,
): void {
  context.runtime.localServers.catalogSeeds.resetCooldown(agent);
}

/** Save a freshly downloaded host catalogue where the pickers read it from. */
export async function persistHostCatalog(
  context: CommandContext,
  catalog: HostCatalog,
  projectId?: string,
): Promise<void> {
  const { storage } = context;
  if (catalog.agent === "claude") {
    await storage.cacheAgentModelCatalog("claude", catalog.models);
  } else if (catalog.agent === "codex") {
    await storage.cacheAgentModelCatalog("codex", asCachedCodexModels(catalog.models));
  } else if (catalog.agent === "cursor" || catalog.agent === "grok" || catalog.agent === "pi") {
    await storage.cacheAgentModelCatalog(catalog.agent, catalog.models);
  } else {
    projectId ??= HOST_OPENCODE_CATALOG_SCOPE;
    const discovered = catalog.models.map((model) => ({
      id: model.id,
      name: model.label,
      provider: model.id.split("/")[0] || "opencode",
      variants: model.reasoning?.map((option) => option.id).filter((id) => id !== "default"),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(typeof model.supportsImageInput === "boolean"
        ? { supportsImageInput: model.supportsImageInput }
        : {}),
    }));
    // Host discovery deliberately runs outside the worktree trust boundary,
    // so it cannot see repository-defined providers. Augment the existing
    // project snapshot instead of narrowing it to host-only configuration.
    const existing = (await storage.getOpenCodeModelCatalog(projectId))?.models ?? [];
    const merged = new Map(existing.map((model) => [model.id, model]));
    for (const model of discovered) merged.set(model.id, model);
    await storage.cacheOpenCodeModelCatalog(projectId, Array.from(merged.values()));
  }
}

async function hasCachedModels(
  context: CommandContext,
  agent: AgentPlatform,
  projectId?: string,
): Promise<boolean> {
  if (agent === "opencode") {
    projectId ??= HOST_OPENCODE_CATALOG_SCOPE;
    return ((await context.storage.getOpenCodeModelCatalog(projectId))?.models.length ?? 0) > 0;
  }
  const cache = await context.storage.getAgentModelCatalogCache();
  return (cache[agent]?.models.length ?? 0) > 0;
}

/**
 * Download a platform's host catalogue when none is cached yet.
 *
 * Returns whether the durable cache now holds models. It never throws: a host
 * that is not signed in yet is the normal first-run state, and the caller's job
 * is only to try again later. An existing catalogue is left alone — replacing it
 * is the explicit Refresh action.
 */
export function seedHostModelCatalogIfMissing(
  context: CommandContext,
  agent: AgentPlatform,
  refresh: typeof RefreshHostModelCatalog,
  options: { projectId?: string; now?: () => number } = {},
): Promise<boolean> {
  const { projectId, now = Date.now } = options;
  return context.runtime.localServers.catalogSeeds.seed(agent, projectId, {
    cached: () => hasCachedModels(context, agent, projectId),
    download: async () => {
      const catalog = await refresh(context, agent);
      // An empty list is a failed download, not a seeded cache: keeping it
      // would leave `cached()` false and retry it on the next boot anyway.
      if (catalog.models.length === 0) {
        throw new Error(`${agent} returned an empty model catalogue`);
      }
      await persistHostCatalog(context, catalog, projectId);
    },
    now,
  });
}

/**
 * Seed every platform the user has switched on and has no catalogue for.
 *
 * One at a time: each download starts a bridge process, and a first launch
 * should not start six at once. Projectless OpenCode uses the host scope.
 */
export async function seedEnabledHostModelCatalogs(
  context: CommandContext,
  refresh: typeof RefreshHostModelCatalog,
  options: { projectId?: string } = {},
): Promise<void> {
  const enabled = normalizeAgentPlatforms(
    (await context.storage.loadConfig()).global.enabledAgentPlatforms,
  );
  for (const agent of enabled) {
    await seedHostModelCatalogIfMissing(context, agent, refresh, options);
  }
}
