import nodePath from "node:path";
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
import { discoverHostPiModelCatalog } from "./pi-model-catalog-seeding.js";
import {
  syncDiffStatsTracking,
  asString,
  asRecord,
  assertOnlyKeys,
  redactGlobalConfig,
  redactAppConfig,
  stripRendererCredentials,
  asOptionalString,
  asStringArray,
  asNonBlankString,
  asCachedCodexModels,
  peekLocalAgentBridge,
  peekContainerAgentBridge,
  fetchAcpNormalizedModelsResult,
  parseClaudeBridgeModelCatalog,
  projectPathKey,
  duplicateLocalPathGuard,
  readOriginUrl,
  createProjectFromScratch,
} from "./commands-helpers.js";

/**
 * Total extra time a first-use catalogue read may spend starting a bridge and
 * reading its live list before it answers from the durable cache instead.
 */
export const FIRST_USE_CATALOG_BUDGET_MS = 45_000;

/** The share of that budget allowed for the bridge to become ready. */
export const FIRST_USE_BRIDGE_READY_TIMEOUT_MS = 30_000;

/** The fetch receives only the budget left after bridge readiness work. */
export function firstUseCatalogFetchTimeoutMs(deadline: number, now = Date.now()): number {
  return Math.max(1_000, deadline - now);
}

