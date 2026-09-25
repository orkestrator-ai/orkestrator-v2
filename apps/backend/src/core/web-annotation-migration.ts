/**
 * Legacy browser-annotation migration (plan step 09, backend side).
 *
 * Browser notes used to be copied into every open native compose draft as
 * `TranscriptAnnotation { source: "browser" }` plus a screenshot attachment.
 * This moves them into durable threads without losing notes, evidence, or
 * uncertain sends:
 *
 * 1. Read a draft at revision R; derive import identity
 *    (environmentId, legacyAnnotationId) and variant hashes.
 * 2. Commit imported records and a migration receipt (draft key, revision,
 *    legacy ids, content-free screenshot references, and the native session
 *    ownership seen at inventory time). Re-running is a no-op.
 * 3. Compare-and-swap the source draft at R, replacing only the imported
 *    browser annotations with lightweight migrated references (`migratedTo`)
 *    and removing their linked attachments. A changed draft is left
 *    untouched and retried later from its new revision.
 * 4. Record completion after cleanup.
 *
 * Drafts whose native session has a pending/unknown dispatch are imported
 * read-only and never mutated. Older clients that re-persist an imported
 * note are mapped to the existing thread on save (`mapMigratedComposeDraft`),
 * and dirty in-memory drafts are reconciled through the same import
 * (`reconcileDraft`). Nothing here manufactures completion or resolution,
 * and logs never contain draft text or paths.
 */
import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  EMPTY_WEB_ANNOTATION_REDACTION,
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATION_SCHEMA_VERSION,
  type WebAnnotation,
  type WebAnnotationDraftReconciliation,
  type WebAnnotationMigratedReference,
  type WebAnnotationMigrationStatus,
} from "@orkestrator/protocol/web-annotations";
import { isSafeRelativePath } from "@orkestrator/protocol/web-annotations-validation";
import { decodeBase64Png, validatePngBytes, type ValidatedPng } from "./web-annotation-assets.js";
import {
  extractLegacyBrowserAnnotations,
  hasUnmigratedBrowserAnnotations,
  legacyAnnotationId,
  legacyTitle,
  pendingDispatchRequestId,
  composeDraftSessionKey,
  replaceLegacyBrowserAnnotations,
  sha,
  type LegacyBrowserAnnotation,
} from "./web-annotation-migration-drafts.js";
import {
  WebAnnotationServiceError,
  errorOutcome,
  stableStringify,
  type WebAnnotationHostComposeDraft,
  type WebAnnotationHostEnvironment,
} from "./web-annotation-service-base.js";
import { WebAnnotationServiceRequests } from "./web-annotation-service-requests.js";
import {
  writeDurable,
  type ManifestMigrationOwnership,
  type ManifestMigrationScreenshot,
  type WebAnnotationEnvironmentStore,
  type WebAnnotationManifest,
  type WebAnnotationTransaction,
} from "./web-annotation-storage.js";

export {
  composeDraftSessionKey,
  extractLegacyBrowserAnnotations,
  removeLegacyBrowserAnnotations,
  replaceLegacyBrowserAnnotations,
  type LegacyBrowserAnnotation,
} from "./web-annotation-migration-drafts.js";

/** Drafts processed per `migrate` call; callers repeat until nothing is pending. */
export const WEB_ANNOTATION_MIGRATION_PAGE = 25;
/** Legacy notes imported per `reconcileDraft` call. */
const RECONCILE_ITEMS = 50;
const MAX_SCREENSHOT_RECORDS = 50;

type NativeOwnership = Map<string, unknown> | null;

export abstract class WebAnnotationServiceMigration extends WebAnnotationServiceRequests {
  private readonly migrations = new Map<string, Promise<WebAnnotationMigrationStatus>>();

  private migrationHost() {
    const host = this.options.storage;
    if (!host?.listComposeDrafts || !host.getComposeDraft || !host.saveComposeDraft) {
      throw new WebAnnotationServiceError("Web annotation migration is unavailable");
    }
    return {
      listComposeDrafts: host.listComposeDrafts.bind(host),
      getComposeDraft: host.getComposeDraft.bind(host),
      saveComposeDraft: host.saveComposeDraft.bind(host),
      listNativeAgentSessions: host.listNativeAgentSessions?.bind(host),
    };
  }

