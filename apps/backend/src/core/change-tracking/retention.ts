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
 *
 * Each pass also purges deleted environments and retires ledger rows past the
 * archive window, in bounded batches ({@link LedgerRetirement}). Both delete only
 * rows and references; the reachability sweeps here take the snapshots, objects
 * and evidence bodies nothing names any more, so shared content survives.
 */

import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { readManifest } from "./capture.js";
import type { ChangeLedger, MeasurementOwnerCursor } from "./change-ledger.js";
import type { EvidenceBodyStore } from "./evidence-body-store.js";
import {
  LedgerRetirement,
  type EnvironmentPurge,
  type RetirementBatch,
} from "./ledger-retirement.js";
import { MEASUREMENTS_KEPT_PER_OWNER } from "./measurement-service.js";
import type { ObjectStore } from "./object-store.js";
import type { ChangeTrackingPolicyRegistry } from "./policy-registry.js";
import { ReachabilityCache, type ReachabilityCacheLimits } from "./reachability-cache.js";

const log = createLogger("change-tracking");

/** Superseded measurements are pruned in batches of at most this many file rows. */
const MEASUREMENT_PRUNE_BATCH_FILE_ROWS = 256;
const MEASUREMENT_PRUNE_BATCH = 64;
/** Owners read per page of the hourly pass's walk for superseded measurements. */
const MEASUREMENT_OWNERS_PER_PAGE = 512;
/**
 * How long after a turn ends its superseded measurements stay, for a reader
 * that was paging one or read the history just before the final measurement
 * was selected (restore tokens last five minutes). Then the hourly pass keeps
 * only the turn's newest and selected ones (todo 4960).
 */
export const FINISHED_TURN_SUPERSEDED_GRACE_MS = 15 * 60_000;
/** Freed database pages are released in steps of this many 4 KiB pages. */
const RELEASE_PAGES_PER_STEP = 128;
/** Ledger rows deleted per transaction by a purge or age-based retention. */
const RETIREMENT_ROWS_PER_BATCH = 256;
/** A first run on an old ledger faces its whole backlog: later passes take the rest. */
const RETIREMENT_BATCHES_PER_PASS = 4_096;
/** Finished turns whose endpoints quota pressure releases, per transaction and per pass. */
const QUOTA_RELEASE_BATCH = 16;
const QUOTA_RELEASES_PER_PASS = 64;
const SNAPSHOTS_PER_TRANSACTION = 32;
const DIFF_IDENTITIES_PER_PAGE = 512;
const LIVE_IDENTITY_AGE_MS = 86_400_000;

