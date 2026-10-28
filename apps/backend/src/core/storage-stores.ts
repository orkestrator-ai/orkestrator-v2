import fs from "node:fs";
import path from "node:path";
import { BUILD_PIPELINE_TRANSCRIPT_STORE_LAYOUTS } from "./build-pipeline-transcript-layout.js";
import { NATIVE_AGENT_DISPLAY_TAIL_STORE_LAYOUTS } from "./native-agent-display-tail-layout.js";
import { changeLedgerMigration } from "./change-tracking/ledger-schema.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import { snapshotBeforeMigration } from "./storage-backups.js";
import { recordShapeUpgradeMigration } from "./storage-record-upgrades.js";
import { RETIRED_LEGACY_STORES, retireLoopedReviewsMigration } from "./storage-retired-features.js";
import {
  WEB_ANNOTATION_STORE_LAYOUT,
  WEB_ANNOTATION_STORE_PREFIX,
} from "./web-annotation-store-layout.js";
import { USAGE_HISTORY_STORE_LAYOUTS } from "./usage-history-layout.js";
import { SCHEDULED_JOBS_STORE_LAYOUTS } from "./scheduled-jobs/layout.js";
import { PERMISSION_RULE_STORE_LAYOUTS } from "./permission-rules/layout.js";
import {
  TRANSCRIPT_ARTIFACT_ENGINE_STORE_LAYOUTS,
  TRANSCRIPT_ARTIFACT_STORE_LAYOUT,
  TRANSCRIPT_ARTIFACT_STORE_PREFIX,
} from "./transcript-artifacts/store-layout.js";
import {
  StorageDatabase,
  type StorageDatabaseOptions,
  type StorageMigration,
  type StorageMigrationContext,
  type StoreLayout,
} from "./storage-database.js";

/**
 * Registry of the backend stores kept in the SQLite database, and the one-time
 * import of the JSON files they replace.
 *
 * A store's name is its former file path relative to the data directory
 * without `.json` (`kanban`, `public-operations/index`). Two files are not
 * here on purpose: `config.json` and `agent-platforms.json` are read, and on
 * first run written, by the Electron main process and the toolchain installer
 * before the backend exists. Those run under Node, which has no `bun:sqlite`.
 */

const ownerField =
  (field: string) =>
  (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const owner = (value as Record<string, unknown>)[field];
    return typeof owner === "string" ? owner : undefined;
  };

const STORE_LAYOUTS: Record<string, StoreLayout> = {
  projects: { kind: "array" },
  environments: { kind: "array", owner: ownerField("projectId") },
  "project-removal-fences": { kind: "record" },
  "agent-model-catalog": { kind: "document" },
  "opencode-model-catalog": { kind: "envelope", collections: ["catalogs"] },
  sessions: { kind: "array", owner: ownerField("environmentId") },
  "pane-layouts": { kind: "record" },
  "multi-reviews": { kind: "record" },
  "build-pipelines": { kind: "record" },
  "native-agent-sessions": { kind: "record" },
  "agent-interaction-resolution-journal": { kind: "document" },
  "prompt-queues": { kind: "record" },
  "compose-drafts": { kind: "record" },
  "file-drafts": { kind: "record" },
  "agent-handoffs": { kind: "record" },
  "agent-mail": { kind: "envelope", collections: ["mailboxes", "idempotency", "counterparts"] },
  coordinators: { kind: "envelope", collections: ["workspaces"] },
  kanban: { kind: "array", owner: ownerField("projectId") },
  "project-notes": { kind: "array", key: "projectId" },
  "feature-plans": { kind: "array", owner: ownerField("projectId") },
  "linear-auth": { kind: "document" },
  "linear-completion-comments": { kind: "array", key: "pipelineId" },
  "github-completion-comments": { kind: "array", key: "pipelineId" },
  "preview-services": { kind: "envelope", collections: ["definitions"] },
  "preview-settings": { kind: "document" },
  "backend-identity": { kind: "document" },
  "backend-profile": { kind: "document" },
  "node-registry": { kind: "document" },
  "node-attachments": { kind: "document" },
  "node-summaries": { kind: "document" },
  "node-outcomes": { kind: "document" },
  "node-mail": { kind: "document" },
  "node-action-requests": { kind: "document" },
  "agent-accounts": { kind: "document" },
  "public-operations/index": { kind: "document" },
  "environment-cleanup-ledger": { kind: "envelope", collections: ["entries"] },
  "environment-cleanup-sweeps": { kind: "document" },
  "workflow-results": { kind: "envelope", collections: ["entries"] },
  "workflow-result-tools": { kind: "document" },
};

