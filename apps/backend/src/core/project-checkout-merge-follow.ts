/**
 * Keeps a project's checkout current when one of its environments' pull
 * requests merges.
 *
 * The project's coordinator reads the project's own checkout (the project
 * home's working tree). When a PR merges — through the merge button, a
 * coordinator, auto-merge, or on GitHub directly — the base branch moves on
 * the remote, and the coordinator would go on answering from the code before
 * it. So the backend fetches and fast-forwards the checkout as soon as it
 * learns of the merge, whenever Git can do that cleanly: the same rule the
 * coordinator applies before each message
 * (`@orkestrator/protocol/coordinator-upstream-merge`). A checkout with local
 * commits, uncommitted changes or an unfinished operation is left alone.
 *
 * The checkout never changes under a running coordinator or project-home
 * turn. A merge observed while one runs is retried every
 * `retryIntervalMs` until the turn ends, for at most `retryWindowMs`; after
 * that the next coordinator message merges it instead. Repeated merges of one
 * project coalesce into one attempt (plus one rerun when a merge lands during
 * an attempt), and one PR is followed once per backend process.
 *
 * This is background work owned by the backend; no client needs to be open.
 */
import { decideUpstreamMergeOffer } from "@orkestrator/protocol/coordinator-upstream-merge";
import type { ProjectGitStatus } from "@orkestrator/protocol/coordinator";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("coordinator");

/** The `ProjectGitService` surface this needs. */
export interface ProjectCheckoutGit {
  isCheckoutBusy(projectId: string): Promise<boolean>;
  fetch(projectId: string, force?: boolean): Promise<ProjectGitStatus>;
  sync(projectId: string): Promise<ProjectGitStatus>;
}

export type ProjectCheckoutFollowOutcome =
  /** The checkout was fast-forwarded to its upstream. */
  | "fast-forwarded"
  /** A turn is running or the checkout is already changing; retried later. */
  | "busy"
  /** Already up to date, or no upstream to follow. */
  | "not-behind"
  /** Behind, but local commits, changes or an operation block a fast-forward. */
  | "blocked"
  /** No status could be read. */
  | "no-status"
  /** The fast-forward itself failed. */
  | "failed";

/** `ProjectGitService` refusals that mean "not now", not "cannot". */
const BUSY_MESSAGES = [
  "Stop the active coordinator turn before changing the checkout",
  "Wait for the coordinator turn to start before changing the checkout",
  "The project checkout is already changing",
];

function isBusyRefusal(error: unknown): boolean {
  return error instanceof Error && BUSY_MESSAGES.includes(error.message);
}

/**
 * One attempt: fetch (bypassing the cooldown, since the remote just moved)
 * and fast-forward if Git can do it cleanly.
 */
export async function fastForwardProjectCheckout(
  git: ProjectCheckoutGit,
  projectId: string,
): Promise<ProjectCheckoutFollowOutcome> {
  if (await git.isCheckoutBusy(projectId)) return "busy";
  const decision = decideUpstreamMergeOffer(await git.fetch(projectId, true).catch(() => null));
  if (!decision.offer) {
    return decision.reason === "blocked" || decision.reason === "no-status"
      ? decision.reason
      : "not-behind";
  }
  try {
    await git.sync(projectId);
    return "fast-forwarded";
  } catch (error) {
    if (isBusyRefusal(error)) return "busy";
    log.warn("checkout.merge-follow-failed", { projectId, error: formatLogError(error) });
    return "failed";
  }
}

export interface ProjectCheckoutMergeFollowerOptions {
  retryIntervalMs?: number;
  retryWindowMs?: number;
  /** How many followed PRs are remembered, to follow each once. */
  maxRememberedMerges?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

interface PendingFollow {
  git: ProjectCheckoutGit;
  deadline: number;
  running: boolean;
  rerun: boolean;
  timer?: unknown;
}

export class ProjectCheckoutMergeFollower {
  private readonly pending = new Map<string, PendingFollow>();
  private readonly followed = new Set<string>();
  private readonly settled = new Set<Promise<void>>();
  private closed = false;
  private readonly retryIntervalMs: number;
  private readonly retryWindowMs: number;
  private readonly maxRememberedMerges: number;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(options: ProjectCheckoutMergeFollowerOptions = {}) {
    this.retryIntervalMs = options.retryIntervalMs ?? 30_000;
    this.retryWindowMs = options.retryWindowMs ?? 30 * 60_000;
    this.maxRememberedMerges = options.maxRememberedMerges ?? 512;
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref?.();
        return timer;
      });
    this.cancel =
      options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /**
   * Follows a merge into the project's checkout. `mergeKey` (the PR URL)
   * makes repeated reports of the same merge a no-op.
   */
  follow(projectId: string, git: ProjectCheckoutGit, mergeKey?: string): void {
    if (this.closed) return;
    if (mergeKey) {
      if (this.followed.has(mergeKey)) return;
      this.followed.add(mergeKey);
      if (this.followed.size > this.maxRememberedMerges) {
        const oldest = this.followed.values().next().value;
        if (oldest !== undefined) this.followed.delete(oldest);
      }
    }
    const deadline = this.now() + this.retryWindowMs;
    const existing = this.pending.get(projectId);
    if (existing) {
      existing.git = git;
      existing.deadline = deadline;
      // A merge that landed after this attempt's fetch needs another one.
      if (existing.running) existing.rerun = true;
      return;
    }
    const entry: PendingFollow = { git, deadline, running: false, rerun: false };
    this.pending.set(projectId, entry);
    this.run(projectId, entry);
  }

  /** Waits for every attempt now running (tests and shutdown ordering). */
  async idle(): Promise<void> {
    while (this.settled.size > 0) await Promise.all(Array.from(this.settled));
  }

  /** Whether a project still has an attempt running or a retry scheduled. */
  isFollowing(projectId: string): boolean {
    return this.pending.has(projectId);
  }

  shutdown(): void {
    this.closed = true;
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) this.cancel(entry.timer);
    }
    this.pending.clear();
    this.followed.clear();
  }

  private run(projectId: string, entry: PendingFollow): void {
    entry.running = true;
    entry.rerun = false;
    entry.timer = undefined;
    const attempt = fastForwardProjectCheckout(entry.git, projectId)
      .catch((error): ProjectCheckoutFollowOutcome => {
        log.warn("checkout.merge-follow-failed", { projectId, error: formatLogError(error) });
        return "failed";
      })
      .then((outcome) => this.settle(projectId, entry, outcome));
    this.settled.add(attempt);
    void attempt.finally(() => this.settled.delete(attempt));
  }

  private settle(projectId: string, entry: PendingFollow, outcome: ProjectCheckoutFollowOutcome) {
    entry.running = false;
    if (this.closed || this.pending.get(projectId) !== entry) return;
    if (entry.rerun) {
      this.run(projectId, entry);
      return;
    }
    if (outcome === "busy" && this.now() < entry.deadline) {
      entry.timer = this.schedule(() => {
        if (!this.closed && this.pending.get(projectId) === entry) this.run(projectId, entry);
      }, this.retryIntervalMs);
      return;
    }
    this.pending.delete(projectId);
    if (outcome !== "failed") log.info("checkout.merge-followed", { projectId, outcome });
  }
}
