/**
 * ChangeRetentionService: reachability-based garbage collection with quotas.
 *
 * Roots are the ledger's references (thread baselines, turn endpoints, live
 * segment pins), snapshots of pending capture attempts and in-flight readers.
 * Objects are swept only after a grace fence, so a capture that has written
 * objects but not yet committed its ledger row cannot lose them.
 *
 * Quota pressure is an explicit, observable transition: archived turn
 * endpoints past the retention window are released first, then the oldest
 * finalized turn endpoints; thread baselines and active work stay pinned. A
 * body that is removed answers `body-expired` with its retained counts — never
 * a live-file fallback. If pinned data alone exceeds the hard ceiling, new
 * captures are refused with an explicit reason.
 */

import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { readManifest } from "./capture.js";
import type { ChangeLedger } from "./change-ledger.js";
import { MEASUREMENTS_KEPT_PER_OWNER } from "./measurement-service.js";
import type { ObjectStore } from "./object-store.js";
import type { ChangeTrackingPolicyRegistry } from "./policy-registry.js";
import { ReachabilityCache, type ReachabilityCacheLimits } from "./reachability-cache.js";

const log = createLogger("change-tracking");

/** Superseded measurements are pruned in batches of at most this many file rows. */
const MEASUREMENT_PRUNE_BATCH_FILE_ROWS = 256;
const MEASUREMENT_PRUNE_BATCH = 64;
/** Freed database pages are released in steps of this many 4 KiB pages. */
const RELEASE_PAGES_PER_STEP = 128;

