import type { StateSignalCredential, WorktreeSignalReason } from "./agent-tools.js";
import type { CommandContext } from "./commands-context.js";
import {
  emptySignalHealthStates,
  type SignalDemotionReason,
  type SignalHealthState,
  type SignalHealthStatus,
} from "./recurring-diagnostics.js";
import type { WorktreeChangeHint, WorktreeWatcher } from "./worktree-watcher.js";

/**
 * Container worktree change signal (`container-worktree-signal=1`).
 *
 * A container has no host-side watcher, so without this its Files panel pays a
 * status exec per read and a tree walk every 10 s, and its counts rescan every
 * 15 s. With it, `orkestrator-worktree-signal` (an inotify watcher started in
 * the container) rings the agent tools server when the workspace changes, and
 * `DiffStatsService` treats the container like a watched local worktree:
 * results stay valid until a ring, a known mutation or an explicit refresh,
 * and only a slow safety scan runs.
 *
 * This module is the watcher `DiffStatsService.startContainerWatcher` gets: it
 * turns rings into the same {@link WorktreeChangeHint}s a local watcher sends,
 * so the service stays the one scan owner. It mirrors the Claude state signal
 * (`tmux-poll.ts`):
 *
 * - **Lineage.** One credential per `startContainerWatcher` call. The service
 *   starts one for every tracking lineage (a container start, a retarget, a
 *   backend start, a replacement container), and the install replaces any
 *   watcher already in the container, so an old lineage can never confirm a
 *   new one. A container restarted behind the backend's back loses its
 *   watcher; the next safety scan finds whatever changed meanwhile.
 * - **The ring carries no state.** Every ring dirties the file list and the
 *   tree and rescans the whole worktree, so an inotify overflow already is a
 *   full reconciliation. Its reason header can only add work: `ready` (the
 *   watches are established) confirms the signal, `lost` (the watcher ended
 *   on its own) demotes it.
 * - **Trust is earned and can be lost.** Until a ring arrives the service
 *   keeps the fallback bounds (3 s file lists, 3/10 s trees, 15 s scans). A
 *   safety scan that finds a change no ring announced demotes the lineage
 *   unless a ring arrives within {@link CONTAINER_WORKTREE_SIGNAL_MISS_GRACE_MS}
 *   (a ring still settling in the container); so do a `lost` ring and more
 *   than {@link CONTAINER_WORKTREE_SIGNAL_MAX_RINGS_PER_MINUTE} rings a minute.
 *   A demoted lineage re-arms after {@link CONTAINER_WORKTREE_SIGNAL_RETRY_MS}.
 * - **Cost bound.** Rings become hints at most once per
 *   {@link CONTAINER_WORKTREE_SIGNAL_MIN_HINT_GAP_MS}, so a container under
 *   constant writes costs at most one status exec per gap, and a quiet one only
 *   the safety scan.
 */

/** Least gap between hints from one lineage; the watcher itself rings at most once a second. */
export const CONTAINER_WORKTREE_SIGNAL_MIN_HINT_GAP_MS = 2_000;
/** Twice what the watcher can ring (one a second): only a misbehaving container gets here. */
export const CONTAINER_WORKTREE_SIGNAL_MAX_RINGS_PER_MINUTE = 120;
/** A suspected miss is forgiven when a ring follows within this (the watcher settles ≤ 1 s). */
export const CONTAINER_WORKTREE_SIGNAL_MISS_GRACE_MS = 3_000;
/** Least gap between arming attempts of one lineage after a failure or demotion. */
export const CONTAINER_WORKTREE_SIGNAL_RETRY_MS = 300_000;
/**
 * Safety scan of a confirmed container: the bound on a change the watcher
 * cannot see (inside `node_modules`, Git's object store) or a watcher that
 * died with its container. Local watchers use the 120 s safety net; the
 * container's watcher is a process the agent can kill, so it is checked more
 * often. One exec a minute against four.
 */
