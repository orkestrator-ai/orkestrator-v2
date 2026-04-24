import type { ModelReasoningEffort } from "@openai/codex-sdk";

export interface ModelReasoningOption {
  effort: ModelReasoningEffort;
  label: string;
  description?: string;
}

export interface BridgeModel {
  id: string;
  name: string;
  description?: string;
  reasoningEfforts: ModelReasoningEffort[];
  reasoningOptions: ModelReasoningOption[];
  defaultReasoningEffort: ModelReasoningEffort;
}

interface ModelCacheReasoningLevel {
  effort?: unknown;
  description?: unknown;
}

interface ModelCacheEntry {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  visibility?: unknown;
  supported_in_api?: unknown;
  supported_reasoning_levels?: unknown;
}

interface ModelCachePayload {
  models?: unknown;
}

export const MODEL_REASONING_EFFORTS = new Set<ModelReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export const DEFAULT_REASONING_EFFORT: ModelReasoningEffort = "medium";

export const REASONING_LABELS: Record<ModelReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
};

export const REASONING_DESCRIPTIONS: Record<ModelReasoningEffort, string> = {
  minimal: "Shortest reasoning path for the fastest possible responses",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
};

export function normalizeReasoningOptions(value: unknown): ModelReasoningOption[] {
  if (!Array.isArray(value)) {
    return [
      {
        effort: DEFAULT_REASONING_EFFORT,
        label: REASONING_LABELS[DEFAULT_REASONING_EFFORT],
        description: REASONING_DESCRIPTIONS[DEFAULT_REASONING_EFFORT],
      },
    ];
  }

  const options: ModelReasoningOption[] = [];
  for (const entry of value) {
    const rawEffort =
      typeof (entry as ModelCacheReasoningLevel | null)?.effort === "string"
        ? (entry as ModelCacheReasoningLevel).effort
        : undefined;

    if (
      typeof rawEffort !== "string"
      || !MODEL_REASONING_EFFORTS.has(rawEffort as ModelReasoningEffort)
    ) {
      continue;
    }

    const effort = rawEffort as ModelReasoningEffort;
    const description =
      typeof (entry as ModelCacheReasoningLevel | null)?.description === "string"
        ? ((entry as ModelCacheReasoningLevel).description as string)
        : undefined;

    options.push({
      effort,
      label: REASONING_LABELS[effort],
      description: description ?? REASONING_DESCRIPTIONS[effort],
    });
  }

  if (options.length === 0) {
    return [
      {
        effort: DEFAULT_REASONING_EFFORT,
        label: REASONING_LABELS[DEFAULT_REASONING_EFFORT],
        description: REASONING_DESCRIPTIONS[DEFAULT_REASONING_EFFORT],
      },
    ];
  }
  return options;
}

export function parseModelCatalog(raw: string): BridgeModel[] {
  const parsed = JSON.parse(raw) as ModelCachePayload;
  if (!Array.isArray(parsed.models)) {
    return [];
  }

  return parsed.models
    .map((entry) => entry as ModelCacheEntry)
    .filter(
      (entry) =>
        typeof entry.slug === "string"
        && entry.slug.trim().length > 0
        && (entry.visibility === undefined || entry.visibility === "list")
        && entry.supported_in_api !== false,
    )
    .map((entry) => {
      const slug = (entry.slug as string).trim();
      const displayName =
        typeof entry.display_name === "string" && entry.display_name.trim().length > 0
          ? entry.display_name.trim()
          : slug;
      const reasoningOptions = normalizeReasoningOptions(entry.supported_reasoning_levels);
      const reasoningEfforts = reasoningOptions.map((option) => option.effort);
      return {
        id: slug,
        name: displayName,
        description:
          typeof entry.description === "string" && entry.description.trim().length > 0
            ? entry.description.trim()
            : undefined,
        reasoningEfforts,
        reasoningOptions,
        defaultReasoningEffort: reasoningEfforts.includes(DEFAULT_REASONING_EFFORT)
          ? DEFAULT_REASONING_EFFORT
          : reasoningEfforts[0] ?? DEFAULT_REASONING_EFFORT,
      } satisfies BridgeModel;
    });
}

export interface ModelCatalogCacheOptions {
  /** Fetch the authoritative catalog by shelling out to the Codex CLI. */
  fetchFromCli: () => Promise<BridgeModel[] | null>;
  /** Read the bridge's persisted cache (survives restarts). */
  readPersistedCache: () => Promise<BridgeModel[] | null>;
  /** Persist the catalog to disk. Best-effort; should not throw. */
  writePersistedCache: (models: BridgeModel[]) => Promise<void>;
  /** Read Codex CLI's own models cache file, if present. */
  readCodexCliCache?: () => Promise<BridgeModel[] | null>;
  /** Hardcoded fallback when every source fails. */
  fallback: BridgeModel[];
  /** In-memory TTL before we kick off a background refresh. */
  ttlMs?: number;
  now?: () => number;
}

export interface ModelCatalogResult {
  models: BridgeModel[];
  source: "cache" | "fallback";
}

/**
 * Serves the Codex model catalog from a cached snapshot immediately and
 * refreshes from the CLI in the background. This avoids blocking the
 * `/global/models` endpoint on the slow initial `codex debug models` call.
 */
export class ModelCatalogCache {
  private memory: { at: number; models: BridgeModel[] } | null = null;
  private backgroundRefresh: Promise<void> | null = null;
  private persistedCacheLoadAttempted = false;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: ModelCatalogCacheOptions) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  async get(): Promise<ModelCatalogResult> {
    // 1. In-memory cache: always served immediately. Refresh in background if stale.
    if (this.memory) {
      if (this.now() - this.memory.at >= this.ttlMs) {
        this.kickBackgroundRefresh();
      }
      return { models: this.memory.models, source: "cache" };
    }

    // 2. First call after boot: warm up from the persisted bridge cache.
    if (!this.persistedCacheLoadAttempted) {
      this.persistedCacheLoadAttempted = true;
      const persisted = await this.opts.readPersistedCache();
      if (persisted && persisted.length > 0) {
        this.memory = { at: 0, models: persisted };
        this.kickBackgroundRefresh();
        return { models: persisted, source: "cache" };
      }
    }

    // 3. Fall back to Codex CLI's own on-disk cache, if provided.
    if (this.opts.readCodexCliCache) {
      const cliCache = await this.opts.readCodexCliCache();
      if (cliCache && cliCache.length > 0) {
        this.memory = { at: 0, models: cliCache };
        this.kickBackgroundRefresh();
        return { models: cliCache, source: "cache" };
      }
    }

    // 4. No cache at all — return hardcoded fallback and kick off a refresh so
    //    subsequent requests see the real catalog.
    this.kickBackgroundRefresh();
    return { models: this.opts.fallback, source: "fallback" };
  }

  /** Force a refresh and wait for it. Primarily for tests. */
  async refreshNow(): Promise<void> {
    this.kickBackgroundRefresh();
    await this.backgroundRefresh;
  }

  private kickBackgroundRefresh(): void {
    if (this.backgroundRefresh) return;
    this.backgroundRefresh = this.doRefresh().finally(() => {
      this.backgroundRefresh = null;
    });
  }

  private async doRefresh(): Promise<void> {
    try {
      const models = await this.opts.fetchFromCli();
      if (models && models.length > 0) {
        this.memory = { at: this.now(), models };
        await this.opts.writePersistedCache(models);
      }
    } catch (error) {
      // Swallow — background refresh failures shouldn't affect serving.
      console.warn(
        "[codex-bridge] Background model refresh failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }
}
