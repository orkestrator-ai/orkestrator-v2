import { useEffect, useMemo, useState } from "react";
import {
  buildLaunchDefaults,
  buildPipelineConfiguredDefaults,
  configuredOpenCodeModelIds,
} from "@/lib/build-launch-options";
import {
  buildReviewModelCatalog,
  includeMissingOpenCodeModels,
  includeOpenCodeDefaultModel,
} from "@/lib/review-launch-options";
import {
  type CachedOpenCodeModel,
  getCachedOpenCodeModelCatalog,
  getOpencodeModelPreferences,
  type OpenCodeModelPreferences,
} from "@/lib/backend";
import {
  EMPTY_OPENCODE_MODEL_PREFERENCES,
  openCodeModelRefToId,
} from "@/lib/opencode-model-preferences";
import {
  normalizeOpenCodeModelProviders,
  openCodeModelDisplayLabel,
} from "@orkestrator/protocol/native-agent";
import { useConfigStore, useProjectStore } from "@/stores";
import { useAgentModelCatalogStore } from "@/stores/agentModelCatalogStore";

function normalizeCachedOpenCodeModels(value: unknown): CachedOpenCodeModel[] | null {
  if (!Array.isArray(value)) return null;
  if (
    !value.every((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const record = candidate as Record<string, unknown>;
      return (
        typeof record.id === "string" &&
        record.id.trim().length > 0 &&
        typeof record.name === "string" &&
        record.name.trim().length > 0 &&
        typeof record.provider === "string" &&
        record.provider.trim().length > 0 &&
        (record.variants === undefined ||
          (Array.isArray(record.variants) &&
            record.variants.every(
              (variant) => typeof variant === "string" && variant.trim().length > 0,
            )))
      );
    })
  )
    return null;
  return value as CachedOpenCodeModel[];
}

