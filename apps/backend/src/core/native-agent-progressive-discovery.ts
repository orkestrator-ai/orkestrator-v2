import type {
  StorageService,
  NativeAgentRuntimeProvider,
  NativeAgentProjectionInput,
  NativeAgentDiscoveryUpdateInput,
} from "./native-agent-service-shared.js";
import {
  nativeAgentSessionStorageKey,
  nativeCapabilities,
  createHash,
} from "./native-agent-service-shared.js";
import {
  NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION,
  type NativeAgentDiscoverySection,
  type NativeAgentDiscoverySectionState,
  type NativeAgentDiscoveryUpdate,
  type NativeAgentDiscoveryView,
} from "@orkestrator/protocol/native-agent";
import { nativeSessionInvalidationMetrics } from "./native-session-invalidation-metrics.js";
import type { NativeAgentCatalogCache } from "./native-agent-catalog-cache.js";
import { ProgressiveReadPhaseTimer, monotonicMs } from "./native-agent-progressive-metrics.js";
import { unsupportedCommandCatalogueState } from "@orkestrator/protocol/agent-command-catalogue";
import { withSessionActionSlashCommands } from "@orkestrator/protocol/agent-slash-commands";
import {
  discoveryAnnouncementKey,
  discoveryChangedPaths,
  orderMcpServerTools,
} from "./native-agent-projection-helpers.js";
import { runWithTimeout } from "./abortable-timing.js";
import {
  type NativeAgentTranscriptProjectionHost,
  type NativeAgentProjectionContext,
} from "./native-agent-projection-context.js";

/**
 * The progressive discovery view (`get_native_agent_discovery_update`): the
 * session's models, commands, MCP servers, runtime and the other slow,
 * provider-owned sections, each renewed in the background under a per-provider
 * job limit, plus the fence and refresh around an MCP action.
 *
 * The section cache (`progressiveDiscoveryBytes`) and the deferred renewals
 * are bounded and reconstructible.
 */
export class NativeAgentProgressiveDiscovery {
  private readonly host: NativeAgentTranscriptProjectionHost;
  private readonly storage: StorageService;
  private readonly catalogs: NativeAgentCatalogCache;

  constructor(private readonly context: NativeAgentProjectionContext) {
    this.host = context.host;
    this.storage = context.storage;
    this.catalogs = context.catalogs;
  }

  /** Test-only view of the discovery state; production code must not call it. */
  forTesting() {
    return {
      progressiveDiscoveryCache: this.progressiveDiscoveryCache,
      deferredDiscoveryRenewals: this.deferredDiscoveryRenewals,
    };
  }

  /** Key counts and charged bytes of the discovery state, for `native-projection` diagnostics. */
  cacheGauges(): Record<string, number> {
    return {
      progressiveDiscovery: this.progressiveDiscoveryCache.size,
      progressiveDiscoveryBytes: this.progressiveDiscoveryBytes,
      progressiveDiscoveryProviders: this.progressiveDiscoveryJobsByProvider.size,
      deferredDiscoveryRenewals: this.deferredDiscoveryRenewals.size,
    };
  }

  /** Drop every discovery section, job count and deferred renewal (shutdown). */
  clear(): void {
    this.progressiveDiscoveryJobsByProvider.clear();
    this.deferredDiscoveryRenewals.clear();
    this.progressiveDiscoveryCache.clear();
    this.progressiveDiscoveryBytes = 0;
  }

  /**
   * Drop a session's sections and deferred renewals. The owner calls this
   * before any epoch of the session can be pruned back to its default zero,
   * so no renewal callback outlives the epoch it captured.
   */
  forgetSession(sessionKey: string): void {
    const progressivePrefix = `${sessionKey}\0progressive-v1\0`;
    for (const candidate of Array.from(this.deferredDiscoveryRenewals.keys())) {
      if (candidate.startsWith(progressivePrefix)) this.deferredDiscoveryRenewals.delete(candidate);
    }
    for (const candidate of Array.from(this.progressiveDiscoveryCache.keys())) {
      if (!candidate.startsWith(progressivePrefix)) continue;
      const entry = this.progressiveDiscoveryCache.get(candidate);
      if (entry) this.progressiveDiscoveryBytes -= entry.bytes;
      this.progressiveDiscoveryCache.delete(candidate);
    }
  }

