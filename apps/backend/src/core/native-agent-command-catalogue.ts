/**
 * Authoritative, bounded command catalogue lifecycle for native-agent sessions.
 *
 * One entry per environment, provider and session (or `global`). The entry is
 * the backend's answer to "what can this session run right now", with an
 * explicit status instead of an optional list:
 *
 * - `loading` until the first read finishes, so a slow provider probe never
 *   holds a transcript hostage;
 * - `ready` only after a successful authoritative read — including an empty
 *   one;
 * - `stale` when a later read failed (or the provider itself said so) and the
 *   previous list is retained for display only;
 * - `unavailable` when a read failed and nothing was ever retained;
 * - `unsupported` when the integration has no provider catalogue.
 *
 * A failure is never turned into `ready: []`. Revisions advance only when the
 * commands or the state meaningfully change, so a quiet revalidation does not
 * churn projection deltas. Reads are metadata: they never touch liveness or
 * re-attach an idle session (the provider methods are specified that way).
 */
import {
  commandCatalogueBytes,
  isCommandCatalogueErrorCode,
  withCommandIdentities,
} from "@orkestrator/protocol/agent-command-catalogue";
import type {
  NativeAgentCommandCatalogueErrorCode,
  NativeAgentCommandCatalogueState,
  NativeAgentCommandRefreshOutcome,
  NativeAgentSlashCommand,
} from "@orkestrator/protocol/native-agent";
import {
  PromptRejectedError,
  ProviderUnavailableError,
  ProviderUnreachableError,
  type NativeAgentRuntimeProvider,
  type ProviderCommandCatalogue,
} from "./agent-provider-contract.js";

export const COMMAND_CATALOGUE_TTL_MS = 30_000;
export const COMMAND_CATALOGUE_MAX_ENTRIES = 256;
export const COMMAND_CATALOGUE_MAX_BYTES = 16 * 1024 * 1024;
export const COMMAND_CATALOGUE_RETRY_BASE_MS = 5_000;
export const COMMAND_CATALOGUE_RETRY_MAX_MS = 5 * 60_000;
/** Expensive provider reads (a Claude cold probe spawns a CLI) across the service. */
export const COMMAND_CATALOGUE_MAX_CONCURRENT_READS = 4;
export const COMMAND_CATALOGUE_MAX_QUEUED_READS = 64;
export const COMMAND_CATALOGUE_READ_TIMEOUT_MS = 15_000;
/** How long a projection waits for a first read before publishing `loading`. */
export const COMMAND_CATALOGUE_FIRST_READ_BUDGET_MS = 250;

export interface CommandCatalogueSnapshot {
  /** Provider rows only; session actions are merged by the caller. */
  commands: NativeAgentSlashCommand[];
  state: NativeAgentCommandCatalogueState;
}

interface CatalogueEntry {
  environmentId: string;
  commands: NativeAgentSlashCommand[];
  state: NativeAgentCommandCatalogueState;
  /** Content signature; the revision advances only when this changes. */
  signature: string;
  expiresAt: number;
  failures: number;
  bytes: number;
  /** Bridge-reported generation, used to notice a provider restart. */
  generation?: string;
  /** Bridge-reported inventory revision the entry was read at. */
  providerRevision?: number;
}

interface InFlightRead {
  operation: Promise<CommandCatalogueSnapshot>;
  validity: { current: boolean };
}

export interface CommandCatalogueCacheOptions {
  now: () => number;
  /** Tell mounted and unmounted clients alike that a projection changed. */
  announce: (environmentId: string) => void;
  ttlMs?: number;
  retryBaseMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  maxConcurrentReads?: number;
  readTimeoutMs?: number;
  firstReadBudgetMs?: number;
}

export function commandCatalogueKey(
  environmentId: string,
  agent: string,
  sessionId: string | undefined,
): string {
  return `${environmentId}\0${agent}\0${sessionId ?? "global"}`;
}

class CommandCatalogueReadTimeoutError extends Error {
  constructor() {
    super("Command discovery timed out");
    this.name = "CommandCatalogueReadTimeoutError";
  }
}

