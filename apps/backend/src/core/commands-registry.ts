import type {
  AwaitBridgeReadyResult,
  ClaudeModelCatalogSnapshot,
  ConditionalResourceSnapshot,
  ResourceManifestKind,
  StorageService,
} from "./commands-dependencies.js";
import {
  createExtensionDiscoveryCache,
  isResourceGeneration,
  isResourceSnapshotRevision,
  runCommand,
} from "./commands-dependencies.js";
import {
  assertDockerContainerOwned,
  enqueueEnvironmentLifecycleOperation,
  renameEnvironmentFromPrompt,
  syncPrMonitorTracking,
} from "./commands-helpers.js";
import { isGeneratedEnvironmentName } from "./environment-name.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import type {
  CommandRegistrar,
  CommandRegistryOptions,
  RegistryDependencies,
} from "./commands-registry-types.js";
import { registerBuildPipelineCommands } from "./commands-registry-build.js";
import { registerControlCommands } from "./commands-registry-control.js";
import { registerDockerCommands } from "./commands-registry-docker.js";
import { registerEnvironmentCommands } from "./commands-registry-environments.js";
import { registerGitHubCommands } from "./commands-registry-github.js";
import { registerKanbanCommands } from "./commands-registry-kanban.js";
import { registerLinearCommands } from "./commands-registry-linear.js";
import { registerNativeAgentCommands } from "./commands-registry-native.js";
import { registerPullRequestCommands } from "./commands-registry-pr.js";
import { registerProjectCommands } from "./commands-registry-projects.js";
import { registerPromptCommands } from "./commands-registry-prompts.js";
import { registerReviewWorkflowCommands } from "./commands-registry-reviews.js";
import { registerServerCommands } from "./commands-registry-servers.js";
import { registerSessionCommands } from "./commands-registry-sessions.js";
import { registerTeardownCommands } from "./commands-registry-teardown.js";
import { registerTerminalCommands } from "./commands-registry-terminal.js";
import { registerToolingCommands } from "./commands-registry-tools.js";
import { refreshHostModelCatalog } from "./host-model-catalog-refresh.js";

export type { CommandRegistryOptions } from "./commands-registry-types.js";

