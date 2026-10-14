/**
 * One-time import of the file-based web-annotation storage (format 1 and 2)
 * into the environment's database store.
 *
 * The old layout under `<dataDir>/web-annotations/<environmentId>/` was
 * `manifest.json` (+ `manifest.prev.json`), `drafts.json` (+ `drafts.prev.json`)
 * and immutable `records/<sha40>/<revision>.json`. This module reads it with
 * the same recovery the file engine applied on load:
 *
 * - a damaged or missing `manifest.json` falls back to `manifest.prev.json`,
 *   imported as `degraded` (read-only), exactly as it was served before;
 * - a manifest (or annotation) written by a newer version, or no readable
 *   manifest at all, is `unavailable`: nothing is imported, nothing is moved,
 *   and the next load tries again (a newer build or a repaired file wins);
 * - version 1 manifests (inline requests and drafts) load; version 2 request
 *   text is read from its `request-text` record into the request;
 * - drafts consumed by a manifest commit whose `drafts.json` write was lost
 *   (`consumedDrafts`) are dropped;
 * - a referenced record that is missing or damaged becomes an `unreadable`
 *   row, so the items depending on it stay read-only instead of empty.
 *
 * PNG assets stay where they are. After a clean import the old files move to
 * `<dataDir>/legacy-json/<timestamp>/web-annotations/<environmentId>/`, the
 * same 14-day recovery window the JSON store import uses (they hold user
 * notes, so they are kept for a downgrade or manual recovery rather than
 * deleted, and environment deletion removes them). An imperfect import
 * (degraded manifest or drafts, or any unreadable record) leaves them in place
 * so nothing a manual repair could still recover is ever discarded.
 */
import { chmod, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  WEB_ANNOTATION_LIMITS,
  isWebAnnotationRequestActive,
  type WebAnnotationErrorDetail,
  type WebAnnotationRequest,
  type WebAnnotationStorageStatus,
} from "@orkestrator/protocol/web-annotations";
import { LEGACY_JSON_DIRECTORY } from "./storage-stores.js";
import { recordKey, type UnreadableRecord } from "./web-annotation-store-rows.js";
import {
  WebAnnotationStorageError,
  emptyManifest,
  isRecord,
  parseDrafts,
  parseManifest,
  recordDirectoryName,
  requestTextRecordId,
  type RequestTextRef,
  type StorageErrorCode,
  type WebAnnotationManifest,
  type WebAnnotationRecordKind,
} from "./web-annotation-storage-format.js";

/** Upper bound for any single immutable record file (and row). */
export const WEB_ANNOTATION_MAX_RECORD_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = WEB_ANNOTATION_LIMITS.environmentMetadataBytes + 1024 * 1024;
const MAX_DRAFTS_BYTES = 4 * 1024 * 1024;
const READ_CONCURRENCY = 16;

const LEGACY_INDEX_FILES = [
  "manifest.json",
  "manifest.prev.json",
  "drafts.json",
  "drafts.prev.json",
] as const;
const LEGACY_RECORDS_DIRECTORY = "records";

export interface LegacyRecordRow {
  key: string;
  json: string;
  bytes: number;
}

export interface LegacyImport {
  manifest: WebAnnotationManifest;
  status: "ready" | "degraded";
  reason?: string;
  draftsStatus: WebAnnotationStorageStatus;
  records: LegacyRecordRow[];
  unreadable: Map<string, UnreadableRecord>;
  sourceVersion: 1 | 2;
  /** Everything was read: the files may be archived. */
  clean: boolean;
}

export type LegacyReadResult =
  | { kind: "absent" }
  | {
      kind: "unavailable";
      reason: string;
      detail?: WebAnnotationErrorDetail;
    }
  | { kind: "import"; legacy: LegacyImport };

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function storageCode(error: unknown): StorageErrorCode {
  if (error instanceof WebAnnotationStorageError && error.code) return error.code;
  return errorCode(error) === "ENOENT" ? "manifest-missing" : "manifest-unreadable";
}