  async migrationStatus(environmentId: string): Promise<WebAnnotationMigrationStatus> {
    const store = await this.env(environmentId);
    const host = this.options.storage;
    const drafts = host?.listComposeDrafts
      ? await host.listComposeDrafts("environment", environmentId).catch(() => null)
      : null;
    return this.computeStatus(environmentId, store.manifest, drafts);
  }

  private computeStatus(
    environmentId: string,
    manifest: WebAnnotationManifest,
    drafts: WebAnnotationHostComposeDraft[] | null,
  ): WebAnnotationMigrationStatus {
    const migration = manifest.migration;
    let pending = 0;
    let deferred = 0;
    let failed = 0;
    if (drafts) {
      for (const draft of drafts) {
        if (extractLegacyBrowserAnnotations(draft.value).length === 0) continue;
        const state = migration.drafts[draft.draftKey]?.state;
        if (state === "deferred") deferred++;
        else if (
          state === "failed" &&
          migration.drafts[draft.draftKey]!.sourceRevision === draft.revision
        )
          failed++;
        else pending++;
      }
    } else {
      for (const record of Object.values(migration.drafts)) {
        if (record.state === "imported") pending++;
        else if (record.state === "deferred") deferred++;
        else if (record.state === "failed") failed++;
      }
    }
    return {
      environmentId,
      scannedDrafts: Object.keys(migration.drafts).length,
      importedAnnotations: Object.keys(migration.imports).length,
      pendingDrafts: pending,
      deferredDrafts: deferred,
      failedDrafts: failed,
      completedAt: pending + deferred + failed === 0 ? migration.completedAt : null,
    };
  }

  /** Resumable, bounded migration pass for one environment. */
  migrate(environmentId: string): Promise<WebAnnotationMigrationStatus> {
    const existing = this.migrations.get(environmentId);
    if (existing) return existing;
    const run = this.runMigration(environmentId).finally(() =>
      this.migrations.delete(environmentId),
    );
    this.migrations.set(environmentId, run);
    return run;
  }

  /** Session key → pending dispatch, or null when sessions cannot be read. */
  private async nativeOwnership(
    host: ReturnType<WebAnnotationServiceMigration["migrationHost"]>,
    environmentId: string,
  ): Promise<NativeOwnership> {
    try {
      const sessions = host.listNativeAgentSessions ? await host.listNativeAgentSessions() : [];
      const pending = new Map<string, unknown>();
      for (const session of sessions) {
        if (session.environmentId === environmentId && session.pendingDispatch) {
          pending.set(session.logicalSessionKey, session.pendingDispatch);
        }
      }
      return pending;
    } catch {
      return null;
    }
  }

  private ownershipOf(
    draftKey: string,
    environmentId: string,
    native: NativeOwnership,
  ): ManifestMigrationOwnership {
    const logicalSessionKey = composeDraftSessionKey(draftKey, environmentId);
    if (native === null) return { logicalSessionKey, pendingDispatch: "unknown" };
    const pending = logicalSessionKey === null ? undefined : native.get(logicalSessionKey);
    if (pending === undefined) return { logicalSessionKey, pendingDispatch: false };
    const requestId = pendingDispatchRequestId(pending);
    return {
      logicalSessionKey,
      pendingDispatch: true,
      ...(requestId ? { pendingRequestId: requestId } : {}),
    };
  }

