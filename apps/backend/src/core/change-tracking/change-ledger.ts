/**
 * ChangeLedger: indexed durable records for change tracking, on the shared
 * `orkestrator.sqlite` (tables from ledger-schema.ts).
 *
 * Every method is synchronous and short. Callers never hold a transaction
 * across an await: read the filesystem and write immutable objects first,
 * then commit references, measurements, selection pointers and outbox rows in
 * one {@link ChangeLedger.transaction} that revalidates the owner fence.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { ChangeMeasurement } from "@orkestrator/protocol/change-measurements";
import type { DiffIdentity } from "@orkestrator/protocol/change-resources";
import type { StorageDatabase } from "../storage-database.js";

export class OwnerFenceError extends Error {
  constructor(
    readonly worktreeId: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Change-tracking owner fence moved (${expected} → ${actual})`);
    this.name = "OwnerFenceError";
  }
}

export interface WorktreeRow {
  id: string;
  identity_key: string;
  incarnation: string;
  runtime_kind: string;
  runtime_id: string;
  canonical_root: string;
  git_dir: string | null;
  common_dir: string | null;
  fencing_epoch: number;
  owner_id: string | null;
  last_boundary_seq: number;
  last_observation_seq: number;
  tombstoned_at: string | null;
}

export interface OperationRow {
  operation_id: string;
  binding_id: string;
  environment_id: string;
  conversation_id: string;
  turn_id: string | null;
  call_id: string | null;
  parent_call_id: string | null;
  attempt_id: string;
  tool_kind: string;
  phase: string;
  execution_occurrence: string;
  background_task_id: string | null;
  capability_revision: string | null;
  history_mode: string;
  presentation_revision: number;
  reconciliation_json: string | null;
  first_seen_seq: number;
  updated_seq: number;
}

export interface EvidenceRow {
  evidence_id: string;
  revision: number;
  owner_kind: string;
  owner_id: string;
  evidence_key: string;
  revision_key: string;
  replaces_revision_key: string | null;
  kind: string;
  claim: string;
  evidence_json: string;
  selected: number;
  frame_key: string;
  ingested_seq: number;
}

export interface SnapshotRow {
  id: string;
  worktree_id: string;
  incarnation: string;
  tree_oid: string;
  object_format: string;
  policy_id: string;
  capture_started_at: string;
  capture_finished_at: string;
  observation_epoch: number;
  coverage_json: string;
  consistency_json: string;
  closure_verified: number;
  file_count: number;
  retained_bytes: number;
  created_at: string;
}

export interface SegmentRow {
  segment_id: string;
  thread_id: string;
  environment_id: string;
  worktree_id: string;
  initial_turn_id: string | null;
  baseline_snapshot_id: string | null;
  baseline_state: string;
  baseline_reason: string | null;
  latest_live_snapshot_id: string | null;
  final_snapshot_id: string | null;
  inherited_prefix_id: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface TurnBoundaryRow {
  turn_id: string;
  segment_id: string;
  thread_id: string;
  environment_id: string;
  worktree_id: string;
  lifecycle: string;
  start_attempt_id: string | null;
  start_snapshot_id: string | null;
  end_snapshot_id: string | null;
  before_quality: string;
  after_quality: string;
  terminal_evidence: string | null;
  dispatch_token: string | null;
  dispatch_receipt: string | null;
  reason: string | null;
  started_at: string;
  finished_at: string | null;
  ordinal: number;
}

export interface ToolWindowRow {
  window_id: string;
  operation_id: string;
  turn_id: string | null;
  worktree_id: string;
  before_snapshot_id: string | null;
  after_snapshot_id: string | null;
  before_quality: string;
  after_quality: string;
  overlap: string;
  overlap_group: string | null;
  lifecycle: string;
  opened_seq: number;
  closed_seq: number | null;
  opened_at: string;
  closed_at: string | null;
  reason: string | null;
}

export interface MeasurementFileRecord {
  pathId: string;
  oldPath: string | null;
  newPath: string | null;
  oldBlob: string | null;
  newBlob: string | null;
  oldMode: string | null;
  newMode: string | null;
  status: string;
  fileKind: string;
  additions: number | null;
  additionsQuality: string;
  deletions: number | null;
  deletionsQuality: string;
  bodyState: string;
  reason: string | null;
}

export interface SelectionRow {
  selection_key: string;
  selector: string;
  baseline_version: string | null;
  measurement_id: string | null;
  selected_observation_epoch: number;
  revision: number;
  worktree_incarnation: string | null;
  owner_fence: number;
  updated_at: string;
}

export interface OutboxRow {
  sequence: number;
  resource_key: string;
  revision: number;
  measurement_id: string | null;
  event_kind: string;
  delivered: number;
  created_at: string;
}

export interface CaptureAttemptRow {
  id: string;
  boundary_key: string;
  worktree_id: string;
  owner_epoch: number;
  required_after_boundary_seq: number;
  purpose: string;
  status: string;
  deadline_at: string;
  error_code: string | null;
  snapshot_id: string | null;
}

const now = () => new Date().toISOString();

export class ChangeLedger {
  constructor(private readonly storage: () => StorageDatabase) {}

  private get db(): Database {
    return this.storage().db;
  }

  /** One short IMMEDIATE transaction; `fn` must be synchronous. */
  transaction<T>(fn: () => T): T {
    return this.storage().transaction(fn);
  }

  // -------------------------------------------------------------------------
  // Sequences and meta
  // -------------------------------------------------------------------------

  /** Durable ledger-wide ingestion sequence (audit order only). */
  nextSequence(): number {
    return this.transaction(() => {
      const row = this.db.query("SELECT value FROM change_ledger_meta WHERE key = 'seq'").get() as {
        value: string;
      } | null;
      const next = (row ? Number(row.value) : 0) + 1;
      this.db
        .query(
          "INSERT INTO change_ledger_meta (key, value) VALUES ('seq', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
        )
        .run(String(next));
      return next;
    });
  }

  meta(key: string): string | null {
    const row = this.db.query("SELECT value FROM change_ledger_meta WHERE key = ?").get(key) as {
      value: string;
    } | null;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO change_ledger_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
      )
      .run(key, value);
  }

  // -------------------------------------------------------------------------
  // Worktrees, fences and boundary sequences
  // -------------------------------------------------------------------------

  worktreeByIdentity(identityKey: string): WorktreeRow | null {
    return this.db
      .query(
        "SELECT * FROM change_worktrees WHERE identity_key = ? AND tombstoned_at IS NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get(identityKey) as WorktreeRow | null;
  }

  worktree(id: string): WorktreeRow | null {
    return this.db
      .query("SELECT * FROM change_worktrees WHERE id = ?")
      .get(id) as WorktreeRow | null;
  }

  insertWorktree(
    row: Omit<
      WorktreeRow,
      "fencing_epoch" | "owner_id" | "last_boundary_seq" | "last_observation_seq" | "tombstoned_at"
    >,
  ): WorktreeRow {
    const at = now();
    this.db
      .query(
        `INSERT INTO change_worktrees (id, identity_key, incarnation, runtime_kind, runtime_id, canonical_root, git_dir, common_dir, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
      )
      .run(
        row.id,
        row.identity_key,
        row.incarnation,
        row.runtime_kind,
        row.runtime_id,
        row.canonical_root,
        row.git_dir,
        row.common_dir,
        at,
      );
    return this.worktree(row.id)!;
  }

  tombstoneWorktree(id: string): void {
    this.db
      .query("UPDATE change_worktrees SET tombstoned_at = ?2, updated_at = ?2 WHERE id = ?1")
      .run(id, now());
  }

  /**
   * Take ownership of a worktree: advance its durable fence and record the
   * owner. Every later publication or mutation must present this epoch.
   */
  claimOwnership(worktreeId: string, ownerId: string): number {
    return this.transaction(() => {
      this.db
        .query(
          "UPDATE change_worktrees SET fencing_epoch = fencing_epoch + 1, owner_id = ?2, updated_at = ?3 WHERE id = ?1",
        )
        .run(worktreeId, ownerId, now());
      return this.worktree(worktreeId)?.fencing_epoch ?? 0;
    });
  }

  /** Throws {@link OwnerFenceError} unless `epoch` is still current. Use inside a transaction. */
  assertFence(worktreeId: string, epoch: number): void {
    const current = this.worktree(worktreeId)?.fencing_epoch ?? -1;
    if (current !== epoch) throw new OwnerFenceError(worktreeId, epoch, current);
  }

  nextBoundarySequence(worktreeId: string): number {
    return this.transaction(() => {
      this.db
        .query(
          "UPDATE change_worktrees SET last_boundary_seq = last_boundary_seq + 1, updated_at = ?2 WHERE id = ?1",
        )
        .run(worktreeId, now());
      return this.worktree(worktreeId)?.last_boundary_seq ?? 0;
    });
  }

  // -------------------------------------------------------------------------
  // Bindings, capabilities, cursors, frames
  // -------------------------------------------------------------------------

  resolveBinding(input: {
    sourceKey: string;
    environmentId: string;
    provider: string;
    conversationId: string;
    worktreeId: string | null;
  }): string {
    const existing = this.db
      .query("SELECT id FROM change_bindings WHERE source_key = ?")
      .get(input.sourceKey) as { id: string } | null;
    if (existing) {
      if (input.worktreeId) {
        this.db
          .query(
            "UPDATE change_bindings SET worktree_id = ?2 WHERE id = ?1 AND worktree_id IS NULL",
          )
          .run(existing.id, input.worktreeId);
      }
      return existing.id;
    }
    const id = `bind_${randomUUID()}`;
    this.db
      .query(
        `INSERT INTO change_bindings (id, source_key, environment_id, provider, conversation_id, worktree_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .run(
        id,
        input.sourceKey,
        input.environmentId,
        input.provider,
        input.conversationId,
        input.worktreeId,
        now(),
      );
    return id;
  }

  binding(id: string) {
    return this.db.query("SELECT * FROM change_bindings WHERE id = ?").get(id) as {
      id: string;
      source_key: string;
      environment_id: string;
      provider: string;
      conversation_id: string;
      worktree_id: string | null;
    } | null;
  }

  recordCapabilities(revision: string, json: string): void {
    this.db
      .query(
        "INSERT OR IGNORE INTO change_capabilities (revision, capabilities_json, first_seen_at) VALUES (?1, ?2, ?3)",
      )
      .run(revision, json, now());
  }

  capabilities(revision: string): string | null {
    const row = this.db
      .query("SELECT capabilities_json FROM change_capabilities WHERE revision = ?")
      .get(revision) as { capabilities_json: string } | null;
    return row?.capabilities_json ?? null;
  }

  cursor(sourceKey: string): { runtimeEpoch: string; cursor: number } | null {
    const row = this.db
      .query("SELECT runtime_epoch, cursor FROM change_evidence_cursors WHERE source_key = ?")
      .get(sourceKey) as { runtime_epoch: string; cursor: number } | null;
    return row ? { runtimeEpoch: row.runtime_epoch, cursor: row.cursor } : null;
  }

  setCursor(sourceKey: string, runtimeEpoch: string, cursor: number): void {
    this.db
      .query(
        `INSERT INTO change_evidence_cursors (source_key, runtime_epoch, cursor, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(source_key) DO UPDATE SET runtime_epoch = ?2, cursor = ?3, updated_at = ?4`,
      )
      .run(sourceKey, runtimeEpoch, cursor, now());
  }

  frame(frameKey: string): { receipt_id: string; content_hash: string } | null {
    return this.db
      .query("SELECT receipt_id, content_hash FROM change_frames WHERE frame_key = ?")
      .get(frameKey) as { receipt_id: string; content_hash: string } | null;
  }

  insertFrame(input: {
    frameKey: string;
    bindingId: string;
    runtimeEpoch: string;
    receiptId: string;
    contentHash: string;
    seq: number;
  }): void {
    this.db
      .query(
        `INSERT INTO change_frames (frame_key, binding_id, runtime_epoch, receipt_id, content_hash, ingested_seq, received_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .run(
        input.frameKey,
        input.bindingId,
        input.runtimeEpoch,
        input.receiptId,
        input.contentHash,
        input.seq,
        now(),
      );
  }

  // -------------------------------------------------------------------------
  // Operations and evidence
  // -------------------------------------------------------------------------

  operation(operationId: string): OperationRow | null {
    return this.db
      .query("SELECT * FROM change_operations WHERE operation_id = ?")
      .get(operationId) as OperationRow | null;
  }

  upsertOperation(row: OperationRow): void {
    this.db
      .query(
        `INSERT INTO change_operations (operation_id, binding_id, environment_id, conversation_id, turn_id, call_id, parent_call_id, attempt_id, tool_kind, phase, execution_occurrence, background_task_id, capability_revision, history_mode, presentation_revision, reconciliation_json, first_seen_seq, updated_seq)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
         ON CONFLICT(operation_id) DO UPDATE SET
           turn_id = COALESCE(change_operations.turn_id, ?5),
           parent_call_id = COALESCE(change_operations.parent_call_id, ?7),
           tool_kind = ?9, phase = ?10, execution_occurrence = ?11,
           background_task_id = COALESCE(change_operations.background_task_id, ?12),
           capability_revision = COALESCE(change_operations.capability_revision, ?13),
           presentation_revision = ?15, reconciliation_json = ?16, updated_seq = ?18`,
      )
      .run(
        row.operation_id,
        row.binding_id,
        row.environment_id,
        row.conversation_id,
        row.turn_id,
        row.call_id,
        row.parent_call_id,
        row.attempt_id,
        row.tool_kind,
        row.phase,
        row.execution_occurrence,
        row.background_task_id,
        row.capability_revision,
        row.history_mode,
        row.presentation_revision,
        row.reconciliation_json,
        row.first_seen_seq,
        row.updated_seq,
      );
  }

  operationsForTurn(turnId: string): OperationRow[] {
    return this.db
      .query("SELECT * FROM change_operations WHERE turn_id = ? ORDER BY first_seen_seq")
      .all(turnId) as OperationRow[];
  }

  operationsForConversation(bindingId: string, limit: number): OperationRow[] {
    return this.db
      .query(
        "SELECT * FROM change_operations WHERE binding_id = ? ORDER BY first_seen_seq DESC LIMIT ?",
      )
      .all(bindingId, limit) as OperationRow[];
  }

  evidenceRevisions(evidenceId: string): EvidenceRow[] {
    return this.db
      .query("SELECT * FROM change_evidence WHERE evidence_id = ? ORDER BY revision")
      .all(evidenceId) as EvidenceRow[];
  }

  insertEvidence(row: EvidenceRow): void {
    this.db
      .query(
        `INSERT INTO change_evidence (evidence_id, revision, owner_kind, owner_id, evidence_key, revision_key, replaces_revision_key, kind, claim, evidence_json, selected, frame_key, ingested_seq)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .run(
        row.evidence_id,
        row.revision,
        row.owner_kind,
        row.owner_id,
        row.evidence_key,
        row.revision_key,
        row.replaces_revision_key,
        row.kind,
        row.claim,
        row.evidence_json,
        row.selected,
        row.frame_key,
        row.ingested_seq,
      );
  }

  /** Make `revision` the one selected revision of `evidenceId`. */
  selectEvidenceRevision(evidenceId: string, revision: number): void {
    this.db
      .query(
        "UPDATE change_evidence SET selected = CASE WHEN revision = ?2 THEN 1 ELSE 0 END WHERE evidence_id = ?1",
      )
      .run(evidenceId, revision);
  }

  selectedEvidence(ownerKind: string, ownerId: string): EvidenceRow[] {
    return this.db
      .query(
        "SELECT * FROM change_evidence WHERE owner_kind = ? AND owner_id = ? AND selected = 1 ORDER BY evidence_key",
      )
      .all(ownerKind, ownerId) as EvidenceRow[];
  }

  evidenceRevision(evidenceId: string, revision: number): EvidenceRow | null {
    return this.db
      .query("SELECT * FROM change_evidence WHERE evidence_id = ? AND revision = ?")
      .get(evidenceId, revision) as EvidenceRow | null;
  }

  insertChunk(input: {
    evidenceId: string;
    revisionKey: string;
    targetBodyId: string;
    chunkIndex: number;
    chunkId: string;
    offsetBytes: number;
    bodyId: string;
    final: boolean;
  }): "inserted" | "duplicate" | "conflict" {
    const existing = this.db
      .query(
        "SELECT chunk_id, body_id, offset_bytes FROM change_evidence_chunks WHERE evidence_id = ? AND revision_key = ? AND chunk_index = ?",
      )
      .get(input.evidenceId, input.revisionKey, input.chunkIndex) as {
      chunk_id: string;
      body_id: string;
      offset_bytes: number;
    } | null;
    if (existing) {
      return existing.chunk_id === input.chunkId &&
        existing.body_id === input.bodyId &&
        existing.offset_bytes === input.offsetBytes
        ? "duplicate"
        : "conflict";
    }
    this.db
      .query(
        `INSERT INTO change_evidence_chunks (evidence_id, revision_key, target_body_id, chunk_index, chunk_id, offset_bytes, body_id, final)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .run(
        input.evidenceId,
        input.revisionKey,
        input.targetBodyId,
        input.chunkIndex,
        input.chunkId,
        input.offsetBytes,
        input.bodyId,
        input.final ? 1 : 0,
      );
    return "inserted";
  }

  chunks(evidenceId: string, revisionKey: string) {
    return this.db
      .query(
        "SELECT * FROM change_evidence_chunks WHERE evidence_id = ? AND revision_key = ? ORDER BY chunk_index",
      )
      .all(evidenceId, revisionKey) as Array<{
      chunk_index: number;
      offset_bytes: number;
      body_id: string;
      final: number;
    }>;
  }

  recordBody(input: {
    bodyId: string;
    state: "available" | "unavailable" | "expired";
    bytes: number;
    complete: boolean;
    originalBytes: number | null;
    reason: string | null;
  }): void {
    this.db
      .query(
        `INSERT INTO change_evidence_bodies (body_id, state, bytes, complete, original_bytes, reason, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(body_id) DO UPDATE SET state = CASE WHEN change_evidence_bodies.state = 'available' THEN 'available' ELSE ?2 END`,
      )
      .run(
        input.bodyId,
        input.state,
        input.bytes,
        input.complete ? 1 : 0,
        input.originalBytes,
        input.reason,
        now(),
      );
  }

  body(bodyId: string) {
    return this.db.query("SELECT * FROM change_evidence_bodies WHERE body_id = ?").get(bodyId) as {
      body_id: string;
      state: string;
      bytes: number;
      complete: number;
      original_bytes: number | null;
      reason: string | null;
    } | null;
  }

  expireBody(bodyId: string, reason: string): void {
    this.db
      .query(
        "UPDATE change_evidence_bodies SET state = 'expired', reason = ?2, expires_at = ?3 WHERE body_id = ?1",
      )
      .run(bodyId, reason, now());
  }

  recordGap(input: {
    gapId: string;
    bindingId: string;
    coverageJson: string;
    reason: string;
  }): boolean {
    const result = this.db
      .query(
        "INSERT OR IGNORE INTO change_evidence_gaps (gap_id, binding_id, coverage_json, reason, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      )
      .run(input.gapId, input.bindingId, input.coverageJson, input.reason, now());
    return result.changes > 0;
  }

  gapsForBinding(bindingId: string): number {
    return (
      this.db
        .query("SELECT COUNT(*) AS n FROM change_evidence_gaps WHERE binding_id = ?")
        .get(bindingId) as {
        n: number;
      }
    ).n;
  }

  // -------------------------------------------------------------------------
  // Capture attempts and snapshots
  // -------------------------------------------------------------------------

  reserveCapture(input: {
    boundaryKey: string;
    worktreeId: string;
    ownerEpoch: number;
    requiredAfterBoundarySeq: number;
    purpose: string;
    deadlineAt: string;
  }): CaptureAttemptRow {
    const existing = this.db
      .query("SELECT * FROM change_capture_attempts WHERE boundary_key = ?")
      .get(input.boundaryKey) as CaptureAttemptRow | null;
    if (existing) return existing;
    const id = `cap_${randomUUID()}`;
    const at = now();
    this.db
      .query(
        `INSERT INTO change_capture_attempts (id, boundary_key, worktree_id, owner_epoch, required_after_boundary_seq, purpose, status, deadline_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'reserved', ?7, ?8, ?8)`,
      )
      .run(
        id,
        input.boundaryKey,
        input.worktreeId,
        input.ownerEpoch,
        input.requiredAfterBoundarySeq,
        input.purpose,
        input.deadlineAt,
        at,
      );
    return this.db
      .query("SELECT * FROM change_capture_attempts WHERE id = ?")
      .get(id) as CaptureAttemptRow;
  }

  finishCapture(
    id: string,
    status: "published" | "failed" | "abandoned",
    input: { snapshotId?: string; errorCode?: string },
  ): void {
    this.db
      .query(
        "UPDATE change_capture_attempts SET status = ?2, snapshot_id = ?3, error_code = ?4, updated_at = ?5 WHERE id = ?1",
      )
      .run(id, status, input.snapshotId ?? null, input.errorCode ?? null, now());
  }

  pendingCaptures(): CaptureAttemptRow[] {
    return this.db
      .query("SELECT * FROM change_capture_attempts WHERE status = 'reserved'")
      .all() as CaptureAttemptRow[];
  }

  insertSnapshot(row: SnapshotRow): void {
    this.db
      .query(
        `INSERT INTO change_snapshots (id, worktree_id, incarnation, tree_oid, object_format, policy_id, capture_started_at, capture_finished_at, observation_epoch, coverage_json, consistency_json, closure_verified, file_count, retained_bytes, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
      )
      .run(
        row.id,
        row.worktree_id,
        row.incarnation,
        row.tree_oid,
        row.object_format,
        row.policy_id,
        row.capture_started_at,
        row.capture_finished_at,
        row.observation_epoch,
        row.coverage_json,
        row.consistency_json,
        row.closure_verified,
        row.file_count,
        row.retained_bytes,
        row.created_at,
      );
  }

  snapshot(id: string): SnapshotRow | null {
    return this.db
      .query("SELECT * FROM change_snapshots WHERE id = ?")
      .get(id) as SnapshotRow | null;
  }

  latestSnapshot(worktreeId: string): SnapshotRow | null {
    return this.db
      .query(
        "SELECT * FROM change_snapshots WHERE worktree_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(worktreeId) as SnapshotRow | null;
  }

  snapshots(): SnapshotRow[] {
    return this.db
      .query("SELECT * FROM change_snapshots ORDER BY created_at")
      .all() as SnapshotRow[];
  }

  deleteSnapshot(id: string): void {
    this.db.query("DELETE FROM change_snapshots WHERE id = ?").run(id);
  }

  // -------------------------------------------------------------------------
  // Segments, turns, windows
  // -------------------------------------------------------------------------

  insertSegment(row: SegmentRow): void {
    this.db
      .query(
        `INSERT INTO change_thread_segments (segment_id, thread_id, environment_id, worktree_id, initial_turn_id, baseline_snapshot_id, baseline_state, baseline_reason, latest_live_snapshot_id, final_snapshot_id, inherited_prefix_id, created_at, closed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .run(
        row.segment_id,
        row.thread_id,
        row.environment_id,
        row.worktree_id,
        row.initial_turn_id,
        row.baseline_snapshot_id,
        row.baseline_state,
        row.baseline_reason,
        row.latest_live_snapshot_id,
        row.final_snapshot_id,
        row.inherited_prefix_id,
        row.created_at,
        row.closed_at,
      );
  }

  currentSegment(threadId: string): SegmentRow | null {
    return this.db
      .query(
        "SELECT * FROM change_thread_segments WHERE thread_id = ? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get(threadId) as SegmentRow | null;
  }

  segment(segmentId: string): SegmentRow | null {
    return this.db
      .query("SELECT * FROM change_thread_segments WHERE segment_id = ?")
      .get(segmentId) as SegmentRow | null;
  }

  segmentsForThread(threadId: string): SegmentRow[] {
    return this.db
      .query("SELECT * FROM change_thread_segments WHERE thread_id = ? ORDER BY created_at")
      .all(threadId) as SegmentRow[];
  }

  updateSegment(segmentId: string, patch: Partial<SegmentRow>): void {
    const entries = Object.entries(patch).filter(([key]) => key !== "segment_id");
    if (entries.length === 0) return;
    const sets = entries.map(([key], index) => `${key} = ?${index + 2}`).join(", ");
    this.db
      .query(`UPDATE change_thread_segments SET ${sets} WHERE segment_id = ?1`)
      .run(segmentId, ...(entries.map(([, value]) => value) as Array<string | number | null>));
  }

  insertTurn(row: TurnBoundaryRow): void {
    this.db
      .query(
        `INSERT INTO change_turn_boundaries (turn_id, segment_id, thread_id, environment_id, worktree_id, lifecycle, start_attempt_id, start_snapshot_id, end_snapshot_id, before_quality, after_quality, terminal_evidence, dispatch_token, dispatch_receipt, reason, started_at, finished_at, ordinal)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
      )
      .run(
        row.turn_id,
        row.segment_id,
        row.thread_id,
        row.environment_id,
        row.worktree_id,
        row.lifecycle,
        row.start_attempt_id,
        row.start_snapshot_id,
        row.end_snapshot_id,
        row.before_quality,
        row.after_quality,
        row.terminal_evidence,
        row.dispatch_token,
        row.dispatch_receipt,
        row.reason,
        row.started_at,
        row.finished_at,
        row.ordinal,
      );
  }

  turn(turnId: string): TurnBoundaryRow | null {
    return this.db
      .query("SELECT * FROM change_turn_boundaries WHERE turn_id = ?")
      .get(turnId) as TurnBoundaryRow | null;
  }

  updateTurn(turnId: string, patch: Partial<TurnBoundaryRow>): void {
    const entries = Object.entries(patch).filter(([key]) => key !== "turn_id");
    if (entries.length === 0) return;
    const sets = entries.map(([key], index) => `${key} = ?${index + 2}`).join(", ");
    this.db
      .query(`UPDATE change_turn_boundaries SET ${sets} WHERE turn_id = ?1`)
      .run(turnId, ...(entries.map(([, value]) => value) as Array<string | number | null>));
  }

  turnsForThread(threadId: string, afterOrdinal: number, limit: number): TurnBoundaryRow[] {
    return this.db
      .query(
        "SELECT * FROM change_turn_boundaries WHERE thread_id = ? AND ordinal > ? ORDER BY ordinal LIMIT ?",
      )
      .all(threadId, afterOrdinal, limit) as TurnBoundaryRow[];
  }

  recentTurnsForThread(threadId: string, beforeOrdinal: number, limit: number): TurnBoundaryRow[] {
    return this.db
      .query(
        "SELECT * FROM change_turn_boundaries WHERE thread_id = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT ?",
      )
      .all(threadId, beforeOrdinal, limit) as TurnBoundaryRow[];
  }

  nextTurnOrdinal(threadId: string): number {
    const row = this.db
      .query("SELECT MAX(ordinal) AS n FROM change_turn_boundaries WHERE thread_id = ?")
      .get(threadId) as { n: number | null };
    return (row.n ?? 0) + 1;
  }

  activeTurns(): TurnBoundaryRow[] {
    return this.db
      .query(
        "SELECT * FROM change_turn_boundaries WHERE lifecycle NOT IN ('finalized', 'interrupted', 'end-unavailable', 'abandoned')",
      )
      .all() as TurnBoundaryRow[];
  }

  latestTurnForThread(threadId: string): TurnBoundaryRow | null {
    return this.db
      .query(
        "SELECT * FROM change_turn_boundaries WHERE thread_id = ? ORDER BY ordinal DESC LIMIT 1",
      )
      .get(threadId) as TurnBoundaryRow | null;
  }

  /** Terminal turns, oldest first (retention order). */
  turnsByAge(): TurnBoundaryRow[] {
    return this.db
      .query("SELECT * FROM change_turn_boundaries ORDER BY COALESCE(finished_at, started_at) ASC")
      .all() as TurnBoundaryRow[];
  }

  insertWindow(row: ToolWindowRow): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO change_tool_windows (window_id, operation_id, turn_id, worktree_id, before_snapshot_id, after_snapshot_id, before_quality, after_quality, overlap, overlap_group, lifecycle, opened_seq, closed_seq, opened_at, closed_at, reason)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
      )
      .run(
        row.window_id,
        row.operation_id,
        row.turn_id,
        row.worktree_id,
        row.before_snapshot_id,
        row.after_snapshot_id,
        row.before_quality,
        row.after_quality,
        row.overlap,
        row.overlap_group,
        row.lifecycle,
        row.opened_seq,
        row.closed_seq,
        row.opened_at,
        row.closed_at,
        row.reason,
      );
  }

  window(windowId: string): ToolWindowRow | null {
    return this.db
      .query("SELECT * FROM change_tool_windows WHERE window_id = ?")
      .get(windowId) as ToolWindowRow | null;
  }

  openWindows(worktreeId: string): ToolWindowRow[] {
    return this.db
      .query("SELECT * FROM change_tool_windows WHERE worktree_id = ? AND lifecycle = 'open'")
      .all(worktreeId) as ToolWindowRow[];
  }

  allOpenWindows(): ToolWindowRow[] {
    return this.db
      .query("SELECT * FROM change_tool_windows WHERE lifecycle = 'open'")
      .all() as ToolWindowRow[];
  }

  /** Windows of `worktreeId` whose interval intersects [openedSeq, closedSeq]. */
  overlappingWindows(
    worktreeId: string,
    windowId: string,
    openedSeq: number,
    closedSeq: number,
  ): ToolWindowRow[] {
    return this.db
      .query(
        `SELECT * FROM change_tool_windows WHERE worktree_id = ?1 AND window_id != ?2
           AND opened_seq <= ?4 AND (closed_seq IS NULL OR closed_seq >= ?3)`,
      )
      .all(worktreeId, windowId, openedSeq, closedSeq) as ToolWindowRow[];
  }

  updateWindow(windowId: string, patch: Partial<ToolWindowRow>): void {
    const entries = Object.entries(patch).filter(([key]) => key !== "window_id");
    if (entries.length === 0) return;
    const sets = entries.map(([key], index) => `${key} = ?${index + 2}`).join(", ");
    this.db
      .query(`UPDATE change_tool_windows SET ${sets} WHERE window_id = ?1`)
      .run(windowId, ...(entries.map(([, value]) => value) as Array<string | number | null>));
  }

  // -------------------------------------------------------------------------
  // Measurements, files, identities
  // -------------------------------------------------------------------------

  insertMeasurement(
    measurement: ChangeMeasurement,
    owner: { kind: string; id: string },
    files: readonly MeasurementFileRecord[],
    seq: number,
  ): void {
    this.db
      .query(
        `INSERT INTO change_measurements (id, scope, owner_kind, owner_id, worktree_id, from_snapshot_id, to_snapshot_id, algorithm_id, representation_id, measurement_json, supersedes_id, created_seq)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .run(
        measurement.measurementId,
        measurement.scope,
        owner.kind,
        owner.id,
        measurement.worktreeId,
        measurement.beforeSnapshotId,
        measurement.afterSnapshotId,
        measurement.algorithmPolicyId,
        measurement.representationPolicyId,
        JSON.stringify(measurement),
        measurement.supersedesMeasurementId,
        seq,
      );
    const insert = this.db.query(
      `INSERT INTO change_measurement_files (measurement_id, ordinal, path_id, old_path, new_path, old_blob, new_blob, old_mode, new_mode, status, file_kind, additions, additions_quality, deletions, deletions_quality, body_state, reason)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
    );
    files.forEach((file, ordinal) => {
      insert.run(
        measurement.measurementId,
        ordinal,
        file.pathId,
        file.oldPath,
        file.newPath,
        file.oldBlob,
        file.newBlob,
        file.oldMode,
        file.newMode,
        file.status,
        file.fileKind,
        file.additions,
        file.additionsQuality,
        file.deletions,
        file.deletionsQuality,
        file.bodyState,
        file.reason,
      );
    });
  }

  measurement(id: string): ChangeMeasurement | null {
    const row = this.db
      .query("SELECT measurement_json FROM change_measurements WHERE id = ?")
      .get(id) as { measurement_json: string } | null;
    return row ? (JSON.parse(row.measurement_json) as ChangeMeasurement) : null;
  }

  measurementOwner(id: string): { owner_kind: string; owner_id: string } | null {
    return this.db
      .query("SELECT owner_kind, owner_id FROM change_measurements WHERE id = ?")
      .get(id) as { owner_kind: string; owner_id: string } | null;
  }

  latestMeasurement(ownerKind: string, ownerId: string, scope: string): ChangeMeasurement | null {
    const row = this.db
      .query(
        "SELECT measurement_json FROM change_measurements WHERE owner_kind = ? AND owner_id = ? AND scope = ? ORDER BY created_seq DESC LIMIT 1",
      )
      .get(ownerKind, ownerId, scope) as { measurement_json: string } | null;
    return row ? (JSON.parse(row.measurement_json) as ChangeMeasurement) : null;
  }

  measurementFiles(measurementId: string, offset: number, limit: number) {
    return this.db
      .query(
        "SELECT * FROM change_measurement_files WHERE measurement_id = ? ORDER BY ordinal LIMIT ? OFFSET ?",
      )
      .all(measurementId, limit, offset) as Array<{
      measurement_id: string;
      ordinal: number;
      path_id: string;
      old_path: string | null;
      new_path: string | null;
      old_blob: string | null;
      new_blob: string | null;
      old_mode: string | null;
      new_mode: string | null;
      status: string;
      file_kind: string;
      additions: number | null;
      additions_quality: string;
      deletions: number | null;
      deletions_quality: string;
      body_state: string;
      reason: string | null;
    }>;
  }

  measurementFileCount(measurementId: string): number {
    return (
      this.db
        .query("SELECT COUNT(*) AS n FROM change_measurement_files WHERE measurement_id = ?")
        .get(measurementId) as { n: number }
    ).n;
  }

  /**
   * Deletes measurements nothing reads any more, with their file rows and
   * diff identities, oldest first. A measurement goes once `keepLatest` newer
   * ones of the same owner and scope exist, unless a resource still selects
   * it, an unexpired restore token or a running restore holds it. Readers only
   * reach measurements through selections (and, briefly, the identity of one
   * just superseded, which `keepLatest` covers), so a pruned one is never
   * looked up again; the handoff reports one as "not retained".
   *
   * Every re-measurement stores its whole file list again (an environment's
   * net diff can be thousands of files), so without this the table grows
   * without bound. Bounded work per call: stops after `maxMeasurements` or
   * once `maxFileRows` file rows are deleted, in one transaction.
   */
  pruneSupersededMeasurements(input: {
    keepLatest: number;
    nowIso: string;
    maxMeasurements: number;
    maxFileRows?: number;
    owner?: { kind: string; id: string; scope: string };
  }): { measurements: number; files: number } {
    return this.transaction(() => {
      const ownedBy = input.owner ? "WHERE owner_kind = ?4 AND owner_id = ?5 AND scope = ?6" : "";
      const candidates = this.db
        .query(
          `SELECT id FROM (
             SELECT id, created_seq, ROW_NUMBER() OVER (
               PARTITION BY owner_kind, owner_id, scope ORDER BY created_seq DESC
             ) AS newer
             FROM change_measurements ${ownedBy}
           )
           WHERE newer > ?1
             AND id NOT IN (SELECT measurement_id FROM change_selections WHERE measurement_id IS NOT NULL)
             AND id NOT IN (SELECT measurement_id FROM change_restore_tokens WHERE expires_at > ?2 AND consumed_at IS NULL)
             AND id NOT IN (SELECT measurement_id FROM change_restore_operations WHERE state = 'applying')
           ORDER BY created_seq
           LIMIT ?3`,
        )
        .all(
          input.keepLatest,
          input.nowIso,
          input.maxMeasurements,
          ...(input.owner ? [input.owner.kind, input.owner.id, input.owner.scope] : []),
        ) as Array<{ id: string }>;
      const deleteFiles = this.db.query(
        "DELETE FROM change_measurement_files WHERE measurement_id = ?",
      );
      const deleteIdentities = this.db.query(
        "DELETE FROM change_diff_identities WHERE measurement_id = ?",
      );
      const deleteMeasurement = this.db.query("DELETE FROM change_measurements WHERE id = ?");
      const pruned = { measurements: 0, files: 0 };
      for (const { id } of candidates) {
        if (input.maxFileRows !== undefined && pruned.files >= input.maxFileRows) break;
        pruned.files += deleteFiles.run(id).changes;
        deleteIdentities.run(id);
        deleteMeasurement.run(id);
        pruned.measurements += 1;
      }
      return pruned;
    });
  }

  /** Returns up to `maxPages` free database pages to the filesystem; the free pages left. */
  releaseFreePages(maxPages?: number): number {
    return this.storage().releaseFreePages(maxPages);
  }

  insertDiffIdentity(identity: DiffIdentity): void {
    this.db
      .query(
        "INSERT OR IGNORE INTO change_diff_identities (id, measurement_id, identity_json, created_at) VALUES (?1, ?2, ?3, ?4)",
      )
      .run(identity.id, identity.measurementId, JSON.stringify(identity), now());
  }

  /** Blobs referenced by file-pair identities (live details). */
  diffIdentityBlobs(): string[] {
    const blobs: string[] = [];
    const rows = this.db
      .query(
        'SELECT identity_json FROM change_diff_identities WHERE identity_json LIKE \'%"kind":"file"%\'',
      )
      .all() as Array<{ identity_json: string }>;
    for (const row of rows) {
      const identity = JSON.parse(row.identity_json) as DiffIdentity;
      if (identity.kind !== "file") continue;
      for (const side of [identity.before, identity.after])
        if (side.state === "present") blobs.push(side.blobId);
    }
    return blobs;
  }

  /** Live-detail identities are transient views; prune them after `olderThan`. */
  pruneLiveIdentities(olderThan: string): number {
    return this.db
      .query(
        'DELETE FROM change_diff_identities WHERE created_at < ? AND identity_json LIKE \'%"kind":"file"%\'',
      )
      .run(olderThan).changes;
  }

  diffIdentity(id: string): DiffIdentity | null {
    const row = this.db
      .query("SELECT identity_json FROM change_diff_identities WHERE id = ?")
      .get(id) as { identity_json: string } | null;
    return row ? (JSON.parse(row.identity_json) as DiffIdentity) : null;
  }

  // -------------------------------------------------------------------------
  // References, selections, outbox
  // -------------------------------------------------------------------------

  addReference(input: {
    ownerKind: string;
    ownerId: string;
    snapshotId: string;
    reason: string;
    expiresAt?: string | null;
  }): void {
    if (input.reason === "thread-latest") {
      this.removeReferences(input.ownerKind, input.ownerId, input.reason);
      if (input.ownerKind === "segment") this.removeReferences("segment-live", input.ownerId);
    }
    this.db
      .query(
        "INSERT OR IGNORE INTO change_references (owner_kind, owner_id, snapshot_id, reason, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      )
      .run(input.ownerKind, input.ownerId, input.snapshotId, input.reason, input.expiresAt ?? null);
  }

  removeReferences(ownerKind: string, ownerId: string, reason?: string): number {
    if (reason) {
      return this.db
        .query("DELETE FROM change_references WHERE owner_kind = ? AND owner_id = ? AND reason = ?")
        .run(ownerKind, ownerId, reason).changes;
    } else {
      return this.db
        .query("DELETE FROM change_references WHERE owner_kind = ? AND owner_id = ?")
        .run(ownerKind, ownerId).changes;
    }
  }

  expireReferences(at: string): number {
    return this.db
      .query("DELETE FROM change_references WHERE expires_at IS NOT NULL AND expires_at < ?")
      .run(at).changes;
  }

  referencedSnapshotIds(): Set<string> {
    const rows = this.db
      .query("SELECT DISTINCT snapshot_id FROM change_references")
      .all() as Array<{
      snapshot_id: string;
    }>;
    return new Set(rows.map((row) => row.snapshot_id));
  }

  selection(key: string): SelectionRow | null {
    return this.db
      .query("SELECT * FROM change_selections WHERE selection_key = ?")
      .get(key) as SelectionRow | null;
  }

  /**
   * Compare-and-swap a selection pointer. Succeeds only when the stored
   * revision equals `expectedRevision` (0 for absent) and the observation
   * epoch does not move backwards. Returns the new revision or null.
   */
  swapSelection(input: {
    key: string;
    selector: string;
    expectedRevision: number;
    baselineVersion: string | null;
    measurementId: string | null;
    observationEpoch: number;
    worktreeIncarnation: string | null;
    ownerFence: number;
  }): number | null {
    const current = this.selection(input.key);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== input.expectedRevision) return null;
    if (current && input.observationEpoch < current.selected_observation_epoch) return null;
    const revision = currentRevision + 1;
    this.db
      .query(
        `INSERT INTO change_selections (selection_key, selector, baseline_version, measurement_id, selected_observation_epoch, revision, worktree_incarnation, owner_fence, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(selection_key) DO UPDATE SET selector = ?2, baseline_version = ?3, measurement_id = ?4,
           selected_observation_epoch = ?5, revision = ?6, worktree_incarnation = ?7, owner_fence = ?8, updated_at = ?9`,
      )
      .run(
        input.key,
        input.selector,
        input.baselineVersion,
        input.measurementId,
        input.observationEpoch,
        revision,
        input.worktreeIncarnation,
        input.ownerFence,
        now(),
      );
    return revision;
  }

  appendOutbox(input: {
    resourceKey: string;
    revision: number;
    measurementId: string | null;
    eventKind: string;
  }): number {
    return Number(
      this.db
        .query(
          "INSERT INTO change_outbox (resource_key, revision, measurement_id, event_kind, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .run(input.resourceKey, input.revision, input.measurementId, input.eventKind, now())
        .lastInsertRowid,
    );
  }

  pendingOutbox(limit: number): OutboxRow[] {
    return this.db
      .query("SELECT * FROM change_outbox WHERE delivered = 0 ORDER BY sequence LIMIT ?")
      .all(limit) as OutboxRow[];
  }

  markOutboxDelivered(sequence: number): void {
    this.db.query("UPDATE change_outbox SET delivered = 1 WHERE sequence = ?").run(sequence);
  }

  pruneOutbox(keep: number): void {
    this.db
      .query(
        "DELETE FROM change_outbox WHERE delivered = 1 AND sequence < (SELECT COALESCE(MAX(sequence), 0) - ? FROM change_outbox)",
      )
      .run(keep);
  }

  // -------------------------------------------------------------------------
  // Restore tokens and operations
  // -------------------------------------------------------------------------

  insertRestoreToken(input: {
    token: string;
    measurementId: string;
    payloadJson: string;
    ownerFence: number;
    expiresAt: string;
  }): void {
    this.db
      .query(
        "INSERT INTO change_restore_tokens (token, measurement_id, payload_json, owner_fence, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      )
      .run(input.token, input.measurementId, input.payloadJson, input.ownerFence, input.expiresAt);
  }

  restoreToken(token: string) {
    return this.db.query("SELECT * FROM change_restore_tokens WHERE token = ?").get(token) as {
      token: string;
      measurement_id: string;
      payload_json: string;
      owner_fence: number;
      expires_at: string;
      consumed_at: string | null;
    } | null;
  }

  consumeRestoreToken(token: string): boolean {
    return (
      this.db
        .query(
          "UPDATE change_restore_tokens SET consumed_at = ?2 WHERE token = ?1 AND consumed_at IS NULL",
        )
        .run(token, now()).changes > 0
    );
  }

  restoreOperationByKey(idempotencyKey: string) {
    return this.db
      .query("SELECT * FROM change_restore_operations WHERE idempotency_key = ?")
      .get(idempotencyKey) as {
      id: string;
      idempotency_key: string;
      token: string;
      measurement_id: string;
      state: string;
      outcome_json: string | null;
    } | null;
  }

  insertRestoreOperation(input: {
    id: string;
    idempotencyKey: string;
    token: string;
    measurementId: string;
  }): void {
    const at = now();
    this.db
      .query(
        "INSERT INTO change_restore_operations (id, idempotency_key, token, measurement_id, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'applying', ?5, ?5)",
      )
      .run(input.id, input.idempotencyKey, input.token, input.measurementId, at);
  }

  recoverRestoreOperations(): void {
    const outcome = {
      kind: "error",
      error: { code: "precondition-failed", reasonKey: "changes.restore.interrupted" },
    };
    this.db
      .query(
        "UPDATE change_restore_operations SET state = 'failed', outcome_json = ?, updated_at = ? WHERE state = 'applying' AND outcome_json IS NULL",
      )
      .run(JSON.stringify(outcome), now());
  }

  finishRestoreOperation(id: string, state: string, outcomeJson: string): void {
    this.db
      .query(
        "UPDATE change_restore_operations SET state = ?2, outcome_json = ?3, updated_at = ?4 WHERE id = ?1",
      )
      .run(id, state, outcomeJson, now());
  }
}
