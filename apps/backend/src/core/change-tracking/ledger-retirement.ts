/**
 * LedgerRetirement: the bounded deletes behind environment purges and age-based
 * retention. `ChangeRetentionService` decides when they run and yields between
 * them; every method here is one short transaction.
 *
 * A row budget bounds each transaction. Children go before their parent, and a
 * parent stays until the last of them is gone, so a batch that stops early (or a
 * crash) resumes by finding the same parent again. Snapshot rows, objects and
 * evidence bodies are never deleted here: only the rows that name them. The
 * reachability sweeps then take what nothing names any more, which is what keeps
 * content another environment shares.
 */

import { environmentChangeResourceKey } from "@orkestrator/protocol/change-resources";
import {
  TERMINAL_TURN_LIFECYCLES,
  TURN_RETENTION_CURSOR_KEY,
  turnLifecycleSqlList,
  type ChangeLedger,
} from "./change-ledger.js";
import { GIT_SCOPES, gitScopeResourceKey } from "./git-scopes.js";
import {
  operationVolumeResourceKey,
  threadResourceKey,
  toolResourceKeys,
  turnResourceKeys,
} from "./identities.js";

const PURGE_PREFIX = "purge-env:";
/** The ledger sequence below which every frame is past the archive window. */
const EXPIRED_SEQUENCE_KEY = "retention:expired-seq";
const OWNERS_PER_QUERY = 16;
const WALK_PAGE_ROWS = 256;
const TURN_AGE = "COALESCE(finished_at, started_at)";

export interface EnvironmentPurge {
  environmentId: string;
  requestedAt: string;
  /** Worktrees only this environment used, tombstoned by the delete. */
  worktreeIds: string[];
  /** Evidence producers seen for it; their cursors name no environment. */
  sourceKeys: string[];
}

export interface RetirementBatch {
  rows: number;
  done: boolean;
  held?: boolean;
}

interface Budget {
  left: number;
}

/** The half-open key range of everything starting with `prefix`. */
const under = (prefix: string): [string, string] => [prefix, `${prefix}￿`];

export class LedgerRetirement {
  private indexedDatabase: unknown = null;

  constructor(private readonly ledger: ChangeLedger) {}

  private get db() {
    return this.ledger.db;
  }

  /**
   * Indexes that change no stored value and no schema version, as
   * `store_rows_position` does (docs/architecture/storage.md), so an older build
   * still opens the ledger. On small tables, about one row per turn or thread;
   * the larger tables are walked in row order, which is age order, instead.
   * Three serve lookups the event loop otherwise paid with a scan (to-do 0741
   * task 6): a pruning candidate's selection; the open tool windows, which
   * every retention pass and startup read; and a purged binding's provider
   * turns, found by frame key. The last two are partial indexes, holding only
   * the rows those queries ask for.
   */
  ensureIndexes(): void {
    const db = this.db;
    if (this.indexedDatabase === db) return;
    db.exec(`
      CREATE INDEX IF NOT EXISTS change_turn_boundaries_environment ON change_turn_boundaries (environment_id);
      CREATE INDEX IF NOT EXISTS change_thread_segments_environment ON change_thread_segments (environment_id);
      CREATE INDEX IF NOT EXISTS change_turn_boundaries_age ON change_turn_boundaries (${TURN_AGE}, turn_id);
      CREATE INDEX IF NOT EXISTS change_selections_measurement ON change_selections (measurement_id);
      CREATE INDEX IF NOT EXISTS change_tool_windows_open_only ON change_tool_windows (window_id) WHERE lifecycle = 'open';
      CREATE INDEX IF NOT EXISTS change_evidence_provider_turn_frames ON change_evidence (frame_key) WHERE owner_kind = 'provider-turn';
    `);
    this.indexedDatabase = db;
  }

  // -------------------------------------------------------------------------
  // What must not be deleted yet
  // -------------------------------------------------------------------------

  /** Measurements a restore or a reader still needs. */
  heldMeasurements(nowIso: string): Set<string> {
    const rows = this.db
      .query(
        `SELECT measurement_id AS id FROM change_restore_tokens WHERE expires_at > ?1 AND consumed_at IS NULL
         UNION SELECT measurement_id AS id FROM change_restore_operations WHERE state = 'applying'`,
      )
      .all(nowIso) as Array<{ id: string }>;
    const held = new Set(rows.map((row) => row.id));
    for (const id of this.ledger.pinnedMeasurements()) held.add(id);
    return held;
  }

  /** The endpoints a restore in progress reads, whatever released their references. */
  heldSnapshots(nowIso: string): Set<string> {
    const snapshots = new Set<string>();
    for (const id of this.heldMeasurements(nowIso)) {
      const measurement = this.ledger.measurement(id);
      if (measurement?.beforeSnapshotId) snapshots.add(measurement.beforeSnapshotId);
      if (measurement?.afterSnapshotId) snapshots.add(measurement.afterSnapshotId);
    }
    return snapshots;
  }

  /** A held measurement defers the environment's whole purge, briefly: tokens last minutes. */
  environmentHeld(environmentId: string, nowIso: string): boolean {
    for (const id of this.heldMeasurements(nowIso)) {
      if (this.ledger.measurement(id)?.logicalOwner.environmentId === environmentId) return true;
    }
    return false;
  }

