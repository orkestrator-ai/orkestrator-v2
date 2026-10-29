import { registerChangeCommands } from "./commands-registry-changes.js";
import { registerGraphTemplateCommands } from "./commands-registry-graphs.js";
import {
  registerGraphRunCommands,
  registerGraphRunRewindCommands,
} from "./commands-registry-graph-runs.js";
import { registerGraphDescribeCommands } from "./commands-registry-graph-describe.js";
import { registerDesignCommands } from "./commands-registry-design.js";
import { registerMcpManagementCommands } from "./commands-registry-mcp.js";
import { registerPreviewCommands } from "./commands-registry-previews.js";
import { registerWebAnnotationCommands } from "./commands-registry-web-annotations.js";
import {
  registerTranscriptArtifactCommands,
  registerTranscriptArtifactPdfCommands,
} from "./transcript-artifacts/index.js";
import type { AwaitBridgeReadyResult } from "@orkestrator/protocol/bridge-readiness";
import type { ClaudeModelCatalogSnapshot } from "./models.js";
import type {
  ConditionalResourceSnapshot,
  ResourceManifestKind,
} from "@orkestrator/protocol/resource-events";
import type { StorageService } from "./storage.js";
import { createExtensionDiscoveryCache } from "./extension-discovery.js";
import {
  isResourceGeneration,
  isResourceSnapshotRevision,
} from "@orkestrator/protocol/resource-events";
import { runCommand } from "./shell.js";
import {
  assertDockerContainerOwned,
  enqueueEnvironmentLifecycleOperation,
  renameEnvironmentFromPrompt,
} from "./commands-helpers.js";
import { isGeneratedEnvironmentName } from "./environment-name.js";
import {
  PendingRenameFailureLog,
  pendingRenameRetryDelayMs,
} from "./pending-rename-failure-log.js";
import { assertRuntimeGeneration } from "./container-lifecycle-service.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import type {
  CommandRegistrar,
  CommandRegistryOptions,
  RegistryDependencies,
} from "./commands-registry-types.js";
import { registerPermissionRuleCommands } from "./commands-registry-permission-rules.js";
import { registerBackendProfileCommands } from "./commands-registry-backend-profile.js";
import { registerNodeCommands } from "./commands-registry-nodes.js";
import { registerBuildPipelineCommands } from "./commands-registry-build.js";
import { registerControlCommands } from "./commands-registry-control.js";
import { registerCoordinatorCommands } from "./commands-registry-coordinator.js";
import { registerControllerWorkflowCommands } from "./commands-registry-controller-workflows.js";
import { registerCoordinatorNodeCommands } from "./commands-registry-coordinator-nodes.js";
import { registerDockerCommands } from "./commands-registry-docker.js";
import { registerEnvironmentCommands } from "./commands-registry-environments.js";
import { registerGitHubCommands } from "./commands-registry-github.js";
import { registerGitHubPullRequestCommands } from "./commands-registry-github-pull-requests.js";
import { registerKanbanCommands } from "./commands-registry-kanban.js";
import { registerAgentMailCommands } from "./commands-registry-mail.js";
import { registerScheduledJobCommands } from "./commands-registry-scheduled-jobs.js";
import { registerDiskUsageCommands } from "./commands-registry-disk-usage.js";
import { registerUsageCommands } from "./commands-registry-usage.js";
import {
  registerAgentAccountCommands,
  registerOpenCodeProviderLoginCommands,
} from "./commands-registry-accounts.js";
import { registerWorkflowResultCommands } from "./commands-registry-workflow-results.js";
import { registerLinearCommands } from "./commands-registry-linear.js";
import { registerNativeAgentCommands } from "./commands-registry-native.js";
import { registerPullRequestCommands } from "./commands-registry-pr.js";
import { registerProjectCommands } from "./commands-registry-projects.js";
import { registerProjectCopyCommands } from "./commands-registry-project-copy.js";
import { registerPromptCommands } from "./commands-registry-prompts.js";
import { registerReviewWorkflowCommands } from "./commands-registry-reviews.js";
import { registerServerCommands } from "./commands-registry-servers.js";
import { registerSessionCommands } from "./commands-registry-sessions.js";
import { registerSystemCommands } from "./commands-registry-system.js";
import { registerHostFileCommands } from "./commands-host-files.js";
import { registerHostMaintenanceCommands } from "./commands-registry-host.js";
import { registerTeardownCommands } from "./commands-registry-teardown.js";
import { registerPublicApiCommands } from "./public-api/registry.js";
import { registerTerminalCommands } from "./commands-registry-terminal.js";
import { registerUserCommandCommands } from "./commands-registry-user-commands.js";
import { registerToolingCommands } from "./commands-registry-tools.js";
import { refreshHostModelCatalog } from "./host-model-catalog-refresh.js";
import { readPlanUsage } from "./plan-usage.js";

