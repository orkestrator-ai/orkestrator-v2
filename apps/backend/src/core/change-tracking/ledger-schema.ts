/**
 * ChangeLedger schema and its database file.
 *
 * The first engine with its own indexed tables: the ledger needs joins and
 * range scans (turns of a thread, open windows of a worktree, outbox order)
 * that the shared `store_rows` layout cannot serve without decoding whole
 * stores. Rows hold identities, bounded metadata and references only. File
 * contents and evidence bodies are files under `<dataDir>/change-tracking/`
 * (see snapshot-store.ts, evidence-body-store.ts).
 *
 * The tables live in their own file, {@link CHANGE_LEDGER_DATABASE_FILE},
 * beside `orkestrator.sqlite`. Storage migration 4 first created them in the
 * main database; migration 7 ({@link moveChangeLedgerMigration}) moves them
 * out, so the hourly snapshot of the app's stores no longer copies the ledger.
 * Nothing joins or writes across the two files.
 *
 * `storage-stores.ts` loads this module while opening the database, so it
 * imports only the storage layer at runtime, never the rest of change tracking.
 */

import { createLogger } from "@orkestrator/protocol/logger";
import { snapshotBeforeMigration } from "../storage-backups.js";
import { recurringDiagnosticsRegistry } from "../recurring-diagnostics.js";
import {
  CHANGE_LEDGER_DATABASE_FILE,
  StorageDatabase,
  type StorageDatabaseOptions,
  type StorageMigration,
} from "../storage-database.js";

const log = createLogger("storage");

/** Storage migration 4: the ledger's tables, first created in `orkestrator.sqlite`. */
export const CHANGE_LEDGER_MIGRATION_VERSION = 4;

/** Storage migration 7: the ledger leaves `orkestrator.sqlite` for its own file. */
export const CHANGE_LEDGER_MOVE_MIGRATION_VERSION = 7;

export { CHANGE_LEDGER_DATABASE_FILE };

/**
 * Schema version of {@link CHANGE_LEDGER_DATABASE_FILE}: 1 is the storage base
 * schema every `StorageDatabase` file has, 2 the ledger's tables. Versioned on
 * its own, and refused when newer than the build, as the main file is.
 */
export const CHANGE_LEDGER_FILE_SCHEMA_VERSION = 2;

