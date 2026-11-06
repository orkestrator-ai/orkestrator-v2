import type { RecurringWorkSnapshot } from "@orkestrator/protocol/recurring-work";
import type { NativeSessionInvalidationSnapshot } from "@orkestrator/protocol/native-agent-observation";
import { recurringWorkMetrics, type RecurringWorkMetrics } from "./recurring-work-metrics.js";
import {
  nativeSessionInvalidationMetrics,
  type NativeSessionInvalidationMetrics,
} from "./native-session-invalidation-metrics.js";
import type { RecurringSchedulerStatus } from "./recurring-scheduler.js";
import type { AdmissionPoolStatus } from "./work-admission.js";
import type { ContainerGitFetchStatus } from "./container-git-fetch.js";

/**
 * The one read-only surface for recurring-work diagnostics, shared by the
 * `get_recurring_work_diagnostics` command and the gateway's `/__orkestrator/metrics`.
 *
 * Schedulers and admission pools register themselves here when constructed
 * (and unregister on dispose/close), so diagnostics report every live instance
 * without each owner threading a reference through the command context.
 * Everything returned is aggregate and content-free: kinds, classes, counts
 * and ages — never a key, target, path or identifier. Reading it performs no
 * I/O.
 */

/** Live instances are few (one per owning service); the bound guards a leak. */
export const MAX_DIAGNOSTIC_SOURCES = 32;

type StatusSource<T> = { status(): T };

/** Finite names for fetch-policy diagnostics sources. */
export type FetchPolicyName = "container-git-fetch";
export type FetchPolicyStatus = Omit<ContainerGitFetchStatus, "generation">;

/** Finite names for container change-signal diagnostics sources. */
export type SignalSourceName =
  "claude-state-signal" | "container-worktree-signal" | "tmux-hook-signal";

/**
 * Where one container's change signal stands.
 *
 * - `unarmed`: no attempt yet (no installer, no agent tools server, or the
 *   image could not be inspected); the container is on its fallback timers.
 * - `arming`: the capability check or install is running.
 * - `armed`: a credential is installed and its probe ring has not arrived.
 * - `unconfirmed`: armed for a whole retry window with no ring. The install's
 *   probe ring is fire-and-forget, so this is the only sign that rings cannot
 *   reach the backend (a host firewall, a proxy, the host alias); it cannot
 *   say which. The container stays on its fallback timers.
 * - `confirmed`: the signal works; only the slow safety read runs.
 * - `demoted`: the signal stopped being trusted; fallback timers until the
 *   next attempt.
 * - `unsupported`: the image has no signal; fallback timers for its life.
 */
export type SignalHealthState =
  "unarmed" | "arming" | "armed" | "unconfirmed" | "confirmed" | "demoted" | "unsupported";

export type SignalDemotionReason =
  /** A safety read found a change no ring announced. */
  | "missed-change"
  /** More rings in a minute than the source's flood limit. */
  | "rang-too-often"
  /** The install exec failed. */
  | "arm-failed"
  /** The container's watcher reported that it stopped. */
  | "watcher-lost";

/** Content-free health of one signal source: no container ids, paths or tokens. */
export interface SignalHealthStatus {
  /** Containers (poll or tracking lineages) the source currently holds. */
  containers: number;
  /** How many of them are in each state; every state is present. */
  states: Record<SignalHealthState, number>;
  /** Containers held now whose fallback cadence is running (not confirmed). */
  fallback: number;
  /** Demotions since the source was created, by reason. */
  demotions: Partial<Record<SignalDemotionReason, number>>;
  /** Accepted rings since the source was created. */
  rings: number;
}

/** An all-zero state table, so every state is reported even when empty. */
export function emptySignalHealthStates(): Record<SignalHealthState, number> {
  return {
    unarmed: 0,
    arming: 0,
    armed: 0,
    unconfirmed: 0,
    confirmed: 0,
    demoted: 0,
    unsupported: 0,
  };
}

/**
 * The state of a lineage holding a credential that has not rung: `armed` until
 * it has waited `retryWindowMs` since it was first armed without a ring, then
 * `unconfirmed`. `armedAt` is when the first install of that unconfirmed
 * stretch finished; re-arming on the retry window keeps it.
 */
export function armedSignalHealth(
  armedAt: number | undefined,
  nowMs: number,
  retryWindowMs: number,
): Extract<SignalHealthState, "armed" | "unconfirmed"> {
  return armedAt !== undefined && nowMs - armedAt >= retryWindowMs ? "unconfirmed" : "armed";
}

/**
 * Finite names for cache gauge sources: in-memory caches the soak footprint
 * cannot see through schedulers, pools or subscribers (todo 0048 task 10).
 *
 * - `storage-row-cache`: each `StorageDatabase` connection's revision-validated
 *   store cache.
 * - `worktree-snapshots`: the diff-stats service's tracked entries, its file
 *   tree lineages and retained bodies, and its ad hoc file-list and tree reads.
 * - `local-git-scan`: the process-wide per-worktree line-count cache.
 * - `native-projection`: the native agent transcript projection's per-session
 *   maps (views, sync revisions, history, tool details, progressive reads).
 * - `change-tracking`: the change-tracking service's evidence sources and its
 *   deleted-environment fences.
 */