/**
 * Stores of engines that have no legacy JSON file to import: the legacy
 * import iterates {@link STORE_LAYOUTS} only.
 */
const ENGINE_STORE_LAYOUTS: Record<string, StoreLayout> = {
  "storage-deletion-fences": { kind: "record" },
  "storage-legacy-json-cleanups": { kind: "document" },
  "host-maintenance": { kind: "document" },
  "compatibility-path-usage": { kind: "document" },
  ...NATIVE_AGENT_DISPLAY_TAIL_STORE_LAYOUTS,
  ...BUILD_PIPELINE_TRANSCRIPT_STORE_LAYOUTS,
  ...TRANSCRIPT_ARTIFACT_ENGINE_STORE_LAYOUTS,
  ...USAGE_HISTORY_STORE_LAYOUTS,
  ...SCHEDULED_JOBS_STORE_LAYOUTS,
  ...PERMISSION_RULE_STORE_LAYOUTS,
};

const PREFIX_STORE_LAYOUTS: ReadonlyArray<readonly [string, StoreLayout]> = [
  [WEB_ANNOTATION_STORE_PREFIX, WEB_ANNOTATION_STORE_LAYOUT],
  [TRANSCRIPT_ARTIFACT_STORE_PREFIX, TRANSCRIPT_ARTIFACT_STORE_LAYOUT],
];

const PUBLIC_OPERATION_NAMESPACE = /^public-operations\/ns-[0-9]{13}-[a-f0-9]{8}$/;

export function storeLayout(store: string): StoreLayout {
  const exact = STORE_LAYOUTS[store] ?? ENGINE_STORE_LAYOUTS[store];
  if (exact) return exact;
  for (const [prefix, layout] of PREFIX_STORE_LAYOUTS) {
    if (store.startsWith(prefix)) return layout;
  }
  return { kind: "document" };
}

/** The store that replaces `relativePath` (a data-dir relative `.json` path), if any. */
export function databaseStoreForPath(relativePath: string): string | null {
  const normalized = relativePath.split(path.sep).join("/");
  if (!normalized.endsWith(".json")) return null;
  const store = normalized.slice(0, -".json".length);
  if (Object.hasOwn(STORE_LAYOUTS, store) || PUBLIC_OPERATION_NAMESPACE.test(store)) return store;
  return null;
}

/** Retained backups the JSON writer kept beside each primary file. */
const LEGACY_BACKUPS = 5;
export const LEGACY_JSON_DIRECTORY = "legacy-json";
/** How long imported JSON files are kept for manual recovery after the move. */
export const LEGACY_JSON_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function legacyStoreFiles(dataDir: string): Array<{ store: string; file: string }> {
  const files = Object.keys(STORE_LAYOUTS).map((store) => ({
    store,
    file: path.join(dataDir, `${store}.json`),
  }));
  const operations = path.join(dataDir, "public-operations");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(operations);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const entry of entries.sort()) {
    const store = `public-operations/${entry.replace(/\.json$/, "")}`;
    if (entry.endsWith(".json") && PUBLIC_OPERATION_NAMESPACE.test(store)) {
      files.push({ store, file: path.join(operations, entry) });
    }
  }
  return files;
}

function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    // EACCES/EIO: the data may be intact. Refusing to start is safer than
    // importing nothing and letting the next write replace it.
    throw error;
  }
}

function parseJson(raw: string | null): { value: unknown } | null {
  if (raw === null || !raw.trim()) return null;
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch {
    return null;
  }
}

/**
 * Imports one legacy store with the same recovery the JSON reader applied: the
 * primary file, else the newest readable `.bak.N`. A file that exists but that
 * neither it nor any backup can repair is carried over as an unreadable
 * document, preserving "present but corrupt" instead of turning it into an
 * empty store a reconciliation could act on.
 */
function importLegacyStore(database: StorageDatabase, store: string, file: string): boolean {
  const primary = readIfPresent(file);
  const parsed = parseJson(primary);
  if (parsed) {
    database.writeStoreInTransaction(store, parsed.value);
    return true;
  }
  for (let index = 1; index <= LEGACY_BACKUPS; index += 1) {
    const backup = parseJson(readIfPresent(`${file}.bak.${index}`));
    if (backup) {
      database.writeStoreInTransaction(store, backup.value);
      return true;
    }
  }
  if (primary === null) return false;
  database.writeRawDocumentInTransaction(store, primary);
  return true;
}

