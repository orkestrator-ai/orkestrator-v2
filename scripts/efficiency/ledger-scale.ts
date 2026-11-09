/**
 * Change-tracking ledger at production scale (to-do 0741 task 6).
 *
 *   mise exec -- bun scripts/efficiency/ledger-scale.ts [--scale 1] [--agents 8]
 *     [--seconds 20] [--pace-ms 20] [--manifest-entries 100000] [--window-days 7]
 *     [--only ingest,queries,retention,manifest,mixed,window] [--disk-writers 0]
 *     [--dir <path>] [--keep] [--out <file.json>]
 *
 * Builds a synthetic `change-tracking.sqlite` in a throwaway data directory
 * (2.8M rows and 1.28 GB at `--scale 1`, the shape of arktech-mini's
 * ledger on 2026-11-06), then runs the real `ChangeTrackingService` on it and
 * records the longest event-loop stall of each ledger operation:
 *
 * - `ingest`: `--agents` agent loops, each pulling tool, turn and turn-diff
 *   evidence through `pullEvidence` and publishing environment scans, paced
 *   `--pace-ms` apart.
 * - `queries`: projection reads (views, tool presentations, history) and the
 *   ledger's measurement reads (latest measurement, file pages and counts).
 * - `retention`: one hourly pass (`ChangeRetentionService.run`) with the
 *   default 30-day window, while three synthetic environments are purged.
 * - `manifest`: storing and cold-reading a capture manifest of
 *   `--manifest-entries` entries, and parsing measurement JSON.
 * - `mixed`: ingestion, queries and back-to-back retention passes at once.
 * - `window`: passes with a `--window-days` archive window, which retire
 *   the rows past it: what a shorter retention bound would cost on its
 *   first pass.
 *
 * `--disk-writers N` adds N child processes that write and fsync 4 MiB blocks
 * in a loop (at most 256 MiB each, in the data directory) for the whole run:
 * the disk contention of builds, Docker and other test suites on the same
 * host, which slows ledger I/O, including checkpoints that still sync with
 * `synchronous = NORMAL` (ledger commits no longer sync individually).
 *
 * A stall is the lateness of a 2 ms timer chain, as in
 * `apps/backend/scripts/storage-maintenance-stall.ts`. Every statement the
 * ledger runs and every transaction it commits is timed: `bun:sqlite` is
 * synchronous, so each figure is time the event loop could not run. At the
 * end, every distinct statement seen is put through `EXPLAIN QUERY PLAN`, and
 * any that scans a large table is listed.
 *
 * Nothing outside the temporary directory is read or written but the report
 * (`--dir` reuses a ledger built earlier; `--keep` leaves the directory). No provider is
 * called and no port is bound.
 */