export const CHANGE_LEDGER_SCHEMA = `
CREATE TABLE change_ledger_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE change_worktrees (
  id TEXT PRIMARY KEY,
  identity_key TEXT NOT NULL,
  incarnation TEXT NOT NULL,
  runtime_kind TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  canonical_root TEXT NOT NULL,
  git_dir TEXT,
  common_dir TEXT,
  fencing_epoch INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT,
  last_boundary_seq INTEGER NOT NULL DEFAULT 0,
  last_observation_seq INTEGER NOT NULL DEFAULT 0,
  tombstoned_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (identity_key, incarnation)
) STRICT;
CREATE INDEX change_worktrees_identity ON change_worktrees (identity_key);

CREATE TABLE change_bindings (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  environment_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  worktree_id TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX change_bindings_environment ON change_bindings (environment_id);

CREATE TABLE change_capabilities (
  revision TEXT PRIMARY KEY,
  capabilities_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL
) STRICT;

CREATE TABLE change_evidence_cursors (
  source_key TEXT PRIMARY KEY,
  runtime_epoch TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE change_frames (
  frame_key TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,
  runtime_epoch TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  ingested_seq INTEGER NOT NULL,
  received_at TEXT NOT NULL
) STRICT;

CREATE TABLE change_operations (
  operation_id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_id TEXT,
  call_id TEXT,
  parent_call_id TEXT,
  attempt_id TEXT NOT NULL,
  tool_kind TEXT NOT NULL,
  phase TEXT NOT NULL,
  execution_occurrence TEXT NOT NULL,
  background_task_id TEXT,
  capability_revision TEXT,
  history_mode TEXT NOT NULL,
  presentation_revision INTEGER NOT NULL DEFAULT 0,
  reconciliation_json TEXT,
  first_seen_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL
) STRICT;
CREATE INDEX change_operations_turn ON change_operations (turn_id);
CREATE INDEX change_operations_binding ON change_operations (binding_id, updated_seq);

CREATE TABLE change_evidence (
  evidence_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  evidence_key TEXT NOT NULL,
  revision_key TEXT NOT NULL,
  replaces_revision_key TEXT,
  kind TEXT NOT NULL,
  claim TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0,
  frame_key TEXT NOT NULL,
  ingested_seq INTEGER NOT NULL,
  PRIMARY KEY (evidence_id, revision),
  UNIQUE (evidence_id, revision_key)
) STRICT;
CREATE INDEX change_evidence_owner ON change_evidence (owner_kind, owner_id, selected);

CREATE TABLE change_evidence_chunks (
  evidence_id TEXT NOT NULL,
  revision_key TEXT NOT NULL,
  target_body_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_id TEXT NOT NULL,
  offset_bytes INTEGER NOT NULL,
  body_id TEXT NOT NULL,
  final INTEGER NOT NULL,
  PRIMARY KEY (evidence_id, revision_key, chunk_index)
) STRICT;

CREATE TABLE change_evidence_bodies (
  body_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  complete INTEGER NOT NULL,
  original_bytes INTEGER,
  reason TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
) STRICT;

CREATE TABLE change_evidence_gaps (
  gap_id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,
  coverage_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  recorded_at TEXT NOT NULL
) STRICT;
CREATE INDEX change_evidence_gaps_binding ON change_evidence_gaps (binding_id);

CREATE TABLE change_capture_attempts (
  id TEXT PRIMARY KEY,
  boundary_key TEXT NOT NULL UNIQUE,
  worktree_id TEXT NOT NULL,
  owner_epoch INTEGER NOT NULL,
  required_after_boundary_seq INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  error_code TEXT,
  snapshot_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX change_capture_attempts_status ON change_capture_attempts (status);

CREATE TABLE change_snapshots (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL,
  incarnation TEXT NOT NULL,
  tree_oid TEXT NOT NULL,
  object_format TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  capture_started_at TEXT NOT NULL,
  capture_finished_at TEXT NOT NULL,
  observation_epoch INTEGER NOT NULL,
  coverage_json TEXT NOT NULL,
  consistency_json TEXT NOT NULL,
  closure_verified INTEGER NOT NULL,
  file_count INTEGER NOT NULL,
  retained_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX change_snapshots_worktree ON change_snapshots (worktree_id, created_at);

CREATE TABLE change_thread_segments (
  segment_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  initial_turn_id TEXT,
  baseline_snapshot_id TEXT,
  baseline_state TEXT NOT NULL,
  baseline_reason TEXT,
  latest_live_snapshot_id TEXT,
  final_snapshot_id TEXT,
  inherited_prefix_id TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
) STRICT;
CREATE INDEX change_thread_segments_thread ON change_thread_segments (thread_id, created_at);

CREATE TABLE change_turn_boundaries (
  turn_id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  start_attempt_id TEXT,
  start_snapshot_id TEXT,
  end_snapshot_id TEXT,
  before_quality TEXT NOT NULL,
  after_quality TEXT NOT NULL,
  terminal_evidence TEXT,
  dispatch_token TEXT,
  dispatch_receipt TEXT,
  reason TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ordinal INTEGER NOT NULL
) STRICT;
CREATE INDEX change_turn_boundaries_thread ON change_turn_boundaries (thread_id, ordinal);
CREATE INDEX change_turn_boundaries_lifecycle ON change_turn_boundaries (lifecycle);

CREATE TABLE change_tool_windows (
  window_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  turn_id TEXT,
  worktree_id TEXT NOT NULL,
  before_snapshot_id TEXT,
  after_snapshot_id TEXT,
  before_quality TEXT NOT NULL,
  after_quality TEXT NOT NULL,
  overlap TEXT NOT NULL,
  overlap_group TEXT,
  lifecycle TEXT NOT NULL,
  opened_seq INTEGER NOT NULL,
  closed_seq INTEGER,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  reason TEXT
) STRICT;
CREATE INDEX change_tool_windows_open ON change_tool_windows (worktree_id, lifecycle);
CREATE INDEX change_tool_windows_operation ON change_tool_windows (operation_id);

CREATE TABLE change_measurements (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  from_snapshot_id TEXT,
  to_snapshot_id TEXT,
  algorithm_id TEXT NOT NULL,
  representation_id TEXT NOT NULL,
  measurement_json TEXT NOT NULL,
  supersedes_id TEXT,
  created_seq INTEGER NOT NULL
) STRICT;
CREATE INDEX change_measurements_owner ON change_measurements (owner_kind, owner_id, scope, created_seq);
CREATE INDEX change_measurements_snapshots ON change_measurements (from_snapshot_id, to_snapshot_id);

CREATE TABLE change_measurement_files (
  measurement_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  path_id TEXT NOT NULL,
  old_path TEXT,
  new_path TEXT,
  old_blob TEXT,
  new_blob TEXT,
  old_mode TEXT,
  new_mode TEXT,
  status TEXT NOT NULL,
  file_kind TEXT NOT NULL,
  additions INTEGER,
  additions_quality TEXT NOT NULL,
  deletions INTEGER,
  deletions_quality TEXT NOT NULL,
  body_state TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (measurement_id, ordinal)
) STRICT;

CREATE TABLE change_diff_identities (
  id TEXT PRIMARY KEY,
  measurement_id TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX change_diff_identities_measurement ON change_diff_identities (measurement_id);

CREATE TABLE change_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE (owner_kind, owner_id, snapshot_id, reason)
) STRICT;
CREATE INDEX change_references_snapshot ON change_references (snapshot_id);

CREATE TABLE change_selections (
  selection_key TEXT PRIMARY KEY,
  selector TEXT NOT NULL,
  baseline_version TEXT,
  measurement_id TEXT,
  selected_observation_epoch INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL,
  worktree_incarnation TEXT,
  owner_fence INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE change_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  measurement_id TEXT,
  event_kind TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX change_outbox_pending ON change_outbox (delivered, sequence);

CREATE TABLE change_restore_tokens (
  token TEXT PRIMARY KEY,
  measurement_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  owner_fence INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;

CREATE TABLE change_restore_operations (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL,
  measurement_id TEXT NOT NULL,
  state TEXT NOT NULL,
  outcome_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`;