export const CONTAINER_WORKTREE_SAFETY_SCAN_INTERVAL_MS = 60_000;

/** `unknown`: the image could not be inspected right now; ask again later. */
export type ContainerWorktreeSignalSupport = "supported" | "unsupported" | "unknown";

/** What arming needs from the backend: storage for the image, agent tools for the credential. */
export type ContainerWorktreeSignalContext = Pick<CommandContext, "storage"> &
  Partial<Pick<CommandContext, "agentTools" | "containerHostReachability">>;

/** Puts the watcher into a container (`container-worktree-signal-install.ts`). */
export interface ContainerWorktreeSignalInstaller {
  support(
    containerId: string,
    context: ContainerWorktreeSignalContext,
  ): Promise<ContainerWorktreeSignalSupport>;
  /** Resolves once the config is written and the watcher started; `ready` rings later. */
  install(
    containerId: string,
    credential: StateSignalCredential,
    context: ContainerWorktreeSignalContext,
    isCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface ContainerWorktreeWatcherOptions {
  containerId: string;
  onChange: (hint?: WorktreeChangeHint) => void;
  /** Called whenever {@link WorktreeWatcher.qualified} changes, in either direction. */
  onCoverageChange?: () => void;
}

/** A container watcher; `unannouncedChange` is how the scan owner reports a miss. */
export interface ContainerWorktreeWatcher extends WorktreeWatcher {
  unannouncedChange(): void;
}

export interface ContainerWorktreeSignalsOptions {
  /** Without one every container keeps the fallback bounds. */
  installer?: ContainerWorktreeSignalInstaller | null;
  /** The latest backend context; read at arming time. */
  context: () => ContainerWorktreeSignalContext | null;
  nowMs?: () => number;
  delay?: (callback: () => void, delayMs: number) => unknown;
  cancelDelay?: (timer: unknown) => void;
  onWarning?: (message: string) => void;
}

type Lineage = {
  containerId: string;
  closed: boolean;
  qualified: boolean;
  unsupported: boolean;
  demoted: boolean;
  arming: boolean;
  abort: AbortController;
  credential?: StateSignalCredential;
  options: ContainerWorktreeWatcherOptions;
  rings: number;
  ringWindowStartedAt?: number;
  ringsInWindow: number;
  lastHintAt?: number;
  overflowPending: boolean;
  hintTimer?: unknown;
  graceTimer?: unknown;
  retryTimer?: unknown;
};

export class ContainerWorktreeSignals {
  private readonly lineages = new Set<Lineage>();
  /** Per container, so a lineage's install waits for the previous one to stop writing. */
  private readonly installations = new Map<string, Promise<void>>();
  /** An image without the capability stays without it; Docker never reuses ids. */
  private readonly unsupported = new Set<string>();
  private readonly installer: ContainerWorktreeSignalInstaller | null;
  private readonly context: () => ContainerWorktreeSignalContext | null;
  private readonly nowMs: () => number;
  private readonly delay: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelDelay: (timer: unknown) => void;
  private readonly onWarning: (message: string) => void;
  private readonly demotions: Partial<Record<SignalDemotionReason, number>> = {};
  private acceptedRings = 0;

  constructor(options: ContainerWorktreeSignalsOptions) {
    this.installer = options.installer ?? null;
    this.context = options.context;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.delay =
      options.delay ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref?.();
        return timer;
      });
    this.cancelDelay =
      options.cancelDelay ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.onWarning = options.onWarning ?? ((message) => console.warn(`[diff-stats] ${message}`));
  }

  /** The `startContainerWatcher` of `DiffStatsService`. */
  start(options: ContainerWorktreeWatcherOptions): ContainerWorktreeWatcher {
    const lineage: Lineage = {
      containerId: options.containerId,
      closed: false,
      qualified: false,
      unsupported: this.unsupported.has(options.containerId),
      demoted: false,
      arming: false,
      abort: new AbortController(),
      options,
      rings: 0,
      ringsInWindow: 0,
      overflowPending: false,
    };
    this.lineages.add(lineage);
    this.arm(lineage);
    return {
      get watching() {
        return !lineage.closed && !lineage.unsupported;
      },
      get qualified() {
        return !lineage.closed && lineage.qualified;
      },
      close: () => this.close(lineage),
      unannouncedChange: () => this.suspectMiss(lineage),
    };
  }

