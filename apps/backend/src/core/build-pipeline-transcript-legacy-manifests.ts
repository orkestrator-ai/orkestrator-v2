import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import {
  KEYED_RECORD_DEFAULT_MAX_HEADER_BYTES,
  KEYED_RECORD_EXTENSION,
  KEYED_RECORD_PREVIOUS_EXTENSION,
  isMissingPathError,
  readRecordFile,
  readRecordHeader,
  recordFileStem,
} from "./keyed-record-format.js";
import { BUILD_PIPELINE_TRANSCRIPT_LEGACY_MIGRATION_STORE } from "./build-pipeline-transcript-layout.js";
import {
  isTranscriptManifestRow,
  type TranscriptChunkRef,
  type TranscriptManifestRow,
  type TranscriptManifestRows,
} from "./build-pipeline-transcript-manifests.js";
import type { StorageDatabase } from "./storage-database.js";

/**
 * Import of the manifests the pre-database transcript store kept as files
 * (`build-pipeline-transcripts/manifests/<stem>.rec` plus a `.prev`
 * generation, an `_meta/index.json` and tombstones) into the manifest store.
 *
 * It runs in the background in small batches, never inside the synchronous
 * open-time migration: each batch reads its files asynchronously, then commits
 * the new rows and the progress cursor in one short transaction, so a crash
 * resumes after the last committed batch and a re-run is idempotent (a key
 * that already has a row is never overwritten). Only manifests whose pipeline
 * still has a control record are imported, so a pipeline deleted meanwhile is
 * never resurrected. Once every file was visited, the progress moves to
 * `cleanup` before the old manifest directory is removed, so a crash during
 * removal never re-imports a file. Chunk files are shared unchanged: the new
 * rows name the same content-addressed chunks.
 *
 * Reads and checkpoints of a session whose manifest was not imported yet
 * import that one key on demand ({@link importLegacyManifest}).
 */
export const LEGACY_MANIFEST_DIRECTORY = "manifests";
const LEGACY_SCHEMA = "build-pipeline-transcript-v1+manifest";
const LEGACY_FORMAT = "ork-record-manifest-v1";
const LEGACY_META_VERSION = 1;
const DEFAULT_BATCH = 32;

type MigrationStatus = "importing" | "cleanup" | "complete";

interface MigrationState {
  v: 1;
  status: MigrationStatus;
  /** Last stem whose batch committed; files sort by stem. */
  cursor: string | null;
  imported: number;
  skipped: number;
  updatedAt: string;
}

export interface LegacyManifestDeps {
  database: () => StorageDatabase;
  rows: TranscriptManifestRows;
  namespace: string;
  /** The transcript directory (`<data>/build-pipeline-transcripts`). */
  directory: string;
  maxManifestBytes: number;
  /** Synchronous, called inside the import transaction. */
  isLive: (pipelineTag: string) => boolean;
  now: () => number;
}

export interface LegacyManifestMigrationReport {
  imported: number;
  skipped: number;
  complete: boolean;
}

function isState(value: unknown): value is MigrationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    state.v === 1 &&
    (state.status === "importing" || state.status === "cleanup" || state.status === "complete") &&
    (state.cursor === null || typeof state.cursor === "string") &&
    typeof state.imported === "number" &&
    typeof state.skipped === "number"
  );
}