class CommandCatalogueBusyError extends Error {
  constructor() {
    super("Command discovery is busy");
    this.name = "CommandCatalogueBusyError";
  }
}

function errorCode(error: unknown): NativeAgentCommandCatalogueErrorCode {
  if (error instanceof CommandCatalogueReadTimeoutError) return "timeout";
  if (error instanceof ProviderUnreachableError) return "unreachable";
  if (error instanceof PromptRejectedError) return "rejected";
  if (error instanceof ProviderUnavailableError) return "provider-error";
  const code = (error as { catalogueErrorCode?: unknown })?.catalogueErrorCode;
  return isCommandCatalogueErrorCode(code) ? code : "provider-error";
}

const ERROR_MESSAGES: Record<NativeAgentCommandCatalogueErrorCode, string> = {
  timeout: "Command discovery timed out.",
  unreachable: "The agent could not be reached to list its commands.",
  rejected: "The agent refused to list its commands.",
  malformed: "The agent returned an unreadable command list.",
  "too-large": "The agent's command list exceeded the size limit.",
  "provider-error": "The agent could not list its commands.",
};

/** Read a provider catalogue through the richest method it offers. */
async function readProviderCatalogue(
  provider: NativeAgentRuntimeProvider,
  sessionId: string | undefined,
): Promise<ProviderCommandCatalogue> {
  if (provider.commandCatalogue) return provider.commandCatalogue(sessionId);
  if (!provider.slashCommands) {
    return { enhanced: true, status: "unsupported", commands: [] };
  }
  // A legacy provider: rows are display records that run as prompt text.
  return {
    enhanced: false,
    status: "ready",
    commands: withCommandIdentities(await provider.slashCommands(sessionId)),
  };
}

export class NativeAgentCommandCatalogueCache {
  private readonly entries = new Map<string, CatalogueEntry>();
  private readonly reads = new Map<string, InFlightRead>();
  private readonly revisions = new Map<string, number>();
  private bytes = 0;
  private activeReads = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly options: Required<Omit<CommandCatalogueCacheOptions, "now" | "announce">> &
    Pick<CommandCatalogueCacheOptions, "now" | "announce">;
  private stopped = false;

  constructor(options: CommandCatalogueCacheOptions) {
    this.options = {
      ttlMs: COMMAND_CATALOGUE_TTL_MS,
      retryBaseMs: COMMAND_CATALOGUE_RETRY_BASE_MS,
      maxEntries: COMMAND_CATALOGUE_MAX_ENTRIES,
      maxBytes: COMMAND_CATALOGUE_MAX_BYTES,
      maxConcurrentReads: COMMAND_CATALOGUE_MAX_CONCURRENT_READS,
      readTimeoutMs: COMMAND_CATALOGUE_READ_TIMEOUT_MS,
      firstReadBudgetMs: COMMAND_CATALOGUE_FIRST_READ_BUDGET_MS,
      ...options,
    };
  }

  get size(): number {
    return this.entries.size;
  }

  get retainedBytes(): number {
    return this.bytes;
  }

  /** Current cached answer without starting any read. */
  peek(key: string): CommandCatalogueSnapshot | undefined {
    const entry = this.entries.get(key);
    return entry ? { commands: entry.commands, state: entry.state } : undefined;
  }

  expiresAt(key: string): number | undefined {
    return this.entries.get(key)?.expiresAt;
  }

