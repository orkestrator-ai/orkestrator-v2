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

export class EventRing<T> {
  private readonly capacity: number;
  private readonly buffer: RingEvent<T>[] = [];
  private revision = 0;
  private droppedEvents = 0;

  constructor(capacity: number = DEFAULT_RING_CAPACITY) {
    // A zero-capacity ring would report every reconnect as needing reconciliation,
    // which is correct but pointless; guard against a misconfigured 0.
    this.capacity = Math.max(1, capacity);
  }

  get latestRevision(): number {
    return this.revision;
  }

  /** Oldest revision still replayable, or 0 when empty. */
  get oldestRevision(): number {
    return this.buffer[0]?.revision ?? 0;
  }

  getStats(): { retained: number; capacity: number; latestRevision: number; dropped: number } {
    return {
      retained: this.buffer.length,
      capacity: this.capacity,
      latestRevision: this.revision,
      dropped: this.droppedEvents,
    };
  }

  /** Assigns the next revision and retains the event. */
  append(event: T): number {
    this.revision += 1;
    this.buffer.push({ revision: this.revision, event });
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
      this.droppedEvents += 1;
    }
    return this.revision;
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
