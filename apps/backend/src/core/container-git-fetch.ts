import { createHash, randomUUID } from "node:crypto";
import type {
  WorktreeRemoteFetchFailure,
  WorktreeRemoteFreshness,
} from "@orkestrator/protocol/worktree-snapshots";
import { recurringWorkMetrics, type RecurringWorkMetrics } from "./recurring-work-metrics.js";
import type { WorkAdmissionPool } from "./work-admission.js";
import { worktreeTargetKey } from "./worktree-adhoc-reads.js";

/**
 * Remote freshness for container clones, separated from status scans.
 *
 * A container's status script used to run `git fetch origin <ref>` on every
 * scan: every 15 s background poll and every 5 s Files-panel read opened a
 * network round trip, even for a baseline that was an immutable commit already
 * in the clone. Status collection now reads local Git state only
 * (`buildContainerGitStatusScript`), and this owner decides when a fetch is
 * worth running — the container equivalent of `GitFetchScheduler`, without
 * sharing identities across isolated clones.
 *
 * ## Baselines
 *
 * The status script classifies the comparison base it resolved, with exactly
 * the old resolution order (`origin/<ref>`, then `<ref>`):
 *
 * - `commit`: the ref is a full commit SHA present in the clone. It names the
 *   same commit forever, so no fetch is ever attempted.
 * - `tracking-ref` / `local-ref`: a branch (or other movable ref) resolved
 *   through `origin/<ref>` or the local `<ref>`. Fetched by policy below.
 * - missing: nothing resolves. The wrapper asks {@link recover} for one
 *   bounded fetch and re-resolves once; if the base is still missing the
 *   existing missing-target error surfaces. A missing base never becomes an
 *   empty diff.
 *
 * ## Identity
 *
 * A record is keyed by the container generation (a counter this owner bumps
 * when the container is forgotten on a lifecycle change), the container id
 * (Docker ids are never reused), a digest of the clone's identity reported by
 * the script (top level, common Git dir and its device/inode/birth time, so a workspace
 * re-cloned inside the same container is a different clone) and the remote
 * and ref. Branch or project names alone never key anything. State lives in
 * memory, so a backend restart is a new generation of everything.
 *
 * ## Policy
 *
 * - One fetch per key at a time; concurrent consumers join it.
 * - An attempt — successful or not — stamps `lastAttemptAt` on completion.
 *   The next attempt is due {@link CONTAINER_FETCH_COOLDOWN_MS} later. A
 *   failure doubles that per consecutive failure up to
 *   {@link CONTAINER_FETCH_FAILURE_COOLDOWN_MAX_MS}: an unreachable or
 *   unauthenticated remote costs at most one attempt per window and never a
 *   retry storm, and a failure never marks refs fresh.
 * - `lastAttemptAt`, `lastSuccessAt`, the in-flight attempt and the failure
 *   category are separate facts; freshness is derived from them.
 * - A known remote mutation (successful merge) marks the key dirty and makes
 *   it due at once; an explicit refresh does the same unless an attempt
 *   started or finished within {@link CONTAINER_FETCH_EXPLICIT_MIN_INTERVAL_MS}.
 *   An invalidation that lands while an attempt runs keeps the key dirty and
 *   starts one follow-up attempt when it settles: the running fetch may have
 *   read the remote before the mutation.
 *
 * ## Admission and ordering
 *
 * Routine fetches are never awaited by a status read. When a scan finds a key
 * due, a background attempt acquires the shared `git-docker-scan` pool at
 * `discovery` priority under the *same* target key as the container's scans
 * (`container:<id>`), so a fetch and a scan of one container never overlap
 * and user reads (`interactive`) are admitted first. The scan that triggered
 * it does not wait: it answers from local refs. When the fetch moves
 * `origin/<ref>`, `onChange` reports `baselineMoved` and the caller
 * invalidates the snapshot baseline, which rescans once.
 *
 * Missing-baseline recovery runs *inside* the scan's own admission slot (the
 * scan already holds the container's target key) with the bounded fetch
 * timeout: it never acquires a second slot, so it cannot deadlock on itself.
 * If a background attempt for the key is still waiting for admission, the
 * recovery takes it over — cancels the queued acquisition and performs that
 * same attempt inline — so joiners still see exactly one fetch.
 *
 * Worst case for local views: a hanging remote holds the container's one
 * target slot for at most one fetch timeout per cooldown window, after which
 * failure backoff makes it rarer. Other containers are unaffected
 * (per-target limit).
 *
 * ## Bounds
 *
 * Records are evicted when idle for {@link CONTAINER_FETCH_RECORD_IDLE_MS} or
 * beyond {@link CONTAINER_FETCH_MAX_RECORDS} (least recently used first);
 * in-flight records are never evicted, so an eviction cannot let a duplicate
 * fetch start for the same generation. The fetch script bounds stderr to
 * {@link CONTAINER_FETCH_STDERR_BYTES}; it is classified into a finite category
 * here and never retained or logged.
 */

