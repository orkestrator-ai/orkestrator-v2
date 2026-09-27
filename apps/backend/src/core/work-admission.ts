import {
  isRecurringJobKind,
  recurringPriorityRank,
  type RecurringErrorCategory,
  type RecurringJobKind,
  type RecurringPriorityClass,
} from "@orkestrator/protocol/recurring-work";
import {
  recurringDiagnosticsRegistry,
  type RecurringDiagnosticsRegistry,
} from "./recurring-diagnostics.js";
import { recurringWorkMetrics, type RecurringWorkMetrics } from "./recurring-work-metrics.js";

/**
 * Bounded, fair admission for expensive physical work, per work class and per
 * target.
 *
 * A {@link RecurringScheduler} decides *when* a key is due; a pool decides
 * whether the physical operation behind it may start *now*, across every
 * owner that shares the resource. Git/Docker scans, external PR requests and
 * workflow/provider reads each get their own pool, so saturating one class
 * cannot delay another.
 *
 * ## Contract
 *
 * - **Bounded.** At most `maxConcurrent` leases are held, at most
 *   `maxPerTarget` per target (one by default, so one slow worktree or
 *   container cannot take every slot), and at most `maxWaiting` acquisitions
 *   queue. A full queue rejects with {@link AdmissionRejectedError}
 *   (`capacity`); the caller keeps its obligation and retries on its own
 *   schedule.
 * - **Fair priority.** The most urgent waiting class is granted first (user
 *   intent before quiet discovery), FIFO within a class. A waiter passed over
 *   `starvationLimit` times while eligible is granted next regardless of class.
 * - **Physical release.** A lease is released when the caller says the
 *   operation settled — {@link WorkAdmissionPool.run} does this when the work's
 *   promise settles. Aborting a *waiting* acquisition removes it from the
 *   queue; aborting after the grant does not release the slot, because a
 *   cancelled request is not evidence that a spawned process or remote call
 *   stopped.
 * - **No nested deadlock.** Pools have a fixed acquisition order
 *   ({@link ADMISSION_POOL_ORDER}): while holding a lease you may only acquire
 *   a pool later in the order. Passing a held lease of the *same* pool as
 *   `parent` hands its slot to the nested work instead of taking a second one,
 *   so nested work in a saturated pool proceeds rather than waiting on itself.
 *   Any other nesting is refused synchronously with {@link AdmissionOrderError}.
 * - **Critical work never waits here.** Lease renewal, approval/authentication
 *   expiry and watchdogs must not use these pools; `critical` acquisitions are
 *   refused so a best-effort queue can never delay them.
 *
 * ## Use
 *
 * ```ts
 * await gitDockerScans.run({ kind: "diff-scan", priority: "discovery", target: worktreeKey },
 *   () => scanWorktree(target));   // slot held until the scan's promise settles
 * ```
 */

export const ADMISSION_POOL_NAMES = [
  "workflow-provider",
  "external-pr",
  "git-docker-scan",
] as const;
export type AdmissionPoolName = (typeof ADMISSION_POOL_NAMES)[number];

/**
 * Acquisition order. A workflow pass may read a provider and then scan Git; a
 * PR detection may resolve its branch through Git; a Git/Docker scan never
 * needs a PR or provider slot. Acquire only in increasing order.
 */
export const ADMISSION_POOL_ORDER: Readonly<Record<AdmissionPoolName, number>> = {
  "workflow-provider": 0,
  "external-pr": 1,
  "git-docker-scan": 2,
};

export interface AdmissionPoolLimits {
  maxConcurrent: number;
  maxPerTarget: number;
  maxWaiting: number;
  starvationLimit: number;
}

/** Initial trial values from the plan index; tune from the baseline. */
export const DEFAULT_ADMISSION_POOL_LIMITS: Readonly<
  Record<AdmissionPoolName, AdmissionPoolLimits>
> = {
  "git-docker-scan": { maxConcurrent: 4, maxPerTarget: 1, maxWaiting: 256, starvationLimit: 8 },
  "external-pr": { maxConcurrent: 2, maxPerTarget: 1, maxWaiting: 256, starvationLimit: 8 },
  "workflow-provider": {
    maxConcurrent: 8,
    maxPerTarget: 2,
    maxWaiting: 512,
    starvationLimit: 8,
  },
};

export class AdmissionRejectedError extends Error {
  readonly category: RecurringErrorCategory;
  constructor(category: "capacity" | "cancelled" | "unavailable", message: string) {
    super(message);
    this.name = "AdmissionRejectedError";
    this.category = category;
  }
}

/** A nested acquisition that could deadlock or starve critical work. */
export class AdmissionOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdmissionOrderError";
  }
}

export interface AdmissionLease {
  readonly pool: AdmissionPoolName;
  readonly released: boolean;
  /** Idempotent. Call only once the physical operation has settled. */
  release(): void;
}