/** Lets requests run between bounded batches of database maintenance. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export interface RetentionReport {
  prunedMeasurements: number;
  prunedMeasurementFiles: number;
  expiredReferences: number;
  releasedForQuota: number;
  deletedSnapshots: number;
  removedObjects: number;
  removedBytes: number;
  storedBytes: number;
  hardLimited: boolean;
}

export class ChangeRetentionService {
  private hardLimited = false;
  private running: Promise<RetentionReport> | null = null;
  private stopped = false;
  /** One drain per owner and scope; a publication during one is picked up by its next batch. */
  private readonly ownerDrains = new Map<string, Promise<void>>();
  /** Object ids by manifest, kept between passes so a pass need not reparse them. */
  private readonly reachability: ReachabilityCache;
  private reachabilityHits = 0;

  constructor(
    private readonly deps: {
      ledger: ChangeLedger;
      store: ObjectStore;
      policies: ChangeTrackingPolicyRegistry;
      readerPins: () => Iterable<string>;
      reachabilityCache?: Partial<ReachabilityCacheLimits>;
    },
  ) {
    this.reachability = new ReachabilityCache(deps.reachabilityCache);
  }

  /** True while pinned data exceeds the hard ceiling; captures are refused. */
  get captureRefused(): boolean {
    return this.hardLimited;
  }

  run(nowMs = Date.now()): Promise<RetentionReport> {
    this.running ??= this.runNow(nowMs).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /**
   * Drains an owner's superseded measurements right after a publication that
   * could not prune them all, so the rows do not wait for the hourly pass. The
   * freed pages are reused by the owner's next measurement; the pass releases
   * what is left.
   */
  drainOwner(owner: { kind: string; id: string; scope: string }): void {
    const key = `${owner.kind}\0${owner.id}\0${owner.scope}`;
    if (this.stopped || this.ownerDrains.has(key)) return;
    const drain = yieldToEventLoop()
      .then(() => this.pruneBatches(Date.now(), owner))
      .then(
        () => undefined,
        (error) => log.warn("measurement-drain.failed", { error: formatLogError(error) }),
      )
      .finally(() => {
        this.ownerDrains.delete(key);
      });
    this.ownerDrains.set(key, drain);
  }

  /** Settle owner drains (tests and benchmarks). */
  async idle(): Promise<void> {
    while (this.ownerDrains.size > 0) await Promise.all(this.ownerDrains.values());
  }

  /** Stops owner drains at their next batch; the database may close after this. */
  stop(): void {
    this.stopped = true;
  }

  private async runNow(nowMs: number): Promise<RetentionReport> {
    const { ledger, store, policies } = this.deps;
    const policy = policies.policy;
    const report: RetentionReport = {
      prunedMeasurements: 0,
      prunedMeasurementFiles: 0,
      expiredReferences: 0,
      releasedForQuota: 0,
      deletedSnapshots: 0,
      removedObjects: 0,
      removedBytes: 0,
      storedBytes: 0,
      hardLimited: false,
    };
    report.expiredReferences = ledger.transaction(() =>
      ledger.expireReferences(new Date(nowMs).toISOString()),
    );
    await this.pruneMeasurements(nowMs, report);

    // Archived turn endpoints beyond the retention window lose their pins.
    const cutoff = new Date(nowMs - policy.archivedBodyRetentionDays * 86_400_000).toISOString();
    report.releasedForQuota += this.releaseTurnEndpoints(
      (turn) => (turn.finished_at ?? turn.started_at) < cutoff,
      Number.POSITIVE_INFINITY,
    );

    // The store keeps this figure current across puts and sweeps (ST-20).
    let stored = await store.currentBytes();
    if (stored > policy.snapshotSoftBudgetBytes) {
      // Release the oldest finalized turn endpoints, a bounded batch per pass.
      report.releasedForQuota += this.releaseTurnEndpoints(() => true, 64);
    }

    await this.sweep(nowMs, report);
    stored = await store.currentBytes();
    report.storedBytes = stored;
    this.hardLimited = stored > policy.snapshotHardBudgetBytes;
    report.hardLimited = this.hardLimited;
    ledger.transaction(() => {
      ledger.pruneOutbox(10_000);
      ledger.pruneLiveIdentities(new Date(nowMs - 86_400_000).toISOString());
    });
    return report;
  }

  /**
   * Prunes superseded measurements in bounded batches, yielding between
   * them: a backlog can be tens of millions of file rows, and one long
   * transaction would block every request. Then returns the freed pages to
   * the filesystem, again in steps.
   */
  private async pruneMeasurements(nowMs: number, report: RetentionReport): Promise<void> {
    const { ledger } = this.deps;
    const pruned = await this.pruneBatches(nowMs);
    report.prunedMeasurements += pruned.measurements;
    report.prunedMeasurementFiles += pruned.files;
    // Also when this pass pruned nothing: publications and owner drains free pages too.
    let previous = Number.POSITIVE_INFINITY;
    while (true) {
      const left = ledger.releaseFreePages(RELEASE_PAGES_PER_STEP);
      // Stop once nothing is left or a step makes no progress (a busy writer).
      if (left === 0 || left >= previous) break;
      previous = left;
      await yieldToEventLoop();
    }
  }

  private async pruneBatches(
    nowMs: number,
    owner?: { kind: string; id: string; scope: string },
  ): Promise<{ measurements: number; files: number }> {
    const total = { measurements: 0, files: 0 };
    while (!this.stopped) {
      const pruned = this.deps.ledger.pruneSupersededMeasurements({
        keepLatest: MEASUREMENTS_KEPT_PER_OWNER,
        nowIso: new Date(nowMs).toISOString(),
        maxMeasurements: MEASUREMENT_PRUNE_BATCH,
        maxFileRows: MEASUREMENT_PRUNE_BATCH_FILE_ROWS,
        ...(owner ? { owner } : {}),
      });
      total.measurements += pruned.measurements;
      total.files += pruned.files;
      if (pruned.measurements === 0 && pruned.files === 0) break;
      await yieldToEventLoop();
    }
    return total;
  }

  private releaseTurnEndpoints(
    eligible: (turn: { finished_at: string | null; started_at: string }) => boolean,
    limit: number,
  ): number {
    const { ledger } = this.deps;
    let released = 0;
    const rows = ledger.turnsByAge();
    for (const turn of rows) {
      if (released >= limit) break;
      if (!["finalized", "interrupted", "end-unavailable", "abandoned"].includes(turn.lifecycle))
        continue;
      if (!eligible(turn)) continue;
      const removed = ledger.transaction(() => ledger.removeReferences("turn", turn.turn_id));
      if (removed > 0) released++;
    }
    return released;
  }

  private async sweep(nowMs: number, report: RetentionReport): Promise<void> {
    const { ledger, store, policies } = this.deps;
    const graceMs = policies.policy.orphanGraceMs;
    const referenced = ledger.referencedSnapshotIds();
    for (const id of this.deps.readerPins()) referenced.add(id);
    for (const attempt of ledger.pendingCaptures())
      if (attempt.snapshot_id) referenced.add(attempt.snapshot_id);
    for (const turn of ledger.activeTurns()) {
      if (turn.start_snapshot_id) referenced.add(turn.start_snapshot_id);
      if (turn.end_snapshot_id) referenced.add(turn.end_snapshot_id);
    }
    for (const window of ledger.allOpenWindows()) {
      if (window.before_snapshot_id) referenced.add(window.before_snapshot_id);
    }
    // Snapshot rows nothing references, older than the grace window, are retired.
    const reachable = new Set<string>();
    const walked = new Set<string>();
    this.reachability.beginPass();
    for (const snapshot of ledger.snapshots()) {
      const age = nowMs - Date.parse(snapshot.created_at);
      if (!referenced.has(snapshot.id) && age > graceMs) {
        ledger.transaction(() => ledger.deleteSnapshot(snapshot.id));
        report.deletedSnapshots++;
        continue;
      }
      reachable.add(snapshot.tree_oid);
      // Snapshots of an unchanged tree share one manifest: read it once per pass.
      // Kept apart from `reachable`, where a blob could have the same id.
      if (walked.has(snapshot.tree_oid)) continue;
      walked.add(snapshot.tree_oid);
      await this.addManifestObjects(snapshot.tree_oid, reachable);
    }
    // Only a completed walk may drop what it did not see.
    this.reachability.endPass();
    // Live-detail blobs are referenced by diff identities, not snapshots.
    for (const blob of ledger.diffIdentityBlobs()) reachable.add(blob);
    const swept = await store.sweep(reachable, graceMs, nowMs);
    report.removedObjects = swept.removed;
    report.removedBytes = swept.bytes;
  }

  /**
   * The objects one manifest names, from the reachability cache when it holds
   * them. A hit still requires the manifest object, so a manifest that is gone
   * contributes nothing, exactly as a read would.
   */
  private async addManifestObjects(manifestId: string, reachable: Set<string>): Promise<void> {
    const { store } = this.deps;
    if (!(await store.has(manifestId))) {
      this.reachability.forget(manifestId);
      return;
    }
    if (this.reachability.addTo(manifestId, reachable)) {
      this.reachabilityHits++;
      return;
    }
    const manifest = await readManifest(store, manifestId, { scan: true });
    if (!manifest) return;
    const oids: string[] = [];
    for (const entry of manifest.entries) if (entry.m !== "160000") oids.push(entry.o);
    for (const oid of oids) reachable.add(oid);
    this.reachability.remember(manifestId, oids);
  }

  /** For tests and benchmarks: the reachability cache's sizes and hits. */
  reachabilityStats() {
    return { ...this.reachability.snapshot(), hits: this.reachabilityHits };
  }
}