/** Minimum time between fetch attempts of one key after a success. */
export const CONTAINER_FETCH_COOLDOWN_MS = 5 * 60_000;
/** Consecutive failures double the cooldown up to this. */
export const CONTAINER_FETCH_FAILURE_COOLDOWN_MAX_MS = 30 * 60_000;
/** An explicit refresh within this of the last attempt joins that attempt. */
export const CONTAINER_FETCH_EXPLICIT_MIN_INTERVAL_MS = 15_000;
/** In-container `timeout` for `git fetch`; the host exec allows a margin on top. */
export const CONTAINER_FETCH_TIMEOUT_MS = 30_000;
export const CONTAINER_FETCH_EXEC_MARGIN_MS = 10_000;
export const CONTAINER_FETCH_MAX_RECORDS = 256;
export const CONTAINER_FETCH_RECORD_IDLE_MS = 30 * 60_000;
/** Refs remembered per container for freshness lookups. */
export const CONTAINER_FETCH_MAX_REFS_PER_CONTAINER = 8;
export const CONTAINER_FETCH_STDERR_BYTES = 2_048;
const SWEEP_INTERVAL_MS = 60_000;

export type ContainerBaselineKind = "commit" | "tracking-ref" | "local-ref";

/** What a status scan learned about one container clone. */
export interface ContainerFetchScope {
  containerId: string;
  /** Digest of the clone identity reported by the script; `""` when unknown. */
  repoId: string;
  ref: string;
}

export type ContainerFetchOutcome =
  | { ok: true; moved: boolean }
  | { ok: false; failure: WorktreeRemoteFetchFailure }
  /** The clone changed between the scan and the fetch; nothing was stamped. */
  | { ok: false; superseded: true };

export interface ContainerFetchChange {
  containerId: string;
  ref: string;
  /** `origin/<ref>` moved and nobody is re-reading it already: rescan. */
  baselineMoved: boolean;
}

export interface ContainerGitFetchPolicyOptions {
  /** Runs the fetch script for `ref` in the container; resolves with its raw stdout. */
  runFetch: (containerId: string, ref: string, timeoutMs: number) => Promise<string>;
  /** The shared `git-docker-scan` pool; none in unit tests unless given. */
  admission?: WorkAdmissionPool | null;
  /** Monotonic milliseconds. */
  now?: () => number;
  /** Wall clock for the exposed `lastSuccessAt`. */
  wallNow?: () => string;
  metrics?: RecurringWorkMetrics;
  /** Remote freshness changed (and possibly the baseline moved) for a container. */
  onChange?: (change: ContainerFetchChange) => void;
  cooldownMs?: number;
  failureCooldownMaxMs?: number;
  explicitMinIntervalMs?: number;
  fetchTimeoutMs?: number;
  maxRecords?: number;
  recordIdleMs?: number;
}

interface FetchAttempt {
  phase: "waiting" | "running" | "done";
  /** Recovery performs it inside a scan that re-reads by itself. */
  inline: boolean;
  startedAt?: number;
  invalidationsAtStart: number;
  abort: AbortController;
  promise: Promise<ContainerFetchOutcome>;
  resolve: (outcome: ContainerFetchOutcome) => void;
}