export const LEGACY_JSON_IMPORT_VERSION = 2;

export const STORAGE_MIGRATIONS: readonly StorageMigration[] = [
  {
    version: LEGACY_JSON_IMPORT_VERSION,
    name: "import-legacy-json-stores",
    up({ dataDir, database }: StorageMigrationContext) {
      for (const { store, file } of legacyStoreFiles(dataDir)) {
        importLegacyStore(database, store, file);
      }
    },
  },
  recordShapeUpgradeMigration,
  changeLedgerMigration,
  retireLoopedReviewsMigration,
];

function legacyArtifacts(entries: readonly string[], baseName: string): string[] {
  return entries.filter(
    (entry) =>
      entry === baseName ||
      entry.startsWith(`${baseName}.bak.`) ||
      entry.startsWith(`${baseName}.lock`) ||
      // Temp files: the StorageService writer's `.<name>.<uuid>.tmp` (and
      // recovery temps), and the other engines' `<name>.<suffix>.tmp`.
      ((entry.startsWith(`.${baseName}.`) || entry.startsWith(`${baseName}.`)) &&
        entry.endsWith(".tmp")),
  );
}

/**
 * Moves imported JSON files (and their backups, lock and temp files) into
 * `legacy-json/<timestamp>/`, then removes moved copies older than the
 * retention window. Runs after the import committed; a crash before it simply
 * leaves files that the next start moves. Files another, older backend wrote
 * after the import are moved the same way: they are never read again.
 */
export function retireLegacyJsonStores(dataDir: string, now = Date.now()): number {
  const archiveRoot = path.join(dataDir, LEGACY_JSON_DIRECTORY);
  let moved = 0;
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const archive = path.join(archiveRoot, stamp);
  const move = (source: string, relative: string) => {
    const destination = path.join(archive, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.chmodSync(archiveRoot, 0o700);
    fs.renameSync(source, destination);
    moved += 1;
  };
  let topLevel: string[] = [];
  try {
    topLevel = fs.readdirSync(dataDir);
  } catch {
    topLevel = [];
  }
  for (const store of [...Object.keys(STORE_LAYOUTS), ...RETIRED_LEGACY_STORES]) {
    if (store.includes("/")) continue;
    for (const entry of legacyArtifacts(topLevel, `${store}.json`)) {
      move(path.join(dataDir, entry), entry);
    }
  }
  const operations = path.join(dataDir, "public-operations");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(operations);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (entry.endsWith(".json") || entry.includes(".json.") || entry.startsWith("store.lock")) {
      move(path.join(operations, entry), path.join("public-operations", entry));
    }
  }
  if (entries.length > 0) {
    try {
      fs.rmdirSync(operations);
    } catch {
      // Something else lives there; leave the directory.
    }
  }
  // Two lock families had no store of their own.
  for (const directory of ["project-creation-locks", "github-completion-comment-locks"]) {
    fs.rmSync(path.join(dataDir, directory), { recursive: true, force: true });
  }
  purgeExpiredLegacyJson(archiveRoot, now);
  return moved;
}

