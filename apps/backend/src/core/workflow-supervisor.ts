import type { RecurringJobKind } from "@orkestrator/protocol/recurring-work";
import type { RecurringDiagnosticsRegistry } from "./recurring-diagnostics.js";
import {
  RecurringScheduler,
  type RecurringRunContext,
  type RecurringRunResult,
  type RecurringSchedulerLimits,
  type RecurringTimerFactory,
} from "./recurring-scheduler.js";
import type { RecurringWorkMetrics } from "./recurring-work-metrics.js";
import {
  AdmissionRejectedError,
  type AdmissionLease,
  type WorkAdmissionPool,
} from "./work-admission.js";

/**
 * Keyed supervision for backend-owned workflows (recurring-processes step 08).
 *
 * The previous supervisors listed *every* stored workflow on a one-second
 * timer and advanced the active ones from inside that tick. Selection cost
 * therefore grew with retained history, and one workflow waiting on a slow
 * provider held the whole service's tick open, delaying every other workflow.
 *
 * This keeps a small, rebuildable **index** of keys that still owe work — an
 * obligation, not merely a phase called "running" — and gives each key its own
 * due time on a {@link RecurringScheduler}:
 *
 * - **Obligations.** The domain classifies a durable record into an obligation
 *   (or `null` when nothing is owed) and {@link KeyedWorkflowSupervisor.note}s
 *   it after every successful durable mutation and every authoritative read
 *   of that record. Only noted/discovered keys are ever scheduled.
 * - **Per-key progress.** A key's pass runs the domain's own locked advance at
 *   the domain's fallback cadence (the previous tick interval), repeated from
 *   completion. A slow key rests; it never delays another key.
 * - **Scoped wakeups.** Commands, provider transitions, accepted results and
 *   environment changes wake only the affected keys. Dirty wakeups
 *   (`invalidate`) produce exactly one trailing pass if they arrive mid-pass;
 *   hints (`requestSooner`) are dropped while the key runs, so a periodic
 *   timer or the key's own writes can never sustain an immediate-rerun chain.
 * - **Safety discovery.** A separate, slower pass lists authoritative storage,
 *   registers any obligation the index missed (a lost wakeup, another process,
 *   a crash between commit and wakeup) and drops keys storage no longer
 *   reports — but only when the enumeration was complete, and never a key
 *   noted or woken after that enumeration began.
 * - **Bounded admission.** At most `maxConcurrent` passes run at once and,
 *   when a {@link WorkAdmissionPool} is supplied, each pass also holds a
 *   `workflow-provider` slot for its target. Nested work inside a pass (a
 *   reviewer fan-out) receives the pass's lease so it can hand off within the
 *   same pool instead of queueing behind itself.
 * - **Critical jobs.** Lease renewal registers on the same scheduler's
 *   separate critical pool and is never queued behind best-effort passes.
 *
 * Nothing here is durable. The index is a projection of storage and can be
 * discarded at any time: {@link KeyedWorkflowSupervisor.start} and every
 * discovery pass rebuild it.
 */

/** Domains with a keyed driver, each individually revertible. */
export const KEYED_SCHEDULING_DOMAINS = [
  "feature-planning",
  "build-pipeline",
  "looped-review",
  "multi-review",
  "native-queues",
  "backend-activity",
] as const;
export type KeyedSchedulingDomain = (typeof KEYED_SCHEDULING_DOMAINS)[number];

/**
 * Rollback switch. A comma-separated list of domains (or `all`) that return to
 * their previous driver on the next backend start, e.g.
 * `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK=build-pipeline,looped-review`.
 * A domain runs exactly one driver: the switch is read once at construction,
 * so the new driver is never started when the old one is selected.
 */
export const KEYED_SCHEDULING_ROLLBACK_ENV = "ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK";

export function keyedSchedulingEnabled(
  domain: KeyedSchedulingDomain,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[KEYED_SCHEDULING_ROLLBACK_ENV];
  if (!raw) return true;
  const disabled = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return !(disabled.includes("all") || disabled.includes(domain));
}

