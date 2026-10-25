/**
 * The native-agent service's cache of runtime providers, one per environment
 * and agent, and everything that decides when one is reused, replaced or
 * disposed.
 *
 * A provider is a client of one bridge generation. The registry resolves it —
 * starting the bridge (`resolve`) or only peeking at a running one
 * (`observe`) — caches it with that generation's identity, and retires a
 * replaced or evicted provider only once no dispatch it sent is still in the
 * at-most-once window. It never closes or deletes a provider session; the
 * service owns sessions, storage and locks, and passes in what the registry
 * needs as narrow dependencies.
 */
import {
  ABSENT_BRIDGE_RECHECK_MS,
  PROVIDER_RETIREMENT_GRACE_MS,
  createHash,
  type BridgeConnection,
  type BuildPipelineAgent,
  type EnsureNativeAgentSessionInput,
  type Environment,
  type NativeAgentRuntimeProvider,
  type NativeAgentServiceOptions,
} from "./native-agent-service-shared.js";
import type { NativeAgentObservationBroker } from "./native-agent-observation.js";

export interface ProviderRegistryDependencies {
  now(): number;
  isStopped(): boolean;
  assertAcceptingWork(): void;
  assertEnvironmentLive(environmentId: string): Promise<Environment>;
  /** Read per call, so the injected factory and grace stay live settings. */
  options: Pick<NativeAgentServiceOptions, "provider" | "providerRetirementGraceMs">;
  observations: Pick<NativeAgentObservationBroker, "replaceGroupGeneration" | "wakeGroup">;
  /** Bridge coordinates, starting the bridge when it is not running. */
  bridgeConnection(
    agent: BuildPipelineAgent,
    environment: Environment,
    model?: string,
    effort?: string,
  ): Promise<BridgeConnection>;
  /** Bridge coordinates of an already-running bridge, never starting one. */
  observeBridgeConnection(
    agent: BuildPipelineAgent,
    environment: Environment,
  ): Promise<BridgeConnection | undefined>;
  /** Build the interactive provider for one bridge generation. */
  createProvider(
    connection: BridgeConnection,
    environmentId: string,
    cacheKey: string,
  ): NativeAgentRuntimeProvider;
  /** Drop service state keyed by a provider group whose environment is gone. */
  forgetGroup(cacheKey: string): void;
}

export function providerCacheKey(environmentId: string, agent: BuildPipelineAgent): string {
  return `${environmentId}\0${agent}`;
}

/** Identity of one live bridge generation: ports and credentials both change on replacement. */
export function bridgeConnectionIdentity(connection: BridgeConnection): string {
  return createHash("sha256")
    .update(connection.agent)
    .update("\0")
    .update(connection.baseUrl)
    .update("\0")
    .update(connection.authToken)
    .update("\0")
    .update(connection.accountId ?? "unknown")
    .digest("hex");
}

export class ProviderRegistry {
  private readonly providers = new Map<string, NativeAgentRuntimeProvider>();
  /**
   * Provider calls inside the durable at-most-once dispatch window. Deletion
   * may now record its intent while one is running, so the background cache
   * pruner must not dispose the provider until the send has settled.
   */
  private readonly dispatchCounts = new Map<NativeAgentRuntimeProvider, number>();
  /**
   * Identity of the live bridge generation behind each production provider.
   * Ports and bearer credentials both change when a bridge is replaced.
   */
  private readonly connections = new Map<string, string>();
  private readonly absentBridgeUntil = new Map<string, number>();
  /**
   * Providers replaced or evicted from the cache but not yet disposed. An
   * OpenCode provider owns an event subscription from construction, so an
   * obsolete one left undisposed is a duplicate observer for the life of the
   * process; disposing it while a prompt it sent is in flight would abort that
   * prompt. Retirement waits for its dispatches to settle and a grace period.
   */
  private readonly retiring = new Map<
    NativeAgentRuntimeProvider,
    ReturnType<typeof setTimeout> | null
  >();
  private readonly disposed = new WeakSet<NativeAgentRuntimeProvider>();

  constructor(private readonly deps: ProviderRegistryDependencies) {}