  /** Whether a deferred renewal still needs the session's epoch. */
  holdsSession(sessionKey: string): boolean {
    const progressivePrefix = `${sessionKey}\0progressive-v1\0`;
    return Array.from(this.deferredDiscoveryRenewals.keys()).some((candidate) =>
      candidate.startsWith(progressivePrefix),
    );
  }

  /** Collect a deleted environment's queued-only sessions: they have no cached view or live read. */
  collectEnvironmentSessions(environmentId: string, sessionKeys: Set<string>): void {
    for (const entry of this.deferredDiscoveryRenewals.values()) {
      if (entry.environmentId === environmentId) sessionKeys.add(entry.sessionKey);
    }
  }

  private readonly progressiveDiscoveryJobsByProvider = new Map<string, number>();
  /**
   * Expired discovery sections whose renewal a job limit refused, oldest
   * first, each a retry of that schedule. A finishing job starts them, so a
   * section is never left waiting for the view's next read: those reads are
   * 30 s apart once renewals no longer change the view (#2314).
   */
  private readonly deferredDiscoveryRenewals = new Map<
    string,
    { environmentId: string; sessionKey: string; retry: () => void }
  >();
  private readonly progressiveDiscoveryCache = new Map<
    string,
    {
      value: unknown;
      revision: number;
      expiresAt: number;
      bytes: number;
      availability: "ready" | "stale" | "unavailable";
      error?: string;
    }
  >();
  private progressiveDiscoveryBytes = 0;

  /**
   * Store one discovery section. Returns `changed` when the stored section
   * differs at all (its revision moves), and `announce` when a view would
   * show something different enough to be told now:
   *
   * - A retained value becoming stale is announced so readers learn that a
   *   renewal failed or timed out without waiting for the 30 s backstop.
   *   Recovery with the same value stays silent: stale readers already have
   *   a 2 s follow-up, and unchanged successful renewals must stay quiet.
   * - Diagnostic drift counters in the runtime section are not announced:
   *   `unknownEvents` only ever grows while the provider streams events this
   *   backend has no branch for, so every renewal of an idle session would
   *   otherwise announce. The set of unknown kinds still is.
   */
  private storeProgressiveDiscovery(
    key: string,
    entry: {
      value: unknown;
      availability: "ready" | "stale" | "unavailable";
      expiresAt: number;
      error?: string;
    },
  ): { changed: boolean; announce: boolean; changedPaths: string[] } {
    const previous = this.progressiveDiscoveryCache.get(key);
    const semantic = JSON.stringify({
      value: entry.value,
      availability: entry.availability,
      error: entry.error,
    });
    const previousSemantic = previous
      ? JSON.stringify({
          value: previous.value,
          availability: previous.availability,
          error: previous.error,
        })
      : undefined;
    const changed = previousSemantic !== semantic;
    const retainedValue =
      previous !== undefined &&
      previous.value !== undefined &&
      entry.value !== undefined &&
      previous.availability !== "unavailable" &&
      entry.availability !== "unavailable";
    const announce =
      changed &&
      (!retainedValue ||
        (entry.availability === "stale" && previous.availability !== "stale") ||
        discoveryAnnouncementKey(previous.value) !== discoveryAnnouncementKey(entry.value));
    const bytes = Buffer.byteLength(semantic);
    if (previous) this.progressiveDiscoveryBytes -= previous.bytes;
    this.progressiveDiscoveryCache.delete(key);
    this.progressiveDiscoveryCache.set(key, {
      ...entry,
      revision: changed ? (previous?.revision ?? 0) + 1 : (previous?.revision ?? 0),
      bytes,
    });
    this.progressiveDiscoveryBytes += bytes;
    while (
      this.progressiveDiscoveryCache.size > 256 ||
      this.progressiveDiscoveryBytes > 16 * 1024 * 1024
    ) {
      const oldest = this.progressiveDiscoveryCache.keys().next().value as string | undefined;
      if (!oldest || oldest === key) break;
      const removed = this.progressiveDiscoveryCache.get(oldest);
      if (removed) this.progressiveDiscoveryBytes -= removed.bytes;
      this.progressiveDiscoveryCache.delete(oldest);
    }
    // Diagnostic only, and computed only for an announcement: which part of
    // the value moved (#2062). Content-free paths, never values.
    const changedPaths = !announce
      ? []
      : !previous
        ? ["initial"]
        : !retainedValue
          ? ["availability"]
          : previous.availability !== entry.availability &&
              discoveryAnnouncementKey(previous.value) === discoveryAnnouncementKey(entry.value)
            ? ["availability"]
            : discoveryChangedPaths(previous.value, entry.value);
    return { changed, announce, changedPaths };
  }

