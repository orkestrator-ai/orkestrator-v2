import { randomUUID } from "node:crypto";
import {
  PR_MONITOR_CHANGED_EVENT,
  PR_MONITOR_MODE_TIMEOUTS_MS,
  type PrMonitorEnvironmentState,
  type PrMonitorEvent,
  type PrMonitorMode,
  type PrMonitorRemovalEvent,
  type PrMonitorSnapshot,
  type PrMonitorStateEvent,
  type PrMonitorTransition,
  type PrCheckSummary,
  type PrState,
} from "@orkestrator/protocol/pr-monitor";
import { recurringPriorityRank } from "@orkestrator/protocol/recurring-work";
import { recurringWorkMetrics, type RecurringWorkMetrics } from "./recurring-work-metrics.js";
import {
  AdmissionRejectedError,
  WorkAdmissionPool,
  type AdmissionLease,
  type AdmissionRequest,
} from "./work-admission.js";
import {
  PrCooldownScopes,
  backgroundDelay,
  classifyPrDetectionFailure,
  detectionPriority,
  resolvePrMonitorPolicy,
  type PrDetectionFailure,
  type PrMonitorPolicyConfig,
  type PrMonitorWakeReason,
  type PrObservationPolicy,
} from "./pr-monitor-policy.js";

/**
 * Owns pull-request polling for every environment, for every connected client.
 *
 * Before this, each renderer ran its own polling loop and only ever watched the
 * environment the user was looking at: switch tabs and the previous
 * environment's merge went unnoticed until it was selected again, pending-mode
 * requests lived in a Zustand store that a reload erased, and closing the last
 * window stopped the work entirely. A pull request is a fact about a branch,
 * not about a window, so the loop lives here now.
 *
 * What is monitored: every environment with a stored PR, plus any environment a
 * client has requested a pending mode for (create-pending after "Create PR",
 * merge-pending after "Merge"). Environments with neither are not polled — the
 * agent-completion wake ({@link PrMonitorService.wakeForCompletion}) discovers agent-created PRs
 * without a standing timer per environment.
 *
 * The probe is driven by the backend's own agent-idle edges, not by a renderer.
 * Both supervision paths reach the `pr_monitor_probe_environment` command:
 * `OrkestratorBackend` from a native agent session's working/waiting → idle
 * transition, and `ClaudeStatePollManager` from a Claude tmux working →
 * waiting/idle transition. (The two differ on `waiting` on purpose: a bridge
 * reports it for a live turn parked on an approval, while the tmux Stop hook
 * writes it when the turn is over.)
 *
 * Both fire on the transition rather than on each ended-state reading: the
 * native sweep re-reads idle every two seconds and the tmux poll every second
 * per container, so a probe per reading would be a `gh` call per idle
 * environment per tick.
 *
 * ## Lifecycle policy (see `pr-monitor-policy.ts`)
 *
 * The public mode is user intent; the observation policy is derived from the
 * PR's lifecycle. Open PRs keep the 20 s / 5 s / 1 s cadences. A merged or
 * closed PR first settles its terminal obligations, then drops to branch
 * discovery every five minutes, so a reopened PR or a replacement PR on the
 * same branch is still found. An explicit refresh, a new pending intent and an
 * agent-completion edge ({@link PrMonitorService.wakeForCompletion}) reset the
 * due time of any entry.
 *
 * ## Terminal obligations
 *
 * | Obligation                         | Durable record                                   | Idempotency                         |
 * | ---------------------------------- | ------------------------------------------------ | ----------------------------------- |
 * | Environment PR fields              | environment `prUrl`/`prState` (`persistPr`)      | same value rewritten; retried by re-detection while `persistencePending` |
 * | Linked task → review (merged only) | task `status`                                    | only moves `in-progress`/unknown     |
 * | Linked task PR link                | task `prUrl`/`prState`, `prMergeCommented:false` | compared before writing             |
 * | Linked task terminal comment       | task comment text (URL-specific)                 | exact text check                    |
 * | Linked task completion flag        | task `prMergeCommented:true` for that URL/state  | durable marker                      |
 * | Merge-cleanup recovery             | environment `cleanupAfterMergeRequestedAt`/`…Error` | `resumeTerminalEffects`; owner dedupes per environment |
 * | Transition display (toast)         | none — best-effort (step 11)                     | clients dedupe per (env, url, state) |
 *
 * Every obligation is reconstructible from storage, so a restart loses only
 * the runtime "settled" marker, never the work: a restored terminal entry
 * repairs from its durable observation (no `gh` call) before it goes quiet.
 * Nothing persists a boolean claiming all effects completed.
 */

export interface PrMonitorTarget {
  environmentId: string;
  branch: string;
  kind: "local" | "container";
  worktreePath?: string;
  containerId?: string;
  /** Whether `gh` can run against this environment right now. */
  ready: boolean;
  prUrl: string | null;
  prState: PrState | null;
  hasMergeConflicts: boolean | null;
}

export interface PrDetection {
  url: string;
  state: PrState;
  /** Null means GitHub has not determined mergeability yet. */
  hasMergeConflicts: boolean | null;
  /** Null means no usable rollup was returned. See {@link checkSummaryStatus}. */
  checkSummary: PrCheckSummary | null;
  /** Distinguishes a throttled/irrelevant query from an attempted query failure. */
  checkSummaryStatus: "skipped" | "succeeded" | "failed";
}

export interface PrMonitorDetectionOptions {
  /** Whether this detection should also pay for the separate check-rollup query. */
  includeCheckSummary: boolean;
}

/** The slice of a kanban task the reconciliation side effects need. */
export interface PrMonitorKanbanTask {
  taskId: string;
  /** Null when the task was located via a build pipeline but not loaded. */
  status: string | null;
  prUrl: string | null;
  prState: PrState | null;
  prMergeCommented: boolean;
  hasCommentText: (text: string) => boolean;
}

/**
 * Side effects injected by the composition root, so the polling and transition
 * logic is testable without storage, docker, or `gh`.
 */
export interface PrMonitorEffects {
  /** Returns the PR for the branch, null when none exists, throws on failure. */
  detect: (
    target: PrMonitorTarget,
    options: PrMonitorDetectionOptions,
  ) => Promise<PrDetection | null>;
  persistPr: (environmentId: string, detection: PrDetection) => Promise<void>;
  clearPr: (environmentId: string) => Promise<void>;
  findTaskForEnvironment: (environmentId: string) => Promise<PrMonitorKanbanTask | null>;
  moveTaskToReview: (taskId: string) => Promise<void>;
  addTaskComment: (taskId: string, text: string) => Promise<void>;
  updateTaskPrMetadata: (
    taskId: string,
    updates: { prUrl?: string; prState?: PrState; prMergeCommented?: boolean },
  ) => Promise<void>;
  /**
   * Rereads the environment's durable PR fields. A local repair revalidates
   * its observation against this first, so a replacement or reopened PR never
   * receives an old terminal side effect. Optional: without it the repair
   * trusts the in-memory target, which reconciliation keeps in step with
   * storage.
   */
  readTarget?: (environmentId: string) => Promise<PrMonitorTarget | null>;
  /**
   * Idempotent environment-side follow-ups of a confirmed terminal state
   * (merge-cleanup recovery). Must be safe to call repeatedly; its owner
   * reads its own durable intent and de-duplicates.
   */
  resumeTerminalEffects?: (
    environmentId: string,
    observation: { url: string; state: "merged" | "closed" },
  ) => Promise<void> | void;
}