/** Lets requests run between bounded batches of database maintenance. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export interface RetentionReport {
  prunedMeasurements: number;
  prunedMeasurementFiles: number;
  purgedEnvironments: number;
  /** Rows age-based retention and environment purges deleted. */
  retiredRows: number;
  /** A purge has work this pass could not do: a restore holds it, or its batches ran out. */
  purgesWaiting: boolean;
  expiredReferences: number;
  releasedForQuota: number;
  deletedSnapshots: number;
  removedObjects: number;
  removedBytes: number;
  removedBodies: number;
  removedBodyBytes: number;
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
  private readonly retirement: LedgerRetirement;

  constructor(
    private readonly deps: {
      ledger: ChangeLedger;
      store: ObjectStore;
      bodies?: EvidenceBodyStore;
      policies: ChangeTrackingPolicyRegistry;
      readerPins: () => Iterable<string>;
      onPurgeFinished?: (environmentId: string) => void;
      reachabilityCache?: Partial<ReachabilityCacheLimits>;
    },
  ) {
    this.reachability = new ReachabilityCache(deps.reachabilityCache);
    this.retirement = new LedgerRetirement(deps.ledger);
  }

  /** The ledger queries behind purges, for the delete path that requests one. */
  get purges(): LedgerRetirement {
    return this.retirement;
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
  drainOwner(owner: MeasurementOwnerCursor): void {
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
      purgedEnvironments: 0,
      retiredRows: 0,
      purgesWaiting: false,
      expiredReferences: 0,
      releasedForQuota: 0,
      deletedSnapshots: 0,
      removedObjects: 0,
      removedBytes: 0,
      removedBodies: 0,
      removedBodyBytes: 0,
      storedBytes: 0,
      hardLimited: false,
    };
    this.retirement.ensureIndexes();
    report.expiredReferences = ledger.transaction(() =>
      ledger.expireReferences(new Date(nowMs).toISOString()),
    );
    await this.pruneMeasurements(nowMs, report);

    const batches = { left: RETIREMENT_BATCHES_PER_PASS };
    const finishedPurges = await this.purgeEnvironments(nowMs, report, batches);
    // Past the window a turn's rows go, which releases its endpoints too.
    await this.retireExpired(nowMs, report, batches);

    // The store keeps this figure current across puts and sweeps (ST-20).
    let stored = await store.currentBytes();
    if (stored > policy.snapshotSoftBudgetBytes) {
      // Release the oldest finalized turn endpoints, a bounded batch per pass.
      report.releasedForQuota += await this.releaseForQuota();
    }

    await this.sweep(nowMs, report);
    await this.sweepBodies(nowMs, report);
    // After the sweep, which took the snapshots naming their worktrees.
    for (const purge of finishedPurges) {
      this.retirement.finishPurge(purge);
      this.deps.onPurgeFinished?.(purge.environmentId);
      report.purgedEnvironments++;
    }
    stored = await store.currentBytes();
    report.storedBytes = stored;
    this.hardLimited = stored > policy.snapshotHardBudgetBytes;
    report.hardLimited = this.hardLimited;
    ledger.transaction(() => ledger.pruneOutbox(10_000));
    await this.pruneLiveIdentities(nowMs);
    await this.releaseFreePages();
    return report;
  }

  /**
   * Each pending purge, in bounded batches. A restore that still needs one of the
   * environment's measurements defers it to a later pass. An entry outlives its
   * rows by the orphan grace: a late write already under way when the environment
   * was deleted lands before that, and the next pass finds it. Returns the purges
   * that can finish.
   */
  private async purgeEnvironments(
    nowMs: number,
    report: RetentionReport,
    batches: { left: number },
  ): Promise<EnvironmentPurge[]> {
    const finished: EnvironmentPurge[] = [];
    const nowIso = new Date(nowMs).toISOString();
    const graceMs = this.deps.policies.policy.orphanGraceMs;
    for (const purge of this.retirement.pendingPurges()) {
      if (this.stopped) break;
      if (this.retirement.environmentHeld(purge.environmentId, nowIso)) {
        report.purgesWaiting = true;
        continue;
      }
      if (!(await this.purgeEnvironment(purge, report, batches, nowIso))) {
        report.purgesWaiting = true;
        continue;
      }
      if (nowMs - Date.parse(purge.requestedAt) > graceMs) finished.push(purge);
    }
    return finished;
  }

  /** True once none of the environment's rows are left. */
  private async purgeEnvironment(
    purge: EnvironmentPurge,
    report: RetentionReport,
    batches: { left: number },
    nowIso: string,
  ): Promise<boolean> {
    const { environmentId } = purge;
    const complete = await this.retireInBatches(report, batches, () =>
      this.retirement.purgeEnvironmentBatch(environmentId, RETIREMENT_ROWS_PER_BATCH, nowIso),
    );
    if (!complete) return false;
    if (!this.retirement.hasLegacySummaries(environmentId)) return true;
    let after: number | null = 0;
    while (after !== null) {
      if (this.stopped || batches.left <= 0) return false;
      batches.left--;
      const outcome = this.deps.ledger.transaction(() => {
        if (this.retirement.environmentHeld(environmentId, nowIso)) return { held: true };
        return { next: this.retirement.retireLegacySummariesPage(environmentId, after!) };
      });
      if (outcome.held) return false;
      after = outcome.next!;
      await yieldToEventLoop();
    }
    return true;
  }

  /** Rows of finished work past the archive window, oldest first. */
  private async retireExpired(
    nowMs: number,
    report: RetentionReport,
    batches: { left: number },
  ): Promise<void> {
    const { retirement } = this;
    const nowIso = new Date(nowMs).toISOString();
    const windowMs = this.deps.policies.policy.archivedBodyRetentionDays * 86_400_000;
    const cutoff = new Date(nowMs - windowMs).toISOString();
    const rows = RETIREMENT_ROWS_PER_BATCH;
    let afterOperation = 0;
    let afterEvidence = 0;
    const steps: Array<() => RetirementBatch> = [
      () => retirement.retireExpiredFrames(cutoff, rows),
      () => {
        const batch = retirement.retireExpiredTurns(cutoff, nowIso, rows);
        report.releasedForQuota += batch.released;
        return batch;
      },
      () => {
        const batch = retirement.retireExpiredOperations(cutoff, nowIso, afterOperation, rows);
        afterOperation = batch.next;
        return batch;
      },
      () => {
        const batch = retirement.retireExpiredProviderTurns(nowIso, afterEvidence, rows);
        afterEvidence = batch.next;
        return batch;
      },
      () => retirement.retireExpiredSegments(cutoff, nowIso, rows),
      () => retirement.retireExpiredRecords(cutoff, rows),
    ];
    for (const step of steps) await this.retireInBatches(report, batches, step);
  }

  /** Runs `batch` until it is done, yielding between transactions. False if it was cut short. */
  private async retireInBatches(
    report: RetentionReport,
    batches: { left: number },
    batch: () => RetirementBatch,
  ): Promise<boolean> {
    while (!this.stopped && batches.left > 0) {
      batches.left--;
      const outcome = batch();
      report.retiredRows += outcome.rows;
      await yieldToEventLoop();
      if (outcome.held) return false;
      if (outcome.done) return true;
    }
    return false;
  }

  /** Oldest finished turns first; their rows stay, only their endpoints go. */
  private async releaseForQuota(): Promise<number> {
    let released = 0;
    let after: readonly [string, string] | null = null;
    while (!this.stopped && released < QUOTA_RELEASES_PER_PASS) {
      const limit = Math.min(QUOTA_RELEASE_BATCH, QUOTA_RELEASES_PER_PASS - released);
      const batch = this.retirement.releaseOldestTurnEndpoints(limit, after);
      released += batch.released;
      after = batch.next;
      if (batch.released < limit) break;
      await yieldToEventLoop();
    }
    return released;
  }

  /**
   * Prunes superseded measurements in bounded batches, yielding between
   * them: a backlog can be tens of millions of file rows, and one long
   * transaction would block every request.
   */
  private async pruneMeasurements(nowMs: number, report: RetentionReport): Promise<void> {
    const pruned = await this.pruneBatches(nowMs);
    report.prunedMeasurements += pruned.measurements;
    report.prunedMeasurementFiles += pruned.files;
    const finished = await this.pruneFinishedTurns(nowMs);
    report.prunedMeasurements += finished.measurements;
    report.prunedMeasurementFiles += finished.files;
  }

  /**
   * A finished turn keeps two measurements like any owner, but the older one
   * (its provisional list, up to the file row cap) is never selected again,
   * and the turn stays for the whole archive window. Past the grace each
   * finished turn keeps only its newest measurement and any a selection,
   * restore or reader still holds.
   */
  private async pruneFinishedTurns(
    nowMs: number,
  ): Promise<{ measurements: number; files: number }> {
    const total = { measurements: 0, files: 0 };
    const finishedBefore = new Date(nowMs - FINISHED_TURN_SUPERSEDED_GRACE_MS).toISOString();
    let after: MeasurementOwnerCursor | null = null;
    do {
      if (this.stopped) break;
      const page: ReturnType<ChangeLedger["finishedTurnOwnersPage"]> =
        this.deps.ledger.finishedTurnOwnersPage(after, finishedBefore, MEASUREMENT_OWNERS_PER_PAGE);
      for (const owner of page.owners) {
        const pruned = await this.pruneOwner(nowMs, owner, 1);
        total.measurements += pruned.measurements;
        total.files += pruned.files;
      }
      after = page.next;
      await yieldToEventLoop();
    } while (after);
    return total;
  }

  /**
   * Returns freed pages to the filesystem in steps, after everything this pass
   * deleted. Also when it deleted nothing: publications and owner drains free
   * pages too.
   */
  private async releaseFreePages(): Promise<void> {
    const { ledger } = this.deps;
    let previous = Number.POSITIVE_INFINITY;
    while (true) {
      const left = ledger.releaseFreePages(RELEASE_PAGES_PER_STEP);
      // Stop once nothing is left or a step makes no progress (a busy writer).
      if (left <= 0 || left >= previous) break;
      previous = left;
      await yieldToEventLoop();
    }
    // The ledger is the database with joins and range scans, so keep its
    // planner statistics current as it grows and shrinks. Cheap when nothing
    // changed much.
    ledger.optimize();
  }

  /**
   * Every owner's superseded measurements, or one owner's. The hourly pass
   * finds owners with more than they keep a page of the owner index at a time,
   * yielding between pages, then prunes each through its own index range.
   */
  private async pruneBatches(
    nowMs: number,
    owner?: MeasurementOwnerCursor,
  ): Promise<{ measurements: number; files: number }> {
    if (owner) return this.pruneOwner(nowMs, owner);
    const total = { measurements: 0, files: 0 };
    let after: MeasurementOwnerCursor | null = null;
    do {
      if (this.stopped) break;
      const page: ReturnType<ChangeLedger["supersededOwnersPage"]> =
        this.deps.ledger.supersededOwnersPage(
          after,
          MEASUREMENTS_KEPT_PER_OWNER,
          MEASUREMENT_OWNERS_PER_PAGE,
        );
      for (const superseded of page.owners) {
        const pruned = await this.pruneOwner(nowMs, superseded);
        total.measurements += pruned.measurements;
        total.files += pruned.files;
      }
      after = page.next;
      await yieldToEventLoop();
    } while (after);
    return total;
  }

  private async pruneOwner(
    nowMs: number,
    owner: MeasurementOwnerCursor,
    keepLatest = MEASUREMENTS_KEPT_PER_OWNER,
  ): Promise<{ measurements: number; files: number }> {
    const total = { measurements: 0, files: 0 };
    while (!this.stopped) {
      const pruned = this.deps.ledger.pruneSupersededMeasurements({
        keepLatest,
        nowIso: new Date(nowMs).toISOString(),
        maxMeasurements: MEASUREMENT_PRUNE_BATCH,
        maxFileRows: MEASUREMENT_PRUNE_BATCH_FILE_ROWS,
        owner,
      });
      total.measurements += pruned.measurements;
      total.files += pruned.files;
      if (pruned.measurements === 0 && pruned.files === 0) break;
      await yieldToEventLoop();
    }
    return total;
  }

  private async sweep(nowMs: number, report: RetentionReport): Promise<void> {
    const { ledger, store, policies } = this.deps;
    const graceMs = policies.policy.orphanGraceMs;
    const referenced = ledger.referencedSnapshotIds();
    for (const id of this.deps.readerPins()) referenced.add(id);
    for (const id of this.retirement.heldSnapshots(new Date(nowMs).toISOString()))
      referenced.add(id);
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
    let retiring: string[] = [];
    const retire = async () => {
      const ids = retiring;
      retiring = [];
      ledger.transaction(() => {
        for (const id of ids) ledger.deleteSnapshot(id);
      });
      report.deletedSnapshots += ids.length;
      await yieldToEventLoop();
    };
    for (const snapshot of ledger.snapshotAges()) {
      const age = nowMs - Date.parse(snapshot.created_at);
      if (!referenced.has(snapshot.id) && age > graceMs) {
        retiring.push(snapshot.id);
        if (retiring.length >= SNAPSHOTS_PER_TRANSACTION) await retire();
        continue;
      }
      reachable.add(snapshot.tree_oid);
      // Snapshots of an unchanged tree share one manifest: read it once per pass.
      // Kept apart from `reachable`, where a blob could have the same id.
      if (walked.has(snapshot.tree_oid)) continue;
      walked.add(snapshot.tree_oid);
      await this.addManifestObjects(snapshot.tree_oid, reachable);
    }
    if (retiring.length > 0) await retire();
    // Only a completed walk may drop what it did not see.
    this.reachability.endPass();
    // Live-detail blobs are referenced by diff identities, not snapshots.
    let afterIdentity: number | null = 0;
    while (afterIdentity !== null) {
      const page: { blobs: string[]; next: number | null } = ledger.diffIdentityBlobsPage(
        afterIdentity,
        DIFF_IDENTITIES_PER_PAGE,
      );
      for (const blob of page.blobs) reachable.add(blob);
      afterIdentity = page.next;
      if (afterIdentity !== null) await yieldToEventLoop();
    }
    const swept = await store.sweep(reachable, graceMs, nowMs);
    report.removedObjects = swept.removed;
    report.removedBytes = swept.bytes;
  }

  /**
   * Evidence bodies are content-addressed, so one can be shared: only a body no
   * evidence row names goes, past the grace fence that covers a body stored just
   * before the row naming it commits. A frame's raw slice has no row naming it; no
   * producer sends one today, and nothing reads one.
   */
  private async sweepBodies(nowMs: number, report: RetentionReport): Promise<void> {
    const { bodies, policies } = this.deps;
    if (!bodies) return;
    const { retirement } = this;
    const reachable = new Set<string>();
    for (const list of [
      (after: number) => retirement.evidenceBodiesPage(after),
      (after: number) => retirement.chunkBodiesPage(after),
    ]) {
      let after: number | null = 0;
      while (after !== null) {
        const page: { ids: string[]; next: number | null } = list(after);
        for (const id of page.ids) reachable.add(id);
        after = page.next;
        await yieldToEventLoop();
      }
    }
    const graceMs = policies.policy.orphanGraceMs;
    const swept = await bodies.sweep(reachable, graceMs, nowMs, (id) => retirement.forgetBody(id));
    report.removedBodies = swept.removed;
    report.removedBodyBytes = swept.bytes;
    const olderThan = new Date(nowMs - graceMs).toISOString();
    let after: number | null = 0;
    while (after !== null) {
      after = retirement.retireUnstoredBodiesPage(reachable, olderThan, after);
      await yieldToEventLoop();
    }
  }

  /** Live-detail identities are transient views. The walk takes a page per transaction. */
  private async pruneLiveIdentities(nowMs: number): Promise<void> {
    const olderThan = new Date(nowMs - LIVE_IDENTITY_AGE_MS).toISOString();
    let after: number | null = 0;
    while (after !== null) {
      after = this.deps.ledger.pruneLiveIdentitiesPage(olderThan, after, DIFF_IDENTITIES_PER_PAGE);
      if (after !== null) await yieldToEventLoop();
    }
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
      await store.invalidateBytes();
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