  /** Count an announced discovery change by section and changed path (#2062). */
  private recordDiscoveryAnnouncement(
    input: NativeAgentDiscoveryUpdateInput,
    section: NativeAgentDiscoverySection,
    changedPaths: readonly string[],
  ): void {
    nativeSessionInvalidationMetrics.recordDiscoveryRenewal(section, input.agent, changedPaths);
  }

  private scheduleProgressiveDiscovery(
    input: NativeAgentDiscoveryUpdateInput,
    section: NativeAgentDiscoverySection,
    provider: NativeAgentRuntimeProvider,
    providerSessionId: string,
  ): void {
    const cacheKey = this.context.reads.progressiveKey(input, `discovery:${section}`);
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const epoch = this.context.projectionEpochs.get(sessionKey) ?? 0;
    if (this.context.reads.progressiveReads.has(cacheKey)) return;
    const activeDiscoveryJobs = Array.from(this.context.reads.progressiveReads.keys()).filter(
      (key) => key.includes("\0progressive-v1\0discovery:"),
    ).length;
    const providerKey = `${input.environmentId}\0${input.agent}\0${String(
      this.host.providerGeneration(input) ?? "in-process",
    )}`;
    if (
      activeDiscoveryJobs >= 4 ||
      (this.progressiveDiscoveryJobsByProvider.get(providerKey) ?? 0) >= 2
    ) {
      this.deferDiscoveryRenewal(cacheKey, input.environmentId, sessionKey, epoch, () =>
        this.scheduleProgressiveDiscovery(input, section, provider, providerSessionId),
      );
      return;
    }
    this.deferredDiscoveryRenewals.delete(cacheKey);
    const read = async (): Promise<unknown> => {
      switch (section) {
        case "models":
          return (await this.catalogs.refreshModels(input.environmentId)).filter(
            (model) => model.platform === input.agent,
          );
        case "commands":
          return this.catalogs.slashCommands(input, provider, providerSessionId);
        case "mcp":
          return provider.mcpServers
            ? orderMcpServerTools((await provider.mcpServers(providerSessionId)).slice(0, 512))
            : [];
        case "runtime": {
          const health = provider.runtimeHealth
            ? await provider.runtimeHealth(providerSessionId)
            : { summary: {}, notices: [], authoritative: true };
          const summary = health.summary.mcp
            ? { ...health.summary, mcp: orderMcpServerTools(health.summary.mcp) }
            : health.summary;
          return { summary, notices: health.notices };
        }
      }
    };
    this.progressiveDiscoveryJobsByProvider.set(
      providerKey,
      (this.progressiveDiscoveryJobsByProvider.get(providerKey) ?? 0) + 1,
    );
    // The job runs behind the views that asked for it, so its timing is its
    // own sample: provider read, then committing the section.
    const jobStartedAt = monotonicMs();
    const phases = new ProgressiveReadPhaseTimer();
    const timedRead = phases.own(async () => {
      phases.sourceStarted();
      try {
        return await read();
      } finally {
        phases.sourceEnded();
      }
    });
    const operation = phases.covering(() =>
      this.context.reads.progressiveRead(cacheKey, timedRead),
    );
    let settled = false;
    const deadline = setTimeout(() => {
      if (
        settled ||
        this.host.isStopped() ||
        (this.context.projectionEpochs.get(sessionKey) ?? 0) !== epoch
      )
        return;
      const previous = this.progressiveDiscoveryCache.get(cacheKey);
      const { announce, changedPaths } = this.storeProgressiveDiscovery(cacheKey, {
        value: previous?.value,
        availability: previous?.value === undefined ? "unavailable" : "stale",
        expiresAt: this.host.now() + 5_000,
        error: "Discovery timed out",
      });
      if (!announce) return;
      this.recordDiscoveryAnnouncement(input, section, changedPaths);
      this.storage.announceNativeAgentSessionProjection(input.environmentId, "discovery-deadline", {
        agent: input.agent,
        logicalSessionKey: input.logicalSessionKey,
      });
    }, 2_000);
    void operation
      .then((value) => {
        settled = true;
        clearTimeout(deadline);
        if (this.host.isStopped() || (this.context.projectionEpochs.get(sessionKey) ?? 0) !== epoch)
          return;
        const { announce, changedPaths } = phases.normalize(() =>
          this.storeProgressiveDiscovery(cacheKey, {
            value,
            availability: "ready",
            expiresAt: this.host.now() + 30_000,
          }),
        );
        this.context.reads.recordProgressiveMetric(
          "discovery",
          jobStartedAt,
          "provider",
          announce ? "snapshot" : "unchanged",
          phases.phases(),
        );
        // Every section expires after 30 s and an idle view's own read renews
        // it. Announcing an unchanged renewal would wake that view (and reset
        // its quiet backoff) four times per expiry for nothing: a view reads
        // only values, and they did not change.
        if (!announce) return;
        this.recordDiscoveryAnnouncement(input, section, changedPaths);
        this.storage.announceNativeAgentSessionProjection(
          input.environmentId,
          "discovery-renewal",
          {
            agent: input.agent,
            logicalSessionKey: input.logicalSessionKey,
          },
        );
      })
      .catch((error) => {
        settled = true;
        clearTimeout(deadline);
        if (this.host.isStopped() || (this.context.projectionEpochs.get(sessionKey) ?? 0) !== epoch)
          return;
        this.context.reads.recordProgressiveMetric(
          "discovery",
          jobStartedAt,
          "provider",
          "unavailable",
          phases.phases(),
        );
        const previous = this.progressiveDiscoveryCache.get(cacheKey);
        const { announce, changedPaths } = this.storeProgressiveDiscovery(cacheKey, {
          value: previous?.value,
          availability: previous?.value === undefined ? "unavailable" : "stale",
          expiresAt: this.host.now() + 5_000,
          error: error instanceof Error ? error.message.slice(0, 4_000) : "Discovery unavailable",
        });
        if (!announce) return;
        this.recordDiscoveryAnnouncement(input, section, changedPaths);
        this.storage.announceNativeAgentSessionProjection(
          input.environmentId,
          "discovery-renewal",
          {
            agent: input.agent,
            logicalSessionKey: input.logicalSessionKey,
          },
        );
      })
      .finally(() => {
        const remaining = Math.max(
          0,
          (this.progressiveDiscoveryJobsByProvider.get(providerKey) ?? 1) - 1,
        );
        if (remaining === 0) this.progressiveDiscoveryJobsByProvider.delete(providerKey);
        else this.progressiveDiscoveryJobsByProvider.set(providerKey, remaining);
        this.startDeferredDiscoveryRenewals();
      });
  }