export function createCommandRegistry(
  options: CommandRegistryOptions = {},
): Map<string, CommandHandler> {
  const commands = new Map<string, CommandHandler>();
  const register: CommandRegistrar = (name, handler) => {
    commands.set(name, (args, context) => {
      const containerId = args.containerId;
      if (context.strictDockerOwner && typeof containerId === "string" && containerId.trim()) {
        return assertDockerContainerOwned(containerId, context).then(() => handler(args, context));
      }
      return handler(args, context);
    });
  };

  const pendingEnvironmentRenameTasks = new Map<string, Promise<void>>();
  const pendingEnvironmentRenameRetryAt = new Map<string, number>();
  const claudeModelCatalogRefreshes = new Map<string, Promise<ClaudeModelCatalogSnapshot>>();
  const bridgeReadinessWaits = new Map<
    string,
    {
      deadline: number;
      promise: Promise<AwaitBridgeReadyResult>;
    }
  >();
  const validatedClaudeModelCatalogs = new Set<string>();
  const extensionDiscoveryCache = createExtensionDiscoveryCache();
  const runProjectCreationCommand = options.projectCreation?.runCommand ?? runCommand;

  const conditionalManifestSnapshot = async <T>(
    args: Record<string, unknown>,
    storage: StorageService,
    resource: ResourceManifestKind,
    load: () => Promise<T> | T,
  ): Promise<T | ConditionalResourceSnapshot<T>> => {
    const hasGeneration = args.knownManifestGeneration !== undefined;
    const hasRevision = args.knownResourceRevision !== undefined;
    if (!hasGeneration && !hasRevision) return await load();
    if (!hasGeneration || !hasRevision) {
      throw new Error(
        "knownManifestGeneration and knownResourceRevision must be provided together",
      );
    }
    const generation = args.knownManifestGeneration;
    if (!isResourceGeneration(generation)) {
      throw new Error("knownManifestGeneration must be an opaque resource generation");
    }
    const revision = args.knownResourceRevision;
    if (!isResourceSnapshotRevision(revision)) {
      throw new Error("knownResourceRevision must be an opaque resource revision");
    }
    return storage.readConditionalResourceSnapshot(resource, generation, revision, load);
  };

  const pendingEnvironmentRenameTask = (
    environmentId: string,
    context: CommandContext,
  ): Promise<void> => {
    const existing = pendingEnvironmentRenameTasks.get(environmentId);
    if (existing) return existing;

    // Defer admission by one microtask so the task is present in the coalescing
    // map before lifecycle admission can fail synchronously during shutdown.
    // More importantly, callers only ever schedule this task: a caller may
    // already own the same lifecycle queue while completing environment start.
    const task = Promise.resolve()
      .then(() =>
        enqueueEnvironmentLifecycleOperation(environmentId, context, async () => {
          const environment = await context.storage.getEnvironment(environmentId);
          const prompt = environment?.pendingRenamePrompt?.trim();
          // The lifecycle queue may have placed a stop/delete ahead of this task.
          // Keep the intent for the next successful start instead of renaming a
          // branch inside an environment that can no longer accept the prompt.
          if (!prompt || environment?.status !== "running") return;
          await renameEnvironmentFromPrompt(environmentId, prompt, context, prompt);
          await syncPrMonitorTracking(context);
        }),
      )
      .then(() => {
        pendingEnvironmentRenameRetryAt.delete(environmentId);
      })
      .catch((error) => {
        // Keep the durable intent and bound automatic retries. Authentication or
        // model outages must not spin `codex exec` on the two-second backend sweep.
        pendingEnvironmentRenameRetryAt.set(environmentId, Date.now() + 30_000);
        throw error;
      })
      .finally(() => {
        if (pendingEnvironmentRenameTasks.get(environmentId) === task) {
          pendingEnvironmentRenameTasks.delete(environmentId);
        }
      });

    pendingEnvironmentRenameTasks.set(environmentId, task);
    return task;
  };

  const logPendingEnvironmentRenameFailure = (error: unknown): void => {
    console.warn("[ElectronBackend] Failed to rename environment from pending prompt:", error);
  };

  const schedulePendingEnvironmentRename = (
    environmentId: string,
    context: CommandContext,
  ): void => {
    if (pendingEnvironmentRenameTasks.has(environmentId)) return;
    void pendingEnvironmentRenameTask(environmentId, context).catch(
      logPendingEnvironmentRenameFailure,
    );
  };

  const prepareEnvironmentFirstPrompt = async (
    environmentId: string,
    prompt: string,
    context: CommandContext,
  ): Promise<void> => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) return;
    let environment = await context.storage.getEnvironment(environmentId);
    if (!environment) throw new Error(`Environment not found: ${environmentId}`);
    if (environment.deletionRequestedAt) return;
    if (!isGeneratedEnvironmentName(environment.name)) return;

    if (!environment.pendingRenamePrompt?.trim()) {
      await context.storage.updateEnvironment(environmentId, {
        pendingRenamePrompt: trimmedPrompt,
      });
      environment = await context.storage.getEnvironment(environmentId);
      // A concurrent manual rename clears the intent. Re-check the name after
      // persisting so stale prompt preparation cannot overwrite that choice.
      if (!environment || !isGeneratedEnvironmentName(environment.name)) {
        if (environment?.pendingRenamePrompt?.trim() === trimmedPrompt) {
          await context.storage.updateEnvironment(environmentId, {
            pendingRenamePrompt: undefined,
          });
        }
        return;
      }
    }

    // An explicit first prompt is an immediate retry signal even if a previous
    // background attempt is in backoff. Coalescing still ensures one generator
    // and one branch mutation per environment.
    pendingEnvironmentRenameRetryAt.delete(environmentId);
    schedulePendingEnvironmentRename(environmentId, context);
  };

  const reconcilePendingEnvironmentRenames = async (context: CommandContext): Promise<void> => {
    const now = Date.now();
    const environments = await context.storage.loadEnvironments();
    const tasks: Promise<void>[] = [];
    for (const environment of environments) {
      if (
        environment.status !== "running" ||
        !environment.pendingRenamePrompt?.trim() ||
        (pendingEnvironmentRenameRetryAt.get(environment.id) ?? 0) > now
      ) {
        continue;
      }
      tasks.push(
        pendingEnvironmentRenameTask(environment.id, context).catch(
          logPendingEnvironmentRenameFailure,
        ),
      );
    }
    await Promise.all(tasks);
  };

  const dependencies: RegistryDependencies = {
    commands,
    options,
    pendingEnvironmentRenameTasks,
    claudeModelCatalogRefreshes,
    bridgeReadinessWaits,
    validatedClaudeModelCatalogs,
    extensionDiscoveryCache,
    runProjectCreationCommand,
    refreshHostModelCatalog: options.modelCatalogRefresh ?? refreshHostModelCatalog,
    conditionalManifestSnapshot,
    schedulePendingEnvironmentRename,
    prepareEnvironmentFirstPrompt,
    reconcilePendingEnvironmentRenames,
  };

  registerProjectCommands(register, dependencies);
  registerControlCommands(register, dependencies);
  registerLinearCommands(register, dependencies);
  registerGitHubCommands(register, dependencies);
  registerEnvironmentCommands(register, dependencies);
  registerDockerCommands(register, dependencies);
  registerServerCommands(register, dependencies);
  registerToolingCommands(register, dependencies);
  registerSessionCommands(register, dependencies);
  registerNativeAgentCommands(register, dependencies);
  registerReviewWorkflowCommands(register, dependencies);
  registerBuildPipelineCommands(register, dependencies);
  registerPromptCommands(register, dependencies);
  registerTerminalCommands(register, dependencies);
  registerPullRequestCommands(register, dependencies);
  registerKanbanCommands(register, dependencies);
  registerTeardownCommands(register, dependencies);

  return commands;
}
