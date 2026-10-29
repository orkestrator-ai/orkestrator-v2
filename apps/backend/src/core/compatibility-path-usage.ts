/**
 * Content-free usage counters for mixed-version compatibility paths, so a path
 * is retired on evidence rather than a guess
 * (`docs/architecture/version-compatibility.md`).
 *
 * Each path is a fixed id from {@link COMPATIBILITY_PATH_IDS}; nothing else is
 * recorded: no session, agent, URL, port or version of the other side. Hot
 * paths call {@link CompatibilityPathUsage.record}, which only bumps memory.
 * Once a sink is attached (the backend attaches its database at startup), the
 * pending counts are merged into the `compatibility-path-usage` store at most
 * once a minute, on every read, and at shutdown, so the totals and the first
 * and last time each path was taken survive restarts and upgrades. The
 * database sink lives in `compatibility-path-usage-store.ts`, so the paths that
 * record here never import storage.
 */
/**
 * Every counted path. Add an id when a change adds a path for an older peer
 * and remove it with the path. The register in the architecture doc names
 * each path's owner and removal condition.
 */
export const COMPATIBILITY_PATH_IDS = [
  /** A session-route 404 was rejected as an outdated bridge, without reading a legacy route. */
  "slash-catalogue.outdated-bridge",
  /** A bridge without `POST /session/:id/close` was closed through its legacy DELETE. */
  "bridge-close.legacy-delete",
  /** A bridge without the close route and with a destructive DELETE got the restart notice. */
  "bridge-close.upgrade-required",
  /** A bridge without `/transcript` was read through its whole `/messages` body. */
  "bridge-transcript.messages-fallback",
  /**
   * A history page was served from the joined sync-v1 projection while the
   * session's latest view carried a direct cursor, or no view was read: a
   * caller paging with a v1 cursor it did not need (0232 item 3).
   */
  "history.joined-v1-page",
  /** A joined page for a view whose source has no direct pages (no provider cursor). */
  "history.joined-v1-page.unpaged-source",
  /** A joined page for a view whose source pages directly but could name or wrap no cursor. */
  "history.joined-v1-page.unnamed-cursor",
  /** A runtime-health body had `mcpConfig` but no `mcpConfigReporting` marker. */
  "mcp-report.unmarked-config",
  /** An MCP apply outcome was decided by the older-bridge rule. */
  "mcp-report.older-bridge-outcome",
  /** A request used the legacy `/__orkestrator/browser/loopback/<port>/` preview route. */
  "preview.legacy-loopback-route",
] as const;

export type CompatibilityPathId = (typeof COMPATIBILITY_PATH_IDS)[number];

