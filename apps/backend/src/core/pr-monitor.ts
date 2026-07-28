import {
  PR_MONITOR_CHANGED_EVENT,
  PR_MONITOR_MODE_TIMEOUTS_MS,
  getEffectivePrMonitorInterval,
  type PrMonitorEnvironmentState,
  type PrMonitorEvent,
  type PrMonitorMode,
  type PrMonitorTransition,
  type PrState,
} from "@orkestrator/protocol/pr-monitor";

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
  hasMergeConflicts: boolean;
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
  detect: (target: PrMonitorTarget) => Promise<PrDetection | null>;
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
}

export const PR_MERGED_COMMENT = "🎉 PR merged";
export const PR_CLOSED_COMMENT = "❌ PR closed";

type ReconciliationStep = "status" | "comment" | "metadata";

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
   * Kanban side-effect progress per (url, state, task), so a failure in a later
   * step retries that step without repeating comments or status moves.
   */
  reconciliation: Map<string, Set<ReconciliationStep>>;
  /** Transitions already emitted, so a failed persist retry cannot re-announce. */
  announcedTransitions: Set<string>;
  /** Last emitted state; suppresses byte-identical events. */
  lastEmitted?: PrMonitorEnvironmentState;
}

export class PrMonitorService {
  private readonly entries = new Map<string, PrMonitorEntry>();
  private readonly options: Required<
    Pick<PrMonitorServiceOptions, "effects" | "emit" | "now" | "monotonicNow" | "schedule" | "cancel">
  > & { onWarning?: PrMonitorServiceOptions["onWarning"] };

