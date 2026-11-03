import type { StorageContext } from "./storage-context.js";
import { isRecord } from "./storage-shared.js";

/** How many pull requests one project watches; the least recently seen goes first. */
export const MAX_WATCHED_PULL_REQUESTS_PER_PROJECT = 100;
/** How many settled pull requests a project remembers, so a link seen again is not re-watched. */
export const MAX_SETTLED_PULL_REQUESTS_PER_PROJECT = 200;
/**
 * How long a settled (merged, closed, gone) pull request is refused as a new
 * rendered watch; explicit opens revalidate it on the next sweep. A coordinator transcript keeps rendering the link of a merged PR;
 * without this every render would cost a read that only finds it settled.
 */
export const WATCHED_PULL_REQUEST_SETTLED_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export const WATCHED_PULL_REQUEST_STATES = ["open", "draft", "closed", "merged"] as const;
export const WATCHED_PULL_REQUEST_CHECKS = [
  "passing",
  "failing",
  "pending",
  "neutral",
  "none",
] as const;
export const WATCHED_PULL_REQUEST_REVIEWS = ["approved", "changes-requested", "none"] as const;
export const WATCHED_PULL_REQUEST_SOURCES = ["rendered", "opened"] as const;

/** The parts of a pull request whose change a coordinator hears about. */
export interface WatchedPullRequestReading {
  state: (typeof WATCHED_PULL_REQUEST_STATES)[number];
  checks: (typeof WATCHED_PULL_REQUEST_CHECKS)[number];
  /** Null while GitHub has not computed mergeability. */
  conflicts: boolean | null;
  review: (typeof WATCHED_PULL_REQUEST_REVIEWS)[number];
}

/** One pull request a project's coordinator watches; see `coordinator-pr-watches.ts`. */
export interface WatchedPullRequest {
  /** `owner/repo#number`, lower-case owner and repository. */
  key: string;
  owner: string;
  repo: string;
  number: number;
  title?: string;
  /** What put it here first: a link rendered in, or opened from, the coordinator. */
  source: (typeof WATCHED_PULL_REQUEST_SOURCES)[number];
  addedAt: string;
  /** Last time the coordinator rendered or opened it. */
  lastSeenAt: string;
  /** Last time the watch read it from GitHub, successfully or not. */
  checkedAt?: string;
  /**
   * When GitHub first answered "not found" without confirming a deletion;
   * cleared by the next successful reading. See `WATCHED_PR_MISSING_GIVE_UP_MS`.
   */
  missingSince?: string;
  /** The last reading; absent until the first one, which is the baseline. */
  reading?: WatchedPullRequestReading;
  /** Notices sent so far; part of each notice's request id. */
  notices: number;
}

interface PersistedWatchedPullRequests {
  projectId: string;
  entries: WatchedPullRequest[];
  settled: Array<{ key: string; at: string }>;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

function storedReading(value: unknown): WatchedPullRequestReading | undefined {
  if (!isRecord(value)) return undefined;
  const state = oneOf(value.state, WATCHED_PULL_REQUEST_STATES);
  const checks = oneOf(value.checks, WATCHED_PULL_REQUEST_CHECKS);
  const review = oneOf(value.review, WATCHED_PULL_REQUEST_REVIEWS);
  if (!state || !checks || !review) return undefined;
  const conflicts = typeof value.conflicts === "boolean" ? value.conflicts : null;
  return { state, checks, conflicts, review };
}

function storedEntry(value: unknown): WatchedPullRequest | null {
  if (!isRecord(value)) return null;
  const { key, owner, repo, number, addedAt, lastSeenAt } = value;
  const source = oneOf(value.source, WATCHED_PULL_REQUEST_SOURCES);
  if (
    typeof key !== "string" ||
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    typeof addedAt !== "string" ||
    typeof lastSeenAt !== "string" ||
    !source
  ) {
    return null;
  }
  const reading = storedReading(value.reading);
  return {
    key,
    owner,
    repo,
    number,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    source,
    addedAt,
    lastSeenAt,
    ...(typeof value.checkedAt === "string" ? { checkedAt: value.checkedAt } : {}),
    ...(typeof value.missingSince === "string" ? { missingSince: value.missingSince } : {}),
    ...(reading ? { reading } : {}),
    notices:
      typeof value.notices === "number" && Number.isSafeInteger(value.notices) && value.notices > 0
        ? value.notices
        : 0,
  };
}

function stored(value: unknown, projectId: string): PersistedWatchedPullRequests {
  if (!isRecord(value) || value.projectId !== projectId) {
    return { projectId, entries: [], settled: [] };
  }
  const entries = Array.isArray(value.entries)
    ? value.entries.map(storedEntry).filter((entry): entry is WatchedPullRequest => entry !== null)
    : [];
  const settled = Array.isArray(value.settled)
    ? value.settled.filter(
        (item): item is { key: string; at: string } =>
          isRecord(item) && typeof item.key === "string" && typeof item.at === "string",
      )
    : [];
  return { projectId, entries, settled };
}

function settledRecently(
  settled: PersistedWatchedPullRequests["settled"],
  key: string,
  nowMs: number,
): boolean {
  return settled.some(
    (item) => item.key === key && nowMs - Date.parse(item.at) < WATCHED_PULL_REQUEST_SETTLED_TTL_MS,
  );
}

export type WatchPullRequestResult =
  { watched: true; added: boolean } | { watched: false; reason: "settled" };

/** What a mutation of one watched pull request does: keep a new value, stop watching it, or nothing. */
export type WatchedPullRequestUpdate =
  { kind: "keep"; entry: WatchedPullRequest } | { kind: "settle" } | { kind: "unchanged" };

/**
 * The `coordinator-watched-pull-requests` store: one row per project holding
 * the pull requests its coordinator watches and the ones recently settled.
 * Watches are per machine, like the coordinator they report to.
 */
export class WatchedPullRequestsRepository {
  constructor(private readonly context: StorageContext) {}