import { Database, Statement } from "bun:sqlite";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { environmentChangeResourceKey } from "../../packages/protocol/src/change-resources";
import { ChangeEvidenceRecorder } from "../../packages/protocol/src/node/change-tracking/evidence-builders";
import { ChangeEvidenceSpool } from "../../packages/protocol/src/node/change-tracking/evidence-spool";
import { encodePath, readManifest } from "../../apps/backend/src/core/change-tracking/capture";
import {
  GIT_SCOPES,
  gitScopeResourceKey,
} from "../../apps/backend/src/core/change-tracking/git-scopes";
import {
  CHANGE_LEDGER_DATABASE_FILE,
  CHANGE_LEDGER_TABLES,
  openChangeLedgerDatabase,
} from "../../apps/backend/src/core/change-tracking/ledger-schema";
import {
  ChangeTrackingService,
  type EvidenceSource,
} from "../../apps/backend/src/core/change-tracking/service";
import { StorageDatabase } from "../../apps/backend/src/core/storage-database";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
function numberArgument(name: string, fallback: number): number {
  const value = argument(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} needs a number`);
  return parsed;
}

const SCALE = numberArgument("--scale", 1);
const AGENTS = numberArgument("--agents", 8);
const SECONDS = numberArgument("--seconds", 20);
const PACE_MS = numberArgument("--pace-ms", 20);
const MANIFEST_ENTRIES = numberArgument("--manifest-entries", 100_000);
const WINDOW_DAYS = numberArgument("--window-days", 7);
const ONLY = new Set(
  (argument("--only") ?? "ingest,queries,retention,manifest,mixed,window").split(","),
);
const KEEP = process.argv.includes("--keep");
const REUSE_DIR = argument("--dir");
const OUT = argument("--out");
const DISK_WRITERS = numberArgument("--disk-writers", 0);

const DAY_MS = 86_400_000;
/** The synthetic history spans this many days before now, like mini's two weeks. */
const HISTORY_DAYS = 14;
const PROBE_INTERVAL_MS = 2;
/** Tables large enough that a scan of one is a stall risk at this scale. */
const LARGE_TABLES = new Set([
  "change_measurement_files",
  "change_measurements",
  "change_frames",
  "change_evidence",
  "change_evidence_bodies",
  "change_operations",
  "change_tool_windows",
  "change_diff_identities",
  "change_selections",
  "change_ledger_meta",
]);

// ---------------------------------------------------------------------------
// Event-loop stall probe
// ---------------------------------------------------------------------------

interface StallSummary {
  maxStallMs: number;
  over100Ms: number;
  over1s: number;
  ticks: number;
}

class StallProbe {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private expected = 0;
  private current: StallSummary = { maxStallMs: 0, over100Ms: 0, over1s: 0, ticks: 0 };

  start(): void {
    this.expected = performance.now() + PROBE_INTERVAL_MS;
    const tick = () => {
      const now = performance.now();
      const late = now - this.expected;
      this.current.ticks++;
      if (late > this.current.maxStallMs) this.current.maxStallMs = late;
      if (late >= 100) this.current.over100Ms++;
      if (late >= 1000) this.current.over1s++;
      this.expected = now + PROBE_INTERVAL_MS;
      this.timer = setTimeout(tick, PROBE_INTERVAL_MS);
    };
    this.timer = setTimeout(tick, PROBE_INTERVAL_MS);
  }

  /** The figures since the last call, then starts a new window. */
  take(): StallSummary {
    const taken = this.current;
    this.current = { maxStallMs: 0, over100Ms: 0, over1s: 0, ticks: 0 };
    return { ...taken, maxStallMs: Math.round(taken.maxStallMs) };
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}

// ---------------------------------------------------------------------------
// Statement and transaction profiler
// ---------------------------------------------------------------------------

interface Timing {
  calls: number;
  totalMs: number;
  maxMs: number;
}

const statementTimings = new Map<string, Timing>();
const transactionTimings = new Map<string, Timing>();
const allStatements = new Map<string, number>();
let transactionDepth = 0;

function note(table: Map<string, Timing>, key: string, ms: number): void {
  const timing = table.get(key) ?? { calls: 0, totalMs: 0, maxMs: 0 };
  timing.calls++;
  timing.totalMs += ms;
  if (ms > timing.maxMs) timing.maxMs = ms;
  table.set(key, timing);
}

const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

/** The ledger method or service function that opened a transaction. */
function transactionCaller(): string {
  const frames = (new Error().stack ?? "").split("\n").slice(1);
  for (const frame of frames) {
    if (
      frame.includes("ledger-scale.ts") ||
      frame.includes("storage-database.ts") ||
      /ChangeLedger\.transaction|at transaction /.test(frame) ||
      frame.includes("bun:sqlite")
    )
      continue;
    const match = /at (?:async )?([\w.<>$]+) \((?:.*\/)?([\w.-]+\.ts):\d+/.exec(frame);
    if (match) return `${match[1]} (${match[2]})`;
  }
  return "unknown";
}

const wrapped = new WeakSet<object>();

/** Times every call of one statement. Bun keeps a statement's methods on the instance. */
function instrument(statement: Statement, sql: string): Statement {
  if (wrapped.has(statement)) return statement;
  wrapped.add(statement);
  const key = normalize(sql);
  const target = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ["run", "get", "all", "values"]) {
    const original = target[method]!.bind(statement);
    target[method] = (...args: unknown[]) => {
      const started = performance.now();
      try {
        return original(...args);
      } finally {
        note(statementTimings, key, performance.now() - started);
        allStatements.set(key, (allStatements.get(key) ?? 0) + 1);
      }
    };
  }
  return statement;
}

function installProfiler(): void {
  const query = Database.prototype.query;
  Database.prototype.query = function (this: Database, sql: string) {
    return instrument(query.call(this, sql) as Statement, sql);
  } as typeof query;
  const prepare = Database.prototype.prepare;
  Database.prototype.prepare = function (this: Database, sql: string, ...rest: unknown[]) {
    return instrument((prepare as (...args: unknown[]) => Statement).call(this, sql, ...rest), sql);
  } as typeof prepare;
  const exec = Database.prototype.exec;
  Database.prototype.exec = function (this: Database, sql: string, ...rest: unknown[]) {
    const started = performance.now();
    try {
      return (exec as (...args: unknown[]) => unknown).call(this, sql, ...rest);
    } finally {
      note(statementTimings, normalize(sql), performance.now() - started);
    }
  } as typeof exec;
  const transaction = StorageDatabase.prototype.transaction;
  StorageDatabase.prototype.transaction = function <T>(this: StorageDatabase, fn: () => T): T {
    if (transactionDepth > 0) return transaction.call(this, fn) as T;
    const caller = transactionCaller();
    transactionDepth++;
    const started = performance.now();
    try {
      return transaction.call(this, fn) as T;
    } finally {
      transactionDepth--;
      note(transactionTimings, caller, performance.now() - started);
    }
  };
}

function topTimings(table: Map<string, Timing>, count: number) {
  return Array.from(table, ([key, timing]) => ({
    key: key.length > 220 ? `${key.slice(0, 217)}...` : key,
    calls: timing.calls,
    maxMs: Math.round(timing.maxMs * 10) / 10,
    totalMs: Math.round(timing.totalMs),
  }))
    .toSorted((left, right) => right.maxMs - left.maxMs)
    .slice(0, count);
}

function resetTimings(): void {
  statementTimings.clear();
  transactionTimings.clear();
}

// ---------------------------------------------------------------------------
// Synthetic ledger
// ---------------------------------------------------------------------------

const hex = (value: string, length = 40) =>
  createHash("sha256").update(value).digest("hex").slice(0, length);
const uuid = (value: string) => {
  const h = hex(value, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

interface Shape {
  environments: number;
  bindingsPerEnvironment: number;
  turnsPerBinding: number;
  toolsPerTurn: number;
  turnDiffRevisions: number;
  turnNetFiles: number;
  environmentNetFiles: number;
  gitScopeFiles: number;
}

const shapeFor = (scale: number): Shape => ({
  environments: Math.max(4, Math.round(360 * scale)),
  bindingsPerEnvironment: 3,
  turnsPerBinding: 8,
  toolsPerTurn: 19,
  turnDiffRevisions: 4,
  turnNetFiles: 25,
  environmentNetFiles: 400,
  gitScopeFiles: 330,
});

function measurementJson(input: {
  id: string;
  scope: string;
  worktreeId: string;
  environmentId: string;
  threadId: string;
  turnId: string | null;
  operationId: string | null;
  evidenceId: string | null;
  files: number;
  at: string;
}): string {
  const count = (value: number) => ({ value, quality: "complete", bound: "exact" });
  return JSON.stringify({
    schemaVersion: 1,
    measurementId: input.id,
    worktreeId: input.worktreeId,
    worktreeIncarnation: "ino:597795792:1794002309217",
    scope: input.scope,
    logicalOwner: {
      environmentId: input.environmentId,
      threadId: input.threadId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.operationId ? { operationId: input.operationId, attemptId: "attempt-1" } : {}),
    },
    baselineVersion: null,
    beforeSnapshotId: null,
    afterSnapshotId: null,
    evidenceRefs: input.evidenceId
      ? [{ evidenceId: input.evidenceId, evidenceRevision: 1, selectedPaths: ["src/a.ts"] }]
      : [],
    capabilityRevision: "cap:ea00bb702e4a0d30d06b58dace86a6197b0a85c6",
    origin: input.evidenceId ? "input-fragments" : "snapshot-compare",
    algorithmPolicyId: "raw-lines-v1/myers-bounded-1",
    representationPolicyId: "provider-payload-v1",
    execution: "succeeded",
    executionOccurrence: "started",
    effectClaim: "proposal",
    finality: "final",
    consistency: "unknown",
    boundary: { before: "not-applicable", after: "not-applicable" },
    attribution: { basis: "proposal", writerIsolation: "unknown", overlap: "unknown" },
    completeness: { files: "complete", reasons: [], omittedFileCount: null },
    totals: {
      additions: count(input.files * 3),
      deletions: count(input.files),
      changedFiles: count(input.files),
      binaryFiles: count(0),
      renames: count(0),
    },
    diffIdentityId: `diff_${hex(`d:${input.id}`)}`,
    createdAt: input.at,
    supersedesMeasurementId: null,
  });
}

function evidenceJson(kind: "replacement" | "patch", seed: string): string {
  const body = (s: string, bytes: number) => ({
    id: `sha256:${hex(s, 64)}`,
    state: "available",
    retainedBytes: bytes,
    complete: true,
  });
  return JSON.stringify(
    kind === "replacement"
      ? {
          evidence: {
            kind: "replacement",
            path: `packages/area-${seed.length % 50}/src/file-${hex(seed, 6)}.ts`,
            before: { state: "present", body: body(`b:${seed}`, 4_096) },
            after: { state: "present", body: body(`a:${seed}`, 4_120) },
            extent: "fragment",
            origin: "input",
            effectClaim: "proposal",
          },
          sourceSequence: null,
          mode: "live",
        }
      : {
          evidence: {
            kind: "patch",
            body: body(`p:${seed}`, 2_048),
            format: "git_unified",
            effectClaim: "provider-reported",
          },
          sourceSequence: null,
          mode: "live",
        },
  );
}

interface Synthetic {
  environments: string[];
  /** Measurements with many file rows, for the page reads. */
  wideMeasurements: string[];
  /** Owners with a latest measurement, for `latestMeasurement`. */
  owners: Array<{ kind: string; id: string; scope: string }>;
  worktreeFor: Map<string, string>;
  bindingsFor: Map<string, string[]>;
}

/** Fills `database` with the synthetic history. Rows go in age order, as production writes them. */
function fillLedger(database: StorageDatabase, shape: Shape): Synthetic {
  const db = database.db;
  db.exec("PRAGMA synchronous = OFF");
  const insert = {
    worktree: db.prepare(
      `INSERT INTO change_worktrees (id, identity_key, incarnation, runtime_kind, runtime_id, canonical_root, git_dir, common_dir, created_at, updated_at)
       VALUES (?1, ?2, 'ino:1:1', 'host', 'bench-host', ?3, ?4, ?4, ?5, ?5)`,
    ),
    binding: db.prepare(
      `INSERT INTO change_bindings (id, source_key, environment_id, provider, conversation_id, worktree_id, created_at)
       VALUES (?1, ?2, ?3, 'claude', ?4, ?5, ?6)`,
    ),
    cursor: db.prepare(
      "INSERT INTO change_evidence_cursors (source_key, runtime_epoch, cursor, updated_at) VALUES (?1, ?2, ?3, ?4)",
    ),
    meta: db.prepare("INSERT OR REPLACE INTO change_ledger_meta (key, value) VALUES (?1, ?2)"),
    frame: db.prepare(
      `INSERT INTO change_frames (frame_key, binding_id, runtime_epoch, receipt_id, content_hash, ingested_seq, received_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ),
    operation: db.prepare(
      `INSERT INTO change_operations (operation_id, binding_id, environment_id, conversation_id, turn_id, call_id, parent_call_id, attempt_id, tool_kind, phase, execution_occurrence, background_task_id, capability_revision, history_mode, presentation_revision, reconciliation_json, first_seen_seq, updated_seq)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 'attempt-1', ?7, 'succeeded', 'started', NULL, 'cap:ea00bb702e4a0d30d06b58dace86a6197b0a85c6', 'live', 2, NULL, ?8, ?9)`,
    ),
    evidence: db.prepare(
      `INSERT INTO change_evidence (evidence_id, revision, owner_kind, owner_id, evidence_key, revision_key, replaces_revision_key, kind, claim, evidence_json, selected, frame_key, ingested_seq)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    ),
    body: db.prepare(
      `INSERT OR IGNORE INTO change_evidence_bodies (body_id, state, bytes, complete, original_bytes, reason, created_at, expires_at)
       VALUES (?1, 'available', ?2, 1, NULL, NULL, ?3, NULL)`,
    ),
    window: db.prepare(
      `INSERT INTO change_tool_windows (window_id, operation_id, turn_id, worktree_id, before_snapshot_id, after_snapshot_id, before_quality, after_quality, overlap, overlap_group, lifecycle, opened_seq, closed_seq, opened_at, closed_at, reason)
       VALUES (?1, ?2, ?3, ?4, NULL, NULL, 'prior-observation', 'after-terminal', 'none-observed', NULL, 'closed', ?5, ?5, ?6, ?6, NULL)`,
    ),
    measurement: db.prepare(
      `INSERT INTO change_measurements (id, scope, owner_kind, owner_id, worktree_id, from_snapshot_id, to_snapshot_id, algorithm_id, representation_id, measurement_json, supersedes_id, created_seq)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'raw-lines-v1/myers-bounded-1', 'provider-payload-v1', ?8, NULL, ?9)`,
    ),
    file: db.prepare(
      `INSERT INTO change_measurement_files (measurement_id, ordinal, path_id, old_path, new_path, old_blob, new_blob, old_mode, new_mode, status, file_kind, additions, additions_quality, deletions, deletions_quality, body_state, reason)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, '100644', '100644', 'modified', 'text', ?7, 'complete', ?8, 'complete', 'not-retained', NULL)`,
    ),
    identity: db.prepare(
      "INSERT INTO change_diff_identities (id, measurement_id, identity_json, created_at) VALUES (?1, ?2, ?3, ?4)",
    ),
    selection: db.prepare(
      `INSERT OR REPLACE INTO change_selections (selection_key, selector, baseline_version, measurement_id, selected_observation_epoch, revision, worktree_incarnation, owner_fence, updated_at)
       VALUES (?1, 'live', NULL, ?2, 0, ?3, 'ino:1:1', 0, ?4)`,
    ),
    outbox: db.prepare(
      `INSERT INTO change_outbox (resource_key, revision, measurement_id, event_kind, delivered, created_at)
       VALUES (?1, ?2, ?3, 'projection', 1, ?4)`,
    ),
    segment: db.prepare(
      `INSERT INTO change_thread_segments (segment_id, thread_id, environment_id, worktree_id, initial_turn_id, baseline_snapshot_id, baseline_state, baseline_reason, latest_live_snapshot_id, final_snapshot_id, inherited_prefix_id, created_at, closed_at)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5, 'captured', NULL, NULL, NULL, NULL, ?6, NULL)`,
    ),
    turn: db.prepare(
      `INSERT INTO change_turn_boundaries (turn_id, segment_id, thread_id, environment_id, worktree_id, lifecycle, start_attempt_id, start_snapshot_id, end_snapshot_id, before_quality, after_quality, terminal_evidence, dispatch_token, dispatch_receipt, reason, started_at, finished_at, ordinal)
       VALUES (?1, ?2, ?3, ?4, ?5, 'finalized', NULL, ?6, ?7, 'captured', 'captured', NULL, NULL, NULL, NULL, ?8, ?9, ?10)`,
    ),
    snapshot: db.prepare(
      `INSERT INTO change_snapshots (id, worktree_id, incarnation, tree_oid, object_format, policy_id, capture_started_at, capture_finished_at, observation_epoch, coverage_json, consistency_json, closure_verified, file_count, retained_bytes, created_at)
       VALUES (?1, ?2, 'ino:1:1', ?3, 'sha1', 'v1', ?4, ?4, 1, '{"kind":"complete"}', '{"kind":"stable"}', 1, 2000, 0, ?4)`,
    ),
    reference: db.prepare(
      "INSERT OR IGNORE INTO change_references (owner_kind, owner_id, snapshot_id, reason, expires_at) VALUES (?1, ?2, ?3, ?4, NULL)",
    ),
  };
  const synthetic: Synthetic = {
    environments: [],
    wideMeasurements: [],
    owners: [],
    worktreeFor: new Map(),
    bindingsFor: new Map(),
  };
  const now = Date.now();
  const totalTurns = shape.environments * shape.bindingsPerEnvironment * shape.turnsPerBinding;
  const startMs = now - HISTORY_DAYS * DAY_MS;
  const stepMs = (HISTORY_DAYS * DAY_MS) / totalTurns;
  let seq = 0;
  let outboxRevision = 0;
  const iso = (ms: number) => new Date(ms).toISOString();

  const addMeasurement = (input: {
    scope: string;
    ownerKind: string;
    ownerId: string;
    selectionKey: string;
    worktreeId: string;
    environmentId: string;
    threadId: string;
    turnId: string | null;
    operationId: string | null;
    evidenceId: string | null;
    files: number;
    atMs: number;
    seed: string;
  }) => {
    const id = `m_${hex(`m:${input.seed}`)}`;
    const at = iso(input.atMs);
    seq++;
    insert.measurement.run(
      id,
      input.scope,
      input.ownerKind,
      input.ownerId,
      input.worktreeId,
      null,
      null,
      measurementJson({ ...input, id, at }),
      seq,
    );
    for (let ordinal = 0; ordinal < input.files; ordinal++) {
      const file = `packages/area-${ordinal % 50}/src/d${ordinal % 97}/file-${ordinal}.ts`;
      insert.file.run(
        id,
        ordinal,
        `u:${file}`,
        file,
        hex(`o:${input.seed}:${ordinal}`),
        hex(`n:${input.seed}:${ordinal}`),
        3,
        1,
      );
    }
    const identity = `diff_${hex(`d:${id}`)}`;
    insert.identity.run(
      identity,
      id,
      JSON.stringify({
        id: identity,
        worktreeId: input.worktreeId,
        worktreeIncarnation: "ino:1:1",
        scope: input.scope,
        measurementId: id,
        algorithmPolicyId: "raw-lines-v1/myers-bounded-1",
        representationPolicyId: "provider-payload-v1",
        rendererPolicyId: "hunks-v1",
        whitespacePolicy: "preserve",
        kind: "payload",
        evidenceId: input.evidenceId,
        evidenceRevision: 1,
        pathDisplays: [{ before: "src/a.ts", after: "src/a.ts" }],
      }),
      at,
    );
    insert.selection.run(input.selectionKey, id, 1, at);
    outboxRevision++;
    if (outboxRevision % 8 === 0) insert.outbox.run(input.selectionKey, 1, id, at);
    return id;
  };

  const environments = Array.from({ length: shape.environments }, (_, index) => `env-syn-${index}`);
  synthetic.environments = environments;
  const chunk = (fn: () => void) => db.transaction(fn)();

  chunk(() => {
    for (const environmentId of environments) {
      const worktreeId = `wt_${uuid(`wt:${environmentId}`)}`;
      synthetic.worktreeFor.set(environmentId, worktreeId);
      const root = `/bench/worktrees/${environmentId}`;
      insert.worktree.run(
        worktreeId,
        `host:bench:${root}:${root}/.git`,
        root,
        `${root}/.git`,
        iso(startMs),
      );
      const bindings: string[] = [];
      for (let b = 0; b < shape.bindingsPerEnvironment; b++) {
        const bindingId = `bind_${uuid(`b:${environmentId}:${b}`)}`;
        const sourceKey = `${environmentId}\0claude\0bench-${b}`;
        bindings.push(bindingId);
        insert.binding.run(
          bindingId,
          `${environmentId}\0claude\0claude:s${b}`,
          environmentId,
          `s${b}`,
          worktreeId,
          iso(startMs),
        );
        insert.cursor.run(sourceKey, uuid(`epoch:${environmentId}:${b}`), 1, iso(startMs));
        insert.meta.run(
          `evidence-source:${encodeURIComponent(environmentId)}:${encodeURIComponent(sourceKey)}`,
          sourceKey,
        );
        const segmentId = `seg_${uuid(`seg:${bindingId}`)}`;
        const baseline = `snap_${uuid(`base:${bindingId}`)}`;
        insert.snapshot.run(baseline, worktreeId, treeOid(0), iso(startMs));
        insert.reference.run("segment", segmentId, baseline, "baseline");
        insert.segment.run(segmentId, `s${b}`, environmentId, worktreeId, baseline, iso(startMs));
      }
      synthetic.bindingsFor.set(environmentId, bindings);
    }
  });

  // One turn after another across every environment, in time order.
  const CHUNK_TURNS = 200;
  for (let first = 0; first < totalTurns; first += CHUNK_TURNS) {
    chunk(() => {
      for (let slot = first; slot < Math.min(totalTurns, first + CHUNK_TURNS); slot++) {
        const environmentIndex = slot % shape.environments;
        const environmentId = environments[environmentIndex]!;
        const local = Math.floor(slot / shape.environments);
        const bindingIndex = local % shape.bindingsPerEnvironment;
        const ordinal = Math.floor(local / shape.bindingsPerEnvironment);
        if (ordinal >= shape.turnsPerBinding) continue;
        const worktreeId = synthetic.worktreeFor.get(environmentId)!;
        const bindingId = synthetic.bindingsFor.get(environmentId)![bindingIndex]!;
        const threadId = `s${bindingIndex}`;
        const epoch = uuid(`epoch:${environmentId}:${bindingIndex}`);
        const atMs = startMs + slot * stepMs;
        const at = iso(atMs);
        const turnId = `turn-${hex(`t:${slot}`, 24)}`;
        const segmentId = `seg_${uuid(`seg:${bindingId}`)}`;
        const startSnapshot = `snap_${uuid(`s:${slot}`)}`;
        const endSnapshot = `snap_${uuid(`e:${slot}`)}`;
        insert.snapshot.run(startSnapshot, worktreeId, treeOid(slot), at);
        insert.snapshot.run(endSnapshot, worktreeId, treeOid(slot + 1), iso(atMs + stepMs / 2));
        insert.reference.run("turn", turnId, startSnapshot, "turn-start");
        insert.reference.run("turn", turnId, endSnapshot, "turn-end");
        insert.turn.run(
          turnId,
          segmentId,
          threadId,
          environmentId,
          worktreeId,
          startSnapshot,
          endSnapshot,
          at,
          iso(atMs + stepMs / 2),
          ordinal + 1,
        );
        const frameAt = (index: number) => iso(atMs + (index * stepMs) / (shape.toolsPerTurn * 3));
        const frame = (index: number, seed: string) => {
          const frameKey = `${bindingId}\0frame:${hex(`f:${seed}`)}`;
          seq++;
          insert.frame.run(
            frameKey,
            bindingId,
            epoch,
            `rcpt_${uuid(`r:${seed}`)}`,
            hex(`h:${seed}`, 64),
            seq,
            frameAt(index),
          );
          return frameKey;
        };
        // The turn's own operation.
        const turnOperation = `op_${hex(`top:${slot}`)}`;
        frame(0, `turn:${slot}`);
        insert.operation.run(
          turnOperation,
          bindingId,
          environmentId,
          threadId,
          turnId,
          null,
          "turn",
          seq,
          seq,
        );
        for (let tool = 0; tool < shape.toolsPerTurn; tool++) {
          const seed = `${slot}:${tool}`;
          const operationId = `op_${hex(`op:${seed}`)}`;
          frame(tool * 2 + 1, `run:${seed}`);
          const firstSeen = seq;
          const finished = frame(tool * 2 + 2, `done:${seed}`);
          insert.operation.run(
            operationId,
            bindingId,
            environmentId,
            threadId,
            turnId,
            `call-${hex(seed, 12)}`,
            tool % 3 === 0 ? "shell" : "file-edit",
            firstSeen,
            seq,
          );
          insert.window.run(
            `win_${operationId}`,
            operationId,
            turnId,
            worktreeId,
            seq,
            frameAt(tool * 2 + 2),
          );
          insert.meta.run(`opturn:${operationId}`, turnId);
          if (tool % 2 === 0) {
            const evidenceId = `ev_${hex(`ev:${seed}`)}`;
            insert.evidence.run(
              evidenceId,
              1,
              "operation",
              operationId,
              "replacement:0",
              `rev:${hex(`rev:${seed}`)}`,
              null,
              "replacement",
              "proposal",
              evidenceJson("replacement", seed),
              1,
              finished,
              seq,
            );
            insert.body.run(`sha256:${hex(`b:${seed}`, 64)}`, 4_096, at);
            insert.body.run(`sha256:${hex(`a:${seed}`, 64)}`, 4_120, at);
            if (tool % 6 !== 4) {
              addMeasurement({
                scope: "tool-payload",
                ownerKind: "operation",
                ownerId: operationId,
                selectionKey: `tool-payload/operation/${operationId}/live`,
                worktreeId,
                environmentId,
                threadId,
                turnId,
                operationId,
                evidenceId,
                files: 1,
                atMs,
                seed: `tool:${seed}`,
              });
            }
          }
        }
        // Cumulative provider turn diffs: each revision replaces the last.
        const providerTurn = `pturn_${hex(`pt:${slot}`)}`;
        const turnEvidence = `ev_${hex(`pev:${slot}`)}`;
        for (let revision = 1; revision <= shape.turnDiffRevisions; revision++) {
          const seed = `${slot}:diff:${revision}`;
          const frameKey = frame(shape.toolsPerTurn * 2 + revision, seed);
          insert.evidence.run(
            turnEvidence,
            revision,
            "provider-turn",
            providerTurn,
            "turn-diff",
            `rev:${hex(`prev:${seed}`)}`,
            revision > 1 ? `rev:${hex(`prev:${slot}:diff:${revision - 1}`)}` : null,
            "patch",
            "provider-reported",
            evidenceJson("patch", seed),
            revision === shape.turnDiffRevisions ? 1 : 0,
            frameKey,
            seq,
          );
          insert.body.run(`sha256:${hex(`p:${seed}`, 64)}`, 2_048, at);
        }
        addMeasurement({
          scope: "provider-turn-diff",
          ownerKind: "provider-turn",
          ownerId: providerTurn,
          selectionKey: `provider-turn-diff/turn/${providerTurn}/live`,
          worktreeId,
          environmentId,
          threadId,
          turnId: providerTurn,
          operationId: null,
          evidenceId: turnEvidence,
          files: 4,
          atMs,
          seed: `pturn:${slot}`,
        });
        addMeasurement({
          scope: "turn-net",
          ownerKind: "turn",
          ownerId: turnId,
          selectionKey: `turn-net/turn/${turnId}/live`,
          worktreeId,
          environmentId,
          threadId,
          turnId,
          operationId: null,
          evidenceId: null,
          files: shape.turnNetFiles,
          atMs,
          seed: `tnet:${slot}`,
        });
        // Environment and Git scope views, re-measured as the environment works:
        // two kept per owner, as pruning leaves them.
        if (
          ordinal >= shape.turnsPerBinding - 1 &&
          bindingIndex === shape.bindingsPerEnvironment - 1
        ) {
          for (let version = 0; version < 2; version++) {
            const wide = addMeasurement({
              scope: "environment-net",
              ownerKind: "environment",
              ownerId: environmentId,
              selectionKey: environmentChangeResourceKey(environmentId),
              worktreeId,
              environmentId,
              threadId,
              turnId: null,
              operationId: null,
              evidenceId: null,
              files: shape.environmentNetFiles,
              atMs: atMs + version,
              seed: `enet:${environmentId}:${version}`,
            });
            if (version === 1) synthetic.wideMeasurements.push(wide);
            for (const scope of GIT_SCOPES.slice(0, 3)) {
              const key = gitScopeResourceKey(scope, environmentId);
              addMeasurement({
                scope,
                ownerKind: `git-${scope}`,
                ownerId: key,
                selectionKey: key,
                worktreeId,
                environmentId,
                threadId,
                turnId: null,
                operationId: null,
                evidenceId: null,
                files: shape.gitScopeFiles,
                atMs: atMs + version,
                seed: `git:${scope}:${environmentId}:${version}`,
              });
              if (version === 1) synthetic.owners.push({ kind: `git-${scope}`, id: key, scope });
            }
          }
          synthetic.owners.push({
            kind: "environment",
            id: environmentId,
            scope: "environment-net",
          });
        }
      }
    });
  }
  db.exec(
    "INSERT OR REPLACE INTO change_ledger_meta (key, value) VALUES ('seq', '" + (seq + 1) + "')",
  );
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec("ANALYZE");
  return synthetic;
}

/** A few hundred distinct trees: snapshots of an unchanged tree share one. */
const treeOid = (index: number) => hex(`tree:${index % 300}`);

/** Rebuilds the bookkeeping `fillLedger` returns from a ledger built earlier. */
function syntheticFrom(database: StorageDatabase): Synthetic {
  const db = database.db;
  const synthetic: Synthetic = {
    environments: [],
    wideMeasurements: [],
    owners: [],
    worktreeFor: new Map(),
    bindingsFor: new Map(),
  };
  for (const row of db
    .query(
      "SELECT id, environment_id AS env, worktree_id AS wt FROM change_bindings WHERE environment_id LIKE 'env-syn-%' ORDER BY rowid",
    )
    .all() as Array<{ id: string; env: string; wt: string }>) {
    if (!synthetic.bindingsFor.has(row.env)) {
      synthetic.environments.push(row.env);
      synthetic.bindingsFor.set(row.env, []);
      synthetic.worktreeFor.set(row.env, row.wt);
    }
    synthetic.bindingsFor.get(row.env)!.push(row.id);
  }
  synthetic.wideMeasurements = (
    db
      .query(
        "SELECT measurement_id AS id FROM change_selections WHERE selection_key LIKE 'environment-net/%' AND measurement_id IS NOT NULL",
      )
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
  synthetic.owners = db
    .query(
      "SELECT DISTINCT owner_kind AS kind, owner_id AS id, scope FROM change_measurements WHERE owner_kind = 'environment' OR owner_kind LIKE 'git-%'",
    )
    .all() as Array<{ kind: string; id: string; scope: string }>;
  return synthetic;
}

// ---------------------------------------------------------------------------
// Agent-like load
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "b",
      GIT_AUTHOR_EMAIL: "b@e",
      GIT_COMMITTER_NAME: "b",
      GIT_COMMITTER_EMAIL: "b@e",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

const capabilities = {
  resolution: "resolved",
  beforeTurn: "controlled-dispatch",
  afterTurn: "terminal-observed",
  beforeTool: "awaited",
  afterTool: "awaited",
  historicalCallIdentity: "stable",
  fileEvidence: { resolution: "confirmed", kinds: ["replacement"] },
  turnDiff: "reported",
  captureExecutor: "host-worker",
  captureAvailability: "ready",
  backgroundCompletion: "launch-only",
} as const;

const lines = (count: number, changeAt: number) =>
  Array.from({ length: count }, (_, index) =>
    index === changeAt ? `x${index}\n` : `l${index}\n`,
  ).join("");

interface Agent {
  environmentId: string;
  conversationId: string;
  recorder: ChangeEvidenceRecorder;
  source: EvidenceSource;
  turns: number;
  calls: string[];
}

function createAgent(service: ChangeTrackingService, index: number): Agent {
  const spool = new ChangeEvidenceSpool();
  const environmentId = `agent-${index}`;
  const conversationId = `conv-${index}`;
  const recorder = new ChangeEvidenceRecorder({
    spool,
    provider: "claude",
    capabilities: capabilities as never,
  });
  service.rememberConversation(environmentId, "claude", conversationId, `tab-${index}`);
  return {
    environmentId,
    conversationId,
    recorder,
    calls: [],
    turns: 0,
    source: {
      sourceKey: `${environmentId}\0claude\0bench`,
      environmentId,
      provider: "claude",
      read: async (cursor, epoch) => spool.read(epoch && epoch !== spool.runtimeEpoch ? 0 : cursor),
      body: async (id) => spool.readBody(id),
      ack: async (request) => {
        spool.acknowledge(request);
      },
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One agent turn: a turn frame, four tool calls with edits, a cumulative turn diff, an environment scan. */
async function agentTurn(
  service: ChangeTrackingService,
  agent: Agent,
  repo: string,
): Promise<void> {
  const turnId = `t${agent.turns++}`;
  const source = { conversationId: agent.conversationId, turnId };
  agent.recorder.turn(source, "running");
  await service.pullEvidence(agent.source);
  for (let call = 0; call < 4; call++) {
    const callId = `${turnId}-c${call}`;
    agent.recorder.tool(
      { ...source, callId },
      {
        toolKind: "file-edit",
        phase: "succeeded",
        executionOccurrence: "started",
        evidence: [
          {
            kind: "replacement",
            path: `src/file-${call}.ts`,
            before: lines(200, -1),
            after: lines(200, (agent.turns * 7 + call) % 200),
            extent: "fragment",
            origin: "input",
            claim: "proposal",
          },
        ],
      },
    );
    agent.calls.push(callId);
    if (agent.calls.length > 64) agent.calls.shift();
    await service.pullEvidence(agent.source);
    agent.recorder.turnDiff(
      source,
      `--- a/src/file-${call}.ts\n+++ b/src/file-${call}.ts\n@@ -1 +1 @@\n-l0\n+x${agent.turns}-${call}\n`,
    );
    await service.pullEvidence(agent.source);
    if (PACE_MS > 0) await sleep(PACE_MS);
  }
  agent.recorder.turn(source, "succeeded");
  await service.pullEvidence(agent.source);
  const at = new Date().toISOString();
  const files = 300;
  service.onDiffScanEvent({
    kind: "scanned",
    target: {
      environmentId: agent.environmentId,
      comparisonRef: "main",
      kind: "local",
      worktreePath: repo,
    },
    result: {
      stats: { additions: files, deletions: 0, filesChanged: files, truncated: false },
      changes: Array.from({ length: files }, (_, index) => {
        const file = index === files - 1 ? `round-${agent.turns}.ts` : `file-${index}.ts`;
        return {
          path: `src/${file}`,
          filename: file,
          directory: "src",
          additions: 1,
          deletions: 0,
          status: "M",
        };
      }),
      baseOid: "a".repeat(40),
    },
    changed: true,
    at,
    startedAt: at,
  } as never);
}

async function runAgents(
  service: ChangeTrackingService,
  agents: Agent[],
  repo: string,
  until: number,
): Promise<number> {
  let turns = 0;
  await Promise.all(
    agents.map(async (agent) => {
      while (performance.now() < until) {
        await agentTurn(service, agent, repo);
        turns++;
      }
    }),
  );
  await service.environments.idle();
  await service.retention.idle();
  return turns;
}

/** Readers: what open tabs and the changes panel ask for. */
async function runQueries(
  service: ChangeTrackingService,
  agents: Agent[],
  synthetic: Synthetic,
  until: number,
): Promise<number> {
  let reads = 0;
  let index = 0;
  while (performance.now() < until) {
    const agent = agents[index % agents.length]!;
    service.getView({ resourceKey: environmentChangeResourceKey(agent.environmentId) });
    service.getToolPresentations({
      environmentId: agent.environmentId,
      provider: "claude",
      conversationId: agent.conversationId,
      callIds: agent.calls.slice(-16),
    });
    service.getHistory({
      environmentId: agent.environmentId,
      logicalSessionKey: `tab-${index % agents.length}`,
    });
    const wide = synthetic.wideMeasurements[index % Math.max(1, synthetic.wideMeasurements.length)];
    if (wide) {
      service.ledger.measurementFileCount(wide);
      service.ledger.measurementFiles(wide, (index * 50) % 350, 50);
      service.ledger.measurement(wide);
    }
    const owner = synthetic.owners[index % Math.max(1, synthetic.owners.length)];
    if (owner) service.ledger.latestMeasurement(owner.kind, owner.id, owner.scope);
    reads++;
    index++;
    await sleep(5);
  }
  return reads;
}

// ---------------------------------------------------------------------------
// Query plans
// ---------------------------------------------------------------------------

function slowPlans(db: Database) {
  const found: Array<{ sql: string; plan: string[]; maxMs: number; calls: number }> = [];
  for (const [sql, calls] of allStatements) {
    if (!/^(SELECT|UPDATE|DELETE|INSERT|WITH)/i.test(sql)) continue;
    let plan: string[];
    try {
      plan = (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(
        (row) => row.detail,
      );
    } catch {
      continue;
    }
    const scans = plan.filter((detail) => {
      const match = /^SCAN (\w+)/.exec(detail);
      return match ? LARGE_TABLES.has(match[1]!) : false;
    });
    const peakMs = Math.max(statementTimings.get(sql)?.maxMs ?? 0, peakStatementMs.get(sql) ?? 0);
    // A scan of a large table, or anything slow enough to matter whatever its plan says.
    if (scans.length === 0 && peakMs < 10) continue;
    found.push({
      sql: sql.length > 400 ? `${sql.slice(0, 397)}...` : sql,
      plan,
      maxMs: Math.round(peakMs * 10) / 10,
      calls,
    });
  }
  return found.toSorted((left, right) => right.maxMs - left.maxMs);
}

/** Worst time per statement over every phase (phases reset `statementTimings`). */
const peakStatementMs = new Map<string, number>();
function rememberPeaks(): void {
  for (const [sql, timing] of statementTimings)
    peakStatementMs.set(sql, Math.max(peakStatementMs.get(sql) ?? 0, timing.maxMs));
}

// ---------------------------------------------------------------------------
// Disk contention
// ---------------------------------------------------------------------------

/** One fsync loop over a bounded file: 64 positions of 4 MiB, rewritten forever. */
const DISK_WRITER_SOURCE = `
const fs = require("node:fs");
const block = Buffer.alloc(4 << 20, 7);
const fd = fs.openSync(process.argv[1], "w");
for (let n = 0; ; n++) {
  fs.writeSync(fd, block, 0, block.length, (n % 64) * block.length);
  fs.fsyncSync(fd);
}
`;

function startDiskWriters(directory: string, count: number): ChildProcess[] {
  return Array.from({ length: count }, (_, index) =>
    spawn(
      process.execPath,
      ["-e", DISK_WRITER_SOURCE, path.join(directory, `disk-load-${index}.bin`)],
      {
        stdio: "ignore",
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  installProfiler();
  const dataDir = REUSE_DIR
    ? path.resolve(REUSE_DIR)
    : mkdtempSync(path.join(tmpdir(), "ork-ledger-scale-"));
  const repo = mkdtempSync(path.join(tmpdir(), "ork-ledger-scale-repo-"));
  const report: Record<string, unknown> = {
    scale: SCALE,
    agents: AGENTS,
    seconds: SECONDS,
    paceMs: PACE_MS,
    startedAt: new Date().toISOString(),
    phases: [] as unknown[],
  };
  const phases = report.phases as Array<Record<string, unknown>>;
  let service: ChangeTrackingService | null = null;
  let database: StorageDatabase | null = null;
  const probe = new StallProbe();
  let writers: ChildProcess[] = [];
  try {
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "a.txt"), "one\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");

    const ledgerFile = path.join(dataDir, CHANGE_LEDGER_DATABASE_FILE);
    const built = existsSync(ledgerFile);
    database = openChangeLedgerDatabase(dataDir);
    let synthetic: Synthetic;
    if (built) {
      synthetic = syntheticFrom(database);
    } else {
      const started = performance.now();
      synthetic = fillLedger(database, shapeFor(SCALE));
      report.buildMs = Math.round(performance.now() - started);
    }
    const counts: Record<string, number> = {};
    let totalRows = 0;
    for (const table of CHANGE_LEDGER_TABLES) {
      counts[table] = (
        database.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
      ).n;
      totalRows += counts[table]!;
    }
    report.ledger = {
      fileBytes: statSync(ledgerFile).size,
      rows: totalRows,
      tables: counts,
    };
    console.log(
      `ledger: ${(statSync(ledgerFile).size / 1e9).toFixed(2)} GB, ${totalRows.toLocaleString()} rows`,
    );
    resetTimings();
    allStatements.clear();

    const openService = (policy: Record<string, unknown> = {}) =>
      new ChangeTrackingService({
        dataDir,
        database: () => database!,
        emit: () => {},
        environmentTarget: async (environmentId) =>
          environmentId.startsWith("agent-") ? { kind: "local", worktreePath: repo } : null,
        manualScheduling: true,
        policy,
      });
    service = openService();
    service.start();
    const agents = Array.from({ length: AGENTS }, (_, index) => createAgent(service!, index));
    writers = startDiskWriters(dataDir, DISK_WRITERS);
    report.diskWriters = DISK_WRITERS;
    probe.start();
    await sleep(20);

    const phase = async (name: string, work: () => Promise<Record<string, unknown>>) => {
      resetTimings();
      probe.take();
      const started = performance.now();
      const details = await work();
      const wallMs = Math.round(performance.now() - started);
      await sleep(10);
      const stalls = probe.take();
      rememberPeaks();
      const entry = {
        phase: name,
        wallMs,
        ...stalls,
        ...details,
        slowestStatements: topTimings(statementTimings, 8),
        slowestTransactions: topTimings(transactionTimings, 8),
      };
      phases.push(entry);
      console.log(
        `${name.padEnd(10)} wall ${String(wallMs).padStart(7)} ms  max stall ${String(stalls.maxStallMs).padStart(6)} ms  >=100ms ${stalls.over100Ms}  >=1s ${stalls.over1s}`,
      );
      for (const row of entry.slowestTransactions.slice(0, 3))
        console.log(`    txn ${String(row.maxMs).padStart(7)} ms  x${row.calls}  ${row.key}`);
      for (const row of entry.slowestStatements.slice(0, 3))
        console.log(
          `    sql ${String(row.maxMs).padStart(7)} ms  x${row.calls}  ${row.key.slice(0, 140)}`,
        );
    };

    // Warm the agents' bindings and worktree before timing anything.
    await runAgents(service, agents, repo, performance.now());

    if (ONLY.has("ingest"))
      await phase("ingest", async () => ({
        turns: await runAgents(service!, agents, repo, performance.now() + SECONDS * 1000),
      }));

    if (ONLY.has("queries"))
      await phase("queries", async () => ({
        reads: await runQueries(service!, agents, synthetic, performance.now() + SECONDS * 1000),
      }));

    if (ONLY.has("retention"))
      await phase("retention", async () => {
        const purged = synthetic.environments.slice(0, 3);
        const requestedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
        for (const environmentId of purged) {
          service!.retention.purges.requestPurge({
            environmentId,
            requestedAt,
            worktreeIds: [synthetic.worktreeFor.get(environmentId)!],
            sourceKeys: (synthetic.bindingsFor.get(environmentId) ?? []).map(
              (_, index) => `${environmentId}\0claude\0bench-${index}`,
            ),
          });
        }
        synthetic.environments = synthetic.environments.slice(3);
        const first = await service!.retention.run();
        const second = await service!.retention.run();
        return { purgedEnvironments: purged.length, first, second };
      });

    if (ONLY.has("manifest"))
      await phase("manifest", async () => {
        const paths = Array.from({ length: MANIFEST_ENTRIES }, (_, index) =>
          encodePath(
            new TextEncoder().encode(
              `packages/area-${index % 50}/src/d${index % 500}/file-${index}.ts`,
            ),
          ),
        ).toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
        const timings: Record<string, number> = {};
        const time = async (label: string, work: () => unknown) => {
          // Independent samples: consuming a submeasurement must not reset the
          // enclosing phase's stall totals.
          const measurementProbe = new StallProbe();
          measurementProbe.start();
          try {
            const started = performance.now();
            await work();
            timings[`${label}Ms`] = Math.round(performance.now() - started);
            await sleep(5);
            timings[`${label}StallMs`] = measurementProbe.take().maxStallMs;
          } finally {
            measurementProbe.stop();
          }
        };
        const manifest = {
          v: 1,
          root: `bench-${Date.now()}`,
          entries: paths.map((p, index) => ({
            p,
            m: "100644",
            o: index.toString(16).padStart(40, "0"),
            s: index,
            t: 1,
          })),
          omitted: [],
          unstable: [],
        };
        let encoded: Uint8Array = new Uint8Array();
        await time("stringify", () => {
          encoded = new TextEncoder().encode(JSON.stringify(manifest));
        });
        let id = "";
        await time("store", async () => {
          id = (await service!.objects.put("manifest", encoded)).id;
        });
        await time("coldRead", () => readManifest(service!.objects, id, { scan: true }));
        const wide = synthetic.wideMeasurements[0];
        await time("measurementJson", () => {
          for (let index = 0; index < 1_000 && wide; index++) service!.ledger.measurement(wide);
        });
        return { manifestEntries: MANIFEST_ENTRIES, manifestBytes: encoded.length, ...timings };
      });

    if (ONLY.has("mixed"))
      await phase("mixed", async () => {
        const until = performance.now() + SECONDS * 1000;
        let passes = 0;
        const retention = (async () => {
          while (performance.now() < until) {
            await service!.retention.run();
            passes++;
          }
        })();
        const [turns, reads] = await Promise.all([
          runAgents(service!, agents, repo, until),
          runQueries(service!, agents, synthetic, until),
          retention,
        ]);
        return { turns, reads, retentionPasses: passes };
      });

    if (ONLY.has("window")) {
      service.shutdown();
      service = openService({ archivedBodyRetentionDays: WINDOW_DAYS });
      service.start();
      await phase("window", async () => {
        const reports = [];
        for (let pass = 0; pass < 8; pass++) {
          const outcome = await service!.retention.run();
          reports.push(outcome);
          if (outcome.retiredRows === 0 && outcome.prunedMeasurements === 0) break;
        }
        const after: Record<string, number> = {};
        for (const table of [
          "change_frames",
          "change_evidence",
          "change_operations",
          "change_measurements",
          "change_measurement_files",
        ])
          after[table] = (
            database!.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
          ).n;
        return {
          windowDays: WINDOW_DAYS,
          passes: reports.length,
          retiredRows: reports.reduce((sum, outcome) => sum + outcome.retiredRows, 0),
          rowsAfter: after,
          fileBytesAfter: statSync(path.join(dataDir, CHANGE_LEDGER_DATABASE_FILE)).size,
        };
      });
    }

    // Plans on a connection of their own, so nothing is left open on the service's.
    const planner = new Database(ledgerFile, { readonly: true });
    try {
      report.slowPlans = slowPlans(planner);
    } finally {
      planner.close();
    }

    console.log("\nstatements that scan a large table or took 10 ms or more:");
    for (const plan of report.slowPlans as ReturnType<typeof slowPlans>)
      console.log(
        `  ${String(plan.maxMs).padStart(7)} ms x${plan.calls}  ${plan.sql.slice(0, 160)}\n      ${plan.plan.join(" | ")}`,
      );

    const out =
      OUT ??
      path.join(
        import.meta.dir,
        "..",
        "..",
        "output",
        "efficiency",
        "ledger-scale",
        `${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nreport: ${out}`);
  } finally {
    probe.stop();
    // Only the writers this run spawned, through their own handles.
    for (const writer of writers) writer.kill();
    for (let index = 0; index < writers.length; index++)
      rmSync(path.join(dataDir, `disk-load-${index}.bin`), { force: true });
    service?.shutdown();
    database?.close();
    rmSync(repo, { recursive: true, force: true });
    if (!KEEP && !REUSE_DIR) rmSync(dataDir, { recursive: true, force: true });
    else console.log(`ledger kept at ${dataDir}`);
  }
}

await main();
