import { createExtensionDiscoveryCache } from "./extension-discovery.js";
import { runCommand } from "./shell.js";
import type { AwaitBridgeReadyResult } from "@orkestrator/protocol/bridge-readiness";
import type { ClaudeModelCatalogSnapshot, Environment } from "./models.js";
import type {
  ConditionalResourceSnapshot,
  ResourceManifestKind,
} from "@orkestrator/protocol/resource-events";
import type { StorageService } from "./storage.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import type { LocalServerKind } from "./commands-helpers.js";
import type { refreshHostModelCatalog } from "./host-model-catalog-refresh.js";
import type { PlanUsageReader } from "./plan-usage.js";

export type CommandRegistrar = (name: string, handler: CommandHandler) => void;

export type CommandRegistryOptions = {
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
  /** Resolves with how many environments still carry a rename intent. */
  reconcilePendingEnvironmentRenames: (context: CommandContext) => Promise<number>;
};