  private heldOwners(nowIso: string): Set<string> {
    const owners = new Set<string>();
    for (const id of this.heldMeasurements(nowIso)) {
      const owner = this.ledger.measurementOwner(id);
      if (owner) owners.add(`${owner.owner_kind}\0${owner.owner_id}`);
    }
    return owners;
  }

  // -------------------------------------------------------------------------
  // Environment purges
  // -------------------------------------------------------------------------

  /** Worktrees an environment's rows name. Made-up ids (`legacy:`, `unresolved:`) have no row. */
  environmentWorktrees(environmentId: string): string[] {
    const rows = this.db
      .query(
        `SELECT worktree_id AS id FROM change_turn_boundaries WHERE environment_id = ?1
         UNION SELECT worktree_id AS id FROM change_thread_segments WHERE environment_id = ?1
         UNION SELECT worktree_id AS id FROM change_bindings WHERE environment_id = ?1 AND worktree_id IS NOT NULL
         UNION SELECT worktree_id AS id FROM change_measurements WHERE owner_kind = 'environment' AND owner_id = ?1`,
      )
      .all(environmentId) as Array<{ id: string }>;
    return rows.map((row) => row.id).filter((id) => this.ledger.worktree(id) !== null);
  }

  /** One checkout can serve several environments; their rows keep it alive. */
  worktreeUsedElsewhere(worktreeId: string, environmentId: string): boolean {
    return (
      this.db
        .query(
          `SELECT 1 FROM change_turn_boundaries WHERE worktree_id = ?1 AND environment_id != ?2
           UNION ALL SELECT 1 FROM change_thread_segments WHERE worktree_id = ?1 AND environment_id != ?2
           UNION ALL SELECT 1 FROM change_bindings WHERE worktree_id = ?1 AND environment_id != ?2
           UNION ALL SELECT 1 FROM change_measurements WHERE owner_kind = 'environment' AND worktree_id = ?1 AND owner_id != ?2
           LIMIT 1`,
        )
        .get(worktreeId, environmentId) !== null
    );
  }

  requestPurge(purge: EnvironmentPurge): void {
    this.ledger.transaction(() => {
      const key = `${PURGE_PREFIX}${purge.environmentId}`;
      const stored = this.ledger.meta(key);
      const previous = stored
        ? (JSON.parse(stored) as Omit<EnvironmentPurge, "environmentId">)
        : null;
      this.ledger.setMeta(
        key,
        JSON.stringify({
          requestedAt: previous?.requestedAt ?? purge.requestedAt,
          worktreeIds: Array.from(
            new Set([...(previous?.worktreeIds ?? []), ...purge.worktreeIds]),
          ),
          sourceKeys: Array.from(new Set([...(previous?.sourceKeys ?? []), ...purge.sourceKeys])),
        }),
      );
    });
  }

  pendingPurges(): EnvironmentPurge[] {
    const rows = this.metaUnder(PURGE_PREFIX);
    return rows.map((row) => ({
      environmentId: row.key.slice(PURGE_PREFIX.length),
      ...(JSON.parse(row.value) as Omit<EnvironmentPurge, "environmentId">),
    }));
  }

  private purgeSourceGaps(environmentId: string, budget: Budget): boolean {
    const stored = this.ledger.meta(`${PURGE_PREFIX}${environmentId}`);
    if (!stored) return true;
    const purge = JSON.parse(stored) as Omit<EnvironmentPurge, "environmentId">;
    for (const sourceKey of purge.sourceKeys) {
      if (!this.drain("change_evidence_gaps", "binding_id = ?", [sourceKey], budget)) return false;
    }
    return true;
  }

  private metaUnder(prefix: string, limit = 4_096) {
    const [from, to] = under(prefix);
    return this.db
      .query("SELECT key, value FROM change_ledger_meta WHERE key >= ? AND key < ? LIMIT ?")
      .all(from, to, limit) as Array<{ key: string; value: string }>;
  }

  /** Removes one batch of an environment's rows, in one transaction. */
  purgeEnvironmentBatch(
    environmentId: string,
    rows: number,
    nowIso = new Date().toISOString(),
  ): RetirementBatch {
    return this.ledger.transaction(() => {
      if (this.environmentHeld(environmentId, nowIso)) return { rows: 0, done: false, held: true };
      const budget: Budget = { left: rows };
      const done =
        this.purgeSourceGaps(environmentId, budget) &&
        this.purgeBindings(environmentId, budget) &&
        this.purgeTurns(environmentId, budget) &&
        this.purgeSegments(environmentId, budget) &&
        this.purgeEnvironmentOwners(environmentId, budget);
      return { rows: rows - budget.left, done };
    });
  }

  private purgeBindings(environmentId: string, budget: Budget): boolean {
    const bindings = this.db
      .query("SELECT id FROM change_bindings WHERE environment_id = ?")
      .all(environmentId) as Array<{ id: string }>;
    for (const { id } of bindings) {
      if (!this.retireBinding(id, budget)) return false;
      if (!this.drain("change_bindings", "id = ?", [id], budget)) return false;
    }
    return true;
  }