function readState(database: StorageDatabase): MigrationState | null {
  try {
    const value = database.readStore(BUILD_PIPELINE_TRANSCRIPT_LEGACY_MIGRATION_STORE)?.value;
    return isState(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStateInTransaction(deps: LegacyManifestDeps, state: Omit<MigrationState, "v">) {
  deps.database().writeStoreInTransaction(BUILD_PIPELINE_TRANSCRIPT_LEGACY_MIGRATION_STORE, {
    v: 1,
    ...state,
    updatedAt: new Date(deps.now()).toISOString(),
  });
}

function manifestsDirectory(deps: Pick<LegacyManifestDeps, "directory">): string {
  return path.join(deps.directory, LEGACY_MANIFEST_DIRECTORY);
}

/** True once no pre-database manifest can still need importing. */
export function legacyManifestsSettled(deps: LegacyManifestDeps): boolean {
  const state = readState(deps.database());
  if (state?.status === "complete") return true;
  return !existsSync(manifestsDirectory(deps));
}

interface LegacyMeta {
  v: number;
  sdkSessionId: string;
  revision: number;
  fingerprint: string;
  contentDigest: string;
  messageCount: number;
  counts: number[];
  bytes: number;
  omittedMessages: number;
  committedAt: string;
  sourceRevision?: number;
}

function toRow(
  payload: Buffer,
  header: { revision: number; owner: Record<string, string>; key: string },
): TranscriptManifestRow | null {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (manifest.format !== LEGACY_FORMAT || !Array.isArray(manifest.chunks)) return null;
  const meta = manifest.meta as LegacyMeta | undefined;
  if (
    !meta ||
    meta.v !== LEGACY_META_VERSION ||
    !Array.isArray(meta.counts) ||
    meta.counts.length !== manifest.chunks.length
  ) {
    return null;
  }
  const chunks: TranscriptChunkRef[] = [];
  let firstIndex = 0;
  let totalBytes = 0;
  for (const [index, chunk] of (manifest.chunks as Array<Record<string, unknown>>).entries()) {
    const count = meta.counts[index]!;
    chunks.push({
      name: chunk.name as string,
      firstIndex,
      count,
      length: chunk.length as number,
      checksum: chunk.checksum as string,
    });
    firstIndex += count;
    totalBytes += typeof chunk.length === "number" ? chunk.length : 0;
  }
  const row: TranscriptManifestRow = {
    v: 1,
    revision: header.revision,
    pipeline: header.owner.pipeline ?? header.key.split("/")[0] ?? "",
    sdkSessionId: meta.sdkSessionId,
    displayRevision: meta.revision,
    fingerprint: meta.fingerprint,
    contentDigest: meta.contentDigest,
    messageCount: meta.messageCount,
    bytes: meta.bytes,
    omittedMessages: meta.omittedMessages,
    committedAt: meta.committedAt,
    ...(meta.sourceRevision === undefined ? {} : { sourceRevision: meta.sourceRevision }),
    totalBytes,
    chunks,
  };
  return isTranscriptManifestRow(row) && row.pipeline ? row : null;
}

/**
 * Reads one legacy session manifest: the current generation, else the
 * retained previous one (or the generation `preferRevision` names, when it is
 * readable — the one the control record references).
 */
async function readLegacyManifest(
  deps: LegacyManifestDeps,
  stem: string,
  expectedKey?: string,
  preferRevision?: number,
): Promise<{ key: string; row: TranscriptManifestRow } | null> {
  const limits = {
    maxHeaderBytes: KEYED_RECORD_DEFAULT_MAX_HEADER_BYTES,
    maxPayloadBytes: deps.maxManifestBytes,
  };
  const candidates: Array<{ key: string; row: TranscriptManifestRow }> = [];
  for (const extension of [KEYED_RECORD_EXTENSION, KEYED_RECORD_PREVIOUS_EXTENSION]) {
    const file = path.join(manifestsDirectory(deps), `${stem}${extension}`);
    const header = await readRecordHeader(
      file,
      {
        schema: LEGACY_SCHEMA,
        retentionClass: "durable",
        ...(expectedKey ? { key: expectedKey } : {}),
      },
      limits,
    );
    if (header.status !== "ok") continue;
    const key = header.header.key;
    // The file name is the namespaced hash of the key it claims.
    if (recordFileStem(deps.namespace, key) !== stem) continue;
    const read = await readRecordFile(
      file,
      { schema: LEGACY_SCHEMA, key, retentionClass: "durable" },
      limits,
    );
    if (read.status !== "ok") continue;
    const row = toRow(read.payload, { ...read.header, key });
    if (row) candidates.push({ key, row });
  }
  if (preferRevision !== undefined) {
    const preferred = candidates.find((candidate) => candidate.row.revision === preferRevision);
    if (preferred) return preferred;
  }
  return candidates[0] ?? null;
}

function commitImports(
  deps: LegacyManifestDeps,
  imports: ReadonlyArray<{ key: string; row: TranscriptManifestRow }>,
): { imported: number; skipped: number } {
  let imported = 0;
  let skipped = 0;
  for (const { key, row } of imports) {
    if (deps.isLive(row.pipeline) && deps.rows.insertIfAbsent(key, row)) imported += 1;
    else skipped += 1;
  }
  return { imported, skipped };
}

/** On-demand import of one key (a read or checkpoint ahead of the background job). */
export async function importLegacyManifest(
  deps: LegacyManifestDeps,
  key: string,
  options: {
    preferRevision?: number;
    /** The caller is writing this pipeline's control record (it may not exist yet). */
    ownerIsLive?: boolean;
  } = {},
): Promise<"imported" | "absent" | "skipped"> {
  const stem = recordFileStem(deps.namespace, key);
  const found = await readLegacyManifest(deps, stem, key, options.preferRevision);
  if (!found) return "absent";
  const imported = deps.database().transaction(() => {
    if (options.ownerIsLive) return deps.rows.insertIfAbsent(found.key, found.row);
    return commitImports(deps, [found]).imported > 0;
  });
  return imported ? "imported" : "skipped";
}

async function legacyStems(directory: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
  const stems = new Set<string>();
  for (const entry of entries) {
    for (const extension of [KEYED_RECORD_EXTENSION, KEYED_RECORD_PREVIOUS_EXTENSION]) {
      if (!entry.endsWith(extension)) continue;
      const stem = entry.slice(0, -extension.length);
      if (/^[0-9a-f]{64}$/.test(stem)) stems.add(stem);
    }
  }
  return [...stems].sort();
}

/**
 * Background, batched import of every legacy manifest, then removal of the
 * old manifest files. `preferRevision` maps a row key to the manifest revision
 * its control record references, so the referenced generation is imported
 * when both survive.
 */
export async function migrateLegacyManifests(
  deps: LegacyManifestDeps,
  options: {
    batchSize?: number;
    shouldContinue?: () => boolean;
    preferRevision?: (key: string) => number | undefined;
    afterBatch?: (cursor: string) => Promise<void>;
  } = {},
): Promise<LegacyManifestMigrationReport> {
  const report: LegacyManifestMigrationReport = { imported: 0, skipped: 0, complete: false };
  const directory = manifestsDirectory(deps);
  let state = readState(deps.database());
  if (state?.status === "complete") return { ...report, complete: true };
  if (!state && !existsSync(directory)) {
    deps.database().transaction(() =>
      writeStateInTransaction(deps, {
        status: "complete",
        cursor: null,
        imported: 0,
        skipped: 0,
        updatedAt: "",
      }),
    );
    return { ...report, complete: true };
  }
  state ??= {
    v: 1,
    status: "importing",
    cursor: null,
    imported: 0,
    skipped: 0,
    updatedAt: "",
  };
  if (state.status === "importing") {
    const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH);
    const stems = (await legacyStems(directory)).filter(
      (stem) => state!.cursor === null || stem > state!.cursor,
    );
    for (let offset = 0; offset < stems.length; offset += batchSize) {
      if (!(options.shouldContinue?.() ?? true)) return report;
      const batch = stems.slice(offset, offset + batchSize);
      const imports: Array<{ key: string; row: TranscriptManifestRow }> = [];
      for (const stem of batch) {
        // A key whose row exists (imported on demand, or committed since) is
        // only skipped; reading its files would be wasted work.
        const found = await readLegacyManifest(deps, stem);
        if (!found) continue;
        const preferred = options.preferRevision?.(found.key);
        const chosen =
          preferred !== undefined && preferred !== found.row.revision
            ? ((await readLegacyManifest(deps, stem, found.key, preferred)) ?? found)
            : found;
        imports.push(chosen);
      }
      const cursor = batch.at(-1)!;
      const committed = deps.database().transaction(() => {
        const result = commitImports(deps, imports);
        const current = readState(deps.database()) ?? state!;
        writeStateInTransaction(deps, {
          status: "importing",
          cursor,
          imported: current.imported + result.imported,
          skipped: current.skipped + result.skipped + (batch.length - imports.length),
          updatedAt: "",
        });
        return result;
      });
      report.imported += committed.imported;
      report.skipped += committed.skipped + (batch.length - imports.length);
      state = { ...state!, cursor };
      await options.afterBatch?.(cursor);
    }
    deps.database().transaction(() => {
      const current = readState(deps.database()) ?? state!;
      writeStateInTransaction(deps, { ...current, status: "cleanup" });
    });
  }
  // Every file was visited: none of them is read again, so removal can be
  // interrupted and resumed freely.
  await fs.rm(directory, { recursive: true, force: true });
  deps.database().transaction(() => {
    const current = readState(deps.database()) ?? state!;
    writeStateInTransaction(deps, { ...current, status: "complete" });
  });
  report.complete = true;
  return report;
}