/** Repository-scoped model catalog shared by launchers and repository settings. */
export function useProjectModelCatalog(projectId: string, enabled: boolean) {
  // These subscriptions keep the memoized catalog current when a native agent
  // publishes its models after the launcher has mounted.
  const claudeModels = useAgentModelCatalogStore((state) => state.claudeModels);
  const codexModels = useAgentModelCatalogStore((state) => state.codexModels);
  const cursorModels = useAgentModelCatalogStore((state) => state.cursorModels);
  const grokModels = useAgentModelCatalogStore((state) => state.grokModels);
  const piModels = useAgentModelCatalogStore((state) => state.piModels);
  const favoriteModels = useConfigStore((state) => state.config.global.favoriteModels);
  const openCodeModelProviders = useConfigStore(
    (state) => state.config.global.openCodeModelProviders,
  );
  const [cachedOpenCodeCatalog, setCachedOpenCodeCatalog] = useState<{
    projectId: string;
    models: CachedOpenCodeModel[];
  } | null>(null);
  const [catalogRefreshRevision, setCatalogRefreshRevision] = useState(0);

  useEffect(() => {
    const refresh = () => setCatalogRefreshRevision((revision) => revision + 1);
    window.addEventListener("orkestrator:model-catalog-refreshed", refresh);
    return () => window.removeEventListener("orkestrator:model-catalog-refreshed", refresh);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setCachedOpenCodeCatalog(null);
    if (!enabled || !projectId)
      return () => {
        cancelled = true;
      };
    void getCachedOpenCodeModelCatalog(projectId)
      .then((snapshot) => {
        const models = normalizeCachedOpenCodeModels(snapshot?.models);
        if (!cancelled && snapshot?.projectId === projectId && models) {
          setCachedOpenCodeCatalog({ projectId, models });
        }
      })
      .catch((error) => {
        console.warn("[useProjectModelCatalog] Failed to load cached OpenCode models:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [catalogRefreshRevision, enabled, projectId]);

  // OpenCode catalogs are repository-scoped and come from the backend's durable
  // per-project cache.
  const projectOpenCodeModels = useMemo(() => {
    const cached =
      cachedOpenCodeCatalog?.projectId === projectId ? cachedOpenCodeCatalog.models : [];
    return cached.filter(
      (model, index, models) =>
        models.findIndex((candidate) => candidate.id === model.id) === index,
    );
  }, [cachedOpenCodeCatalog, projectId]);

  const catalog = useMemo(() => {
    // The standard Claude/Codex catalogs and the unpinned OpenCode placeholder.
    const baseCatalog = buildReviewModelCatalog();
    const allowedProviders = normalizeOpenCodeModelProviders(openCodeModelProviders);
    const favoriteOpenCodeIds = (favoriteModels ?? [])
      .filter((favorite) => favorite.platform === "opencode")
      .map((favorite) => favorite.modelId);
    const mapped =
      projectOpenCodeModels.length === 0
        ? baseCatalog.opencode
        : projectOpenCodeModels.map((model) => ({
            id: model.id,
            name: openCodeModelDisplayLabel(model.id, model.name),
            providerLabel: model.provider,
            description: model.provider,
            reasoningEfforts: [...(model.variants ?? [])],
            ...(model.connected === false ? { connected: false } : {}),
          }));
    return {
      ...baseCatalog,
      opencode: includeMissingOpenCodeModels(mapped, favoriteOpenCodeIds, allowedProviders),
    };
    // buildReviewModelCatalog reads the Claude/Codex/Cursor/Grok/Pi stores through
    // getState(), which does not subscribe. These selectors are the subscription:
    // the rule sees them as unused because the body never names them, but dropping
    // them freezes the catalog at whatever was loaded on first render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [
    claudeModels,
    codexModels,
    cursorModels,
    favoriteModels,
    grokModels,
    piModels,
    openCodeModelProviders,
    projectOpenCodeModels,
  ]);

  return catalog;
}

/** Review keeps an explicit "use OpenCode's last model" choice above the cache. */
export function useReviewModelCatalog(projectId: string, enabled: boolean) {
  const catalog = useProjectModelCatalog(projectId, enabled);
  return useMemo(
    () => ({
      ...catalog,
      opencode: includeOpenCodeDefaultModel(catalog.opencode),
    }),
    [catalog],
  );
}

/** Shared defaults and repository-scoped model catalog for every build launcher. */
export function useBuildLaunchOptions(projectId: string, enabled: boolean) {
  const config = useConfigStore((state) => state.config);
  const projects = useProjectStore((state) => state.projects);
  const projectHasLocalPath = Boolean(
    projects.find((project) => project.id === projectId)?.localPath,
  );
  const defaults = useMemo(
    () => ({
      ...buildLaunchDefaults(config, projectId, projectHasLocalPath),
      pipelineDefaults: buildPipelineConfiguredDefaults(config, projectId),
    }),
    [config, projectHasLocalPath, projectId],
  );
  const projectCatalog = useProjectModelCatalog(projectId, enabled);
  const catalog = useMemo(() => {
    const allowedProviders = normalizeOpenCodeModelProviders(config.global.openCodeModelProviders);
    return {
      ...projectCatalog,
      opencode: includeMissingOpenCodeModels(
        projectCatalog.opencode,
        configuredOpenCodeModelIds(defaults.pipelineDefaults),
        allowedProviders,
      ),
    };
  }, [config.global.openCodeModelProviders, defaults.pipelineDefaults, projectCatalog]);
  const [openCodeModelPreferences, setOpenCodeModelPreferences] =
    useState<OpenCodeModelPreferences>(EMPTY_OPENCODE_MODEL_PREFERENCES);
  // Another project's (or a disabled launcher's) preferences never carry over;
  // the effect below loads this scope's.
  const preferencesScope = JSON.stringify([enabled, projectId]);
  const [renderedPreferencesScope, setRenderedPreferencesScope] = useState(preferencesScope);
  if (renderedPreferencesScope !== preferencesScope) {
    setRenderedPreferencesScope(preferencesScope);
    setOpenCodeModelPreferences(EMPTY_OPENCODE_MODEL_PREFERENCES);
  }

  useEffect(() => {
    let cancelled = false;
    if (!enabled)
      return () => {
        cancelled = true;
      };
    void getOpencodeModelPreferences()
      .then((preferences) => {
        if (
          !cancelled &&
          preferences &&
          Array.isArray(preferences.favorite) &&
          Array.isArray(preferences.recent)
        ) {
          setOpenCodeModelPreferences(preferences);
        }
      })
      .catch((error) => {
        console.warn("[useBuildLaunchOptions] Failed to load OpenCode model preferences:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, projectId]);

  const favoriteOpenCodeModelIds = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const favorite of openCodeModelPreferences.favorite) {
      const id = openCodeModelRefToId(favorite);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }, [openCodeModelPreferences.favorite]);

  return { catalog, defaults, favoriteOpenCodeModelIds };
}
