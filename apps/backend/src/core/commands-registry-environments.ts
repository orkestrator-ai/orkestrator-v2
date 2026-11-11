import {
  acknowledgeStartupAgentSessionCommand,
  applyEnvironmentAllowedDomainsCommand,
  approveEnvironmentSetupCommand,
  approveProjectSetupCommandsCommand,
  awaitEnvironmentSetupSessionCommand,
  cancelContainerOperationCommand,
  cleanupLogsCommand,
  clearEnvironmentPrCommand,
  createEnvironmentCommand,
  deleteEnvironmentCommand,
  discardRecoveryCopyCommand,
  ensureEnvironmentSetupCommand,
  ensureProjectHomeEnvironmentCommand,
  forkEnvironmentCommand,
  getClaudeTerminalStateCommand,
  getContainerLifecycleSnapshotCommand,
  getEnvironmentCommand,
  getEnvironmentExtensionsCommand,
  getEnvironmentInputsCommand,
  getEnvironmentNetworkPolicyCommand,
  getEnvironmentPrHealthCommand,
  getEnvironmentPrUrlCommand,
  getEnvironmentResourcesCommand,
  getEnvironmentSetupApprovalCommand,
  getEnvironmentSnapshotCommand,
  getEnvironmentSnapshotsCommand,
  getEnvironmentStatusCommand,
  getEnvironmentsCommand,
  getLogDirectoryCommand,
  getLogStorageStatsCommand,
  getRebuildPreviewCommand,
  listRecoveryCopiesCommand,
  moveEnvironmentCommand,
  overrideEnvironmentSetupCommand,
  prepareEnvironmentFirstPromptCommand,
  reconcilePendingEnvironmentRenamesCommand,
  recreateEnvironmentCommand,
  removeEnvironmentDomainsCommand,
  renameEnvironmentCommand,
  renameEnvironmentFromPromptCommand,
  reorderEnvironmentsCommand,
  resolveContainerOperationCommand,
  restoreProviderCredentialsCommand,
  restoreRecoveryCopyCommand,
  revokeProviderCredentialsCommand,
  runEnvironmentSetupCommand,
  setContainerResourceLimitsCommand,
  setEnvironmentPrCommand,
  startEnvironmentBackgroundCommand,
  startEnvironmentCommand,
  stopEnvironmentCommand,
  syncAllEnvironmentsWithDockerCommand,
  syncEnvironmentStatusCommand,
  updateEnvironmentAgentSettingsCommand,
  updateEnvironmentAllowedDomainsCommand,
  updateEnvironmentResourcesCommand,
  updatePortMappingsCommand,
} from "@orkestrator/protocol/contract/domains/environments";
import { environmentSetupCompleteEvent } from "@orkestrator/protocol/contract/domains/events";
import { reconcileProjectHomeEnvironment } from "./project-home-environment.js";
import {
  containerLifecycleSnapshot,
  parseContainerLifecycle,
  parseContainerMutationIdentity,
  parseRecreateEnvironmentRequest,
} from "@orkestrator/protocol/container-lifecycle";
import { resolveNeedsAttentionOperation } from "./container-lifecycle-service.js";
import { rebuildPreview } from "./container-replacement.js";
import { listRecoveryCopies } from "./recovery-copies.js";
import { applyEnvironmentAllowedDomains, environmentNetworkPolicy } from "./container-network.js";
import {
  environmentResourcePolicy,
  unenforceableOnThisDaemon,
  updateEnvironmentResources,
} from "./container-resources.js";
import {
  parseResourceLimits,
  type ContainerResourceLimits,
} from "@orkestrator/protocol/container-resources";
import {
  environmentInputStatus,
  restoreProviderCredentials,
  revokeProviderCredentials,
} from "./portable-input-status.js";
import {
  isEmptyAgentSettings,
  normalizeAgentSettings,
  type AgentSettingsTier,
} from "@orkestrator/protocol/agent-settings";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { normalizeAgentMessagingSettings } from "@orkestrator/protocol/agent-mail";
import { environmentMailMarkers, isWorkingPipelineRecord } from "./nodes/index.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { withAsyncArgumentFailures } from "./commands-registry-async-args.js";
import { createEnvironment, defaultEnvironmentName, sanitizeEnvironmentName } from "./storage.js";
import { discoverAgentExtensions } from "./extension-discovery.js";
import { dockerOwnerNamespace } from "./docker-ownership.js";
import type { Environment } from "./models.js";
import {
  asString,
  asOptionalString,
  asNumber,
  asStringArray,
  asNonBlankString,
  asPortMappings,
  asEnvironmentType,
  makeUniqueEnvironmentSlug,
  allocateEnvironmentBranchName,
  createExtensionCommandRunner,
  renameEnvironmentToName,
  renameEnvironmentFromPrompt,
  parsePrState,
  toClientEnvironment,
  toClientEnvironmentSetupStartResult,
  logSetupTerminal,
  inspectDockerContainerIdentity,
  isMissingDockerObjectError,
  getOrkestratorContainerStates,
  syncStoredEnvironmentStatus,
  startEnvironmentSetup,
  admitEnvironmentStartTask,
  stopEnvironmentTask,
  recreateEnvironmentTask,
  restoreRecoveryCopyTask,
  discardRecoveryCopyTask,
  runEnvironmentSetupNow,
  deleteEnvironmentTask,
  scheduleMergeCleanupRecovery,
  logEnvironmentLifecycleFailure,
  enqueueEnvironmentLifecycleOperation,
} from "./commands-helpers.js";
import { ControlRequestConflictError } from "./storage-projects.js";
import { forkEnvironmentRecord } from "./commands-environment-fork.js";
import type { CommandContext } from "./commands-context.js";
import { cleanupLogStorage, getLogStorageStats } from "./log-storage.js";
import { ensureProjectHomeEnvironment, readCheckoutBranch } from "./project-home-environment.js";
import { resolveProjectGitRoot } from "./project-git-service.js";
import { validateWorktreeLocation } from "./worktree-locations.js";
import { moveEnvironmentTask } from "./environment-move.js";
import {
  describeEnvironmentSetupApproval,
  localSetupWorktree,
  readSetupLocalCommands,
  setupCommandsHash,
} from "./setup-approval.js";

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
  registerCommand: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  // `async` handlers keep rejecting on bad arguments (`commands-registry-async-args.ts`).
  const register = withAsyncArgumentFailures(registerCommand);
  const {
    conditionalManifestSnapshot,
    schedulePendingEnvironmentRename,
    prepareEnvironmentFirstPrompt,
    reconcilePendingEnvironmentRenames,
    extensionDiscoveryCache,
  } = dependencies;
  register(getLogDirectoryCommand, (_args, { storage }) => storage.getLogDirectory());
  register(getLogStorageStatsCommand, (_args, { storage }) => {
    return getLogStorageStats(storage.getLogDirectory());
  });
  register(cleanupLogsCommand, (_args, { storage }) => {
    return cleanupLogStorage(storage.getLogDirectory());
  });

  register(getEnvironmentsCommand, async ({ projectId }, context) => {
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
          context,
          knownContainerStates,
          context.strictDockerOwner,
        ),
      ),
    );
    for (let index = 0; index < synced.length; index += 1) {
      const environment = synced[index]!;
      if (
        environment.lifecycleOperation === "merging" &&
        !context.runtime.environments.isMerging(environment.id)
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
    // Same recovery argument for diff watchers: reconciling here re-arms them
    // after a backend restart without waiting for a lifecycle command.
    void context.runtime.diffStats.sync(context).catch(() => undefined);
    // Cleanup-after-merge intent also makes exact-URL PR monitoring authoritative
    // after a restart. The monitor never resubmits the merge; it only confirms a
    // terminal state so the persisted deletion follow-up can resume safely.
    void context.runtime.prMonitor.sync(context).catch(() => undefined);
    return synced.map(toClientEnvironment);
  });
  register(getEnvironmentSnapshotsCommand, async (args, context) => {
    const { storage, runtime } = context;
    const load = async () =>
      (await storage.getEnvironmentsByProject(asString(args.projectId, "projectId"))).map(
        toClientEnvironment,
      );
    if (args.includePrMonitorHealth !== true) {
      return conditionalManifestSnapshot(args, storage, "environment", load);
    }
    // A node summary read (`NODE_SUMMARY_ENVIRONMENT_READ_ARGS`). The health is
    // runtime monitor state that the environment manifest revision does not
    // cover, so this form is never answered `unchanged`.
    // Summary-only command nodes must also re-arm polling after a leaf restart.
    // Reconciliation schedules detection; the response need not await GitHub.
    await runtime.prMonitor.sync(context);
    const environments = await load();
    const announced = runtime.prMonitor.announcedStates();
    // Match the local sidebar's pipeline.environmentId membership. Persisted
    // buildPipelineId can outlive deletion and is also copied onto forks.
    const pipelines = await storage.listBuildPipelines(asString(args.projectId, "projectId"));
    const buildEnvironmentIds = new Set(pipelines.map((pipeline) => pipeline.environmentId));
    const activeBuildEnvironmentIds = new Set(
      pipelines.filter(isWorkingPipelineRecord).map((pipeline) => pipeline.environmentId),
    );
    // The row's agent-mail badge, counted as this machine's own sidebar counts it.
    const mail = normalizeAgentMessagingSettings((await storage.loadConfig()).global.agentMessaging)
      .enabled
      ? environmentMailMarkers(await storage.getAgentMailSummary())
      : new Map();
    // A machine-level fact, stamped on each row so a command node needs no
    // extra read; absent while unknown.
    const dockerAvailable = await runtime.dockerAvailability.forSummary();
    return environments.map((environment) => ({
      ...environment,
      ...(dockerAvailable === undefined ? {} : { dockerAvailable }),
      ...runtime.prMonitor.relayedHealth(environment, announced),
      ...(buildEnvironmentIds.has(environment.id) ? { buildPipeline: true as const } : {}),
      ...(activeBuildEnvironmentIds.has(environment.id) ? { buildActive: true as const } : {}),
      ...mail.get(environment.id),
    }));
  });
  // One environment as `get_environment_snapshots` lists it, for a client that
  // was told exactly one changed. Reads only that row.
  register(getEnvironmentSnapshotCommand, async ({ environmentId }, { storage }) => {
    const environment = await storage.getEnvironment(asString(environmentId, "environmentId"));
    return environment ? toClientEnvironment(environment) : null;
  });
  /**
   * The PR monitor health of a project's environments (check counts, merge
   * permission, whether the monitor vouches for the reading), from announced
   * monitor state only: no reconciliation and no GitHub call. A coordinator's
   * environment reads add it to decide "ready to merge".
   */
  register(getEnvironmentPrHealthCommand, async (args, { storage, runtime }) => {
    const projectId = asString(args.projectId, "projectId");
    const wanted = Array.isArray(args.environmentIds)
      ? new Set(
          args.environmentIds.filter((id): id is string => typeof id === "string").slice(0, 1_000),
        )
      : null;
    const announced = runtime.prMonitor.announcedStates();
    const health: Record<string, ReturnType<typeof runtime.prMonitor.relayedHealth>> = {};
    for (const environment of await storage.getEnvironmentsByProject(projectId)) {
      if (!environment.prUrl || (wanted && !wanted.has(environment.id))) continue;
      health[environment.id] = runtime.prMonitor.relayedHealth(environment, announced);
    }
    return health;
  });
  register(getEnvironmentCommand, async ({ environmentId, includeFinalPrState }, { storage }) => {
    const environment = await storage.getEnvironment(asString(environmentId, "environmentId"));
    return environment
      ? reconcileProjectHomeEnvironment(environment, storage)
      : includeFinalPrState === true
        ? storage.getFinalEnvironmentPr(asString(environmentId, "environmentId"))
        : null;
  });
  // `claude-state-*` frames are emitted only on change, so a client whose
  // disconnect outlasted gateway replay reads the persisted state here instead
  // of waiting for the next transition. Only the state and its timestamp leave
  // the backend; the other activity sources stay private. The renderer holds
  // the stored id, so this is an exact match and never asks Docker.
  register(getClaudeTerminalStateCommand, async ({ containerId }, { storage }) => {
    const id = asString(containerId, "containerId");
    const environment = (await storage.loadEnvironments()).find(
      (candidate) => candidate.containerId === id,
    );
    const source = environment?.agentActivitySources?.["claude-terminal"];
    return source ? { state: source.state, occurredAt: source.updatedAt } : null;
  });
  register(reorderEnvironmentsCommand, ({ projectId, environmentIds }, { storage }) =>
    storage
      .reorderEnvironments(asString(projectId, "projectId"), asStringArray(environmentIds))
      .then((environments) => environments.map(toClientEnvironment)),
  );
  register(
    createEnvironmentCommand,
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
        agentSettings,
        pendingAgentLaunch,
        initialAgentPlatform,
        initialAgentModel,
        initialReasoningEffort,
        initialFastMode,
        initialConversationMode,
        controlRequestId,
        controlRequestFingerprint,
        delegationBaseBranch,
        delegationBaseCommit,
        worktreeBaseDir,
      },
      context,
    ) => {
      const { storage } = context;
      const project = await storage.getProject(asString(projectId, "projectId"));
      if (!project) throw new Error(`Project not found: ${projectId}`);
      const externalRequestId = asOptionalString(controlRequestId)?.trim();
      const requestFingerprint = asOptionalString(controlRequestFingerprint);
      if (requestFingerprint !== undefined && !/^[0-9a-f]{64}$/.test(requestFingerprint)) {
        throw new Error("controlRequestFingerprint must be a SHA-256 hex digest");
      }
      if (requestFingerprint !== undefined && !externalRequestId) {
        throw new Error("controlRequestFingerprint requires controlRequestId");
      }
      if (externalRequestId) {
        if (externalRequestId.length > 256) {
          throw new Error("controlRequestId must be at most 256 characters");
        }
        const existing = (await storage.getEnvironmentsByProject(project.id)).find(
          (candidate) => candidate.controlRequestId === externalRequestId,
        );
        if (existing) {
          if (
            existing.controlRequestFingerprint &&
            requestFingerprint &&
            existing.controlRequestFingerprint !== requestFingerprint
          ) {
            throw new ControlRequestConflictError(externalRequestId, existing.id);
          }
          return toClientEnvironment(existing);
        }
      }
      const requestedEnvironmentType = asEnvironmentType(environmentType);
      if (requestedEnvironmentType === "local" && !project.localPath) {
        throw new Error("Project has no local path - cannot create a local worktree");
      }
      let chosenWorktreeBaseDir: string | undefined;
      if (worktreeBaseDir !== undefined && worktreeBaseDir !== null) {
        if (requestedEnvironmentType !== "local") {
          throw new Error("Only a local environment can choose its worktree location");
        }
        chosenWorktreeBaseDir = validateWorktreeLocation(worktreeBaseDir, {
          label: "Worktree location",
          dataDir: storage.getDataDir(),
          projectPath: project.localPath,
        });
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
      const uniqueName = makeUniqueEnvironmentSlug(baseName, existingEnvironments);
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
      env.branch = await allocateEnvironmentBranchName({
        name: env.name,
        environmentId: env.id,
        siblingEnvironments: existingEnvironments,
        projectPath: requestedEnvironmentType === "local" ? project.localPath : null,
        remoteUrl: project.gitUrl,
      });
      env.controlRequestId = externalRequestId || undefined;
      if (chosenWorktreeBaseDir) env.worktreeBaseDir = chosenWorktreeBaseDir;
      if (requestFingerprint) env.controlRequestFingerprint = requestFingerprint;
      if (delegationBaseBranch !== undefined || delegationBaseCommit !== undefined) {
        const baseBranch = asOptionalString(delegationBaseBranch)?.trim();
        const baseCommit = asOptionalString(delegationBaseCommit)?.trim();
        if (!baseBranch || !baseCommit || !/^[0-9a-f]{40}$/i.test(baseCommit)) {
          throw new Error("delegationBaseBranch and a full delegationBaseCommit are required");
        }
        env.delegationBaseBranch = baseBranch;
        env.delegationBaseCommit = baseCommit;
      }
      if (agentSettings !== undefined) env.agentSettings = normalizedTier(agentSettings);
      if (pendingAgentLaunch === true) {
        env.pendingAgentLaunch = true;
        if (initialAgentPlatform !== undefined) {
          if (!isAgentPlatform(initialAgentPlatform)) {
            throw new Error("initialAgentPlatform is invalid");
          }
          env.initialAgentPlatform = initialAgentPlatform;
        }
        env.initialAgentModel = asOptionalString(initialAgentModel)?.trim() || undefined;
        env.initialReasoningEffort = asOptionalString(initialReasoningEffort)?.trim() || undefined;
        if (initialFastMode !== undefined && typeof initialFastMode !== "boolean") {
          throw new Error("initialFastMode must be a boolean");
        }
        env.initialFastMode = initialFastMode;
        if (
          initialConversationMode !== undefined &&
          initialConversationMode !== "plan" &&
          initialConversationMode !== "build"
        ) {
          throw new Error("initialConversationMode must be plan or build");
        }
        env.initialConversationMode = initialConversationMode;
      } else if (pendingAgentLaunch !== undefined && pendingAgentLaunch !== false) {
        throw new Error("pendingAgentLaunch must be a boolean");
      }
      await storage.patchRepositoryConfig(project.id, {
        lastEnvironmentType: env.environmentType,
      });
      return toClientEnvironment(await storage.addEnvironment(env));
    },
  );
  register(ensureProjectHomeEnvironmentCommand, async (args, context) => {
    const projectId = asString(args.projectId, "projectId");
    const { storage } = context;
    const { environment } = await ensureProjectHomeEnvironment(
      context.runtime.environments,
      projectId,
      {
        storage,
        resolveRoot: (project) => resolveProjectGitRoot(storage, project.id),
        readBranch: readCheckoutBranch,
        createRecord: (id, name) => createEnvironment(id, { name, environmentType: "local" }),
        clearTerminalSessions: async (environmentId) => {
          await storage.clearBackendTerminalSessionIds?.(environmentId);
        },
      },
    );
    // The home is a tracked worktree like any other: its watcher is what
    // announces a dropped or edited file as a change.
    await context.runtime.diffStats.sync(context);
    await context.runtime.prMonitor.sync(context);
    return toClientEnvironment(environment);
  });
  register(forkEnvironmentCommand, async ({ environmentId, environmentType }, context) => {
    const source = await context.storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!source) throw new Error(`Environment not found: ${environmentId}`);
    return forkEnvironmentRecord(source, asEnvironmentType(environmentType), context);
  });
  register(deleteEnvironmentCommand, async ({ environmentId }, context) => {
    const id = asString(environmentId, "environmentId");
    extensionDiscoveryCache.invalidate(id);
    return deleteEnvironmentTask(id, context);
  });
  register(moveEnvironmentCommand, async (args, context) => {
    const id = asString(args.environmentId, "environmentId");
    const moved = await moveEnvironmentTask(id, args.destinationDir, context, {
      invalidateDiscovery: (environmentId) => extensionDiscoveryCache.invalidate(environmentId),
    });
    return toClientEnvironment(moved);
  });
  register(renameEnvironmentCommand, async ({ environmentId, name }, context) => {
    const { storage } = context;
    const id = asString(environmentId, "environmentId");
    const newName = sanitizeEnvironmentName(asString(name, "name"));
    const environment = await storage.getEnvironment(id);
    if (!environment) throw new Error(`Environment not found: ${id}`);
    const updated = await renameEnvironmentToName(environment, newName, context);
    await context.runtime.prMonitor.sync(context);
    return toClientEnvironment(updated);
  });
  register(renameEnvironmentFromPromptCommand, async ({ environmentId, prompt }, context) => {
    const envId = asString(environmentId, "environmentId");
    await renameEnvironmentFromPrompt(envId, asString(prompt, "prompt"), context);
    await context.runtime.prMonitor.sync(context);
  });
  register(prepareEnvironmentFirstPromptCommand, async ({ environmentId, prompt }, context) => {
    await prepareEnvironmentFirstPrompt(
      asString(environmentId, "environmentId"),
      asString(prompt, "prompt"),
      context,
    );
  });
  register(reconcilePendingEnvironmentRenamesCommand, async (_args, context) => {
    return { pending: await reconcilePendingEnvironmentRenames(context) };
  });
  register(getEnvironmentStatusCommand, async ({ environmentId }, context) => {
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
        context,
        knownContainerStates,
        context.strictDockerOwner,
      )
    ).status;
  });
  register(syncEnvironmentStatusCommand, async ({ environmentId }, context) => {
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
        context,
        knownContainerStates,
        context.strictDockerOwner,
      ),
    );
  });
  register(syncAllEnvironmentsWithDockerCommand, async (_args, context) => {
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
      // An admitted start or replacement owns the reference right now.
      if (context.runtime.environments.isStarting(environment.id)) continue;
      // Only a definite answer clears a reference. An unreachable daemon, a
      // timeout or a permission failure says nothing about whether the
      // container — possibly the only copy of the workspace — still exists.
      try {
        const identity = await inspectDockerContainerIdentity(environment.containerId!);
        if (
          context.strictDockerOwner &&
          identity.owner !== dockerOwnerNamespace(storage.getDataDir())
        ) {
          await storage.updateEnvironment(environment.id, { status: "stopped", containerId: null });
          cleared.push(environment.id);
        }
      } catch (error) {
        if (!isMissingDockerObjectError(error)) continue;
        await storage.updateEnvironment(environment.id, { status: "stopped", containerId: null });
        cleared.push(environment.id);
      }
    }
    return cleared;
  });
  // `admit` refuses synchronously by design, so every lifecycle command is
  // `async`: a caller that reaches the registry directly must see a rejection
  // rather than a throw from the call expression itself.
  register(startEnvironmentCommand, async (args, context) => {
    const { task } = await admitEnvironmentStartTask(
      asString(args.environmentId, "environmentId"),
      context,
      schedulePendingEnvironmentRename,
      parseContainerMutationIdentity(args),
    );
    return toClientEnvironmentSetupStartResult(await task);
  });
  register(startEnvironmentBackgroundCommand, async (args, context) => {
    const id = asString(args.environmentId, "environmentId");
    // Validate before acknowledging the request. Once accepted, the task is
    // backend-owned: a renderer, browser, or reverse proxy can disconnect
    // without cancelling Docker provisioning or losing the durable launch.
    const { task } = await admitEnvironmentStartTask(
      id,
      context,
      schedulePendingEnvironmentRename,
      parseContainerMutationIdentity(args),
    );
    void task.catch((error) => {
      // `startEnvironmentOnce` has already logged the cause; this only records
      // that nobody was awaiting the result, so the rejection is not unhandled.
      logEnvironmentLifecycleFailure("background start", id, error);
    });
  });
  register(stopEnvironmentCommand, async (args, context) =>
    stopEnvironmentTask(
      asString(args.environmentId, "environmentId"),
      context,
      (id) => extensionDiscoveryCache.invalidate(id),
      parseContainerMutationIdentity(args),
    ),
  );
  register(getContainerLifecycleSnapshotCommand, async ({ environmentId }, { storage }) => {
    const environment = await storage.getEnvironment(asString(environmentId, "environmentId"));
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    return containerLifecycleSnapshot(parseContainerLifecycle(environment.containerLifecycle));
  });
  register(resolveContainerOperationCommand, async (args, context) => {
    const environmentId = asString(args.environmentId, "environmentId");
    const operationId = asString(args.operationId, "operationId");
    const resolution = args.resolution;
    if (resolution !== "adopt" && resolution !== "release") {
      throw new Error("Expected resolution to be adopt or release");
    }
    const updated = await enqueueEnvironmentLifecycleOperation(environmentId, context, () =>
      resolveNeedsAttentionOperation(
        context,
        environmentId,
        operationId,
        resolution === "adopt"
          ? { kind: "adopt", containerId: asString(args.containerId, "containerId") }
          : { kind: "release" },
      ),
    );
    return updated ? toClientEnvironment(updated) : undefined;
  });
  register(getRebuildPreviewCommand, async (args, context) => {
    return rebuildPreview(asString(args.environmentId, "environmentId"), context);
  });
  register(listRecoveryCopiesCommand, async (args, context) => {
    return listRecoveryCopies(asString(args.environmentId, "environmentId"), context, {
      measureSize: args.measureSize === true,
    });
  });
  register(discardRecoveryCopyCommand, async (args, context) => {
    return discardRecoveryCopyTask(
      {
        environmentId: asString(args.environmentId, "environmentId"),
        copyId: asString(args.copyId, "copyId"),
        ...parseContainerMutationIdentity(args),
      },
      context,
    );
  });
  register(restoreRecoveryCopyCommand, async (args, context) => {
    const expected = args.expectedContainerId;
    if (expected !== null && typeof expected !== "string") {
      throw new Error("Expected expectedContainerId to be the reviewed container id or null");
    }
    const result = await restoreRecoveryCopyTask(
      {
        environmentId: asString(args.environmentId, "environmentId"),
        copyId: asString(args.copyId, "copyId"),
        expectedContainerId: expected,
        ...parseContainerMutationIdentity(args),
      },
      context,
      schedulePendingEnvironmentRename,
      (id) => extensionDiscoveryCache.invalidate(id),
    );
    return result ? toClientEnvironmentSetupStartResult(result) : undefined;
  });
  register(getEnvironmentResourcesCommand, async (args, context) => {
    return environmentResourcePolicy(asString(args.environmentId, "environmentId"), context);
  });
  register(updateEnvironmentResourcesCommand, async (args, context) => {
    const environmentId = asString(args.environmentId, "environmentId");
    let limits: ContainerResourceLimits | undefined;
    if (args.limits !== null && args.limits !== undefined) {
      const parsed = parseResourceLimits(args.limits);
      if (!parsed.ok) throw new Error(`Invalid ${parsed.field}: ${parsed.reason}`);
      limits = parsed.limits;
    }
    return enqueueEnvironmentLifecycleOperation(environmentId, context, () =>
      updateEnvironmentResources(
        {
          environmentId,
          limits,
          applyNow: args.applyNow === true,
          allowBelowUsage: args.allowBelowUsage === true,
        },
        context,
      ),
    );
  });
  register(setContainerResourceLimitsCommand, async (args, { storage }) => {
    let limits: ContainerResourceLimits | undefined;
    if (args.limits !== null && args.limits !== undefined) {
      const parsed = parseResourceLimits(args.limits);
      if (!parsed.ok) throw new Error(`Invalid ${parsed.field}: ${parsed.reason}`);
      limits = parsed.limits;
    }
    // Applies to runtimes created from now on; existing ones keep theirs.
    // `null` removes the budget (the built-in default applies); all-null
    // limits are explicitly unrestricted.
    await storage.setContainerResourceLimits(limits);
    // Saved either way: the default may be meant for another daemon, and an
    // unreachable Docker must not block Settings. But a budget this daemon
    // cannot enforce makes every create refuse it, so say so now.
    const unenforceable =
      limits && Object.values(limits).some((limit) => limit !== null)
        ? await unenforceableOnThisDaemon(limits)
        : [];
    return { limits: limits ?? null, ...(unenforceable.length > 0 ? { unenforceable } : {}) };
  });
  register(getEnvironmentNetworkPolicyCommand, async (args, context) => {
    return environmentNetworkPolicy(asString(args.environmentId, "environmentId"), context);
  });
  register(applyEnvironmentAllowedDomainsCommand, async (args, context) => {
    return applyEnvironmentAllowedDomains(asString(args.environmentId, "environmentId"), context);
  });
  register(getEnvironmentInputsCommand, async (args, context) => {
    return environmentInputStatus(asString(args.environmentId, "environmentId"), context);
  });
  register(revokeProviderCredentialsCommand, async (args, context) => {
    const provider = args.provider;
    if (!isAgentPlatform(provider)) throw new Error("Expected provider to be an agent platform");
    return revokeProviderCredentials(
      asString(args.environmentId, "environmentId"),
      provider,
      context,
    );
  });
  register(restoreProviderCredentialsCommand, async (args, context) => {
    const provider = args.provider;
    if (!isAgentPlatform(provider)) throw new Error("Expected provider to be an agent platform");
    return restoreProviderCredentials(
      asString(args.environmentId, "environmentId"),
      provider,
      context,
    );
  });
  register(cancelContainerOperationCommand, async (args, { storage, runtime }) => {
    const environmentId = asString(args.environmentId, "environmentId");
    const operationId = asString(args.operationId, "operationId");
    const environment = await storage.getEnvironment(environmentId);
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    const parsed = parseContainerLifecycle(environment.containerLifecycle);
    const operation = parsed.supported ? parsed.record.operation : undefined;
    // Not queued: the rebuild holds the lifecycle queue. Only a replacement
    // that has not committed can be cancelled; it stops at its next phase
    // boundary and rolls back exactly as a failure would.
    if (
      !operation ||
      operation.operationId !== operationId ||
      (operation.kind !== "migrate" && operation.kind !== "rebuild") ||
      operation.phase === "committed"
    ) {
      return { cancelled: false };
    }
    runtime.environments.requestReplacementCancellation(operationId);
    return { cancelled: true, pending: true };
  });
  register(recreateEnvironmentCommand, async (args, context) => {
    const result = await recreateEnvironmentTask(
      parseRecreateEnvironmentRequest(args),
      context,
      schedulePendingEnvironmentRename,
      (id) => extensionDiscoveryCache.invalidate(id),
    );
    return result ? toClientEnvironmentSetupStartResult(result) : undefined;
  });
  register(setEnvironmentPrCommand, async (args, context) => {
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
    void context.runtime.prMonitor.sync(context).catch(() => undefined);
    return toClientEnvironment(updated);
  });
  register(clearEnvironmentPrCommand, async ({ environmentId }, context) => {
    await context.storage.updateEnvironment(asString(environmentId, "environmentId"), {
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      prRecheckAfterAgentCompletionArmedAt: undefined,
    });
    void context.runtime.prMonitor.sync(context).catch(() => undefined);
  });
  register(
    getEnvironmentPrUrlCommand,
    async ({ environmentId }, { storage }) =>
      (await storage.getEnvironment(asString(environmentId, "environmentId")))?.prUrl ?? null,
  );
  register(overrideEnvironmentSetupCommand, async ({ environmentId }, context) => {
    const id = asString(environmentId, "environmentId");
    const current = await context.storage.getEnvironment(id);
    if (!current) throw new Error(`Environment not found: ${id}`);
    let environment = await context.storage.updateEnvironment(id, {
      status: "running",
      setupScriptsComplete: true,
      setupPhase: "ready",
      setupOverride: true,
      setupApprovalRequired: false,
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
    context.emit(environmentSetupCompleteEvent, {
      environment_id: id,
      success: true,
      overridden: true,
      environment: toClientEnvironment(environment),
    });
    return toClientEnvironment(environment);
  });
  // Setup approval (`setup-approval.ts`). None of these is reachable by an
  // agent: no Control MCP tool or public action names them, coordinators are
  // denied them outright, and the node-link-only and command-node-only ones
  // are classified in `nodes/node-routing.ts`.
  register(getEnvironmentSetupApprovalCommand, async ({ environmentId }, context) => {
    const id = asString(environmentId, "environmentId");
    const environment = await context.storage.getEnvironment(id);
    if (!environment) throw new Error(`Environment not found: ${id}`);
    return describeEnvironmentSetupApproval(environment, context);
  });
  register(approveEnvironmentSetupCommand, async ({ environmentId, hash, remember }, context) => {
    const id = asString(environmentId, "environmentId");
    const approvedHash = asString(hash, "hash");
    const environment = await context.storage.getEnvironment(id);
    if (!environment) throw new Error(`Environment not found: ${id}`);
    // The hash names the commands the user was shown; anything else is a
    // different decision.
    const commands = await readSetupLocalCommands(localSetupWorktree(environment));
    if (setupCommandsHash(commands) !== approvedHash) {
      throw new Error("The setup commands changed since they were shown. Review them again.");
    }
    if (remember === true) {
      context.storage.setupApprovals.approveSetupCommands(environment.projectId, approvedHash);
    }
    const result = await startEnvironmentSetup(environment, context, {
      approvedSetupHash: approvedHash,
    });
    return toClientEnvironment(result.environment);
  });
  // Node link only: the command node's "approve on every machine" writes each
  // node's own record through this.
  register(approveProjectSetupCommandsCommand, async ({ projectId, hash }, context) => {
    const id = asString(projectId, "projectId");
    if (!(await context.storage.getProject(id))) throw new Error(`Project not found: ${id}`);
    context.storage.setupApprovals.approveSetupCommands(id, asString(hash, "hash"));
    return { approved: true };
  });
  register(runEnvironmentSetupCommand, async ({ environmentId }, context) => {
    return toClientEnvironment(
      await runEnvironmentSetupNow(asString(environmentId, "environmentId"), context),
    );
  });
  register(ensureEnvironmentSetupCommand, async ({ environmentId }, context) => {
    const environment = await context.storage.getEnvironment(
      asString(environmentId, "environmentId"),
    );
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    logSetupTerminal("setup.renderer-ensured", {
      environmentId: environment.id,
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
    const session = context.runtime.environments.setupSession(id);
    const terminals = context.runtime.terminals;
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
          terminalRunning: terminals.hasProcess(environment.setupSessionId),
          hasOutput: terminals.outputLength(environment.setupSessionId) > 0,
        };
      }
      logSetupTerminal("setup.renderer-requested-none", {
        environmentId: id,
      });
      return null;
    }
    const payload = {
      ...session,
      terminalRunning: terminals.hasProcess(session.sessionId),
      hasOutput: terminals.outputLength(session.sessionId) > 0,
    };
    logSetupTerminal("setup.renderer-requested", {
      environmentId: id,
      sessionId: session.sessionId,
      running: session.running,
      terminalRunning: payload.terminalRunning,
      hasOutput: payload.hasOutput,
      success: session.success ?? null,
      bufferChars: terminals.outputLength(session.sessionId),
    });
    return payload;
  };
  register(awaitEnvironmentSetupSessionCommand, async ({ environmentId, timeoutMs }, context) => {
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
  register(updatePortMappingsCommand, ({ environmentId, portMappings }, { storage }) =>
    storage
      .updateEnvironment(asString(environmentId, "environmentId"), {
        portMappings: asPortMappings(portMappings) ?? [],
      })
      .then(toClientEnvironment),
  );
  register(
    updateEnvironmentAgentSettingsCommand,
    async (
      {
        environmentId,
        agentSettings,
        pendingAgentLaunch,
        initialAgentPlatform,
        initialAgentModel,
        initialReasoningEffort,
        initialFastMode,
        initialConversationMode,
        initialPrompt,
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
          updates.initialAgentPlatform = undefined;
          updates.initialAgentModel = undefined;
          updates.initialReasoningEffort = undefined;
          updates.initialFastMode = undefined;
          updates.initialConversationMode = undefined;
          updates.initialPromptAttachments = undefined;
          updates.initialPromptPresentation = undefined;
        }
      }
      if (pendingAgentLaunch !== false && initialAgentPlatform !== undefined) {
        if (!isAgentPlatform(initialAgentPlatform)) {
          throw new Error("initialAgentPlatform is invalid");
        }
        updates.initialAgentPlatform = initialAgentPlatform;
      }
      if (pendingAgentLaunch !== false && typeof initialAgentModel === "string") {
        updates.initialAgentModel = initialAgentModel;
      }
      if (pendingAgentLaunch !== false && typeof initialReasoningEffort === "string") {
        updates.initialReasoningEffort = initialReasoningEffort;
      }
      if (initialFastMode !== undefined && typeof initialFastMode !== "boolean") {
        throw new Error("initialFastMode must be a boolean");
      }
      if (pendingAgentLaunch !== false && typeof initialFastMode === "boolean") {
        updates.initialFastMode = initialFastMode;
      }
      if (pendingAgentLaunch !== false && initialPrompt !== undefined) {
        updates.initialPrompt = asString(initialPrompt, "initialPrompt");
      }
      if (
        initialConversationMode !== undefined &&
        initialConversationMode !== "plan" &&
        initialConversationMode !== "build"
      ) {
        throw new Error("initialConversationMode must be plan or build");
      }
      if (
        pendingAgentLaunch !== false &&
        (initialConversationMode === "plan" || initialConversationMode === "build")
      ) {
        updates.initialConversationMode = initialConversationMode;
      }
      if (pendingAgentLaunch !== false && Array.isArray(initialPromptAttachments)) {
        updates.initialPromptAttachments =
          initialPromptAttachments as Environment["initialPromptAttachments"];
      }
      return toClientEnvironment(await storage.updateEnvironment(id, updates));
    },
  );
  register(
    acknowledgeStartupAgentSessionCommand,
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
  register(getEnvironmentExtensionsCommand, async ({ environmentId, refresh }, context) => {
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
  // A saved allowlist is applied to the running container in place when its
  // image supports it. The save stands either way; the network section
  // reports whether the container enforces it yet.
  const applySaved = (environmentId: string, context: CommandContext) =>
    applyEnvironmentAllowedDomains(environmentId, context).catch(() => undefined);
  register(updateEnvironmentAllowedDomainsCommand, async ({ environmentId, domains }, context) => {
    const id = asString(environmentId, "environmentId");
    const environment = await context.storage.updateEnvironment(id, {
      allowedDomains: asStringArray(domains),
    });
    await applySaved(id, context);
    return toClientEnvironment(environment);
  });
  register(removeEnvironmentDomainsCommand, async ({ environmentId, domains }, context) => {
    const environment = await context.storage.getEnvironment(
      asString(environmentId, "environmentId"),
    );
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    const remove = new Set(asStringArray(domains));
    const updated = (environment.allowedDomains ?? []).filter((domain) => !remove.has(domain));
    await context.storage.updateEnvironment(environment.id, { allowedDomains: updated });
    await applySaved(environment.id, context);
    return updated.join(",");
  });
}
