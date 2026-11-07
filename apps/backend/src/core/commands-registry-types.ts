import { createExtensionDiscoveryCache } from "./extension-discovery.js";
import { runCommand } from "./shell.js";
import type { AwaitBridgeReadyResult } from "@orkestrator/protocol/bridge-readiness";
import type { ClaudeModelCatalogSnapshot, Environment } from "./models.js";
import type {
  ConditionalResourceSnapshot,
  ResourceManifestKind,
} from "@orkestrator/protocol/resource-events";
import type { StorageService } from "./storage.js";
import type { AnyCommandDef, ArgsOf, ResultOf } from "@orkestrator/protocol/contract/command";
import type { CommandContext, CommandHandler, CommandInvocation } from "./commands-context.js";
import type { LocalServerKind } from "./commands-helpers.js";
import type { refreshHostModelCatalog } from "./host-model-catalog-refresh.js";
import type { PlanUsageRead } from "./plan-usage.js";

/** The handler of a command registered with its definition: its arguments are already decoded. */
export type DefinedCommandHandler<C extends AnyCommandDef> = (
  args: ArgsOf<C>,
  context: CommandContext,
  invocation?: CommandInvocation,
) => Promise<ResultOf<C>> | ResultOf<C>;

/**
 * Registers a command, by name (an untyped command, unchanged) or by its
 * contract definition (`defineCommand`, plan item 1003). The definition form
 * decodes the arguments tolerantly before the handler runs, refuses an unknown
 * critical field, and validates the result in development and tests.
 *
 * A registrar that wraps another forwards both forms: see `wrapRegistrar` in
 * `commands-registry-contracts.ts`.
 */
export interface CommandRegistrar {
  (name: string, handler: CommandHandler): void;
  <C extends AnyCommandDef>(
    def: C,
    handler: DefinedCommandHandler<C>,
    options?: DefinedCommandOptions,
  ): void;
}

/** Options of a definition's registration. */
export interface DefinedCommandOptions {
  /**
   * Wraps the call around argument decoding: `wrap(run)` receives the raw
   * arguments, and `run` decodes them and runs the handler. The registry's
   * version check still runs first. For a domain whose handlers refused a call
   * before parsing it (the web annotation rollout gate, payload ceilings and
   * outcome metrics), so that order survives the conversion.
   */
  readonly beforeDecode?: (run: CommandHandler) => CommandHandler;
}

/** What a registrar receives: a command name or a command definition. */
export type CommandTarget = string | AnyCommandDef;

export type CommandRegistryOptions = {
  projectCreation?: {
    runCommand?: typeof runCommand;
  };
  containerFileCopy?: {
    runCommand?: typeof runCommand;
    timeoutMs?: number;
  };
  modelCatalogRefresh?: typeof refreshHostModelCatalog;
  planUsageReader?: PlanUsageRead;
  /**
   * Validate the results of commands registered with a definition. Defaults to
   * on when `NODE_ENV` is `development` or `test`, off otherwise.
   */
  validateContractResults?: boolean;
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
  planUsageReader: PlanUsageRead;
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