/** Why a key was woken. Finite so it can be counted without content. */
export const WORKFLOW_WAKE_REASONS = [
  "start",
  "resume",
  "retry",
  "cancel",
  "enqueue",
  "provider-transition",
  "result-accepted",
  "environment-change",
  "storage-change",
  "explicit",
] as const;
export type WorkflowWakeReason = (typeof WORKFLOW_WAKE_REASONS)[number];

/**
 * Hints only pull a key's due time earlier and are dropped while it runs.
 * Every other reason is a real change that must be observed by a pass that
 * starts after it, so it invalidates (one trailing pass while running).
 */
const HINT_WAKE_REASONS: ReadonlySet<WorkflowWakeReason> = new Set([
  "provider-transition",
  "environment-change",
]);

/** Safety discovery once wakeups and recovery are proven (task 12). */
export const DEFAULT_WORKFLOW_DISCOVERY_MS = 30_000;

export interface WorkflowDiscoveryEntry<O extends string> {
  key: string;
  obligation: O;
  /** Admission target (an environment id); defaults to the key. Never reported. */
  target?: string;
}

export interface WorkflowDiscoveryResult<O extends string> {
  entries: WorkflowDiscoveryEntry<O>[];
  /** Records enumerated, for content-free cost accounting. */
  scanned: number;
  /**
   * False when any part of the enumeration failed. An incomplete discovery
   * adds what it found but never drops a key: absence from a failed read is
   * not evidence that work finished.
   */
  complete: boolean;
}

export interface WorkflowPass<O extends string> {
  key: string;
  /** `probe` when the key was woken before anything classified it. */
  obligation: O | "probe";
  /** `wake` for a pass started by a scoped wakeup, `periodic` for the fallback cadence. */
  trigger: "periodic" | "wake";
  signal: AbortSignal;
  /** Admission lease held for this pass; pass it as `holding` for nested acquisitions. */
  lease?: AdmissionLease;
  isCurrent(): boolean;
}

export interface KeyedWorkflowSupervisorOptions<O extends string> {
  domain: KeyedSchedulingDomain;
  /** Metrics kind for every pass and discovery (the previous tick's kind). */
  kind: RecurringJobKind;
  /** Fallback cadence for a key with an obligation (the previous tick interval). */
  progressIntervalMs: number;
  /** Safety discovery cadence. */
  discoveryIntervalMs: number;
  discover(signal: AbortSignal): Promise<WorkflowDiscoveryResult<O>>;
  /** Runs the domain's locked advance. The domain notes what it read and wrote. */
  advance(pass: WorkflowPass<O>): Promise<void>;
  /**
   * Delay before a key's next pass after one completes. `undefined` uses
   * `progressIntervalMs`; `null` drops the key until it is noted or woken.
   */
  nextDelayMs?(
    key: string,
    obligation: O,
  ): number | null | undefined | Promise<number | null | undefined>;
  /** Stable per-key initial spread for keys restored together. */
  initialSpreadMs?(key: string): number;
  admission?: WorkAdmissionPool | null;
  maxConcurrent?: number;
  maxKeys?: number;
  now?: () => number;
  timers?: RecurringTimerFactory;
  random?: () => number;
  metrics?: RecurringWorkMetrics;
  diagnostics?: RecurringDiagnosticsRegistry | null;
}

/** Options every keyed workflow service accepts. */
export interface KeyedWorkflowServiceOptions {
  /** Keyed driver (step 08). False selects the previous driver; never both. */
  keyedScheduling?: boolean;
  /** Safety discovery cadence for the keyed driver. */
  discoveryIntervalMs?: number;
  /** Shared `workflow-provider` admission across workflow keys. */
  workflowAdmission?: WorkAdmissionPool | null;
  /** Test seam: the keyed driver's monotonic clock and timers. */
  schedulerClock?: { now: () => number; timers: RecurringTimerFactory };
}

/** What `index.ts` needs from each keyed workflow owner. */
export interface KeyedWorkflowOwner {
  /** Scoped wakeup for every indexed key of one environment. */
  wakeEnvironment(environmentId: string, reason: WorkflowWakeReason): void;
  schedulingStatus(): WorkflowSupervisorStatus | null;
  /** Full diagnostic reconciliation; `null` when the keyed driver is not running. */
  reconcileScheduling(): Promise<WorkflowReconcileReport | null>;
}

