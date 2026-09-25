/**
 * Web annotation service: threads.
 *
 * Owns annotation threads, captures, entries, listing, resolution, and
 * archive/continuation. Lifecycle, capabilities, receipts, drafts, assets,
 * and GC live in `web-annotation-service-base.ts`. Request orchestration and
 * migration extend this class in `web-annotation-service-requests.ts` and
 * `web-annotation-migration.ts`.
 *
 * Provenance is assigned here and nowhere else: bodies received from commands
 * are `host-user`; lifecycle markers are `system`; imported legacy comments
 * are `legacy-page-comment`; agent excerpts are `agent-reference`.
 */
import {
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATION_SCHEMA_VERSION,
  isWebAnnotationRequestActive,
  webAnnotationPageKey,
  webAnnotationUtf8Bytes,
  type WebAnnotation,
  type WebAnnotationArchiveInput,
  type WebAnnotationArchiveResult,
  type WebAnnotationCapture,
  type WebAnnotationCaptureInput,
  type WebAnnotationCaptureProducer,
  type WebAnnotationCaptureState,
  type WebAnnotationCommandArgs,
  type WebAnnotationCreateInput,
  type WebAnnotationEntriesResult,
  type WebAnnotationEntry,
  type WebAnnotationEntryKind,
  type WebAnnotationGetResult,
  type WebAnnotationListInput,
  type WebAnnotationListResult,
  type WebAnnotationOperationReceipt,
  type WebAnnotationProvenance,
  type WebAnnotationRequest,
  type WebAnnotationResolveInput,
  type WebAnnotationResult,
  type WebAnnotationSummary,
  type WebAnnotationTarget,
  type WebAnnotationTranscriptRef,
} from "@orkestrator/protocol/web-annotations";
import {
  isWebAnnotationDestination,
  isWebAnnotationId,
  validateWebAnnotationBody,
  validateWebAnnotationCaptureInput,
  validateWebAnnotationTitle,
} from "@orkestrator/protocol/web-annotations-validation";
import { liveAnnotationCount } from "./web-annotation-assets.js";
import {
  WebAnnotationServiceBase,
  WebAnnotationServiceError,
  archivedError,
  capacityError,
  conflictError,
  degradedError,
  hashBody,
  newId,
  notFound,
  stableStringify,
} from "./web-annotation-service-base.js";
import type {
  ManifestCapture,
  ManifestEntry,
  WebAnnotationEnvironmentStore,
  WebAnnotationManifest,
  WebAnnotationTransaction,
} from "./web-annotation-storage.js";

export {
  WebAnnotationServiceError,
  capacityError,
  conflictError,
  hashBody,
  newId,
  notFound,
  stableStringify,
  type WebAnnotationHostComposeDraft,
  type WebAnnotationHostEnvironment,
  type WebAnnotationHostStorage,
  type WebAnnotationServiceOptions,
} from "./web-annotation-service-base.js";

const INTENT_EXCERPT_CHARS = 280;
const MAX_GET_RESULTS = 20;
const CONTINUED_SUFFIX = " (continued)";

function excerpt(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

function defaultTitle(body: string, target: WebAnnotationTarget): string {
  const firstLine =
    body
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "";
  const candidate = excerpt(firstLine || target.label, 80);
  return candidate || "Untitled note";
}

function continuationTitle(title: string): string {
  const base = title.endsWith(CONTINUED_SUFFIX) ? title.slice(0, -CONTINUED_SUFFIX.length) : title;
  const max = WEB_ANNOTATION_LIMITS.titleChars - CONTINUED_SUFFIX.length;
  return `${base.length <= max ? base : `${base.slice(0, max - 1)}…`}${CONTINUED_SUFFIX}`;
}

interface ListCursor {
  v: 1;
  r: number;
  f: string;
  c: string;
  i: string;
}

function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): ListCursor {
  try {
    if (value.length > 2_000) throw new Error("cursor too long");
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as ListCursor;
    if (
      parsed?.v !== 1 ||
      !Number.isSafeInteger(parsed.r) ||
      typeof parsed.f !== "string" ||
      typeof parsed.c !== "string" ||
      typeof parsed.i !== "string"
    ) {
      throw new Error("cursor shape");
    }
    return parsed;
  } catch {
    throw new WebAnnotationServiceError("Web annotation list cursor is invalid; refresh the list");
  }
}