/** One path's persisted usage. */
export interface CompatibilityPathUsageEntry {
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** The persisted document, also what the command and `/api/metrics` return. */
export interface CompatibilityPathUsageSnapshot {
  version: 1;
  paths: Partial<Record<CompatibilityPathId, CompatibilityPathUsageEntry>>;
}

/** Where pending counts are merged; the backend's is the database store. */
export interface CompatibilityPathUsageSink {
  /** Adds `pending` to the stored totals and returns the merged document. */
  merge(pending: ReadonlyMap<CompatibilityPathId, PendingUsage>): CompatibilityPathUsageSnapshot;
  close?(): void;
}

export interface PendingUsage {
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export const COMPATIBILITY_PATH_USAGE_STORE = "compatibility-path-usage";
const FLUSH_INTERVAL_MS = 60_000;
const KNOWN_IDS = new Set<string>(COMPATIBILITY_PATH_IDS);

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Reads valid entries; persistence retains newer ids while public snapshots filter them. */
export function normalizeCompatibilityPathUsage(
  value: unknown,
  includeUnknown = false,
): CompatibilityPathUsageSnapshot {
  const paths: CompatibilityPathUsageSnapshot["paths"] = {};
  const stored =
    value && typeof value === "object" ? (value as { paths?: unknown }).paths : undefined;
  if (stored && typeof stored === "object") {
    for (const [id, entry] of Object.entries(stored)) {
      if ((!includeUnknown && !KNOWN_IDS.has(id)) || !entry || typeof entry !== "object") continue;
      const { count, firstSeenAt, lastSeenAt } = entry as Record<string, unknown>;
      if (!Number.isSafeInteger(count) || (count as number) < 0) continue;
      if (!isIso(firstSeenAt) || !isIso(lastSeenAt)) continue;
      Object.defineProperty(paths, id, {
        value: { count: count as number, firstSeenAt, lastSeenAt },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return { version: 1, paths };
}

/** Adds pending counts to a document in place. */
export function mergeCompatibilityPathUsage(
  document: CompatibilityPathUsageSnapshot,
  pending: ReadonlyMap<CompatibilityPathId, PendingUsage>,
): CompatibilityPathUsageSnapshot {
  for (const [id, usage] of pending) {
    const stored = document.paths[id];
    document.paths[id] = stored
      ? {
          count: Math.min(Number.MAX_SAFE_INTEGER, stored.count + usage.count),
          firstSeenAt:
            stored.firstSeenAt < usage.firstSeenAt ? stored.firstSeenAt : usage.firstSeenAt,
          lastSeenAt: stored.lastSeenAt > usage.lastSeenAt ? stored.lastSeenAt : usage.lastSeenAt,
        }
      : { ...usage };
  }
  return document;
}

export class CompatibilityPathUsage {
  private pending = new Map<CompatibilityPathId, PendingUsage>();
  private sink: CompatibilityPathUsageSink | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private persisted: CompatibilityPathUsageSnapshot = { version: 1, paths: {} };

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly flushIntervalMs = FLUSH_INTERVAL_MS,
  ) {}

  /** Counts one use of a path. Never throws and never does I/O. */
  record(id: CompatibilityPathId): void {
    const at = this.now().toISOString();
    const usage = this.pending.get(id);
    if (usage) {
      usage.count += 1;
      usage.lastSeenAt = at;
    } else {
      this.pending.set(id, { count: 1, firstSeenAt: at, lastSeenAt: at });
    }
    this.scheduleFlush();
  }

  /**
   * Persists through `sink` from now on; counts recorded before are kept. A
   * previously attached sink (another backend in the same process, as in
   * tests) is flushed and closed first.
   */
  attach(sink: CompatibilityPathUsageSink): void {
    if (this.sink && this.sink !== sink) this.detach(this.sink);
    this.sink = sink;
    if (this.pending.size > 0) this.scheduleFlush();
  }

  /** Flushes into `sink`, then stops persisting and closes it, if it is still attached. */
  detach(sink: CompatibilityPathUsageSink): void {
    if (this.sink !== sink) return;
    this.flush();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.sink = null;
    this.persisted = { version: 1, paths: {} };
    sink.close?.();
  }

  /**
   * Merges pending counts into the sink and returns the totals. Without a
   * sink, the pending counts are returned. If a write fails, they are kept,
   * retried at the flush interval, and added to the last persisted snapshot.
   */
  flush(): CompatibilityPathUsageSnapshot {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pending;
    if (!this.sink) return mergeCompatibilityPathUsage({ version: 1, paths: {} }, pending);
    this.pending = new Map();
    try {
      const snapshot = this.sink.merge(pending);
      this.persisted = normalizeCompatibilityPathUsage(snapshot);
      return snapshot;
    } catch {
      // Keep the counts and retry even when no further traffic arrives.
      this.pending = pending;
      if (pending.size > 0) this.scheduleFlush();
      return mergeCompatibilityPathUsage(normalizeCompatibilityPathUsage(this.persisted), pending);
    }
  }

  /** Persisted totals plus anything not yet flushed. */
  snapshot(): CompatibilityPathUsageSnapshot {
    return this.flush();
  }

  private scheduleFlush(): void {
    if (!this.sink || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }
}

/** The process-wide counters every compatibility path records into. */
export const compatibilityPathUsage = new CompatibilityPathUsage();