  /** Resolve a provider, starting its bridge if needed. */
  async resolve(input: EnsureNativeAgentSessionInput): Promise<NativeAgentRuntimeProvider> {
    this.deps.assertAcceptingWork();
    const cacheKey = providerCacheKey(input.environmentId, input.agent);
    const environment = await this.deps.assertEnvironmentLive(input.environmentId);
    const cached = this.providers.get(cacheKey);

    const injected = this.deps.options.provider;
    if (injected) {
      if (cached) return cached;
      const provider = await injected(input, environment);
      await this.deps.assertEnvironmentLive(input.environmentId);
      this.deps.assertAcceptingWork();
      this.cache(cacheKey, provider);
      return provider;
    }
    // A renderer readiness request or tab teardown can replace the bridge
    // without going through this service. Re-resolve its generation before
    // trusting a cached provider, otherwise that provider keeps sending to the
    // dead port/token for the rest of the backend process.
    const connection = await this.deps.bridgeConnection(
      input.agent,
      environment,
      input.model,
      input.reasoningEffort,
    );
    const connectionIdentity = bridgeConnectionIdentity(connection);
    if (cached && this.connections.get(cacheKey) === connectionIdentity) return cached;
    await this.deps.assertEnvironmentLive(input.environmentId);
    this.deps.assertAcceptingWork();
    const provider = this.deps.createProvider(connection, input.environmentId, cacheKey);
    this.cache(cacheKey, provider, connectionIdentity);
    return provider;
  }

  /**
   * Resolve a provider for observation only, never starting a bridge.
   *
   * `resolve()` resolves its connection by *invoking the start command*, so
   * calling it from the activity sweep would spawn a bridge process for every
   * environment that has ever held a session — at startup, with no tab open,
   * and then keep them all alive on a two-second poll. An environment with no
   * running bridge has no turn in flight, which the caller records as idle, so
   * `undefined` here is an answer rather than a failure.
   */
  async observe(
    input: EnsureNativeAgentSessionInput,
  ): Promise<NativeAgentRuntimeProvider | undefined> {
    this.deps.assertAcceptingWork();
    const cacheKey = providerCacheKey(input.environmentId, input.agent);
    if (this.isBridgeKnownAbsent(cacheKey)) {
      return undefined;
    }
    const environment = await this.deps.assertEnvironmentLive(input.environmentId);
    const cached = this.providers.get(cacheKey);
    if (cached) return cached;

    const injected = this.deps.options.provider;
    if (injected) {
      const provider = await injected(input, environment);
      await this.deps.assertEnvironmentLive(input.environmentId);
      this.deps.assertAcceptingWork();
      this.install(cacheKey, provider);
      this.connections.delete(cacheKey);
      return provider;
    }
    const connection = await this.deps.observeBridgeConnection(input.agent, environment);
    if (!connection) {
      this.markBridgeAbsent(cacheKey);
      return undefined;
    }
    await this.deps.assertEnvironmentLive(input.environmentId);
    this.deps.assertAcceptingWork();
    const provider = this.deps.createProvider(connection, input.environmentId, cacheKey);
    this.cache(cacheKey, provider, bridgeConnectionIdentity(connection));
    return provider;
  }

  cached(cacheKey: string): NativeAgentRuntimeProvider | undefined {
    return this.providers.get(cacheKey);
  }

  /** The cached provider, only while it still serves this bridge generation. */
  cachedForConnection(
    cacheKey: string,
    connectionIdentity: string,
  ): NativeAgentRuntimeProvider | undefined {
    const cached = this.providers.get(cacheKey);
    return cached && this.connections.get(cacheKey) === connectionIdentity ? cached : undefined;
  }

  /** Bridge generation behind a cached production provider, if any. */
  connectionIdentity(cacheKey: string): string | undefined {
    return this.connections.get(cacheKey);
  }

  /**
   * Publish a provider and retire any "no bridge is running" note for it.
   *
   * Reaching here means a bridge was just started or connected to, so the
   * observer's cooldown is stale and would otherwise keep the sidebar reporting
   * idle for up to its full window after a user opens a tab.
   */
  cache(cacheKey: string, provider: NativeAgentRuntimeProvider, connectionIdentity?: string): void {
    const previousProvider = this.providers.get(cacheKey);
    const previousIdentity = this.connections.get(cacheKey);
    this.install(cacheKey, provider);
    if (connectionIdentity !== previousIdentity && previousProvider === provider) {
      // Same object, new bridge coordinates: still a new provider generation.
      this.deps.observations.replaceGroupGeneration(cacheKey);
    }
    if (connectionIdentity) {
      this.connections.set(cacheKey, connectionIdentity);
    } else {
      this.connections.delete(cacheKey);
    }
    this.absentBridgeUntil.delete(cacheKey);
  }

