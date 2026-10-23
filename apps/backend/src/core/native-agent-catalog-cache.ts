import { withSessionActionSlashCommands } from "@orkestrator/protocol/agent-slash-commands";
import { unsupportedCommandCatalogueState } from "@orkestrator/protocol/agent-command-catalogue";
import type { NativeAgentCommandRefreshOutcome } from "@orkestrator/protocol/native-agent";
import {
  NativeAgentCommandCatalogueCache,
  commandCatalogueKey,
  type CommandCatalogueSnapshot,
} from "./native-agent-command-catalogue.js";
import {
  NATIVE_MODEL_CATALOG_CACHE_LIMIT,
  NATIVE_MODEL_CATALOG_TTL_MS,
  ProviderUnavailableError,
  nativeCapabilities,
  type AgentModel,
  type CommandInvoker,
  type NativeAgentProjectionInput,
  type NativeAgentRuntimeProvider,
  type NativeAgentSlashCommand,
} from "./native-agent-service-shared.js";

export interface NativeAgentCatalogCacheDeps {
  invoke: CommandInvoker;
  now(): number;
  /** Tell mounted and unmounted clients alike that an environment's projection changed. */
  announce(environmentId: string): void;
}

/** A cached model catalogue for one environment. */
export interface CachedModelCatalog {
  readonly models: AgentModel[];
  readonly expiresAt: number;
}

/** The parts of a session identity that select one command catalogue. */
type CatalogueScope = Pick<NativeAgentProjectionInput, "environmentId" | "agent">;

/**
 * Projection-only model and command catalogues.
 *
 * Model catalogues are per environment, served stale while they revalidate,
 * and bounded by `NATIVE_MODEL_CATALOG_CACHE_LIMIT`. Command catalogues are
 * per session and live in `NativeAgentCommandCatalogueCache`, which owns their
 * byte, count and concurrency bounds. Both are reconstructible from the
 * provider, so losing them never loses user state.
 */
export class NativeAgentCatalogCache {
  private readonly modelCatalogCache = new Map<
    string,
    { models: AgentModel[]; expiresAt: number }
  >();
  /** Coalesced stale-while-revalidate tasks for projection-only metadata. */
  private readonly modelCatalogRefreshes = new Map<
    string,
    {
      operation: Promise<AgentModel[]>;
      validity: { current: boolean };
    }
  >();
  /** Authoritative, bounded command catalogues; see native-agent-command-catalogue.ts. */
  private readonly commandCatalogues: NativeAgentCommandCatalogueCache;

  constructor(private readonly deps: NativeAgentCatalogCacheDeps) {
    this.commandCatalogues = new NativeAgentCommandCatalogueCache({
      now: () => deps.now(),
      announce: (environmentId) => deps.announce(environmentId),
    });
  }

  /** The environment's cached model catalogue, fresh or expired, without reading. */
  cachedModels(environmentId: string): CachedModelCatalog | undefined {
    return this.modelCatalogCache.get(environmentId);
  }

  /**
   * Back off a failed revalidation: keep serving `entry` and try again after
   * `delayMs`. Does nothing if a newer catalogue replaced it meanwhile.
   */
  retryModelsAfter(environmentId: string, entry: CachedModelCatalog, delayMs: number): void {
    const retained = this.modelCatalogCache.get(environmentId);
    if (retained === entry) retained.expiresAt = this.deps.now() + delayMs;
  }

  /** Read the environment's model catalogue, coalescing concurrent reads. */
  refreshModels(environmentId: string): Promise<AgentModel[]> {
    const pending = this.modelCatalogRefreshes.get(environmentId);
    if (pending) return pending.operation;
    const validity = { current: true };
    const operation = (async () => {
      const catalog = await this.deps.invoke<AgentModel[]>("get_native_agent_model_catalog", {
        environmentId,
      });
      const bounded = Array.isArray(catalog) ? catalog.slice(0, 512) : [];
      if (!validity.current) {
        throw new ProviderUnavailableError("Model catalog refresh was invalidated");
      }
      if (
        !this.modelCatalogCache.has(environmentId) &&
        this.modelCatalogCache.size >= NATIVE_MODEL_CATALOG_CACHE_LIMIT
      ) {
        const oldest = this.modelCatalogCache.keys().next().value as string | undefined;
        if (oldest) this.modelCatalogCache.delete(oldest);
      }
      this.modelCatalogCache.set(environmentId, {
        models: bounded,
        expiresAt: this.deps.now() + NATIVE_MODEL_CATALOG_TTL_MS,
      });
      return bounded;
    })();
    const entry = { operation, validity };
    this.modelCatalogRefreshes.set(environmentId, entry);
    return operation.finally(() => {
      if (this.modelCatalogRefreshes.get(environmentId) === entry) {
        this.modelCatalogRefreshes.delete(environmentId);
      }
    });
  }