export interface WorkflowCriticalJob {
  key: string;
  kind: RecurringJobKind;
  intervalMs: number;
  run(signal: AbortSignal): Promise<void>;
}

export interface WorkflowSupervisorStatus {
  domain: KeyedSchedulingDomain;
  started: boolean;
  keys: number;
  running: number;
  /** Scheduler runs in flight: key passes, discovery and critical jobs. */
  inFlight: number;
  byObligation: Record<string, number>;
  wakes: Partial<Record<WorkflowWakeReason, number>>;
  discoveries: number;
  failedDiscoveries: number;
  incompleteDiscoveries: number;
  /** Obligations discovery found that the index did not hold (missed wakeups). */
  recoveredByDiscovery: number;
  /** Keys discovery dropped because storage no longer reported them. */
  droppedByDiscovery: number;
  /** Keys the scheduler refused for capacity; discovery retries them. */
  refused: number;
}

export interface WorkflowReconcileReport {
  scanned: number;
  complete: boolean;
  keys: number;
  recovered: number;
  dropped: number;
}

type IndexEntry<O extends string> = {
  obligation: O | "probe" | null;
  target?: string;
  /** Monotonic index revision of the last note/wake for this key. */
  revision: number;
  /** Wakes received for this key; a wake mid-pass must be followed by a pass. */
  wakes: number;
  running: boolean;
};

const DISCOVERY_KEY = "\0discovery";
const KEY_PREFIX = "wf\0";

export class KeyedWorkflowSupervisor<O extends string> {
  readonly domain: KeyedSchedulingDomain;
  private readonly index = new Map<string, IndexEntry<O>>();
  private readonly criticalJobs: WorkflowCriticalJob[] = [];
  private readonly wakeCounts = new Map<WorkflowWakeReason, number>();
  private scheduler: RecurringScheduler | null = null;
  private revision = 0;
  private discovery: Promise<WorkflowReconcileReport> | null = null;
  private discoveries = 0;
  private failedDiscoveries = 0;
  private incompleteDiscoveries = 0;
  private recoveredByDiscovery = 0;
  private droppedByDiscovery = 0;
  private refused = 0;

  constructor(private readonly options: KeyedWorkflowSupervisorOptions<O>) {
    this.domain = options.domain;
  }

  get started(): boolean {
    return this.scheduler !== null;
  }