  /**
   * Remember a renewal a job limit refused. Before #2314 a refused
   * section waited for the view's next read, which the `stale` answer made
   * 2 s later; that answer was itself a whole changed view. A retry whose
   * session moved to a new epoch (identity change, invalidation) is dropped:
   * the next read schedules for the new identity.
   */
  private deferDiscoveryRenewal(
    cacheKey: string,
    environmentId: string,
    sessionKey: string,
    epoch: number,
    retry: () => void,
  ): void {
    this.deferredDiscoveryRenewals.delete(cacheKey);
    this.deferredDiscoveryRenewals.set(cacheKey, {
      environmentId,
      sessionKey,
      retry: () => {
        if (this.host.isStopped() || (this.context.projectionEpochs.get(sessionKey) ?? 0) !== epoch)
          return;
        // Renewed some other way meanwhile (an MCP action's own read).
        const cached = this.progressiveDiscoveryCache.get(cacheKey);
        if (cached && cached.expiresAt > this.host.now()) return;
        retry();
      },
    });
    // Bounded like the section cache it serves.
    while (this.deferredDiscoveryRenewals.size > 256) {
      const oldest = this.deferredDiscoveryRenewals.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.deferredDiscoveryRenewals.delete(oldest);
    }
  }

  /** Give each deferred renewal one more try; a refused one defers itself again. */
  private startDeferredDiscoveryRenewals(): void {
    if (this.deferredDiscoveryRenewals.size === 0 || this.host.isStopped()) return;
    for (const [cacheKey, entry] of Array.from(this.deferredDiscoveryRenewals)) {
      if (this.deferredDiscoveryRenewals.get(cacheKey) !== entry) continue;
      this.deferredDiscoveryRenewals.delete(cacheKey);
      entry.retry();
    }
  }

