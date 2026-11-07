import { join } from "node:path";
import { Schema } from "effect";
import { decodeSync, int, list, num, str, strictObject } from "../tool-schema.js";
import {
  DESIGN_LIMITS,
  type DesignLibraryEntry,
  type DesignLibraryPage,
  type DesignLibraryQuery,
} from "@orkestrator/protocol/design-operations";
import { DESIGN_MAX_CANVASES } from "@orkestrator/protocol/design-canvas";
import { readBounded, writeAtomically, type DesignPrivateRecord } from "./records.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("design");

export interface DesignSummary {
  id: string;
  environmentId: string;
  name: string;
  revision: number;
  createdAt: string;
  modifiedAt: string;
  frameCount: number;
  state: "live" | "deleted" | "provisional" | "problem";
  deletedAt?: string;
  exportPath?: string;
  exportRevision?: number;
  invalid: number;
  unvalidated: number;
  problem?: "corrupt" | "unsupported-version";
  historyBytes: number;
  recordBytes: number;
  fileSize: number;
  fileMtimeMs: number;
  /** Identity (`fileKey` in design-records) of the file this summary was derived from. */
  fileKey?: string;
  legacy?: boolean;
  /** History holds entries beyond the protected newest ones (prunable). */
  historyPrunable?: boolean;
  /** An export intent was recorded; startup reconciles a crashed "writing" state. */
  exportPending?: boolean;
}

const summarySchema = strictObject({
  id: str({ uuid: true }),
  environmentId: str({ min: 1, max: 256 }),
  name: str({ max: 200 }),
  revision: int({ min: 0 }),
  createdAt: str({ max: 40 }),
  modifiedAt: str({ max: 40 }),
  frameCount: int({ min: 0 }),
  state: Schema.Literals(["live", "deleted", "provisional", "problem"]),
  deletedAt: Schema.optionalKey(str({ max: 40 })),
  exportPath: Schema.optionalKey(str({ max: 256 })),
  exportRevision: Schema.optionalKey(int({ min: 0 })),
  invalid: int({ min: 0 }),
  unvalidated: int({ min: 0 }),
  problem: Schema.optionalKey(Schema.Literals(["corrupt", "unsupported-version"])),
  historyBytes: num({ min: 0 }),
  recordBytes: num({ min: 0 }),
  fileSize: num({ min: 0 }),
  fileMtimeMs: num({ min: 0 }),
  fileKey: Schema.optionalKey(str({ max: 200 })),
  legacy: Schema.optionalKey(Schema.Boolean),
  exportPending: Schema.optionalKey(Schema.Boolean),
  historyPrunable: Schema.optionalKey(Schema.Boolean),
});
const indexSchema = Schema.Struct({
  version: Schema.Literal(1),
  entries: list(summarySchema, { max: 4096 }),
});

export function summarizeRecord(
  record: DesignPrivateRecord,
  file: { size: number; mtimeMs: number; key?: string },
  legacy = false,
): DesignSummary {
  const metas = Object.values(record.frames);
  return {
    id: record.canvasId,
    environmentId: record.environmentId,
    name: record.document.name,
    revision: record.document.revision,
    createdAt: record.createdAt,
    modifiedAt: record.modifiedAt,
    frameCount: record.document.frames.length,
    state: record.state,
    ...(record.deleted ? { deletedAt: record.deleted.deletedAt } : {}),
    ...(record.export
      ? {
          exportPath: record.export.relativePath,
          exportRevision: record.export.lastExportedRevision,
        }
      : {}),
    invalid: metas.filter((meta) => meta.validation.state === "invalid").length,
    unvalidated: metas.filter((meta) =>
      ["unvalidated", "renderer-unavailable", "validating"].includes(meta.validation.state),
    ).length,
    historyBytes: record.history.bytes,
    recordBytes: file.size,
    fileSize: file.size,
    fileMtimeMs: file.mtimeMs,
    ...(file.key ? { fileKey: file.key } : {}),
    ...(legacy ? { legacy: true } : {}),
    ...(record.pendingExport?.state === "writing" ? { exportPending: true } : {}),
    // Mirrors PROTECTED_HISTORY_ENTRIES (3) without importing history into the index.
    ...(record.history.entries.length > 3 ? { historyPrunable: true } : {}),
  };
}