  private async runMigration(environmentId: string): Promise<WebAnnotationMigrationStatus> {
    const host = this.migrationHost();
    const store = await this.env(environmentId);
    const environment = await this.hostEnvironment(environmentId);
    if (!environment) throw new WebAnnotationServiceError("Environment not found");
    const drafts = (await host.listComposeDrafts("environment", environmentId))
      .filter((draft) => draft.ownerType === "environment" && draft.ownerId === environmentId)
      .sort((a, b) => (a.draftKey < b.draftKey ? -1 : a.draftKey > b.draftKey ? 1 : 0));

    // A pending or unknown native dispatch owns its submitted snapshot.
    const native = await this.nativeOwnership(host, environmentId);

    let processed = 0;
    for (const draft of drafts) {
      const legacy = extractLegacyBrowserAnnotations(draft.value);
      if (legacy.length === 0) continue;
      const record = store.manifest.migration.drafts[draft.draftKey];
      if (record?.state === "failed" && record.sourceRevision === draft.revision) continue;
      if (processed >= WEB_ANNOTATION_MIGRATION_PAGE) break;
      processed++;
      const ownership = this.ownershipOf(draft.draftKey, environmentId, native);
      try {
        await this.migrateDraft(store, environment, draft, legacy, ownership, host);
      } catch (error) {
        const reason = errorOutcome(error);
        console.warn(`[web-annotations] Migration of one draft failed (code=${reason})`);
        this.metrics.recordMigration("failed");
        await store
          .mutate((tx) => {
            tx.markEssential();
            tx.manifest.migration.drafts[draft.draftKey] = {
              state: "failed",
              sourceRevision: draft.revision,
              legacyIds: legacy.map((item) => item.id),
              reason,
              ownership,
              updatedAt: tx.now,
            };
            tx.markDirty();
          })
          .catch(() => undefined);
      }
    }

    const latestDrafts = await host
      .listComposeDrafts("environment", environmentId)
      .catch(() => null);
    const status = this.computeStatus(environmentId, store.manifest, latestDrafts);
    if (
      latestDrafts &&
      status.pendingDrafts + status.deferredDrafts + status.failedDrafts === 0 &&
      !store.manifest.migration.completedAt
    ) {
      await store.mutate((tx) => {
        tx.markEssential();
        tx.manifest.migration.completedAt = tx.now;
        tx.markDirty();
      });
      // Validation succeeded: the private backups are no longer needed.
      await rm(join(store.dir, "migration-backups"), { recursive: true, force: true }).catch(
        () => undefined,
      );
      return this.computeStatus(environmentId, store.manifest, latestDrafts);
    }
    return status;
  }

  /**
   * Import legacy notes into threads in one commit. Screenshots are read
   * (outside the write queue) only for captures that do not exist yet; an
   * unreadable file becomes explicit missing evidence. `record` adds the
   * caller's migration receipt to the same commit.
   */
  private async importLegacy(
    store: WebAnnotationEnvironmentStore,
    environment: WebAnnotationHostEnvironment,
    legacy: LegacyBrowserAnnotation[],
    record?: (tx: WebAnnotationTransaction, screenshots: ManifestMigrationScreenshot[]) => void,
  ): Promise<number> {
    const environmentId = store.environmentId;
    const assets = new Map<string, string | null>();
    const screenshots: ManifestMigrationScreenshot[] = [];
    const held: string[] = [];
    try {
      for (const item of legacy) {
        const imported = store.manifest.migration.imports[item.id];
        const existing = imported?.captureVariants.includes(sha(item.text)) ?? false;
        let assetId: string | null = null;
        if (item.screenshotPath && !existing) {
          const png = await this.readLegacyScreenshot(environment, item.screenshotPath).catch(
            () => null,
          );
          if (png) {
            const stored = await this.storeAssetBytes(store, png).catch(() => null);
            if (stored) {
              assetId = stored.asset.id;
              this.holdAssets([assetId]);
              held.push(assetId);
            }
          }
        }
        assets.set(item.id, assetId);
        if (item.screenshotPath && screenshots.length < MAX_SCREENSHOT_RECORDS) {
          screenshots.push({
            legacyId: item.id,
            referenceDigest: sha(item.screenshotPath),
            assetId,
            outcome: existing ? "existing" : assetId ? "imported" : "missing",
          });
        }
      }
      const before = new Set(Object.keys(store.manifest.migration.imports));
      await store.mutate((tx) => {
        tx.markEssential();
        for (const item of legacy) {
          this.importLegacyItem(tx, environmentId, item, assets.get(item.id) ?? null);
        }
        record?.(tx, screenshots);
        tx.markDirty();
      });
      const imported = legacy.filter((item) => !before.has(item.id)).length;
      if (imported > 0) this.metrics.recordMigrationItems(imported);
      return imported;
    } finally {
      this.releaseAssets(held);
    }
  }