export interface AdmissionRequest {
  kind: RecurringJobKind;
  priority: Exclude<RecurringPriorityClass, "critical">;
  /** Internal target identity (a worktree, container, repository). Never reported. */
  target: string;
  /** Leases the caller already holds; enforces order and enables hand-off. */
  holding?: readonly AdmissionLease[];
  /** Aborts a *waiting* acquisition only. */
  signal?: AbortSignal;
}

export interface AdmissionPoolStatus {
  pool: AdmissionPoolName;
  closed: boolean;
  active: number;
  /** Distinct targets holding at least one lease. */
  activeTargets: number;
  waiting: number;
  waitingByPriority: Partial<Record<RecurringPriorityClass, number>>;
  oldestWaitMs: number | null;
  granted: number;
  handedOff: number;
  rejected: Partial<Record<"capacity" | "cancelled" | "unavailable" | "order", number>>;
  limits: AdmissionPoolLimits;
}

export interface WorkAdmissionPoolOptions {
  name: AdmissionPoolName;
  limits?: Partial<AdmissionPoolLimits>;
  now?: () => number;
  metrics?: RecurringWorkMetrics;
  diagnostics?: RecurringDiagnosticsRegistry | null;
}

type Waiter = {
  request: AdmissionRequest;
  rank: number;
  seq: number;
  enqueuedAt: number;
  bypassed: number;
  resolve: (lease: AdmissionLease) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
};

class PoolLease implements AdmissionLease {
  private releasedFlag = false;
  constructor(
    readonly pool: AdmissionPoolName,
    private readonly onRelease: () => void,
  ) {}

  get released(): boolean {
    return this.releasedFlag;
  }

  release(): void {
    if (this.releasedFlag) return;
    this.releasedFlag = true;
    this.onRelease();
  }
}

export class WorkAdmissionPool {
  readonly name: AdmissionPoolName;
  private readonly limits: AdmissionPoolLimits;
  private readonly now: () => number;
  private readonly metrics: RecurringWorkMetrics;
  private readonly activeByTarget = new Map<string, number>();
  private readonly waiters: Waiter[] = [];
  private readonly rejectedCounts = new Map<
    "capacity" | "cancelled" | "unavailable" | "order",
    number
  >();
  private active = 0;
  private seq = 0;
  private granted = 0;
  private handedOff = 0;
  private closed = false;
  private readonly unregisterDiagnostics: () => void;

  constructor(options: WorkAdmissionPoolOptions) {
    this.name = options.name;
    const defaults = DEFAULT_ADMISSION_POOL_LIMITS[options.name];
    const merged = { ...defaults, ...options.limits };
    const positive = (value: number, fallback: number) =>
      Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
    this.limits = {
      maxConcurrent: positive(merged.maxConcurrent, defaults.maxConcurrent),
      maxPerTarget: positive(merged.maxPerTarget, defaults.maxPerTarget),
      maxWaiting:
        Number.isFinite(merged.maxWaiting) && merged.maxWaiting >= 0
          ? Math.floor(merged.maxWaiting)
          : defaults.maxWaiting,
      starvationLimit: positive(merged.starvationLimit, defaults.starvationLimit),
    };
    this.now = options.now ?? (() => performance.now());
    this.metrics = options.metrics ?? recurringWorkMetrics;
    const diagnostics =
      options.diagnostics === undefined ? recurringDiagnosticsRegistry : options.diagnostics;
    this.unregisterDiagnostics = diagnostics?.addPool(this) ?? (() => undefined);
  }