export type CacheGaugeName =
  | "storage-row-cache"
  | "worktree-snapshots"
  | "local-git-scan"
  | "native-projection"
  | "change-tracking";

/**
 * One cache source's gauges: compiled-in field names to counts (entries,
 * bytes, in-flight reads). Never a key, target, path or identifier.
 */
export type CacheGauges = Readonly<Record<string, number>>;

/** A cache source: reading it walks memory only and never performs I/O. */
export type CacheGaugeSource = { cacheGauges(): CacheGauges };

/**
 * Field names a cache source may report: a short lowercase identifier, so a
 * name can never carry a key or a path into diagnostics.
 */
const CACHE_GAUGE_FIELD = /^[a-z][A-Za-z0-9]{0,47}$/;
/** Fields kept per cache name; owners report a handful. */
export const MAX_CACHE_GAUGE_FIELDS = 64;

/** A scheduler that re-times its due work after the host slept. */
export type SuspensionListener = { compensateSuspension(suspendedMs: number): void };

export interface RecurringWorkDiagnostics {
  metrics: RecurringWorkSnapshot;
  schedulers: RecurringSchedulerStatus[];
  admission: AdmissionPoolStatus[];
  /**
   * Freshness policies that are neither schedulers nor pools (step 04's
   * container fetch policy). Aggregate counts only; generation ids are omitted.
   */
  fetchPolicies: { name: FetchPolicyName; status: FetchPolicyStatus }[];
  /**
   * Container change signals (Claude terminal state, container worktrees):
   * how many containers are confirmed, demoted or on fallback timers, so a
   * container stuck on the fast poll is visible without reading logs.
   */
  signals: { name: SignalSourceName; status: SignalHealthStatus }[];
  /**
   * Every native session invalidation the backend emitted, counted by its
   * content-free cause and the platform it named (todo 0049 task 4): what
   * keeps waking an idle view. Profile-wide, like `metrics`.
   */
  sessionInvalidations: NativeSessionInvalidationSnapshot;
  /**
   * Cache gauges by cache name, summed over that name's live sources (one per
   * open database connection, say), with how many sources reported. Content-
   * free counts only; a field that is not a finite, non-negative number is
   * dropped.
   */
  caches: { name: CacheGaugeName; sources: number; gauges: Record<string, number> }[];
  /** Registrations refused because the source table was full. */
  droppedSources: number;
  /** Sources whose `status()` threw; they are skipped, never propagated. */
  faultedSources: number;
}

export class RecurringDiagnosticsRegistry {
  private readonly schedulers = new Set<StatusSource<RecurringSchedulerStatus>>();
  private readonly pools = new Set<StatusSource<AdmissionPoolStatus>>();
  private readonly fetchPolicies = new Map<
    FetchPolicyName,
    StatusSource<ContainerGitFetchStatus>
  >();
  private readonly signals = new Map<SignalSourceName, Set<StatusSource<SignalHealthStatus>>>();
  private readonly caches = new Map<CacheGaugeName, Set<CacheGaugeSource>>();
  private readonly suspensionListeners = new Set<SuspensionListener>();
  private droppedSources = 0;

  /** Returns an idempotent unregister function. */
  addScheduler(source: StatusSource<RecurringSchedulerStatus>): () => void {
    return this.add(this.schedulers, source);
  }

  addPool(source: StatusSource<AdmissionPoolStatus>): () => void {
    return this.add(this.pools, source);
  }

  /** Registers a named fetch policy; a later registration replaces it. */
  addFetchPolicy(name: FetchPolicyName, source: StatusSource<ContainerGitFetchStatus>): () => void {
    this.fetchPolicies.set(name, source);
    return () => {
      if (this.fetchPolicies.get(name) === source) this.fetchPolicies.delete(name);
    };
  }

  /** Aggregates live sources by signal name; unregister removes only this source. */
  addSignalSource(name: SignalSourceName, source: StatusSource<SignalHealthStatus>): () => void {
    const sources = this.signals.get(name) ?? new Set<StatusSource<SignalHealthStatus>>();
    if (!sources.has(source) && sources.size >= MAX_DIAGNOSTIC_SOURCES) {
      this.droppedSources += 1;
      return () => undefined;
    }
    sources.add(source);
    this.signals.set(name, sources);
    return () => {
      sources.delete(source);
      if (sources.size === 0 && this.signals.get(name) === sources) this.signals.delete(name);
    };
  }