  private async migrateDraft(
    store: WebAnnotationEnvironmentStore,
    environment: WebAnnotationHostEnvironment,
    draft: WebAnnotationHostComposeDraft,
    legacy: LegacyBrowserAnnotation[],
    ownership: ManifestMigrationOwnership,
    host: ReturnType<WebAnnotationServiceMigration["migrationHost"]>,
  ): Promise<void> {
    const environmentId = store.environmentId;
    const deferred = ownership.pendingDispatch !== false;
    let recordedScreenshots: ManifestMigrationScreenshot[] = [];
    await this.importLegacy(store, environment, legacy, (tx, screenshots) => {
      recordedScreenshots = screenshots;
      const previous = tx.manifest.migration.drafts[draft.draftKey];
      tx.manifest.migration.drafts[draft.draftKey] = {
        state: deferred ? "deferred" : "imported",
        sourceRevision: draft.revision,
        legacyIds: legacy.map((item) => item.id),
        ...(previous?.backup ? { backup: previous.backup } : {}),
        screenshots,
        ownership,
        updatedAt: tx.now,
      };
      tx.manifest.migration.completedAt = null;
    });
    this.metrics.recordMigration(deferred ? "deferred" : "imported");
    if (deferred) return;

    // Private, environment-scoped backup of the exact source before cleanup.
    const backupDirectory = join(store.dir, "migration-backups");
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    const backup = `${sha(draft.draftKey).slice(0, 32)}-${draft.revision}.json`;
    await writeDurable(join(backupDirectory, backup), JSON.stringify(draft));

    const current = await host.getComposeDraft(draft.draftKey);
    if (!current || current.revision !== draft.revision || current.ownerId !== environmentId) {
      this.metrics.recordMigration("conflict");
      return; // Changed concurrently: leave it; the next pass retries.
    }
    const mapping = new Map<string, string>();
    for (const item of legacy) {
      const imported = store.manifest.migration.imports[item.id];
      if (imported) mapping.set(item.id, imported.annotationId);
    }
    let saved: WebAnnotationHostComposeDraft;
    try {
      saved = await host.saveComposeDraft(
        draft.draftKey,
        "environment",
        environmentId,
        replaceLegacyBrowserAnnotations(current.value, mapping),
        current.revision,
      );
    } catch {
      this.metrics.recordMigration("conflict");
      return; // Revision conflict or write failure: the import receipt stays.
    }
    await store.mutate((tx) => {
      tx.markEssential();
      tx.manifest.migration.drafts[draft.draftKey] = {
        state: "cleaned",
        sourceRevision: saved.revision,
        legacyIds: Array.from(mapping.keys()),
        backup,
        screenshots: recordedScreenshots,
        ownership,
        updatedAt: tx.now,
      };
      tx.markDirty();
    });
    this.metrics.recordMigration("cleaned");
  }

