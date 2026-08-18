import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  parseStoredDesktopConnections,
  isResourceGeneration,
  isResourceManifestKind,
  isResourceSnapshotRevision,
  createProject,
  parseUpdateObject,
  runCommand,
  isAgentPlatform,
  fallbackReasoningId,
  isSelectableOpenCodeModelId,
  isSelectableOpenCodeProvider,
  normalizeOpenCodeModelProviders,
  openCodeModelDisplayLabel,
  synthesizedOpenCodeAgentModel,
} from "./commands-dependencies.js";
import type {
  ResourceRevisionMap,
  AppConfig,
  AgentModel,
  AgentReasoningOption,
} from "./commands-dependencies.js";
import {
  syncDiffStatsTracking,
  asString,
  asRecord,
  assertOnlyKeys,
  asAgentModelConfigKey,
  redactGlobalConfig,
  redactAppConfig,
  stripRendererCredentials,
  asOptionalString,
  asStringArray,
  asNonBlankString,
  asCachedCodexModels,
  peekLocalAgentBridge,
  peekContainerAgentBridge,
  fetchAcpNormalizedModels,
  parseClaudeBridgeModelCatalog,
  projectPathKey,
  duplicateLocalPathGuard,
  readOriginUrl,
  createProjectFromScratch,
} from "./commands-helpers.js";