async function mapBounded<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) await work(items[cursor++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function readJson(path: string, maxBytes: number): Promise<{ value: unknown }> {
  const info = await stat(path);
  if (info.size > maxBytes) {
    throw new WebAnnotationStorageError("index is too large", "manifest-too-large");
  }
  const json = await readFile(path, "utf8");
  try {
    return { value: JSON.parse(json) as unknown };
  } catch {
    throw new WebAnnotationStorageError("manifest is not valid JSON", "manifest-invalid-json");
  }
}

/** Whether any file of the old layout exists for this environment. */
export async function hasLegacyFiles(dir: string): Promise<boolean> {
  return (await legacyEntries(dir)).length > 0;
}

async function legacyEntries(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names.filter(
    (name) =>
      (LEGACY_INDEX_FILES as readonly string[]).includes(name) ||
      name === LEGACY_RECORDS_DIRECTORY ||
      // The file writer's temp files: `<index>.<uuid>.tmp`.
      (name.endsWith(".tmp") && LEGACY_INDEX_FILES.some((file) => name.startsWith(`${file}.`))),
  );
}

interface RecordRead {
  kind: WebAnnotationRecordKind;
  id: string;
  revision: number;
  /** Content check for records current state depends on. */
  valid?: (value: unknown) => boolean;
}

/**
 * Read the old layout. Never writes. Throws only for I/O errors other than a
 * missing file (EACCES, EIO): the data may be intact, so the caller retries
 * later instead of importing a partial copy.
 */
export async function readLegacyEnvironment(
  dir: string,
  environmentId: string,
  now: string,
): Promise<LegacyReadResult> {
  if (!(await hasLegacyFiles(dir))) return { kind: "absent" };
  const readManifestFile = async (path: string) => {
    const { value } = await readJson(path, MAX_MANIFEST_BYTES);
    return parseManifest(value, environmentId);
  };
  const rethrowIo = (error: unknown) => {
    const code = errorCode(error);
    if (
      code &&
      code !== "ENOENT" &&
      code !== "ENOTDIR" &&
      !(error instanceof WebAnnotationStorageError)
    ) {
      throw error;
    }
  };
  let parsed: Awaited<ReturnType<typeof readManifestFile>> | null = null;
  let status: "ready" | "degraded" = "ready";
  let reason: string | undefined;
  try {
    parsed = await readManifestFile(join(dir, "manifest.json"));
  } catch (error) {
    rethrowIo(error);
    const code = storageCode(error);
    if (code === "unsupported-version")
      return unavailable(error, "manifest uses an unsupported version");
    let previous: Awaited<ReturnType<typeof readManifestFile>> | null = null;
    let previousError: unknown = null;
    try {
      previous = await readManifestFile(join(dir, "manifest.prev.json"));
    } catch (caught) {
      rethrowIo(caught);
      previousError = caught;
    }
    if (!previous) {
      if (code === "manifest-missing" && errorCode(previousError) === "ENOENT") {
        // Never committed a listing index (drafts only, or leftovers).
        parsed = null;
      } else if (storageCode(previousError) === "unsupported-version") {
        return unavailable(previousError, "manifest uses an unsupported version");
      } else {
        return unavailable(error, "manifest is unreadable");
      }
    } else {
      parsed = previous;
      status = "degraded";
      reason =
        code === "manifest-missing"
          ? "manifest is missing; serving the previous committed copy read-only"
          : `${error instanceof WebAnnotationStorageError ? error.message : "manifest is unreadable"}; serving the previous committed copy read-only`;
      console.warn(`[web-annotations] Legacy storage degraded (code=${code})`);
    }
  }
  const manifest = parsed?.manifest ?? emptyManifest(environmentId, now);
  const sourceVersion = parsed?.sourceVersion ?? 2;
  const unreadable = new Map<string, UnreadableRecord>();
  const records: LegacyRecordRow[] = [];

  /** Reads and validates one record; `keep` adds it to the imported rows. */
  const readRecord = async (read: RecordRead, keep = true): Promise<unknown> => {
    const path = join(
      dir,
      LEGACY_RECORDS_DIRECTORY,
      recordDirectoryName(read.id),
      `${read.revision}.json`,
    );
    const key = recordKey(read.id, read.revision);
    const mark = (state: "missing" | "unreadable") => {
      unreadable.set(key, { kind: read.kind, state });
      return undefined;
    };
    let text: string;
    try {
      const info = await stat(path);
      if (info.size > WEB_ANNOTATION_MAX_RECORD_BYTES) return mark("unreadable");
      text = await readFile(path, "utf8");
    } catch (error) {
      rethrowIo(error);
      return mark(errorCode(error) === "ENOENT" ? "missing" : "unreadable");
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      return mark("unreadable");
    }
    if (
      !isRecord(envelope) ||
      envelope.kind !== read.kind ||
      envelope.id !== read.id ||
      envelope.revision !== read.revision ||
      !Object.hasOwn(envelope, "value")
    ) {
      return mark("unreadable");
    }
    if (read.valid && !read.valid(envelope.value)) return mark("unreadable");
    if (keep) {
      const json = JSON.stringify({ kind: read.kind, value: envelope.value });
      records.push({ key, json, bytes: Buffer.byteLength(json, "utf8") });
    }
    return envelope.value;
  };

  // Version 2 request text: instruction and response excerpt.
  const textRefs: ReadonlyMap<string, RequestTextRef | null> = parsed?.textRefs ?? new Map();
  await mapBounded(Array.from(textRefs), READ_CONCURRENCY, async ([requestId, ref]) => {
    const request = manifest.requests[requestId];
    if (!request) return;
    const id = requestTextRecordId(requestId);
    const damage = (state: "missing" | "unreadable") => {
      unreadable.set(recordKey(id, ref?.revision ?? 0), {
        kind: "request-text",
        state,
        requestId,
      });
    };
    if (!ref) return damage("missing");
    // The text moves into the request row; it is not kept as a record.
    const value = await readRecord({ kind: "request-text", id, revision: ref.revision }, false);
    const key = recordKey(id, ref.revision);
    if (unreadable.has(key)) {
      unreadable.set(key, { ...unreadable.get(key)!, requestId });
      return;
    }
    if (
      !isRecord(value) ||
      typeof value.instruction !== "string" ||
      (value.response !== null && !isRecord(value.response))
    ) {
      return damage("unreadable");
    }
    request.instruction = value.instruction;
    request.response = value.response as WebAnnotationRequest["response"];
  });

  // Drafts: inline in version 1, `drafts.json` (else its previous copy) in version 2.
  let draftsStatus: WebAnnotationStorageStatus = "ready";
  if (sourceVersion !== 1) {
    manifest.drafts = {};
    const read = async (path: string) =>
      parseDrafts((await readJson(path, MAX_DRAFTS_BYTES)).value, environmentId);
    try {
      manifest.drafts = (await read(join(dir, "drafts.json"))).drafts;
    } catch (error) {
      rethrowIo(error);
      let previous: Awaited<ReturnType<typeof read>> | null = null;
      let previousError: unknown = null;
      try {
        previous = await read(join(dir, "drafts.prev.json"));
      } catch (caught) {
        rethrowIo(caught);
        previousError = caught;
      }
      if (previous) {
        manifest.drafts = previous.drafts;
        draftsStatus = "degraded";
      } else if (!(errorCode(error) === "ENOENT" && errorCode(previousError) === "ENOENT")) {
        draftsStatus = "unavailable";
      }
      if (draftsStatus !== "ready") {
        console.warn(
          `[web-annotations] Legacy draft index ${draftsStatus} (code=${storageCode(error)})`,
        );
      }
    }
  }
  // A crash between a manifest commit and its draft index write.
  const consumed = new Set(manifest.consumedDrafts ?? []);
  for (const [editorId, draft] of Object.entries(manifest.drafts)) {
    if (consumed.has(draft.id)) delete manifest.drafts[editorId];
  }
  manifest.consumedDrafts = [];

  const reads: RecordRead[] = [];
  const liveCaptures = new Set<string>();
  for (const annotation of Object.values(manifest.annotations)) {
    if (annotation.state !== "deleted") liveCaptures.add(annotation.currentCaptureId);
  }
  for (const capture of Object.values(manifest.captures)) {
    const annotation = manifest.annotations[capture.annotationId];
    reads.push({
      kind: "capture",
      id: capture.id,
      revision: 1,
      ...(annotation && liveCaptures.has(capture.id) && annotation.currentCaptureId === capture.id
        ? {
            valid: (value: unknown) =>
              isRecord(value) &&
              value.id === capture.id &&
              value.annotationId === annotation.id &&
              value.schemaVersion === 1 &&
              isRecord(value.target) &&
              isRecord(value.page),
          }
        : {}),
    });
  }
  for (const entries of Object.values(manifest.entries)) {
    for (const entry of entries) reads.push({ kind: "entry", id: entry.id, revision: 1 });
  }
  for (const request of Object.values(manifest.requests)) {
    reads.push({
      kind: "brief",
      id: request.id,
      revision: 1,
      ...(isWebAnnotationRequestActive(request.state)
        ? {
            valid: (value: unknown) =>
              isRecord(value) &&
              typeof value.body === "string" &&
              value.bodyHash === request.bodyHash,
          }
        : {}),
    });
  }
  for (const result of Object.values(manifest.results)) {
    reads.push({ kind: "result", id: result.id, revision: 1 });
  }
  if (draftsStatus !== "unavailable") {
    for (const draft of Object.values(manifest.drafts)) {
      reads.push({ kind: "draft", id: draft.id, revision: draft.revision });
    }
  }
  await mapBounded(reads, READ_CONCURRENCY, async (read) => {
    await readRecord(read);
  });
  // Only records current state depends on degrade an item; a missing brief of
  // a settled request or an old capture just stays unreadable.
  if (unreadable.size > 0) {
    console.warn(`[web-annotations] Legacy import found ${unreadable.size} unreadable record(s)`);
  }
  return {
    kind: "import",
    legacy: {
      manifest,
      status,
      ...(reason ? { reason } : {}),
      draftsStatus,
      records,
      unreadable,
      sourceVersion,
      clean: status === "ready" && draftsStatus === "ready" && unreadable.size === 0,
    },
  };
}

function unavailable(error: unknown, fallback: string): LegacyReadResult {
  console.warn(`[web-annotations] Legacy storage unavailable (code=${storageCode(error)})`);
  return {
    kind: "unavailable",
    reason: error instanceof WebAnnotationStorageError ? error.message : fallback,
    ...(error instanceof WebAnnotationStorageError && error.detail ? { detail: error.detail } : {}),
  };
}

function archiveStamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

/**
 * Move the old index files and records (not assets, staging or migration
 * backups) into the legacy JSON archive. Returns the number of entries moved.
 */
export async function archiveLegacyEnvironment(
  dataDir: string,
  environmentId: string,
  now = Date.now(),
): Promise<number> {
  const dir = join(dataDir, "web-annotations", environmentId);
  const entries = await legacyEntries(dir);
  if (entries.length === 0) return 0;
  const archiveRoot = join(dataDir, LEGACY_JSON_DIRECTORY);
  const archive = join(archiveRoot, archiveStamp(now), "web-annotations", environmentId);
  await mkdir(archive, { recursive: true, mode: 0o700 });
  await chmod(archiveRoot, 0o700).catch(() => undefined);
  let moved = 0;
  for (const name of entries) {
    try {
      await rename(join(dir, name), join(archive, name));
      moved++;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  return moved;
}

/** Remove archived legacy files of a deleted environment (privacy). */
export async function removeArchivedLegacyEnvironment(
  dataDir: string,
  environmentId: string,
): Promise<void> {
  const archiveRoot = join(dataDir, LEGACY_JSON_DIRECTORY);
  let stamps: string[];
  try {
    stamps = await readdir(archiveRoot);
  } catch {
    return;
  }
  for (const stamp of stamps) {
    await rm(join(archiveRoot, stamp, "web-annotations", environmentId), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }
}