  /** Commit one legacy note: new thread, or new variant in an existing one. */
  private importLegacyItem(
    tx: WebAnnotationTransaction,
    environmentId: string,
    item: LegacyBrowserAnnotation,
    assetId: string | null,
  ): void {
    const variant = sha(stableStringify({ text: item.text, comment: item.comment }));
    const captureVariant = sha(item.text);
    const comment = item.comment.replace(/\r\n?/g, "\n").trim();
    const writeLegacyCapture = (annotationId: string, revision: number) =>
      this.writeCapture(tx, {
        annotationId,
        revision,
        producer: "legacy-import",
        capturedAt: tx.now,
        documentGeneration: null,
        page: {
          service: { kind: "unknown" },
          route: "/",
          displayUrl: "",
          title: "",
          requiresNavigation: true,
        },
        target: {
          kind: "legacy-unresolved",
          label: "Imported browser note",
          referenceText: item.text,
        },
        geometry: null,
        evidence: null,
        assetIds: assetId ? [assetId] : [],
        redaction: { ...EMPTY_WEB_ANNOTATION_REDACTION },
        // Only a screenshot that existed and could not be read is missing
        // evidence; a note that never had one is text-only legacy evidence.
        state: item.screenshotPath && !assetId ? "missing" : "stale",
        stateReason: assetId
          ? "Imported from a legacy chat draft; reselect the element to refresh"
          : item.screenshotPath
            ? "The legacy screenshot could not be imported"
            : "Imported from a legacy chat draft without a screenshot; reselect the element to refresh",
      });
    const imported = tx.manifest.migration.imports[item.id];
    if (!imported) {
      this.assertAnnotationCapacity(tx.manifest);
      const annotationId = legacyAnnotationId(environmentId, item.id);
      const capture = writeLegacyCapture(annotationId, 1);
      const annotation: WebAnnotation = {
        id: annotationId,
        environmentId,
        schemaVersion: WEB_ANNOTATION_SCHEMA_VERSION,
        metadataRevision: 1,
        contentRevision: 1,
        createdAt: tx.now,
        updatedAt: tx.now,
        lastActivityAt: tx.now,
        page: capture.page,
        currentCaptureId: capture.id,
        captureRevision: 1,
        title: legacyTitle(environmentId, item.id),
        targetKind: "legacy-unresolved",
        targetLabel: "Imported browser note",
        state: "open",
        hidden: false,
        defaultDestination: null,
        resolution: null,
        activeRequestId: null,
        requestIds: [],
        entryCount: 0,
        entryBytes: 0,
        lastSequence: 0,
        // Page-origin comments are never promoted to host intent.
        latestIntent: null,
        thumbnailAssetId: assetId,
        imported: true,
      };
      tx.manifest.annotations[annotationId] = annotation;
      this.appendEntry(tx, annotation, {
        provenance: "system",
        kind: "lifecycle",
        body: null,
        lifecycle: { event: "imported" },
        captureId: capture.id,
        force: true,
      });
      if (comment) {
        this.appendEntry(tx, annotation, {
          provenance: "legacy-page-comment",
          kind: "legacy-comment",
          body: comment,
          captureId: capture.id,
          legacyVariantCount: 1,
          force: true,
        });
      }
      tx.manifest.migration.imports[item.id] = {
        annotationId,
        variants: [variant],
        captureVariants: [captureVariant],
        importedAt: tx.now,
      };
      return;
    }
    // An archived thread continues elsewhere: new variants join the live
    // continuation instead of being dropped.
    let annotation = tx.manifest.annotations[imported.annotationId];
    for (let hops = 0; annotation?.archivedAt && annotation.continuationId && hops < 8; hops++) {
      annotation = tx.manifest.annotations[annotation.continuationId];
    }
    if (!annotation || annotation.state === "deleted" || annotation.archivedAt) {
      if (!imported.variants.includes(variant)) imported.variants.push(variant);
      if (!imported.captureVariants.includes(captureVariant))
        imported.captureVariants.push(captureVariant);
      return;
    }
    let captureId: string | null = null;
    if (!imported.captureVariants.includes(captureVariant)) {
      // Divergent evidence: retain it as a historical capture in the thread.
      const capture = writeLegacyCapture(
        annotation.id,
        this.nextCaptureRevision(tx.manifest, annotation.id),
      );
      captureId = capture.id;
      imported.captureVariants.push(captureVariant);
      this.appendEntry(tx, annotation, {
        provenance: "system",
        kind: "lifecycle",
        body: null,
        lifecycle: { event: "imported" },
        captureId,
        force: true,
      });
      this.bumpMetadata(tx, annotation);
    }
    if (!imported.variants.includes(variant)) {
      imported.variants.push(variant);
      if (comment) {
        this.appendEntry(tx, annotation, {
          provenance: "legacy-page-comment",
          kind: "legacy-comment",
          body: comment,
          ...(captureId ? { captureId } : {}),
          legacyVariantCount: imported.variants.length,
          force: true,
        });
      }
      this.bumpMetadata(tx, annotation);
    }
  }