  private retireBinding(bindingId: string, budget: Budget): boolean {
    const ownedOperations = this.db.query(
      "SELECT operation_id AS id FROM change_operations WHERE binding_id = ? LIMIT ?",
    );
    while (budget.left > 0) {
      const operations = ownedOperations.all(bindingId, OWNERS_PER_QUERY) as Array<{ id: string }>;
      if (operations.length === 0) break;
      for (const { id } of operations) if (!this.retireOperation(id, budget)) return false;
    }
    if (budget.left <= 0) return false;
    // A provider turn's id is a digest, so only its evidence's frames lead to it.
    // Named, because without statistics the planner would read every provider
    // turn's rows through the owner index instead.
    this.ensureIndexes();
    const [from, to] = this.frameRange(bindingId);
    const providerTurns = this.db.query(
      `SELECT DISTINCT owner_id AS id FROM change_evidence INDEXED BY change_evidence_provider_turn_frames
       WHERE owner_kind = 'provider-turn' AND frame_key >= ? AND frame_key < ? LIMIT ?`,
    );
    while (budget.left > 0) {
      const turns = providerTurns.all(from, to, OWNERS_PER_QUERY) as Array<{ id: string }>;
      if (turns.length === 0) break;
      for (const { id } of turns) if (!this.retireProviderTurn(id, budget)) return false;
    }
    if (budget.left <= 0) return false;
    this.spend(
      budget,
      this.db
        .query(
          `DELETE FROM change_frames WHERE rowid IN (
             SELECT rowid FROM change_frames WHERE frame_key >= ? AND frame_key < ? LIMIT ?
           )`,
        )
        .run(from, to, budget.left).changes,
    );
    if (budget.left <= 0) return false;
    return this.drain("change_evidence_gaps", "binding_id = ?", [bindingId], budget);
  }

  /** Frame keys are `<binding id>\0<frame id>`. */
  private frameRange(bindingId: string): [string, string] {
    return [`${bindingId}\0`, `${bindingId}\u0001`];
  }

  private purgeTurns(environmentId: string, budget: Budget): boolean {
    const owned = this.db.query(
      "SELECT turn_id AS id FROM change_turn_boundaries WHERE environment_id = ? LIMIT ?",
    );
    while (budget.left > 0) {
      const turns = owned.all(environmentId, OWNERS_PER_QUERY) as Array<{ id: string }>;
      if (turns.length === 0) return true;
      for (const { id } of turns) {
        if (!this.retireTurn(id, budget)) return false;
        if (!this.drain("change_turn_boundaries", "turn_id = ?", [id], budget)) return false;
      }
    }
    return false;
  }

  private purgeSegments(environmentId: string, budget: Budget): boolean {
    const owned = this.db.query(
      "SELECT segment_id AS id FROM change_thread_segments WHERE environment_id = ? LIMIT ?",
    );
    while (budget.left > 0) {
      const segments = owned.all(environmentId, OWNERS_PER_QUERY) as Array<{ id: string }>;
      if (segments.length === 0) return true;
      for (const { id } of segments) if (!this.retireSegment(id, budget)) return false;
    }
    return false;
  }

  /** The environment-net, Git scope and live-detail owners, then its keyed metadata. */
  private purgeEnvironmentOwners(environmentId: string, budget: Budget): boolean {
    const netKey = environmentChangeResourceKey(environmentId);
    if (!this.retireOwner("environment", environmentId, [netKey], budget)) return false;
    const encoded = encodeURIComponent(environmentId);
    for (const scope of GIT_SCOPES) {
      const live = gitScopeResourceKey(scope, environmentId);
      // A pinned commit's key is `<scope>/environment/<environment>@<commit>/pinned`.
      const [from, to] = under(`${scope}/environment/${encoded}%40`);
      const owners = this.db
        .query(
          `SELECT DISTINCT owner_id AS id FROM change_measurements
           WHERE owner_kind = ?1 AND (owner_id = ?2 OR (owner_id >= ?3 AND owner_id < ?4))`,
        )
        .all(`git-${scope}`, live, from, to) as Array<{ id: string }>;
      for (const { id } of owners)
        if (!this.retireOwner(`git-${scope}`, id, [id], budget)) return false;
      if (
        !this.drain(
          "change_selections",
          "selection_key = ? OR (selection_key >= ? AND selection_key < ?)",
          [live, from, to],
          budget,
        )
      )
        return false;
    }
    const [fileFrom, fileTo] = under(`${environmentId}:`);
    const files = this.db
      .query(
        `SELECT DISTINCT owner_id AS id FROM change_measurements
         WHERE owner_kind = 'environment-file' AND owner_id >= ? AND owner_id < ?`,
      )
      .all(fileFrom, fileTo) as Array<{ id: string }>;
    for (const { id } of files)
      if (!this.retireOwner("environment-file", id, [], budget)) return false;
    if (budget.left <= 0) return false;
    for (const prefix of [`conv:${environmentId}\0`, `fork:${environmentId}\0`]) {
      const [from, to] = under(prefix);
      if (!this.drain("change_ledger_meta", "key >= ? AND key < ?", [from, to], budget))
        return false;
    }
    return budget.left > 0;
  }

  /**
   * Legacy summaries have no operation row or binding: only the made-up worktree
   * id of their measurement names the environment. Their import markers say
   * whether there are any, so most purges never walk the table for them.
   */
  hasLegacySummaries(environmentId: string): boolean {
    return this.metaUnder(legacyMarkerPrefix(environmentId), 1).length > 0;
  }