  isCached(provider: NativeAgentRuntimeProvider): boolean {
    for (const cached of this.providers.values()) if (cached === provider) return true;
    return false;
  }

  /** Whether a recent peek found no bridge running and the note is still fresh. */
  isBridgeKnownAbsent(cacheKey: string): boolean {
    return (this.absentBridgeUntil.get(cacheKey) ?? 0) > this.deps.now();
  }

  markBridgeAbsent(cacheKey: string): void {
    this.absentBridgeUntil.set(cacheKey, this.deps.now() + ABSENT_BRIDGE_RECHECK_MS);
  }

  clearBridgeAbsent(cacheKey: string): void {
    this.absentBridgeUntil.delete(cacheKey);
  }

  /** Enter the at-most-once window: the provider may not be disposed until `endDispatch`. */
  beginDispatch(provider: NativeAgentRuntimeProvider): void {
    this.dispatchCounts.set(provider, (this.dispatchCounts.get(provider) ?? 0) + 1);
  }

  endDispatch(provider: NativeAgentRuntimeProvider): void {
    const remaining = (this.dispatchCounts.get(provider) ?? 1) - 1;
    if (remaining > 0) this.dispatchCounts.set(provider, remaining);
    else {
      this.dispatchCounts.delete(provider);
      // A provider retired while this send was in flight may go now.
      this.scheduleRetirement(provider);
    }
  }

  hasDispatchInFlight(provider: NativeAgentRuntimeProvider): boolean {
    return this.dispatchCounts.has(provider);
  }

  /**
   * Drop a provider whose read-only activity call failed so the next sweep
   * reconnects with fresh bridge coordinates. The identity check avoids
   * evicting a replacement installed by concurrent work.
   *
   * Deliberately does not dispose. `OpenCodeProvider.dispose()` aborts the
   * controller whose signal is attached to *every* request that provider makes,
   * including a `promptAsync` the user is waiting on — so disposing here would
   * let a failed background health read cancel a live prompt and report it as
   * an ambiguous dispatch. It would also tear down the provider's event
   * subscription, which feeds transcript, status and notice state. Eviction
   * alone is enough;
   * `prune` still disposes a provider whose environment has gone away, where
   * nothing can be in flight.
   */
  evict(
    input: Pick<EnsureNativeAgentSessionInput, "environmentId" | "agent">,
    provider: NativeAgentRuntimeProvider,
  ): void {
    const cacheKey = providerCacheKey(input.environmentId, input.agent);
    if (this.providers.get(cacheKey) !== provider) return;
    this.providers.delete(cacheKey);
    this.connections.delete(cacheKey);
    this.deps.observations.replaceGroupGeneration(cacheKey);
    this.retire(provider);
  }

  /**
   * Dispose providers whose environment has gone away.
   *
   * Without this a deleted environment's provider stays cached for the life of
   * the process, holding its bridge connection open.
   */
  async prune(liveEnvironmentIds: Set<string>): Promise<void> {
    const stale: Array<[string, NativeAgentRuntimeProvider]> = [];
    for (const [cacheKey, provider] of this.providers) {
      const environmentId = cacheKey.slice(0, cacheKey.indexOf("\0"));
      if (!liveEnvironmentIds.has(environmentId) && !this.dispatchCounts.has(provider)) {
        stale.push([cacheKey, provider]);
      }
    }
    if (stale.length === 0) return;
    for (const [cacheKey] of stale) this.forget(cacheKey);
    // Unlike observer eviction, an absent environment is safe to dispose only
    // after any provider call that passed the pre-dispatch liveness fence has
    // settled. Active providers remain cached for the next sweep to prune.
    await Promise.allSettled(
      stale.map(([, provider]) => {
        this.disposed.add(provider);
        return provider.dispose?.();
      }),
    );
  }