  /**
   * The projection read. Serves the cached answer and revalidates it in the
   * background when expired; waits at most a short budget for a first read.
   */
  async read(
    key: string,
    environmentId: string,
    provider: NativeAgentRuntimeProvider,
    sessionId: string | undefined,
  ): Promise<CommandCatalogueSnapshot> {
    const entry = this.entries.get(key);
    if (entry) {
      this.touch(key, entry);
      if (entry.expiresAt <= this.options.now()) {
        void this.revalidate(key, environmentId, provider, sessionId)
          .then(() => undefined)
          .catch(() => undefined);
      }
      return { commands: entry.commands, state: entry.state };
    }
    const operation = this.revalidate(key, environmentId, provider, sessionId);
    const settled = operation.then(
      (snapshot) => snapshot,
      () => undefined,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.options.firstReadBudgetMs);
    });
    const first = await Promise.race([settled, budget]);
    if (timer) clearTimeout(timer);
    if (first) return first;
    const failed = this.entries.get(key);
    if (failed) return { commands: failed.commands, state: failed.state };
    // Still reading: publish loading. The revalidation announces the result.
    return {
      commands: [],
      state: { status: "loading", revision: this.revisions.get(key) ?? 0, enhanced: false },
    };
  }

  /**
   * Authoritative read for dispatch. Uses a fresh-enough entry, otherwise
   * waits for a read; `force` re-reads even a fresh entry (a selection that
   * was not found gets exactly one such refresh).
   */
  async readForDispatch(
    key: string,
    environmentId: string,
    provider: NativeAgentRuntimeProvider,
    sessionId: string | undefined,
    force = false,
  ): Promise<CommandCatalogueSnapshot> {
    const entry = this.entries.get(key);
    if (!force && entry && entry.expiresAt > this.options.now() && entry.state.status === "ready") {
      this.touch(key, entry);
      return { commands: entry.commands, state: entry.state };
    }
    try {
      return await this.revalidate(key, environmentId, provider, sessionId, force);
    } catch {
      const retained = this.entries.get(key);
      return retained
        ? { commands: retained.commands, state: retained.state }
        : {
            commands: [],
            state: {
              status: "unavailable",
              revision: this.revisions.get(key) ?? 0,
              enhanced: false,
            },
          };
    }
  }

  /**
   * Explicit refresh: ask the provider to reload what it can, then re-read.
   * Reports what actually happened; never claims a reload that did not occur.
   */
  async refresh(
    key: string,
    environmentId: string,
    provider: NativeAgentRuntimeProvider,
    sessionId: string | undefined,
  ): Promise<{ outcome: NativeAgentCommandRefreshOutcome; message?: string }> {
    this.invalidateInFlight(key);
    let outcome: NativeAgentCommandRefreshOutcome = "reread";
    let message: string | undefined;
    if (provider.refreshCommands) {
      try {
        const result = await provider.refreshCommands(sessionId);
        outcome = result.outcome;
        message = result.message;
      } catch {
        outcome = "failed";
        message = "The agent could not reload its commands.";
      }
    } else if (!provider.commandCatalogue && !provider.slashCommands) {
      outcome = "unsupported";
    }
    if (outcome !== "unsupported") {
      try {
        await this.revalidate(key, environmentId, provider, sessionId, true);
      } catch {
        outcome = "failed";
        message ??= ERROR_MESSAGES[errorCode(undefined)];
      }
    }
    const entry = this.entries.get(key);
    if (entry) {
      const lastRefresh = {
        outcome,
        at: new Date(this.options.now()).toISOString(),
        ...(message ? { message: message.slice(0, 512) } : {}),
      };
      this.store(key, entry.environmentId, {
        ...entry,
        state: { ...entry.state, lastRefresh },
      });
    }
    this.options.announce(environmentId);
    return { outcome, ...(message ? { message } : {}) };
  }

  /** Drop an entry and discard any read that has not landed yet. */
  invalidate(key: string): void {
    this.invalidateInFlight(key);
    const entry = this.entries.get(key);
    if (entry) {
      this.bytes -= entry.bytes;
      this.entries.delete(key);
    }
  }

  /** Session close: forget its catalogue. A tab unmount must never call this. */
  forgetSession(environmentId: string, agent: string, sessionId: string): void {
    this.invalidate(commandCatalogueKey(environmentId, agent, sessionId));
    this.revisions.delete(commandCatalogueKey(environmentId, agent, sessionId));
  }

  /**
   * A bridge reported a different inventory revision than the one cached.
   * Revalidate now, in the background; the result announces itself.
   */
  observeProviderRevision(
    key: string,
    environmentId: string,
    provider: NativeAgentRuntimeProvider,
    sessionId: string | undefined,
    revision: number,
  ): void {
    const entry = this.entries.get(key);
    if (!entry || entry.providerRevision === undefined || entry.providerRevision === revision) {
      return;
    }
    if (this.reads.has(key)) return;
    entry.expiresAt = Math.min(entry.expiresAt, this.options.now());
    void this.revalidate(key, environmentId, provider, sessionId)
      .then(() => undefined)
      .catch(() => undefined);
  }

  /** Environment deletion: drop every catalogue it owned. */
  forgetEnvironment(environmentId: string): void {
    for (const [key, entry] of Array.from(this.entries)) {
      if (entry.environmentId !== environmentId) continue;
      this.invalidate(key);
      this.revisions.delete(key);
    }
    const prefix = `${environmentId}\0`;
    for (const key of Array.from(this.reads.keys())) {
      if (key.startsWith(prefix)) this.invalidateInFlight(key);
    }
  }

  async settle(): Promise<void> {
    await Promise.allSettled([...this.reads.values()].map((read) => read.operation));
  }

  clear(): void {
    this.stopped = true;
    for (const read of this.reads.values()) read.validity.current = false;
    this.reads.clear();
    this.entries.clear();
    this.revisions.clear();
    this.bytes = 0;
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  private invalidateInFlight(key: string): void {
    const pending = this.reads.get(key);
    if (pending) {
      pending.validity.current = false;
      this.reads.delete(key);
    }
  }

  private touch(key: string, entry: CatalogueEntry): void {
    // Map order is the LRU order used for eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private revalidate(
    key: string,
    environmentId: string,
    provider: NativeAgentRuntimeProvider,
    sessionId: string | undefined,
    force = false,
  ): Promise<CommandCatalogueSnapshot> {
    const pending = this.reads.get(key);
    if (pending && !force) return pending.operation;
    if (pending) this.invalidateInFlight(key);
    const validity = { current: true };
    const operation = (async (): Promise<CommandCatalogueSnapshot> => {
      const previous = this.entries.get(key);
      if (!force && previous && previous.expiresAt > this.options.now()) {
        return { commands: previous.commands, state: previous.state };
      }
      await this.acquire();
      let result: ProviderCommandCatalogue;
      try {
        result = await this.withTimeout(readProviderCatalogue(provider, sessionId));
      } catch (error) {
        if (validity.current && !this.stopped) this.recordFailure(key, environmentId, error);
        throw error;
      } finally {
        this.release();
      }
      if (!validity.current || this.stopped) {
        throw new ProviderUnavailableError("Command discovery was invalidated");
      }
      return this.recordSuccess(key, environmentId, result);
    })();
    const entry = { operation, validity };
    this.reads.set(key, entry);
    // Never leave a rejection unhandled; callers that care attach their own.
    operation
      .catch(() => undefined)
      .finally(() => {
        if (this.reads.get(key) === entry) this.reads.delete(key);
      });
    return operation;
  }

  private recordSuccess(
    key: string,
    environmentId: string,
    result: ProviderCommandCatalogue,
  ): CommandCatalogueSnapshot {
    const previous = this.entries.get(key);
    const commands =
      result.status === "unsupported" || result.status === "missing" ? [] : result.commands;
    const status: NativeAgentCommandCatalogueState["status"] =
      result.status === "missing" ? "unavailable" : result.status;
    const state: NativeAgentCommandCatalogueState = {
      status,
      revision: 0,
      enhanced: result.enhanced,
      freshness: result.freshness ?? "ttl",
      fetchedAt: new Date(this.options.now()).toISOString(),
      ...(result.truncated ? { truncated: true } : {}),
      ...(result.status === "missing"
        ? {
            error: {
              code: "rejected" as const,
              message: "The agent does not hold this session yet.",
            },
          }
        : {}),
      ...(previous?.state.lastRefresh ? { lastRefresh: previous.state.lastRefresh } : {}),
    };
    const next: CatalogueEntry = {
      environmentId,
      commands,
      state,
      signature: "",
      expiresAt: this.options.now() + this.options.ttlMs,
      failures: 0,
      bytes: 0,
      ...(result.generation ? { generation: result.generation } : {}),
      ...(result.revision !== undefined ? { providerRevision: result.revision } : {}),
    };
    const stored = this.store(key, environmentId, next);
    if (!previous || previous.signature !== stored.signature) {
      this.options.announce(environmentId);
    }
    return { commands: stored.commands, state: stored.state };
  }

  private recordFailure(key: string, environmentId: string, error: unknown): void {
    const previous = this.entries.get(key);
    const failures = (previous?.failures ?? 0) + 1;
    const backoff = Math.min(
      COMMAND_CATALOGUE_RETRY_MAX_MS,
      this.options.retryBaseMs * 2 ** Math.max(0, failures - 1),
    );
    const code = errorCode(error);
    const retained = previous && previous.state.status !== "unavailable";
    const state: NativeAgentCommandCatalogueState = {
      // A failure never becomes an authoritative empty list.
      status:
        previous?.state.status === "unsupported"
          ? "unsupported"
          : retained
            ? "stale"
            : "unavailable",
      revision: 0,
      enhanced: previous?.state.enhanced ?? false,
      freshness: previous?.state.freshness ?? "ttl",
      ...(previous?.state.fetchedAt ? { fetchedAt: previous.state.fetchedAt } : {}),
      ...(previous?.state.truncated ? { truncated: true } : {}),
      error: { code, message: ERROR_MESSAGES[code] },
      ...(previous?.state.lastRefresh ? { lastRefresh: previous.state.lastRefresh } : {}),
    };
    const stored = this.store(key, environmentId, {
      environmentId,
      commands: retained ? previous.commands : [],
      state,
      signature: "",
      expiresAt: this.options.now() + backoff,
      failures,
      bytes: 0,
      ...(previous?.generation ? { generation: previous.generation } : {}),
    });
    if (!previous || previous.signature !== stored.signature) {
      this.options.announce(environmentId);
    }
  }

  /** Insert with revision bookkeeping and byte/count bounds. */
  private store(key: string, environmentId: string, entry: CatalogueEntry): CatalogueEntry {
    const previous = this.entries.get(key);
    const { revision: _ignored, fetchedAt: _fetched, ...semanticState } = entry.state;
    const signature = JSON.stringify([entry.commands, semanticState]);
    const priorRevision = this.revisions.get(key) ?? previous?.state.revision ?? 0;
    const revision =
      previous && previous.signature === signature ? priorRevision : priorRevision + 1;
    this.revisions.set(key, revision);
    const bytes = commandCatalogueBytes(entry.commands) + signature.length;
    const stored: CatalogueEntry = {
      ...entry,
      environmentId,
      signature,
      bytes,
      state: { ...entry.state, revision },
    };
    if (previous) this.bytes -= previous.bytes;
    this.entries.delete(key);
    this.entries.set(key, stored);
    this.bytes += bytes;
    this.evict(key);
    return stored;
  }

  private evict(protectedKey: string): void {
    for (const [key, entry] of Array.from(this.entries)) {
      if (this.entries.size <= this.options.maxEntries && this.bytes <= this.options.maxBytes) {
        return;
      }
      if (key === protectedKey) continue;
      this.bytes -= entry.bytes;
      this.entries.delete(key);
      if (this.revisions.size > this.options.maxEntries * 4) this.revisions.delete(key);
    }
  }

  private async acquire(): Promise<void> {
    if (this.activeReads < this.options.maxConcurrentReads) {
      this.activeReads += 1;
      return;
    }
    if (this.waiters.length >= COMMAND_CATALOGUE_MAX_QUEUED_READS) {
      throw new CommandCatalogueBusyError();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    if (this.stopped) throw new ProviderUnavailableError("Command discovery stopped");
    this.activeReads += 1;
  }

  private release(): void {
    this.activeReads = Math.max(0, this.activeReads - 1);
    this.waiters.shift()?.();
  }

  private withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new CommandCatalogueReadTimeoutError()),
        this.options.readTimeoutMs,
      );
    });
    // The provider read keeps running after a timeout; its eventual rejection
    // is observed here so it can never become an unhandled rejection.
    operation.catch(() => undefined);
    return Promise.race([operation, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}
