import fs from "node:fs";
import path from "node:path";
import { BUILD_PIPELINE_TRANSCRIPT_STORE_LAYOUTS } from "./build-pipeline-transcript-layout.js";
import { NATIVE_AGENT_DISPLAY_TAIL_STORE_LAYOUTS } from "./native-agent-display-tail-layout.js";
import { snapshotBeforeMigration } from "./storage-backups.js";
import { recordShapeUpgradeMigration } from "./storage-record-upgrades.js";
import {
  WEB_ANNOTATION_STORE_LAYOUT,
  WEB_ANNOTATION_STORE_PREFIX,
} from "./web-annotation-store-layout.js";
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
  "looped-reviews": { kind: "record" },
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
  ...NATIVE_AGENT_DISPLAY_TAIL_STORE_LAYOUTS,
  ...BUILD_PIPELINE_TRANSCRIPT_STORE_LAYOUTS,
};

const PREFIX_STORE_LAYOUTS: ReadonlyArray<readonly [string, StoreLayout]> = [
  [WEB_ANNOTATION_STORE_PREFIX, WEB_ANNOTATION_STORE_LAYOUT],
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
  for (const store of Object.keys(STORE_LAYOUTS)) {
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

/** Apply privacy deletion to every retired generation, including interrupted writer temps.
 * Unknown or oversized shapes are removed because they cannot be attributed safely.
 * Other stores in the archive are left intact.
 */
export function scrubLegacyJsonStore(
  dataDir: string,
  store: string,
  transform?: (value: unknown) => unknown,
): void {
  const root = path.join(dataDir, LEGACY_JSON_DIRECTORY);
  let stamps: fs.Dirent[];
  try {
    stamps = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
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
      const file = path.join(directory, name);
      if (transform && fs.statSync(file).isFile() && fs.statSync(file).size <= 64 * 1024 * 1024) {
        let sanitized: unknown;
        try {
          sanitized = transform(JSON.parse(fs.readFileSync(file, "utf8")));
        } catch {
          fs.rmSync(file, { recursive: true, force: true });
          continue;
        }
        const temp = `${file}.${process.pid}.scrub.tmp`;
        try {
          fs.writeFileSync(temp, JSON.stringify(sanitized), { mode: 0o600 });
          fs.renameSync(temp, file);
        } finally {
          fs.rmSync(temp, { force: true });
        }
      } else {
        fs.rmSync(file, { recursive: true, force: true });
      }
    }
  }
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

/** Opens the backend database for `dataDir`, importing legacy JSON once. */
export function openBackendDatabase(
  dataDir: string,
  options: Pick<StorageDatabaseOptions, "observe"> = {},
): StorageDatabase {
  const database = new StorageDatabase(dataDir, {
    layoutFor: storeLayout,
    migrations: STORAGE_MIGRATIONS,
    beforeMigrate: (opened, from) => snapshotBeforeMigration(opened, dataDir, from),
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
  return database;
}