/** Every retired generation's copies of `store`: primary, backups, lock and temp files. */
function legacyJsonCopies(dataDir: string, store: string): string[] {
  const root = path.join(dataDir, LEGACY_JSON_DIRECTORY);
  let stamps: fs.Dirent[];
  try {
    stamps = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const copies: string[] = [];
  for (const stamp of stamps) {
    if (!stamp.isDirectory()) continue;
    const directory = path.join(root, stamp.name, path.dirname(store));
    let entries: string[];
    try {
      entries = fs.readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const name of legacyArtifacts(entries, `${path.basename(store)}.json`)) {
      copies.push(path.join(directory, name));
    }
  }
  return copies;
}

/** Whether any retired generation still holds a copy of `store`. */
export function hasLegacyJsonStore(dataDir: string, store: string): boolean {
  return legacyJsonCopies(dataDir, store).length > 0;
}

/** Apply privacy deletion to every retired generation, including interrupted writer temps.
 * Unknown or oversized shapes are removed because they cannot be attributed safely.
 * A copy the transform leaves unchanged is not rewritten, so it stays byte-identical.
 * Without a transform every copy is removed. Other stores in the archive are left intact.
 */
export function scrubLegacyJsonStore(
  dataDir: string,
  store: string,
  transform?: (value: unknown) => unknown,
): void {
  for (const file of legacyJsonCopies(dataDir, store)) {
    if (transform && fs.statSync(file).isFile() && fs.statSync(file).size <= 64 * 1024 * 1024) {
      let sanitized: string;
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        // Serialized before the transform runs, in case it edits in place.
        const original = JSON.stringify(parsed);
        sanitized = JSON.stringify(transform(parsed));
        if (sanitized === original) continue;
      } catch {
        fs.rmSync(file, { recursive: true, force: true });
        continue;
      }
      const temp = `${file}.${process.pid}.scrub.tmp`;
      try {
        fs.writeFileSync(temp, sanitized, { mode: 0o600 });
        fs.renameSync(temp, file);
      } finally {
        fs.rmSync(temp, { force: true });
      }
    } else {
      fs.rmSync(file, { recursive: true, force: true });
    }
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON with object keys sorted, so equal content compares equal whatever its key order. */
function canonicalJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) =>
    isJsonRecord(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

/** An array item's identity for {@link pruneRemovedContent}: its `id`, else its content. */
function itemIdentity(item: unknown): string {
  if (isJsonRecord(item) && (typeof item.id === "string" || typeof item.id === "number")) {
    return `id:${typeof item.id}:${item.id}`;
  }
  return `content:${canonicalJson(item)}`;
}

/**
 * `archived` without the content that `next` no longer holds, everything else
 * left exactly as archived:
 *
 * - a record key `next` lacks (or holds as `undefined`) is dropped;
 * - an array item with no counterpart in `next` is dropped. Items are matched
 *   by `id`, else by equal content, so an item that cannot be matched is
 *   treated as removed;
 * - a value `next` cleared to `null` becomes `null`.
 *
 * Matched records and items recurse; changed scalars keep their archived value.
 * Incompatible containers are cleared. When nothing is removed the result is
 * `archived` itself, so `pruneRemovedContent(previous, next) !== previous`
 * tells whether a write from `previous` to `next` deleted anything.
 */
export function pruneRemovedContent(archived: unknown, next: unknown): unknown {
  if (next === null) return null;
  if (isJsonRecord(archived) && isJsonRecord(next)) {
    let changed = false;
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(archived)) {
      if (!Object.hasOwn(next, key) || next[key] === undefined) {
        changed = true;
        continue;
      }
      const pruned = pruneRemovedContent(value, next[key]);
      if (pruned !== value) changed = true;
      kept[key] = pruned;
    }
    return changed ? kept : archived;
  }
  if (Array.isArray(archived) && Array.isArray(next)) {
    const counterparts = new Map(next.map((item: unknown) => [itemIdentity(item), item]));
    let changed = false;
    const kept: unknown[] = [];
    for (const item of archived) {
      const identity = itemIdentity(item);
      if (!counterparts.has(identity)) {
        changed = true;
        continue;
      }
      const pruned = pruneRemovedContent(item, counterparts.get(identity));
      if (pruned !== item) changed = true;
      kept.push(pruned);
    }
    return changed ? kept : archived;
  }
  // A container with an incompatible counterpart cannot be attributed. Keeping
  // it could retain an entire deleted workspace in a malformed backup.
  if (
    isJsonRecord(archived) ||
    Array.isArray(archived) ||
    isJsonRecord(next) ||
    Array.isArray(next)
  ) {
    return null;
  }
  return archived;
}

export type LegacyJsonCleanup =
  { store: string; kind: "delete" } | { store: string; kind: "prune"; next: unknown };

const LEGACY_CLEANUPS_STORE = "storage-legacy-json-cleanups";
const MAX_LEGACY_CLEANUPS = 1024;
const MAX_LEGACY_CLEANUP_BYTES = 64 * 1024 * 1024;

/** Commit cleanup intent with its mutation; no archive changes before commit. */
export function commitWithLegacyJsonCleanup(
  database: StorageDatabase,
  dataDir: string,
  mutate: () => void,
  cleanups: LegacyJsonCleanup[] = [],
): void {
  // Finish failed work before allowing another mutation to obscure its evidence.
  let scrubbedPending = false;
  database.transaction(() => {
    scrubbedPending = applyLegacyJsonCleanup(database, dataDir);
    mutate();
    if (cleanups.length === 0) return;
    if (
      cleanups.length > MAX_LEGACY_CLEANUPS ||
      Buffer.byteLength(JSON.stringify(cleanups)) > MAX_LEGACY_CLEANUP_BYTES
    ) {
      throw new Error("Legacy JSON cleanup capacity exceeded");
    }
    // Private SQLite storage, never logs/receipts. Retain each intermediate
    // pruning target: a later re-add must not undo an earlier privacy deletion.
    database.writeStoreInTransaction(LEGACY_CLEANUPS_STORE, cleanups);
  });
  replayLegacyJsonCleanup(database, dataDir);
  if (scrubbedPending) database.scrubDeletedContent();
}

/** Replays idempotently on reopen or the next write, even when it is unrelated. */
export function replayLegacyJsonCleanup(database: StorageDatabase, dataDir: string): void {
  if (!database.hasStore(LEGACY_CLEANUPS_STORE)) return;
  database.transaction(() => applyLegacyJsonCleanup(database, dataDir));
  // Pruning targets themselves can contain content removed by a later target.
  database.scrubDeletedContent();
}

function applyLegacyJsonCleanup(database: StorageDatabase, dataDir: string): boolean {
  // Serialize scrub + acknowledgement across backends. Otherwise an older
  // scrub could overwrite a newer one after that backend has acknowledged it.
  const cleanups = database.readStore(LEGACY_CLEANUPS_STORE)?.value as
    LegacyJsonCleanup[] | undefined;
  if (!cleanups) return false;
  for (const cleanup of cleanups) {
    scrubLegacyJsonStore(
      dataDir,
      cleanup.store,
      cleanup.kind === "prune" ? (copy) => pruneRemovedContent(copy, cleanup.next) : undefined,
    );
  }
  database.deleteStoreInTransaction(LEGACY_CLEANUPS_STORE);
  return true;
}

function purgeExpiredLegacyJson(archiveRoot: string, now: number): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(archiveRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(entry.name);
    if (!match) continue;
    const createdAt = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
    if (Number.isFinite(createdAt) && now - createdAt > LEGACY_JSON_RETENTION_MS) {
      fs.rmSync(path.join(archiveRoot, entry.name), { recursive: true, force: true });
    }
  }
  try {
    if (fs.readdirSync(archiveRoot).length === 0) fs.rmdirSync(archiveRoot);
  } catch {
    // Best effort.
  }
}