  /**
   * Starts scheduling. Synchronous and non-blocking: the first discovery runs
   * on the scheduler, so a caller's startup never waits on provider reads.
   * Subscribe wake sources before calling this; a wake that arrives before
   * the first discovery finishes is kept (as a probe) and never discarded.
   */
  start(): void {
    if (this.scheduler) return;
    const limits: Partial<RecurringSchedulerLimits> = {
      maxConcurrent: Math.max(1, this.options.maxConcurrent ?? 8),
      reservedConcurrency: 0,
      maxKeys: Math.max(8, (this.options.maxKeys ?? 1_024) + 8),
      reservedKeys: 8,
    };
    this.scheduler = new RecurringScheduler({
      owner: this.domain === "native-queues" ? "agent-observation" : "workflows",
      limits,
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.timers ? { timers: this.options.timers } : {}),
      ...(this.options.random ? { random: this.options.random } : {}),
      ...(this.options.metrics ? { metrics: this.options.metrics } : {}),
      ...(this.options.diagnostics !== undefined ? { diagnostics: this.options.diagnostics } : {}),
    });
    this.scheduler.register({
      key: DISCOVERY_KEY,
      kind: this.options.kind,
      priority: "discovery",
      intervalMs: this.options.discoveryIntervalMs,
      initialDelayMs: 0,
      deadline: "hard",
      run: (context) => this.runDiscovery(context),
      retryDelayMs: (failures) =>
        Math.min(this.options.discoveryIntervalMs, 1_000 * 2 ** Math.min(failures - 1, 6)),
    });
    for (const job of this.criticalJobs) this.registerCritical(job);
  }

  /**
   * Stops scheduling and fences running passes. Their domain work is not
   * awaited here: the owning service drains its own locks, which is where a
   * pass's durable writes are tracked.
   */
  stop(): void {
    const scheduler = this.scheduler;
    this.scheduler = null;
    this.index.clear();
    if (scheduler) void scheduler.dispose({ timeoutMs: 0 });
  }

  /**
   * Records the obligation a successful durable mutation or authoritative
   * read left for `key`. `null` means nothing is owed: the key is dropped
   * (after its running pass, if any). A no-op until started.
   */
  note(key: string, obligation: O | null, target?: string): void {
    if (!this.scheduler) return;
    const entry = this.index.get(key);
    this.revision += 1;
    if (obligation === null) {
      if (!entry) return;
      entry.obligation = null;
      entry.revision = this.revision;
      if (!entry.running) this.drop(key);
      return;
    }
    if (entry) {
      entry.obligation = obligation;
      entry.revision = this.revision;
      if (target !== undefined) entry.target = target;
      return;
    }
    const created: IndexEntry<O> = {
      obligation,
      ...(target !== undefined ? { target } : {}),
      revision: this.revision,
      wakes: 0,
      running: false,
    };
    this.index.set(key, created);
    // A durable change that leaves an obligation is progressed on the fallback
    // cadence; the caller wakes the key when it needs a pass sooner.
    this.schedule(key, created, this.options.progressIntervalMs);
  }

  /** Forgets a key whose record was deleted. */
  forget(key: string): void {
    this.note(key, null);
  }

  /**
   * Scoped wakeup for one key. An unknown key is scheduled as a `probe`: its
   * pass reads the record and the domain's note classifies it.
   */
  wake(key: string, reason: WorkflowWakeReason, target?: string): void {
    const scheduler = this.scheduler;
    if (!scheduler) return;
    this.wakeCounts.set(reason, (this.wakeCounts.get(reason) ?? 0) + 1);
    this.revision += 1;
    let entry = this.index.get(key);
    if (!entry) {
      entry = {
        obligation: "probe",
        ...(target !== undefined ? { target } : {}),
        revision: this.revision,
        wakes: 1,
        running: false,
      };
      this.index.set(key, entry);
      this.schedule(key, entry, 0);
      return;
    }
    entry.revision = this.revision;
    entry.wakes += 1;
    if (target !== undefined && entry.target === undefined) entry.target = target;
    if (entry.obligation === null) entry.obligation = "probe";
    if (HINT_WAKE_REASONS.has(reason)) scheduler.requestSooner(KEY_PREFIX + key);
    else scheduler.invalidate(KEY_PREFIX + key);
  }

  /**
   * Wakes every indexed key whose target matches, e.g. all workflows of an
   * environment after a provider transition. Unknown targets wake nothing:
   * the index, not storage, answers this, so the cost is bounded by the
   * active set.
   */
  wakeTarget(
    target: string,
    reason: WorkflowWakeReason,
    filter?: (obligation: O | "probe") => boolean,
  ): number {
    if (!this.scheduler) return 0;
    let woken = 0;
    for (const [key, entry] of Array.from(this.index)) {
      if (entry.target !== target || entry.obligation === null) continue;
      if (filter && !filter(entry.obligation)) continue;
      this.wake(key, reason);
      woken += 1;
    }
    return woken;
  }

  /**
   * Brings the next discovery forward after a change that may have created
   * an obligation the index cannot name (a mutation announced only by its
   * owner). Coalesced: at most one trailing discovery while one runs.
   */
  requestDiscovery(): void {
    this.scheduler?.invalidate(DISCOVERY_KEY);
  }

  /** Registers a critical job (lease renewal) on the scheduler's separate critical pool. */
  addCriticalJob(job: WorkflowCriticalJob): void {
    this.criticalJobs.push(job);
    if (this.scheduler) this.registerCritical(job);
  }

  /**
   * Full diagnostic reconciliation: an authoritative discovery now, joined
   * with one already in flight. Independent of the safety cadence.
   */
  async reconcileNow(): Promise<WorkflowReconcileReport> {
    if (!this.scheduler) {
      return { scanned: 0, complete: false, keys: 0, recovered: 0, dropped: 0 };
    }
    if (this.discovery) await this.discovery.catch(() => undefined);
    return this.discover(new AbortController().signal);
  }

  has(key: string): boolean {
    return this.index.has(key);
  }

  obligation(key: string): O | "probe" | null | undefined {
    return this.index.get(key)?.obligation;
  }

  status(): WorkflowSupervisorStatus {
    const byObligation: Record<string, number> = {};
    let running = 0;
    for (const entry of this.index.values()) {
      if (entry.running) running += 1;
      const name = entry.obligation ?? "settling";
      byObligation[name] = (byObligation[name] ?? 0) + 1;
    }
    const scheduler = this.scheduler?.status();
    return {
      domain: this.domain,
      started: this.scheduler !== null,
      keys: this.index.size,
      running,
      inFlight: scheduler ? scheduler.running + scheduler.runningCritical : 0,
      byObligation,
      wakes: Object.fromEntries(this.wakeCounts),
      discoveries: this.discoveries,
      failedDiscoveries: this.failedDiscoveries,
      incompleteDiscoveries: this.incompleteDiscoveries,
      recoveredByDiscovery: this.recoveredByDiscovery,
      droppedByDiscovery: this.droppedByDiscovery,
      refused: this.refused,
    };
  }

  private registerCritical(job: WorkflowCriticalJob): void {
    this.scheduler?.register({
      key: `\0critical\0${job.key}`,
      kind: job.kind,
      priority: "critical",
      deadline: "hard",
      intervalMs: job.intervalMs,
      initialDelayMs: job.intervalMs,
      run: async ({ signal }) => {
        await job.run(signal);
      },
    });
  }

  private schedule(key: string, entry: IndexEntry<O>, initialDelayMs: number): void {
    const scheduler = this.scheduler;
    if (!scheduler) return;
    const spread = this.options.initialSpreadMs?.(key) ?? 0;
    const result = scheduler.register({
      key: KEY_PREFIX + key,
      kind: this.options.kind,
      priority: "progress",
      intervalMs: this.options.progressIntervalMs,
      initialDelayMs: initialDelayMs + (initialDelayMs > 0 ? spread : 0),
      deadline: "hard",
      run: (context) => this.runKey(key, context),
      retryDelayMs: () => this.options.progressIntervalMs,
    });
    if (!result.ok) {
      // Capacity: the obligation stays in storage and discovery retries it.
      this.refused += 1;
      if (this.index.get(key) === entry) this.index.delete(key);
    }
  }

  private drop(key: string): void {
    this.index.delete(key);
    this.scheduler?.remove(KEY_PREFIX + key);
  }

  private async runKey(key: string, context: RecurringRunContext): Promise<RecurringRunResult> {
    const entry = this.index.get(key);
    if (!entry || entry.obligation === null) {
      if (entry) this.drop(key);
      else this.scheduler?.remove(KEY_PREFIX + key);
      return { outcome: "unchanged", nextDelayMs: null };
    }
    const obligation = entry.obligation;
    const startWakes = entry.wakes;
    // A probe is classified by the domain's note during the pass; one that is
    // still unclassified afterwards found nothing owed (missing or unreadable).
    if (obligation === "probe") entry.obligation = null;
    entry.running = true;
    context.span.work("record-selected");
    const pass = (lease?: AdmissionLease): Promise<void> =>
      this.options.advance({
        key,
        obligation,
        trigger: context.reason === "scheduled" ? "periodic" : "wake",
        signal: context.signal,
        ...(lease ? { lease } : {}),
        isCurrent: context.isCurrent,
      });
    try {
      const admission = this.options.admission;
      if (admission) {
        await admission.run(
          {
            kind: this.options.kind,
            priority: "progress",
            target: entry.target ?? key,
            signal: context.signal,
          },
          (lease) => pass(lease),
        );
      } else {
        await pass();
      }
    } catch (error) {
      entry.running = false;
      if (obligation === "probe" && entry.obligation === null) entry.obligation = "probe";
      if (error instanceof AdmissionRejectedError) {
        return {
          outcome: "failure",
          errorCategory: error.category,
          nextDelayMs: this.options.progressIntervalMs,
        };
      }
      // Domain faults are recorded by the domain; the key keeps its cadence.
      return { outcome: "failure", nextDelayMs: this.options.progressIntervalMs };
    }
    entry.running = false;
    if (this.index.get(key) !== entry) return { outcome: "success", nextDelayMs: null };
    const current = entry.obligation;
    if (current === null || current === "probe") {
      // A wake that arrived mid-pass must still get a pass that starts after it.
      if (entry.wakes > startWakes) {
        entry.obligation = "probe";
        return { outcome: "success", nextDelayMs: 0 };
      }
      this.drop(key);
      return { outcome: "success", nextDelayMs: null };
    }
    let delay: number | null | undefined;
    try {
      delay = await this.options.nextDelayMs?.(key, current);
    } catch {
      delay = undefined;
    }
    if (delay === null) {
      if (this.index.get(key) === entry && !entry.running) this.drop(key);
      return { outcome: "success", nextDelayMs: null };
    }
    return {
      outcome: "success",
      nextDelayMs:
        typeof delay === "number" && Number.isFinite(delay) && delay >= 0
          ? delay
          : this.options.progressIntervalMs,
    };
  }

  private async runDiscovery(context: RecurringRunContext): Promise<RecurringRunResult> {
    const report = await this.discover(context.signal);
    context.span.work("record-scanned", report.scanned);
    return { outcome: report.recovered > 0 || report.dropped > 0 ? "success" : "unchanged" };
  }

  private discover(signal: AbortSignal): Promise<WorkflowReconcileReport> {
    const operation = (async (): Promise<WorkflowReconcileReport> => {
      const startRevision = this.revision;
      this.discoveries += 1;
      let result: WorkflowDiscoveryResult<O>;
      try {
        result = await this.options.discover(signal);
      } catch (error) {
        this.failedDiscoveries += 1;
        throw error;
      }
      if (!this.scheduler) {
        return { scanned: result.scanned, complete: false, keys: 0, recovered: 0, dropped: 0 };
      }
      if (!result.complete) this.incompleteDiscoveries += 1;
      const found = new Set<string>();
      let recovered = 0;
      for (const discovered of result.entries) {
        found.add(discovered.key);
        const entry = this.index.get(discovered.key);
        if (!entry) {
          const created: IndexEntry<O> = {
            obligation: discovered.obligation,
            ...(discovered.target !== undefined ? { target: discovered.target } : {}),
            revision: startRevision,
            wakes: 0,
            running: false,
          };
          this.index.set(discovered.key, created);
          this.schedule(discovered.key, created, 0);
          recovered += 1;
          continue;
        }
        if (discovered.target !== undefined) entry.target = discovered.target;
        // A note or wake after this enumeration began is newer than it.
        if (!entry.running && entry.revision <= startRevision) {
          entry.obligation = discovered.obligation;
        }
      }
      let dropped = 0;
      if (result.complete) {
        for (const [key, entry] of Array.from(this.index)) {
          if (found.has(key) || entry.running || entry.revision > startRevision) continue;
          this.drop(key);
          dropped += 1;
        }
      }
      this.recoveredByDiscovery += recovered;
      this.droppedByDiscovery += dropped;
      return {
        scanned: result.scanned,
        complete: result.complete,
        keys: this.index.size,
        recovered,
        dropped,
      };
    })();
    const tracked = operation.finally(() => {
      if (this.discovery === tracked) this.discovery = null;
    });
    this.discovery = tracked;
    return tracked;
  }
}

/**
 * Stable per-key spread in `[0, spreadMs)`, so keys restored together after a
 * restart do not all poll their providers in the same instant. The key is
 * only hashed locally; it never leaves this function.
 */
export function stableSpreadMs(key: string, spreadMs: number): number {
  if (spreadMs <= 0) return 0;
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % Math.floor(spreadMs);
}
