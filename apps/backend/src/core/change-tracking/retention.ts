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

import { readManifest } from "./capture.js";
import type { ChangeLedger } from "./change-ledger.js";
import type { ObjectStore } from "./object-store.js";
import type { ChangeTrackingPolicyRegistry } from "./policy-registry.js";

export interface RetentionReport {
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

  constructor(
    private readonly deps: {
      ledger: ChangeLedger;
      store: ObjectStore;
      policies: ChangeTrackingPolicyRegistry;
      readerPins: () => Iterable<string>;
    },
  ) {}

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

  private async runNow(nowMs: number): Promise<RetentionReport> {
    const { ledger, store, policies } = this.deps;
    const policy = policies.policy;
    const report: RetentionReport = {
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

    // Archived turn endpoints beyond the retention window lose their pins.
    const cutoff = new Date(nowMs - policy.archivedBodyRetentionDays * 86_400_000).toISOString();
    report.releasedForQuota += this.releaseTurnEndpoints(
      (turn) => (turn.finished_at ?? turn.started_at) < cutoff,
      Number.POSITIVE_INFINITY,
    );

    let stored = await store.storedBytes();
    if (stored > policy.snapshotSoftBudgetBytes) {
      // Release the oldest finalized turn endpoints, a bounded batch per pass.
      report.releasedForQuota += this.releaseTurnEndpoints(() => true, 64);
    }

    await this.sweep(nowMs, report);
    stored = await store.storedBytes();
    report.storedBytes = stored;
    this.hardLimited = stored > policy.snapshotHardBudgetBytes;
    report.hardLimited = this.hardLimited;
    ledger.transaction(() => {
      ledger.pruneOutbox(10_000);
      ledger.pruneLiveIdentities(new Date(nowMs - 86_400_000).toISOString());
    });
    return report;
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
    for (const snapshot of ledger.snapshots()) {
      const age = nowMs - Date.parse(snapshot.created_at);
      if (!referenced.has(snapshot.id) && age > graceMs) {
        ledger.transaction(() => ledger.deleteSnapshot(snapshot.id));
        report.deletedSnapshots++;
        continue;
      }
      reachable.add(snapshot.tree_oid);
      const manifest = await readManifest(store, snapshot.tree_oid);
      for (const entry of manifest?.entries ?? []) if (entry.m !== "160000") reachable.add(entry.o);
    }
    // Live-detail blobs are referenced by diff identities, not snapshots.
    for (const blob of ledger.diffIdentityBlobs()) reachable.add(blob);
    const swept = await store.sweep(reachable, graceMs, nowMs);
    report.removedObjects = swept.removed;
    report.removedBytes = swept.bytes;
  }
}
