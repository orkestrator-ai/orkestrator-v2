/**
 * Startup recovery and hourly cleanup for transcript artifacts.
 *
 * - Unfinished operations whose lease lapsed become `interrupted` (never re-run).
 * - Staging files older than one hour that no write in this process holds are removed.
 * - Unpublished drafts idle for seven days expire; their request keys keep a
 *   compact `expired` tombstone so a retry is never treated as new work.
 *   Staged upload references expire after seven days too.
 * - Asset bytes no durable record references are marked, and removed only
 *   when still unreferenced 24 hours later: references are recomputed from
 *   the database inside the same write transaction that unlinks, so another
 *   conversation's (deduplicated) bytes or a concurrent commit are never lost.
 *   Bytes promoted for a commit still in flight are skipped.
 * Published revisions keep their source, receipt and evidence for the
 * conversation's lifetime.
 */
import { stat, rm } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACT_RETENTION_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { isTerminalArtifactOperationStatus } from "@orkestrator/protocol/transcript-artifacts";
import { logArtifactEvent } from "./metrics.js";
import type { ArtifactServiceContext } from "./service-context.js";
import { STAGED_ASSET_TTL_MS } from "./service-assets.js";
import type { ArtifactPreviews } from "./service-preview.js";
import type { EnvironmentRecords } from "./store.js";

export interface ArtifactCleanupReport {
  environments: number;
  interrupted: number;
  stagingRemoved: number;
  draftsExpired: number;
  assetsMarked: number;
  assetsRemoved: number;
}

/** Every asset SHA-256 a durable record references in this environment. */
export function referencedAssets(records: EnvironmentRecords): Set<string> {
  const referenced = new Set<string>();
  for (const revision of records.list("revision")) {
    for (const asset of revision.assets) referenced.add(asset.sha256);
  }
  for (const derived of records.list("derived")) {
    for (const prepared of derived.prepared) referenced.add(prepared.documentSha256);
    for (const printed of derived.printed ?? []) referenced.add(printed.sha256);
  }
  for (const receipt of records.list("receipt")) {
    referenced.add(receipt.identity.effectiveSourceHash);
    const evidence = receipt.evidence;
    if (evidence.kind === "html-static" || evidence.kind === "html-interactive") {
      for (const capture of evidence.captures) referenced.add(capture.sha256);
    } else if (evidence.kind === "mermaid" || evidence.kind === "chart") {
      referenced.add(evidence.rendererOutput.sha256);
      for (const capture of evidence.captures ?? []) referenced.add(capture.sha256);
    }
  }
  for (const operation of records.list("operation")) {
    for (const capture of operation.diagnosticCaptures ?? []) referenced.add(capture.sha256);
  }
  for (const staged of records.list("staged")) referenced.add(staged.sha256);
  return referenced;
}