  /**
   * Registers a cache gauge source under its name; several sources of one name
   * are summed. Bounded per name by {@link MAX_DIAGNOSTIC_SOURCES}: a refused
   * registration counts as dropped. Unregister removes only this source.
   */
  addCacheSource(name: CacheGaugeName, source: CacheGaugeSource): () => void {
    const sources = this.caches.get(name) ?? new Set<CacheGaugeSource>();
    if (!sources.has(source) && sources.size >= MAX_DIAGNOSTIC_SOURCES) {
      this.droppedSources += 1;
      return () => undefined;
    }
    sources.add(source);
    this.caches.set(name, sources);
    return () => {
      sources.delete(source);
      if (sources.size === 0 && this.caches.get(name) === sources) this.caches.delete(name);
    };
  }

  /**
   * Registers a scheduler for host-resume compensation. Bounded by the same
   * source limit as status sources (one per live scheduler).
   */
  addSuspensionListener(listener: SuspensionListener): () => void {
    if (
      !this.suspensionListeners.has(listener) &&
      this.suspensionListeners.size >= MAX_DIAGNOSTIC_SOURCES
    ) {
      return () => undefined;
    }
    this.suspensionListeners.add(listener);
    return () => {
      this.suspensionListeners.delete(listener);
    };
  }

  /**
   * Tells every live scheduler the host was suspended for about
   * `suspendedMs`. A listener that throws is skipped; the rest still run.
   */
  notifySuspension(suspendedMs: number): void {
    for (const listener of Array.from(this.suspensionListeners)) {
      try {
        listener.compensateSuspension(suspendedMs);
      } catch {
        // A faulty listener must not stop the others from reconciling.
      }
    }
  }

  snapshot(
    metrics: RecurringWorkMetrics = recurringWorkMetrics,
    invalidations: NativeSessionInvalidationMetrics = nativeSessionInvalidationMetrics,
  ): RecurringWorkDiagnostics {
    let faultedSources = 0;
    const collect = <T>(sources: Set<StatusSource<T>>): T[] => {
      const result: T[] = [];
      for (const source of sources) {
        try {
          result.push(source.status());
        } catch {
          faultedSources += 1;
        }
      }
      return result;
    };
    const schedulers = collect(this.schedulers);
    const admission = collect(this.pools);
    const fetchPolicies: RecurringWorkDiagnostics["fetchPolicies"] = [];
    for (const [name, source] of this.fetchPolicies) {
      try {
        const { generation: _generation, ...status } = source.status();
        fetchPolicies.push({ name, status });
      } catch {
        faultedSources += 1;
      }
    }
    const signals: RecurringWorkDiagnostics["signals"] = [];
    for (const [name, sources] of this.signals) {
      const statuses = collect(sources);
      if (statuses.length === 0) continue;
      const status: SignalHealthStatus = {
        containers: 0,
        states: emptySignalHealthStates(),
        fallback: 0,
        demotions: {},
        rings: 0,
      };
      for (const current of statuses) {
        status.containers += current.containers;
        status.fallback += current.fallback;
        status.rings += current.rings;
        for (const state of Object.keys(status.states) as SignalHealthState[]) {
          status.states[state] += current.states[state];
        }
        for (const reason of Object.keys(current.demotions) as SignalDemotionReason[]) {
          status.demotions[reason] =
            (status.demotions[reason] ?? 0) + (current.demotions[reason] ?? 0);
        }
      }
      signals.push({ name, status });
    }
    const caches: RecurringWorkDiagnostics["caches"] = [];
    for (const [name, sources] of this.caches) {
      const gauges: Record<string, number> = {};
      let reported = 0;
      for (const source of sources) {
        let current: CacheGauges;
        try {
          current = source.cacheGauges();
        } catch {
          faultedSources += 1;
          continue;
        }
        reported += 1;
        for (const [field, value] of Object.entries(current)) {
          if (!CACHE_GAUGE_FIELD.test(field)) continue;
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
          if (!(field in gauges) && Object.keys(gauges).length >= MAX_CACHE_GAUGE_FIELDS) continue;
          gauges[field] = (gauges[field] ?? 0) + value;
        }
      }
      if (reported > 0) caches.push({ name, sources: reported, gauges });
    }
    return {
      metrics: metrics.snapshot(),
      schedulers,
      admission,
      fetchPolicies,
      signals,
      sessionInvalidations: invalidations.snapshot(),
      caches,
      droppedSources: this.droppedSources,
      faultedSources,
    };
  }

  private add<T>(set: Set<StatusSource<T>>, source: StatusSource<T>): () => void {
    if (!set.has(source) && this.schedulers.size + this.pools.size >= MAX_DIAGNOSTIC_SOURCES) {
      this.droppedSources += 1;
      return () => undefined;
    }
    set.add(source);
    return () => {
      set.delete(source);
    };
  }
}

export const recurringDiagnosticsRegistry = new RecurringDiagnosticsRegistry();

export function recurringWorkDiagnostics(
  metrics: RecurringWorkMetrics = recurringWorkMetrics,
): RecurringWorkDiagnostics {
  return recurringDiagnosticsRegistry.snapshot(metrics);
}
