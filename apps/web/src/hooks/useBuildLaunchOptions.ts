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
import type { CachedOpenCodeModel, OpenCodeModelPreferences } from "@/lib/backend";
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
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { DeclaredAptPackages } from "@orkestrator/protocol/apt-packages";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { hydrateAgentModelCatalogCache } from "@/lib/agent-model-catalog-cache";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";

const log = createLogger("web.build-pipeline");

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
  const nodeBackend = useScopeBackend();
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

  // A node's scope starts on the bundled catalogues and is otherwise refreshed
  // only by a native tab or Settings, so a launcher opened on another machine's
  // environment would list the window's stale guess. Load what that node's
  // backend has cached whenever a launcher opens.
  const catalogScope = useScopesWithCommandFallback().scope;
  useEffect(() => {
    if (!enabled) return;
    void hydrateAgentModelCatalogCache({ scope: catalogScope }).catch((error: unknown) => {
      log.debug("model-catalog.hydrate-failed", { error: formatLogError(error) });
    });
  }, [catalogRefreshRevision, catalogScope, enabled]);

  useEffect(() => {
    let cancelled = false;
    // Drops the previous project's catalogue before this project's read lands.
    // oxlint-disable-next-line react/set-state-in-effect
    setCachedOpenCodeCatalog(null);
    if (!enabled || !projectId)
      return () => {
        cancelled = true;
      };
    void nodeBackend
      .getCachedOpenCodeModelCatalog(projectId)
      .then((snapshot) => {
        const models = normalizeCachedOpenCodeModels(snapshot?.models);
        if (!cancelled && snapshot?.projectId === projectId && models) {
          setCachedOpenCodeCatalog({ projectId, models });
        }
      })
      .catch((error) => {
        log.warn("opencode-catalog.load-failed", { projectId, error: formatLogError(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [catalogRefreshRevision, enabled, projectId, nodeBackend]);

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
    const baseCatalog = buildReviewModelCatalog({
      claudeModels,
      codexModels,
      cursorModels,
      grokModels,
      piModels,
    });
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

/** What a project's default branch asks of a new container (`get_project_setup_requirements`). */
export interface ProjectSetupRequirementsView {
  /** `root` steps, which run only with Full access. */
  rootSteps: number | null;
  /**
   * Declared Debian packages (`aptPackages`), which setup installs from
   * Debian's archive. `null` when the machine cannot tell or predates them.
   */
  aptPackages: DeclaredAptPackages | null;
}

/**
 * What the project's default branch asks of a new container, as the
 * project's machine reads it (`get_project_setup_requirements`): its `root`
 * setup steps, which run only in containers with full network access, and the
 * Debian packages it declares, which a restricted container reaches Debian's
 * archive for. `null` while loading, when the machine cannot tell, or when it
 * predates the command: no warning rather than a guessed one.
 */
export function useProjectSetupRequirements(
  projectId: string,
  enabled: boolean,
): ProjectSetupRequirementsView | null {
  const nodeBackend = useScopeBackend();
  // Keyed by project and machine, so an answer for one never shows for another.
  const [loaded, setLoaded] = useState<{
    projectId: string;
    backend: typeof nodeBackend;
    requirements: ProjectSetupRequirementsView | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Drops the last answer so a reopened launcher, another project or another
    // machine shows nothing until its own read lands.
    // oxlint-disable-next-line react/set-state-in-effect
    setLoaded(null);
    if (!enabled || !projectId)
      return () => {
        cancelled = true;
      };
    // Any failure, a synchronous one included, means "cannot tell".
    void Promise.resolve()
      .then(() => nodeBackend.getProjectSetupRequirements(projectId))
      .then(({ rootSteps, aptPackages }) => {
        if (!cancelled)
          setLoaded({
            projectId,
            backend: nodeBackend,
            requirements: { rootSteps, aptPackages: aptPackages ?? null },
          });
      })
      .catch((error: unknown) => {
        log.debug("setup-requirements.load-failed", { projectId, error: formatLogError(error) });
        if (!cancelled) setLoaded({ projectId, backend: nodeBackend, requirements: null });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, projectId, nodeBackend]);
  return enabled && loaded?.projectId === projectId && loaded.backend === nodeBackend
    ? loaded.requirements
    : null;
}

/**
 * How many `root` setup steps the project's default branch names
 * ({@link useProjectSetupRequirements}). Root steps run only in containers
 * with full network access, so the launchers warn when Restricted is chosen.
 */
export function useProjectRootSetupSteps(projectId: string, enabled: boolean): number | null {
  return useProjectSetupRequirements(projectId, enabled)?.rootSteps ?? null;
}

/** Shared defaults and repository-scoped model catalog for every build launcher. */
export function useBuildLaunchOptions(projectId: string, enabled: boolean) {
  const nodeBackend = useScopeBackend();
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
  const setupRequirements = useProjectSetupRequirements(projectId, enabled);
  const rootSetupSteps = setupRequirements?.rootSteps ?? null;
  const aptPackages = setupRequirements?.aptPackages ?? null;
  const projectCatalog = useProjectModelCatalog(projectId, enabled);
  const catalog = useMemo(() => {
    const allowedProviders = normalizeOpenCodeModelProviders(config.global.openCodeModelProviders);
    return {
      ...projectCatalog,
      opencode: includeMissingOpenCodeModels(
        projectCatalog.opencode,
        configuredOpenCodeModelIds(defaults.pipelineDefaults, defaults.preferredModels.opencode),
        allowedProviders,
      ),
    };
  }, [
    config.global.openCodeModelProviders,
    defaults.pipelineDefaults,
    defaults.preferredModels.opencode,
    projectCatalog,
  ]);
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
    void nodeBackend
      .getOpencodeModelPreferences()
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
        log.warn("opencode-preferences.load-failed", {
          projectId,
          error: formatLogError(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, projectId, nodeBackend]);

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

  const launchDefaults = useMemo(
    () => ({ ...defaults, rootSetupSteps, aptPackages }),
    [defaults, rootSetupSteps, aptPackages],
  );

  return { catalog, defaults: launchDefaults, favoriteOpenCodeModelIds };
}
