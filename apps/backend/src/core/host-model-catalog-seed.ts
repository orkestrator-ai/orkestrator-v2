import { normalizeAgentPlatforms, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { CommandContext } from "./commands-context.js";
import { asCachedCodexModels } from "./commands-validation.js";
import type {
  HostCatalog,
  refreshHostModelCatalog as RefreshHostModelCatalog,
} from "./host-model-catalog-refresh.js";

/**
 * How long a failed seed suppresses the next one. A signed-out host fails every
 * time, and each attempt spawns a whole bridge, so a picker that asks on every
 * focus must not turn that into a respawn loop. A completed sign-in clears it.
 */
export const HOST_CATALOG_SEED_FAILURE_COOLDOWN_MS = 30_000;

// Reserved scope for host-only conversations with no project configuration.
export const HOST_OPENCODE_CATALOG_SCOPE = "host:opencode";

// Per backend but still module state: keyed by platform (and project), so two
// backends share one seed flight and cooldown. Not moved yet: the sign-in reset
// is called from account code
// (docs/todo/backend-structure/1070-backend-module-state-beyond-0390.md).
const failedAt = new Map<string, number>();
const generations = new Map<string, number>();
const flights = new Map<string, { generation: number; promise: Promise<boolean> }>();

/** OpenCode's catalogue is per project; every other platform's is host-wide. */
function seedKey(agent: AgentPlatform, projectId?: string): string {
  return agent === "opencode" ? `opencode:${projectId ?? ""}` : agent;
}

/** Forget recorded failures for a platform, for example because the user just signed in. */
export function resetHostModelCatalogSeedCooldown(agent: AgentPlatform): void {
  const keys = new Set([...failedAt.keys(), ...flights.keys(), agent]);
  for (const key of keys) {
    if (key === agent || key.startsWith(`${agent}:`)) {
      failedAt.delete(key);
      generations.set(key, (generations.get(key) ?? 0) + 1);
    }
  }
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
  const key = seedKey(agent, projectId);
  const generation = generations.get(key) ?? 0;
  const existing = flights.get(key);
  if (existing?.generation === generation) return existing.promise;

  const run = async (): Promise<boolean> => {
    try {
      if (await hasCachedModels(context, agent, projectId)) return true;
      const lastFailure = failedAt.get(key);
      if (
        lastFailure !== undefined &&
        now() - lastFailure < HOST_CATALOG_SEED_FAILURE_COOLDOWN_MS
      ) {
        return false;
      }
      await persistHostCatalog(context, await refresh(context, agent), projectId);
      if ((generations.get(key) ?? 0) === generation) failedAt.delete(key);
      return true;
    } catch (error) {
      // A sign-in may invalidate this attempt while its old credentials are
      // still in use. Do not let that stale failure reinstate the cooldown.
      if ((generations.get(key) ?? 0) === generation) failedAt.set(key, now());
      // The message is the bridge's own error text; it carries no credentials.
      console.warn(
        `[ElectronBackend] Could not download the ${agent} model catalogue yet:`,
        error instanceof Error ? error.message : "unknown error",
      );
      return false;
    }
  };

  // A reset during an in-flight pre-login probe queues exactly one fresh
  // attempt behind it. This avoids concurrent writers while ensuring the
  // authenticated request is not absorbed by the stale flight.
  const started = existing ? existing.promise.then(run, run) : run();
  const flight = started.finally(() => {
    if (flights.get(key)?.promise === flight) flights.delete(key);
  });
  flights.set(key, { generation, promise: flight });
  return flight;
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

export const __testing = {
  reset(): void {
    failedAt.clear();
    generations.clear();
    flights.clear();
  },
};