export interface PrMonitorServiceOptions {
  effects: PrMonitorEffects;
  emit: (event: string, payload: unknown) => void;
  now?: () => string;
  /** Milliseconds from an arbitrary origin; only differences are used. */
  monotonicNow?: () => number;
  /** One-shot timer; the service reschedules after every check. */
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
  onWarning?: (message: string, error: unknown) => void;
  /**
   * Owner generation stamped on every event and snapshot. Defaults to a fresh
   * random token per service instance, so a backend restart is observable as a
   * generation change rather than as a revision counter going backwards.
   */
  generation?: string;
  /** Content-free cost accounting; defaults to the process-wide recorder. */
  metrics?: RecurringWorkMetrics;
  /**
   * Aggregate bound on concurrent detections (`external-pr`: 2 concurrent, 1
   * per environment). Defaults to a private pool with those limits.
   */
  admission?: WorkAdmissionPool;
  /** Uniform sample in [0, 1) for jitter; injectable for deterministic tests. */
  random?: () => number;
  /** Internal policy overrides (trial values; not a user setting). */
  policy?: Partial<PrMonitorPolicyConfig>;
  /**
   * Names the host/auth scope a target's `gh` calls share, or null when no
   * compatible credential boundary can be proven. A rate-limit cooldown is
   * shared only within one scope. Never derive this from a token.
   */
  cooldownScope?: (target: PrMonitorTarget) => string | null;
}

export const PR_MERGED_COMMENT = "🎉 PR merged";
export const PR_CLOSED_COMMENT = "❌ PR closed";
export const PR_CHECK_SUMMARY_REFRESH_INTERVAL_MS = 60_000;

type ReconciliationStep = "status" | "link" | "comment" | "metadata";

interface PrMonitorEntry {
  target: PrMonitorTarget;
  mode: PrMonitorMode;
  /** Monotonic stamp; drives the pending-mode timeouts. */
  modeStartedAt: number;
  consecutiveErrors: number;
  lastCheckAt: string | null;
  checkInProgress: boolean;
  /** A check was requested while one was running; run once more when it ends. */
  recheckRequested: boolean;
  timer?: unknown;
  active: boolean;
  /**
   * Created by a probe rather than by a stored PR or a mode request. Dropped
   * silently after the check when no PR is found, so an agent going idle
   * without a PR does not accrete monitor entries.
   */
  provisional: boolean;
  /** A detected state could not be written yet, so polling must retry it. */
  persistencePending: boolean;
  /**
   * Changes whenever a check's target or lifecycle changes. Async work captures
   * this value so a result for an old branch/container, or a result that
   * completes after pause/removal, cannot mutate the current entry.
   */
  generation: number;
  /**
   * Kanban side-effect progress per (url, state, task), so a failure in a later
   * step retries that step without repeating comments or status moves.
   */
  reconciliation: Map<string, Set<ReconciliationStep>>;
  /** Latest successfully observed PR identity, including failed persist attempts. */
  observedPr: { url: string; state: PrState } | null;
  /** Latest check rollup; intentionally runtime state so every UI rehydrates from the monitor. */
  checkSummary: PrCheckSummary | null;
  /** Last completed rollup-query attempt; limits GitHub traffic independently of PR polling. */
  lastCheckSummaryAt: number | null;
  /** Last emitted state; suppresses byte-identical events. */
  lastEmitted?: PrMonitorEnvironmentState;
  /** ISO time of the last detection GitHub answered (distinct from `lastCheckAt`). */
  lastSuccessfulCheckAt: string | null;
  /**
   * What the in-progress action is doing. `waiting` means queued for an
   * admission slot and not yet asking GitHub, so a new wake is already served
   * by it; `detecting` and `repairing` mean a newer wake needs one more pass.
   */
  phase: "idle" | "waiting" | "detecting" | "repairing";
  /** Strongest wake requested since the last action started. */
  wake: PrMonitorWakeReason | null;
  /** The queued admission request, so pause/removal/upgrade can abort it. */
  admissionWait: {
    controller: AbortController;
    priority: AdmissionRequest["priority"];
    upgradeTo?: AdmissionRequest["priority"];
  } | null;
  /** Consecutive failed local repairs; independent of detection errors. */
  repairFailures: number;
  /**
   * `url\0state` of the terminal observation whose obligations were confirmed
   * settled by this process. Runtime-only on purpose: after a restart every
   * obligation is re-verified from storage before the entry goes quiet.
   */
  settledTerminal: string | null;
  /** Durable state disagreed with a repair's observation; detect before repairing again. */
  forceDetection: boolean;
  /** Monotonic time of the last detection attempt (creation time before the first). */
  lastDetectionAt: number;
  /** Monotonic end of this entry's own rate-limit cooldown. */
  cooldownUntil: number;
  /** Restored by reconciliation: stagger the next background schedule. */
  restoreJitter: boolean;
  /** Restored by reconciliation: spread the first terminal discovery over a period. */
  spreadFirstDiscovery: boolean;
}

export class PrMonitorService {
  /** Owner generation; see `packages/protocol/src/view-sync.ts`. */
  readonly generation: string;
  /**
   * Domain revision: incremented once per announced event, so clients can
   * order events against a snapshot and detect a missed announcement.
   */
  private revision = 0;
  private readonly entries = new Map<string, PrMonitorEntry>();
  /** One chained reconciliation per environment; deleted when it settles. */
  private readonly reconciliationOperations = new Map<string, Promise<boolean>>();
  private readonly options: Required<
    Pick<
      PrMonitorServiceOptions,
      "effects" | "emit" | "now" | "monotonicNow" | "schedule" | "cancel"
    >
  > & { onWarning?: PrMonitorServiceOptions["onWarning"] };
  private readonly metrics: RecurringWorkMetrics;
  private readonly admission: WorkAdmissionPool;
  private readonly random: () => number;
  private readonly policy: PrMonitorPolicyConfig;
  private readonly cooldownScope: (target: PrMonitorTarget) => string | null;
  private readonly cooldowns: PrCooldownScopes;

