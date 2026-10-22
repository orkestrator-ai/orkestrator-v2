/**
 * ChangeLedger schema (storage migration 4).
 *
 * The first engine with its own indexed tables in `orkestrator.sqlite`: the
 * ledger needs joins and range scans (turns of a thread, open windows of a
 * worktree, outbox order) that the shared `store_rows` layout cannot serve
 * without decoding whole stores. Rows hold identities, bounded metadata and
 * references only. File contents and evidence bodies are files under
 * `<dataDir>/change-tracking/` (see snapshot-store.ts, evidence-body-store.ts).
 *
 * Import nothing at runtime: `storage-stores.ts` loads this module while
 * opening the database.
 */

import type { StorageMigration } from "../storage-database.js";

export const CHANGE_LEDGER_MIGRATION_VERSION = 4;

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

export const changeLedgerMigration: StorageMigration = {
  version: CHANGE_LEDGER_MIGRATION_VERSION,
  name: "change-ledger",
  up({ db }) {
    db.exec(CHANGE_LEDGER_SCHEMA);
  },
};