interface FetchRecord {
  key: string;
  containerId: string;
  generation: number;
  repoId: string;
  ref: string;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastSuccessWall?: string;
  failure?: WorktreeRemoteFetchFailure;
  consecutiveFailures: number;
  /** Invalidated since the last attempt that started after the invalidation. */
  dirty: boolean;
  invalidations: number;
  inFlight?: FetchAttempt;
  lastUsedAt: number;
}

interface ContainerScopeState {
  generation: number;
  repoId: string;
  /** ref -> last classification, insertion-ordered for bounded eviction. */
  baselines: Map<string, ContainerBaselineKind>;
  lastUsedAt: number;
}

export interface ContainerGitFetchStatus {
  generation: string;
  records: number;
  containers: number;
  inFlight: number;
  waiting: number;
  dirty: number;
  failing: Partial<Record<WorktreeRemoteFetchFailure, number>>;
  evicted: number;
}

/** A fetch attempt that failed; `category` feeds the content-free metrics. */
export class ContainerFetchError extends Error {
  readonly category: "timeout" | "unavailable" | "error";
  constructor(readonly failure: WorktreeRemoteFetchFailure) {
    super(`Container fetch failed: ${failure}`);
    this.name = "ContainerFetchError";
    this.category =
      failure === "timeout" ? "timeout" : failure === "unavailable" ? "unavailable" : "error";
  }
}

export class ContainerGitFetchPolicy {
  /** Identifies this owner's lifetime in diagnostics. */
  readonly generation = randomUUID();
  private readonly options: Required<
    Pick<
      ContainerGitFetchPolicyOptions,
      | "cooldownMs"
      | "failureCooldownMaxMs"
      | "explicitMinIntervalMs"
      | "fetchTimeoutMs"
      | "maxRecords"
      | "recordIdleMs"
    >
  >;
  private readonly runFetch: ContainerGitFetchPolicyOptions["runFetch"];
  private readonly admission: WorkAdmissionPool | null;
  private readonly now: () => number;
  private readonly wallNow: () => string;
  private readonly metrics: RecurringWorkMetrics;
  private readonly onChange?: (change: ContainerFetchChange) => void;
  private readonly records = new Map<string, FetchRecord>();
  private readonly scopes = new Map<string, ContainerScopeState>();
  private readonly generations = new Map<string, number>();
  private nextGeneration = 1;
  private lastSweepAt = Number.NEGATIVE_INFINITY;
  private evicted = 0;