  private mcpActionOrdinal = 0;

  /** Pin the pre-action epoch until publication, including across cache pruning. */
  async withMcpActionFence<T>(
    input: NativeAgentProjectionInput,
    action: (isCurrent: () => boolean) => Promise<T>,
  ): Promise<T> {
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const epoch = this.context.projectionEpochs.get(sessionKey) ?? 0;
    const key = this.context.reads.progressiveKey(input, `mcp-action:${this.mcpActionOrdinal++}`);
    try {
      return await this.context.reads.progressiveRead(
        key,
        () =>
          action(
            () =>
              !this.host.isStopped() &&
              (this.context.projectionEpochs.get(sessionKey) ?? 0) === epoch,
          ),
        sessionKey,
      );
    } finally {
      this.context.reads.progressiveReadEpochs.delete(key);
      this.context.pruneProjectionEpoch(sessionKey);
    }
  }

  /**
   * Re-read one session's MCP list straight after an MCP server action
   * (reconnect, enable, disable, sign-in) and tell its views to read it.
   *
   * The action's caller has already invalidated the projection, which drops
   * the cached MCP section. Without this nothing announced the change, so an
   * open panel kept the row it had (a reconnected server still "failed")
   * until its 30 s discovery backstop, and that read found only an empty
   * `loading` section and kept the old row for another round (#2031).
   * The bridge updates its inventory before it answers the action, so one
   * read here is the list the user acted on.
   *
   * Best effort: a failed read leaves the section empty, and the announcement
   * still makes the view read again, which schedules the usual job.
   */
  async refreshMcpAfterAction(
    input: NativeAgentProjectionInput,
    provider: NativeAgentRuntimeProvider,
    providerSessionId: string,
  ): Promise<void> {
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const epoch = this.context.projectionEpochs.get(sessionKey) ?? 0;
    const mcpServers = provider.mcpServers?.bind(provider);
    if (mcpServers) {
      try {
        // Bound the action response as well as the read: the deadline aborts
        // the provider's request, and a late result can never publish here.
        const value = await runWithTimeout((signal) => mcpServers(providerSessionId, { signal }), {
          timeoutMs: 2_000,
          message: "MCP discovery timed out",
        });
        // A later identity change owns the section now; this read is not its.
        if (
          this.host.isStopped() ||
          (this.context.projectionEpochs.get(sessionKey) ?? 0) !== epoch
        ) {
          return;
        }
        this.storeProgressiveDiscovery(this.context.reads.progressiveKey(input, "discovery:mcp"), {
          value: orderMcpServerTools(value.slice(0, 512)),
          availability: "ready",
          expiresAt: this.host.now() + 30_000,
        });
      } catch {
        // The view's own read retries through the discovery job.
      }
    }
    if (this.host.isStopped() || (this.context.projectionEpochs.get(sessionKey) ?? 0) !== epoch)
      return;
    this.storage.announceNativeAgentSessionProjection(input.environmentId, "mcp-action", {
      agent: input.agent,
      logicalSessionKey: input.logicalSessionKey,
    });
  }