/** Sort newest first by creation time, then id; both are immutable. */
function compareListOrder(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export interface AppendEntryInput {
  provenance: WebAnnotationProvenance;
  kind: WebAnnotationEntryKind;
  body: string | null;
  lifecycle?: WebAnnotationEntry["lifecycle"];
  transcript?: WebAnnotationTranscriptRef;
  captureId?: string | null;
  supersedes?: string;
  legacyVariantCount?: number;
  /** Lifecycle markers from background work never fail on thread capacity. */
  force?: boolean;
}

export abstract class WebAnnotationServiceCore extends WebAnnotationServiceBase {
  // -------------------------------------------------------------------------
  // Helpers used by every mutation

  protected requireAnnotation(
    manifest: WebAnnotationManifest,
    annotationId: string,
  ): WebAnnotation {
    const annotation = isWebAnnotationId(annotationId)
      ? manifest.annotations[annotationId]
      : undefined;
    if (!annotation) throw notFound("Annotation");
    return annotation;
  }

  protected requireMutable(
    store: WebAnnotationEnvironmentStore,
    manifest: WebAnnotationManifest,
    annotationId: string,
  ): WebAnnotation {
    const annotation = this.requireAnnotation(manifest, annotationId);
    if (annotation.state === "deleted")
      throw new WebAnnotationServiceError("Annotation was deleted");
    if (annotation.archivedAt) throw archivedError(annotation.continuationId);
    const unavailable = store.unavailableReason(annotationId);
    if (unavailable) throw degradedError(`annotation is read-only (${unavailable})`);
    return annotation;
  }

  protected expectContentRevision(annotation: WebAnnotation, expected: number): void {
    if (annotation.contentRevision !== expected) {
      throw conflictError(
        `content revision ${expected} is stale (current ${annotation.contentRevision}); refresh and retry`,
      );
    }
  }

  protected expectMetadataRevision(annotation: WebAnnotation, expected: number): void {
    if (annotation.metadataRevision !== expected) {
      throw conflictError(
        `metadata revision ${expected} is stale (current ${annotation.metadataRevision}); refresh and retry`,
      );
    }
  }

  protected bumpMetadata(tx: WebAnnotationTransaction, annotation: WebAnnotation): void {
    annotation.metadataRevision++;
    annotation.updatedAt = tx.now;
    tx.touch({ annotationIds: [annotation.id] });
  }

  protected bumpContent(tx: WebAnnotationTransaction, annotation: WebAnnotation): void {
    annotation.contentRevision++;
    annotation.lastActivityAt = tx.now;
    this.bumpMetadata(tx, annotation);
  }

  /** Append one immutable entry. Callers bump revisions as appropriate. */
  protected appendEntry(
    tx: WebAnnotationTransaction,
    annotation: WebAnnotation,
    input: AppendEntryInput,
  ): WebAnnotationEntry {
    const bodyBytes = input.body === null ? 0 : webAnnotationUtf8Bytes(input.body);
    if (!input.force) {
      if (annotation.entryCount >= WEB_ANNOTATION_LIMITS.threadEntries) {
        throw capacityError(
          `thread has ${annotation.entryCount} of ${WEB_ANNOTATION_LIMITS.threadEntries} entries; archive it and continue in a new note (web_annotation_archive)`,
          {
            resource: "thread-entries",
            used: annotation.entryCount,
            limit: WEB_ANNOTATION_LIMITS.threadEntries,
            requested: 1,
            archivable: true,
          },
        );
      }
      if (annotation.entryBytes + bodyBytes > WEB_ANNOTATION_LIMITS.threadTextBytes) {
        throw capacityError(
          `thread text would use ${annotation.entryBytes + bodyBytes} of ${WEB_ANNOTATION_LIMITS.threadTextBytes} bytes; archive it and continue in a new note (web_annotation_archive)`,
          {
            resource: "thread-bytes",
            used: annotation.entryBytes,
            limit: WEB_ANNOTATION_LIMITS.threadTextBytes,
            requested: bodyBytes,
            archivable: true,
          },
        );
      }
    }
    const entry: WebAnnotationEntry = {
      id: newId("entry"),
      annotationId: annotation.id,
      sequence: annotation.lastSequence + 1,
      provenance: input.provenance,
      kind: input.kind,
      body: input.body,
      ...(input.transcript ? { transcript: input.transcript } : {}),
      ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
      contentRevision: annotation.contentRevision,
      captureId: input.captureId === undefined ? annotation.currentCaptureId : input.captureId,
      createdAt: tx.now,
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
      ...(input.legacyVariantCount ? { legacyVariantCount: input.legacyVariantCount } : {}),
    };
    const bytes = tx.writeRecord("entry", entry.id, 1, entry);
    const index: ManifestEntry = {
      id: entry.id,
      annotationId: annotation.id,
      sequence: entry.sequence,
      kind: entry.kind,
      provenance: entry.provenance,
      bytes,
      createdAt: entry.createdAt,
      ...(entry.supersedes ? { supersedes: entry.supersedes } : {}),
    };
    (tx.manifest.entries[annotation.id] ??= []).push(index);
    annotation.entryCount++;
    annotation.entryBytes += bodyBytes;
    annotation.lastSequence = entry.sequence;
    annotation.lastActivityAt = tx.now;
    annotation.updatedAt = tx.now;
    tx.touch({ annotationIds: [annotation.id] });
    return entry;
  }

  /** New substantive human feedback reopens a resolved annotation. */
  protected reopenIfResolved(tx: WebAnnotationTransaction, annotation: WebAnnotation): void {
    if (annotation.state !== "resolved") return;
    annotation.state = "open";
    annotation.resolution = null;
    this.appendEntry(tx, annotation, {
      provenance: "system",
      kind: "lifecycle",
      body: null,
      lifecycle: { event: "reopened" },
      force: true,
    });
  }

  protected referenceAssets(tx: WebAnnotationTransaction, assetIds: readonly string[]) {
    const assets = [];
    for (const id of assetIds) {
      const asset = tx.manifest.assets[id];
      if (!asset) throw notFound("Asset");
      asset.orphanedAt = null;
      assets.push(asset);
    }
    return assets;
  }

  protected nextCaptureRevision(manifest: WebAnnotationManifest, annotationId: string): number {
    let max = 0;
    for (const capture of Object.values(manifest.captures)) {
      if (capture.annotationId === annotationId && capture.revision > max) max = capture.revision;
    }
    return max + 1;
  }

  /** Write an immutable capture record and its index entry. */
  protected writeCapture(
    tx: WebAnnotationTransaction,
    input: {
      annotationId: string;
      revision: number;
      producer: WebAnnotationCaptureProducer;
      capturedAt: string;
      documentGeneration: number | null;
      page: WebAnnotationCapture["page"];
      target: WebAnnotationTarget;
      geometry: WebAnnotationCapture["geometry"];
      evidence: WebAnnotationCapture["evidence"];
      assetIds: string[];
      redaction: WebAnnotationCapture["redaction"];
      state: WebAnnotationCaptureState;
      stateReason?: string;
      resultOf?: { requestId: string; resultId?: string };
      comparison?: WebAnnotationCapture["comparison"];
    },
  ): WebAnnotationCapture {
    this.referenceAssets(tx, input.assetIds);
    const capture: WebAnnotationCapture = {
      id: newId("capture"),
      annotationId: input.annotationId,
      schemaVersion: WEB_ANNOTATION_SCHEMA_VERSION,
      revision: input.revision,
      producer: input.producer,
      capturedAt: input.capturedAt,
      documentGeneration: input.documentGeneration,
      page: input.page,
      target: input.target,
      geometry: input.geometry,
      evidence: input.evidence,
      assetIds: [...input.assetIds],
      redaction: input.redaction,
      state: input.state,
      ...(input.stateReason ? { stateReason: input.stateReason } : {}),
      ...(input.resultOf ? { resultOf: input.resultOf } : {}),
      ...(input.comparison ? { comparison: input.comparison } : {}),
    };
    const bytes = tx.writeRecord("capture", capture.id, 1, capture);
    const index: ManifestCapture = {
      id: capture.id,
      annotationId: capture.annotationId,
      revision: capture.revision,
      producer: capture.producer,
      state: capture.state,
      assetIds: capture.assetIds,
      ...(capture.resultOf ? { resultOf: capture.resultOf } : {}),
      createdAt: tx.now,
      bytes,
    };
    tx.manifest.captures[capture.id] = index;
    return capture;
  }

  protected captureFromInput(
    tx: WebAnnotationTransaction,
    annotationId: string,
    revision: number,
    input: WebAnnotationCaptureInput,
    producer: WebAnnotationCaptureProducer = input.producer,
    resultOf?: { requestId: string; resultId?: string },
    comparison?: WebAnnotationCapture["comparison"],
  ): WebAnnotationCapture {
    return this.writeCapture(tx, {
      ...(comparison ? { comparison } : {}),
      annotationId,
      revision,
      producer,
      capturedAt: input.capturedAt,
      documentGeneration: input.documentGeneration,
      page: input.page,
      target: input.target,
      geometry: input.geometry,
      evidence: input.evidence,
      assetIds: input.assetIds,
      redaction: input.redaction,
      state: input.stale ? "stale" : "complete",
      ...(input.stale ? { stateReason: input.stale.reason } : {}),
      ...(resultOf ? { resultOf } : {}),
    });
  }

  protected validateCapture(value: unknown): WebAnnotationCaptureInput {
    const result = validateWebAnnotationCaptureInput(value);
    if (!result.ok) throw new WebAnnotationServiceError(result.error);
    return result.value;
  }

  protected validateBody(value: unknown): string {
    const result = validateWebAnnotationBody(value);
    if (!result.ok) throw new WebAnnotationServiceError(result.error);
    return result.value;
  }

  // -------------------------------------------------------------------------
  // Reads

  protected project(
    store: WebAnnotationEnvironmentStore,
    annotation: WebAnnotation,
  ): WebAnnotation {
    const unavailable = store.unavailableReason(annotation.id);
    return unavailable ? { ...annotation, unavailable } : { ...annotation };
  }

  protected summary(
    store: WebAnnotationEnvironmentStore,
    manifest: WebAnnotationManifest,
    annotation: WebAnnotation,
  ): WebAnnotationSummary {
    const request = annotation.activeRequestId
      ? manifest.requests[annotation.activeRequestId]
      : undefined;
    return {
      ...this.project(store, annotation),
      activeRequest: request
        ? {
            id: request.id,
            state: request.state,
            operation: request.operation,
            blockedReason: request.blockedReason,
            destination: request.destination,
          }
        : null,
    };
  }

  protected async readCapture(
    store: WebAnnotationEnvironmentStore,
    manifest: WebAnnotationManifest,
    captureId: string,
  ): Promise<WebAnnotationCapture | null> {
    const index = manifest.captures[captureId];
    if (!index) return null;
    try {
      return await store.readRecord<WebAnnotationCapture>("capture", captureId, 1);
    } catch {
      store.markUnavailable(index.annotationId, "capture record unreadable");
      return null;
    }
  }

  protected async readEntry(
    store: WebAnnotationEnvironmentStore,
    index: ManifestEntry,
  ): Promise<WebAnnotationEntry> {
    try {
      const entry = await store.readRecord<WebAnnotationEntry>("entry", index.id, 1);
      return index.supersededBy ? { ...entry, supersededBy: index.supersededBy } : entry;
    } catch {
      store.markUnavailable(index.annotationId, "entry record unreadable");
      // Visible placeholder: never silently drop an entry from the thread.
      return {
        id: index.id,
        annotationId: index.annotationId,
        sequence: index.sequence,
        provenance: index.provenance,
        kind: index.kind,
        body: null,
        contentRevision: 0,
        captureId: null,
        createdAt: index.createdAt,
        ...(index.supersedes ? { supersedes: index.supersedes } : {}),
        ...(index.supersededBy ? { supersededBy: index.supersededBy } : {}),
      };
    }
  }

  /** Read a bounded run of entry indexes (count and response bytes). */
  private async readEntryRun(
    store: WebAnnotationEnvironmentStore,
    indexes: readonly ManifestEntry[],
    limit: number,
  ): Promise<WebAnnotationEntry[]> {
    const bounded = Math.max(1, Math.min(limit, WEB_ANNOTATION_LIMITS.entryPageItems));
    const entries: WebAnnotationEntry[] = [];
    let bytes = 0;
    for (const index of indexes) {
      if (entries.length >= bounded) break;
      if (entries.length > 0 && bytes + index.bytes > WEB_ANNOTATION_LIMITS.entryPageBytes) break;
      entries.push(await this.readEntry(store, index));
      bytes += index.bytes;
    }
    return entries;
  }

  protected async readEntryPage(
    store: WebAnnotationEnvironmentStore,
    manifest: WebAnnotationManifest,
    annotationId: string,
    afterSequence: number,
    limit: number,
  ): Promise<{ entries: WebAnnotationEntry[]; nextSequence: number | null }> {
    const indexes = (manifest.entries[annotationId] ?? []).filter(
      (entry) => entry.sequence > afterSequence,
    );
    const entries = await this.readEntryRun(store, indexes, limit);
    const more = indexes.length > entries.length;
    return { entries, nextSequence: more ? (entries.at(-1)?.sequence ?? afterSequence) : null };
  }

  /** The newest bounded page before `beforeSequence`, oldest first. */
  protected async readEntryPageBefore(
    store: WebAnnotationEnvironmentStore,
    manifest: WebAnnotationManifest,
    annotationId: string,
    beforeSequence: number,
    limit: number,
  ): Promise<{ entries: WebAnnotationEntry[]; previousSequence: number | null }> {
    const older = (manifest.entries[annotationId] ?? [])
      .filter((entry) => entry.sequence < beforeSequence)
      .reverse();
    const newestFirst = await this.readEntryRun(store, older, limit);
    const entries = newestFirst.reverse();
    const more = older.length > entries.length;
    return { entries, previousSequence: more ? (entries[0]?.sequence ?? null) : null };
  }

  async list(input: WebAnnotationListInput): Promise<WebAnnotationListResult> {
    const store = await this.env(input.environmentId);
    const manifest = store.manifest;
    const filter = {
      pageKey: input.filter?.pageKey ?? null,
      state: input.filter?.state ?? "open",
      destinationTabId: input.filter?.destinationTabId ?? null,
      includeHidden: input.filter?.includeHidden ?? false,
      importedOnly: input.filter?.importedOnly ?? false,
      ...(input.filter?.includeArchived ? { includeArchived: true } : {}),
    };
    const filterKey = stableStringify(filter);
    const limit = Math.max(
      1,
      Math.min(
        input.limit ?? WEB_ANNOTATION_LIMITS.listPageItems,
        WEB_ANNOTATION_LIMITS.listPageItems,
      ),
    );
    const matches = (annotation: WebAnnotation) => {
      if (annotation.state === "deleted") return false;
      if (annotation.archivedAt && !filter.includeArchived) return false;
      if (filter.state !== "all" && annotation.state !== filter.state) return false;
      if (!filter.includeHidden && annotation.hidden) return false;
      if (filter.importedOnly && !annotation.imported) return false;
      if (filter.pageKey !== null && webAnnotationPageKey(annotation.page) !== filter.pageKey)
        return false;
      if (filter.destinationTabId !== null) {
        const active = annotation.activeRequestId
          ? manifest.requests[annotation.activeRequestId]
          : undefined;
        if (
          annotation.defaultDestination?.tabId !== filter.destinationTabId &&
          active?.destination.tabId !== filter.destinationTabId
        ) {
          return false;
        }
      }
      return true;
    };
    const all = Object.values(manifest.annotations).filter(matches).sort(compareListOrder);
    let start = 0;
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      if (cursor.f !== filterKey) {
        throw new WebAnnotationServiceError(
          "Web annotation list cursor belongs to another filter; refresh the list",
        );
      }
      const position = { createdAt: cursor.c, id: cursor.i };
      if (cursor.r !== manifest.revision) {
        // Items sorting after the cursor that changed since the snapshot may
        // have entered or left this filter: continuing could skip or repeat.
        for (const [id, changed] of Object.entries(manifest.changedAt)) {
          if (changed <= cursor.r) continue;
          const annotation = manifest.annotations[id];
          if (annotation && compareListOrder(annotation, position) > 0) {
            throw conflictError("the list changed during pagination; refresh from the first page");
          }
        }
      }
      start = all.findIndex((annotation) => compareListOrder(annotation, position) > 0);
      if (start < 0) start = all.length;
    }
    const items: WebAnnotationSummary[] = [];
    let bytes = 0;
    for (let index = start; index < all.length && items.length < limit; index++) {
      const summary = this.summary(store, manifest, all[index]!);
      const size = Buffer.byteLength(JSON.stringify(summary));
      if (items.length > 0 && bytes + size > WEB_ANNOTATION_LIMITS.listPageBytes) break;
      items.push(summary);
      bytes += size;
    }
    const last = items.at(-1);
    const nextCursor =
      last && start + items.length < all.length
        ? encodeCursor({ v: 1, r: manifest.revision, f: filterKey, c: last.createdAt, i: last.id })
        : null;
    let openOnPage: number | undefined;
    if (filter.pageKey !== null) {
      openOnPage = 0;
      for (const annotation of Object.values(manifest.annotations)) {
        if (
          annotation.state === "open" &&
          !annotation.hidden &&
          !annotation.archivedAt &&
          webAnnotationPageKey(annotation.page) === filter.pageKey
        ) {
          openOnPage++;
        }
      }
    }
    return {
      generation: this.generation,
      revision: manifest.revision,
      items,
      nextCursor,
      total: all.length,
      ...(openOnPage !== undefined ? { openOnPage } : {}),
    };
  }

  protected async readResult(
    store: WebAnnotationEnvironmentStore,
    resultId: string,
  ): Promise<WebAnnotationResult | null> {
    try {
      return await store.readRecord<WebAnnotationResult>("result", resultId, 1);
    } catch {
      return null;
    }
  }

  async get(
    environmentId: string,
    annotationId: string,
    entryLimit: number = WEB_ANNOTATION_LIMITS.entryPageItems,
    entryWindow: "oldest" | "latest" = "oldest",
  ): Promise<WebAnnotationGetResult> {
    const store = await this.env(environmentId);
    const manifest = store.manifest;
    const stored = this.requireAnnotation(manifest, annotationId);
    const capture = await this.readCapture(store, manifest, stored.currentCaptureId);
    let entries: WebAnnotationEntry[];
    let nextEntrySequence: number | null;
    let previousEntrySequence: number | null = null;
    if (entryWindow === "latest") {
      const page = await this.readEntryPageBefore(
        store,
        manifest,
        annotationId,
        stored.lastSequence + 1,
        entryLimit,
      );
      entries = page.entries;
      nextEntrySequence = null;
      previousEntrySequence = page.previousSequence;
    } else {
      const page = await this.readEntryPage(store, manifest, annotationId, 0, entryLimit);
      entries = page.entries;
      nextEntrySequence = page.nextSequence;
    }
    const requests = stored.requestIds
      .map((id) => manifest.requests[id])
      .filter((request): request is WebAnnotationRequest => Boolean(request));
    const resultIds = requests.flatMap((request) => request.resultIds).slice(-MAX_GET_RESULTS);
    const results: WebAnnotationResult[] = [];
    for (const id of resultIds) {
      const result = await this.readResult(store, id);
      if (result) results.push(result);
    }
    return {
      generation: this.generation,
      revision: manifest.revision,
      annotation: this.project(store, stored),
      capture,
      entries,
      nextEntrySequence,
      previousEntrySequence,
      requests: requests.map((request) => ({ ...request })),
      results,
    };
  }

  async entries(
    environmentId: string,
    annotationId: string,
    afterSequence: number,
    limit: number = WEB_ANNOTATION_LIMITS.entryPageItems,
    beforeSequence?: number,
  ): Promise<WebAnnotationEntriesResult> {
    const store = await this.env(environmentId);
    const manifest = store.manifest;
    const annotation = this.requireAnnotation(manifest, annotationId);
    if (beforeSequence !== undefined) {
      if (
        afterSequence !== 0 ||
        !Number.isSafeInteger(beforeSequence) ||
        beforeSequence < 1 ||
        beforeSequence > annotation.lastSequence + 1
      ) {
        return { entries: [], nextSequence: null, previousSequence: null, resetRequired: true };
      }
      const page = await this.readEntryPageBefore(
        store,
        manifest,
        annotationId,
        beforeSequence,
        limit,
      );
      return {
        entries: page.entries,
        nextSequence: null,
        previousSequence: page.previousSequence,
        resetRequired: false,
      };
    }
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      afterSequence > annotation.lastSequence
    ) {
      return { entries: [], nextSequence: null, resetRequired: true };
    }
    const page = await this.readEntryPage(store, manifest, annotationId, afterSequence, limit);
    return { entries: page.entries, nextSequence: page.nextSequence, resetRequired: false };
  }

  async capture(environmentId: string, captureId: string): Promise<WebAnnotationCapture> {
    const store = await this.env(environmentId);
    const manifest = store.manifest;
    if (!isWebAnnotationId(captureId) || !manifest.captures[captureId]) throw notFound("Capture");
    const capture = await this.readCapture(store, manifest, captureId);
    if (!capture) throw degradedError("capture record is unreadable");
    return capture;
  }

  // -------------------------------------------------------------------------
  // Annotation mutations

  async create(input: WebAnnotationCreateInput): Promise<WebAnnotationOperationReceipt> {
    const capture = this.validateCapture(input.capture);
    const body = this.validateBody(input.body);
    const title =
      input.title === undefined
        ? defaultTitle(body, capture.target)
        : this.requireTitle(input.title);
    if (input.draftId !== undefined && !isWebAnnotationId(input.draftId)) {
      throw new WebAnnotationServiceError("draftId is invalid");
    }
    return this.annotationMutation(
      input.environmentId,
      input.operationId,
      "create",
      { capture: input.capture, body: input.body, title: input.title, draftId: input.draftId },
      (tx) => {
        this.assertAnnotationCapacity(tx.manifest);
        const annotationId = newId("annotation");
        const record = this.captureFromInput(tx, annotationId, 1, capture);
        const annotation: WebAnnotation = {
          id: annotationId,
          environmentId: input.environmentId,
          schemaVersion: WEB_ANNOTATION_SCHEMA_VERSION,
          metadataRevision: 1,
          contentRevision: 1,
          createdAt: tx.now,
          updatedAt: tx.now,
          lastActivityAt: tx.now,
          page: capture.page,
          currentCaptureId: record.id,
          captureRevision: 1,
          title,
          targetKind: capture.target.kind,
          targetLabel: capture.target.label,
          state: "open",
          hidden: false,
          defaultDestination: null,
          resolution: null,
          activeRequestId: null,
          requestIds: [],
          entryCount: 0,
          entryBytes: 0,
          lastSequence: 0,
          latestIntent: excerpt(body, INTENT_EXCERPT_CHARS),
          thumbnailAssetId: capture.assetIds[0] ?? null,
          imported: false,
        };
        tx.manifest.annotations[annotationId] = annotation;
        const entry = this.appendEntry(tx, annotation, {
          provenance: "host-user",
          kind: "comment",
          body,
          captureId: record.id,
        });
        if (input.draftId) this.removeDraftInTx(tx, (draft) => draft.id === input.draftId);
        return { annotation, captureId: record.id, entryId: entry.id };
      },
    );
  }

  protected assertAnnotationCapacity(manifest: WebAnnotationManifest): void {
    const count = liveAnnotationCount(manifest);
    const limit = WEB_ANNOTATION_LIMITS.environmentAnnotations;
    if (count >= limit) {
      throw capacityError(`environment has ${count} of ${limit} annotations`, {
        resource: "annotations",
        used: count,
        limit,
        requested: 1,
      });
    }
  }

  private requireTitle(value: unknown): string {
    const result = validateWebAnnotationTitle(value);
    if (!result.ok) throw new WebAnnotationServiceError(result.error);
    return result.value;
  }

  async appendEntryCommand(input: WebAnnotationCommandArgs["web_annotation_entry_append"]) {
    const body = this.validateBody(input.body);
    return this.annotationMutation(
      input.environmentId,
      input.operationId,
      "entry-append",
      {
        annotationId: input.annotationId,
        expectedContentRevision: input.expectedContentRevision,
        body: input.body,
        editorId: input.editorId,
      },
      (tx, store) => {
        const annotation = this.requireMutable(store, tx.manifest, input.annotationId);
        this.expectContentRevision(annotation, input.expectedContentRevision);
        this.bumpContent(tx, annotation);
        const entry = this.appendEntry(tx, annotation, {
          provenance: "host-user",
          kind: "comment",
          body,
        });
        annotation.latestIntent = excerpt(body, INTENT_EXCERPT_CHARS);
        this.reopenIfResolved(tx, annotation);
        if (input.editorId) this.removeDraftInTx(tx, (draft) => draft.editorId === input.editorId);
        return { annotation, entryId: entry.id };
      },
    );
  }

  async editEntry(input: WebAnnotationCommandArgs["web_annotation_entry_edit"]) {
    const body = this.validateBody(input.body);
    return this.annotationMutation(
      input.environmentId,
      input.operationId,
      "entry-edit",
      {
        annotationId: input.annotationId,
        entryId: input.entryId,
        expectedContentRevision: input.expectedContentRevision,
        body: input.body,
      },
      (tx, store) => {
        const annotation = this.requireMutable(store, tx.manifest, input.annotationId);
        this.expectContentRevision(annotation, input.expectedContentRevision);
        const index = (tx.manifest.entries[annotation.id] ?? []).find(
          (entry) => entry.id === input.entryId,
        );
        if (!index) throw notFound("Entry");
        if (index.provenance !== "host-user" || index.kind !== "comment") {
          throw new WebAnnotationServiceError("Only your own comments can be edited");
        }
        if (index.supersededBy) throw conflictError("entry was already edited; refresh and retry");
        this.bumpContent(tx, annotation);
        const entry = this.appendEntry(tx, annotation, {
          provenance: "host-user",
          kind: "comment",
          body,
          supersedes: index.id,
        });
        index.supersededBy = entry.id;
        const latest = (tx.manifest.entries[annotation.id] ?? [])
          .filter(
            (item) =>
              item.provenance === "host-user" && item.kind === "comment" && !item.supersededBy,
          )
          .at(-1);
        if (latest?.id === entry.id) annotation.latestIntent = excerpt(body, INTENT_EXCERPT_CHARS);
        this.reopenIfResolved(tx, annotation);
        return { annotation, entryId: entry.id };
      },
    );
  }

  async update(input: WebAnnotationCommandArgs["web_annotation_update"]) {
    const title = input.title === undefined ? undefined : this.requireTitle(input.title);
    if (
      input.defaultDestination !== undefined &&
      input.defaultDestination !== null &&
      !isWebAnnotationDestination(input.defaultDestination)
    ) {
      throw new WebAnnotationServiceError("defaultDestination is invalid");
    }
    if (input.hidden !== undefined && typeof input.hidden !== "boolean") {
      throw new WebAnnotationServiceError("hidden must be a boolean");
    }
    if (
      title === undefined &&
      input.defaultDestination === undefined &&
      input.hidden === undefined
    ) {
      throw new WebAnnotationServiceError("Nothing to update");
    }
    return this.annotationMutation(
      input.environmentId,
      input.operationId,
      "update",
      {
        annotationId: input.annotationId,
        expectedMetadataRevision: input.expectedMetadataRevision,
        title: input.title,
        defaultDestination: input.defaultDestination,
        hidden: input.hidden,
      },
      (tx, store) => {
        const annotation = this.requireMutable(store, tx.manifest, input.annotationId);
        this.expectMetadataRevision(annotation, input.expectedMetadataRevision);
        if (title !== undefined) annotation.title = title;
        if (input.defaultDestination !== undefined)
          annotation.defaultDestination = input.defaultDestination;
        if (input.hidden !== undefined) annotation.hidden = input.hidden;
        this.bumpMetadata(tx, annotation);
        return { annotation };
      },
    );
  }

  async replaceCapture(input: WebAnnotationCommandArgs["web_annotation_capture_replace"]) {
    const capture = this.validateCapture(input.capture);
    const body = input.body === undefined ? null : this.validateBody(input.body);
    return this.annotationMutation(
      input.environmentId,
      input.operationId,
      "capture-replace",
      {
        annotationId: input.annotationId,
        expectedContentRevision: input.expectedContentRevision,
        capture: input.capture,
        body: input.body,
      },
      (tx, store) => {
        const annotation = this.requireMutable(store, tx.manifest, input.annotationId);
        this.expectContentRevision(annotation, input.expectedContentRevision);
        const revision = this.nextCaptureRevision(tx.manifest, annotation.id);
        const record = this.captureFromInput(tx, annotation.id, revision, capture);
        annotation.currentCaptureId = record.id;
        annotation.captureRevision = revision;
        annotation.page = capture.page;
        annotation.targetKind = capture.target.kind;
        annotation.targetLabel = capture.target.label;
        annotation.thumbnailAssetId = capture.assetIds[0] ?? null;
        this.bumpContent(tx, annotation);
        this.appendEntry(tx, annotation, {
          provenance: "system",
          kind: "lifecycle",
          body: null,
          lifecycle: { event: "capture-replaced" },
          captureId: record.id,
          force: true,
        });
        let entryId: string | null = null;
        if (body !== null) {
          entryId = this.appendEntry(tx, annotation, {
            provenance: "host-user",
            kind: "comment",
            body,
          }).id;
          annotation.latestIntent = excerpt(body, INTENT_EXCERPT_CHARS);
          this.reopenIfResolved(tx, annotation);
        }
        return { annotation, captureId: record.id, entryId };
      },
    );
  }

  async resolve(input: WebAnnotationResolveInput) {
    if (
      input.note !== undefined &&
      (typeof input.note !== "string" || input.note.length > WEB_ANNOTATION_LIMITS.entryChars)
    ) {
      throw new WebAnnotationServiceError("note is invalid");
    }
    return this.annotationMutation(
      input.environmentId,
      input.operationId,
      "resolve",
      { ...input, operationId: undefined, environmentId: undefined },
      (tx, store) => {
        const annotation = this.requireMutable(store, tx.manifest, input.annotationId);
        if (annotation.state === "resolved") throw conflictError("annotation is already resolved");
        this.expectContentRevision(annotation, input.expectedContentRevision);
        if (annotation.currentCaptureId !== input.expectedCaptureId) {
          throw conflictError(
            "capture changed since review; refresh and review the current capture",
          );
        }
        let resultRevision: number | undefined;
        if (input.resultId !== undefined && input.requestId === undefined) {
          throw new WebAnnotationServiceError("resultId requires requestId");
        }
        if (input.requestId !== undefined) {
          const request = tx.manifest.requests[input.requestId];
          if (
            !request ||
            !request.selections.some((selection) => selection.annotationId === annotation.id)
          ) {
            throw notFound("Request");
          }
          if (input.resultId !== undefined) {
            const result = tx.manifest.results[input.resultId];
            if (!result || result.requestId !== request.id) throw notFound("Result");
            const superseded = Object.values(tx.manifest.results).some(
              (other) => other.supersedes === result.id,
            );
            if (superseded || result.revision !== input.expectedResultRevision) {
              throw conflictError("result revision is stale; review the latest result");
            }
            resultRevision = result.revision;
          } else if (input.expectedResultRevision !== undefined) {
            throw new WebAnnotationServiceError("expectedResultRevision requires resultId");
          }
        }
        annotation.state = "resolved";
        annotation.resolution = {
          acceptedBy: "host-user",
          acceptedAt: tx.now,
          contentRevision: annotation.contentRevision,
          captureId: annotation.currentCaptureId,
          captureRevision: annotation.captureRevision,
          ...(input.requestId ? { requestId: input.requestId } : {}),
          ...(input.resultId ? { resultId: input.resultId } : {}),
          ...(resultRevision !== undefined ? { resultRevision } : {}),
          ...(input.note ? { note: input.note } : {}),
        };
        this.appendEntry(tx, annotation, {
          provenance: "system",
          kind: "lifecycle",
          body: null,
          lifecycle: {
            event: "resolved",
            ...(input.requestId ? { requestId: input.requestId } : {}),
          },
          force: true,
        });
        this.bumpMetadata(tx, annotation);
        return { annotation };
      },
    );
  }

  async reopen(input: WebAnnotationCommandArgs["web_annotation_reopen"]) {
    const body = input.body === undefined ? null : this.validateBody(input.body);
    return this.annotationMutation(
      input.environmentId,
      input.operationId,
      "reopen",
      {
        annotationId: input.annotationId,
        expectedMetadataRevision: input.expectedMetadataRevision,
        body: input.body,
      },
      (tx, store) => {
        const annotation = this.requireMutable(store, tx.manifest, input.annotationId);
        this.expectMetadataRevision(annotation, input.expectedMetadataRevision);
        if (annotation.state !== "resolved") throw conflictError("annotation is not resolved");
        this.reopenIfResolved(tx, annotation);
        let entryId: string | null = null;
        if (body !== null) {
          this.bumpContent(tx, annotation);
          entryId = this.appendEntry(tx, annotation, {
            provenance: "host-user",
            kind: "comment",
            body,
          }).id;
          annotation.latestIntent = excerpt(body, INTENT_EXCERPT_CHARS);
        } else {
          this.bumpMetadata(tx, annotation);
        }
        return { annotation, entryId };
      },
    );
  }

  async delete(input: WebAnnotationCommandArgs["web_annotation_delete"]) {
    return this.annotationMutation(
      input.environmentId,
      input.operationId,
      "delete",
      {
        annotationId: input.annotationId,
        expectedMetadataRevision: input.expectedMetadataRevision,
      },
      (tx) => {
        const annotation = this.requireAnnotation(tx.manifest, input.annotationId);
        if (annotation.state === "deleted") return { annotation };
        this.expectMetadataRevision(annotation, input.expectedMetadataRevision);
        const active = annotation.activeRequestId
          ? tx.manifest.requests[annotation.activeRequestId]
          : undefined;
        if (active && isWebAnnotationRequestActive(active.state)) {
          throw conflictError(
            `request ${active.id} is still ${active.state}; cancel or recover it before deleting`,
          );
        }
        annotation.state = "deleted";
        annotation.hidden = true;
        this.bumpMetadata(tx, annotation);
        return { annotation };
      },
    );
  }

  // -------------------------------------------------------------------------
  // Archive and continuation (thread history limits)

  /**
   * Archive a thread and continue it in a new linked thread, in one commit.
   *
   * The archived thread keeps every entry, capture, request, and result and
   * becomes read-only; it leaves default lists but stays readable and
   * pageable. The continuation starts with a copy of the current capture
   * (same target, page, evidence, and images), the default destination, the
   * latest host intent excerpt, a `created` lifecycle entry linking back,
   * and optionally a first host note. Refused while an implementation is
   * still active for the thread, so no in-flight review is stranded.
   */
  async archive(input: WebAnnotationArchiveInput): Promise<WebAnnotationArchiveResult> {
    this.assertOperationId(input.operationId);
    const body = input.body === undefined ? null : this.validateBody(input.body);
    const title = input.title === undefined ? undefined : this.requireTitle(input.title);
    const store = await this.env(input.environmentId);
    const kind = "archive";
    const bodyHash = hashBody(kind, {
      annotationId: input.annotationId,
      expectedMetadataRevision: input.expectedMetadataRevision,
      title: input.title,
      body: input.body,
    });
    const source = this.requireAnnotation(store.manifest, input.annotationId);
    // Read the capture being carried outside the write queue; revalidated below.
    const carried = await this.readCapture(store, store.manifest, source.currentCaptureId);
    const committed = await store.mutate((tx) => {
      const existing = this.lookupReceipt(tx.manifest, input.operationId, kind, bodyHash);
      if (existing?.receipt && existing.value) {
        return {
          continuation: existing.receipt,
          archivedAnnotationId: String(existing.value.archivedAnnotationId),
          archivedMetadataRevision: Number(existing.value.archivedMetadataRevision),
        };
      }
      const archived = this.requireMutable(store, tx.manifest, input.annotationId);
      this.expectMetadataRevision(archived, input.expectedMetadataRevision);
      const active = archived.activeRequestId
        ? tx.manifest.requests[archived.activeRequestId]
        : undefined;
      if (active && isWebAnnotationRequestActive(active.state)) {
        throw conflictError(
          `request ${active.id} is still ${active.state}; let it settle or cancel it before archiving`,
        );
      }
      if (!carried || carried.id !== archived.currentCaptureId) {
        throw conflictError("the capture changed or is unreadable; refresh and retry");
      }
      this.assertAnnotationCapacity(tx.manifest);
      const continuationId = newId("annotation");
      const capture = this.writeCapture(tx, {
        annotationId: continuationId,
        revision: 1,
        producer: carried.producer,
        capturedAt: carried.capturedAt,
        documentGeneration: carried.documentGeneration,
        page: carried.page,
        target: carried.target,
        geometry: carried.geometry,
        evidence: carried.evidence,
        assetIds: carried.assetIds,
        redaction: carried.redaction,
        state: carried.state,
        ...(carried.stateReason ? { stateReason: carried.stateReason } : {}),
      });
      const continuation: WebAnnotation = {
        id: continuationId,
        environmentId: input.environmentId,
        schemaVersion: WEB_ANNOTATION_SCHEMA_VERSION,
        metadataRevision: 1,
        contentRevision: 1,
        createdAt: tx.now,
        updatedAt: tx.now,
        lastActivityAt: tx.now,
        page: archived.page,
        currentCaptureId: capture.id,
        captureRevision: 1,
        title: title ?? continuationTitle(archived.title),
        targetKind: archived.targetKind,
        targetLabel: archived.targetLabel,
        state: "open",
        hidden: false,
        defaultDestination: archived.defaultDestination,
        resolution: null,
        activeRequestId: null,
        requestIds: [],
        entryCount: 0,
        entryBytes: 0,
        lastSequence: 0,
        latestIntent: body !== null ? excerpt(body, INTENT_EXCERPT_CHARS) : archived.latestIntent,
        thumbnailAssetId: archived.thumbnailAssetId,
        imported: archived.imported,
        continuedFromId: archived.id,
      };
      tx.manifest.annotations[continuationId] = continuation;
      this.appendEntry(tx, continuation, {
        provenance: "system",
        kind: "lifecycle",
        body: null,
        lifecycle: { event: "created", relatedAnnotationId: archived.id },
        captureId: capture.id,
        force: true,
      });
      let entryId: string | null = null;
      if (body !== null) {
        entryId = this.appendEntry(tx, continuation, {
          provenance: "host-user",
          kind: "comment",
          body,
          captureId: capture.id,
        }).id;
      }
      this.appendEntry(tx, archived, {
        provenance: "system",
        kind: "lifecycle",
        body: null,
        lifecycle: { event: "archived", relatedAnnotationId: continuationId },
        force: true,
      });
      archived.archivedAt = tx.now;
      archived.continuationId = continuationId;
      this.bumpMetadata(tx, archived);
      const receipt: WebAnnotationOperationReceipt = {
        operationId: input.operationId,
        annotationId: continuationId,
        captureId: capture.id,
        entryId,
        contentRevision: continuation.contentRevision,
        metadataRevision: continuation.metadataRevision,
        captureRevision: continuation.captureRevision,
        environmentRevision: tx.manifest.revision + 1,
      };
      this.pushReceipt(tx, {
        operationId: input.operationId,
        kind,
        bodyHash,
        recordedAt: tx.now,
        receipt,
        value: {
          archivedAnnotationId: archived.id,
          archivedMetadataRevision: archived.metadataRevision,
        },
      });
      tx.touch({ annotationIds: [archived.id, continuationId] });
      return {
        continuation: receipt,
        archivedAnnotationId: archived.id,
        archivedMetadataRevision: archived.metadataRevision,
      };
    });
    return committed.value;
  }
}
