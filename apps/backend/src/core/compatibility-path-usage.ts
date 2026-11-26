/**
 * Content-free usage counters for mixed-version compatibility paths, so a path
 * is retired on evidence rather than a guess
 * (`docs/architecture/version-compatibility.md`).
 *
 * Each path is a fixed id from {@link COMPATIBILITY_PATH_IDS}, or a domain
 * client adapter's id (`domain-adapter.<source>.<domain>.v<version>`); nothing else is
 * recorded: no session, agent, URL, port or version of the other side. Hot
 * paths call {@link CompatibilityPathUsage.record}, which only bumps memory.
 * Once a sink is attached (the backend attaches its database at startup), the
 * pending counts are merged into the `compatibility-path-usage` store at most
 * once a minute, on every durable read, and at shutdown, so the totals and the first
 * and last time each path was taken survive restarts and upgrades. The
 * database sink lives in `compatibility-path-usage-store.ts`, so the paths that
 * record here never import storage.
 */
import {
  isDomainAdapterPathId,
  type DomainAdapterPathId,
} from "@orkestrator/protocol/contract/client-usage";

/**
 * Every counted path. Add an id when a change adds a path for an older peer
 * and remove it with the path. The register in the architecture doc names
 * each path's owner and removal condition.
 */
export const COMPATIBILITY_PATH_IDS = [
  /** A container bridge's token was read from its `node`-readable `/tmp` file. */
  "bridge-credential.token-file",
  /**
   * A Claude or Codex turn outcome was recorded as a usage limit from its error
   * text alone: the bridge sent no `errorCode` (it predates the code, or the
   * provider refused without its structured signal).
   */
  "usage-limit.text-classified",
  /**
   * A workspace client (a client grant or the relay) sent a global-settings
   * write that changed nothing and was answered with the current settings: a
   * realm from before `patch_global_config` saving a model favourite.
   */
  "workspace-grant.config-echo",
] as const;

/**
 * A fixed path id, or a domain client adapter's id
 * (`domain-adapter.<backend|renderer>.<domain>.v<version>`, plan item 1009):
 * one per adapter below its domain's current version, bounded by the domain
 * names and the adapter list rather than listed here.
 */
export type CompatibilityPathId = (typeof COMPATIBILITY_PATH_IDS)[number] | DomainAdapterPathId;

/** One path's persisted usage. */
export interface CompatibilityPathUsageEntry {
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** The persisted document, also what the command and `/__orkestrator/metrics` return. */
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

/** Whether `id` is a fixed path id or a well-formed domain adapter id. */
export function isCompatibilityPathId(id: string): id is CompatibilityPathId {
  return KNOWN_IDS.has(id) || isDomainAdapterPathId(id);
}

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
      if ((!includeUnknown && !isCompatibilityPathId(id)) || !entry || typeof entry !== "object") {
        continue;
      }
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
  /** Whether {@link persisted} has been read from the attached sink. */
  private loaded = false;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly flushIntervalMs = FLUSH_INTERVAL_MS,
  ) {}

  /**
   * Counts `count` uses of a path (one by default; a renderer's upload carries
   * several). Never throws and never does I/O.
   */
  record(id: CompatibilityPathId, count = 1): void {
    if (!Number.isSafeInteger(count) || count < 1) return;
    const at = this.now().toISOString();
    const usage = this.pending.get(id);
    if (usage) {
      usage.count = Math.min(Number.MAX_SAFE_INTEGER, usage.count + count);
      usage.lastSeenAt = at;
    } else {
      this.pending.set(id, { count, firstSeenAt: at, lastSeenAt: at });
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
    this.scheduleFlush();
  }

  /** Flushes into `sink`, then stops persisting and closes it, if it is still attached. */
  detach(sink: CompatibilityPathUsageSink): void {
    if (this.sink !== sink) return;
    this.flush();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.sink = null;
    this.loaded = false;
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
      this.loaded = true;
      this.scheduleFlush();
      return snapshot;
    } catch {
      // Keep the counts and retry even when no further traffic arrives.
      this.pending = pending;
      this.scheduleFlush();
      return mergeCompatibilityPathUsage(normalizeCompatibilityPathUsage(this.persisted), pending);
    }
  }

  /** Persisted totals plus anything not yet flushed. */
  snapshot(): CompatibilityPathUsageSnapshot {
    return this.flush();
  }

  /**
   * The last totals read or written plus what is pending, from memory: a poll
   * costs no I/O and persistence stays with the once-a-minute flush. The first
   * call reads the sink once, so a fresh process starts from the stored totals.
   * Another backend's counts arrive within the periodic flush interval;
   * for the durable truth call {@link snapshot}.
   */
  peek(): CompatibilityPathUsageSnapshot {
    if (this.sink && !this.loaded) return this.flush();
    return mergeCompatibilityPathUsage(
      normalizeCompatibilityPathUsage(this.persisted),
      this.pending,
    );
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