/**
 * Charges a connection's reads to recurring work. Storage is charged by what
 * the caller got, not where the rows came from: a read served from the
 * revision-validated cache still parses every row, so an extra read shows
 * however warm the cache is. Bytes are charged only for content fetched from
 * the database, which is what tells a cache miss from a cache-served read.
 */
const RECURRING_STORAGE_OBSERVERS: Required<
  Pick<StorageDatabaseOptions, "observe" | "observeFetch">
> = {
  observe: (event) => recurringWorkMetrics.work(event === "read" ? "storage-read" : "storage-stat"),
  observeFetch: (length) => recurringWorkMetrics.bytes(length),
};

/**
 * Opens the backend database for `dataDir`, importing legacy JSON once. Every
 * connection reports its reads to {@link recurringWorkMetrics} unless the
 * caller passes its own observers.
 */
export function openBackendDatabase(
  dataDir: string,
  options: Pick<StorageDatabaseOptions, "observe" | "observeFetch"> = {},
): StorageDatabase {
  const database = new StorageDatabase(dataDir, {
    layoutFor: storeLayout,
    migrations: STORAGE_MIGRATIONS,
    beforeMigrate: (opened, from) => snapshotBeforeMigration(opened, dataDir, from),
    ...RECURRING_STORAGE_OBSERVERS,
    ...options,
  });
  try {
    const imported = database.openedAtVersion < LEGACY_JSON_IMPORT_VERSION;
    const moved = retireLegacyJsonStores(dataDir);
    if (moved > 0 && !imported) {
      // Only an older backend sharing (or later reusing) this directory writes
      // these. Their content is not merged; it stays recoverable in the archive.
      console.warn(
        `[Storage] Moved ${moved} JSON store file(s) written after the SQLite migration to ${LEGACY_JSON_DIRECTORY}/; they were not imported`,
      );
    }
  } catch (error) {
    console.warn("[Storage] Could not archive imported JSON store files:", error);
  }
  try {
    replayLegacyJsonCleanup(database, dataDir);
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}
