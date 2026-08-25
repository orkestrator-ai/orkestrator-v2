import {
  isEmptyAgentSettings,
  normalizeAgentSettings,
  type AgentSettingsTier,
} from "@orkestrator/protocol/agent-settings";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  createEnvironment,
  defaultEnvironmentName,
  sanitizeBranchName,
  sanitizeEnvironmentName,
  discoverAgentExtensions,
} from "./commands-dependencies.js";
import type { Environment } from "./commands-dependencies.js";
import {
  terminalProcesses,
  mergingEnvironments,
  environmentSetupSessions,
  syncDiffStatsTracking,
  syncPrMonitorTracking,
  asString,
  assertOnlyKeys,
  asOptionalString,
  asRequiredBoolean,
  asNumber,
  asStringArray,
  asNonBlankString,
  asPortMappings,
  asEnvironmentType,
  makeUniqueEnvironmentSlug,
  createExtensionCommandRunner,
  listGitBranchesAtPath,
  renameEnvironmentToName,
  renameEnvironmentFromPrompt,
  parsePrState,
  toClientEnvironment,
  toClientEnvironmentSetupStartResult,
  terminalOutputBufferLength,
  logSetupTerminal,
  getDockerStatus,
  getOrkestratorContainerStates,
  syncStoredEnvironmentStatus,
  clearPendingAgentLaunchUpdates,
  startEnvironmentSetup,
  admitEnvironmentStartTask,
  stopEnvironmentTask,
  recreateEnvironmentTask,
  runEnvironmentSetupNow,
  deleteEnvironmentTask,
  scheduleMergeCleanupRecovery,
  logEnvironmentLifecycleFailure,
} from "./commands-helpers.js";
import type { CommandContext } from "./commands-context.js";
import { cleanupLogStorage, getLogStorageStats } from "./log-storage.js";

/**
 * A validated environment tier, or `undefined` when it expresses no opinion.
 *
 * Absence already means "inherit everything", so an all-empty block is stored
 * as nothing at all — the same rule `loadEnvironments` applies when it migrates
 * a legacy record. Without this an explicit clear would leave a `{}` behind on
 * every environment the user had ever opened the settings dialog for.
 */
function normalizedTier(value: unknown): AgentSettingsTier | undefined {
  const normalized = normalizeAgentSettings(value);
  return isEmptyAgentSettings(normalized) ? undefined : normalized;
}

