import { useEffect, useMemo, useState } from "react";
import { buildLaunchDefaults } from "@/lib/build-launch-options";
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
import { useConfigStore, useEnvironmentStore, useProjectStore } from "@/stores";
import { useClaudeStore } from "@/stores/claudeStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
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
  const claudeModels = useClaudeStore((state) => state.models);
  const codexModels = useCodexStore((state) => state.models);
  const openCodeModels = useOpenCodeStore((state) => state.models);
  const openCodeModelSources = useOpenCodeStore((state) => state.modelSource);
  const cursorModels = useAgentModelCatalogStore((state) => state.cursorModels);
  const grokModels = useAgentModelCatalogStore((state) => state.grokModels);
  const environments = useEnvironmentStore((state) => state.environments);
  const favoriteModels = useConfigStore((state) => state.config.global.favoriteModels);
  const openCodeModelProviders = useConfigStore(
    (state) => state.config.global.openCodeModelProviders,
  );
  const [cachedOpenCodeCatalog, setCachedOpenCodeCatalog] = useState<{
    projectId: string;
    models: CachedOpenCodeModel[];
  } | null>(null);

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
  }, [enabled, projectId]);

  // OpenCode catalogs are repository-scoped. A live catalog may supersede the
  // durable cache only when its environment belongs to this project.
  const projectOpenCodeModels = useMemo(() => {
    const projectEnvironmentIds = new Set(
      environments
        .filter((environment) => environment.projectId === projectId)
        .map((environment) => environment.id),
    );
    const live = Array.from(projectEnvironmentIds)
      .filter((environmentId) => openCodeModelSources.get(environmentId) === "server")
      .flatMap((environmentId) => openCodeModels.get(environmentId) ?? []);
    const cached =
      cachedOpenCodeCatalog?.projectId === projectId ? cachedOpenCodeCatalog.models : [];
    const selected = live.length > 0 ? live : cached;
    return selected.filter(
      (model, index, models) =>
        models.findIndex((candidate) => candidate.id === model.id) === index,
    );
  }, [cachedOpenCodeCatalog, environments, openCodeModelSources, openCodeModels, projectId]);

  const catalog = useMemo(() => {
    // `null` retains the standard Claude/Codex catalogs and the unpinned
    // OpenCode placeholder without aggregating another project's models.
    const baseCatalog = buildReviewModelCatalog(null);
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
            description: model.provider,
            reasoningEfforts: [...(model.variants ?? [])],
          }));
    return {
      ...baseCatalog,
      opencode: includeMissingOpenCodeModels(mapped, favoriteOpenCodeIds, allowedProviders),
    };
    // buildReviewModelCatalog reads the Claude/Codex/Cursor/Grok stores through
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
    () => buildLaunchDefaults(config, projectId, projectHasLocalPath),
    [config, projectHasLocalPath, projectId],
  );
  const catalog = useProjectModelCatalog(projectId, enabled);
  const [openCodeModelPreferences, setOpenCodeModelPreferences] =
    useState<OpenCodeModelPreferences>(EMPTY_OPENCODE_MODEL_PREFERENCES);

  useEffect(() => {
    let cancelled = false;
    setOpenCodeModelPreferences(EMPTY_OPENCODE_MODEL_PREFERENCES);
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