/**
 * Derived, bounded view of private records. Never authoritative for editing.
 * Every backend sharing the data directory keeps its own copy; the service
 * rescans the records when another process signals a change (see
 * `DesignService.refreshLibrary`). `index.json` is only a startup cache whose
 * entries are trusted solely while their file identity still matches.
 */
export class DesignLibraryIndex {
  readonly entries = new Map<string, DesignSummary>();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persisting: Promise<void> = Promise.resolve();
  constructor(private readonly root: string) {}
  get file() {
    return join(this.root, "index.json");
  }
  async load(): Promise<Map<string, DesignSummary>> {
    try {
      const raw = await readBounded(this.file, 16 * 1024 * 1024);
      const parsed = decodeSync(indexSchema, JSON.parse(raw.toString("utf8")));
      return new Map(parsed.entries.map((entry) => [entry.id, entry as DesignSummary]));
    } catch {
      // A missing or corrupt index is rebuilt from the records.
      return new Map();
    }
  }
  upsert(summary: DesignSummary) {
    this.entries.set(summary.id, summary);
    this.persistSoon();
  }
  remove(id: string) {
    if (this.entries.delete(id)) this.persistSoon();
  }
  persistSoon() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.flush();
    }, 250);
    this.persistTimer.unref?.();
  }
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    const entries = Array.from(this.entries.values());
    this.persisting = this.persisting
      .catch(() => undefined)
      .then(() => writeAtomically(this.file, Buffer.from(JSON.stringify({ version: 1, entries }))))
      .catch((error: unknown) => {
        log.warn("library.index-write-failed", {
          error: formatLogError(error, { message: false }),
        });
      });
    await this.persisting;
  }
  counts(environmentId?: string) {
    let live = 0;
    let deleted = 0;
    let deletedBytes = 0;
    let provisional = 0;
    for (const entry of this.entries.values()) {
      if (environmentId && entry.environmentId !== environmentId) continue;
      if (entry.state === "live" || entry.state === "problem") live++;
      else if (entry.state === "deleted") {
        deleted++;
        deletedBytes += entry.recordBytes + entry.historyBytes;
      } else provisional++;
    }
    return { live, deleted, deletedBytes, provisional };
  }
  query(environmentId: string, query: DesignLibraryQuery): DesignLibraryPage {
    const filter = query.filter ?? "live";
    const search = query.search?.trim().toLowerCase().slice(0, 120);
    const matches = Array.from(this.entries.values()).filter((entry) => {
      if (entry.environmentId !== environmentId || entry.state === "provisional") return false;
      if (filter === "live" && entry.state === "deleted") return false;
      if (filter === "deleted" && entry.state !== "deleted") return false;
      return !search || entry.name.toLowerCase().includes(search);
    });
    matches.sort((a, b) =>
      query.sort === "name"
        ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
        : b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id),
    );
    const limit = Math.max(
      1,
      Math.min(DESIGN_LIMITS.libraryPageSize, query.limit ?? DESIGN_LIMITS.libraryPageSize),
    );
    const offset = Math.max(0, query.offset ?? 0);
    const page = matches.slice(offset, offset + limit);
    const global = this.counts();
    return {
      entries: page.map((entry): DesignLibraryEntry => ({
        id: entry.id,
        name: entry.name,
        revision: entry.revision,
        modifiedAt: entry.modifiedAt,
        createdAt: entry.createdAt,
        frameCount: entry.frameCount,
        state:
          entry.state === "problem" ? "problem" : entry.state === "deleted" ? "deleted" : "live",
        ...(entry.deletedAt ? { deletedAt: entry.deletedAt } : {}),
        ...(entry.exportPath
          ? {
              export: {
                relativePath: entry.exportPath,
                revision: entry.exportRevision ?? 0,
                outdated: (entry.exportRevision ?? 0) !== entry.revision,
              },
            }
          : {}),
        validation: { invalid: entry.invalid, unvalidated: entry.unvalidated },
        ...(entry.problem ? { problem: entry.problem } : {}),
      })),
      total: matches.length,
      ...(offset + limit < matches.length ? { nextOffset: offset + limit } : {}),
      quota: {
        live: global.live + global.provisional,
        liveLimit: DESIGN_MAX_CANVASES,
        deleted: global.deleted,
        deletedLimit: DESIGN_LIMITS.recycleCanvases,
        deletedBytes: global.deletedBytes,
        deletedBytesLimit: DESIGN_LIMITS.recycleBytes,
      },
    };
  }
  close() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
  }
}