  constructor(options: ContainerGitFetchPolicyOptions) {
    this.runFetch = options.runFetch;
    this.admission = options.admission ?? null;
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => new Date().toISOString());
    this.metrics = options.metrics ?? recurringWorkMetrics;
    this.onChange = options.onChange;
    this.options = {
      cooldownMs: options.cooldownMs ?? CONTAINER_FETCH_COOLDOWN_MS,
      failureCooldownMaxMs: options.failureCooldownMaxMs ?? CONTAINER_FETCH_FAILURE_COOLDOWN_MAX_MS,
      explicitMinIntervalMs:
        options.explicitMinIntervalMs ?? CONTAINER_FETCH_EXPLICIT_MIN_INTERVAL_MS,
      fetchTimeoutMs: options.fetchTimeoutMs ?? CONTAINER_FETCH_TIMEOUT_MS,
      maxRecords: options.maxRecords ?? CONTAINER_FETCH_MAX_RECORDS,
      recordIdleMs: options.recordIdleMs ?? CONTAINER_FETCH_RECORD_IDLE_MS,
    };
  }

  /**
   * Called after a local-only status scan resolved a baseline. Starts a
   * background fetch when one is due and returns the remote freshness the
   * scan's result should carry. Never waits for the network.
   */
  observe(scope: ContainerFetchScope, baseline: ContainerBaselineKind): WorktreeRemoteFreshness {
    this.remember(scope, baseline);
    if (baseline === "commit") return { state: "not-required" };
    const record = this.record(scope);
    this.metrics.requested("git-fetch-container");
    if (record.inFlight) {
      this.metrics.coalesced("git-fetch-container");
    } else if (this.isDue(record)) {
      this.metrics.cacheMiss("git-fetch-container");
      this.startBackground(record);
    } else {
      this.metrics.cacheHit("git-fetch-container");
    }
    return freshnessOf(record);
  }

  /**
   * The baseline did not resolve. Performs at most one bounded fetch — only
   * when the key is due, so a ref that is genuinely absent is not fetched on
   * every read (the failure stamps the cooldown) — and resolves `true` when a
   * fetch succeeded and the caller should re-resolve the baseline once.
   *
   * Must be called from inside the scan's admission slot for this container:
   * the fetch runs in that slot rather than acquiring another.
   */
  async recover(scope: ContainerFetchScope): Promise<boolean> {
    this.remember(scope, undefined);
    const record = this.record(scope);
    this.metrics.requested("git-fetch-container");
    const existing = record.inFlight;
    if (existing) {
      this.metrics.coalesced("git-fetch-container");
      if (existing.phase === "waiting") {
        // Queued behind the slot this scan holds: perform it here instead.
        existing.inline = true;
        existing.abort.abort();
        void this.perform(record, existing);
      }
      return (await existing.promise).ok;
    }
    if (!this.isDue(record)) {
      this.metrics.cacheHit("git-fetch-container");
      return false;
    }
    this.metrics.cacheMiss("git-fetch-container");
    const attempt = this.newAttempt(record, true);
    void this.perform(record, attempt);
    return (await attempt.promise).ok;
  }

  /**
   * The remote is known (`mutation`: a merge) or asked (`explicit`: a manual
   * refresh) to have moved. Every ref of the container, or just `ref`.
   */
  invalidate(lookup: { containerId: string; ref?: string }, reason: "mutation" | "explicit"): void {
    const now = this.now();
    const generation = this.generations.get(lookup.containerId);
    let changed = false;
    for (const record of this.records.values()) {
      if (record.containerId !== lookup.containerId || record.generation !== generation) continue;
      if (lookup.ref !== undefined && record.ref !== lookup.ref) continue;
      if (reason === "explicit" && this.recentlyAttempted(record, now)) continue;
      record.invalidations += 1;
      if (!record.dirty) changed = true;
      record.dirty = true;
    }
    if (changed) this.notify(lookup.containerId, lookup.ref ?? "", false);
  }

  /**
   * The container stopped, was recreated or deleted: drop its records and
   * start a new generation, so a fetch still running for the old one can
   * neither stamp nor be joined by the new one.
   */
  forgetContainer(containerId: string): void {
    const had = this.generations.has(containerId) || this.scopes.has(containerId);
    this.generations.delete(containerId);
    this.scopes.delete(containerId);
    for (const [key, record] of Array.from(this.records)) {
      if (record.containerId === containerId) this.records.delete(key);
    }
    if (had) this.generations.set(containerId, this.nextGeneration++);
  }

  /** Lifecycle reconciliation: forget every container not in `live`. */
  retainContainers(live: Iterable<string>): void {
    const keep = new Set(live);
    const known = new Set([...this.generations.keys(), ...this.scopes.keys()]);
    for (const containerId of known) {
      if (!keep.has(containerId)) {
        this.forgetContainer(containerId);
        // Nothing of it remains; a later sighting starts fresh anyway.
        this.generations.delete(containerId);
      }
    }
  }

  /** Remote freshness last observed for a container's comparison ref. */
  freshness(containerId: string, ref: string): WorktreeRemoteFreshness | undefined {
    const scope = this.scopes.get(containerId);
    const baseline = scope?.baselines.get(ref);
    if (!scope || baseline === undefined) return undefined;
    if (baseline === "commit") return { state: "not-required" };
    const record = this.records.get(recordKey(containerId, scope.generation, scope.repoId, ref));
    return record ? freshnessOf(record) : { state: "unknown" };
  }

  /** Resolves when every attempt currently in flight has settled (tests, shutdown). */
  async idle(): Promise<void> {
    while (true) {
      const pending = Array.from(this.records.values())
        .map((record) => record.inFlight?.promise)
        .filter((promise): promise is Promise<ContainerFetchOutcome> => promise !== undefined);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  /** Content-free status for diagnostics and tests. */
  status(): ContainerGitFetchStatus {
    let inFlight = 0;
    let waiting = 0;
    let dirty = 0;
    const failing: ContainerGitFetchStatus["failing"] = {};
    for (const record of this.records.values()) {
      if (record.inFlight?.phase === "running") inFlight += 1;
      if (record.inFlight?.phase === "waiting") waiting += 1;
      if (record.dirty) dirty += 1;
      if (record.failure) failing[record.failure] = (failing[record.failure] ?? 0) + 1;
    }
    return {
      generation: this.generation,
      records: this.records.size,
      containers: this.scopes.size,
      inFlight,
      waiting,
      dirty,
      failing,
      evicted: this.evicted,
    };
  }

  private remember(scope: ContainerFetchScope, baseline: ContainerBaselineKind | undefined): void {
    const now = this.now();
    const generation = this.generationOf(scope.containerId);
    let state = this.scopes.get(scope.containerId);
    if (!state || state.repoId !== scope.repoId || state.generation !== generation) {
      // A re-cloned workspace is a different clone: its old classifications
      // and records no longer describe anything (records age out).
      state = { generation, repoId: scope.repoId, baselines: new Map(), lastUsedAt: now };
      this.scopes.set(scope.containerId, state);
    }
    state.lastUsedAt = now;
    if (baseline !== undefined) {
      state.baselines.delete(scope.ref);
      state.baselines.set(scope.ref, baseline);
      while (state.baselines.size > CONTAINER_FETCH_MAX_REFS_PER_CONTAINER) {
        const oldest = state.baselines.keys().next().value;
        if (oldest === undefined) break;
        state.baselines.delete(oldest);
      }
    }
  }

  private generationOf(containerId: string): number {
    let generation = this.generations.get(containerId);
    if (generation === undefined) {
      generation = this.nextGeneration++;
      this.generations.set(containerId, generation);
    }
    return generation;
  }

  private record(scope: ContainerFetchScope): FetchRecord {
    const now = this.now();
    const generation = this.generationOf(scope.containerId);
    const key = recordKey(scope.containerId, generation, scope.repoId, scope.ref);
    let record = this.records.get(key);
    if (!record) {
      this.sweep(now, true);
      record = {
        key,
        containerId: scope.containerId,
        generation,
        repoId: scope.repoId,
        ref: scope.ref,
        consecutiveFailures: 0,
        dirty: false,
        invalidations: 0,
        lastUsedAt: now,
      };
      this.records.set(key, record);
    } else {
      this.sweep(now, false);
    }
    record.lastUsedAt = now;
    return record;
  }

  private isDue(record: FetchRecord): boolean {
    if (record.lastAttemptAt === undefined || record.dirty) return true;
    return this.now() - record.lastAttemptAt >= this.cooldownOf(record);
  }

  private cooldownOf(record: FetchRecord): number {
    if (!record.failure) return this.options.cooldownMs;
    const doubled = this.options.cooldownMs * 2 ** Math.max(0, record.consecutiveFailures - 1);
    return Math.min(doubled, Math.max(this.options.cooldownMs, this.options.failureCooldownMaxMs));
  }

  private recentlyAttempted(record: FetchRecord, now: number): boolean {
    const interval = this.options.explicitMinIntervalMs;
    const started = record.inFlight?.startedAt;
    if (started !== undefined && now - started < interval) return true;
    if (record.inFlight?.phase === "waiting") return true;
    return record.lastAttemptAt !== undefined && now - record.lastAttemptAt < interval;
  }

  private newAttempt(record: FetchRecord, inline: boolean): FetchAttempt {
    let resolve!: (outcome: ContainerFetchOutcome) => void;
    const promise = new Promise<ContainerFetchOutcome>((settle) => {
      resolve = settle;
    });
    const attempt: FetchAttempt = {
      phase: "waiting",
      inline,
      invalidationsAtStart: record.invalidations,
      abort: new AbortController(),
      promise,
      resolve,
    };
    record.inFlight = attempt;
    return attempt;
  }

  private startBackground(record: FetchRecord): void {
    const attempt = this.newAttempt(record, false);
    if (!this.admission) {
      void this.perform(record, attempt);
      return;
    }
    this.admission
      .acquire({
        kind: "git-fetch-container",
        priority: "discovery",
        target: worktreeTargetKey({ containerId: record.containerId }),
        signal: attempt.abort.signal,
      })
      .then(
        (lease) => {
          if (attempt.phase !== "waiting") {
            lease.release();
            return;
          }
          void this.perform(record, attempt).finally(() => lease.release());
        },
        () => {
          // Taken over by a recovery (aborted on purpose), or refused.
          if (attempt.phase !== "waiting") return;
          attempt.phase = "running";
          this.settle(record, attempt, { ok: false, failure: "capacity" });
        },
      );
  }

  /** Runs the physical fetch for `attempt`. Never rejects. */
  private async perform(record: FetchRecord, attempt: FetchAttempt): Promise<void> {
    if (attempt.phase !== "waiting") return;
    attempt.phase = "running";
    attempt.startedAt = this.now();
    // Invalidations up to the moment the remote is read are covered by it.
    attempt.invalidationsAtStart = record.invalidations;
    let outcome: ContainerFetchOutcome;
    try {
      const parsed = await this.metrics.observe("git-fetch-container", async () => {
        const output = await this.runFetch(
          record.containerId,
          record.ref,
          this.options.fetchTimeoutMs,
        );
        const response = parseContainerFetchResponse(output);
        if (response.kind === "failed") throw new ContainerFetchError(response.failure);
        return response;
      });
      if (parsed.kind === "no-repo" || (record.repoId && parsed.repoId !== record.repoId)) {
        outcome = { ok: false, superseded: true };
      } else {
        outcome = { ok: true, moved: parsed.before !== parsed.after };
      }
    } catch (error) {
      outcome = { ok: false, failure: classifyFetchError(error) };
    }
    this.settle(record, attempt, outcome);
  }

  private settle(record: FetchRecord, attempt: FetchAttempt, outcome: ContainerFetchOutcome): void {
    if (attempt.phase === "done") return;
    attempt.phase = "done";
    if (record.inFlight === attempt) record.inFlight = undefined;
    const invalidatedDuring = record.invalidations !== attempt.invalidationsAtStart;
    if (!("superseded" in outcome)) {
      const now = this.now();
      // Stamped on completion: a slow fetch is not already stale when it ends.
      record.lastAttemptAt = now;
      if (outcome.ok) {
        record.lastSuccessAt = now;
        record.lastSuccessWall = this.wallNow();
        record.failure = undefined;
        record.consecutiveFailures = 0;
      } else {
        record.failure = outcome.failure;
        record.consecutiveFailures += 1;
      }
      if (!invalidatedDuring) record.dirty = false;
    }
    attempt.resolve(outcome);
    if (this.records.get(record.key) !== record) return;
    this.notify(record.containerId, record.ref, outcome.ok && outcome.moved && !attempt.inline);
    // The remote may have changed after this attempt read it.
    if (invalidatedDuring && record.dirty && !record.inFlight) this.startBackground(record);
  }

  private notify(containerId: string, ref: string, baselineMoved: boolean): void {
    try {
      this.onChange?.({ containerId, ref, baselineMoved });
    } catch {
      // Observational: a faulty listener must not break fetch bookkeeping.
    }
  }

  private sweep(now: number, adding: boolean): void {
    const over = adding && this.records.size >= this.options.maxRecords;
    if (!over && now - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    for (const [key, record] of Array.from(this.records)) {
      if (!record.inFlight && now - record.lastUsedAt > this.options.recordIdleMs) {
        this.records.delete(key);
        this.evicted += 1;
      }
    }
    for (const [containerId, scope] of Array.from(this.scopes)) {
      if (now - scope.lastUsedAt > this.options.recordIdleMs) this.scopes.delete(containerId);
    }
    const limit = adding ? this.options.maxRecords - 1 : this.options.maxRecords;
    if (this.records.size <= limit) return;
    const idle = Array.from(this.records.values())
      .filter((record) => !record.inFlight)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const record of idle) {
      if (this.records.size <= limit) break;
      this.records.delete(record.key);
      this.evicted += 1;
    }
  }
}

function recordKey(containerId: string, generation: number, repoId: string, ref: string): string {
  return [containerId, generation, repoId, "origin", ref].join("\0");
}

function freshnessOf(record: FetchRecord): WorktreeRemoteFreshness {
  const lastSuccessAt = record.lastSuccessWall;
  if (record.lastAttemptAt === undefined) {
    return record.dirty && lastSuccessAt ? { state: "stale", lastSuccessAt } : { state: "unknown" };
  }
  if (!record.failure && !record.dirty) return { state: "current", lastSuccessAt };
  return {
    state: "stale",
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
    ...(record.failure ? { failure: record.failure } : {}),
  };
}

function classifyFetchError(error: unknown): WorktreeRemoteFetchFailure {
  if (error instanceof ContainerFetchError) return error.failure;
  if (error && typeof error === "object" && (error as { timedOut?: unknown }).timedOut === true) {
    return "timeout";
  }
  // The exec itself failed: the container is stopping, gone or unreachable.
  return "unavailable";
}

// ---------------------------------------------------------------------------
// Framing shared with the scripts in `commands-files.ts`. Markers use the same
// ASCII record/unit separators as the status script.

const FRAME_START = String.fromCharCode(0x1e);
const FRAME_END = String.fromCharCode(0x1f);
function marker(name: string): string {
  return `${FRAME_START}${name}${FRAME_END}`;
}
export const CONTAINER_REPO_MARKER = marker("ORKESTRATOR_REPO");
export const CONTAINER_FETCH_NO_REPO_MARKER = marker("ORKESTRATOR_FETCH_NO_REPO");
export const CONTAINER_FETCH_MARKER = marker("ORKESTRATOR_FETCH");
export const CONTAINER_FETCH_ERR_MARKER = marker("ORKESTRATOR_FETCH_ERR");
export const CONTAINER_FETCH_END_MARKER = marker("ORKESTRATOR_FETCH_END");

/**
 * Shell fragment that prints the framed clone identity: top level, absolute
 * common Git dir and its device/inode/birth time, base64'd because paths may
 * hold any byte. Inode plus birth time distinguish a workspace re-cloned at the
 * same path even when the filesystem reuses the inode number.
 */
export const CONTAINER_REPO_IDENTITY_SNIPPET = `
      repo_top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
      repo_common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || git rev-parse --git-common-dir 2>/dev/null || true)"
      case "$repo_common" in
        ''|/*) ;;
        *) repo_common="$(pwd)/$repo_common" ;;
      esac
      repo_node="$(stat -c '%d:%i:%w' "$repo_common" 2>/dev/null || stat -f '%d:%i:%B' "$repo_common" 2>/dev/null || true)"
      printf '\\036ORKESTRATOR_REPO\\037'
      printf '%s\\t%s\\t%s' "$repo_top" "$repo_common" "$repo_node" | base64 -w0
`;

/** Content-free digest of a decoded clone identity payload. */
export function containerRepoId(payload: string): string {
  if (!payload) return "";
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * Decodes a framed base64 section, tolerating the whitespace some base64
 * implementations emit (see `decodeGitStatusSection`).
 */
export function decodeFramedBase64(payload: string, label: string): string {
  const encoded = payload.replace(/\s+/g, "");
  if (encoded.length === 0) return "";
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error(`Malformed ${label}: invalid base64`);
  }
  return Buffer.from(encoded, "base64").toString("utf8");
}

export type ContainerFetchResponse =
  | { kind: "no-repo" }
  | { kind: "fetched"; repoId: string; before: string; after: string }
  | { kind: "failed"; failure: WorktreeRemoteFetchFailure };

const SHA_OR_EMPTY = /^(?:[0-9a-f]{40}|[0-9a-f]{64})?$/;

/**
 * Parses the fetch script's framed output. A non-zero `git fetch` becomes a
 * sanitized failure category; the stderr it was classified from is dropped.
 */
export function parseContainerFetchResponse(output: string): ContainerFetchResponse {
  if (output === CONTAINER_FETCH_NO_REPO_MARKER) return { kind: "no-repo" };
  const fetchStart = output.indexOf(CONTAINER_FETCH_MARKER);
  const errStart = output.indexOf(CONTAINER_FETCH_ERR_MARKER);
  const endStart = output.indexOf(CONTAINER_FETCH_END_MARKER);
  if (
    !output.startsWith(CONTAINER_REPO_MARKER) ||
    fetchStart < CONTAINER_REPO_MARKER.length ||
    errStart < fetchStart ||
    endStart < errStart ||
    endStart + CONTAINER_FETCH_END_MARKER.length !== output.length
  ) {
    return { kind: "failed", failure: "error" };
  }
  let repoPayload: string;
  let stderr: string;
  try {
    repoPayload = decodeFramedBase64(
      output.slice(CONTAINER_REPO_MARKER.length, fetchStart),
      "container repo identity",
    );
    stderr = decodeFramedBase64(
      output.slice(errStart + CONTAINER_FETCH_ERR_MARKER.length, endStart),
      "container fetch stderr",
    ).slice(0, CONTAINER_FETCH_STDERR_BYTES);
  } catch {
    return { kind: "failed", failure: "error" };
  }
  const fields = output.slice(fetchStart + CONTAINER_FETCH_MARKER.length, errStart).split("\t");
  const [statusText = "", before = "", after = ""] = fields;
  if (
    fields.length !== 3 ||
    !/^\d+$/.test(statusText) ||
    !SHA_OR_EMPTY.test(before) ||
    !SHA_OR_EMPTY.test(after)
  ) {
    return { kind: "failed", failure: "error" };
  }
  const status = Number.parseInt(statusText, 10);
  if (status !== 0) return { kind: "failed", failure: classifyFetchFailure(status, stderr) };
  return { kind: "fetched", repoId: containerRepoId(repoPayload), before, after };
}

/**
 * Builds a framed fetch response exactly as the fetch script prints it; for
 * tests and the deterministic baseline harness, which have no container.
 */
export function formatContainerFetchResponse(input: {
  repo: string;
  status?: number;
  before?: string;
  after?: string;
  stderr?: string;
}): string {
  return [
    CONTAINER_REPO_MARKER,
    Buffer.from(input.repo).toString("base64"),
    CONTAINER_FETCH_MARKER,
    `${input.status ?? 0}\t${input.before ?? ""}\t${input.after ?? ""}`,
    CONTAINER_FETCH_ERR_MARKER,
    Buffer.from(input.stderr ?? "").toString("base64"),
    CONTAINER_FETCH_END_MARKER,
  ].join("");
}

/**
 * Maps a failed `git fetch` to a finite category from its exit status and
 * bounded stderr. The text never leaves this function.
 */
export function classifyFetchFailure(status: number, stderr: string): WorktreeRemoteFetchFailure {
  // `timeout(1)` exits 124 on expiry, or 137 when it had to kill.
  if (status === 124 || status === 137) return "timeout";
  const text = stderr.toLowerCase();
  if (
    /authentication failed|could not read (username|password)|permission denied|terminal prompts disabled|invalid username or password|access denied|http 40[13]|returned error: 40[13]|bad credentials/.test(
      text,
    )
  ) {
    return "auth";
  }
  if (/couldn't find remote ref|could not find remote ref|not our ref|no such ref/.test(text)) {
    return "missing-ref";
  }
  if (
    /does not appear to be a git repository|no such remote|repository .* not found|not a git repository/.test(
      text,
    )
  ) {
    return "no-remote";
  }
  if (
    /could not resolve host|connection (timed out|refused|reset)|network is unreachable|unable to access|early eof|operation timed out|failed to connect|temporary failure in name resolution|the remote end hung up/.test(
      text,
    )
  ) {
    return "network";
  }
  return "error";
}
