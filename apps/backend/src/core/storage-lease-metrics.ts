import {
  LEASE_WAIT_BUCKETS_MS,
  type LeaseWaitFamilySnapshot,
  type LeaseWaitSnapshot,
} from "@orkestrator/protocol/backend-diagnostics";

/**
 * Bounded, content-free counters for lease contention, which otherwise looks
 * like a generic event-loop stall until a waiter times out.
 *
 * A lease name holds a hash, an id or (outside the data directory) a path, so
 * series are by family: `native-agent-session-leases/<hash>` counts as
 * `native-agent-session-leases`. {@link leaseFamily} keeps nothing else, and the
 * table is capped, so memory stays bounded whatever a name holds.
 */
export const MAX_LEASE_FAMILIES = 64;
const OTHER_FAMILY = "other";
const OUTSIDE_DATA_DIR = "outside-data-dir";
/** A UUID or a long hex digest, which no fixed family name contains. */
const ID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}/gi;
const SAFE_FAMILY = /^[A-Za-z0-9._*-]{1,64}$/;

/**
 * {@link leaseFamily}'s rules as data, for code that runs where this module
 * cannot be imported: the backup child sizes stores by family with them
 * (`storage-backups.ts`), and a test holds the two to the same answers.
 */
export const FAMILY_RULES = {
  idLike: ID_LIKE.source,
  safeFamily: SAFE_FAMILY.source,
  other: OTHER_FAMILY,
  outsideDataDir: OUTSIDE_DATA_DIR,
} as const;

export function leaseFamily(name: string): string {
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) {
    return OUTSIDE_DATA_DIR;
  }
  const first = (name.split("/", 1)[0] ?? "").replace(ID_LIKE, "*");
  return SAFE_FAMILY.test(first) ? first : OTHER_FAMILY;
}

/**
 * A lease's name for a log line: the name itself when it is relative to the
 * data directory (store files, hashes and ids), its family when it is a path.
 */
export function leaseLogName(name: string): string {
  return leaseFamily(name) === OUTSIDE_DATA_DIR ? OUTSIDE_DATA_DIR : name.slice(0, 200);
}

function emptyFamily(): LeaseWaitFamilySnapshot {
  return {
    acquired: 0,
    timedOut: 0,
    totalWaitMs: 0,
    maxWaitMs: 0,
    buckets: Array.from({ length: LEASE_WAIT_BUCKETS_MS.length + 1 }, () => 0),
  };
}

export class LeaseWaitMetrics {
  private readonly families = new Map<string, LeaseWaitFamilySnapshot>();
  private overflowed = 0;
  private busy = 0;

  private series(name: string): LeaseWaitFamilySnapshot {
    let family = leaseFamily(name);
    if (!this.families.has(family) && this.families.size >= MAX_LEASE_FAMILIES) {
      this.overflowed += 1;
      family = OTHER_FAMILY;
    }
    let series = this.families.get(family);
    if (!series) {
      series = emptyFamily();
      this.families.set(family, series);
    }
    return series;
  }

  private observe(series: LeaseWaitFamilySnapshot, waitMs: number): void {
    const wait = Math.max(0, waitMs);
    series.totalWaitMs += wait;
    series.maxWaitMs = Math.max(series.maxWaitMs, wait);
    const bucket = LEASE_WAIT_BUCKETS_MS.findIndex((limit) => wait <= limit);
    series.buckets[bucket === -1 ? LEASE_WAIT_BUCKETS_MS.length : bucket]! += 1;
  }

  acquired(name: string, waitMs: number): void {
    const series = this.series(name);
    series.acquired += 1;
    this.observe(series, waitMs);
  }

  timedOut(name: string, waitMs: number): void {
    const series = this.series(name);
    series.timedOut += 1;
    this.observe(series, waitMs);
  }

  transactionBusy(): void {
    this.busy += 1;
  }

  snapshot(): LeaseWaitSnapshot {
    const families: Record<string, LeaseWaitFamilySnapshot> = {};
    for (const [family, series] of this.families) {
      families[family] = { ...series, buckets: [...series.buckets] };
    }
    return {
      bucketsMs: LEASE_WAIT_BUCKETS_MS,
      families,
      overflowed: this.overflowed,
      transactionsBusy: this.busy,
    };
  }
}

/** The process-wide counters every {@link StorageDatabase} records into. */
export const leaseWaitMetrics = new LeaseWaitMetrics();
