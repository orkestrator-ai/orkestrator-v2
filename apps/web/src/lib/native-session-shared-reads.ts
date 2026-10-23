import type { ReadContext } from "@/lib/read-coordinator";

/**
 * Shared background reads for several mounted views of one native session
 * (docs/todo/transcripts-and-observation/0049, code item 3).
 *
 * Every mounted `useNativeAgentSession` keeps its own fenced state: refresh
 * sequence, operation epoch and the conditional tokens it last applied. That
 * state stays per view. What is shared is the schedule and the request:
 *
 * - **One schedule.** The coordinated read is keyed by session, so the read
 *   coordinator holds one timer, one dirty flag and one in-flight read for
 *   every view of the session. Its read runs a {@link NativeSessionReadRound}
 *   that refreshes every registered view that currently wants background
 *   reads.
 * - **One request per round.** Inside a round, views that send the same
 *   command with the same arguments (same identity, window and conditional
 *   token) share one backend call and each apply the same answer into its own
 *   fenced state. Views whose tokens differ, for example one that has just
 *   mounted, send their own request; after they apply the same answer their
 *   tokens agree and the next round joins them.
 *
 * A join never outlives its round, so an answer is only reused by a view whose
 * read started in the same coordinator read, never by a later one. Explicit
 * and post-mutation refreshes run outside any round and are never joined.
 */

/** One mounted view's part in its session's shared background read. */
export interface NativeSessionSharedView {
  /** Whether the view wants automatic reads right now (enabled and active). */
  wantsBackgroundRead(): boolean;
  /** The view's own background refresh, sending its requests through `round`. */
  refresh(context: ReadContext, round: NativeSessionReadRound): Promise<unknown>;
}

/** Bounds a round's join map; a round holds a handful of commands per view. */
const MAX_ROUND_JOINS = 64;

/** Requests joined within one coordinator read. */
export class NativeSessionReadRound {
  private readonly joins = new Map<string, Promise<unknown>>();
  private joined = 0;

  /**
   * Send `command` once per distinct `input` in this round. `input` must
   * describe the whole request; it is compared structurally.
   */
  request<T>(command: string, input: object, send: () => Promise<T>): Promise<T> {
    const key = `${command}\u0000${stableJson(input)}`;
    const existing = this.joins.get(key);
    if (existing) {
      this.joined += 1;
      return existing as Promise<T>;
    }
    const pending = send();
    if (this.joins.size < MAX_ROUND_JOINS) this.joins.set(key, pending);
    return pending;
  }

  /** For tests and diagnostics: requests answered by another view's call. */
  joinedRequests(): number {
    return this.joined;
  }
}

const views = new Map<string, Set<NativeSessionSharedView>>();

/** Register a view under its session target; returns the unregister. */
export function registerNativeSessionView(
  target: string,
  view: NativeSessionSharedView,
): () => void {
  let set = views.get(target);
  if (!set) {
    set = new Set();
    views.set(target, set);
  }
  set.add(view);
  return () => {
    const current = views.get(target);
    if (!current) return;
    current.delete(view);
    if (current.size === 0) views.delete(target);
  };
}

/**
 * The shared coordinated read for one session: refresh every registered view
 * that wants background reads, joining identical requests. Resolves once every
 * view's refresh settled; one view's failure does not stop the others.
 */
export async function runNativeSessionReadRound(
  target: string,
  context: ReadContext,
): Promise<NativeSessionReadRound> {
  const round = new NativeSessionReadRound();
  const participants = Array.from(views.get(target) ?? []).filter((view) =>
    view.wantsBackgroundRead(),
  );
  const results = await Promise.allSettled(
    participants.map((view) => view.refresh(context, round)),
  );
  // A read coordinator retry needs a failure; report it only when every
  // participating view failed, as a single view's read would have.
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure && results.every((result) => result.status === "rejected")) {
    throw failure.reason;
  }
  return round;
}

/** Number of registered views of one session (tests and diagnostics). */
export function nativeSessionViewCount(target: string): number {
  return views.get(target)?.size ?? 0;
}

export function resetNativeSessionSharedReadsForTests(): void {
  views.clear();
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) return inner;
    return Object.fromEntries(
      Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  });
}