export class ArtifactGarbageCollector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<ArtifactCleanupReport> | null = null;

  constructor(
    private readonly ctx: ArtifactServiceContext,
    private readonly previews: ArtifactPreviews,
  ) {}

  /** Startup pass now, a second recovery pass once stale leases lapse, then hourly. */
  start(): void {
    if (this.timer) return;
    void this.run().catch(() => undefined);
    this.recoveryTimer = setTimeout(() => {
      for (const environmentId of this.ctx.store.environmentIds())
        this.previews.recover(environmentId);
    }, this.ctx.leaseMs + 1_000);
    this.recoveryTimer.unref?.();
    this.timer = setInterval(
      () => void this.run().catch(() => undefined),
      ARTIFACT_RETENTION_POLICY.cleanupIntervalMs,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.timer = null;
    this.recoveryTimer = null;
  }

  run(): Promise<ArtifactCleanupReport> {
    if (this.running) return this.running;
    this.running = this.runOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runOnce(): Promise<ArtifactCleanupReport> {
    const report: ArtifactCleanupReport = {
      environments: 0,
      interrupted: 0,
      stagingRemoved: 0,
      draftsExpired: 0,
      assetsMarked: 0,
      assetsRemoved: 0,
    };
    for (const environmentId of await this.ctx.store.knownEnvironmentIds()) {
      if (this.ctx.store.isDeleted(environmentId)) continue;
      report.environments += 1;
      try {
        report.interrupted += this.previews.recover(environmentId);
        report.stagingRemoved += await this.cleanStaging(environmentId);
        report.draftsExpired += this.expireDrafts(environmentId);
        this.expireStagedAssets(environmentId);
        this.pruneOutbox(environmentId);
        const assets = await this.sweepAssets(environmentId);
        report.assetsMarked += assets.marked;
        report.assetsRemoved += assets.removed;
      } catch (error) {
        logArtifactEvent("cleanup-failed", {
          environmentId,
          reason: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    try {
      this.ctx.grants.prune();
    } catch {
      // Grant pruning is best effort; verification checks expiry itself.
    }
    if (report.stagingRemoved)
      this.ctx.metrics.increment("gc_staging_removed", {}, report.stagingRemoved);
    if (report.draftsExpired)
      this.ctx.metrics.increment("gc_drafts_expired", {}, report.draftsExpired);
    if (report.assetsRemoved)
      this.ctx.metrics.increment("gc_assets_removed", {}, report.assetsRemoved);
    return report;
  }

  private async cleanStaging(environmentId: string): Promise<number> {
    const directory = this.ctx.store.stagingDirectory(environmentId);
    let removed = 0;
    for (const name of await this.ctx.store.listStagingFiles(environmentId)) {
      if (this.ctx.store.isActiveStaging(name)) continue;
      const file = join(directory, name);
      try {
        const info = await stat(file);
        if (this.ctx.now() - info.mtimeMs < ARTIFACT_RETENTION_POLICY.abandonedStagingMs) continue;
        if (this.ctx.store.isActiveStaging(name)) continue;
        await rm(file, { force: true });
        removed += 1;
      } catch {
        // Already gone.
      }
    }
    return removed;
  }

  expireDrafts(environmentId: string): number {
    const cutoff = this.ctx.now() - ARTIFACT_RETENTION_POLICY.unpublishedDraftMs;
    return this.ctx.store.transact(environmentId, (records) => {
      const operations = records.list("operation");
      let expired = 0;
      for (const head of records.list("head")) {
        if (head.publishedRevision !== null || Date.parse(head.updatedAt) > cutoff) continue;
        const ownOperations = operations.filter(
          (operation) => operation.artifactId === head.artifactId,
        );
        if (ownOperations.some((operation) => !isTerminalArtifactOperationStatus(operation.status)))
          continue;
        const prefix = `${head.artifactId}/`;
        for (const key of records.keys("revision"))
          if (key.startsWith(prefix)) records.delete("revision", key);
        for (const key of records.keys("derived"))
          if (key.startsWith(prefix)) records.delete("derived", key);
        for (const key of records.keys("repair"))
          if (key.startsWith(prefix)) records.delete("repair", key);
        for (const receipt of records.list("receipt")) {
          if (receipt.artifactId === head.artifactId) records.delete("receipt", receipt.receiptId);
        }
        for (const operation of ownOperations) records.delete("operation", operation.operationId);
        for (const row of records.list("idempotency", { owner: head.owner.conversationKey })) {
          if (row.artifactId !== head.artifactId || row.state === "expired") continue;
          const { response: _response, isError: _isError, ...rest } = row;
          records.put("idempotency", row.key, { ...rest, state: "expired" }, row.conversationKey);
        }
        records.delete("head", head.artifactId);
        expired += 1;
      }
      return expired;
    });
  }

  /** Staged upload references expire like unpublished drafts; revisions keep their own copies. */
  expireStagedAssets(environmentId: string): number {
    return this.ctx.store.transact(environmentId, (records) => {
      let expired = 0;
      for (const row of records.list("staged")) {
        if (this.ctx.now() - Date.parse(row.createdAt) < STAGED_ASSET_TTL_MS) continue;
        records.delete("staged", row.stagedId);
        expired += 1;
      }
      return expired;
    });
  }

  private pruneOutbox(environmentId: string): void {
    const cutoff = this.ctx.now() - ARTIFACT_RETENTION_POLICY.unreferencedPreviewAssetMs;
    this.ctx.store.transact(environmentId, (records) => {
      for (const event of records.list("outbox")) {
        if (Date.parse(event.createdAt) < cutoff) records.delete("outbox", event.eventId);
      }
      // A request-key reservation whose holder died lapses; drop it so the
      // key (and the per-conversation request bound) is free again.
      for (const row of records.list("idempotency")) {
        if (
          row.state === "pending" &&
          Date.parse(row.reservation?.expiresAt ?? "") <= this.ctx.now()
        ) {
          records.delete("idempotency", row.key);
        }
      }
    });
  }

  /** Mark, then unlink only what is still unreferenced, re-checked under the write lock. */
  async sweepAssets(environmentId: string): Promise<{ marked: number; removed: number }> {
    const files = await this.ctx.store.listAssetFiles(environmentId);
    const graceMs = ARTIFACT_RETENTION_POLICY.unreferencedPreviewAssetMs;
    const now = this.ctx.now();
    const nowIso = new Date(now).toISOString();
    return this.ctx.store.transact(environmentId, (records) => {
      const referenced = referencedAssets(records);
      let marked = 0;
      let removed = 0;
      const rows = records.list("asset");
      const known = new Set<string>();
      for (const row of rows) {
        known.add(row.sha256);
        if (referenced.has(row.sha256)) {
          if (row.unreferencedSince !== null)
            records.put("asset", row.sha256, { ...row, unreferencedSince: null });
          continue;
        }
        if (row.unreferencedSince === null) {
          records.put("asset", row.sha256, { ...row, unreferencedSince: nowIso });
          marked += 1;
          continue;
        }
        if (now - Date.parse(row.unreferencedSince) < graceMs) continue;
        if (
          this.ctx.store.isPending(environmentId, row.sha256) ||
          this.recentlyWritten(environmentId, row.sha256, now, graceMs)
        )
          continue;
        this.ctx.store.unlinkAssetInTransaction(records, row.sha256);
        removed += 1;
      }
      // Files no row describes: promoted for a commit that never happened.
      for (const sha256 of files) {
        if (known.has(sha256) || referenced.has(sha256)) continue;
        if (
          this.ctx.store.isPending(environmentId, sha256) ||
          this.recentlyWritten(environmentId, sha256, now, graceMs)
        )
          continue;
        this.ctx.store.unlinkAssetInTransaction(records, sha256);
        removed += 1;
      }
      return { marked, removed };
    });
  }

  private recentlyWritten(
    environmentId: string,
    sha256: string,
    now: number,
    graceMs: number,
  ): boolean {
    try {
      return now - lstatSync(this.ctx.store.assetPath(environmentId, sha256)).mtimeMs < graceMs;
    } catch {
      return false;
    }
  }
}