  constructor(options: PrMonitorServiceOptions) {
    this.options = {
      effects: options.effects,
      emit: options.emit,
      now: options.now ?? (() => new Date().toISOString()),
      monotonicNow: options.monotonicNow ?? (() => Date.now()),
      schedule: options.schedule ?? ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref?.();
        return timer;
      }),
      cancel: options.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)),
      onWarning: options.onWarning,
    };
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
        entry.target = target;
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
    for (const [environmentId, entry] of [...this.entries]) {
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
      this.track(target, mode, { immediate: true });
      return;
    }
    entry.target = target;
    entry.provisional = false;
    if (entry.mode !== mode) {
      entry.mode = mode;
      entry.modeStartedAt = this.options.monotonicNow();
      this.emitState(entry);
    } else {
      entry.modeStartedAt = this.options.monotonicNow();
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
   * One-shot discovery, e.g. when an agent goes idle: it may have just created
   * a PR the backend knows nothing about. Monitored environments get an
   * immediate check; unmonitored ones get a single detection that either
   * promotes them into the set or leaves no trace.
   */
  probe(target: PrMonitorTarget): void {
    const entry = this.entries.get(target.environmentId);
    if (entry) {
      entry.target = target;
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

  /** Authoritative snapshot for a client that just connected or remounted. */
  snapshot(): PrMonitorEnvironmentState[] {
    return [...this.entries.values()].map((entry) => this.describe(entry));
  }

  /** Releases every timer; used on backend shutdown. */
  shutdown(): void {
    for (const entry of this.entries.values()) {
      this.options.cancel(entry.timer);
      entry.timer = undefined;
      entry.active = false;
    }
    this.entries.clear();
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
      reconciliation: new Map(),
      announcedTransitions: new Set(),
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
    this.options.cancel(entry.timer);
    entry.timer = undefined;
    entry.active = false;
    this.entries.delete(entry.target.environmentId);
    // A provisional probe that found nothing was never announced; announcing
    // its removal would tell clients about an entry they never saw.
    if (entry.lastEmitted) {
      this.emitSafely({ environmentId: entry.target.environmentId, removed: true });
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
    if (entry.checkInProgress) {
      entry.recheckRequested = true;
      return;
    }
    if (!this.expireModeIfDue(entry)) return;

    entry.checkInProgress = true;
    let transition: PrMonitorTransition | undefined;
    try {
      let detection: PrDetection | null = null;
      let failed = false;
      try {
        detection = await this.options.effects.detect(entry.target);
      } catch (error) {
        failed = true;
        this.warn(`PR detection failed for ${entry.target.environmentId}`, error);
      }

      // Deleted (and possibly re-tracked as a different entry) while the
      // detection ran; a stale result must not resurrect removed state.
      if (this.entries.get(entry.target.environmentId) !== entry) return;

      if (failed) {
        entry.consecutiveErrors += 1;
      } else {
        entry.consecutiveErrors = 0;
        if (detection) transition = await this.applyDetection(entry, detection);
        else await this.applyNotFound(entry);
      }
    } finally {
      entry.checkInProgress = false;
      entry.lastCheckAt = this.options.now();
      if (this.entries.get(entry.target.environmentId) === entry) {
        const silentProbe = entry.provisional
          && !entry.lastEmitted
          && !transition
          && !entry.target.prUrl
          && entry.mode === "normal";
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
  ): Promise<PrMonitorTransition | undefined> {
    const previous = entry.target;
    const previousState = previous.prState;
    const changed = detection.url !== previous.prUrl
      || detection.state !== previous.prState
      || detection.hasMergeConflicts !== previous.hasMergeConflicts;

    let transition: PrMonitorTransition | undefined;
    if (detection.url !== previous.prUrl || detection.state !== previous.prState) {
      const key = [entry.target.environmentId, detection.url, detection.state].join("\0");
      // A confirmed transition is announced even if persisting it fails: the
      // stale stored state would otherwise make every retry look like the same
      // new transition and re-notify on each one.
      if (!entry.announcedTransitions.has(key)) {
        entry.announcedTransitions.add(key);
        transition = { url: detection.url, state: detection.state, previousState };
      }
    }

    let persisted = !changed;
    if (changed) {
      try {
        await this.options.effects.persistPr(entry.target.environmentId, detection);
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

    if (detection.state === "merged" || detection.state === "closed") {
      await this.reconcileTask(entry, detection);
    }

    if (persisted && entry.mode === "create-pending") {
      if (await this.storePrOnTask(entry, detection)) {
        entry.mode = "normal";
        entry.modeStartedAt = this.options.monotonicNow();
      }
    } else if (
      persisted
      && entry.mode === "merge-pending"
      && (detection.state === "merged" || detection.state === "closed")
    ) {
      entry.mode = "normal";
      entry.modeStartedAt = this.options.monotonicNow();
    }

    return transition;
  }

  private async applyNotFound(entry: PrMonitorEntry): Promise<void> {
    const { prUrl, prState } = entry.target;
    if (!prUrl) {
      // A PR found on the previous check but never durably stored may disappear
      // before the retry. There is then no state left to persist and no reason
      // to retain a provisional background poller forever.
      entry.persistencePending = false;
      return;
    }
    // After a merge with --delete-branch the environment checks out the base
    // branch and `gh pr list --head` stops finding the PR. The merged/closed
    // reading saved when the merge landed is the truth; do not clear it.
    if (prState === "merged" || prState === "closed") return;
    try {
      await this.options.effects.clearPr(entry.target.environmentId);
      entry.target = { ...entry.target, prUrl: null, prState: null, hasMergeConflicts: null };
      entry.persistencePending = false;
    } catch (error) {
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
  private async reconcileTask(entry: PrMonitorEntry, detection: PrDetection): Promise<void> {
    const terminalState = detection.state as "merged" | "closed";
    const environmentId = entry.target.environmentId;
    try {
      const task = await this.options.effects.findTaskForEnvironment(environmentId);
      if (!task) return;

      const key = [environmentId, detection.url, terminalState, task.taskId].join("\0");
      const progress = entry.reconciliation.get(key) ?? new Set<ReconciliationStep>();
      entry.reconciliation.set(key, progress);
      const commentText = terminalState === "merged" ? PR_MERGED_COMMENT : PR_CLOSED_COMMENT;

      const taskMetadataMatchesDetection = task.prUrl === detection.url
        && task.prState === terminalState;
      if (task.prMergeCommented && taskMetadataMatchesDetection) {
        progress.add("comment");
        progress.add("metadata");
      } else if (taskMetadataMatchesDetection && task.hasCommentText(commentText)) {
        // A previous attempt (possibly by an earlier backend process) added the
        // comment but died before setting the idempotency flag. Only the same
        // PR and terminal state qualify: a replacement PR on the same task must
        // receive its own reconciliation.
        progress.add("comment");
      }

      if (terminalState === "merged" && !progress.has("status")) {
        // Only advance in-progress tasks; a task already in review or done must
        // not regress. A pipeline-located task (status unknown) is moved, which
        // matches the renderer behaviour this replaced.
        if (task.status === "in-progress" || task.status === null) {
          await this.options.effects.moveTaskToReview(task.taskId);
        }
        progress.add("status");
      }

      if (!progress.has("comment")) {
        await this.options.effects.addTaskComment(task.taskId, commentText);
        progress.add("comment");
      }

      if (!progress.has("metadata")) {
        await this.options.effects.updateTaskPrMetadata(task.taskId, {
          prUrl: detection.url,
          prState: terminalState,
          prMergeCommented: true,
        });
        progress.add("metadata");
      }
    } catch (error) {
      this.warn(`Failed to reconcile kanban task after PR ${terminalState} for ${environmentId}`, error);
    }
  }

  /** Records the PR on the linked task when it is first detected. */
  private async storePrOnTask(entry: PrMonitorEntry, detection: PrDetection): Promise<boolean> {
    try {
      const task = await this.options.effects.findTaskForEnvironment(entry.target.environmentId);
      if (!task || task.prUrl) return true;
      await this.options.effects.updateTaskPrMetadata(task.taskId, {
        prUrl: detection.url,
        prState: detection.state,
      });
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
    };
  }

  private emitState(entry: PrMonitorEntry, transition?: PrMonitorTransition): void {
    const state = this.describe(entry);
    // Deduped on the observable fields only: `lastCheckAt` moves on every
    // check, and announcing each uneventful poll would wake every client at
    // the polling cadence for information nothing renders.
    if (!transition && entry.lastEmitted && isSameObservableState(entry.lastEmitted, state)) return;
    entry.lastEmitted = state;
    this.emitSafely({ environmentId: state.environmentId, state, transition });
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

function isSameObservableState(
  a: PrMonitorEnvironmentState,
  b: PrMonitorEnvironmentState,
): boolean {
  return a.mode === b.mode
    && a.consecutiveErrors === b.consecutiveErrors
    && a.prUrl === b.prUrl
    && a.prState === b.prState
    && a.hasMergeConflicts === b.hasMergeConflicts;
}