export function registerProjectCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const {
    commands,
    conditionalManifestSnapshot,
    runProjectCreationCommand,
    refreshHostModelCatalog,
  } = dependencies;
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
  register("remove_project", async ({ projectId }, { storage }) => {
    const id = asString(projectId, "projectId");
    if (typeof storage.deleteAgentMailByProject === "function") {
      await storage.deleteAgentMailByProject(id);
    }
    return storage.removeProject(id);
  });
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
  register("ensure_host_pi_model_catalog", async (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    const cached = (await context.storage.getAgentModelCatalogCache()).pi?.models;
    if (cached?.length) return cached;
    const models = await discoverHostPiModelCatalog(context);
    if (models.length > 0) await context.storage.cacheAgentModelCatalog("pi", models);
    return models;
  });
  register("refresh_host_agent_model_catalog", async (args, context) => {
    assertOnlyKeys(args, ["agent", "projectId"], "arguments");
    const agent = asNonBlankString(args.agent, "agent");
    if (!isAgentPlatform(agent)) throw new Error(`Unknown agent platform: ${agent}`);
    const projectId =
      agent === "opencode" ? asNonBlankString(args.projectId, "projectId") : undefined;
    if (projectId && !(await context.storage.getProject(projectId))) {
      throw new Error(`Project not found: ${projectId}`);
    }
    const catalog = await refreshHostModelCatalog(context, agent);

    if (catalog.agent === "claude") {
      await context.storage.cacheAgentModelCatalog("claude", catalog.models);
    } else if (catalog.agent === "codex") {
      await context.storage.cacheAgentModelCatalog("codex", asCachedCodexModels(catalog.models));
    } else if (catalog.agent === "cursor" || catalog.agent === "grok" || catalog.agent === "pi") {
      await context.storage.cacheAgentModelCatalog(catalog.agent, catalog.models);
    } else {
      if (!projectId) throw new Error("OpenCode refresh requires a project target");
      const discoveredModels = catalog.models.map((model) => ({
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
      const existingModels =
        (await context.storage.getOpenCodeModelCatalog(projectId))?.models ?? [];
      const mergedModels = new Map(existingModels.map((model) => [model.id, model]));
      for (const model of discoveredModels) {
        mergedModels.set(model.id, model);
      }
      await context.storage.cacheOpenCodeModelCatalog(projectId, Array.from(mergedModels.values()));
    }

    return { agent: catalog.agent, modelCount: catalog.models.length };
  });
  register("get_agent_model_catalog_cache", async (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    let cache = await context.storage.getAgentModelCatalogCache();
    if (!cache.pi?.models.length) {
      const config = await context.storage.loadConfig();
      if (config.global.enabledAgentPlatforms?.includes("pi")) {
        const ensure = commands.get("ensure_host_pi_model_catalog");
        if (ensure) {
          try {
            await ensure({}, context);
            cache = await context.storage.getAgentModelCatalogCache();
          } catch (error) {
            // Keep startup non-fatal and return every last-known-good catalogue.
            // The next application launch can retry a transient provider error.
            console.warn(
              "[ElectronBackend] Failed to seed the host Pi model catalogue:",
              error instanceof Error ? error.message : "unknown error",
            );
          }
        }
      }
    }
    return cache;
  });
  register("get_native_agent_model_catalog", async (args, context) => {
    assertOnlyKeys(args, ["environmentId", "ensureAgent"], "arguments");
    const { storage } = context;
    const id = asNonBlankString(args.environmentId, "environmentId");
    const ensureAgent = args.ensureAgent;
    if (
      ensureAgent !== undefined &&
      ensureAgent !== "cursor" &&
      ensureAgent !== "grok" &&
      ensureAgent !== "pi"
    ) {
      throw new Error("ensureAgent must be one of: cursor, grok, pi");
    }
    const environment = await storage.getEnvironment(id);
    if (!environment) throw new Error(`Environment not found: ${id}`);
    const cache = await storage.getAgentModelCatalogCache();
    // Bounds the extra work a first-use read may add, so the model picker
    // cannot be left waiting on a cold bridge for an open-ended time. Only the
    // first-use branch consumes it; a read served from the durable cache is
    // unaffected.
    let firstUseDeadline: number | null = null;
    if (ensureAgent && !cache[ensureAgent]?.models.length) {
      // The empty-tab picker is the first consumer on a fresh installation, so
      // there may be neither a live bridge nor a durable last-known-good list.
      // Start only the platform the user is trying to select; eagerly starting
      // every enabled bridge would create unused processes in every environment.
      firstUseDeadline = Date.now() + FIRST_USE_CATALOG_BUDGET_MS;
      const awaitBridgeReady = commands.get("await_bridge_ready");
      if (awaitBridgeReady) {
        try {
          // The bridge's own health budget is what actually bounds a cold
          // start; waiting longer here only extends the case where the
          // environment is still being created, which a picker must not block
          // on.
          const ready = (await awaitBridgeReady(
            {
              environmentId: id,
              agent: ensureAgent,
              timeoutMs: FIRST_USE_BRIDGE_READY_TIMEOUT_MS,
            },
            context,
          )) as { status?: unknown; error?: { message?: unknown } } | undefined;
          // `await_bridge_ready` reports failure by returning, not throwing. It
          // is the launch here, so there are no other launch diagnostics to
          // inherit: without this the user sees an empty picker and nothing
          // anywhere records why.
          if (ready && ready.status !== "ready") {
            console.warn(
              `[ElectronBackend] The first-use ${ensureAgent} catalogue bridge did not become ready (${
                typeof ready.status === "string" ? ready.status : "unknown"
              }): ${typeof ready.error?.message === "string" ? ready.error.message : "no detail"}`,
            );
          }
        } catch (error) {
          console.warn(
            `[ElectronBackend] The first-use ${ensureAgent} catalogue bridge failed to start:`,
            error instanceof Error ? error.message : "unknown error",
          );
        }
      }
    }
    // Only the platform this read is trying to seed is held to the remaining
    // budget. The others are already answering from local bridge state.
    const firstUseFetchTimeoutMs = (kind: "cursor" | "grok" | "pi"): number | undefined =>
      firstUseDeadline !== null && kind === ensureAgent
        ? firstUseCatalogFetchTimeoutMs(firstUseDeadline)
        : undefined;
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
    const [cursorFetch, grokFetch, piFetch] = await Promise.all([
      fetchAcpNormalizedModelsResult(
        environment,
        context,
        "cursor",
        firstUseFetchTimeoutMs("cursor"),
      ),
      fetchAcpNormalizedModelsResult(environment, context, "grok", firstUseFetchTimeoutMs("grok")),
      fetchAcpNormalizedModelsResult(environment, context, "pi", firstUseFetchTimeoutMs("pi")),
    ]);
    const cursorModels = cursorFetch.models;
    const grokModels = grokFetch.models;
    const piModels = piFetch.models;
    for (const [agent, models] of [
      ["cursor", cursorModels],
      ["grok", grokModels],
      ["pi", piModels],
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
      ...(piModels.length > 0 ? piModels : (cache.pi?.models ?? [])),
    ];
    if (!ensureAgent) return result;
    const ensuredFetch = { cursor: cursorFetch, grok: grokFetch, pi: piFetch }[ensureAgent];
    return {
      models: result,
      status: result.some((model) => model.platform === ensureAgent)
        ? ("ready" as const)
        : ensuredFetch.status === "ok"
          ? ("empty" as const)
          : ("failed" as const),
    };
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
    if (agent === "pi") {
      return storage.cacheAgentModelCatalog("pi", args.models as AgentModel[]);
    }
    throw new Error("Expected agent to be claude, codex, or pi");
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
  /**
   * Experimental Cursor SDK sign-in.
   *
   * Split into start and poll rather than one awaited call: the browser flow is
   * human-paced and can take minutes, which is far longer than a request should
   * be held open. Every decision — spawning the bridge, parsing its output,
   * storing the credential, cancelling — stays here; the settings pane only
   * opens the returned URL and polls.
   */
  register("cursor_sdk_login_start", async (_payload, context) => {
    const { getBridgePath } = await import("./commands-servers.js");
    const { resolveBunBinary } = await import("./commands-agent-support.js");
    const { startCursorSdkLogin } = await import("./cursor-sdk-bridge.js");
    return startCursorSdkLogin(context, {
      bridgeEntrypoint: nodePath.join(getBridgePath(context, "cursor-bridge"), "dist", "index.js"),
      runtime: resolveBunBinary(context),
    });
  });
  register("cursor_sdk_login_status", async (_payload, context) => {
    const { cursorSdkLoginProgress } = await import("./cursor-sdk-bridge.js");
    const { resolveCursorApiKey } = await import("./commands-validation.js");
    const config = await context.storage.loadConfig();
    // The stored key is read only to report *which* credential is in play; it
    // is never returned.
    return cursorSdkLoginProgress(context, resolveCursorApiKey(config.global).apiKey);
  });
  register("cursor_sdk_login_cancel", async () => {
    const { cancelCursorSdkLogin } = await import("./cursor-sdk-bridge.js");
    cancelCursorSdkLogin();
    return { cancelled: true };
  });
  register("cursor_sdk_logout", async (_payload, context) => {
    const { cancelCursorSdkLogin, cursorSdkAuthStatus, cursorSdkLogout } =
      await import("./cursor-sdk-bridge.js");
    const { resolveCursorApiKey } = await import("./commands-validation.js");
    cancelCursorSdkLogin();
    await cursorSdkLogout(context);
    const config = await context.storage.loadConfig();
    return cursorSdkAuthStatus(context, resolveCursorApiKey(config.global).apiKey);
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
  // No current renderer calls this: create dialogs resolve every agent control
  // from Settings. It stays because a cached older web client still sends it,
  // and this is the only compatibility surface that a shipped bundle can reach —
  // an old renderer carries its own copy of the client-side wrapper, so keeping
  // one here would have protected nothing.
  register(
    "remember_environment_agent_selection",
    async ({ projectId, platform, mode }, { storage }) => {
      if (!isAgentPlatform(platform)) {
        throw new Error("Expected platform to be a supported agent platform");
      }
      const selectedPlatform = platform;
      const selectedMode = asString(mode, "mode");
      if (selectedMode !== "terminal" && selectedMode !== "native") {
        throw new Error("Expected mode to be terminal or native");
      }
      return redactAppConfig(
        await storage.patchRepositoryConfig(asString(projectId, "projectId"), {
          lastEnvironmentAgentSelection: { platform: selectedPlatform, mode: selectedMode },
        }),
      );
    },
  );
}