export type { CommandRegistryOptions } from "./commands-registry-types.js";

export function createCommandRegistry(
  options: CommandRegistryOptions = {},
): Map<string, CommandHandler> {
  const commands = new Map<string, CommandHandler>();
  // Commands that resolve container ownership themselves because their rule
  // differs from the generic one (adoption accepts a reviewed pre-label
  // container that no environment references yet).
  const selfVerifyingContainerCommands = new Set(["reattach_container"]);
  const register: CommandRegistrar = (name, handler) => {
    if (selfVerifyingContainerCommands.has(name)) {
      commands.set(name, handler);
      return;
    }
    commands.set(name, (args, context) => {
      const containerId = args.containerId;
      const namesContainer = typeof containerId === "string" && containerId.trim().length > 0;
      const bindsGeneration = args.expectedRuntimeGeneration !== undefined;
      // Commands that name no container stay synchronous.
      if (!namesContainer && !bindsGeneration) return handler(args, context);
      return (async () => {
        // A handle minted for one runtime generation must not be connected to
        // a replacement: callers that bind to a generation send it back and
        // get a `runtime-changed` conflict instead of the new container.
        if (bindsGeneration) await assertRuntimeGeneration(args, context);
        // A supplied container id is not proof of ownership, in any profile.
        // It must be this registry's persisted association (exact id) or carry
        // this registry's labels; strict profiles always verify the labels.
        // Lifecycle mutations verify labels again at their own entry points.
        if (namesContainer) {
          await assertDockerContainerOwned(containerId, context, {
            trustExactAssociation: true,
          });
        }
        return handler(args, context);
      })();
    });
  };

  const pendingEnvironmentRenameTasks = new Map<string, Promise<void>>();
  const pendingEnvironmentRenameRetryAt = new Map<string, number>();
  const pendingEnvironmentRenameFailures = new PendingRenameFailureLog();
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
  const runContainerFileCopyCommand = options.containerFileCopy?.runCommand ?? runCommand;
  const containerFileCopyTimeoutMs = options.containerFileCopy?.timeoutMs ?? 120_000;

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

    // The intent this attempt read, so repeated failures for it log once.
    let intent = "";
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
          intent = prompt;
          const renamed = await renameEnvironmentFromPrompt(environmentId, prompt, context, prompt);
          await context.runtime.prMonitor.sync(context);
          return renamed;
        }),
      )
      .then((renamed) => {
        pendingEnvironmentRenameRetryAt.delete(environmentId);
        if (renamed) pendingEnvironmentRenameFailures.succeeded(environmentId);
      })
      .catch((error) => {
        // Keep the durable intent and back off automatic retries. A signed-out,
        // missing or offline Codex must not spawn `codex exec` every 30 seconds
        // for as long as the environment runs.
        const failures = pendingEnvironmentRenameFailures.failed(environmentId, intent, error);
        pendingEnvironmentRenameRetryAt.set(
          environmentId,
          Date.now() + pendingRenameRetryDelayMs(failures),
        );
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

  // The task logged the failure itself, without its message.
  const ignorePendingEnvironmentRenameFailure = (): void => undefined;

  const schedulePendingEnvironmentRename = (
    environmentId: string,
    context: CommandContext,
  ): void => {
    if (pendingEnvironmentRenameTasks.has(environmentId)) return;
    void pendingEnvironmentRenameTask(environmentId, context).catch(
      ignorePendingEnvironmentRenameFailure,
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

  const reconcilePendingEnvironmentRenames = async (context: CommandContext): Promise<number> => {
    const now = Date.now();
    const environments = await context.storage.loadEnvironments();
    const tasks: Promise<void>[] = [];
    let pending = 0;
    const withIntent = new Set(
      environments
        .filter((environment) => environment.pendingRenamePrompt?.trim())
        .map((environment) => environment.id),
    );
    // A cleared intent restarts its backoff, so its retry time goes with its count.
    pendingEnvironmentRenameFailures.retainOnly(withIntent);
    for (const environmentId of Array.from(pendingEnvironmentRenameRetryAt.keys())) {
      if (!withIntent.has(environmentId)) pendingEnvironmentRenameRetryAt.delete(environmentId);
    }
    for (const environment of environments) {
      if (environment.status !== "running" || !environment.pendingRenamePrompt?.trim()) continue;
      pending += 1;
      if ((pendingEnvironmentRenameRetryAt.get(environment.id) ?? 0) > now) {
        continue;
      }
      tasks.push(
        pendingEnvironmentRenameTask(environment.id, context).catch(
          ignorePendingEnvironmentRenameFailure,
        ),
      );
    }
    await Promise.all(tasks);
    return pending;
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
    runContainerFileCopyCommand,
    containerFileCopyTimeoutMs,
    refreshHostModelCatalog: options.modelCatalogRefresh ?? refreshHostModelCatalog,
    planUsageReader: options.planUsageReader ?? readPlanUsage,
    conditionalManifestSnapshot,
    schedulePendingEnvironmentRename,
    prepareEnvironmentFirstPrompt,
    reconcilePendingEnvironmentRenames,
  };

  registerDesignCommands(register, dependencies);
  registerPreviewCommands(register);
  registerMcpManagementCommands(register);
  registerWebAnnotationCommands(register);
  registerTranscriptArtifactCommands(register);
  registerTranscriptArtifactPdfCommands(register, (name) => commands.get(name));
  registerProjectCommands(register, dependencies);
  registerProjectCopyCommands(register, dependencies);
  registerControlCommands(register, dependencies);
  registerCoordinatorCommands(register, dependencies);
  registerControllerWorkflowCommands(register, dependencies);
  registerCoordinatorNodeCommands(register);
  registerLinearCommands(register, dependencies);
  registerGitHubCommands(register, dependencies);
  registerGitHubPullRequestCommands(register, dependencies);
  registerEnvironmentCommands(register, dependencies);
  registerSystemCommands(register);
  registerBackendProfileCommands(register);
  registerPermissionRuleCommands(register);
  registerNodeCommands(register);
  registerHostFileCommands(register);
  registerHostMaintenanceCommands(register);
  registerDockerCommands(register, dependencies);
  registerServerCommands(register, dependencies);
  registerToolingCommands(register, dependencies);
  registerSessionCommands(register, dependencies);
  registerNativeAgentCommands(register, dependencies);
  registerReviewWorkflowCommands(register, dependencies);
  registerBuildPipelineCommands(register, dependencies);
  registerPromptCommands(register, dependencies);
  registerTerminalCommands(register, dependencies);
  registerUserCommandCommands(register);
  registerChangeCommands(register);
  registerPullRequestCommands(register, dependencies);
  registerKanbanCommands(register, dependencies);
  registerAgentMailCommands(register);
  registerScheduledJobCommands(register);
  registerDiskUsageCommands(register);
  registerUsageCommands(register);
  registerAgentAccountCommands(register, dependencies);
  registerOpenCodeProviderLoginCommands(register);
  registerWorkflowResultCommands(register);
  registerGraphTemplateCommands(register);
  registerGraphRunCommands(register);
  registerGraphRunRewindCommands(register);
  registerGraphDescribeCommands(register);
  registerTeardownCommands(register, dependencies);
  // Last: the public contract composes the commands registered above.
  registerPublicApiCommands(register, dependencies);

  return commands;
}