  /**
   * Dispose every cached and retiring provider and forget them. Callers drain
   * their in-flight work first; nothing can be in flight on these afterwards.
   */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.providers.values()].map((provider) => provider.dispose?.()));
    // Obsolete providers still in their retirement grace hold event streams
    // of their own; nothing can be in flight on them once the drains above
    // have settled.
    const retiring = Array.from(this.retiring.keys()).filter(
      (provider) => !this.isCached(provider) && !this.disposed.has(provider),
    );
    for (const timer of this.retiring.values()) if (timer) clearTimeout(timer);
    this.retiring.clear();
    await Promise.allSettled(
      retiring.map((provider) => {
        this.disposed.add(provider);
        return provider.dispose?.();
      }),
    );
    this.dispatchCounts.clear();
    this.providers.clear();
    this.connections.clear();
  }

  /** Test-only: the live state, for seeding races the public interface cannot stage. */
  stateForTesting(): {
    providers: Map<string, NativeAgentRuntimeProvider>;
    connections: Map<string, string>;
    absentBridgeUntil: Map<string, number>;
    retiring: Map<NativeAgentRuntimeProvider, ReturnType<typeof setTimeout> | null>;
  } {
    return {
      providers: this.providers,
      connections: this.connections,
      absentBridgeUntil: this.absentBridgeUntil,
      retiring: this.retiring,
    };
  }

  /**
   * Put a provider in the cache, retiring whatever it replaces.
   *
   * A replacement is a new observation generation for the group: any read in
   * flight against the previous provider is fenced, and the group is due.
   */
  private install(cacheKey: string, provider: NativeAgentRuntimeProvider): void {
    const previous = this.providers.get(cacheKey);
    this.providers.set(cacheKey, provider);
    this.cancelRetirement(provider);
    if (previous === provider) return;
    this.deps.observations.replaceGroupGeneration(cacheKey);
    if (previous) this.retire(previous);
  }

  /**
   * Dispose a provider nothing should use any more, safely.
   *
   * Never while a prompt it sent is inside the at-most-once window (its
   * `dispose()` would abort that request and park a turn that may have run),
   * never while it is still cached under another key, and only after a grace
   * period so a projection read or an interaction answer already in flight
   * on it can finish. What this prevents is the duplicate observer: an
   * evicted OpenCode provider keeps its event subscription until disposed.
   */
  private retire(provider: NativeAgentRuntimeProvider): void {
    if (this.deps.isStopped() || this.disposed.has(provider)) return;
    if (this.isCached(provider) || this.retiring.has(provider)) return;
    this.retiring.set(provider, null);
    this.scheduleRetirement(provider);
  }

  /** Arm the grace timer once no dispatch is in flight on the provider. */
  private scheduleRetirement(provider: NativeAgentRuntimeProvider): void {
    if (!this.retiring.has(provider) || this.retiring.get(provider)) return;
    if (this.dispatchCounts.has(provider)) return; // re-armed when it settles
    const timer = setTimeout(
      () => void this.finishRetirement(provider),
      Math.max(0, this.deps.options.providerRetirementGraceMs ?? PROVIDER_RETIREMENT_GRACE_MS),
    );
    timer.unref?.();
    this.retiring.set(provider, timer);
  }

  private cancelRetirement(provider: NativeAgentRuntimeProvider): void {
    const timer = this.retiring.get(provider);
    if (timer) clearTimeout(timer);
    this.retiring.delete(provider);
  }

  private async finishRetirement(provider: NativeAgentRuntimeProvider): Promise<void> {
    if (!this.retiring.has(provider)) return;
    if (this.dispatchCounts.has(provider)) {
      // A dispatch reached it during the grace period; wait for that instead.
      this.retiring.set(provider, null);
      return;
    }
    this.retiring.delete(provider);
    if (this.isCached(provider) || this.disposed.has(provider)) return;
    this.disposed.add(provider);
    try {
      await provider.dispose?.();
    } catch (error) {
      console.warn(
        "[native-agent] Retiring an obsolete provider failed:",
        error instanceof Error ? error.name : "unknown error",
      );
    }
  }

  /** Forget a provider whose environment is gone, along with its observer state. */
  private forget(cacheKey: string): void {
    const previous = this.providers.get(cacheKey);
    if (previous) this.cancelRetirement(previous);
    this.deps.observations.replaceGroupGeneration(cacheKey);
    this.providers.delete(cacheKey);
    this.connections.delete(cacheKey);
    this.absentBridgeUntil.delete(cacheKey);
    this.deps.forgetGroup(cacheKey);
  }
}