  private file(): string {
    return this.context.file("coordinator-watched-pull-requests.json");
  }

  listWatchedPullRequests(projectId: string): WatchedPullRequest[] {
    return stored(this.context.loadStoreRow(this.file(), projectId), projectId).entries;
  }

  /**
   * Adds the pull request to the project's watch, or refreshes `lastSeenAt`
   * when it is already watched (written at most once per `touchAfterMs`). A
   * rendered pull request settled within the last week is refused. An explicit
   * open clears the tombstone and revalidates at the next sweep.
   */
  watchPullRequest(
    projectId: string,
    input: Pick<WatchedPullRequest, "key" | "owner" | "repo" | "number" | "source">,
    now: Date,
    touchAfterMs: number,
  ): WatchPullRequestResult {
    const at = now.toISOString();
    return this.context.updateStoreRow<WatchPullRequestResult>(
      this.file(),
      projectId,
      (current) => {
        const value = stored(current, projectId);
        const existing = value.entries.find((entry) => entry.key === input.key);
        if (existing) {
          if (now.getTime() - Date.parse(existing.lastSeenAt) < touchAfterMs) {
            return { result: { watched: true, added: false } };
          }
          existing.lastSeenAt = at;
          return { result: { watched: true, added: false }, value };
        }
        if (input.source !== "opened" && settledRecently(value.settled, input.key, now.getTime())) {
          return { result: { watched: false, reason: "settled" } };
        }
        value.settled = value.settled.filter((item) => item.key !== input.key);
        const entries = [...value.entries, { ...input, addedAt: at, lastSeenAt: at, notices: 0 }]
          .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
          .slice(0, MAX_WATCHED_PULL_REQUESTS_PER_PROJECT);
        return { result: { watched: true, added: true }, value: { ...value, entries } };
      },
    );
  }

  /**
   * Applies `mutate` to one watched pull request under the row's
   * transaction. `settle` stops watching it and remembers it as settled.
   * Returns false when it is no longer watched.
   */
  updateWatchedPullRequest(
    projectId: string,
    key: string,
    now: Date,
    mutate: (entry: WatchedPullRequest) => WatchedPullRequestUpdate,
  ): boolean {
    return this.context.updateStoreRow<boolean>(this.file(), projectId, (current) => {
      const value = stored(current, projectId);
      const index = value.entries.findIndex((entry) => entry.key === key);
      if (index < 0) return { result: false };
      const update = mutate(structuredClone(value.entries[index]!));
      if (update.kind === "unchanged") return { result: true };
      if (update.kind === "keep") {
        value.entries[index] = update.entry;
        return { result: true, value };
      }
      value.entries.splice(index, 1);
      const nowMs = now.getTime();
      value.settled = [
        ...value.settled.filter(
          (item) =>
            item.key !== key && nowMs - Date.parse(item.at) < WATCHED_PULL_REQUEST_SETTLED_TTL_MS,
        ),
        { key, at: now.toISOString() },
      ].slice(-MAX_SETTLED_PULL_REQUESTS_PER_PROJECT);
      return { result: true, value };
    });
  }

  deleteWatchedPullRequestsForProject(projectId: string): void {
    this.context.updateStoreRow<void>(this.file(), projectId, (current) =>
      current === undefined ? { result: undefined } : { result: undefined, delete: true },
    );
  }
}

/**
 * The watched pull request store: what callers reach as
 * `storage.watchedPullRequests`. Every name here is an entry point
 * `storage-writer-guards.test.ts` follows store writes back to.
 */
export type WatchedPullRequestsStorage = Pick<
  WatchedPullRequestsRepository,
  "listWatchedPullRequests" | "watchPullRequest" | "updateWatchedPullRequest"
>;