/** Every ledger table, in schema order. */
export const CHANGE_LEDGER_TABLES: readonly string[] = Array.from(
  CHANGE_LEDGER_SCHEMA.matchAll(/^CREATE TABLE (\w+) \(/gm),
  (match) => match[1]!,
);

export const changeLedgerMigration: StorageMigration = {
  version: CHANGE_LEDGER_MIGRATION_VERSION,
  name: "change-ledger",
  up({ db }) {
    db.exec(CHANGE_LEDGER_SCHEMA);
  },
};

const CHANGE_LEDGER_FILE_MIGRATIONS: readonly StorageMigration[] = [
  {
    version: CHANGE_LEDGER_FILE_SCHEMA_VERSION,
    name: "change-ledger",
    up({ db }) {
      db.exec(CHANGE_LEDGER_SCHEMA);
    },
  },
];

/**
 * Opens (creating on first use) the ledger's own database. WAL and secure delete
 * match the main database, but synchronous = NORMAL avoids
 * syncing the WAL on every commit. In WAL mode this cannot corrupt the database;
 * a power loss or OS crash may roll back the last few committed ledger transactions.
 * An application crash or SIGKILL loses no committed transactions. The main
 * database stays FULL. Before a later schema migration, the ledger gets its own
 * `change-tracking-pre-migration-v<from>` snapshot.
 */
export function openChangeLedgerDatabase(
  dataDir: string,
  options: Pick<StorageDatabaseOptions, "busyTimeoutMs" | "cacheGaugeRegistry"> = {},
): StorageDatabase {
  return new StorageDatabase(dataDir, {
    cacheGaugeRegistry: recurringDiagnosticsRegistry,
    ...options,
    file: CHANGE_LEDGER_DATABASE_FILE,
    synchronous: "normal",
    migrations: CHANGE_LEDGER_FILE_MIGRATIONS,
    beforeMigrate: (opened, from) =>
      snapshotBeforeMigration(opened, dataDir, from, Date.now(), "change-tracking-pre-migration"),
  });
}

/**
 * Storage migration 7. Copies the ledger's committed rows from
 * `orkestrator.sqlite` into {@link CHANGE_LEDGER_DATABASE_FILE}, replacing
 * whatever that file held, then drops the tables here. The copy is one
 * transaction on the ledger file, through a second connection that attaches
 * this database and only reads it: WAL lets it read the committed rows while the
 * migration holds the write lock. Earlier migrations in the same open never
 * write ledger rows, so the committed rows are all of them. Tables migration 4
 * created in this same open are empty, so a new database copies nothing and
 * leaves the ledger file to be created on first use.
 *
 * A crash between the copy and this migration's commit leaves both copies;
 * the next open copies again, which replaces the file's rows with the same
 * ones. The pre-migration snapshot taken before this open keeps the ledger as
 * it was, so restoring that snapshot and starting again moves that ledger.
 */
export const moveChangeLedgerMigration: StorageMigration = {
  version: CHANGE_LEDGER_MOVE_MIGRATION_VERSION,
  name: "move-change-ledger",
  up({ dataDir, db, database }) {
    const present = new Set(
      (
        db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    const tables = CHANGE_LEDGER_TABLES.filter((table) => present.has(table));
    if (tables.length === 0) return;
    const started = performance.now();
    // Tables migration 4 created in this same open are empty: nothing to copy.
    const rows =
      database.openedAtVersion < CHANGE_LEDGER_MIGRATION_VERSION
        ? 0
        : copyCommittedLedger(dataDir, database.path);
    // Keep secure deletion enabled: legacy non-incremental databases may
    // retain freed pages indefinitely after these tables are dropped.
    for (const table of tables) db.exec(`DROP TABLE IF EXISTS ${table}`);
    // A new database has nothing to move, and its first open must stay quiet:
    // a command that writes JSON to stdout shares the stream with this line.
    if (rows > 0) {
      log.info("ledger.moved", { rows, durationMs: Math.round(performance.now() - started) });
    }
  },
};

/** Copies every committed ledger row from `source` into the ledger file. Returns the rows copied. */
function copyCommittedLedger(dataDir: string, source: string): number {
  const target = openChangeLedgerDatabase(dataDir);
  try {
    const db = target.db;
    db.query("ATTACH DATABASE ? AS moving").run(source);
    try {
      // Deferred, not IMMEDIATE: an IMMEDIATE transaction would ask for the
      // write lock of the attached database too, which the migration holds.
      return db.transaction(() => {
        const visible = new Set(
          (
            db.query("SELECT name FROM moving.sqlite_master WHERE type = 'table'").all() as Array<{
              name: string;
            }>
          ).map((row) => row.name),
        );
        let rows = 0;
        for (const table of CHANGE_LEDGER_TABLES) {
          db.exec(`DELETE FROM main.${table}`);
          if (!visible.has(table)) continue;
          const columns = sharedColumns(db, table);
          rows += db
            .query(`INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM moving.${table}`)
            .run().changes;
        }
        if (visible.has("sqlite_sequence")) {
          // AUTOINCREMENT counters, so no id is ever reused after the move.
          for (const table of CHANGE_LEDGER_TABLES) {
            db.query("DELETE FROM main.sqlite_sequence WHERE name = ?").run(table);
            db.query(
              "INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM moving.sqlite_sequence WHERE name = ?",
            ).run(table);
          }
        }
        return rows;
      })();
    } finally {
      db.exec("DETACH DATABASE moving");
    }
  } finally {
    target.close();
  }
}

/** The columns `table` has in both files, quoted, in the ledger file's order. */
function sharedColumns(db: StorageDatabase["db"], table: string): string {
  const names = (schema: string) =>
    (
      db.query(`SELECT name FROM pragma_table_info(?, ?)`).all(table, schema) as Array<{
        name: string;
      }>
    ).map((row) => row.name);
  const source = new Set(names("moving"));
  return names("main")
    .filter((name) => source.has(name))
    .map((name) => `"${name}"`)
    .join(", ");
}