  status(): SignalHealthStatus {
    const states = emptySignalHealthStates();
    let fallback = 0;
    for (const lineage of this.lineages) {
      states[this.healthOf(lineage)] += 1;
      if (!lineage.qualified) fallback += 1;
    }
    return {
      containers: this.lineages.size,
      states,
      fallback,
      demotions: { ...this.demotions },
      rings: this.acceptedRings,
    };
  }

  private healthOf(lineage: Lineage): SignalHealthState {
    if (lineage.unsupported) return "unsupported";
    if (lineage.qualified) return "confirmed";
    if (lineage.credential) return "armed";
    if (lineage.arming) return "arming";
    if (lineage.demoted) return "demoted";
    return "unarmed";
  }

  private arm(lineage: Lineage): void {
    const installer = this.installer;
    const context = this.context();
    const issue = context?.agentTools?.issueWorktreeSignal;
    if (!installer || lineage.closed || lineage.unsupported) return;
    if (!context || !issue) {
      this.scheduleRetry(lineage);
      return;
    }
    if (lineage.arming || lineage.qualified) return;
    lineage.arming = true;
    const { containerId } = lineage;
    const current = () => !lineage.closed && this.lineages.has(lineage);
    const previous = this.installations.get(containerId);
    const arming = (async () => {
      await previous;
      if (!current()) return;
      const support = await installer.support(containerId, context);
      if (!current()) return;
      if (support === "unsupported") {
        this.unsupported.add(containerId);
        lineage.unsupported = true;
        lineage.options.onCoverageChange?.();
        return;
      }
      if (support !== "supported") {
        this.scheduleRetry(lineage);
        return;
      }
      this.revoke(lineage);
      let credential: StateSignalCredential | null = null;
      credential = issue.call(context.agentTools, (reason) => {
        if (credential && lineage.credential === credential) this.ring(lineage, reason);
      });
      if (!credential) {
        this.scheduleRetry(lineage);
        return;
      }
      lineage.credential = credential;
      await installer.install(containerId, credential, context, current, lineage.abort.signal);
      // A watcher whose `ready` ring never arrives (a firewall, a missing host
      // alias) is re-armed after the window; a confirmed one ignores this.
      this.scheduleRetry(lineage);
    })()
      .catch((error: unknown) => {
        if (current()) {
          this.demote(
            lineage,
            "arm-failed",
            `Could not arm the worktree signal for ${containerId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } else {
          this.revoke(lineage);
        }
      })
      .finally(() => {
        lineage.arming = false;
        if (this.installations.get(containerId) === arming) this.installations.delete(containerId);
      });
    this.installations.set(containerId, arming);
  }

  private ring(lineage: Lineage, reason: WorktreeSignalReason): void {
    if (lineage.closed) return;
    const now = this.nowMs();
    if (lineage.ringWindowStartedAt === undefined || now - lineage.ringWindowStartedAt >= 60_000) {
      lineage.ringWindowStartedAt = now;
      lineage.ringsInWindow = 0;
    }
    lineage.ringsInWindow += 1;
    if (lineage.ringsInWindow > CONTAINER_WORKTREE_SIGNAL_MAX_RINGS_PER_MINUTE) {
      this.demote(lineage, "rang-too-often");
      this.hint(lineage, true);
      return;
    }
    lineage.rings += 1;
    this.acceptedRings += 1;
    if (reason === "lost") {
      // Whatever changed after the watcher's last ring was never announced.
      this.demote(lineage, "watcher-lost");
      this.hint(lineage, true);
      return;
    }
    if (!lineage.qualified) {
      lineage.qualified = true;
      lineage.demoted = false;
      // Coverage first, so the rescan this ring asks for is a qualified one:
      // events before confirmation were never announced.
      lineage.options.onCoverageChange?.();
    }
    if (reason === "overflow") lineage.overflowPending = true;
    this.hint(lineage, false);
  }

  /** Forwards a full hint, at most once per gap (trailing), or at once when `now`. */
  private hint(lineage: Lineage, now: boolean): void {
    if (lineage.closed) return;
    const at = this.nowMs();
    const wait =
      now || lineage.lastHintAt === undefined
        ? 0
        : lineage.lastHintAt + CONTAINER_WORKTREE_SIGNAL_MIN_HINT_GAP_MS - at;
    if (wait <= 0) {
      if (lineage.hintTimer !== undefined) this.cancelDelay(lineage.hintTimer);
      lineage.hintTimer = undefined;
      this.emitHint(lineage);
      return;
    }
    if (lineage.hintTimer !== undefined) return;
    lineage.hintTimer = this.delay(() => {
      lineage.hintTimer = undefined;
      this.emitHint(lineage);
    }, wait);
  }

  private emitHint(lineage: Lineage): void {
    if (lineage.closed) return;
    lineage.lastHintAt = this.nowMs();
    const overflow = lineage.overflowPending;
    lineage.overflowPending = false;
    lineage.options.onChange({ fileList: true, tree: true, overflow });
  }

  /**
   * The scan owner saw a change that no ring since its previous scan
   * announced. A ring may still be settling in the container, so wait for one
   * before deciding the watcher missed it.
   */
  private suspectMiss(lineage: Lineage): void {
    if (lineage.closed || !lineage.qualified || lineage.graceTimer !== undefined) return;
    const rings = lineage.rings;
    lineage.graceTimer = this.delay(() => {
      lineage.graceTimer = undefined;
      if (lineage.closed || !lineage.qualified || lineage.rings !== rings) return;
      this.demote(lineage, "missed-change");
    }, CONTAINER_WORKTREE_SIGNAL_MISS_GRACE_MS);
  }

  private demote(lineage: Lineage, reason: SignalDemotionReason, detail?: string): void {
    const wasQualified = lineage.qualified;
    lineage.qualified = false;
    lineage.demoted = true;
    this.demotions[reason] = (this.demotions[reason] ?? 0) + 1;
    this.revoke(lineage);
    this.onWarning(
      detail ??
        `Worktree signal in ${lineage.containerId} ${DEMOTION_TEXT[reason]}; scanning on timers until it is re-armed`,
    );
    if (wasQualified) lineage.options.onCoverageChange?.();
    this.scheduleRetry(lineage);
  }

  private scheduleRetry(lineage: Lineage): void {
    if (lineage.closed || lineage.retryTimer !== undefined) return;
    lineage.retryTimer = this.delay(() => {
      lineage.retryTimer = undefined;
      this.arm(lineage);
    }, CONTAINER_WORKTREE_SIGNAL_RETRY_MS);
  }

  private revoke(lineage: Lineage): void {
    lineage.credential?.revoke();
    lineage.credential = undefined;
  }

  private close(lineage: Lineage): void {
    if (lineage.closed) return;
    lineage.closed = true;
    lineage.abort.abort();
    lineage.qualified = false;
    this.revoke(lineage);
    for (const timer of [lineage.hintTimer, lineage.graceTimer, lineage.retryTimer]) {
      if (timer !== undefined) this.cancelDelay(timer);
    }
    lineage.hintTimer = lineage.graceTimer = lineage.retryTimer = undefined;
    this.lineages.delete(lineage);
  }
}

const DEMOTION_TEXT: Record<SignalDemotionReason, string> = {
  "missed-change": "missed a change",
  "rang-too-often": "rang too often",
  "arm-failed": "could not be armed",
  "watcher-lost": "lost its watcher",
};
