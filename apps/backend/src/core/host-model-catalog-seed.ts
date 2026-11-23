import { normalizeAgentPlatforms, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { CommandContext } from "./commands-context.js";
import { asCachedCodexModels } from "./commands-validation.js";
import type { AgentModelCatalogCache, CodexModelCatalogEntry } from "./models.js";
import { agentAccountLoginKey } from "./agent-accounts/store.js";
import { AGENT_MODEL_CATALOG_MAX_AGE_MS } from "./storage-shared.js";
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

/** Account swaps and login promotion share this lock with the catalogue write. */
export function persistCodexHostCatalog(
  context: CommandContext,
  models: CodexModelCatalogEntry[],
  accountLoginKey: string,
): Promise<AgentModelCatalogCache | undefined> {
  const { storage } = context;
  return context.runtime.accounts.withMutation(async () => {
    const accounts = await storage.agentAccounts.loadAgentAccounts();
    if (
      agentAccountLoginKey(accounts.active.codex, accounts.loginGeneration?.codex) !==
      accountLoginKey
    )
      return undefined;
    return storage.cacheAgentModelCatalog("codex", models);
  });
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
    const saved = await persistCodexHostCatalog(
      context,
      asCachedCodexModels(catalog.models),
      catalog.accountLoginKey,
    );
    if (!saved) throw new Error("The active Codex login changed during model discovery");
  } else if (
    catalog.agent === "cursor" ||
    catalog.agent === "grok" ||
    catalog.agent === "pi" ||
    catalog.agent === "antigravity"
  ) {
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
  freshness?: { maxAgeMs: number; now: () => number },
): Promise<boolean> {
  if (agent === "opencode") {
    projectId ??= HOST_OPENCODE_CATALOG_SCOPE;
    return ((await context.storage.getOpenCodeModelCatalog(projectId))?.models.length ?? 0) > 0;
  }
  const cache = await context.storage.getAgentModelCatalogCache();
  if (!freshness) return (cache[agent]?.models.length ?? 0) > 0;
  return !isHostModelCatalogStale(cache, agent, freshness.now(), freshness.maxAgeMs);
}

/**
 * The host-wide catalogues a read keeps fresh in the background.
 *
 * Claude and Codex lists come from the host's own sign-in and are what every
 * launch dialog offers before any environment runs. Cursor, Grok and Pi are
 * re-read from each running bridge, and OpenCode's list is per project, so a
 * background host probe would only add bridge starts for them.
 */
export const STALE_REFRESHED_HOST_CATALOGS = ["claude", "codex"] as const;
type StaleRefreshedHostCatalog = (typeof STALE_REFRESHED_HOST_CATALOGS)[number];

/**
 * Whether `agent`'s cached catalogue exists but was last confirmed more than
 * `maxAgeMs` ago. A missing catalogue is not stale: seeding it is first use.
 * Neither is one with no readable time; the persisted cache always has one
 * (an unreadable stored time is read back as the epoch, which is stale).
 */
export function isHostModelCatalogStale(
  cache: AgentModelCatalogCache,
  agent: Exclude<AgentPlatform, "opencode">,
  now: number,
  maxAgeMs = AGENT_MODEL_CATALOG_MAX_AGE_MS,
): boolean {
  const entry = cache[agent];
  if (!entry?.models.length) return false;
  const confirmedAt =
    typeof entry.updatedAt === "string" ? Date.parse(entry.updatedAt) : Number.NaN;
  return Number.isFinite(confirmedAt) && now - confirmedAt > maxAgeMs;
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
  options: { projectId?: string; now?: () => number; maxAgeMs?: number } = {},
): Promise<boolean> {
  const { projectId, now = Date.now, maxAgeMs } = options;
  return context.runtime.localServers.catalogSeeds.seed(agent, projectId, {
    cached: () =>
      hasCachedModels(
        context,
        agent,
        projectId,
        maxAgeMs === undefined ? undefined : { maxAgeMs, now },
      ),
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

/**
 * Re-download every enabled Claude or Codex host catalogue last confirmed more
 * than a day ago (`AGENT_MODEL_CATALOG_MAX_AGE_MS`).
 *
 * The cached list keeps serving while this runs; it never throws. It shares the
 * seed's single flight and failure cooldown, so a signed-out host costs one
 * probe per cooldown rather than one per read, and a successful download, or
 * an unchanged list re-confirmed, resets the age.
 */
export async function refreshStaleHostModelCatalogs(
  context: CommandContext,
  refresh: typeof RefreshHostModelCatalog,
  options: { now?: () => number; cache?: AgentModelCatalogCache } = {},
): Promise<void> {
  const { now = Date.now } = options;
  const stale = await staleHostCatalogs(context, options.cache, now());
  for (const agent of stale) {
    await seedHostModelCatalogIfMissing(context, agent, refresh, {
      now,
      maxAgeMs: AGENT_MODEL_CATALOG_MAX_AGE_MS,
    });
  }
}

/**
 * Start {@link refreshStaleHostModelCatalogs} without waiting for it, when any
 * enabled catalogue is stale. For reads that answer from the cache now and let
 * the next read see the refreshed list.
 */
export function refreshStaleHostModelCatalogsInBackground(
  context: CommandContext,
  refresh: typeof RefreshHostModelCatalog,
  cache: AgentModelCatalogCache,
  now: () => number = Date.now,
): void {
  if (!STALE_REFRESHED_HOST_CATALOGS.some((agent) => isHostModelCatalogStale(cache, agent, now())))
    return;
  // A shutdown refuses the probe itself (`withShortLivedBridge`), and the seed
  // turns that into a logged deferral rather than a rejection.
  void refreshStaleHostModelCatalogs(context, refresh, { now, cache }).catch(() => undefined);
}

async function staleHostCatalogs(
  context: CommandContext,
  cache: AgentModelCatalogCache | undefined,
  now: number,
): Promise<StaleRefreshedHostCatalog[]> {
  const enabled = normalizeAgentPlatforms(
    (await context.storage.loadConfig()).global.enabledAgentPlatforms,
  );
  const current = cache ?? (await context.storage.getAgentModelCatalogCache());
  return STALE_REFRESHED_HOST_CATALOGS.filter(
    (agent) => enabled.includes(agent) && isHostModelCatalogStale(current, agent, now),
  );
}
