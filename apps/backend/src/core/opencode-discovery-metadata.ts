/**
 * OpenCode's optional discovery fan-out, kept off the transcript path.
 *
 * Agents, skills, MCP/LSP/formatter status, todos, diffs and the composer
 * catalogue are all *supplementary* panels. They are read together because
 * they share one SDK round-trip budget, and they are cached together because
 * they expire together. Keeping the whole thing in its own module is what lets
 * the provider serve a transcript without importing any of it into that path.
 *
 * Two rules the callers depend on:
 *
 * 1. A refresh is shared. Concurrent readers of the same session join one
 *    in-flight fan-out rather than multiplying SDK calls, which is the whole
 *    reason a cold panel read does not scale with the number of open tabs.
 * 2. A refresh that was started before an invalidation must not install its
 *    result afterwards. Settings edits and reconnects change what the fan-out
 *    would return, so the generation counter fences the write rather than the
 *    read: the caller still gets the value it waited for, but a stale entry
 *    never lands in the cache.
 */

import type {
  AgentModel,
  NativeAgentComposerState,
  NativeAgentRuntimeSummary,
} from "@orkestrator/protocol/native-agent";
import { openCodeExecutionProfiles } from "./opencode-execution-profiles.js";
import { openCodeSessionModelRef } from "./opencode-model-catalog.js";
import {
  asRecord,
  INTERACTIVE_RUNTIME_METADATA_TTL_MS,
  nonEmptyString,
  providerInventoryCount,
} from "./agent-provider-runtime.js";

/** Everything the composer, runtime panel and health surface read together. */
export interface OpenCodeDiscoveryMetadata {
  executionProfiles: NonNullable<NativeAgentComposerState["executionProfiles"]>;
  runtime: NativeAgentRuntimeSummary;
  models: AgentModel[];
  selectedModelId?: string;
  selectedReasoningId?: string;
  /** OpenCode `Session.model`, distinct from the catalog default. */
  sessionModelId?: string;
  sessionReasoningId?: string;
  title?: string;
  shareUrl?: string | null;
}

export interface OpenCodeDiscoveryCacheEntry extends OpenCodeDiscoveryMetadata {
  expiresAt: number;
  providersKey: string;
}

export interface OpenCodeDiscoveryFanOutDeps {
  /** Resolves to an error envelope rather than throwing; optional panels only. */
  optionalSdkCall(group: string, method: string, args: Record<string, unknown>): Promise<unknown>;
  readComposerCatalog(
    allowedProviders: readonly string[],
    connectedOnly: true,
  ): Promise<{ models: AgentModel[]; selectedModelId?: string; selectedReasoningId?: string }>;
  /** Drift and notices observed on the shared event subscription. */
  drift(): NativeAgentRuntimeSummary["drift"];
  notices(): NonNullable<NativeAgentRuntimeSummary["notices"]>;
  directory: string | undefined;
}

/**
 * One bounded fan-out over every optional OpenCode discovery endpoint.
 *
 * Every call is settled rather than awaited as a group failure: an unreadable
 * panel reports an empty count, and no single optional endpoint can fail the
 * whole read. The catalogue is the one entry that carries the allowlist, which
 * is why the resulting entry records the key it was filtered against.
 */
export async function readOpenCodeDiscoveryFanOut(
  sessionId: string,
  providers: readonly string[],
  cacheKey: string,
  deps: OpenCodeDiscoveryFanOutDeps,
): Promise<OpenCodeDiscoveryCacheEntry> {
  const directory = deps.directory;
  const results = await Promise.allSettled([
    deps.optionalSdkCall("app", "agents", { directory }),
    deps.optionalSdkCall("app", "skills", { directory }),
    deps.optionalSdkCall("mcp", "status", { directory }),
    deps.optionalSdkCall("lsp", "status", { directory }),
    deps.optionalSdkCall("formatter", "status", { directory }),
    deps.optionalSdkCall("session", "todo", { sessionID: sessionId, directory }),
    deps.optionalSdkCall("session", "diff", { sessionID: sessionId, directory }),
    deps.optionalSdkCall("session", "get", { sessionID: sessionId, directory }),
    deps.readComposerCatalog(providers, true),
  ]);
  const data = (index: number, fallback: unknown): unknown => {
    const result = results[index];
    return result?.status === "fulfilled" ? (asRecord(result.value)?.data ?? fallback) : fallback;
  };
  const drift = deps.drift();
  const notices = deps.notices();
  const runtime: NativeAgentRuntimeSummary = {
    skills: providerInventoryCount(data(1, [])),
    mcpServers: providerInventoryCount(data(2, {})),
    lspServers: providerInventoryCount(data(3, [])),
    formatters: providerInventoryCount(data(4, [])),
    todos: providerInventoryCount(data(5, [])),
    files: providerInventoryCount(data(6, [])),
    // The event subscription serves the whole server, so drift observed on it
    // belongs to every session's panel rather than to one of them.
    ...(drift ? { drift } : {}),
    ...(notices.length > 0 ? { notices } : {}),
  };
  const sessionResult = results[7];
  const sessionData =
    sessionResult?.status === "fulfilled"
      ? asRecord(asRecord(sessionResult.value)?.data)
      : undefined;
  const title = nonEmptyString(sessionData?.title);
  const shareUrl =
    sessionResult?.status === "fulfilled"
      ? (nonEmptyString(asRecord(sessionData?.share)?.url) ?? null)
      : undefined;
  const sessionModel = openCodeSessionModelRef(sessionData);
  const catalogResult = results[8];
  const catalog = catalogResult?.status === "fulfilled" ? catalogResult.value : { models: [] };
  return {
    expiresAt: Date.now() + INTERACTIVE_RUNTIME_METADATA_TTL_MS,
    providersKey: cacheKey,
    executionProfiles: openCodeExecutionProfiles(data(0, [])),
    runtime,
    models: catalog.models,
    ...(title ? { title } : {}),
    ...(shareUrl === undefined ? {} : { shareUrl }),
    ...(catalog.selectedModelId ? { selectedModelId: catalog.selectedModelId } : {}),
    ...(catalog.selectedReasoningId ? { selectedReasoningId: catalog.selectedReasoningId } : {}),
    ...(sessionModel.modelId ? { sessionModelId: sessionModel.modelId } : {}),
    ...(sessionModel.reasoningId ? { sessionReasoningId: sessionModel.reasoningId } : {}),
  };
}