  /** One page of the walk for legacy summaries; where the next starts, null at the end. */
  retireLegacySummariesPage(environmentId: string, afterRowid: number): number | null {
    return this.ledger.transaction(() => {
      const rows = this.db
        .query(
          `SELECT rowid AS row, owner_kind, owner_id, worktree_id FROM change_measurements
           WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        )
        .all(afterRowid, WALK_PAGE_ROWS) as Array<{
        row: number;
        owner_kind: string;
        owner_id: string;
        worktree_id: string;
      }>;
      const budget: Budget = { left: WALK_PAGE_ROWS };
      for (const row of rows) {
        if (row.worktree_id !== `legacy:${environmentId}`) continue;
        if (!this.retireOwner(row.owner_kind, row.owner_id, operationKeys(row.owner_id), budget))
          return row.row - 1;
      }
      if (rows.length === WALK_PAGE_ROWS) return rows.at(-1)!.row;
      const [from, to] = under(legacyMarkerPrefix(environmentId));
      return this.drain("change_ledger_meta", "key >= ? AND key < ?", [from, to], budget)
        ? null
        : afterRowid;
    });
  }

  /**
   * A purge's end: what only its environment used, and its entry. A worktree row
   * something still names stays, tombstoned; it holds no content.
   */
  finishPurge(purge: EnvironmentPurge): void {
    this.ledger.transaction(() => {
      for (const worktreeId of purge.worktreeIds) {
        this.db.query("DELETE FROM change_capture_attempts WHERE worktree_id = ?").run(worktreeId);
        this.db
          .query(
            `DELETE FROM change_worktrees WHERE id = ?1 AND tombstoned_at IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM change_snapshots WHERE worktree_id = ?1)
               AND NOT EXISTS (SELECT 1 FROM change_turn_boundaries WHERE worktree_id = ?1)
               AND NOT EXISTS (SELECT 1 FROM change_thread_segments WHERE worktree_id = ?1)`,
          )
          .run(worktreeId);
      }
      for (const sourceKey of purge.sourceKeys) {
        this.db.query("DELETE FROM change_evidence_cursors WHERE source_key = ?").run(sourceKey);
        this.db.query("DELETE FROM change_ledger_meta WHERE key = ?").run(pendingAckKey(sourceKey));
      }
      const prefix = `evidence-source:${encodeURIComponent(purge.environmentId)}:`;
      this.db
        .query("DELETE FROM change_ledger_meta WHERE key >= ? AND key < ?")
        .run(prefix, `${prefix}￿`);
      // Delivered announcements of what just went; the table has no key index.
      this.db
        .query(
          `DELETE FROM change_outbox WHERE measurement_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM change_measurements m WHERE m.id = change_outbox.measurement_id
           )`,
        )
        .run();
      this.db
        .query("DELETE FROM change_ledger_meta WHERE key = ?")
        .run(`${PURGE_PREFIX}${purge.environmentId}`);
    });
  }

  // -------------------------------------------------------------------------
  // Age-based retention
  // -------------------------------------------------------------------------

  /**
   * Oldest frames past the window. Rows are in age order by row id, so the walk
   * reads only what it deletes plus one page. Records the newest sequence it
   * passed, which says how old an operation is (its rows have no time of their own).
   */
  retireExpiredFrames(cutoffIso: string, rows: number): RetirementBatch {
    return this.ledger.transaction(() => {
      const oldest = this.db
        .query(
          "SELECT rowid AS row, ingested_seq AS seq, received_at AS at FROM change_frames ORDER BY rowid LIMIT ?",
        )
        .all(rows) as Array<{ row: number; seq: number; at: string }>;
      const remove = this.db.query("DELETE FROM change_frames WHERE rowid = ?");
      let expiredSequence = this.expiredSequence();
      let removed = 0;
      for (const frame of oldest) {
        if (frame.at >= cutoffIso) return this.frameBatch(removed, true, expiredSequence);
        remove.run(frame.row);
        removed++;
        expiredSequence = Math.max(expiredSequence, frame.seq);
      }
      return this.frameBatch(removed, oldest.length < rows, expiredSequence);
    });
  }

  private frameBatch(rows: number, done: boolean, expiredSequence: number): RetirementBatch {
    if (rows > 0) this.ledger.setMeta(EXPIRED_SEQUENCE_KEY, String(expiredSequence));
    return { rows, done };
  }

  private expiredSequence(): number {
    return Number(this.ledger.meta(EXPIRED_SEQUENCE_KEY) ?? 0);
  }

  /**
   * Finished turns past the window lose everything but their boundary row, which
   * keeps ordinals and the thread's history list intact. The cursor is durable,
   * so a pass never walks retired boundaries again. A turn a restore still holds
   * ends the walk until the next pass, so nothing behind the cursor is ever kept.
   */
  retireExpiredTurns(
    cutoffIso: string,
    nowIso: string,
    rows: number,
  ): RetirementBatch & { released: number } {
    return this.ledger.transaction(() => {
      const budget: Budget = { left: rows };
      const held = this.heldOwners(nowIso);
      const [age, id] = this.turnCursor();
      const turns = this.db
        .query(
          `SELECT turn_id, lifecycle, ${TURN_AGE} AS age FROM change_turn_boundaries
           WHERE (${TURN_AGE}, turn_id) > (?1, ?2) AND ${TURN_AGE} < ?3
           ORDER BY ${TURN_AGE}, turn_id LIMIT ?4`,
        )
        .all(age, id, cutoffIso, OWNERS_PER_QUERY) as Array<{
        turn_id: string;
        lifecycle: string;
        age: string;
      }>;
      let released = 0;
      let cursor: [string, string] | null = null;
      let done = turns.length < OWNERS_PER_QUERY;
      for (const turn of turns) {
        // An active turn gets a newer age when it ends, ahead of the cursor.
        if (TERMINAL_TURN_LIFECYCLES.has(turn.lifecycle)) {
          if (held.has(`turn\0${turn.turn_id}`)) {
            done = true;
            break;
          }
          if (
            this.ledger.db
              .query("SELECT 1 FROM change_references WHERE owner_kind = 'turn' AND owner_id = ?")
              .get(turn.turn_id)
          )
            released++;
          if (!this.retireTurn(turn.turn_id, budget)) {
            done = false;
            break;
          }
        }
        cursor = [turn.age, turn.turn_id];
        if (budget.left <= 0) {
          done = false;
          break;
        }
      }
      if (cursor) this.ledger.setMeta(TURN_RETENTION_CURSOR_KEY, JSON.stringify(cursor));
      return { rows: rows - budget.left, done, released };
    });
  }

  private turnCursor(): [string, string] {
    const stored = this.ledger.meta(TURN_RETENTION_CURSOR_KEY);
    return stored ? (JSON.parse(stored) as [string, string]) : ["", ""];
  }

  /**
   * Quota pressure: releases the oldest finished turns' endpoints, keeping their
   * rows. Starts at the cursor, since nothing behind it has endpoints left.
   */
  releaseOldestTurnEndpoints(limit: number, after: readonly [string, string] | null) {
    return this.ledger.transaction(() => {
      const [age, id] = after ?? this.turnCursor();
      const turns = this.db
        .query(
          `SELECT t.turn_id, ${TURN_AGE} AS age FROM change_turn_boundaries t
           WHERE (${TURN_AGE}, t.turn_id) > (?1, ?2)
             AND +t.lifecycle IN (${turnLifecycleSqlList("terminal")})
             AND EXISTS (SELECT 1 FROM change_references r WHERE r.owner_kind = 'turn' AND r.owner_id = t.turn_id)
           ORDER BY ${TURN_AGE}, t.turn_id LIMIT ?3`,
        )
        .all(age, id, limit) as Array<{ turn_id: string; age: string }>;
      for (const turn of turns) this.ledger.removeReferences("turn", turn.turn_id);
      const last = turns.at(-1);
      return { released: turns.length, next: last ? ([last.age, last.turn_id] as const) : null };
    });
  }

  /**
   * One page of operations with no frame in the window, oldest first. An
   * operation stays while the turn it belongs to is retained, and while a restore
   * holds its measurement. Rows are in first-seen order, so the walk ends at the
   * first operation first seen inside the window. Returns where to go on from.
   */
  retireExpiredOperations(
    cutoffIso: string,
    nowIso: string,
    afterRowid: number,
    rows: number,
  ): RetirementBatch & { next: number } {
    return this.ledger.transaction(() => {
      const budget: Budget = { left: rows };
      const expired = this.expiredSequence();
      const held = this.heldOwners(nowIso);
      const operations = this.db
        .query(
          `SELECT rowid AS row, operation_id AS id, first_seen_seq AS first, updated_seq AS updated
           FROM change_operations WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        )
        .all(afterRowid, OWNERS_PER_QUERY) as Array<{
        row: number;
        id: string;
        first: number;
        updated: number;
      }>;
      let next = afterRowid;
      let done = operations.length < OWNERS_PER_QUERY;
      for (const operation of operations) {
        if (operation.first > expired) {
          done = true;
          break;
        }
        if (
          operation.updated <= expired &&
          !held.has(`operation\0${operation.id}`) &&
          !this.operationTurnRetained(operation.id, cutoffIso) &&
          !this.retireOperation(operation.id, budget)
        ) {
          done = false;
          break;
        }
        next = operation.row;
        if (budget.left <= 0) {
          done = false;
          break;
        }
      }
      return { rows: rows - budget.left, done, next };
    });
  }

  private operationTurnRetained(operationId: string, cutoffIso: string): boolean {
    const turnId = this.ledger.meta(`opturn:${operationId}`);
    const turn = turnId ? this.ledger.turn(turnId) : null;
    if (!turn) return false;
    return (
      !TERMINAL_TURN_LIFECYCLES.has(turn.lifecycle) ||
      (turn.finished_at ?? turn.started_at) >= cutoffIso
    );
  }

  /**
   * One page of evidence, oldest first, retiring the provider turn diffs whose
   * newest evidence is past the window. Rows are in ingestion order by row id,
   * so the walk ends at the first row ingested inside the window, and a pass
   * with nothing expired reads one row. Returns where to go on from.
   *
   * Grouping every provider turn's evidence to find its newest row read the
   * whole table each pass: 3.3 s with a cold page cache at 130,000 rows
   * (to-do 0741 task 6).
   */
  retireExpiredProviderTurns(
    nowIso: string,
    afterRowid: number,
    rows: number,
  ): RetirementBatch & { next: number } {
    return this.ledger.transaction(() => {
      const budget: Budget = { left: rows };
      const expired = this.expiredSequence();
      // A quiet pass reads just the frontier row, rather than materializing
      // a whole page of evidence that is still inside the window.
      const first = this.db
        .query(
          "SELECT ingested_seq AS seq FROM change_evidence WHERE rowid > ? ORDER BY rowid LIMIT 1",
        )
        .get(afterRowid) as { seq: number } | null;
      if (!first || first.seq > expired) return { rows: 0, done: true, next: afterRowid };
      const held = this.heldOwners(nowIso);
      const page = this.db
        .query(
          `SELECT rowid AS row, owner_kind AS kind, owner_id AS id, ingested_seq AS seq
           FROM change_evidence WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        )
        .all(afterRowid, WALK_PAGE_ROWS) as Array<{
        row: number;
        kind: string;
        id: string;
        seq: number;
      }>;
      const newest = this.db.query(
        "SELECT MAX(ingested_seq) AS seq FROM change_evidence WHERE owner_kind = 'provider-turn' AND owner_id = ?",
      );
      const checked = new Set<string>();
      let next = afterRowid;
      let done = page.length < WALK_PAGE_ROWS;
      for (const row of page) {
        if (row.seq > expired) {
          done = true;
          break;
        }
        if (row.kind === "provider-turn" && !checked.has(row.id)) {
          checked.add(row.id);
          const latest = (newest.get(row.id) as { seq: number | null }).seq;
          if (
            latest !== null &&
            latest <= expired &&
            !held.has(`provider-turn\0${row.id}`) &&
            !this.retireProviderTurn(row.id, budget)
          ) {
            done = false;
            break;
          }
        }
        next = row.row;
        if (budget.left <= 0) {
          done = false;
          break;
        }
      }
      return { rows: rows - budget.left, done, next };
    });
  }

  /**
   * Closed segments none of whose turns is retained go with their baseline pin.
   * An open segment stays whatever its age: its thread can take another turn, and
   * thread-net would lose its baseline. Purging the environment removes it.
   */
  retireExpiredSegments(cutoffIso: string, nowIso: string, rows: number): RetirementBatch {
    return this.ledger.transaction(() => {
      const budget: Budget = { left: rows };
      const held = this.heldOwners(nowIso);
      const segments = this.db
        .query(
          `SELECT s.segment_id AS id FROM change_thread_segments s
           WHERE s.closed_at IS NOT NULL AND s.closed_at < ?1 AND NOT EXISTS (
             SELECT 1 FROM change_turn_boundaries t
             WHERE t.thread_id = s.thread_id AND t.segment_id = s.segment_id
               AND (t.lifecycle IN (${turnLifecycleSqlList("active")}) OR COALESCE(t.finished_at, t.started_at) >= ?1)
           ) LIMIT ?2`,
        )
        .all(cutoffIso, OWNERS_PER_QUERY) as Array<{ id: string }>;
      const free = segments.filter(({ id }) => !held.has(`segment\0${id}`));
      for (const { id } of free) if (!this.retireSegment(id, budget)) break;
      return { rows: rows - budget.left, done: free.length === 0 };
    });
  }

  /** Records nothing else names: gaps, capture attempts, restore records, cursors, bindings. */
  retireExpiredRecords(cutoffIso: string, rows: number): RetirementBatch {
    return this.ledger.transaction(() => {
      let removed = this.db
        .query(
          `DELETE FROM change_evidence_gaps WHERE rowid IN (
             SELECT rowid FROM change_evidence_gaps WHERE recorded_at < ? LIMIT ?
           )`,
        )
        .run(cutoffIso, rows).changes;
      removed += this.retireExpiredAttempts(cutoffIso, rows - removed);
      removed += this.db
        .query(
          `DELETE FROM change_restore_tokens WHERE rowid IN (
             SELECT rowid FROM change_restore_tokens t WHERE t.expires_at < ?1 AND NOT EXISTS (
               SELECT 1 FROM change_restore_operations o WHERE o.token = t.token AND o.state = 'applying'
             ) LIMIT ?2
           )`,
        )
        .run(cutoffIso, rows - removed).changes;
      const budget = { left: rows - removed };
      this.retireRestores("updated_at < ? AND state != 'applying'", [cutoffIso], budget);
      removed = rows - budget.left;
      removed += this.retireExpiredCursors(cutoffIso, rows - removed);
      removed += this.retireEmptyBindings(cutoffIso, rows - removed);
      return { rows: removed, done: removed === 0 };
    });
  }

  private retireExpiredAttempts(cutoffIso: string, rows: number): number {
    const oldest = this.db
      .query(
        "SELECT rowid AS row, status, updated_at AS at FROM change_capture_attempts ORDER BY rowid LIMIT ?",
      )
      .all(rows) as Array<{ row: number; status: string; at: string }>;
    const remove = this.db.query("DELETE FROM change_capture_attempts WHERE rowid = ?");
    let removed = 0;
    for (const attempt of oldest) {
      if (attempt.at >= cutoffIso) break;
      if (attempt.status !== "reserved") removed += remove.run(attempt.row).changes;
    }
    return removed;
  }

  /** A source that has not delivered for the whole window; an unsent acknowledgment keeps it. */
  private retireExpiredCursors(cutoffIso: string, rows: number): number {
    const cursors = this.db
      .query("SELECT source_key AS key FROM change_evidence_cursors WHERE updated_at < ? LIMIT ?")
      .all(cutoffIso, rows) as Array<{ key: string }>;
    let removed = 0;
    for (const { key } of cursors) {
      if (this.ledger.meta(pendingAckKey(key))) continue;
      this.db.query("DELETE FROM change_ledger_meta WHERE key = ?").run(pendingAckKey(key));
      removed += this.db
        .query("DELETE FROM change_evidence_cursors WHERE source_key = ?")
        .run(key).changes;
    }
    return removed;
  }

  /** A binding is resolved again by its source key if its conversation ever comes back. */
  private retireEmptyBindings(cutoffIso: string, rows: number): number {
    const bindings = this.db
      .query(
        `SELECT b.id FROM change_bindings b WHERE b.created_at < ?
           AND NOT EXISTS (SELECT 1 FROM change_operations o WHERE o.binding_id = b.id)
           AND NOT EXISTS (SELECT 1 FROM change_evidence_gaps g WHERE g.binding_id = b.id)
         LIMIT ?`,
      )
      .all(cutoffIso, rows) as Array<{ id: string }>;
    let removed = 0;
    for (const { id } of bindings) {
      const [from, to] = this.frameRange(id);
      const framed = this.db
        .query("SELECT 1 FROM change_frames WHERE frame_key >= ? AND frame_key < ? LIMIT 1")
        .get(from, to);
      if (framed) continue;
      removed += this.db.query("DELETE FROM change_bindings WHERE id = ?").run(id).changes;
    }
    return removed;
  }

  // -------------------------------------------------------------------------
  // Evidence body reachability
  // -------------------------------------------------------------------------

  /** Bodies one page of evidence names; where the next page starts, null at the end. */
  evidenceBodiesPage(afterRowid: number): { ids: string[]; next: number | null } {
    const rows = this.db
      .query(
        `SELECT rowid AS row,
           json_extract(evidence_json, '$.evidence.body.id') AS patch,
           json_extract(evidence_json, '$.evidence.before.body.id') AS before,
           json_extract(evidence_json, '$.evidence.after.body.id') AS after,
           json_extract(evidence_json, '$.appendOf.targetBodyId') AS target
         FROM change_evidence WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      )
      .all(afterRowid, WALK_PAGE_ROWS) as Array<{
      row: number;
      patch: string | null;
      before: string | null;
      after: string | null;
      target: string | null;
    }>;
    const ids: string[] = [];
    for (const row of rows) {
      for (const id of [row.patch, row.before, row.after, row.target]) if (id) ids.push(id);
    }
    return { ids, next: rows.length < WALK_PAGE_ROWS ? null : rows.at(-1)!.row };
  }

  /** Bodies one page of append chunks names; where the next page starts, null at the end. */
  chunkBodiesPage(afterRowid: number): { ids: string[]; next: number | null } {
    const rows = this.db
      .query(
        `SELECT rowid AS row, body_id AS body, target_body_id AS target
         FROM change_evidence_chunks WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      )
      .all(afterRowid, WALK_PAGE_ROWS) as Array<{ row: number; body: string; target: string }>;
    return {
      ids: rows.flatMap((row) => [row.body, row.target]),
      next: rows.length < WALK_PAGE_ROWS ? null : rows.at(-1)!.row,
    };
  }

  forgetBody(bodyId: string): void {
    this.ledger.transaction(() =>
      this.db.query("DELETE FROM change_evidence_bodies WHERE body_id = ?").run(bodyId),
    );
  }

  /**
   * Records of bodies that were never stored have no file for the sweep to find;
   * one page of them goes once nothing names them. Where the next page starts,
   * null at the end.
   */
  retireUnstoredBodiesPage(
    reachable: ReadonlySet<string>,
    olderThanIso: string,
    afterRowid: number,
  ): number | null {
    return this.ledger.transaction(() => {
      const rows = this.db
        .query(
          `SELECT rowid AS row, body_id AS id, state, created_at AS at
           FROM change_evidence_bodies WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        )
        .all(afterRowid, WALK_PAGE_ROWS) as Array<{
        row: number;
        id: string;
        state: string;
        at: string;
      }>;
      const remove = this.db.query("DELETE FROM change_evidence_bodies WHERE rowid = ?");
      for (const row of rows) {
        if (row.state !== "available" && row.at < olderThanIso && !reachable.has(row.id))
          remove.run(row.row);
      }
      return rows.length < WALK_PAGE_ROWS ? null : rows.at(-1)!.row;
    });
  }

  // -------------------------------------------------------------------------
  // One owner's rows. Each returns false when the budget stopped it early.
  // -------------------------------------------------------------------------

  private spend(budget: Budget, rows: number): void {
    budget.left -= rows;
  }

  /** Delete at most the remaining budget, keeping the parent discoverable on exhaustion. */
  private drain(table: string, predicate: string, params: string[], budget: Budget): boolean {
    if (budget.left <= 0) return false;
    this.spend(
      budget,
      this.db
        .query(
          `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${predicate} LIMIT ?)`,
        )
        .run(...params, budget.left).changes,
    );
    return !this.db.query(`SELECT 1 FROM ${table} WHERE ${predicate} LIMIT 1`).get(...params);
  }

  private retireRestores(predicate: string, params: string[], budget: Budget): boolean {
    const operations = this.db
      .query(`SELECT id FROM change_restore_operations WHERE ${predicate} LIMIT ?`)
      .all(...params, budget.left) as Array<{ id: string }>;
    for (const { id } of operations) {
      if (!this.drain("change_references", "owner_kind = 'restore' AND owner_id = ?", [id], budget))
        return false;
      if (!this.drain("change_restore_operations", "id = ?", [id], budget)) return false;
    }
    return !this.db
      .query(`SELECT 1 FROM change_restore_operations WHERE ${predicate} LIMIT 1`)
      .get(...params);
  }

  private retireOperation(operationId: string, budget: Budget): boolean {
    if (!this.retireOwner("operation", operationId, operationKeys(operationId), budget))
      return false;
    if (!this.retireEvidence("operation", operationId, budget)) return false;
    if (!this.retireEvidence("observation", operationId, budget)) return false;
    if (!this.drain("change_tool_windows", "operation_id = ?", [operationId], budget)) return false;
    if (!this.drain("change_ledger_meta", "key = ?", [`opturn:${operationId}`], budget))
      return false;
    if (!this.drain("change_operations", "operation_id = ?", [operationId], budget)) return false;
    return true;
  }

  private retireProviderTurn(providerTurnId: string, budget: Budget): boolean {
    const key = turnResourceKeys(providerTurnId, providerTurnId).providerTurnDiff!;
    if (!this.retireOwner("provider-turn", providerTurnId, [key], budget)) return false;
    return this.retireEvidence("provider-turn", providerTurnId, budget);
  }

  /** Everything a turn owns; its boundary row is the caller's choice. */
  private retireTurn(turnId: string, budget: Budget): boolean {
    if (!this.drain("change_references", "owner_kind = 'turn' AND owner_id = ?", [turnId], budget))
      return false;
    const keys = [turnResourceKeys(turnId, null).turnNet, operationVolumeResourceKey(turnId)];
    if (!this.retireOwner("turn", turnId, keys, budget)) return false;
    for (const boundary of ["turn-start", "turn-end", "turn-settle"])
      if (
        !this.drain(
          "change_capture_attempts",
          "boundary_key = ?",
          [`${boundary}:${turnId}`],
          budget,
        )
      )
        return false;
    // Retried starts and background end recoveries reserve one key per attempt.
    for (const prefix of [`turn-start:${turnId}:`, `turn-recover:${turnId}:`]) {
      const [from, to] = under(prefix);
      if (
        !this.drain(
          "change_capture_attempts",
          "boundary_key >= ? AND boundary_key < ?",
          [from, to],
          budget,
        )
      )
        return false;
    }
    for (const key of [`turnops:${turnId}`, `pturn:${turnId}`])
      if (!this.drain("change_ledger_meta", "key = ?", [key], budget)) return false;
    return true;
  }

  private retireSegment(segmentId: string, budget: Budget): boolean {
    if (
      !this.drain(
        "change_references",
        "owner_kind IN ('segment', 'segment-live') AND owner_id = ?",
        [segmentId],
        budget,
      )
    )
      return false;
    const keys = [threadResourceKey(segmentId), operationVolumeResourceKey(segmentId, "segment")];
    if (!this.retireOwner("segment", segmentId, keys, budget)) return false;
    if (!this.drain("change_thread_segments", "segment_id = ?", [segmentId], budget)) return false;
    return true;
  }

  private retireEvidence(ownerKind: string, ownerId: string, budget: Budget): boolean {
    const revisions = this.db
      .query(
        "SELECT DISTINCT evidence_id AS id FROM change_evidence WHERE owner_kind = ? AND owner_id = ?",
      )
      .all(ownerKind, ownerId) as Array<{ id: string }>;
    for (const { id } of revisions) {
      if (budget.left <= 0) return false;
      if (!this.drain("change_evidence_chunks", "evidence_id = ?", [id], budget)) return false;
      if (!this.drain("change_evidence", "evidence_id = ?", [id], budget)) return false;
    }
    return true;
  }

  /**
   * An owner's selections, then its measurements. Selections and identities go
   * first, so nothing starts reading a measurement whose file rows are draining.
   */
  private retireOwner(
    ownerKind: string,
    ownerId: string,
    selectionKeys: readonly string[],
    budget: Budget,
  ): boolean {
    for (const key of selectionKeys)
      if (!this.drain("change_selections", "selection_key = ?", [key], budget)) return false;
    const measurements = this.db
      .query("SELECT id FROM change_measurements WHERE owner_kind = ? AND owner_id = ?")
      .all(ownerKind, ownerId) as Array<{ id: string }>;
    for (const { id } of measurements) {
      if (budget.left <= 0) return false;
      if (!this.drain("change_diff_identities", "measurement_id = ?", [id], budget)) return false;
      if (!this.drain("change_restore_tokens", "measurement_id = ?", [id], budget)) return false;
      if (!this.retireRestores("measurement_id = ?", [id], budget)) return false;
      if (!this.drain("change_measurement_files", "measurement_id = ?", [id], budget)) return false;
      if (!this.drain("change_measurements", "id = ?", [id], budget)) return false;
    }
    return true;
  }
}

const operationKeys = (operationId: string): string[] =>
  Object.values(toolResourceKeys(operationId));

const legacyMarkerPrefix = (environmentId: string) =>
  `legacy-import:opencode:file:${environmentId}:`;

/** The acknowledgment `ChangeTrackingService.pullNow` owes a source. */
const pendingAckKey = (sourceKey: string) => `pending-evidence-ack:${sourceKey}`;