  constructor(options: PrMonitorServiceOptions) {
    this.metrics = options.metrics ?? recurringWorkMetrics;
    this.policy = resolvePrMonitorPolicy(options.policy);
    this.random = options.random ?? Math.random;
    this.cooldownScope = options.cooldownScope ?? (() => null);
    this.cooldowns = new PrCooldownScopes(this.policy.maxCooldownScopes);
    this.options = {
      effects: options.effects,
      emit: options.emit,
      now: options.now ?? (() => new Date().toISOString()),
      monotonicNow: options.monotonicNow ?? (() => Date.now()),
      schedule:
        options.schedule ??
        ((callback, delayMs) => {
          const timer = setTimeout(callback, delayMs);
          timer.unref?.();
          return timer;
        }),
      cancel: options.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)),
      onWarning: options.onWarning,
    };
    this.generation = options.generation ?? randomUUID();
    this.admission =
      options.admission ??
      new WorkAdmissionPool({
        name: "external-pr",
        now: this.options.monotonicNow,
        metrics: this.metrics,
        diagnostics: null,
      });
  }

  /**
   * Reconciles the monitored set against what storage says exists.
   *
   * Reconciling the whole set rather than patching it means every caller —
   * start, stop, delete, a client connecting — converges on the same answer,
   * and a missed lifecycle event self-corrects on the next call.
   */
  sync(targets: PrMonitorTarget[]): void {
    const live = new Set<string>();
    for (const target of targets) {
      live.add(target.environmentId);
      const entry = this.entries.get(target.environmentId);
      if (entry) {
        // Storage is authoritative for the persisted PR fields; the entry's
        // copy exists so a check can see what the previous reading was.
        const policyBefore = this.policyOf(entry);
        const targetChanged = this.replaceTarget(entry, target);
        if (targetChanged && entry.lastEmitted) this.emitState(entry);
        if (!target.ready && entry.active) this.pause(target.environmentId);
        else if (
          entry.active &&
          !entry.checkInProgress &&
          policyBefore === "terminal-discovery" &&
          this.policyOf(entry) !== "terminal-discovery"
        ) {
          // Storage moved a quiet terminal entry to another lifecycle (a
          // replacement PR stored by another path): leave the five-minute wait.
          this.scheduleNext(entry);
        } else if (target.ready && !entry.active) {
          entry.active = true;
          // Many containers become ready together after a backend or Docker
          // restart; resuming is reconciliation, not a user action.
          entry.restoreJitter = true;
          entry.spreadFirstDiscovery = true;
          this.scheduleNext(entry);
        }
        // An entry that has lost both its PR and its pending reason is retired
        // below via dropIfUnmonitorable, not here, so one code path decides.
        this.dropIfUnmonitorable(entry);
      } else if (target.prUrl && target.ready) {
        // Reconciliation is not a user action: the first check runs after one
        // normal interval rather than instantly, so converging the set (which
        // every snapshot request does) cannot burst a `gh` call per PR. The
        // first schedule is also jittered so a restart's whole set does not
        // fall due in the same instant.
        this.track(target, "normal", { immediate: false, restored: true });
      } else if (target.prUrl) {
        // Known PR on an environment that cannot be checked right now: hold the
        // last persisted reading, poll nothing.
        this.track(target, "normal", { immediate: false, paused: true, restored: true });
      }
    }
    for (const [environmentId, entry] of Array.from(this.entries)) {
      if (!live.has(environmentId)) this.remove(entry);
    }
  }

  /**
   * A client pressed "Create PR" or "Merge": poll faster until the outcome is
   * visible. Also the way an environment with no stored PR enters the set.
   */
  requestMode(target: PrMonitorTarget, mode: PrMonitorMode): void {
    const entry = this.entries.get(target.environmentId);
    if (!entry) {
      this.track(target, mode, { immediate: true, paused: !target.ready, wake: "interactive" });
      return;
    }
    const targetChanged = this.replaceTarget(entry, target);
    entry.provisional = false;
    if (entry.mode !== mode) {
      entry.mode = mode;
      entry.modeStartedAt = this.options.monotonicNow();
      this.emitState(entry);
    } else {
      entry.modeStartedAt = this.options.monotonicNow();
      if (targetChanged) this.emitState(entry);
    }
    if (target.ready && !entry.active) entry.active = true;
    // A new pending intent resets the due time of any lifecycle policy and is
    // never subject to background jitter or a quiet terminal cadence.
    if (entry.active) this.wakeEntry(entry, "interactive");
  }

  /**
   * Runs a check now for an environment already being monitored: an explicit
   * refresh (`interactive`, the default) or an armed agent-completion edge
   * (`completion`). Resets the due time whatever the lifecycle policy, so a
   * quiet terminal entry is re-read immediately rather than minutes later.
   */
  requestCheck(environmentId: string, reason: PrMonitorWakeReason = "interactive"): void {
    const entry = this.entries.get(environmentId);
    if (!entry || !entry.active) return;
    this.wakeEntry(entry, reason);
  }

  /**
   * Applies a terminal result that another backend operation already confirmed.
   *
   * Merge commands use this before deleting an environment, so linked-task
   * reconciliation is awaited and cannot be lost when deletion immediately
   * untracks the environment. Detection and PR persistence remain the caller's
   * responsibility.
   */
  async reconcileTerminal(target: PrMonitorTarget, detection: PrDetection): Promise<void> {
    if (detection.state !== "merged" && detection.state !== "closed") {
      throw new Error(`Expected terminal PR state, received: ${detection.state}`);
    }

    const reconciledTarget: PrMonitorTarget = {
      ...target,
      prUrl: detection.url,
      prState: detection.state,
      hasMergeConflicts: detection.hasMergeConflicts,
    };
    let entry = this.entries.get(target.environmentId);
    let restorePaused = false;
    if (entry) {
      const targetChanged = this.replaceTarget(entry, reconciledTarget);
      // A confirmed terminal result is no longer a speculative probe and is
      // meaningful to clients even when the entry began life unannounced.
      entry.provisional = false;
      if (targetChanged) this.emitState(entry);
      if (!entry.active) {
        entry.active = true;
        restorePaused = true;
      }
    } else {
      entry = this.track(reconciledTarget, "normal", {
        immediate: false,
        announce: false,
      });
    }

    const generation = entry.generation;
    try {
      await this.reconcileTask(entry, detection, generation);
    } finally {
      if (restorePaused && this.entries.get(target.environmentId) === entry && entry.active) {
        this.pause(target.environmentId);
      }
    }
  }

  /**
   * Agent-completion edge: the agent may have just pushed, opened, reopened or
   * replaced a PR. Monitored environments — including quiet terminal ones —
   * get an immediate check; unmonitored ones get a single provisional
   * detection that either promotes them into the set or leaves no trace.
   *
   * Callers must fire this on the working → idle *edge*, not on every idle
   * reading, so each completed turn costs at most one detection.
   */
  wakeForCompletion(target: PrMonitorTarget): void {
    const entry = this.entries.get(target.environmentId);
    if (entry) {
      const targetChanged = this.replaceTarget(entry, target);
      if (targetChanged && entry.lastEmitted) this.emitState(entry);
      if (entry.active) this.wakeEntry(entry, "completion");
      return;
    }
    if (!target.ready) return;
    this.track(target, "normal", {
      immediate: true,
      announce: false,
      provisional: true,
      wake: "completion",
    });
  }

  /** Alias of {@link wakeForCompletion}, kept for existing callers. */
  probe(target: PrMonitorTarget): void {
    this.wakeForCompletion(target);
  }

  /**
   * Stops polling while keeping the entry, e.g. for a stopped container. The
   * PR may still change on GitHub, but this environment cannot ask about it;
   * the persisted reading remains what clients see.
   */
  pause(environmentId: string): void {
    const entry = this.entries.get(environmentId);
    if (!entry || !entry.active) return;
    entry.generation += 1;
    entry.active = false;
    entry.recheckRequested = false;
    entry.wake = null;
    this.options.cancel(entry.timer);
    entry.timer = undefined;
    this.abortAdmissionWait(entry);
  }

  /** Stops monitoring entirely; used when an environment is deleted. */
  untrack(environmentId: string): void {
    const entry = this.entries.get(environmentId);
    if (entry) this.remove(entry);
  }

  /** Every environment the service holds state for, paused or not. */
  trackedIds(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Live monitoring state of every entry, including unannounced probes and
   * bookkeeping that has not been announced yet. A diagnostic/test view;
   * clients read {@link revisionedSnapshot}.
   */
  snapshot(): PrMonitorEnvironmentState[] {
    return [...this.entries.values()].map((entry) => this.describe(entry));
  }

  /**
   * Internal lifecycle observation policy of one entry (diagnostics/tests).
   * Deliberately not on the wire: clients see user intent (`mode`) and
   * freshness, not scheduling internals.
   */
  observationPolicy(environmentId: string): PrObservationPolicy | null {
    const entry = this.entries.get(environmentId);
    return entry ? this.policyOf(entry) : null;
  }

  /** Current owner generation and the revision of the last announced event. */
  currentRevision(): { generation: string; revision: number } {
    return { generation: this.generation, revision: this.revision };
  }

  /**
   * Authoritative client snapshot, captured synchronously with its revision.
   *
   * `entries` is exactly the fold of every announced event up to `revision`:
   * each announced entry's last emitted state, and nothing unannounced. An
   * unannounced probe can vanish silently, so including it would leave clients
   * holding an entry that no later event or `unchanged` answer would correct.
   */
  revisionedSnapshot(): Required<PrMonitorSnapshot> {
    const entries: PrMonitorEnvironmentState[] = [];
    for (const entry of this.entries.values()) {
      if (entry.lastEmitted) entries.push(entry.lastEmitted);
    }
    return { entries, generation: this.generation, revision: this.revision };
  }

  /** Releases every timer; used on backend shutdown. */
  shutdown(): void {
    let announcedEntries = false;
    for (const entry of this.entries.values()) {
      if (entry.lastEmitted) announcedEntries = true;
      entry.generation += 1;
      this.options.cancel(entry.timer);
      entry.timer = undefined;
      entry.active = false;
      this.abortAdmissionWait(entry);
    }
    this.entries.clear();
    this.cooldowns.clear();
    // The snapshot changed without per-entry removal events. Advancing the
    // revision keeps a conditional read from answering `unchanged` to a client
    // still holding the discarded entries; a live client sees a gap instead.
    if (announcedEntries) this.revision += 1;
  }

  private track(
    target: PrMonitorTarget,
    mode: PrMonitorMode,
    behaviour: {
      immediate: boolean;
      paused?: boolean;
      announce?: boolean;
      provisional?: boolean;
      restored?: boolean;
      wake?: PrMonitorWakeReason;
    },
  ): PrMonitorEntry {
    const now = this.options.monotonicNow();
    const entry: PrMonitorEntry = {
      target,
      mode,
      modeStartedAt: now,
      consecutiveErrors: 0,
      lastCheckAt: null,
      checkInProgress: false,
      recheckRequested: false,
      active: !behaviour.paused,
      provisional: behaviour.provisional === true,
      persistencePending: false,
      generation: 0,
      reconciliation: new Map(),
      observedPr:
        target.prUrl && target.prState ? { url: target.prUrl, state: target.prState } : null,
      checkSummary: null,
      lastCheckSummaryAt: null,
      lastSuccessfulCheckAt: null,
      phase: "idle",
      wake: behaviour.wake ?? null,
      admissionWait: null,
      repairFailures: 0,
      settledTerminal: null,
      forceDetection: false,
      lastDetectionAt: now,
      cooldownUntil: 0,
      restoreJitter: behaviour.restored === true,
      spreadFirstDiscovery: behaviour.restored === true,
    };
    this.entries.set(target.environmentId, entry);
    // Probes stay unannounced until they find something, so a probe that finds
    // nothing can vanish without clients ever hearing about it.
    if (behaviour.announce !== false) this.emitState(entry);
    if (entry.active) {
      this.scheduleNext(entry, behaviour.immediate ? 0 : undefined);
    }
    return entry;
  }

  private remove(entry: PrMonitorEntry): void {
    entry.generation += 1;
    this.options.cancel(entry.timer);
    entry.timer = undefined;
    entry.active = false;
    entry.wake = null;
    this.abortAdmissionWait(entry);
    this.entries.delete(entry.target.environmentId);
    // A provisional probe that found nothing was never announced; announcing
    // its removal would tell clients about an entry they never saw.
    if (entry.lastEmitted) {
      this.announce({ environmentId: entry.target.environmentId, removed: true });
    }
  }

  /**
   * Resets the entry's due time for a wake. A check still queued for
   * admission has not asked GitHub yet, so it already answers this wake; it
   * only needs its priority raised. A check that is running needs one more
   * pass afterwards, which `performCheck`'s coalescing arranges.
   */
  private wakeEntry(entry: PrMonitorEntry, reason: PrMonitorWakeReason): void {
    if (entry.phase === "waiting") {
      this.raiseWaitingPriority(entry, reason);
      return;
    }
    entry.wake = strongerWake(entry.wake, reason);
    this.scheduleNext(entry, 0);
  }

  private raiseWaitingPriority(entry: PrMonitorEntry, reason: PrMonitorWakeReason): void {
    const wait = entry.admissionWait;
    if (!wait) return;
    const wanted = detectionPriority(this.policyOf(entry), reason, entry.persistencePending);
    const current = wait.upgradeTo ?? wait.priority;
    if (recurringPriorityRank(wanted) >= recurringPriorityRank(current)) return;
    // The pool cannot reorder a waiter in place; withdraw and requeue it at
    // the higher priority (`admit` sees `upgradeTo` and re-acquires).
    wait.upgradeTo = wanted;
    wait.controller.abort();
  }

  private abortAdmissionWait(entry: PrMonitorEntry): void {
    const wait = entry.admissionWait;
    if (!wait) return;
    wait.upgradeTo = undefined;
    wait.controller.abort();
  }

  /**
   * Arms the entry's single timer. `delayMs` is an explicit due time (0 for a
   * wake); without it the lifecycle policy chooses the background delay.
   */
  private scheduleNext(entry: PrMonitorEntry, delayMs?: number): void {
    this.options.cancel(entry.timer);
    entry.timer = undefined;
    if (!entry.active || !entry.target.ready) return;
    const delay = delayMs ?? this.backgroundDelayFor(entry);
    entry.timer = this.options.schedule(() => {
      entry.timer = undefined;
      void this.performCheck(entry);
    }, delay);
  }

  private backgroundDelayFor(entry: PrMonitorEntry): number {
    const policy = this.policyOf(entry);
    const restored =
      policy === "terminal-discovery" ? entry.spreadFirstDiscovery : entry.restoreJitter;
    entry.restoreJitter = false;
    if (policy === "terminal-discovery") entry.spreadFirstDiscovery = false;
    let delay = backgroundDelay(
      {
        policy,
        mode: entry.mode,
        consecutiveErrors: entry.consecutiveErrors,
        repairFailures: entry.repairFailures,
        restored,
        random: this.sample(),
      },
      this.policy,
    );
    if (policy === "open" || policy === "provisional" || policy === "terminal-discovery") {
      // A background detection never runs inside a rate-limit cooldown.
      delay = Math.max(delay, this.cooldownRemaining(entry, this.options.monotonicNow()));
    }
    return delay;
  }

  /** Lifecycle observation policy; see `pr-monitor-policy.ts`. */
  private policyOf(entry: PrMonitorEntry): PrObservationPolicy {
    if (!entry.active) return "paused";
    if (entry.mode === "merge-pending") return "merge-pending";
    if (entry.mode === "create-pending") return "create-pending";
    if (entry.provisional) return "provisional";
    const { prUrl, prState } = entry.target;
    if (!prUrl || !isTerminalState(prState) || entry.persistencePending) return "open";
    return entry.settledTerminal === terminalKey(prUrl, prState) && !entry.forceDetection
      ? "terminal-discovery"
      : "terminal-repair";
  }

  /**
   * Whether the next action retries local terminal obligations without asking
   * GitHub again. Only for an observation this process already announced
   * (otherwise its transition would never be emitted), never for a wake, and
   * never so long that a failing repair starves replacement/reopen discovery.
   */
  private shouldRepair(entry: PrMonitorEntry, wake: PrMonitorWakeReason | null): boolean {
    if (wake) return false;
    if (this.policyOf(entry) !== "terminal-repair" || entry.forceDetection) return false;
    const { prUrl, prState } = entry.target;
    if (!prUrl || !isTerminalState(prState)) return false;
    if (entry.observedPr?.url !== prUrl || entry.observedPr.state !== prState) return false;
    return (
      this.options.monotonicNow() - entry.lastDetectionAt < this.policy.terminalDiscoveryIntervalMs
    );
  }

  private cooldownRemaining(entry: PrMonitorEntry, now: number): number {
    return Math.max(
      entry.cooldownUntil - now,
      this.cooldowns.remaining(this.cooldownScopeOf(entry.target), now),
      0,
    );
  }

  private cooldownScopeOf(target: PrMonitorTarget): string | null {
    try {
      return this.cooldownScope(target);
    } catch {
      return null;
    }
  }

  private sample(): number {
    try {
      const value = this.random();
      return Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999_999) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Reverts an expired pending mode. Returns false when the entry was retired
   * (create-pending expired with no PR: there is nothing left to watch).
   */
  private expireModeIfDue(entry: PrMonitorEntry): boolean {
    const timeout = PR_MONITOR_MODE_TIMEOUTS_MS[entry.mode];
    if (!timeout) return true;
    if (this.options.monotonicNow() - entry.modeStartedAt <= timeout) return true;
    if (entry.mode === "create-pending" && !entry.target.prUrl) {
      this.remove(entry);
      return false;
    }
    entry.mode = "normal";
    entry.modeStartedAt = this.options.monotonicNow();
    this.emitState(entry);
    return true;
  }

  private async performCheck(entry: PrMonitorEntry): Promise<void> {
    if (!entry.active || !entry.target.ready) return;
    if (entry.checkInProgress) {
      if (entry.phase === "waiting") {
        // Still queued: the pending check has not asked GitHub, so it already
        // answers this request. One pending check per environment.
        this.metrics.requested("pr-detection");
        this.metrics.coalesced("pr-detection");
        const wake = entry.wake;
        entry.wake = null;
        if (wake) this.raiseWaitingPriority(entry, wake);
      } else if (entry.phase === "detecting") {
        this.metrics.requested("pr-detection");
        this.metrics.coalesced("pr-detection");
        entry.recheckRequested = true;
      } else {
        entry.recheckRequested = true;
      }
      return;
    }
    if (!this.expireModeIfDue(entry)) return;

    const wake = entry.wake;
    entry.wake = null;
    if (this.shouldRepair(entry, wake)) {
      await this.performRepair(entry);
      return;
    }
    const policy = this.policyOf(entry);
    if (wake !== "interactive" && policy !== "merge-pending" && policy !== "create-pending") {
      const remaining = this.cooldownRemaining(entry, this.options.monotonicNow());
      if (remaining > 0) {
        // Rate-limited scope: background and completion checks wait it out
        // instead of spending another request that would be refused. A later
        // interactive wake still resets the due time.
        entry.wake = wake;
        this.scheduleNext(entry, remaining);
        return;
      }
    }
    await this.performDetection(entry, wake, policy);
  }

  private async performDetection(
    entry: PrMonitorEntry,
    wake: PrMonitorWakeReason | null,
    policy: PrObservationPolicy,
  ): Promise<void> {
    this.metrics.requested("pr-detection");
    entry.checkInProgress = true;
    entry.phase = "waiting";
    entry.forceDetection = false;
    const lease = await this.admit(
      entry,
      detectionPriority(policy, wake, entry.persistencePending),
    );
    if (!lease) {
      entry.checkInProgress = false;
      entry.phase = "idle";
      if (this.entries.get(entry.target.environmentId) === entry && entry.active) {
        if (entry.lastEmitted?.checkInProgress) this.emitState(entry);
        // A refused admission is back-pressure, not a failed detection: keep
        // the obligation and the wake, retry on the ordinary schedule.
        entry.wake = strongerWake(entry.wake, wake);
        if (!entry.timer) this.scheduleNext(entry);
      }
      return;
    }

    entry.phase = "detecting";
    // Captured after admission: a branch rename, target change or explicit
    // terminal reconciliation while queued is simply included in this check.
    const generation = entry.generation;
    const detectionTarget = entry.target;
    let transition: PrMonitorTransition | undefined;
    try {
      let detection: PrDetection | null = null;
      let failure: PrDetectionFailure | null = null;
      const startedAt = this.options.monotonicNow();
      try {
        const includeCheckSummary =
          entry.mode !== "merge-pending" &&
          (entry.lastCheckSummaryAt === null ||
            startedAt - entry.lastCheckSummaryAt >= PR_CHECK_SUMMARY_REFRESH_INTERVAL_MS);
        detection = await this.metrics.observe("pr-detection", () =>
          this.options.effects.detect(detectionTarget, { includeCheckSummary }),
        );
        if (includeCheckSummary && detection?.checkSummaryStatus !== "skipped") {
          entry.lastCheckSummaryAt = startedAt;
        }
      } catch (error) {
        failure = classifyPrDetectionFailure(error);
        this.warn(`PR detection failed for ${entry.target.environmentId}`, error);
      } finally {
        // The slot covers the physical `gh`/`docker exec` call only; local
        // persistence and task effects must not hold back other detections.
        lease.release();
      }

      // Deleted (and possibly re-tracked as a different entry) while the
      // detection ran; a stale result must not resurrect removed state.
      if (!this.isCurrent(entry, generation)) return;

      if (failure) {
        entry.consecutiveErrors += 1;
        if (failure.kind === "rate-limited") this.startCooldown(entry, detectionTarget, failure);
      } else {
        entry.consecutiveErrors = 0;
        entry.lastSuccessfulCheckAt = this.options.now();
        if (detection) transition = await this.applyDetection(entry, detection, generation);
        else await this.applyNotFound(entry, generation);
        this.metrics.outcome("pr-detection", transition ? "changed" : "unchanged");
      }
    } finally {
      entry.checkInProgress = false;
      entry.phase = "idle";
      if (entry.generation === generation) {
        entry.lastCheckAt = this.options.now();
        entry.lastDetectionAt = this.options.monotonicNow();
      }
      if (this.entries.get(entry.target.environmentId) === entry) {
        if (entry.generation !== generation) {
          // A superseded check still has to lower a "detecting" state announced
          // mid-check (mode request, target change); otherwise a paused entry
          // would keep a spinner that nothing ever clears.
          if (entry.lastEmitted?.checkInProgress) this.emitState(entry);
          if (entry.active && (entry.recheckRequested || entry.wake)) {
            entry.recheckRequested = false;
            this.scheduleNext(entry, 0);
          }
        } else {
          const silentProbe =
            entry.provisional &&
            !entry.lastEmitted &&
            !transition &&
            !entry.target.prUrl &&
            entry.mode === "normal";
          if (silentProbe) {
            // A probe that found nothing vanishes without clients ever hearing
            // about it; announcing it would flash a monitor entry per idle agent.
            this.remove(entry);
          } else {
            // One emission per completed check, after `checkInProgress` has been
            // lowered: emitting mid-check would strand clients on a "detecting"
            // state that nothing follows up on.
            this.emitState(entry, transition);
            if (this.dropIfUnmonitorable(entry)) {
              // retired: no reschedule
            } else if (entry.recheckRequested || entry.wake) {
              entry.recheckRequested = false;
              this.scheduleNext(entry, 0);
            } else {
              this.scheduleNext(entry);
            }
          }
        }
      }
    }
  }

  /**
   * Waits for an `external-pr` admission slot. Returns null when the wait was
   * refused or withdrawn (pause, removal, shutdown, full queue); re-queues at
   * a higher priority when a stronger wake arrived while waiting.
   */
  private async admit(
    entry: PrMonitorEntry,
    priority: AdmissionRequest["priority"],
  ): Promise<AdmissionLease | null> {
    let wanted = priority;
    while (true) {
      const controller = new AbortController();
      const wait: NonNullable<PrMonitorEntry["admissionWait"]> = { controller, priority: wanted };
      entry.admissionWait = wait;
      try {
        return await this.admission.acquire({
          kind: "pr-detection",
          priority: wanted,
          target: entry.target.environmentId,
          signal: controller.signal,
        });
      } catch (error) {
        const current = this.entries.get(entry.target.environmentId) === entry && entry.active;
        if (current && wait.upgradeTo && error instanceof AdmissionRejectedError) {
          wanted = wait.upgradeTo;
          continue;
        }
        if (!(error instanceof AdmissionRejectedError)) {
          this.warn(`PR detection admission failed for ${entry.target.environmentId}`, error);
        }
        return null;
      } finally {
        if (entry.admissionWait === wait) entry.admissionWait = null;
      }
    }
  }

  private startCooldown(
    entry: PrMonitorEntry,
    target: PrMonitorTarget,
    failure: Extract<PrDetectionFailure, { kind: "rate-limited" }>,
  ): void {
    const now = this.options.monotonicNow();
    const cooldown = Math.min(
      failure.retryAfterMs ?? this.policy.rateLimitCooldownMs,
      this.policy.maxRetryAfterMs,
    );
    entry.cooldownUntil = Math.max(entry.cooldownUntil, now + cooldown);
    const scope = this.cooldownScopeOf(target);
    if (scope) this.cooldowns.set(scope, now + cooldown, now);
  }

  /**
   * Retries the local terminal obligations of an already confirmed and
   * announced observation without another `gh` call. Revalidates against the
   * durable environment first, so a replacement or reopened PR can never
   * receive the old observation's side effects.
   */
  private async performRepair(entry: PrMonitorEntry): Promise<void> {
    const environmentId = entry.target.environmentId;
    const url = entry.target.prUrl!;
    const state = entry.target.prState as "merged" | "closed";
    const generation = entry.generation;
    entry.checkInProgress = true;
    entry.phase = "repairing";
    let settled = false;
    let diverged = false;
    try {
      if (this.options.effects.readTarget) {
        const durable = await this.options.effects.readTarget(environmentId);
        if (!this.isCurrent(entry, generation)) return;
        if (!durable || durable.prUrl !== url || durable.prState !== state) {
          diverged = true;
          return;
        }
      }
      const observation: PrDetection = {
        url,
        state,
        hasMergeConflicts: entry.target.hasMergeConflicts,
        checkSummary: null,
        checkSummaryStatus: "skipped",
      };
      const complete = await this.reconcileTask(entry, observation, generation);
      if (!this.isCurrent(entry, generation) || !complete) return;
      settled = await this.resumeTerminalEffects(entry, url, state, generation);
    } catch (error) {
      this.warn(`Failed to repair terminal PR effects for ${environmentId}`, error);
    } finally {
      entry.checkInProgress = false;
      entry.phase = "idle";
      if (this.entries.get(environmentId) === entry) {
        if (entry.generation === generation) {
          if (diverged) {
            // Storage moved on (reconciliation will deliver the new target);
            // establish the current state by detection, not by old effects.
            entry.forceDetection = true;
          } else if (settled) {
            entry.settledTerminal = terminalKey(url, state);
            entry.repairFailures = 0;
          } else {
            entry.repairFailures += 1;
          }
        }
        if (entry.lastEmitted?.checkInProgress) this.emitState(entry);
        if (entry.active) {
          if (entry.recheckRequested || entry.wake) {
            entry.recheckRequested = false;
            this.scheduleNext(entry, 0);
          } else if (entry.generation === generation) {
            this.scheduleNext(entry);
          }
        }
      }
    }
  }

  /** Requests environment-side terminal follow-ups; true once requested. */
  private async resumeTerminalEffects(
    entry: PrMonitorEntry,
    url: string,
    state: "merged" | "closed",
    generation: number,
  ): Promise<boolean> {
    const resume = this.options.effects.resumeTerminalEffects;
    if (!resume) return true;
    try {
      await resume(entry.target.environmentId, { url, state });
      return this.isCurrent(entry, generation);
    } catch (error) {
      this.warn(`Failed to resume terminal PR effects for ${entry.target.environmentId}`, error);
      return false;
    }
  }

  /**
   * Retires an entry that no longer has a reason to exist: no stored PR and no
   * pending mode. Probes that found nothing vanish silently; a tracked PR that
   * was deleted upstream is announced as removed.
   */
  private dropIfUnmonitorable(entry: PrMonitorEntry): boolean {
    if (entry.checkInProgress) return false;
    if (entry.persistencePending) return false;
    if (entry.target.prUrl || entry.mode !== "normal") return false;
    this.remove(entry);
    return true;
  }

  /** Returns the transition to announce with this check's emission, if any. */
  private async applyDetection(
    entry: PrMonitorEntry,
    detection: PrDetection,
    generation: number,
  ): Promise<PrMonitorTransition | undefined> {
    const previous = entry.target;
    const previousState = previous.prState;
    if (
      previous.prUrl === detection.url &&
      previousState === "merged" &&
      detection.state !== "merged"
    ) {
      // A merged pull request can never be reopened or closed again, so this is
      // a stale read (GitHub's eventual consistency, or a lookup that raced an
      // explicit merge confirmation). Never let it overwrite the terminal state
      // or re-arm side effects. Replacement PRs have a different URL.
      this.warn(
        `Ignored a stale non-merged reading for a merged PR on ${entry.target.environmentId}`,
        new Error(detection.state),
      );
      return undefined;
    }
    if (entry.settledTerminal !== terminalKey(detection.url, detection.state)) {
      entry.settledTerminal = null;
    }
    const changed =
      detection.url !== previous.prUrl ||
      detection.state !== previous.prState ||
      detection.hasMergeConflicts !== previous.hasMergeConflicts;

    const observedChanged =
      detection.url !== entry.observedPr?.url || detection.state !== entry.observedPr?.state;
    const transition: PrMonitorTransition | undefined = observedChanged
      ? {
          // A confirmed transition is announced even if persisting it fails: the
          // stale stored state would otherwise make every retry look like the same
          // new transition and re-notify on each one.
          url: detection.url,
          state: detection.state,
          previousState: entry.observedPr?.state ?? previousState,
        }
      : undefined;

    let persisted = !changed;
    if (changed) {
      try {
        await this.options.effects.persistPr(entry.target.environmentId, detection);
        if (!this.isCurrent(entry, generation)) return undefined;
        entry.target = {
          ...entry.target,
          prUrl: detection.url,
          prState: detection.state,
          hasMergeConflicts: detection.hasMergeConflicts,
        };
        persisted = true;
        entry.persistencePending = false;
      } catch (error) {
        entry.persistencePending = true;
        entry.consecutiveErrors += 1;
        this.warn(`Failed to persist PR state for ${entry.target.environmentId}`, error);
      }
    }
    // A newly discovered PR is not materialized until its authoritative
    // environment record has been updated. Keeping the entry provisional (or
    // create-pending) makes the next scheduled check retry persistence instead
    // of retiring the only monitor that knows a PR was found.
    if (persisted) {
      entry.persistencePending = false;
      entry.provisional = false;
    }

    if (!this.isCurrent(entry, generation)) return undefined;
    if (detection.state === "merged" || detection.state === "closed") {
      const alreadySettled = entry.settledTerminal === terminalKey(detection.url, detection.state);
      // Rereads the durable task every time (cheap, idempotent), so an edit
      // made elsewhere is still repaired on a quiet discovery.
      const complete = await this.reconcileTask(entry, detection, generation);
      if (!this.isCurrent(entry, generation)) return undefined;
      if (persisted && complete && !alreadySettled) {
        const requested = await this.resumeTerminalEffects(
          entry,
          detection.url,
          detection.state,
          generation,
        );
        if (!this.isCurrent(entry, generation)) return undefined;
        if (requested) {
          entry.settledTerminal = terminalKey(detection.url, detection.state);
          entry.repairFailures = 0;
        }
      } else if (!complete) {
        entry.settledTerminal = null;
      }
    }

    if (!this.isCurrent(entry, generation)) return undefined;
    let taskLinkStored = true;
    if (persisted && detection.state === "open") {
      // A PR can be reopened and later reach the same terminal state again.
      // The earlier terminal reconciliation is no longer authoritative once
      // open is observed, so do not suppress the later real transition.
      for (const key of entry.reconciliation.keys()) {
        if (key.split("\0")[1] === detection.url) entry.reconciliation.delete(key);
      }
      // This is intentionally checked even in normal mode. After a backend
      // restart the environment may already contain a replacement PR while the
      // linked task still carries terminal metadata for its predecessor.
      taskLinkStored = await this.storePrOnTask(entry, detection, generation);
    }
    if (!this.isCurrent(entry, generation)) return undefined;
    if (persisted && entry.mode === "create-pending") {
      if (detection.state !== "open" || taskLinkStored) {
        entry.mode = "normal";
        entry.modeStartedAt = this.options.monotonicNow();
      }
    } else if (
      persisted &&
      entry.mode === "merge-pending" &&
      (detection.state === "merged" || detection.state === "closed")
    ) {
      entry.mode = "normal";
      entry.modeStartedAt = this.options.monotonicNow();
    }

    // Commit the observed identity only after every asynchronous side effect
    // has returned and the generation is still current. Otherwise a pause or
    // target replacement during reconciliation would suppress this transition
    // without emitting it, and the resumed check would think it was old news.
    // Failed persistence for a still-current target does count as observed so
    // retries do not notify repeatedly while storage is unavailable.
    if (observedChanged) {
      entry.observedPr = { url: detection.url, state: detection.state };
      // A live transition is not a restart restoration: its first quiet
      // discovery keeps the ordinary period rather than the restore spread.
      entry.spreadFirstDiscovery = false;
    }
    // Preserve the last good reading only when this cycle intentionally skipped
    // the separately throttled query. A failed attempted refresh clears the
    // badge rather than presenting obsolete counts as current. A successful
    // empty rollup also clears it, as do terminal and replacement PRs.
    if (detection.url !== previous.prUrl || detection.state !== "open") {
      entry.checkSummary = null;
    }
    if (detection.checkSummaryStatus === "failed") {
      entry.checkSummary = null;
    } else if (detection.checkSummaryStatus === "succeeded") {
      entry.checkSummary =
        detection.checkSummary && detection.checkSummary.total > 0 ? detection.checkSummary : null;
    }
    return transition;
  }

  private async applyNotFound(entry: PrMonitorEntry, generation: number): Promise<void> {
    const { prUrl, prState } = entry.target;
    if (!prUrl) {
      // A PR found on the previous check but never durably stored may disappear
      // before the retry. There is then no state left to persist and no reason
      // to retain a provisional background poller forever.
      entry.persistencePending = false;
      entry.observedPr = null;
      entry.checkSummary = null;
      return;
    }
    // After a merge with --delete-branch the environment checks out the base
    // branch and `gh pr list --head` stops finding the PR. The merged/closed
    // reading saved when the merge landed is the truth; do not clear it.
    if (prState === "merged" || prState === "closed") return;
    try {
      await this.options.effects.clearPr(entry.target.environmentId);
      if (!this.isCurrent(entry, generation)) return;
      entry.target = { ...entry.target, prUrl: null, prState: null, hasMergeConflicts: null };
      entry.persistencePending = false;
      entry.observedPr = null;
      entry.checkSummary = null;
    } catch (error) {
      entry.persistencePending = true;
      entry.consecutiveErrors += 1;
      this.warn(`Failed to clear PR state for ${entry.target.environmentId}`, error);
    }
  }

  /**
   * Moves the linked kanban task to review, posts the merged/closed comment,
   * and records the `prMergeCommented` idempotency flag.
   *
   * Progress is tracked per (environment, url, state, task) so a failure in a
   * later step retries only that step on the next detection, and the persisted
   * flag plus the comment-text check keep a backend restart — which loses the
   * in-memory progress — from posting the comment twice.
   */
  private async reconcileTask(
    entry: PrMonitorEntry,
    detection: PrDetection,
    generation: number,
  ): Promise<boolean> {
    const environmentId = entry.target.environmentId;
    const previous = this.reconciliationOperations.get(environmentId);
    const operation = previous
      ? previous
          .catch(() => false)
          .then(() => this.reconcileTaskUnlocked(entry, detection, generation))
      : this.reconcileTaskUnlocked(entry, detection, generation);
    this.reconciliationOperations.set(environmentId, operation);
    try {
      return await operation;
    } finally {
      if (this.reconciliationOperations.get(environmentId) === operation) {
        this.reconciliationOperations.delete(environmentId);
      }
    }
  }

  private async reconcileTaskUnlocked(
    entry: PrMonitorEntry,
    detection: PrDetection,
    generation: number,
  ): Promise<boolean> {
    const terminalState = detection.state as "merged" | "closed";
    const environmentId = entry.target.environmentId;
    try {
      const task = await this.options.effects.findTaskForEnvironment(environmentId);
      if (!this.isCurrent(entry, generation)) return false;
      if (!task) return true;

      const key = [environmentId, detection.url, terminalState, task.taskId].join("\0");
      const progress = entry.reconciliation.get(key) ?? new Set<ReconciliationStep>();
      // Re-inserted so the map's order is least recently used first, then
      // bounded: only the latest few (url, state, task) progress records can
      // still matter, and each is reconstructible from the durable task.
      entry.reconciliation.delete(key);
      entry.reconciliation.set(key, progress);
      while (entry.reconciliation.size > this.policy.maxReconciliationKeys) {
        const oldest = entry.reconciliation.keys().next().value;
        if (oldest === undefined || oldest === key) break;
        entry.reconciliation.delete(oldest);
      }
      const commentPrefix = terminalState === "merged" ? PR_MERGED_COMMENT : PR_CLOSED_COMMENT;
      // The URL is part of the durable idempotency marker. A generic comment
      // cannot distinguish a replacement PR from its predecessor if the
      // process dies after pre-linking the replacement but before appending.
      const commentText = `${commentPrefix}: ${detection.url}`;

      const taskMetadataMatchesDetection =
        task.prUrl === detection.url && task.prState === terminalState;
      if (task.prMergeCommented && taskMetadataMatchesDetection) {
        progress.add("link");
        progress.add("comment");
        progress.add("metadata");
      } else if (taskMetadataMatchesDetection && task.hasCommentText(commentText)) {
        // A previous attempt (possibly by an earlier backend process) added the
        // comment but died before setting the idempotency flag. Only the same
        // PR and terminal state qualify: a replacement PR on the same task must
        // receive its own reconciliation.
        progress.add("link");
        progress.add("comment");
      } else if (taskMetadataMatchesDetection) {
        progress.add("link");
      }

      if (terminalState === "merged" && !progress.has("status")) {
        // Only advance in-progress tasks; a task already in review or done must
        // not regress. A pipeline-located task (status unknown) is moved, which
        // matches the renderer behaviour this replaced.
        if (task.status === "in-progress" || task.status === null) {
          await this.options.effects.moveTaskToReview(task.taskId);
          if (!this.isCurrent(entry, generation)) return false;
        }
        progress.add("status");
      }

      if (!progress.has("link")) {
        // Persist the PR identity before appending its generic terminal comment.
        // If this process is invalidated after the append, a fresh monitor can
        // then prove which PR the existing comment belongs to and finish the
        // idempotency flag without posting it again.
        await this.options.effects.updateTaskPrMetadata(task.taskId, {
          prUrl: detection.url,
          prState: terminalState,
          prMergeCommented: false,
        });
        if (!this.isCurrent(entry, generation)) return false;
        progress.add("link");
      }

      if (!progress.has("comment")) {
        await this.options.effects.addTaskComment(task.taskId, commentText);
        // Once the append resolves, remember it even if this generation was
        // invalidated while the storage call was in flight. The entry survives
        // pause/target replacement, so its retry must not append the same
        // comment before completing the metadata idempotency flag.
        progress.add("comment");
        if (!this.isCurrent(entry, generation)) return false;
      }

      if (!progress.has("metadata")) {
        await this.options.effects.updateTaskPrMetadata(task.taskId, {
          prUrl: detection.url,
          prState: terminalState,
          prMergeCommented: true,
        });
        if (!this.isCurrent(entry, generation)) return false;
        progress.add("metadata");
      }
      return true;
    } catch (error) {
      this.warn(
        `Failed to reconcile kanban task after PR ${terminalState} for ${environmentId}`,
        error,
      );
      return false;
    }
  }

  /** Records the PR on the linked task when it is first detected. */
  private async storePrOnTask(
    entry: PrMonitorEntry,
    detection: PrDetection,
    generation: number,
  ): Promise<boolean> {
    try {
      const task = await this.options.effects.findTaskForEnvironment(entry.target.environmentId);
      if (!this.isCurrent(entry, generation)) return false;
      if (!task) return true;
      if (
        task.prUrl === detection.url &&
        task.prState === detection.state &&
        !task.prMergeCommented
      ) {
        return true;
      }
      await this.options.effects.updateTaskPrMetadata(task.taskId, {
        prUrl: detection.url,
        prState: detection.state,
        prMergeCommented: false,
      });
      if (!this.isCurrent(entry, generation)) return false;
      return true;
    } catch (error) {
      this.warn(`Failed to store PR on task for ${entry.target.environmentId}`, error);
      return false;
    }
  }

  private describe(entry: PrMonitorEntry): PrMonitorEnvironmentState {
    return {
      environmentId: entry.target.environmentId,
      mode: entry.mode,
      checkInProgress: entry.checkInProgress,
      consecutiveErrors: entry.consecutiveErrors,
      lastCheckAt: entry.lastCheckAt,
      prUrl: entry.target.prUrl,
      prState: entry.target.prState,
      hasMergeConflicts: entry.target.hasMergeConflicts,
      checkSummary: entry.checkSummary,
      lastSuccessfulCheckAt: entry.lastSuccessfulCheckAt,
    };
  }

  private replaceTarget(entry: PrMonitorEntry, target: PrMonitorTarget): boolean {
    const changed = !isSameTarget(entry.target, target);
    const shouldClearSummary =
      entry.target.prUrl !== target.prUrl ||
      target.prState === "merged" ||
      target.prState === "closed";
    const summaryChanged = shouldClearSummary && entry.checkSummary !== null;
    if (shouldClearSummary) {
      entry.checkSummary = null;
      entry.lastCheckSummaryAt = null;
    }
    if (changed) {
      // A summary belongs to one open immutable PR URL. Keep it through
      // readiness changes, but never leak it onto a replacement or terminal PR.
      entry.generation += 1;
      // A check still queued for admission captures the target when it is
      // granted, so it already covers this change; a running one does not.
      if (entry.checkInProgress && entry.phase !== "waiting") entry.recheckRequested = true;
      if (entry.target.prUrl !== target.prUrl || entry.target.prState !== target.prState) {
        // Terminal obligations are settled per observation; a new identity or
        // state must be settled (or repaired) again from scratch.
        entry.settledTerminal = null;
        entry.forceDetection = false;
        entry.repairFailures = 0;
      }
    }
    entry.target = target;
    return changed || summaryChanged;
  }

  private isCurrent(entry: PrMonitorEntry, generation: number): boolean {
    return (
      this.entries.get(entry.target.environmentId) === entry &&
      entry.generation === generation &&
      entry.active
    );
  }

  private emitState(entry: PrMonitorEntry, transition?: PrMonitorTransition): void {
    const state = this.describe(entry);
    // Deduped on the observable fields only: `lastCheckAt` moves on every
    // check, and announcing each uneventful poll would wake every client at
    // the polling cadence for information nothing renders.
    if (!transition && entry.lastEmitted && isSameObservableState(entry.lastEmitted, state)) return;
    entry.lastEmitted = state;
    this.announce({ environmentId: state.environmentId, state, transition });
  }

  /**
   * Stamps and emits one event. The revision advances even when the sink
   * throws: the state change happened, and a client that never received it
   * must see a gap rather than an apparently contiguous sequence.
   */
  private announce(
    payload:
      | Omit<PrMonitorStateEvent, "generation" | "revision">
      | Omit<PrMonitorRemovalEvent, "generation" | "revision">,
  ): void {
    this.revision += 1;
    this.emitSafely({ ...payload, generation: this.generation, revision: this.revision });
  }

  private emitSafely(payload: PrMonitorEvent): void {
    try {
      this.options.emit(PR_MONITOR_CHANGED_EVENT, payload);
    } catch (error) {
      // One faulty event sink must not stop the background loop it describes.
      this.warn(`Failed to emit PR monitor event for ${payload.environmentId}`, error);
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.onWarning?.(message, error);
    } catch {
      // Warning reporters are observational; a broken logger must never break
      // the monitoring lifecycle it is supposed to describe.
    }
  }
}

function isTerminalState(state: PrState | null): state is "merged" | "closed" {
  return state === "merged" || state === "closed";
}

function terminalKey(url: string, state: PrState): string {
  return `${url}\0${state}`;
}

function strongerWake(
  a: PrMonitorWakeReason | null,
  b: PrMonitorWakeReason | null,
): PrMonitorWakeReason | null {
  if (a === "interactive" || b === "interactive") return "interactive";
  return a ?? b;
}

function isSameTarget(a: PrMonitorTarget, b: PrMonitorTarget): boolean {
  return (
    a.environmentId === b.environmentId &&
    a.branch === b.branch &&
    a.kind === b.kind &&
    a.worktreePath === b.worktreePath &&
    a.containerId === b.containerId &&
    a.ready === b.ready &&
    a.prUrl === b.prUrl &&
    a.prState === b.prState &&
    a.hasMergeConflicts === b.hasMergeConflicts
  );
}

function isSameCheckSummary(a: PrCheckSummary | null, b: PrCheckSummary | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.passed === b.passed &&
      a.total === b.total &&
      a.pending === b.pending)
  );
}

function isSameObservableState(
  a: PrMonitorEnvironmentState,
  b: PrMonitorEnvironmentState,
): boolean {
  return (
    a.mode === b.mode &&
    // Included so a "detecting" state announced mid-check is always followed
    // by the lowered state; otherwise the dedupe strands clients on a spinner.
    a.checkInProgress === b.checkInProgress &&
    a.consecutiveErrors === b.consecutiveErrors &&
    a.prUrl === b.prUrl &&
    a.prState === b.prState &&
    a.hasMergeConflicts === b.hasMergeConflicts &&
    isSameCheckSummary(a.checkSummary, b.checkSummary)
  );
}