export function registerEnvironmentCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const { conditionalManifestSnapshot, schedulePendingEnvironmentRename, extensionDiscoveryCache } =
    dependencies;
  register("get_log_directory", (_args, { storage }) => storage.getLogDirectory());
  register("get_log_storage_stats", (args, { storage }) => {
    assertOnlyKeys(args, [], "arguments");
    return getLogStorageStats(storage.getLogDirectory());
  });
  register("cleanup_logs", (args, { storage }) => {
    assertOnlyKeys(args, [], "arguments");
    return cleanupLogStorage(storage.getLogDirectory());
  });

  register("get_environments", async ({ projectId }, context) => {
    const { storage } = context;
    const environments = await storage.getEnvironmentsByProject(asString(projectId, "projectId"));
    // One shared `docker ps` snapshot for the whole batch instead of one
    // `docker inspect` per containerized environment.
    const knownContainerStates = environments.some(
      (environment) => environment.environmentType !== "local" && environment.containerId,
    )
      ? await getOrkestratorContainerStates(context)
      : null;
    const synced = await Promise.all(
      environments.map((environment) =>
        syncStoredEnvironmentStatus(
          environment,
          storage,
          knownContainerStates,
          context.strictDockerOwner,
        ),
      ),
    );
    for (let index = 0; index < synced.length; index += 1) {
      const environment = synced[index]!;
      if (
        environment.lifecycleOperation === "merging" &&
        !mergingEnvironments.has(environment.id)
      ) {
        synced[index] = await storage.updateEnvironment(environment.id, {
          lifecycleOperation: null,
          lifecycleOperationStartedAt: null,
        });
      }
    }
    for (const environment of synced) {
      if (environment.cleanupAfterMergeRequestedAt) {
        scheduleMergeCleanupRecovery(environment.id, context);
      }
    }
    // Rehydration is also the recovery path after a backend restart. If startup
    // completed before the process exited, resume any persisted rename intent
    // without requiring the user to stop and start the environment again.
    for (const environment of synced) {
      if (environment.status === "running" && environment.pendingRenamePrompt?.trim()) {
        schedulePendingEnvironmentRename(environment.id, context);
      }
    }
    // Same recovery argument for diff watchers: reconciling here re-arms them
    // after a backend restart without waiting for a lifecycle command.
    void syncDiffStatsTracking(context).catch(() => undefined);
    // Cleanup-after-merge intent also makes exact-URL PR monitoring authoritative
    // after a restart. The monitor never resubmits the merge; it only confirms a
    // terminal state so the persisted deletion follow-up can resume safely.
    void syncPrMonitorTracking(context).catch(() => undefined);
    return synced.map(toClientEnvironment);
  });
  register("get_environment_snapshots", (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "environment", async () =>
      (await storage.getEnvironmentsByProject(asString(args.projectId, "projectId"))).map(
        toClientEnvironment,
      ),
    ),
  );
  register("get_environment", ({ environmentId }, { storage }) =>
    storage.getEnvironment(asString(environmentId, "environmentId")),
  );
  register("reorder_environments", ({ projectId, environmentIds }, { storage }) =>
    storage
      .reorderEnvironments(asString(projectId, "projectId"), asStringArray(environmentIds))
      .then((environments) => environments.map(toClientEnvironment)),
  );
  register(
    "create_environment",
    async (
      {
        projectId,
        name,
        networkAccessMode,
        initialPrompt,
        portMappings,
        environmentType,
        namingPrompt,
        buildPipelineId,
      },
      context,
    ) => {
      const { storage } = context;
      const project = await storage.getProject(asString(projectId, "projectId"));
      if (!project) throw new Error(`Project not found: ${projectId}`);
      const requestedEnvironmentType = asEnvironmentType(environmentType);
      if (requestedEnvironmentType === "local" && !project.localPath) {
        throw new Error("Project has no local path - cannot create a local worktree");
      }
      const repoConfig = await storage.getRepositoryConfig(project.id);
      const explicitName = asOptionalString(name)?.trim();
      const initialPromptText = asOptionalString(initialPrompt);
      const pendingRenamePrompt = explicitName
        ? undefined
        : asOptionalString(namingPrompt)?.trim() || undefined;
      const baseName = explicitName
        ? sanitizeEnvironmentName(explicitName)
        : defaultEnvironmentName();
      const existingEnvironments = await storage.getEnvironmentsByProject(project.id);
      const existingGitBranches = project.localPath
        ? await listGitBranchesAtPath(project.localPath, false)
        : [];
      const uniqueName = makeUniqueEnvironmentSlug(
        baseName,
        existingEnvironments,
        existingGitBranches,
      );
      const env = createEnvironment(project.id, {
        name: uniqueName,
        buildPipelineId: asOptionalString(buildPipelineId),
        networkAccessMode:
          networkAccessMode === "full"
            ? "full"
            : networkAccessMode === "restricted"
              ? "restricted"
              : undefined,
        initialPrompt: initialPromptText,
        portMappings: asPortMappings(portMappings),
        environmentType: requestedEnvironmentType,
        entryPort: repoConfig.entryPort,
        pendingRenamePrompt,
      });
      await storage.patchRepositoryConfig(project.id, {
        lastEnvironmentType: env.environmentType,
      });
      return toClientEnvironment(await storage.addEnvironment(env));
    },
  );
  register("delete_environment", async ({ environmentId }, context) => {
    const id = asString(environmentId, "environmentId");
    extensionDiscoveryCache.invalidate(id);
    return deleteEnvironmentTask(id, context);
  });
  register("rename_environment", async ({ environmentId, name }, context) => {
    const { storage } = context;
    const id = asString(environmentId, "environmentId");
    const newName = sanitizeEnvironmentName(asString(name, "name"));
    const environment = await storage.getEnvironment(id);
    if (!environment) throw new Error(`Environment not found: ${id}`);
    const updated = await renameEnvironmentToName(
      environment,
      newName,
      sanitizeBranchName(newName),
      context,
    );
    await syncPrMonitorTracking(context);
    return toClientEnvironment(updated);
  });
  register("rename_environment_from_prompt", async ({ environmentId, prompt }, context) => {
    const envId = asString(environmentId, "environmentId");
    await renameEnvironmentFromPrompt(envId, asString(prompt, "prompt"), context);
    await syncPrMonitorTracking(context);
  });
  register("get_environment_status", async ({ environmentId }, context) => {
    const { storage } = context;
    const environment = await storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    const knownContainerStates =
      environment.environmentType !== "local" && environment.containerId
        ? await getOrkestratorContainerStates(context)
        : null;
    return (
      await syncStoredEnvironmentStatus(
        environment,
        storage,
        knownContainerStates,
        context.strictDockerOwner,
      )
    ).status;
  });
  register("sync_environment_status", async ({ environmentId }, context) => {
    const { storage } = context;
    const environment = await storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    const knownContainerStates =
      environment.environmentType !== "local" && environment.containerId
        ? await getOrkestratorContainerStates(context)
        : null;
    return toClientEnvironment(
      await syncStoredEnvironmentStatus(
        environment,
        storage,
        knownContainerStates,
        context.strictDockerOwner,
      ),
    );
  });
  register("sync_all_environments_with_docker", async (_args, context) => {
    const { storage } = context;
    const cleared: string[] = [];
    const environments = (await storage.loadEnvironments()).filter(
      (environment) => environment.containerId,
    );
    if (environments.length === 0) return cleared;
    // A container listed by the labelled `docker ps -a` definitely still
    // exists; only unlisted ones need the per-container existence probe, which
    // also covers containers created without the label.
    const knownContainerStates = await getOrkestratorContainerStates(context);
    for (const environment of environments) {
      if (knownContainerStates?.has(environment.containerId!)) continue;
      if (context.strictDockerOwner && knownContainerStates) {
        await storage.updateEnvironment(environment.id, { status: "stopped", containerId: null });
        cleared.push(environment.id);
        continue;
      }
      try {
        await getDockerStatus(environment.containerId!);
      } catch {
        await storage.updateEnvironment(environment.id, { status: "stopped", containerId: null });
        cleared.push(environment.id);
      }
    }
    return cleared;
  });
  // `admit` refuses synchronously by design, so every lifecycle command is
  // `async`: a caller that reaches the registry directly must see a rejection
  // rather than a throw from the call expression itself.
  register("start_environment", async ({ environmentId }, context) => {
    const { task } = await admitEnvironmentStartTask(
      asString(environmentId, "environmentId"),
      context,
      schedulePendingEnvironmentRename,
    );
    return toClientEnvironmentSetupStartResult(await task);
  });
  register("start_environment_background", async ({ environmentId }, context) => {
    const id = asString(environmentId, "environmentId");
    // Validate before acknowledging the request. Once accepted, the task is
    // backend-owned: a renderer, browser, or reverse proxy can disconnect
    // without cancelling Docker provisioning or losing the durable launch.
    const { task } = await admitEnvironmentStartTask(id, context, schedulePendingEnvironmentRename);
    void task.catch((error) => {
      // `startEnvironmentOnce` has already logged the cause; this only records
      // that nobody was awaiting the result, so the rejection is not unhandled.
      logEnvironmentLifecycleFailure("background start", id, error);
    });
  });
  register("stop_environment", async ({ environmentId }, context) =>
    stopEnvironmentTask(asString(environmentId, "environmentId"), context, (id) =>
      extensionDiscoveryCache.invalidate(id),
    ),
  );
  register("recreate_environment", async ({ environmentId }, context) => {
    const result = await recreateEnvironmentTask(
      asString(environmentId, "environmentId"),
      context,
      schedulePendingEnvironmentRename,
      (id) => extensionDiscoveryCache.invalidate(id),
    );
    return result ? toClientEnvironmentSetupStartResult(result) : undefined;
  });
  register("set_environment_pr", async (args, context) => {
    assertOnlyKeys(args, ["environmentId", "prUrl", "prState", "hasMergeConflicts"], "arguments");
    const environmentId = asString(args.environmentId, "environmentId");
    const prUrl = asString(args.prUrl, "prUrl");
    const prState = parsePrState(args.prState);
    if (!prState) throw new Error("Expected prState to be open, merged, or closed");
    const hasMergeConflicts = args.hasMergeConflicts;
    if (hasMergeConflicts !== null && typeof hasMergeConflicts !== "boolean") {
      throw new Error("Expected hasMergeConflicts to be a boolean or null");
    }
    const updated = await context.storage.updateEnvironment(environmentId, {
      prUrl,
      prState,
      hasMergeConflicts,
      ...(prState !== "open" || hasMergeConflicts === false
        ? { prRecheckAfterAgentCompletionArmedAt: undefined }
        : {}),
    });
    // A PR recorded outside the monitor (e.g. right after a merge command) must
    // enter the monitored set without waiting for a client to rehydrate.
    void syncPrMonitorTracking(context).catch(() => undefined);
    return toClientEnvironment(updated);
  });
  register("clear_environment_pr", async ({ environmentId }, context) => {
    await context.storage.updateEnvironment(asString(environmentId, "environmentId"), {
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      prRecheckAfterAgentCompletionArmedAt: undefined,
    });
    void syncPrMonitorTracking(context).catch(() => undefined);
  });
  register(
    "get_environment_pr_url",
    async ({ environmentId }, { storage }) =>
      (await storage.getEnvironment(asString(environmentId, "environmentId")))?.prUrl ?? null,
  );
  register("override_environment_setup", async ({ environmentId }, context) => {
    const id = asString(environmentId, "environmentId");
    const current = await context.storage.getEnvironment(id);
    if (!current) throw new Error(`Environment not found: ${id}`);
    let environment = await context.storage.updateEnvironment(id, {
      status: "running",
      setupScriptsComplete: true,
      setupPhase: "ready",
      setupOverride: true,
      setupCompletedAt: new Date().toISOString(),
      lifecycleError: null,
    });
    if (environment.pendingAgentLaunch && context.nativeAgents) {
      await context.nativeAgents.reconcileInitialLaunch(environment.id).catch(() => {
        // The launch intent remains durable. A transient bridge failure must not
        // roll back the user's explicit setup override.
      });
      environment = (await context.storage.getEnvironment(environment.id)) ?? environment;
    }
    context.emit("environment-setup-complete", {
      environment_id: id,
      success: true,
      overridden: true,
      environment: toClientEnvironment(environment),
    });
    return toClientEnvironment(environment);
  });
  register("run_environment_setup", async ({ environmentId }, context) => {
    return toClientEnvironment(
      await runEnvironmentSetupNow(asString(environmentId, "environmentId"), context),
    );
  });
  register("ensure_environment_setup", async ({ environmentId }, context) => {
    const environment = await context.storage.getEnvironment(
      asString(environmentId, "environmentId"),
    );
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    logSetupTerminal("renderer ensured setup", {
      environmentId: environment.id,
      environmentName: environment.name,
      setupScriptsComplete: environment.setupScriptsComplete ?? false,
      status: environment.status,
    });
    return toClientEnvironmentSetupStartResult(await startEnvironmentSetup(environment, context));
  });
  const getEnvironmentSetupSessionSnapshot = async (
    environmentId: string,
    context: CommandContext,
  ) => {
    const id = environmentId;
    const session = environmentSetupSessions.get(id);
    if (!session) {
      const environment = await context.storage.getEnvironment(id);
      if (environment?.setupSessionId && environment.setupStartedAt) {
        return {
          environmentId: id,
          sessionId: environment.setupSessionId,
          running: environment.setupPhase === "running",
          startedAt: environment.setupStartedAt,
          completedAt: environment.setupCompletedAt,
          success:
            environment.setupPhase === "ready"
              ? true
              : environment.setupPhase === "failed"
                ? false
                : undefined,
          terminalRunning: terminalProcesses.has(environment.setupSessionId),
        };
      }
      logSetupTerminal("renderer requested setup session: none", {
        environmentId: id,
      });
      return null;
    }
    const payload = {
      ...session,
      terminalRunning: terminalProcesses.has(session.sessionId),
    };
    logSetupTerminal("renderer requested setup session", {
      environmentId: id,
      sessionId: session.sessionId,
      running: session.running,
      terminalRunning: payload.terminalRunning,
      success: session.success ?? null,
      bufferChars: terminalOutputBufferLength(session.sessionId),
    });
    return payload;
  };
  register("await_environment_setup_session", async ({ environmentId, timeoutMs }, context) => {
    const id = asString(environmentId, "environmentId");
    const timeout = timeoutMs === undefined ? 0 : asNumber(timeoutMs, "timeoutMs");
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60_000) {
      throw new Error("timeoutMs must be an integer between 0 and 60000");
    }
    const deadline = Date.now() + timeout;
    while (true) {
      const snapshot = await getEnvironmentSetupSessionSnapshot(id, context);
      if (snapshot) return snapshot;
      const environment = await context.storage.getEnvironment(id);
      if (
        !environment ||
        (environment.setupPhase !== "pending" && environment.setupPhase !== "running") ||
        Date.now() >= deadline
      ) {
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });
  register("update_port_mappings", ({ environmentId, portMappings }, { storage }) =>
    storage
      .updateEnvironment(asString(environmentId, "environmentId"), {
        portMappings: asPortMappings(portMappings) ?? [],
      })
      .then(toClientEnvironment),
  );
  register(
    "update_environment_agent_settings",
    async (
      {
        environmentId,
        agentSettings,
        pendingAgentLaunch,
        initialAgentModel,
        initialReasoningEffort,
        initialPromptAttachments,
      },
      { storage },
    ) => {
      const id = asString(environmentId, "environmentId");
      // Only a request that actually carried the block may rewrite it. Storage
      // reads key presence, so writing it unconditionally would make a
      // launch-intent-only call (`{ environmentId, pendingAgentLaunch }`) erase
      // every per-environment override the settings dialog stores — this tier
      // now holds models, reasoning levels and action defaults, not just modes.
      // An explicit `null` still clears, which is how the dialog returns an
      // environment to inheriting everything.
      //
      // What does arrive is normalized at the boundary, as the global config's
      // own settings are: a malformed block accepted here is later applied to a
      // launch the user cannot see being configured.
      const updates = (
        agentSettings === undefined ? {} : { agentSettings: normalizedTier(agentSettings) }
      ) as Partial<Environment>;
      if (typeof pendingAgentLaunch === "boolean") {
        updates.pendingAgentLaunch = pendingAgentLaunch;
        if (!pendingAgentLaunch) {
          updates.initialAgentModel = undefined;
          updates.initialReasoningEffort = undefined;
          updates.initialPromptAttachments = undefined;
        }
      }
      if (pendingAgentLaunch !== false && typeof initialAgentModel === "string") {
        updates.initialAgentModel = initialAgentModel;
      }
      if (pendingAgentLaunch !== false && typeof initialReasoningEffort === "string") {
        updates.initialReasoningEffort = initialReasoningEffort;
      }
      if (pendingAgentLaunch !== false && Array.isArray(initialPromptAttachments)) {
        updates.initialPromptAttachments =
          initialPromptAttachments as Environment["initialPromptAttachments"];
      }
      return toClientEnvironment(await storage.updateEnvironment(id, updates));
    },
  );
  register("set_environment_pending_agent_launch", ({ environmentId, pending }, { storage }) => {
    const nextPending = asRequiredBoolean(pending, "pending");
    return storage
      .updateEnvironment(asString(environmentId, "environmentId"), {
        ...(nextPending ? { pendingAgentLaunch: true } : clearPendingAgentLaunchUpdates()),
      })
      .then(toClientEnvironment);
  });
  register(
    "acknowledge_startup_agent_session",
    ({ environmentId, providerSessionId, startedAt }, { storage }) =>
      storage
        .acknowledgeStartupAgentSession(
          asString(environmentId, "environmentId"),
          providerSessionId === undefined
            ? undefined
            : asNonBlankString(providerSessionId, "providerSessionId"),
          startedAt === undefined ? undefined : asNonBlankString(startedAt, "startedAt"),
        )
        .then(toClientEnvironment),
  );
  // The renderer rewrites the initial prompt once it has uploaded the create
  // dialog's attachments and knows their in-workspace paths. Persisting that
  // rewritten text is what lets a post-eviction launch recover a prompt whose
  // attachment references still resolve.
  register(
    "set_environment_initial_prompt",
    ({ environmentId, initialPrompt, initialPromptAttachments }, { storage }) =>
      storage
        .updateEnvironment(asString(environmentId, "environmentId"), {
          initialPrompt: asString(initialPrompt, "initialPrompt"),
          ...(Array.isArray(initialPromptAttachments) ? { initialPromptAttachments } : {}),
        })
        .then(toClientEnvironment),
  );
  register("get_environment_extensions", async ({ environmentId, refresh }, context) => {
    const id = asString(environmentId, "environmentId");
    return extensionDiscoveryCache.get(
      id,
      async () => {
        const environment = await context.storage.getEnvironment(id);
        if (!environment) throw new Error(`Environment not found: ${id}`);
        return discoverAgentExtensions(createExtensionCommandRunner(environment, context));
      },
      { refresh: refresh === true },
    );
  });
  register("update_environment_allowed_domains", ({ environmentId, domains }, { storage }) =>
    storage
      .updateEnvironment(asString(environmentId, "environmentId"), {
        allowedDomains: asStringArray(domains),
      })
      .then(toClientEnvironment),
  );
  register("add_environment_domains", async ({ environmentId, domains }, { storage }) => {
    const environment = await storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    const updated = Array.from(
      new Set([...(environment.allowedDomains ?? []), ...asStringArray(domains)]),
    );
    await storage.updateEnvironment(environment.id, { allowedDomains: updated });
    return updated.join(",");
  });
  register("remove_environment_domains", async ({ environmentId, domains }, { storage }) => {
    const environment = await storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    const remove = new Set(asStringArray(domains));
    const updated = (environment.allowedDomains ?? []).filter((domain) => !remove.has(domain));
    await storage.updateEnvironment(environment.id, { allowedDomains: updated });
    return updated.join(",");
  });
}