  /**
   * Waits for a slot. Resolves with a lease the caller must release after the
   * physical operation settles; rejects with {@link AdmissionRejectedError}
   * when the queue is full, the wait was aborted or the pool closed, and with
   * {@link AdmissionOrderError} for a nesting that could deadlock.
   */
  acquire(request: AdmissionRequest): Promise<AdmissionLease> {
    const order = this.checkOrder(request);
    if (order === "hand-off") {
      this.handedOff += 1;
      // The parent's slot covers the nested work; releasing this lease is a no-op.
      return Promise.resolve(new PoolLease(this.name, () => undefined));
    }
    if (order instanceof Error) {
      this.count("order");
      return Promise.reject(order);
    }
    if (this.closed) return Promise.reject(this.refuse(request, "unavailable", "pool is closed"));
    if ((request.priority as RecurringPriorityClass) === "critical") {
      this.count("order");
      return Promise.reject(
        new AdmissionOrderError("critical work must not wait in a best-effort admission pool"),
      );
    }
    if (request.signal?.aborted) {
      return Promise.reject(this.refuse(request, "cancelled", "acquisition aborted"));
    }
    if (this.waiters.length === 0 && this.canGrant(request.target)) {
      if (isRecurringJobKind(request.kind)) this.metrics.queueDelay(request.kind, 0);
      return Promise.resolve(this.grant(request.target));
    }
    if (this.waiters.length >= this.limits.maxWaiting) {
      return Promise.reject(this.refuse(request, "capacity", "admission queue is full"));
    }
    return new Promise<AdmissionLease>((resolve, reject) => {
      const waiter: Waiter = {
        request,
        rank: recurringPriorityRank(request.priority),
        seq: this.seq++,
        enqueuedAt: this.now(),
        bypassed: 0,
        resolve,
        reject,
      };
      if (request.signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index === -1) return;
          this.waiters.splice(index, 1);
          reject(this.refuse(request, "cancelled", "acquisition aborted"));
          this.drain();
        };
        request.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      this.drain();
    });
  }

  /**
   * Acquires, runs `work`, and releases when `work`'s promise settles —
   * however long that takes after any cancellation. The work's own result or
   * rejection is returned unchanged.
   */
  async run<T>(
    request: AdmissionRequest,
    work: (lease: AdmissionLease) => Promise<T> | T,
  ): Promise<T> {
    const lease = await this.acquire(request);
    try {
      return await work(lease);
    } finally {
      lease.release();
    }
  }

  /** Rejects every waiter and refuses new acquisitions; held leases stay valid. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      this.detach(waiter);
      waiter.reject(this.refuse(waiter.request, "unavailable", "pool is closed"));
    }
    this.unregisterDiagnostics();
  }

  status(): AdmissionPoolStatus {
    const now = this.now();
    const waitingByPriority: AdmissionPoolStatus["waitingByPriority"] = {};
    let oldest = Infinity;
    for (const waiter of this.waiters) {
      waitingByPriority[waiter.request.priority] =
        (waitingByPriority[waiter.request.priority] ?? 0) + 1;
      oldest = Math.min(oldest, waiter.enqueuedAt);
    }
    return {
      pool: this.name,
      closed: this.closed,
      active: this.active,
      activeTargets: this.activeByTarget.size,
      waiting: this.waiters.length,
      waitingByPriority,
      oldestWaitMs: oldest === Infinity ? null : Math.max(0, Math.round(now - oldest)),
      granted: this.granted,
      handedOff: this.handedOff,
      rejected: Object.fromEntries(this.rejectedCounts),
      limits: { ...this.limits },
    };
  }

  private checkOrder(request: AdmissionRequest): "ok" | "hand-off" | AdmissionOrderError {
    const mine = ADMISSION_POOL_ORDER[this.name];
    for (const lease of request.holding ?? []) {
      if (lease.released) continue;
      if (lease.pool === this.name) return "hand-off";
      if (ADMISSION_POOL_ORDER[lease.pool] > mine) {
        return new AdmissionOrderError(
          `cannot acquire ${this.name} while holding ${lease.pool}; acquire pools in order`,
        );
      }
    }
    return "ok";
  }

  private canGrant(target: string): boolean {
    return (
      this.active < this.limits.maxConcurrent &&
      (this.activeByTarget.get(target) ?? 0) < this.limits.maxPerTarget
    );
  }

  private grant(target: string): AdmissionLease {
    this.active += 1;
    this.granted += 1;
    this.activeByTarget.set(target, (this.activeByTarget.get(target) ?? 0) + 1);
    return new PoolLease(this.name, () => {
      this.active = Math.max(0, this.active - 1);
      const remaining = (this.activeByTarget.get(target) ?? 1) - 1;
      if (remaining <= 0) this.activeByTarget.delete(target);
      else this.activeByTarget.set(target, remaining);
      this.drain();
    });
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.active < this.limits.maxConcurrent) {
      let chosen: Waiter | undefined;
      let starving: Waiter | undefined;
      const eligible: Waiter[] = [];
      for (const waiter of this.waiters) {
        if (!this.canGrant(waiter.request.target)) continue;
        eligible.push(waiter);
        if (waiter.bypassed >= this.limits.starvationLimit) {
          if (!starving || waiter.seq < starving.seq) starving = waiter;
        }
        if (
          !chosen ||
          waiter.rank < chosen.rank ||
          (waiter.rank === chosen.rank && waiter.seq < chosen.seq)
        ) {
          chosen = waiter;
        }
      }
      const next = starving ?? chosen;
      if (!next) return;
      for (const waiter of eligible) if (waiter !== next) waiter.bypassed += 1;
      this.waiters.splice(this.waiters.indexOf(next), 1);
      this.detach(next);
      if (isRecurringJobKind(next.request.kind)) {
        this.metrics.queueDelay(next.request.kind, this.now() - next.enqueuedAt);
      }
      next.resolve(this.grant(next.request.target));
    }
  }

  private detach(waiter: Waiter): void {
    if (waiter.onAbort) waiter.request.signal?.removeEventListener("abort", waiter.onAbort);
  }

  private refuse(
    request: AdmissionRequest,
    reason: "capacity" | "cancelled" | "unavailable",
    message: string,
  ): AdmissionRejectedError {
    this.count(reason);
    if (isRecurringJobKind(request.kind)) this.metrics.rejected(request.kind);
    return new AdmissionRejectedError(reason, `${this.name}: ${message}`);
  }

  private count(reason: "capacity" | "cancelled" | "unavailable" | "order"): void {
    this.rejectedCounts.set(reason, (this.rejectedCounts.get(reason) ?? 0) + 1);
  }
}