  async getDiscoveryUpdate(
    input: NativeAgentDiscoveryUpdateInput,
  ): Promise<NativeAgentDiscoveryUpdate> {
    this.host.assertProjectionInput(input);
    if (input.viewVersion !== NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION) {
      throw new Error("Native agent progressive view version is unsupported");
    }
    const startedAt = monotonicMs();
    // A held conversation has no runtime to discover from, and resolving one
    // would start its bridge.
    const resolved = (await this.context.reads.heldCoordinatorRead(input))
      ? null
      : await this.host.resolveProjectionSession(input);
    if (!resolved) {
      this.context.reads.recordProgressiveMetric("discovery", startedAt, "memory", "missing");
      return { viewVersion: 1, status: "missing" };
    }
    const assembleStartedAt = monotonicMs();
    const providerGeneration = this.host.providerGeneration(input) ?? `in-process:${input.agent}`;
    const identity = this.context.reads.progressiveIdentity(
      input,
      resolved.session.providerSessionId,
      providerGeneration,
    );
    const sections: NativeAgentDiscoveryView["sections"] = {};
    for (const section of input.sections) {
      const key = this.context.reads.progressiveKey(input, `discovery:${section}`);
      const cached = this.progressiveDiscoveryCache.get(key);
      const expired = !cached || cached.expiresAt <= this.host.now();
      if (expired) {
        this.scheduleProgressiveDiscovery(
          input,
          section,
          resolved.provider,
          resolved.session.providerSessionId,
        );
      }
      // An expired ready section is still served `ready` while its renewal
      // runs: the view, and its token, change only if the renewed value does,
      // and that change is announced. Serving it `stale` made every 30 s
      // backstop a whole new view plus a 2 s follow-up that was another one
      // (#2314). `stale` now means a renewal failed and the value shown
      // is the one before it.
      const state: NativeAgentDiscoverySectionState<unknown> = cached
        ? {
            availability: cached.availability,
            value: cached.value,
            revision: cached.revision,
            ...(cached.error ? { error: cached.error } : {}),
          }
        : { availability: "loading", revision: 0 };
      if (section === "commands") {
        // The richer catalogue state rides beside the generic availability so a
        // composer can tell ready-empty, unsupported and stale apart.
        const catalogue = this.catalogs.peekCommands(input, resolved.session.providerSessionId);
        const unsupported = !nativeCapabilities(input.agent).slashCommands;
        const detail = unsupported ? unsupportedCommandCatalogueState() : catalogue?.state;
        if (catalogue && !unsupported) {
          // The first discovery job may have cached only session actions while
          // a slow catalogue was still loading. Publish rows and state from
          // the same authoritative snapshot when that read finishes, rather
          // than keeping the empty placeholder until the discovery TTL ends.
          Object.assign(state, {
            value: withSessionActionSlashCommands(
              catalogue.commands,
              nativeCapabilities(input.agent),
            ),
            revision: catalogue.state.revision,
            availability:
              catalogue.state.status === "loading"
                ? "loading"
                : catalogue.state.status === "unavailable"
                  ? "unavailable"
                  : catalogue.state.status === "stale"
                    ? "stale"
                    : "ready",
          });
        }
        // `fetchedAt` moves on every renewal, read or not, and no view shows
        // it: carried here it made each 30 s renewal a whole new discovery
        // view (#2314). The catalogue's revision already moves when the
        // rows or their state do.
        if (detail) {
          const { fetchedAt: _fetchedAt, ...shown } = detail;
          Object.assign(state, { catalogue: shown });
        }
      }
      Object.assign(sections, { [section]: state });
    }
    const value: NativeAgentDiscoveryView = { identity, sections };
    const token = createHash("sha256")
      .update(JSON.stringify(value))
      .digest("base64url")
      .slice(0, 43);
    // Served from the section cache: the provider reads are the jobs above,
    // each recorded when it settles. This read's own cost is assembling and
    // hashing the view.
    const normalizeMs = monotonicMs() - assembleStartedAt;
    if (!input.forceSnapshot && input.knownToken === token) {
      this.context.reads.recordProgressiveMetric("discovery", startedAt, "memory", "unchanged", {
        normalizeMs,
      });
      return { viewVersion: 1, status: "unchanged", token, identity };
    }
    this.context.reads.recordProgressiveMetric("discovery", startedAt, "memory", "snapshot", {
      normalizeMs,
    });
    return {
      viewVersion: 1,
      status: "snapshot",
      token,
      value,
      resetReason: input.forceSnapshot ? "forced" : input.knownToken ? "unknown-token" : "initial",
    };
  }
}
