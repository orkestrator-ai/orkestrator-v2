import { randomUUID } from "node:crypto";
import {
  PR_MONITOR_CHANGED_EVENT,
  PR_MONITOR_MODE_TIMEOUTS_MS,
  getEffectivePrMonitorInterval,
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
import { recurringWorkMetrics, type RecurringWorkMetrics } from "./recurring-work-metrics.js";

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
 * agent-idle probe ({@link PrMonitorService.probe}) discovers agent-created PRs
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
  private readonly reconciliationOperations = new Map<string, Promise<void>>();
  private readonly options: Required<
    Pick<
      PrMonitorServiceOptions,
      "effects" | "emit" | "now" | "monotonicNow" | "schedule" | "cancel"
    >
  > & { onWarning?: PrMonitorServiceOptions["onWarning"] };
  private readonly metrics: RecurringWorkMetrics;

  constructor(options: PrMonitorServiceOptions) {
    this.metrics = options.metrics ?? recurringWorkMetrics;
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
        const targetChanged = this.replaceTarget(entry, target);
        if (targetChanged && entry.lastEmitted) this.emitState(entry);
        if (!target.ready && entry.active) this.pause(target.environmentId);
        else if (target.ready && !entry.active) {
          entry.active = true;
          this.scheduleNext(entry);
        }
        // An entry that has lost both its PR and its pending reason is retired
        // below via dropIfUnmonitorable, not here, so one code path decides.
        this.dropIfUnmonitorable(entry);
      } else if (target.prUrl && target.ready) {
        // Reconciliation is not a user action: the first check runs after one
        // normal interval rather than instantly, so converging the set (which
        // every snapshot request does) cannot burst a `gh` call per PR.
        this.track(target, "normal", { immediate: false });
      } else if (target.prUrl) {
        // Known PR on an environment that cannot be checked right now: hold the
        // last persisted reading, poll nothing.
        this.track(target, "normal", { immediate: false, paused: true });
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
      this.track(target, mode, { immediate: true, paused: !target.ready });
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
    if (entry.active) this.scheduleNext(entry, 0);
  }

  /** Runs a check now for an environment already being monitored. */
  requestCheck(environmentId: string): void {
    const entry = this.entries.get(environmentId);
    if (!entry || !entry.active) return;
    this.scheduleNext(entry, 0);
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
   * One-shot discovery, e.g. when an agent goes idle: it may have just created
   * a PR the backend knows nothing about. Monitored environments get an
   * immediate check; unmonitored ones get a single detection that either
   * promotes them into the set or leaves no trace.
   */
  probe(target: PrMonitorTarget): void {
    const entry = this.entries.get(target.environmentId);
    if (entry) {
      const targetChanged = this.replaceTarget(entry, target);
      if (targetChanged && entry.lastEmitted) this.emitState(entry);
      if (entry.active) this.scheduleNext(entry, 0);
      return;
    }
    if (!target.ready) return;
    const created = this.track(target, "normal", { immediate: true, announce: false });
    created.provisional = true;
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
    this.options.cancel(entry.timer);
    entry.timer = undefined;
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
      this.options.cancel(entry.timer);
      entry.timer = undefined;
      entry.active = false;
    }
    this.entries.clear();
    // The snapshot changed without per-entry removal events. Advancing the
    // revision keeps a conditional read from answering `unchanged` to a client
    // still holding the discarded entries; a live client sees a gap instead.
    if (announcedEntries) this.revision += 1;
  }

  private track(
    target: PrMonitorTarget,
    mode: PrMonitorMode,
    behaviour: { immediate: boolean; paused?: boolean; announce?: boolean },
  ): PrMonitorEntry {
    const entry: PrMonitorEntry = {
      target,
      mode,
      modeStartedAt: this.options.monotonicNow(),
      consecutiveErrors: 0,
      lastCheckAt: null,
      checkInProgress: false,
      recheckRequested: false,
      active: !behaviour.paused,
      provisional: false,
      persistencePending: false,
      generation: 0,
      reconciliation: new Map(),
      observedPr:
        target.prUrl && target.prState ? { url: target.prUrl, state: target.prState } : null,
      checkSummary: null,
      lastCheckSummaryAt: null,
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
    this.entries.delete(entry.target.environmentId);
    // A provisional probe that found nothing was never announced; announcing
    // its removal would tell clients about an entry they never saw.
    if (entry.lastEmitted) {
      this.announce({ environmentId: entry.target.environmentId, removed: true });
    }
  }

  private scheduleNext(entry: PrMonitorEntry, delayMs?: number): void {
    this.options.cancel(entry.timer);
    entry.timer = undefined;
    if (!entry.active || !entry.target.ready) return;
    const delay = delayMs ?? getEffectivePrMonitorInterval(entry.mode, entry.consecutiveErrors);
    entry.timer = this.options.schedule(() => {
      void this.performCheck(entry);
    }, delay);
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
    this.metrics.requested("pr-detection");
    if (entry.checkInProgress) {
      this.metrics.coalesced("pr-detection");
      entry.recheckRequested = true;
      return;
    }
    if (!this.expireModeIfDue(entry)) return;

    entry.checkInProgress = true;
    const generation = entry.generation;
    const detectionTarget = entry.target;
    let transition: PrMonitorTransition | undefined;
    try {
      let detection: PrDetection | null = null;
      let failed = false;
      try {
        const now = this.options.monotonicNow();
        const includeCheckSummary =
          entry.mode !== "merge-pending" &&
          (entry.lastCheckSummaryAt === null ||
            now - entry.lastCheckSummaryAt >= PR_CHECK_SUMMARY_REFRESH_INTERVAL_MS);
        detection = await this.metrics.observe("pr-detection", () =>
          this.options.effects.detect(detectionTarget, { includeCheckSummary }),
        );
        if (includeCheckSummary && detection?.checkSummaryStatus !== "skipped") {
          entry.lastCheckSummaryAt = now;
        }
      } catch (error) {
        failed = true;
        this.warn(`PR detection failed for ${entry.target.environmentId}`, error);
      }

      // Deleted (and possibly re-tracked as a different entry) while the
      // detection ran; a stale result must not resurrect removed state.
      if (!this.isCurrent(entry, generation)) return;

      if (failed) {
        entry.consecutiveErrors += 1;
      } else {
        entry.consecutiveErrors = 0;
        if (detection) transition = await this.applyDetection(entry, detection, generation);
        else await this.applyNotFound(entry, generation);
        this.metrics.outcome("pr-detection", transition ? "changed" : "unchanged");
      }
    } finally {
      entry.checkInProgress = false;
      if (entry.generation === generation) entry.lastCheckAt = this.options.now();
      if (this.entries.get(entry.target.environmentId) === entry) {
        if (entry.generation !== generation) {
          // A superseded check still has to lower a "detecting" state announced
          // mid-check (mode request, target change); otherwise a paused entry
          // would keep a spinner that nothing ever clears.
          if (entry.lastEmitted?.checkInProgress) this.emitState(entry);
          if (entry.active && entry.recheckRequested) {
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
            } else if (entry.recheckRequested) {
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
      await this.reconcileTask(entry, detection, generation);
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
  ): Promise<void> {
    const environmentId = entry.target.environmentId;
    const previous = this.reconciliationOperations.get(environmentId);
    const operation = previous
      ? previous
          .catch(() => undefined)
          .then(() => this.reconcileTaskUnlocked(entry, detection, generation))
      : this.reconcileTaskUnlocked(entry, detection, generation);
    this.reconciliationOperations.set(environmentId, operation);
    try {
      await operation;
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
  ): Promise<void> {
    const terminalState = detection.state as "merged" | "closed";
    const environmentId = entry.target.environmentId;
    try {
      const task = await this.options.effects.findTaskForEnvironment(environmentId);
      if (!this.isCurrent(entry, generation)) return;
      if (!task) return;

      const key = [environmentId, detection.url, terminalState, task.taskId].join("\0");
      const progress = entry.reconciliation.get(key) ?? new Set<ReconciliationStep>();
      entry.reconciliation.set(key, progress);
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
          if (!this.isCurrent(entry, generation)) return;
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
        if (!this.isCurrent(entry, generation)) return;
        progress.add("link");
      }

      if (!progress.has("comment")) {
        await this.options.effects.addTaskComment(task.taskId, commentText);
        // Once the append resolves, remember it even if this generation was
        // invalidated while the storage call was in flight. The entry survives
        // pause/target replacement, so its retry must not append the same
        // comment before completing the metadata idempotency flag.
        progress.add("comment");
        if (!this.isCurrent(entry, generation)) return;
      }

      if (!progress.has("metadata")) {
        await this.options.effects.updateTaskPrMetadata(task.taskId, {
          prUrl: detection.url,
          prState: terminalState,
          prMergeCommented: true,
        });
        if (!this.isCurrent(entry, generation)) return;
        progress.add("metadata");
      }
    } catch (error) {
      this.warn(
        `Failed to reconcile kanban task after PR ${terminalState} for ${environmentId}`,
        error,
      );
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
      if (entry.checkInProgress) entry.recheckRequested = true;
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
