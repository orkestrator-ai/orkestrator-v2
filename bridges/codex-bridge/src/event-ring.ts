/**
 * Bounded replay buffer for the bridge's SSE stream.
 *
 * Why this exists: `/event/subscribe` is the only live channel, and an event
 * emitted while nobody is attached is gone. The chat tab already survives that —
 * it reconnects and refetches `/status` + `/messages` — but that full resync is
 * O(transcript) on *every* blip, and it loses the streaming deltas that occurred
 * during the gap. With a revision cursor a reconnecting client can usually ask for
 * "everything after N" and get exactly that.
 *
 * The buffer is deliberately small and lossy. It is not a durable log: the
 * rollout on disk remains the source of truth, and a client whose cursor has aged
 * out is told to reconcile rather than being served a partial history that would
 * look complete.
 */

export interface RingEvent<T> {
  revision: number;
  event: T;
}

/**
 * Sized for a reconnect gap, not a session. A busy turn emits a coalesced update
 * every ~50ms, so 512 covers roughly half a minute of dense streaming — far longer
 * than an EventSource reconnect — while capping the retained bytes.
 */
export const DEFAULT_RING_CAPACITY = 512;

export interface ReplayResult<T> {
  events: RingEvent<T>[];
  /**
   * False when the requested cursor is older than anything retained, so the
   * caller must tell the client to reconcile from scratch. Distinguishing this
   * from "nothing new" is the whole point: serving a truncated replay silently
   * would leave a permanent hole in the transcript.
   */
  complete: boolean;
  /** Highest revision issued so far, whether or not it is still retained. */
  latestRevision: number;
}

export interface EventRingOptions<T> {
  /** Maximum encoded payload bytes retained across all replayable events. */
  maxBytes?: number;
  /** Returns the retained byte cost for one event. Required with `maxBytes`. */
  measureBytes?: (event: T) => number;
  /**
   * Collapses a retained event that `incoming` makes redundant.
   *
   * Returns the replacement payload for the retained entry, or null when the two
   * are unrelated. Match on the entry's *identity* (its session and message, say)
   * rather than on whether it has already been collapsed: the scan runs
   * newest-first and stops at the first match, which is only sound if an already
   * collapsed entry still counts as a match.
   *
   * The entry keeps its revision, so the sequence stays dense and `since()`'s
   * completeness check is unaffected.
   */
  supersede?: (incoming: T, retained: T) => T | null;
}

export class EventRing<T> {
  private readonly capacity: number;
  private readonly maxBytes: number;
  private readonly measureBytes: (event: T) => number;
  private readonly supersede: ((incoming: T, retained: T) => T | null) | null;
  private readonly buffer: RingEvent<T>[] = [];
  private revision = 0;
  private droppedEvents = 0;
  private retainedBytes = 0;

  constructor(capacity: number = DEFAULT_RING_CAPACITY, options: EventRingOptions<T> = {}) {
    // A zero-capacity ring would report every reconnect as needing reconciliation,
    // which is correct but pointless; guard against a misconfigured 0.
    this.capacity = Math.max(1, capacity);
    if (options.maxBytes !== undefined && !options.measureBytes) {
      // Defaulting the measure to `() => 0` here would silently disable the byte
      // cap the caller just asked for — the ring would look bounded and grow
      // without limit. A misconfiguration this quiet is worth a hard failure.
      throw new TypeError("EventRing: maxBytes requires measureBytes");
    }
    this.maxBytes = Math.max(0, options.maxBytes ?? Number.POSITIVE_INFINITY);
    this.measureBytes = options.measureBytes ?? (() => 0);
    this.supersede = options.supersede ?? null;
  }

  get latestRevision(): number {
    return this.revision;
  }

  /** Oldest revision still replayable, or 0 when empty. */
  get oldestRevision(): number {
    return this.buffer[0]?.revision ?? 0;
  }

  getStats(): {
    retained: number;
    capacity: number;
    latestRevision: number;
    dropped: number;
    retainedBytes: number;
    maxBytes: number | null;
  } {
    return {
      retained: this.buffer.length,
      capacity: this.capacity,
      latestRevision: this.revision,
      dropped: this.droppedEvents,
      retainedBytes: this.retainedBytes,
      maxBytes: Number.isFinite(this.maxBytes) ? this.maxBytes : null,
    };
  }

  /** Assigns the next revision and retains the event. */
  append(event: T): number {
    this.revision += 1;
    if (this.supersede) this.collapseSuperseded(event);
    this.retainedBytes += Math.max(0, this.measureBytes(event));
    this.buffer.push({ revision: this.revision, event });
    while (this.buffer.length > this.capacity || this.retainedBytes > this.maxBytes) {
      const removed = this.buffer.shift();
      if (!removed) break;
      this.retainedBytes -= Math.max(0, this.measureBytes(removed.event));
      this.droppedEvents += 1;
    }
    return this.revision;
  }

  /**
   * Assigns the next revision without retaining a payload.
   *
   * An idle replay ring can stop holding background snapshots, but the cursor
   * sequence must still advance while events are omitted. Otherwise a returning
   * client could present its old cursor and be told it is caught up even though
   * events occurred during the retention gap.
   */
  advance(): number {
    this.revision += 1;
    return this.revision;
  }

  /**
   * Replaces the payload of the newest retained entry `incoming` supersedes.
   *
   * Newest-first with an early exit: every older entry for the same identity was
   * already collapsed when *its* successor was appended, so one match is enough.
   */
  private collapseSuperseded(incoming: T): void {
    const supersede = this.supersede;
    if (!supersede) return;
    for (let index = this.buffer.length - 1; index >= 0; index -= 1) {
      const entry = this.buffer[index]!;
      const replacement = supersede(incoming, entry.event);
      if (replacement === null) continue;
      this.retainedBytes -= Math.max(0, this.measureBytes(entry.event));
      entry.event = replacement;
      this.retainedBytes += Math.max(0, this.measureBytes(replacement));
      return;
    }
  }

  /**
   * Everything issued after `cursor`.
   *
   * `cursor` is the last revision the client *has*, so the result starts at
   * `cursor + 1`. A cursor from the future (a client that reconnected to a
   * restarted bridge, whose revisions began again at 1) cannot be honoured and is
   * reported as incomplete.
   */
  since(cursor: number): ReplayResult<T> {
    if (!Number.isFinite(cursor) || cursor < 0) {
      return { events: [], complete: false, latestRevision: this.revision };
    }
    if (cursor > this.revision) {
      // Stale client against a restarted bridge: its cursor refers to a revision
      // sequence that no longer exists.
      return { events: [], complete: false, latestRevision: this.revision };
    }
    if (cursor === this.revision) {
      // Caught up. Trivially complete, even if the ring has since been trimmed.
      return { events: [], complete: true, latestRevision: this.revision };
    }

    const oldest = this.oldestRevision;
    // The needed range starts at cursor + 1; if that is older than what we kept,
    // there is a hole.
    const complete = oldest !== 0 && cursor + 1 >= oldest;
    return {
      events: complete ? this.buffer.filter((entry) => entry.revision > cursor) : [],
      complete,
      latestRevision: this.revision,
    };
  }

  clear(): void {
    this.buffer.length = 0;
    this.retainedBytes = 0;
  }
}

/**
 * Parses a client-supplied cursor from `?since=` or the `Last-Event-ID` header.
 *
 * Returns null for anything not a non-negative integer, which the caller treats
 * as "no cursor" — a fresh subscription — rather than as an error.
 */
export function parseEventCursor(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}
