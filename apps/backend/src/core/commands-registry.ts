import type {
  AwaitBridgeReadyResult,
  ClaudeModelCatalogSnapshot,
  ConditionalResourceSnapshot,
  Environment,
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
  renameEnvironmentFromPrompt,
} from "./commands-helpers.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import type { ClaudeStatePollManager } from "./commands-dependencies.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { registerBuildPipelineCommands } from "./commands-registry-build.js";
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

export type CommandRegistryOptions = {
  claudeStatePolls?: ClaudeStatePollManager;
  projectCreation?: {
    runCommand?: typeof runCommand;
  };
  tabTeardown?: {
    peekBridge?: (
      environment: Environment,
      agent: import("./commands-helpers.js").LocalServerKind,
      context: CommandContext,
    ) => Promise<{ port: number; authToken: string } | null>;
    fetch?: typeof fetch;
    deleteTimeoutMs?: number;
  };
};

export function createCommandRegistry(
  options: CommandRegistryOptions = {},
): Map<string, CommandHandler> {
  const commands = new Map<string, CommandHandler>();
  const register: CommandRegistrar = (name, handler) => {
    commands.set(name, (args, context) => {
      const containerId = args.containerId;
      if (
        context.strictDockerOwner
        && typeof containerId === "string"
        && containerId.trim()
      ) {
        return assertDockerContainerOwned(containerId, context)
          .then(() => handler(args, context));
      }
      return handler(args, context);
    });
  };

  const pendingEnvironmentRenameTasks = new Map<string, Promise<void>>();
  const claudeModelCatalogRefreshes = new Map<string, Promise<ClaudeModelCatalogSnapshot>>();
  const bridgeReadinessWaits = new Map<string, {
    deadline: number;
    promise: Promise<AwaitBridgeReadyResult>;
  }>();
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

  const schedulePendingEnvironmentRename = (
    environmentId: string,
    context: CommandContext,
  ): void => {
    if (pendingEnvironmentRenameTasks.has(environmentId)) return;

    const task = (async () => {
      const environment = await context.storage.getEnvironment(environmentId);
      const prompt = environment?.pendingRenamePrompt?.trim();
      if (!prompt) return;
      await renameEnvironmentFromPrompt(environmentId, prompt, context, prompt);
    })()
      .catch((error) => {
        // Keep the persisted prompt so another successful start can retry without
        // relying on renderer state surviving for the lifetime of the operation.
        console.warn(
          "[ElectronBackend] Failed to rename environment from pending prompt:",
          error,
        );
      })
      .finally(() => {
        if (pendingEnvironmentRenameTasks.get(environmentId) === task) {
          pendingEnvironmentRenameTasks.delete(environmentId);
        }
      });

    pendingEnvironmentRenameTasks.set(environmentId, task);
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
    conditionalManifestSnapshot,
    schedulePendingEnvironmentRename,
  };

  registerProjectCommands(register, dependencies);
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