  /**
   * Compose-draft persistence hook (`save_compose_draft`): a client that does
   * not know about migration (or a dirty in-memory draft) can re-persist a
   * legacy browser note that already lives in a thread. Map each such copy
   * to its thread instead of letting it fan out again. Never throws: on any
   * failure the value is saved unchanged.
   */
  async mapMigratedComposeDraft(
    ownerType: string,
    ownerId: string,
    value: unknown,
  ): Promise<{ value: unknown; references: WebAnnotationMigratedReference[] }> {
    const unchanged = { value, references: [] as WebAnnotationMigratedReference[] };
    if (ownerType !== "environment" || !hasUnmigratedBrowserAnnotations(value)) return unchanged;
    try {
      const store = await this.env(ownerId);
      if (store.status === "unavailable") return unchanged;
      const manifest = store.manifest;
      const mapping = new Map<string, string>();
      for (const item of extractLegacyBrowserAnnotations(value)) {
        const imported = manifest.migration.imports[item.id];
        if (imported && manifest.annotations[imported.annotationId]) {
          mapping.set(item.id, imported.annotationId);
        }
      }
      if (mapping.size === 0) return unchanged;
      this.metrics.increment("migration_mapped_on_save", mapping.size);
      return {
        value: replaceLegacyBrowserAnnotations(value, mapping),
        references: Array.from(mapping, ([legacyId, annotationId]) => ({ legacyId, annotationId })),
      };
    } catch {
      return unchanged;
    }
  }

  /**
   * `web_annotations_reconcile_draft`: run a dirty in-memory compose draft
   * through the same idempotent import as server-side migration, without
   * touching persisted drafts. Returns the value with imported notes replaced
   * by migrated references; notes that could not be imported stay as they
   * were and are listed in `failed`.
   */
  async reconcileDraft(
    environmentId: string,
    value: unknown,
  ): Promise<WebAnnotationDraftReconciliation> {
    const store = await this.env(environmentId);
    const legacy = extractLegacyBrowserAnnotations(value);
    if (legacy.length === 0) return { value, references: [], imported: 0, failed: [] };
    const environment = await this.hostEnvironment(environmentId);
    if (!environment) throw new WebAnnotationServiceError("Environment not found");
    const batch = legacy.slice(0, RECONCILE_ITEMS);
    const failed = new Set(legacy.slice(RECONCILE_ITEMS).map((item) => item.id));
    let imported = 0;
    try {
      imported = await this.importLegacy(store, environment, batch);
    } catch (error) {
      console.warn(`[web-annotations] Draft reconciliation deferred (code=${errorOutcome(error)})`);
      for (const item of batch) failed.add(item.id);
    }
    const mapping = new Map<string, string>();
    for (const item of batch) {
      if (failed.has(item.id)) continue;
      const record = store.manifest.migration.imports[item.id];
      if (record) mapping.set(item.id, record.annotationId);
      else failed.add(item.id);
    }
    return {
      value: replaceLegacyBrowserAnnotations(value, mapping),
      references: Array.from(mapping, ([legacyId, annotationId]) => ({ legacyId, annotationId })),
      imported,
      failed: Array.from(failed),
    };
  }

  /**
   * Read a legacy screenshot through environment-contained paths only: a
   * local worktree (symlinks resolved and re-checked for containment) or the
   * container workspace via the existing bounded container reader.
   */
  protected async readLegacyScreenshot(
    environment: WebAnnotationHostEnvironment,
    path: string,
  ): Promise<ValidatedPng | null> {
    if (
      environment.environmentType === "local" ||
      (!environment.containerId && environment.worktreePath)
    ) {
      if (!environment.worktreePath) return null;
      const root = await realpath(environment.worktreePath);
      const candidate = isAbsolute(path) ? path : resolve(root, path);
      const real = await realpath(candidate);
      if (real !== root && !real.startsWith(root + sep)) return null;
      const info = await stat(real);
      if (!info.isFile() || info.size > WEB_ANNOTATION_LIMITS.imageBytes) return null;
      return validatePngBytes(await readFile(real));
    }
    if (!environment.containerId || !this.options.invoke) return null;
    const relative = path.startsWith("/workspace/") ? path.slice("/workspace/".length) : path;
    if (!isSafeRelativePath(relative)) return null;
    const data = await this.options.invoke("read_container_file_base64", {
      containerId: environment.containerId,
      filePath: relative,
    });
    return typeof data === "string" ? decodeBase64Png(data.trim()) : null;
  }
}