export function registerProjectCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const { conditionalManifestSnapshot, runProjectCreationCommand } = dependencies;
  register(
    "greet",
    ({ name }) =>
      `Hello, ${asString(name, "name")}! You've been greeted from the Orkestrator backend!`,
  );
  // File pickers belong to the connected client. Browser clients cannot expose
  // a server-side filesystem picker, while Electron handles this via preload.
  register("browse_for_directory", async () => null);

  register("get_resource_revision_manifest", ({ knownGeneration, knownRevisions }, { storage }) => {
    const parsed: Partial<ResourceRevisionMap> = {};
    if (knownRevisions !== undefined) {
      const revisions = asRecord(knownRevisions, "knownRevisions");
      for (const [resource, revision] of Object.entries(revisions)) {
        if (!isResourceManifestKind(resource)) {
          throw new Error(`Unknown manifest resource: ${resource}`);
        }
        if (!isResourceSnapshotRevision(revision)) {
          throw new Error(`Invalid manifest revision for ${resource}`);
        }
        parsed[resource] = revision;
      }
    }
    if (knownGeneration !== undefined && !isResourceGeneration(knownGeneration)) {
      throw new Error("knownGeneration must be an opaque resource generation");
    }
    return storage.getResourceRevisionManifest(knownGeneration, parsed);
  });

  register("get_projects", (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "project", () => storage.loadProjects()),
  );
  register("add_project", async ({ gitUrl, localPath }, { storage }) => {
    const requestedLocalPath = asOptionalString(localPath);
    // Enforced inside the projects.json critical section so this cannot insert
    // the duplicate that create_project_from_scratch guards against.
    const guard =
      requestedLocalPath === undefined
        ? undefined
        : duplicateLocalPathGuard(await projectPathKey(requestedLocalPath), requestedLocalPath);
    return storage.addProject(createProject(asString(gitUrl, "gitUrl"), requestedLocalPath), guard);
  });
  register("create_project_from_scratch", (args, { storage }) => {
    assertOnlyKeys(args, ["localPath"], "arguments");
    return createProjectFromScratch(
      asNonBlankString(args.localPath, "localPath"),
      storage,
      runProjectCreationCommand,
    );
  });
  register("remove_project", ({ projectId }, { storage }) =>
    storage.removeProject(asString(projectId, "projectId")),
  );
  register("get_project", ({ projectId }, { storage }) =>
    storage.getProject(asString(projectId, "projectId")),
  );
  register("update_project", ({ projectId, updates }, { storage }) =>
    storage.updateProject(asString(projectId, "projectId"), parseUpdateObject(updates)),
  );
  register("reorder_projects", ({ projectIds }, { storage }) =>
    storage.reorderProjects(asStringArray(projectIds)),
  );
  register("validate_git_url", ({ url }) =>
    /^(https?:\/\/|git@|ssh:\/\/).+/.test(asString(url, "url").trim()),
  );
  register("get_git_remote_url", async ({ path: repoPath }) => {
    // Reads the raw config value rather than `remote get-url`, which applies
    // `insteadOf` rewrites and can therefore hand back an embedded credential.
    return (await readOriginUrl(asString(repoPath, "path"), runCommand)) || null;
  });

  register("get_config", (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "config", async () =>
      redactAppConfig(await storage.loadConfig()),
    ),
  );
  register("get_agent_model_catalog_cache", (_args, { storage }) =>
    storage.getAgentModelCatalogCache(),
  );
  register("get_native_agent_model_catalog", async ({ environmentId }, context) => {
    const { storage } = context;
    const id = asNonBlankString(environmentId, "environmentId");
    const environment = await storage.getEnvironment(id);
    if (!environment) throw new Error(`Environment not found: ${id}`);
    const cache = await storage.getAgentModelCatalogCache();
    const claudeModels = environment.claudeModelCatalog?.models ?? cache.claude?.models ?? [];
    const codexModels = cache.codex?.models ?? [];
    // The live catalogue is already filtered by the provider, but a cache
    // written before the allowlist changed is not. Filter here too so the
    // renderer never receives a provider the user excluded.
    const config = await storage.loadConfig();
    const openCodeModelProviders = normalizeOpenCodeModelProviders(
      config.global.openCodeModelProviders,
    );
    const openCodeModels = (
      (await storage.getOpenCodeModelCatalog(environment.projectId))?.models ?? []
    ).filter((model) => isSelectableOpenCodeProvider(model.provider, openCodeModelProviders));
    const runningOpenCodeBridge =
      environment.environmentType === "local"
        ? await peekLocalAgentBridge(environment.id, context, "opencode")
        : environment.containerId
          ? await peekContainerAgentBridge(environment.containerId, "opencode")
          : null;
    const liveOpenCodeModels =
      context.nativeAgents && runningOpenCodeBridge
        ? await context.nativeAgents
            .listModelCatalogForCache({
              environmentId: id,
              agent: "opencode",
              logicalSessionKey: `model-catalog:${id}`,
            })
            .catch(() => [])
        : [];
    // Only the reads narrow. Persisting the filtered list instead would make the
    // allowlist durable, so widening it later would leave the launch dialogs —
    // which read this cache before any OpenCode server is ready — narrow until
    // an environment happened to run and re-list.
    if (liveOpenCodeModels.length > 0) {
      await storage
        .cacheOpenCodeModelCatalog(
          environment.projectId,
          liveOpenCodeModels.map((model) => ({
            id: model.id,
            name: model.label,
            provider: model.id.split("/")[0] || "opencode",
            variants: model.reasoning?.map((option) => option.id).filter((id) => id !== "default"),
            ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
            ...(typeof model.supportsImageInput === "boolean"
              ? { supportsImageInput: model.supportsImageInput }
              : {}),
          })),
        )
        .catch(() => undefined);
    }
    const selectableLiveOpenCodeModels = liveOpenCodeModels.filter((model) =>
      isSelectableOpenCodeModelId(model.id, openCodeModelProviders),
    );
    const [cursorModels, grokModels] = await Promise.all([
      fetchAcpNormalizedModels(environment, context, "cursor"),
      fetchAcpNormalizedModels(environment, context, "grok"),
    ]);
    for (const [agent, models] of [
      ["cursor", cursorModels],
      ["grok", grokModels],
    ] as const) {
      if (models.length === 0) continue;
      try {
        await storage.cacheAgentModelCatalog(agent, models);
      } catch (error) {
        console.warn(
          `[ElectronBackend] Failed to persist the ${agent} model catalogue:`,
          error instanceof Error ? error.message : "unknown error",
        );
      }
    }
    const effortLabel = (effort: string) => {
      if (effort === "xhigh") return "Extra high";
      return effort.replace(/[-_]+/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
    };
    const reasoning = (ids: readonly string[]): AgentReasoningOption[] =>
      ids.map((effort) => ({ id: effort, label: effortLabel(effort) }));
    const cataloguedOpenCodeModels =
      selectableLiveOpenCodeModels.length > 0
        ? selectableLiveOpenCodeModels
        : openCodeModels.map((model): AgentModel => {
            const reasoningOptions = [
              { id: "default", label: "Default" },
              ...reasoning(model.variants ?? []),
            ];
            return {
              platform: "opencode",
              id: model.id,
              label: openCodeModelDisplayLabel(model.id, model.name),
              providerLabel: model.provider,
              reasoning: reasoningOptions,
              defaultReasoningId: fallbackReasoningId(reasoningOptions) ?? "default",
              supportsSpeed: false,
              // OpenCode has primary agents, not a Build/Plan permission mode.
              supportsMode: false,
              ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
              ...(typeof model.supportsImageInput === "boolean"
                ? { supportsImageInput: model.supportsImageInput }
                : {}),
            };
          });
    const cataloguedOpenCodeIds = new Set(cataloguedOpenCodeModels.map((model) => model.id));
    // Favourites (and TUI-chosen ids stored as favourites) have to appear in
    // the empty-tab picker before an OpenCode server has listed models.
    // Otherwise they render as disabled placeholders labelled with the raw id.
    const favoriteOpenCodeModels = (config.global.favoriteModels ?? []).flatMap((favorite) => {
      if (favorite.platform !== "opencode") return [];
      if (cataloguedOpenCodeIds.has(favorite.modelId)) return [];
      if (!isSelectableOpenCodeModelId(favorite.modelId, openCodeModelProviders)) return [];
      const synthesized = synthesizedOpenCodeAgentModel(favorite.modelId);
      if (!synthesized) return [];
      cataloguedOpenCodeIds.add(favorite.modelId);
      return [synthesized];
    });
    const result: AgentModel[] = [
      ...claudeModels.map((model): AgentModel => {
        const efforts = model.supportedEffortLevels ?? ["low", "medium", "high"];
        return {
          platform: "claude",
          id: model.id,
          label: model.name,
          providerLabel: "Claude",
          reasoning: reasoning(efforts),
          defaultReasoningId: fallbackReasoningId(efforts) ?? "high",
          supportsSpeed: model.supportsFastMode !== false,
          supportsMode: true,
        };
      }),
      ...codexModels.map((model): AgentModel => {
        const reasoningOptions =
          model.reasoningOptions?.map((option) => ({
            id: option.effort,
            label: option.label,
          })) ?? reasoning(model.reasoningEfforts ?? ["medium", "high"]);
        return {
          platform: "codex",
          id: model.id,
          label: model.name,
          providerLabel: "Codex",
          reasoning: reasoningOptions,
          defaultReasoningId:
            fallbackReasoningId(reasoningOptions, model.defaultReasoningEffort) ??
            model.defaultReasoningEffort,
          supportsSpeed: true,
          supportsMode: true,
        };
      }),
      ...cataloguedOpenCodeModels,
      ...favoriteOpenCodeModels,
      ...(cursorModels.length > 0 ? cursorModels : (cache.cursor?.models ?? [])),
      ...(grokModels.length > 0 ? grokModels : (cache.grok?.models ?? [])),
    ];
    return result;
  });
  register("cache_agent_model_catalog", (args, { storage }) => {
    assertOnlyKeys(args, ["agent", "models"], "arguments");
    const agent = asNonBlankString(args.agent, "agent");
    if (agent === "claude") {
      const catalog = parseClaudeBridgeModelCatalog({
        models: args.models,
        source: "sdk",
        fetchedAt: new Date().toISOString(),
      });
      return storage.cacheAgentModelCatalog("claude", catalog.models);
    }
    if (agent === "codex") {
      return storage.cacheAgentModelCatalog("codex", asCachedCodexModels(args.models));
    }
    throw new Error("Expected agent to be claude or codex");
  });
  register("save_config", async ({ config }, context) => {
    const { storage } = context;
    const candidate = asRecord(config, "config") as unknown as AppConfig;
    await storage.saveConfig(
      {
        ...candidate,
        global: stripRendererCredentials(asRecord(candidate.global, "config.global")),
      },
      { preserveCredentials: true },
    );
    // A whole-config write can move any repository's baseline; see
    // `update_repository_config`.
    void syncDiffStatsTracking(context).catch(() => undefined);
  });
  register("get_desktop_connections", (_args, { storage }) => storage.getDesktopConnections());
  register("save_desktop_connections", ({ desktopConnections }, { storage }) => {
    return storage.saveDesktopConnections(parseStoredDesktopConnections(desktopConnections));
  });
  register("get_global_config", async (_args, { storage }) =>
    redactGlobalConfig((await storage.loadConfig()).global),
  );
  register("update_global_config", async ({ global }, { storage }) => {
    const updated = await storage.updateGlobalConfig(
      stripRendererCredentials(asRecord(global, "global")),
      { preserveCredentials: true },
    );
    return redactAppConfig(updated);
  });
  register("update_agent_model_default", async ({ key, modelId }, { storage }) => {
    // The key is validated against a closed set, so the model id must be held to
    // the same bar: storage writes it verbatim into a required config field and a
    // renderer bug must not be able to persist an empty default.
    const id = asString(modelId, "modelId").trim();
    if (!id) throw new Error("Expected modelId to be non-empty");
    return redactAppConfig(await storage.updateAgentModelDefault(asAgentModelConfigKey(key), id));
  });
  register("set_github_token", async ({ token }, { storage }) => {
    const nextToken = token === null ? null : asString(token, "token").trim();
    if (nextToken !== null && !nextToken) {
      throw new Error("GitHub token cannot be empty. Use null to clear it.");
    }
    return redactAppConfig(await storage.setGitHubToken(nextToken));
  });
  register("set_cursor_api_key", async ({ apiKey }, { storage }) => {
    const nextApiKey = apiKey === null ? null : asString(apiKey, "apiKey").trim();
    if (nextApiKey !== null && !nextApiKey) {
      throw new Error("Cursor API key cannot be empty. Use null to clear it.");
    }
    return redactAppConfig(await storage.setCursorApiKey(nextApiKey));
  });
  register("set_anthropic_api_key", async ({ apiKey }, { storage }) => {
    const nextApiKey = apiKey === null ? null : asString(apiKey, "apiKey").trim();
    if (nextApiKey !== null && !nextApiKey) {
      throw new Error("Anthropic API key cannot be empty. Use null to clear it.");
    }
    return redactAppConfig(await storage.setAnthropicApiKey(nextApiKey));
  });
  register("get_repository_config", ({ projectId }, { storage }) =>
    storage.getRepositoryConfig(asString(projectId, "projectId")),
  );
  register("update_repository_config", async ({ projectId, repoConfig }, context) => {
    const updated = await context.storage.updateRepositorySettings(
      asString(projectId, "projectId"),
      repoConfig as never,
    );
    // The PR base branch is the baseline the counts are measured against, so an
    // edit here retargets every environment in the project. Reconciling now
    // rather than waiting for the next environment poll means the badge follows
    // the setting the user just changed.
    void syncDiffStatsTracking(context).catch(() => undefined);
    return redactAppConfig(updated);
  });
  register(
    "remember_environment_agent_selection",
    async ({ projectId, platform, mode, model, reasoningEffort }, { storage }) => {
      if (!isAgentPlatform(platform)) {
        throw new Error("Expected platform to be a supported agent platform");
      }
      const selectedPlatform = platform;
      const selectedMode = asString(mode, "mode");
      if (selectedMode !== "terminal" && selectedMode !== "native") {
        throw new Error("Expected mode to be terminal or native");
      }
      const selectedModel = asOptionalString(model)?.trim();
      const selectedReasoningEffort = asOptionalString(reasoningEffort)?.trim();
      return redactAppConfig(
        await storage.patchRepositoryConfig(asString(projectId, "projectId"), {
          lastEnvironmentAgentSelection: {
            platform: selectedPlatform,
            mode: selectedMode,
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(selectedReasoningEffort ? { reasoningEffort: selectedReasoningEffort } : {}),
          },
        }),
      );
    },
  );
}
