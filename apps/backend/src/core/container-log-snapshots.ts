/**
 * Shared Docker log tail snapshots for container initialization views
 * (recurring-processes step 09).
 *
 * Every client showing a creating container asks `get_container_logs` for the
 * same bounded tail once a second. Equivalent requests — same container id,
 * which is the container's generation (a recreated container has a new id),
 * and the same tail size — join a read already in flight and reuse a completed
 * snapshot for a short freshness window, so N clients cost one `docker logs`
 * per window rather than N. Failures are never cached. Docker stays the
 * durable, authoritative log buffer; this is not a follower and keeps no
 * history beyond the bounded map of recent snapshots.
 */

/** Shorter than the one-second client cadence, so one client never sees an old tail twice. */
export const CONTAINER_LOG_SNAPSHOT_FRESHNESS_MS = 750;
export const CONTAINER_LOG_SNAPSHOT_MAX_ENTRIES = 32;

interface Snapshot {
  startedAt: number;
  value: Promise<string>;
  settled: boolean;
}

export interface SharedContainerLogReaderOptions {
  read: (containerId: string, tail: string) => Promise<string>;
  now?: () => number;
  freshnessMs?: number;
  maxEntries?: number;
}

export function createSharedContainerLogReader(
  options: SharedContainerLogReaderOptions,
): (containerId: string, tail: string) => Promise<string> {
  const now = options.now ?? (() => performance.now());
  const freshnessMs = options.freshnessMs ?? CONTAINER_LOG_SNAPSHOT_FRESHNESS_MS;
  const maxEntries = options.maxEntries ?? CONTAINER_LOG_SNAPSHOT_MAX_ENTRIES;
  const snapshots = new Map<string, Snapshot>();

  return (containerId, tail) => {
    const key = `${containerId}\u0000${tail}`;
    const at = now();
    const existing = snapshots.get(key);
    if (existing && (!existing.settled || at - existing.startedAt < freshnessMs)) {
      return existing.value;
    }
    const snapshot: Snapshot = {
      startedAt: at,
      value: options.read(containerId, tail),
      settled: false,
    };
    snapshots.delete(key);
    snapshots.set(key, snapshot);
    snapshot.value.then(
      () => {
        snapshot.settled = true;
      },
      () => {
        // A failure is shared with the reads that joined it, never cached.
        if (snapshots.get(key) === snapshot) snapshots.delete(key);
      },
    );
    while (snapshots.size > maxEntries) {
      const oldest = snapshots.keys().next().value;
      if (oldest === undefined) break;
      snapshots.delete(oldest);
    }
    return snapshot.value;
  };
}
