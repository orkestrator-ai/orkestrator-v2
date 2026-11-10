import type {
  DatabaseFileSummary,
  DatabaseRetentionSummary,
  DatabaseSummary,
  DatabaseTopTables,
} from "@orkestrator/protocol/backend-diagnostics";
import fs from "node:fs";
import path from "node:path";
import { CHANGE_LEDGER_DATABASE_FILE, type StorageDatabase } from "./storage-database.js";
import { STORAGE_DATABASE_FILE } from "@orkestrator/protocol/node/storage-database";
import { readTopTables, summarizeStorageSnapshots } from "./storage-backups.js";

/** A `/metrics` poll never costs more than one refresh of this age. */
export const DATABASE_SUMMARY_MAX_AGE_MS = 60_000;

export interface DatabaseSummarySource {
  dataDir: string;
  /** Called only for a file that exists, so a summary never creates one. */
  main: () => StorageDatabase | null;
  ledger: () => StorageDatabase | null;
  retention: () => DatabaseRetentionSummary | null;
  now?: () => number;
  maxAgeMs?: number;
}

function statBytes(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function fileSummary(
  file: string,
  database: () => StorageDatabase | null,
): DatabaseFileSummary | null {
  const fileBytes = statBytes(file);
  if (fileBytes === null) return null;
  let pages: ReturnType<StorageDatabase["pageStats"]> | null = null;
  try {
    const connection = database();
    pages = connection && !connection.isClosed() ? connection.pageStats() : null;
  } catch {
    // A busy or closing connection: the file sizes still answer.
  }
  return {
    fileBytes,
    walBytes: statBytes(`${file}-wal`) ?? 0,
    pageBytes: pages?.pageBytes ?? null,
    pageCount: pages?.pageCount ?? null,
    freelistPages: pages?.freelistPages ?? null,
    freelistBytes: pages ? pages.freelistPages * pages.pageBytes : null,
  };
}

function validTopTables(value: unknown): DatabaseTopTables | null {
  if (typeof value !== "object" || value === null) return null;
  const { takenAt, tables, stores } = value as Partial<DatabaseTopTables>;
  if (typeof takenAt !== "string" || !Array.isArray(tables)) return null;
  // A file an older backend wrote has no store families.
  return Array.isArray(stores) ? { takenAt, tables, stores } : { takenAt, tables };
}

/**
 * The figures that say how big the databases are and what is in them, read at
 * most once a minute: a `stat` per file and three PRAGMAs per database are small
 * but must not run per `/metrics` request. Figures can be a minute old.
 *
 * Top tables and store families come from the backup child
 * (`storage-backups.ts`); this only reads the file it leaves. Nothing here scans a table or writes.
 */
export class DatabaseSummaryCache {
  private cached: { at: number; summary: DatabaseSummary } | null = null;

  constructor(private readonly source: DatabaseSummarySource) {}

  read(): DatabaseSummary {
    const now = (this.source.now ?? Date.now)();
    const maxAge = this.source.maxAgeMs ?? DATABASE_SUMMARY_MAX_AGE_MS;
    // A clock stepping backwards counts as stale rather than pinning the old figures.
    if (this.cached && now >= this.cached.at && now - this.cached.at < maxAge) {
      return this.cached.summary;
    }
    const { dataDir } = this.source;
    const topTables = readTopTables(dataDir);
    const summary: DatabaseSummary = {
      generatedAt: new Date(now).toISOString(),
      main: fileSummary(path.join(dataDir, STORAGE_DATABASE_FILE), this.source.main),
      ledger: fileSummary(path.join(dataDir, CHANGE_LEDGER_DATABASE_FILE), this.source.ledger),
      backups: summarizeStorageSnapshots(dataDir),
      retention: this.source.retention(),
      topTables: {
        main: validTopTables(topTables.main),
        ledger: validTopTables(topTables.ledger),
      },
    };
    this.cached = { at: now, summary };
    return summary;
  }
}
