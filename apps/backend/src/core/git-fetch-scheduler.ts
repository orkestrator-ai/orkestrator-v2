/**
 * Coalesces `git fetch` across every worktree of a repository.
 *
 * Local environments are `git worktree add` checkouts of one project clone, so
 * they share an object database and a single `origin`. Fetching inline on every
 * diff read meant N environments each opened a network round trip for the same
 * refs on every poll, and contended on the same `.git` lock while doing it.
 *
 * Two properties make that go away:
 *
 *  - **Keyed by the shared git directory, not the worktree.** All worktrees of a
 *    repository resolve to one common dir, so they share one fetch.
 *  - **Rate limited, and single-flight.** A ref that was fetched a moment ago is
 *    not fetched again; concurrent callers await the one in-flight fetch instead
 *    of starting their own.
 *
 * The cost of a slightly stale `origin/<branch>` is that a diff is measured
 * against a base that is at most `ttlMs` behind. That is the correct trade: the
 * base branch moves on the order of minutes, and the alternative was a network
 * round trip every fifteen seconds per environment.
 */

export interface GitFetchSchedulerOptions {
  /** Runs a git command; injected so tests need neither git nor a network. */
  run: (args: string[], timeoutMs: number) => Promise<{ stdout: string }>;
  /** How long a completed fetch satisfies later requests for the same ref. */
  ttlMs?: number;
  now?: () => number;
  fetchTimeoutMs?: number;
  resolveTimeoutMs?: number;
}

/** A base branch that moves on the order of minutes does not need fetching faster. */
export const DEFAULT_GIT_FETCH_TTL_MS = 5 * 60_000;

interface FetchRecord {
  completedAt: number;
  inFlight?: Promise<void>;
  invalidatedWhileInFlight?: boolean;
}

export class GitFetchScheduler {
  private readonly run: GitFetchSchedulerOptions["run"];
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly fetchTimeoutMs: number;
  private readonly resolveTimeoutMs: number;
  /** worktree path -> shared git dir, so the resolve runs once per worktree. */
  private readonly commonDirs = new Map<string, Promise<string>>();
  /** `${commonDir}\0${ref}` -> last fetch. */
  private readonly fetches = new Map<string, FetchRecord>();

  constructor(options: GitFetchSchedulerOptions) {
    this.run = options.run;
    this.ttlMs = options.ttlMs ?? DEFAULT_GIT_FETCH_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 60_000;
    this.resolveTimeoutMs = options.resolveTimeoutMs ?? 10_000;
  }

  /**
   * Fetches `ref` for the repository containing `worktreePath` unless a recent
   * fetch already covers it. Never throws: a failed fetch degrades to reading
   * whatever refs are already local, which is what the caller did before.
   */
  async ensureFetched(worktreePath: string, ref: string): Promise<void> {
    const key = `${await this.resolveCommonDir(worktreePath)}\0${ref}`;
    const existing = this.fetches.get(key);

    if (existing?.inFlight) {
      if (existing.invalidatedWhileInFlight) {
        return existing.inFlight.then(() => this.ensureFetched(worktreePath, ref));
      }
      return existing.inFlight;
    }
    if (existing && this.now() - existing.completedAt < this.ttlMs) return;

    const record: FetchRecord = { completedAt: existing?.completedAt ?? 0 };
    const attempt = this.run(["-C", worktreePath, "fetch", "origin", ref], this.fetchTimeoutMs)
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        record.inFlight = undefined;
        if (record.invalidatedWhileInFlight) {
          // The invalidation happened after this request began, so its result
          // cannot satisfy the next caller even if it completed successfully.
          if (this.fetches.get(key) === record) this.fetches.delete(key);
          return;
        }
        // Stamp on completion rather than on start: a fetch that took a minute
        // should not immediately be considered a minute stale.
        record.completedAt = this.now();
      });
    record.inFlight = attempt;
    this.fetches.set(key, record);
    return attempt;
  }

  /**
   * Marks `ref` as needing a fetch on its next read.
   *
   * Used when something is known to have changed the remote - a push, a merge -
   * so the next diff does not have to wait out the TTL to notice.
   */
  invalidate(worktreePath: string, ref?: string): void {
    const pending = this.commonDirs.get(worktreePath);
    if (!pending) return;
    void pending.then(
      (commonDir) => {
        const prefix = `${commonDir}\0`;
        for (const key of [...this.fetches.keys()]) {
          if (!key.startsWith(prefix)) continue;
          if (ref !== undefined && key !== `${prefix}${ref}`) continue;
          const record = this.fetches.get(key);
          if (record?.inFlight) record.invalidatedWhileInFlight = true;
          else this.fetches.delete(key);
        }
      },
      () => undefined,
    );
  }

  /** Drops the cached repository identity for a worktree path. */
  forget(worktreePath: string): void {
    this.commonDirs.delete(worktreePath);
  }

  private resolveCommonDir(worktreePath: string): Promise<string> {
    const cached = this.commonDirs.get(worktreePath);
    if (cached) return cached;

    const pending = this.run(
      ["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      this.resolveTimeoutMs,
    ).then(
      ({ stdout }) => stdout.trim() || worktreePath,
      // Not a git repository, or a git too old for --path-format. Falling back
      // to the worktree path only loses sharing; it never fetches the wrong
      // repository, because the fetch itself still runs with -C worktreePath.
      () => worktreePath,
    );
    this.commonDirs.set(worktreePath, pending);
    return pending;
  }
}
