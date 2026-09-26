import {
  createExtensionDiscoveryCache,
  runCommand,
  type AwaitBridgeReadyResult,
  type ClaudeModelCatalogSnapshot,
  type ConditionalResourceSnapshot,
  type Environment,
  type ResourceManifestKind,
  type StorageService,
  type ClaudeStatePollManager,
} from "./commands-dependencies.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import type { LocalServerKind } from "./commands-helpers.js";
import type { refreshHostModelCatalog } from "./host-model-catalog-refresh.js";
import type { PlanUsageReader } from "./plan-usage.js";

export type CommandRegistrar = (name: string, handler: CommandHandler) => void;

export type CommandRegistryOptions = {
  claudeStatePolls?: ClaudeStatePollManager;
  projectCreation?: {
    runCommand?: typeof runCommand;
  };
  containerFileCopy?: {
    runCommand?: typeof runCommand;
    timeoutMs?: number;
  };
  modelCatalogRefresh?: typeof refreshHostModelCatalog;
  planUsageReader?: PlanUsageReader;
  tabTeardown?: {
    peekBridge?: (
      environment: Environment,
      agent: LocalServerKind,
      context: CommandContext,
    ) => Promise<{ port: number; authToken: string } | null>;
    fetch?: typeof fetch;
    deleteTimeoutMs?: number;
    closeTimeoutMs?: number;
    /** Clock for the per-intent retry backoff (tests). */
    now?: () => number;
  };
};

export type RegistryDependencies = {
  commands: Map<string, CommandHandler>;
  options: CommandRegistryOptions;
  pendingEnvironmentRenameTasks: Map<string, Promise<void>>;
  claudeModelCatalogRefreshes: Map<string, Promise<ClaudeModelCatalogSnapshot>>;
  bridgeReadinessWaits: Map<
    string,
    {
      deadline: number;
      promise: Promise<AwaitBridgeReadyResult>;
    }
  >;
  validatedClaudeModelCatalogs: Set<string>;
  extensionDiscoveryCache: ReturnType<typeof createExtensionDiscoveryCache>;
  runProjectCreationCommand: typeof runCommand;
  runContainerFileCopyCommand: typeof runCommand;
  containerFileCopyTimeoutMs: number;
  refreshHostModelCatalog: typeof refreshHostModelCatalog;
  planUsageReader: PlanUsageReader;
  conditionalManifestSnapshot: <T>(
    args: Record<string, unknown>,
    storage: StorageService,
    resource: ResourceManifestKind,
    load: () => Promise<T> | T,
  ) => Promise<T | ConditionalResourceSnapshot<T>>;
  schedulePendingEnvironmentRename: (environmentId: string, context: CommandContext) => void;
  prepareEnvironmentFirstPrompt: (
    environmentId: string,
    prompt: string,
    context: CommandContext,
  ) => Promise<void>;
  reconcilePendingEnvironmentRenames: (context: CommandContext) => Promise<void>;
};