export interface OpenCodeDiscoveryDeps {
  /** Bounded fan-out for one session; never throws for optional panels. */
  read(
    sessionId: string,
    allowedProviders: readonly string[],
    providersKey: string,
  ): Promise<OpenCodeDiscoveryCacheEntry>;
  /** The connectivity-filtered allowlist the cache entry is keyed on. */
  allowedProviders(): Promise<readonly string[]>;
  cacheKey(allowedProviders: readonly string[]): string;
  /** Overlays live stream state (title, runtime drift) onto a cached entry. */
  applyStreamState<
    T extends {
      runtime: NativeAgentRuntimeSummary;
      title?: string;
      sessionModelId?: string;
      sessionReasoningId?: string;
    },
  >(
    sessionId: string,
    metadata: T,
  ): T;
  /** Insert under the provider's own session-count bound. */
  store(sessionId: string, entry: OpenCodeDiscoveryCacheEntry): void;
  now(): number;
}

export class OpenCodeDiscoveryMetadataCache {
  private generation = 0;
  private readonly refreshes = new Map<string, Promise<OpenCodeDiscoveryMetadata>>();

  constructor(
    private readonly entries: Map<string, OpenCodeDiscoveryCacheEntry>,
    private readonly deps: OpenCodeDiscoveryDeps,
  ) {}

  peek(sessionId: string): OpenCodeDiscoveryCacheEntry | undefined {
    return this.entries.get(sessionId);
  }

  /**
   * Drop every entry and abandon every in-flight refresh.
   *
   * Used when the answer itself changed — a settings edit, an MCP change, a
   * reconnect or an event-stream gap — rather than when it merely aged out.
   */
  invalidate(): void {
    this.generation += 1;
    this.entries.clear();
    this.refreshes.clear();
  }

  /** Forget one session, e.g. after an action that rewrote its share state. */
  forget(sessionId: string): void {
    this.entries.delete(sessionId);
    this.refreshes.delete(sessionId);
  }

  /**
   * Serve the cache when it is live and keyed on the current allowlist.
   *
   * The allowlist is resolved before the cache is consulted: the entry carries
   * a catalogue filtered against a specific allowlist, so a settings edit has
   * to invalidate it here exactly as it does in the composer catalogue read.
   */
  async read(sessionId: string): Promise<OpenCodeDiscoveryMetadata> {
    const allowedProviders = await this.deps.allowedProviders();
    const providersKey = this.deps.cacheKey(allowedProviders);
    const cached = this.entries.get(sessionId);
    if (cached && cached.expiresAt > this.deps.now() && cached.providersKey === providersKey) {
      return this.deps.applyStreamState(sessionId, cached);
    }
    return this.refresh(sessionId, allowedProviders, providersKey);
  }

  /** Join or start the one fan-out for this session. */
  refresh(
    sessionId: string,
    allowedProviders?: readonly string[],
    providersKey?: string,
  ): Promise<OpenCodeDiscoveryMetadata> {
    const existing = this.refreshes.get(sessionId);
    if (existing) return existing;
    const generation = this.generation;
    const attempt = this.run(sessionId, generation, allowedProviders, providersKey).finally(() => {
      if (this.refreshes.get(sessionId) === attempt) this.refreshes.delete(sessionId);
    });
    // An invalidation between capturing the generation and here means this
    // attempt is already stale; it still resolves for its caller, but nothing
    // else may join it.
    if (generation === this.generation) this.refreshes.set(sessionId, attempt);
    return attempt;
  }

  private async run(
    sessionId: string,
    generation: number,
    allowedProviders?: readonly string[],
    providersKey?: string,
  ): Promise<OpenCodeDiscoveryMetadata> {
    const providers = allowedProviders ?? (await this.deps.allowedProviders());
    const cacheKey = providersKey ?? this.deps.cacheKey(providers);
    const entry = await this.deps.read(sessionId, providers, cacheKey);
    if (generation === this.generation) this.deps.store(sessionId, entry);
    return this.deps.applyStreamState(sessionId, entry);
  }
}