  /**
   * Drop the environment's model catalogue and discard in-flight discovery
   * rather than waiting for it. Each refresh re-checks its validity flag
   * immediately before writing the cache, with no await in between, so an
   * invalidated read can no longer land.
   */
  invalidateModels(environmentId: string): void {
    const pending = this.modelCatalogRefreshes.get(environmentId);
    if (pending) {
      pending.validity.current = false;
      this.modelCatalogRefreshes.delete(environmentId);
    }
    this.modelCatalogCache.delete(environmentId);
  }

  /**
   * Provider command rows plus their catalogue state, without session actions.
   *
   * Session actions are merged by the caller *after* runtime qualification, so
   * an unqualified `/steer` never shadows (or deletes) a provider command.
   */
  async commandCatalogue(
    input: CatalogueScope,
    provider: NativeAgentRuntimeProvider,
    sessionId?: string,
  ): Promise<CommandCatalogueSnapshot> {
    const capabilities = nativeCapabilities(input.agent);
    if (!capabilities.slashCommands || (!provider.slashCommands && !provider.commandCatalogue)) {
      return { commands: [], state: unsupportedCommandCatalogueState() };
    }
    return this.commandCatalogues.read(
      commandCatalogueKey(input.environmentId, input.agent, sessionId),
      input.environmentId,
      provider,
      sessionId,
    );
  }

  /** Command rows as a composer sees them: provider commands plus runtime actions. */
  async slashCommands(
    input: CatalogueScope,
    provider: NativeAgentRuntimeProvider,
    sessionId?: string,
  ): Promise<NativeAgentSlashCommand[]> {
    const snapshot = await this.commandCatalogue(input, provider, sessionId);
    return withSessionActionSlashCommands(snapshot.commands, nativeCapabilities(input.agent));
  }

  /** Current cached command catalogue without starting any read. */
  peekCommands(input: CatalogueScope, sessionId?: string): CommandCatalogueSnapshot | undefined {
    return this.commandCatalogues.peek(
      commandCatalogueKey(input.environmentId, input.agent, sessionId),
    );
  }

  /** A dispatch-time read; `force` re-reads past a fresh entry. */
  readCommandsForDispatch(
    input: CatalogueScope,
    provider: NativeAgentRuntimeProvider,
    sessionId: string,
    force: boolean,
  ): Promise<CommandCatalogueSnapshot> {
    return this.commandCatalogues.readForDispatch(
      commandCatalogueKey(input.environmentId, input.agent, sessionId),
      input.environmentId,
      provider,
      sessionId,
      force,
    );
  }

  /** Explicit reload of one session's commands. */
  refreshCommands(
    input: CatalogueScope,
    provider: NativeAgentRuntimeProvider,
    sessionId: string | undefined,
  ): Promise<{ outcome: NativeAgentCommandRefreshOutcome; message?: string }> {
    return this.commandCatalogues.refresh(
      commandCatalogueKey(input.environmentId, input.agent, sessionId),
      input.environmentId,
      provider,
      sessionId,
    );
  }

  /** A provider reported a command catalogue revision; re-read if it moved. */
  observeCommandRevision(
    input: CatalogueScope,
    provider: NativeAgentRuntimeProvider,
    sessionId: string,
    revision: number,
  ): void {
    this.commandCatalogues.observeProviderRevision(
      commandCatalogueKey(input.environmentId, input.agent, sessionId),
      input.environmentId,
      provider,
      sessionId,
      revision,
    );
  }

  invalidateCommands(input: CatalogueScope, sessionId: string | undefined): void {
    this.commandCatalogues.invalidate(
      commandCatalogueKey(input.environmentId, input.agent, sessionId),
    );
  }

  /** Called when an environment is deleted; never on tab unmount or switch. */
  forgetEnvironmentCommands(environmentId: string): void {
    this.commandCatalogues.forgetEnvironment(environmentId);
  }

  /** Every catalogue read still in flight, for shutdown to settle. */
  pendingWork(): Promise<unknown>[] {
    return [
      ...[...this.modelCatalogRefreshes.values()].map((entry) => entry.operation),
      this.commandCatalogues.settle(),
    ];
  }

  clear(): void {
    this.modelCatalogCache.clear();
    this.commandCatalogues.clear();
    this.modelCatalogRefreshes.clear();
  }

  /** When the cached command catalogue for a session expires; for tests. */
  commandExpiresAt(input: CatalogueScope, sessionId?: string): number | undefined {
    return this.commandCatalogues.expiresAt(
      commandCatalogueKey(input.environmentId, input.agent, sessionId),
    );
  }
}
