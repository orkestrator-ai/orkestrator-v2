/**
 * What retention deletes, and above all what it must keep: environment purges,
 * age-based retirement, and content another environment, a restore or a live
 * thread still needs.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { environmentChangeResourceKey } from "@orkestrator/protocol/change-resources";
import { ChangeEvidenceRecorder } from "@orkestrator/protocol/node/change-tracking/evidence-builders";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import type { DiffStatsTarget } from "../diff-stats-service.js";
import { bodyIdFor, EvidenceBodyStore } from "./evidence-body-store.js";
import { gitScopeResourceKey } from "./git-scopes.js";
import { operationIdFor, threadIdFor, toolResourceKeys, turnResourceKeys } from "./identities.js";
import { ChangeTrackingService } from "./service.js";
import { openChangeLedgerDatabase } from "./ledger-schema.js";
import { createHarness, spoolSource, type Harness } from "./service-test-support.js";
import { turnIdFor } from "./turn-boundaries.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const SESSION = "tab";
const CONVERSATION = "conversation";

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

function setup(aliases: readonly string[] = []) {
  const h = createHarness({ aliases });
  harnesses.push(h);
  return h;
}

const count = (h: Harness, table: string, where = "1 = 1", ...params: string[]): number =>
  (
    h
      .database()
      .db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
      .get(...params) as { n: number }
  ).n;

/** A tool call with a stored body, ingested through the real spool and pull. */
async function recordEdit(
  h: Harness,
  environmentId: string,
  callId: string,
  after = "edited\n",
): Promise<void> {
  const spool = new ChangeEvidenceSpool();
  const recorder = new ChangeEvidenceRecorder({
    spool,
    provider: "claude",
    capabilities: {
      resolution: "resolved",
      beforeTurn: "controlled-dispatch",
      afterTurn: "terminal-observed",
      beforeTool: "awaited",
      afterTool: "awaited",
      historicalCallIdentity: "stable",
      fileEvidence: { resolution: "confirmed", kinds: ["replacement"] },
      turnDiff: "absent",
      captureExecutor: "host-worker",
      captureAvailability: "ready",
      backgroundCompletion: "launch-only",
    },
  });
  recorder.tool(
    { conversationId: CONVERSATION, callId },
    {
      toolKind: "file-edit",
      phase: "succeeded",
      executionOccurrence: "started",
      evidence: [
        {
          kind: "replacement",
          path: "a.ts",
          before: "original\n",
          after,
          extent: "fragment",
          origin: "input",
          claim: "proposal",
        },
      ],
    },
  );
  await h.service.pullEvidence({
    ...spoolSource(spool, "claude", environmentId),
    sourceKey: `${environmentId}\0claude\0${callId}`,
  });
}

async function runTurn(h: Harness, environmentId: string, requestId: string, content = requestId) {
  const start = await h.service.prepareTurnStart({
    environmentId,
    logicalSessionKey: SESSION,
    requestId,
    provider: "claude",
  });
  h.service.rememberConversation(environmentId, "claude", CONVERSATION, SESSION);
  h.service.markTurnDispatched(environmentId, SESSION, requestId, "accepted");
  writeFileSync(join(h.repo, "a.txt"), `${content}\n`);
  await h.service.finalizeTurn({ environmentId, logicalSessionKey: SESSION, requestId });
  return { start, turnId: turnIdFor(environmentId, SESSION, requestId) };
}

async function scanEnvironment(h: Harness, environmentId: string) {
  const target: DiffStatsTarget = {
    environmentId,
    comparisonRef: "main",
    kind: "local",
    worktreePath: h.repo,
  };
  const at = new Date().toISOString();
  h.service.onDiffScanEvent({
    kind: "scanned",
    target,
    result: {
      stats: { additions: 1, deletions: 0, filesChanged: 1, truncated: false },
      changes: [
        {
          path: "a.txt",
          filename: "a.txt",
          directory: "",
          additions: 1,
          deletions: 0,
          status: "M",
        },
      ],
      baseOid: "a".repeat(40),
    },
    changed: true,
    at,
    startedAt: at,
  });
  await h.service.environments.idle();
}

const LEDGER_TABLES_OF_ONE_ENVIRONMENT = [
  "change_worktrees",
  "change_bindings",
  "change_frames",
  "change_operations",
  "change_evidence",
  "change_evidence_chunks",
  "change_evidence_bodies",
  "change_evidence_gaps",
  "change_capture_attempts",
  "change_snapshots",
  "change_thread_segments",
  "change_turn_boundaries",
  "change_tool_windows",
  "change_measurements",
  "change_measurement_files",
  "change_diff_identities",
  "change_references",
  "change_selections",
  "change_restore_tokens",
  "change_restore_operations",
  "change_evidence_cursors",
  "change_outbox",
];

describe("deleting an environment", () => {
  test("restart before deletion removes a failed acknowledgment without re-registering its source", async () => {
    const h = setup();
    const spool = new ChangeEvidenceSpool();
    const source = spoolSource(spool);
    // A malformed frame exercises the real ingress path without creating a binding.
    source.read = async () => ({
      ...spool.read(0),
      entries: [{ type: "frame", seq: 1, frame: {} } as never],
      nextCursor: 1,
    });
    source.ack = async () => {
      throw new Error("ack unavailable");
    };
    await h.service.pullEvidence(source);
    const ackKey = `pending-evidence-ack:${source.sourceKey}`;
    expect(h.service.ledger.cursor(source.sourceKey)?.cursor).toBe(1);
    expect(h.service.ledger.meta(ackKey)).not.toBeNull();
    expect(count(h, "change_evidence_gaps")).toBe(1);
    h.service.shutdown();
    const restarted = new ChangeTrackingService({
      dataDir: h.dataDir,
      database: () => h.database(),
      emit: () => undefined,
      environmentTarget: async () => ({ kind: "local", worktreePath: h.repo }),
      durable: false,
      manualScheduling: true,
    });
    try {
      restarted.start();
      restarted.environmentDeleted("env-1");
      await restarted.retention.run(Date.now() + 2 * HOUR);
      expect(count(h, "change_evidence_gaps")).toBe(0);
      expect(restarted.ledger.cursor(source.sourceKey)).toBeNull();
      expect(restarted.ledger.meta(ackKey)).toBeNull();
      expect(restarted.ledger.evidenceSources("env-1")).toEqual([]);
      await restarted.retention.run(Date.now() + 100 * DAY);
      expect(restarted.ledger.cursor(source.sourceKey)).toBeNull();
      expect(restarted.ledger.meta(ackKey)).toBeNull();
    } finally {
      restarted.shutdown();
    }
  });

  test("retried deletion keeps the original worktrees, sources and request time", async () => {
    const h = setup();
    await runTurn(h, "env-1", "retry");
    await recordEdit(h, "env-1", "retry");
    h.service.environmentDeleted("env-1");
    const original = h.service.retention.purges.pendingPurges()[0]!;
    await h.service.retention.run();
    // Purging consumed the rows that originally named the worktree.
    expect(h.service.retention.purges.environmentWorktrees("env-1")).toEqual([]);
    h.service.environmentDeleted("env-1");
    expect(h.service.retention.purges.pendingPurges()[0]).toEqual(original);
    // Also preserve metadata if a caller retries with no discovered ownership.
    h.service.retention.purges.requestPurge({
      environmentId: "env-1",
      requestedAt: new Date(Date.now() + HOUR).toISOString(),
      worktreeIds: [],
      sourceKeys: [],
    });
    expect(h.service.retention.purges.pendingPurges()[0]).toEqual(original);
    await h.service.retention.run(Date.now() + 2 * HOUR);
    expect(count(h, "change_worktrees")).toBe(0);
    expect(count(h, "change_evidence_cursors")).toBe(0);
    expect(h.service.retention.purges.pendingPurges()).toEqual([]);
  });

  test("purges its ledger rows, evidence bodies and objects, and no more than that", async () => {
    const h = setup();
    await runTurn(h, "env-1", "r1");
    await recordEdit(h, "env-1", "c1");
    await scanEnvironment(h, "env-1");
    const binding = h.service.ledger.db.query("SELECT id FROM change_bindings").get() as {
      id: string;
    };
    h.service.ledger.transaction(() =>
      h.service.ledger.recordGap({
        gapId: "gap",
        bindingId: binding.id,
        coverageJson: "{}",
        reason: "test",
      }),
    );
    expect(count(h, "change_evidence_gaps")).toBe(1);
    expect(count(h, "change_evidence_bodies")).toBeGreaterThan(0);
    expect(await h.service.bodies.storedBytes()).toBeGreaterThan(0);
    expect(await h.service.objects.storedBytes()).toBeGreaterThan(0);

    h.service.environmentDeleted("env-1");
    const report = await h.service.retention.run(Date.now() + 2 * HOUR);

    expect(report.purgedEnvironments).toBe(1);
    expect(report.removedBodies).toBeGreaterThan(0);
    for (const table of LEDGER_TABLES_OF_ONE_ENVIRONMENT) {
      expect(`${table}: ${count(h, table)}`).toBe(`${table}: 0`);
    }
    expect(await h.service.bodies.storedBytes()).toBe(0);
    expect(await h.service.objects.storedBytes()).toBe(0);
    const left = h
      .database()
      .db.query("SELECT key FROM change_ledger_meta WHERE key NOT LIKE 'retention:%'")
      .all() as Array<{ key: string }>;
    expect(left.map((row) => row.key).filter((key) => key.includes("env-1"))).toEqual([]);
    expect(h.service.retention.purges.pendingPurges()).toEqual([]);
  });

  test("every other kind of owner an environment has goes too", async () => {
    const h = setup(["env-2"]);
    await scanEnvironment(h, "env-1");
    await scanEnvironment(h, "env-2");
    const ledger = h.service.ledger;
    const measurement = h.service.projections.selectedMeasurement(
      environmentChangeResourceKey("env-1"),
    )!;
    const seed = (id: string, owner: { kind: string; id: string }, worktreeId?: string) => {
      ledger.insertMeasurement(
        { ...measurement, measurementId: id, worktreeId: worktreeId ?? measurement.worktreeId },
        owner,
        [],
        ledger.nextSequence(),
      );
    };
    const select = (key: string, measurementId: string) =>
      ledger.swapSelection({
        key,
        selector: "live",
        expectedRevision: 0,
        baselineVersion: null,
        measurementId,
        observationEpoch: 0,
        worktreeIncarnation: null,
        ownerFence: 0,
      });
    const live = gitScopeResourceKey("uncommitted-net", "env-1");
    const pinned = gitScopeResourceKey("commit", "env-1", "abc");
    const otherLive = gitScopeResourceKey("uncommitted-net", "env-2");
    const legacyOperation = operationIdFor({
      environmentId: "env-1",
      provider: "opencode",
      conversationId: "c",
      callId: "x",
    });
    const providerTurn = "pturn_of_env_1";
    ledger.transaction(() => {
      seed("git-live", { kind: "git-uncommitted-net", id: live });
      select(live, "git-live");
      seed("git-pinned", { kind: "git-commit", id: pinned });
      select(pinned, "git-pinned");
      seed("git-other", { kind: "git-uncommitted-net", id: otherLive });
      select(otherLive, "git-other");
      seed("file", { kind: "environment-file", id: "env-1:hash" });
      seed("file-other", { kind: "environment-file", id: "env-10:hash" });
      seed("legacy", { kind: "operation", id: legacyOperation }, "legacy:env-1");
      select(toolResourceKeys(legacyOperation).observation, "legacy");
      ledger.setMeta("legacy-import:opencode:file:env-1:c", "done");
      ledger.setMeta("fork:env-1\0claude\0child", "segment");
      ledger.setMeta("conv:env-1\0claude\0c", SESSION);
      ledger.setMeta("conv:env-2\0claude\0c", SESSION);
      const binding = ledger.resolveBinding({
        sourceKey: "env-1\0claude\0b",
        environmentId: "env-1",
        provider: "claude",
        conversationId: "c",
        worktreeId: null,
      });
      seed("provider", { kind: "provider-turn", id: providerTurn });
      select(turnResourceKeys(providerTurn, providerTurn).providerTurnDiff!, "provider");
      ledger.insertEvidence({
        evidence_id: "ev",
        revision: 1,
        owner_kind: "provider-turn",
        owner_id: providerTurn,
        evidence_key: "k",
        revision_key: "r",
        replaces_revision_key: null,
        kind: "patch",
        claim: "provider-reported",
        evidence_json: "{}",
        selected: 1,
        frame_key: `${binding}\0frame`,
        ingested_seq: 1,
      });
    });

    h.service.environmentDeleted("env-1");
    await h.service.retention.run(Date.now() + 2 * HOUR);

    expect(
      (
        h.database().db.query("SELECT id FROM change_measurements ORDER BY id").all() as Array<{
          id: string;
        }>
      ).map((row) => row.id),
    ).toEqual(
      [
        "file-other",
        "git-other",
        h.service.projections.selectedMeasurement(environmentChangeResourceKey("env-2"))!
          .measurementId,
      ].sort(),
    );
    expect(
      (
        h.database().db.query("SELECT selection_key AS k FROM change_selections").all() as Array<{
          k: string;
        }>
      )
        .map((row) => row.k)
        .sort(),
    ).toEqual([environmentChangeResourceKey("env-2"), otherLive].sort());
    expect(count(h, "change_evidence")).toBe(0);
    expect(ledger.meta("legacy-import:opencode:file:env-1:c")).toBeNull();
    expect(ledger.meta("fork:env-1\0claude\0child")).toBeNull();
    expect(ledger.meta("conv:env-1\0claude\0c")).toBeNull();
    expect(ledger.meta("conv:env-2\0claude\0c")).toBe(SESSION);
  });

  test("the delete itself only tombstones and records; rows wait for the pass", async () => {
    const h = setup();
    await runTurn(h, "env-1", "r1");
    const worktreeId = h.service.ledger.turn(turnIdFor("env-1", SESSION, "r1"))!.worktree_id;
    h.service.environmentDeleted("env-1");
    expect(h.service.ledger.worktree(worktreeId)?.tombstoned_at).not.toBeNull();
    expect(count(h, "change_turn_boundaries")).toBe(1);
    expect(h.service.retention.purges.pendingPurges().map((p) => p.environmentId)).toEqual([
      "env-1",
    ]);
  });

  test("a pass soon after the delete removes rows; the entry waits out the grace", async () => {
    const h = setup();
    await runTurn(h, "env-1", "r1");
    h.service.environmentDeleted("env-1");
    const soon = await h.service.retention.run();
    expect(soon.purgedEnvironments).toBe(0);
    expect(count(h, "change_turn_boundaries")).toBe(0);
    // A late write that was already under way lands after the first pass.
    h.service.ledger.transaction(() =>
      h.service.ledger.setMeta("conv:env-1\0claude\0late", SESSION),
    );
    expect((await h.service.retention.run(Date.now() + 2 * HOUR)).purgedEnvironments).toBe(1);
    expect(h.service.ledger.meta("conv:env-1\0claude\0late")).toBeNull();
    expect(h.service.retention.purges.pendingPurges()).toEqual([]);
  });

  test("late events cannot write rows for it, and clients still hear it is gone", async () => {
    const h = setup();
    await runTurn(h, "env-1", "r1");
    h.service.environmentDeleted("env-1");
    await scanEnvironment(h, "env-1");
    expect(count(h, "change_measurements", "owner_kind = 'environment'")).toBe(0);
    expect(
      await h.service.prepareTurnStart({
        environmentId: "env-1",
        logicalSessionKey: SESSION,
        requestId: "r2",
        provider: "claude",
      }),
    ).toEqual({ kind: "untracked", reason: "environment-deleted" });
    await recordEdit(h, "env-1", "late");
    expect(count(h, "change_operations")).toBe(0);

    h.service.onDiffScanEvent({
      kind: "removed",
      environmentId: "env-1",
      at: new Date().toISOString(),
    });
    await h.service.environments.idle();
    expect(h.service.getView({ resourceKey: environmentChangeResourceKey("env-1") }).kind).toBe(
      "deleted",
    );
  });

  test("a restarted backend resumes the purge and still refuses late events", async () => {
    const h = setup();
    await runTurn(h, "env-1", "r1");
    h.service.environmentDeleted("env-1");
    const restarted = new ChangeTrackingService({
      dataDir: h.dataDir,
      database: () => h.database(),
      emit: () => undefined,
      environmentTarget: async () => ({ kind: "local", worktreePath: h.repo }),
      durable: false,
      manualScheduling: true,
    });
    restarted.start();
    expect(
      (
        await restarted.prepareTurnStart({
          environmentId: "env-1",
          logicalSessionKey: SESSION,
          requestId: "r2",
          provider: "claude",
        })
      ).kind,
    ).toBe("untracked");
    await restarted.retention.run(Date.now() + 2 * HOUR);
    expect(count(h, "change_turn_boundaries")).toBe(0);
    restarted.retention.stop();
  });

  test("a new environment at a kept checkout gets a fresh worktree row", async () => {
    const h = setup(["env-2"]);
    await runTurn(h, "env-1", "r1");
    const old = h.service.ledger.turn(turnIdFor("env-1", SESSION, "r1"))!.worktree_id;
    h.service.environmentDeleted("env-1");
    // Same path and inode, so the same identity and incarnation as the tombstone.
    const { start, turnId } = await runTurn(h, "env-2", "r1");
    expect(start.kind).toBe("ready");
    expect(h.service.ledger.turn(turnId)!.worktree_id).not.toBe(old);
    await h.service.retention.run(Date.now() + 2 * HOUR);
    expect(h.service.ledger.worktree(old)).toBeNull();
    expect(h.service.ledger.turn(turnId)).not.toBeNull();
  });

  test("a large environment goes in many short transactions", async () => {
    const h = setup();
    await runTurn(h, "env-1", "r1");
    const ledger = h.service.ledger;
    const seed = ledger.turn(turnIdFor("env-1", SESSION, "r1"))!;
    ledger.transaction(() => {
      for (let index = 0; index < 400; index++) {
        ledger.insertTurn({ ...seed, turn_id: `bulk-${index}`, ordinal: index + 10 });
      }
    });
    h.service.environmentDeleted("env-1");
    const transaction = spyOn(ledger, "transaction");
    await h.service.retention.run();
    expect(count(h, "change_turn_boundaries")).toBe(0);
    expect(transaction.mock.calls.length).toBeGreaterThan(1);
    transaction.mockRestore();
  });
});

describe("content another environment shares", () => {
  test("a snapshot both environments reference survives the first purge", async () => {
    const h = setup(["env-2"]);
    for (const environmentId of ["env-1", "env-2"]) {
      await h.service.prepareTurnStart({
        environmentId,
        logicalSessionKey: SESSION,
        requestId: "r1",
        provider: "claude",
      });
      h.service.markTurnDispatched(environmentId, SESSION, "r1", "accepted");
    }
    const worktreeId = h.service.ledger.turn(turnIdFor("env-1", SESSION, "r1"))!.worktree_id;
    const owner = h.service.registry.ownerById(worktreeId)!;
    writeFileSync(join(h.repo, "shared.txt"), "shared\n");
    await h.service.turns.provisional("env-1", owner);
    const segmentOf = (environmentId: string) =>
      h.service.ledger.currentSegment(threadIdFor(environmentId, SESSION))!;
    const shared = segmentOf("env-1").latest_live_snapshot_id!;
    expect(segmentOf("env-2").latest_live_snapshot_id).toBe(shared);
    const tree = h.service.ledger.snapshot(shared)!.tree_oid;

    h.service.environmentDeleted("env-1");
    await h.service.retention.run(Date.now() + 2 * HOUR);

    expect(h.service.ledger.worktree(worktreeId)?.tombstoned_at).toBeNull();
    expect(h.service.ledger.snapshot(shared)).not.toBeNull();
    expect(await h.service.objects.has(tree)).toBe(true);
    expect(count(h, "change_turn_boundaries", "environment_id = 'env-1'")).toBe(0);
    expect(count(h, "change_turn_boundaries", "environment_id = 'env-2'")).toBe(1);

    h.service.environmentDeleted("env-2");
    await h.service.retention.run(Date.now() + 2 * HOUR);
    expect(h.service.ledger.snapshot(shared)).toBeNull();
    expect(await h.service.objects.has(tree)).toBe(false);
    expect(h.service.ledger.worktree(worktreeId)).toBeNull();
  });

  test("an evidence body another environment names survives the first purge", async () => {
    const h = setup(["env-2"]);
    await recordEdit(h, "env-1", "c1", "the same body\n");
    await recordEdit(h, "env-2", "c1", "the same body\n");
    const bodyId = bodyIdFor(new TextEncoder().encode("the same body\n"));
    expect(await h.service.bodies.get(bodyId)).not.toBeNull();
    const operationOf = (environmentId: string) =>
      operationIdFor({
        environmentId,
        provider: "claude",
        conversationId: CONVERSATION,
        callId: "c1",
      });

    h.service.environmentDeleted("env-1");
    const first = await h.service.retention.run(Date.now() + 2 * HOUR);

    expect(h.service.ledger.operation(operationOf("env-1"))).toBeNull();
    expect(h.service.ledger.operation(operationOf("env-2"))).not.toBeNull();
    expect(await h.service.bodies.get(bodyId)).not.toBeNull();
    expect(h.service.ledger.body(bodyId)?.state).toBe("available");
    // Both environments' edits had identical sides, so env-2 names every body.
    expect(first.removedBodies).toBe(0);

    h.service.environmentDeleted("env-2");
    const second = await h.service.retention.run(Date.now() + 2 * HOUR);
    expect(await h.service.bodies.get(bodyId)).toBeNull();
    expect(h.service.ledger.body(bodyId)).toBeNull();
    expect(second.removedBodies).toBeGreaterThan(0);
  });
});

describe("a restore keeps what it needs", () => {
  async function restorable(h: Harness, environmentId: string) {
    writeFileSync(join(h.repo, "a.txt"), "before\n");
    const { turnId } = await runTurn(h, environmentId, "r1", "after");
    const measurementId = h.service.ledger.latestMeasurement(
      "turn",
      turnId,
      "turn-net",
    )!.measurementId;
    const preview = await h.service.restore.prepare({ measurementId });
    if (preview.kind !== "preview") throw new Error(`no preview: ${preview.kind}`);
    return { turnId, measurementId, token: preview.actionToken };
  }

  const measurementRows = (h: Harness, id: string) =>
    count(h, "change_measurement_files", "measurement_id = ?", id);

  for (const mode of ["purge", "age"] as const) {
    test(`an applied restore releases its checkpoint during ${mode}`, async () => {
      const h = setup();
      const { token } = await restorable(h, "env-1");
      expect(
        (await h.service.restore.apply({ actionToken: token, idempotencyKey: mode })).kind,
      ).toBe("applied");
      expect(count(h, "change_references", "owner_kind = 'restore'")).toBeGreaterThan(0);
      if (mode === "purge") h.service.environmentDeleted("env-1");
      await h.service.retention.run(Date.now() + 92 * DAY);
      expect(count(h, "change_restore_operations")).toBe(0);
      expect(count(h, "change_references", "owner_kind = 'restore'")).toBe(0);
      if (mode === "purge") {
        expect(count(h, "change_snapshots")).toBe(0);
        expect(count(h, "change_worktrees")).toBe(0);
        expect(await h.service.objects.storedBytes()).toBe(0);
      }
    });
  }

  test("an unexpired token defers the purge, and it runs once the token expires", async () => {
    const h = setup();
    const { turnId, measurementId } = await restorable(h, "env-1");
    expect(measurementRows(h, measurementId)).toBeGreaterThan(0);
    const measurement = h.service.ledger.measurement(measurementId)!;
    h.service.environmentDeleted("env-1");

    const during = await h.service.retention.run(Date.now() + 60_000);
    expect(during.purgesWaiting).toBe(true);
    expect(h.service.ledger.measurement(measurementId)).not.toBeNull();
    expect(measurementRows(h, measurementId)).toBeGreaterThan(0);
    expect(h.service.ledger.turn(turnId)).not.toBeNull();
    expect(h.service.ledger.snapshot(measurement.beforeSnapshotId!)).not.toBeNull();
    expect(h.service.ledger.snapshot(measurement.afterSnapshotId!)).not.toBeNull();

    const after = await h.service.retention.run(Date.now() + 2 * HOUR);
    expect(after.purgesWaiting).toBe(false);
    expect(h.service.ledger.measurement(measurementId)).toBeNull();
    expect(count(h, "change_restore_tokens")).toBe(0);
    expect(h.service.ledger.turn(turnId)).toBeNull();
  });

  test("a token on another environment's measurement does not hold this purge", async () => {
    const h = setup(["env-2"]);
    const { measurementId } = await restorable(h, "env-2");
    await runTurn(h, "env-1", "other");
    h.service.environmentDeleted("env-1");
    const report = await h.service.retention.run(Date.now() + 60_000);
    expect(report.purgesWaiting).toBe(false);
    expect(count(h, "change_turn_boundaries", "environment_id = 'env-1'")).toBe(0);
    expect(h.service.ledger.measurement(measurementId)).not.toBeNull();
  });

  test("a running restore holds the purge past its token's expiry", async () => {
    const h = setup();
    const { token, measurementId } = await restorable(h, "env-1");
    h.service.ledger.transaction(() => {
      h.service.ledger.consumeRestoreToken(token);
      h.service.ledger.insertRestoreOperation({
        id: "op",
        idempotencyKey: "key",
        token,
        measurementId,
      });
    });
    h.service.environmentDeleted("env-1");
    const later = Date.now() + 2 * HOUR;
    expect((await h.service.retention.run(later)).purgesWaiting).toBe(true);
    expect(h.service.ledger.measurement(measurementId)).not.toBeNull();
    expect(h.service.ledger.restoreOperationByKey("key")).not.toBeNull();

    h.service.ledger.transaction(() =>
      h.service.ledger.finishRestoreOperation("op", "applied", "{}"),
    );
    expect((await h.service.retention.run(later)).purgesWaiting).toBe(false);
    expect(h.service.ledger.measurement(measurementId)).toBeNull();
    expect(h.service.ledger.restoreOperationByKey("key")).toBeNull();
  });

  test("an alias can still apply its token after the other environment's purge", async () => {
    const h = setup(["env-2"]);
    const { token } = await restorable(h, "env-2");
    await runTurn(h, "env-1", "other", "after");
    h.service.environmentDeleted("env-1");
    await h.service.retention.run(Date.now() + 60_000);
    const applied = await h.service.restore.apply({ actionToken: token, idempotencyKey: "alias" });
    expect(applied.kind).toBe("applied");
  });

  test("quota pressure cannot take the endpoints of an unexpired token", async () => {
    const h = setup();
    const { turnId, measurementId } = await restorable(h, "env-1");
    const measurement = h.service.ledger.measurement(measurementId)!;
    h.service.policies.update({ snapshotSoftBudgetBytes: 0 }, "pressure");
    const during = await h.service.retention.run(Date.now() + 2 * 60_000);
    expect(during.releasedForQuota).toBeGreaterThan(0);
    expect(count(h, "change_references", "owner_kind = 'turn' AND owner_id = ?", turnId)).toBe(0);
    // A fresh snapshot is inside the grace in any case: pass the grace with the token live.
    const token = h.service.ledger.db.query("SELECT token FROM change_restore_tokens").get() as {
      token: string;
    };
    h.service.ledger.db
      .query("UPDATE change_restore_tokens SET expires_at = ? WHERE token = ?")
      .run(new Date(Date.now() + 3 * HOUR).toISOString(), token.token);
    await h.service.retention.run(Date.now() + 2 * HOUR);
    expect(h.service.ledger.snapshot(measurement.beforeSnapshotId!)).not.toBeNull();
    expect(h.service.ledger.snapshot(measurement.afterSnapshotId!)).not.toBeNull();
  });
});

describe("age-based retention", () => {
  const PAST_WINDOW = 31 * DAY;

  test("nothing inside the window is touched", async () => {
    const h = setup();
    const { turnId } = await runTurn(h, "env-1", "r1");
    await recordEdit(h, "env-1", "c1");
    const report = await h.service.retention.run(Date.now() + 29 * DAY);
    expect(report.retiredRows).toBe(0);
    expect(h.service.ledger.latestMeasurement("turn", turnId, "turn-net")).not.toBeNull();
    expect(count(h, "change_frames")).toBeGreaterThan(0);
    expect(count(h, "change_operations")).toBe(1);
  });

  test("a finished turn past the window keeps only its boundary row", async () => {
    const h = setup();
    const { turnId } = await runTurn(h, "env-1", "r1");
    await recordEdit(h, "env-1", "c1");
    const ledger = h.service.ledger;
    const operationId = operationIdFor({
      environmentId: "env-1",
      provider: "claude",
      conversationId: CONVERSATION,
      callId: "c1",
    });
    ledger.transaction(() => {
      ledger.setMeta(`opturn:${operationId}`, turnId);
      ledger.setMeta(`turnops:${turnId}`, JSON.stringify([operationId]));
      ledger.setMeta(`pturn:${turnId}`, "provider-turn");
    });
    ledger.transaction(() => {
      for (const suffix of ["one", "two"]) {
        ledger.reserveCapture({
          boundaryKey: `turn-recover:${turnId}:${suffix}`,
          worktreeId: ledger.turn(turnId)!.worktree_id,
          ownerEpoch: 1,
          requiredAfterBoundarySeq: 0,
          purpose: "turn-recovery",
          deadlineAt: new Date(Date.now() + PAST_WINDOW * 2).toISOString(),
        });
      }
    });
    expect(count(h, "change_capture_attempts", "purpose = 'turn-recovery'")).toBe(2);
    const key = turnResourceKeys(turnId, null).turnNet;

    const report = await h.service.retention.run(Date.now() + PAST_WINDOW);

    expect(report.retiredRows).toBeGreaterThan(0);
    expect(report.releasedForQuota).toBe(1);
    expect(ledger.latestMeasurement("turn", turnId, "turn-net")).toBeNull();
    expect(ledger.selection(key)).toBeNull();
    expect(count(h, "change_frames")).toBe(0);
    expect(count(h, "change_operations")).toBe(0);
    expect(count(h, "change_evidence")).toBe(0);
    expect(count(h, "change_evidence_bodies")).toBe(0);
    expect(count(h, "change_capture_attempts")).toBe(0);
    expect(count(h, "change_references", "owner_kind = 'turn'")).toBe(0);
    expect(ledger.meta(`opturn:${operationId}`)).toBeNull();
    expect(ledger.meta(`turnops:${turnId}`)).toBeNull();
    expect(ledger.meta(`pturn:${turnId}`)).toBeNull();
    expect(await h.service.bodies.storedBytes()).toBe(0);

    // History still lists it, in order, and its view says why there is no detail.
    const history = h.service.getHistory({ environmentId: "env-1", logicalSessionKey: SESSION });
    if (history.kind !== "page") throw new Error("page expected");
    expect(history.entries.map((entry) => [entry.turnId, entry.measurementId])).toEqual([
      [turnId, null],
    ]);
    const view = h.service.getView({ resourceKey: key });
    if (view.kind !== "projection") throw new Error("projection expected");
    expect(view.projection.availability).toBe("unavailable");
    expect(view.projection.reasonKeys).toEqual(["changes.reason.history-expired"]);
    // An unknown call in an old transcript reads as an untracked one.
    expect(
      h.service.getToolPresentations({
        environmentId: "env-1",
        provider: "claude",
        conversationId: CONVERSATION,
        callIds: ["c1"],
      }).presentations.c1,
    ).toBeNull();
  });

  test("a live thread keeps its baseline, and its next turn still measures from it", async () => {
    const h = setup();
    const { turnId } = await runTurn(h, "env-1", "r1");
    const ledger = h.service.ledger;
    const segment = ledger.turn(turnId)!.segment_id;
    const baseline = ledger.segment(segment)!.baseline_snapshot_id!;

    await h.service.retention.run(Date.now() + PAST_WINDOW);

    expect(ledger.latestMeasurement("turn", turnId, "turn-net")).toBeNull();
    expect(ledger.segment(segment)?.baseline_state).toBe("active");
    expect(
      count(h, "change_references", "owner_id = ? AND reason = 'thread-baseline'", segment),
    ).toBe(1);
    expect(ledger.snapshot(baseline)).not.toBeNull();
    expect(await h.service.objects.has(ledger.snapshot(baseline)!.tree_oid)).toBe(true);

    await runTurn(h, "env-1", "r2", "next");
    expect(ledger.turn(turnIdFor("env-1", SESSION, "r2"))?.ordinal).toBe(2);
    expect(ledger.turn(turnIdFor("env-1", SESSION, "r2"))?.segment_id).toBe(segment);
    const thread = h.service.threadResource("env-1", SESSION)!;
    expect(h.service.projections.selectedMeasurement(thread.resourceKey)?.beforeSnapshotId).toBe(
      baseline,
    );
  });

  test("a closed segment with nothing retained goes with its baseline pin", async () => {
    const h = setup();
    const { turnId } = await runTurn(h, "env-1", "r1");
    const ledger = h.service.ledger;
    const segment = ledger.turn(turnId)!.segment_id;
    ledger.transaction(() =>
      ledger.updateSegment(segment, { closed_at: new Date().toISOString() }),
    );
    await h.service.retention.run(Date.now() + PAST_WINDOW);
    expect(ledger.segment(segment)).toBeNull();
    expect(count(h, "change_references", "owner_id = ?", segment)).toBe(0);
    // The boundary row stays, so a thread's ordinals stay continuous.
    expect(ledger.turn(turnId)).not.toBeNull();
    expect(ledger.nextTurnOrdinal(ledger.turn(turnId)!.thread_id)).toBe(2);
  });

  test("a closed segment with a turn still in the window stays", async () => {
    const h = setup();
    const { turnId } = await runTurn(h, "env-1", "r1");
    const ledger = h.service.ledger;
    const segment = ledger.turn(turnId)!.segment_id;
    const nowIso = new Date().toISOString();
    ledger.transaction(() => ledger.updateSegment(segment, { closed_at: nowIso }));
    ledger.transaction(() =>
      ledger.updateTurn(turnId, {
        finished_at: new Date(Date.now() + PAST_WINDOW).toISOString(),
      }),
    );
    await h.service.retention.run(Date.now() + PAST_WINDOW);
    expect(ledger.segment(segment)).not.toBeNull();
  });

  test("an operation of a running turn stays past the window", async () => {
    const h = setup();
    await h.service.prepareTurnStart({
      environmentId: "env-1",
      logicalSessionKey: SESSION,
      requestId: "r1",
      provider: "claude",
    });
    h.service.markTurnDispatched("env-1", SESSION, "r1", "accepted");
    const turnId = turnIdFor("env-1", SESSION, "r1");
    await recordEdit(h, "env-1", "c1");
    const operationId = operationIdFor({
      environmentId: "env-1",
      provider: "claude",
      conversationId: CONVERSATION,
      callId: "c1",
    });
    const ledger = h.service.ledger;
    ledger.transaction(() => ledger.setMeta(`opturn:${operationId}`, turnId));
    await h.service.retention.run(Date.now() + PAST_WINDOW);
    expect(ledger.operation(operationId)).not.toBeNull();
    expect(ledger.turn(turnId)?.lifecycle).toBe("running");
    expect(ledger.turn(turnId)?.start_snapshot_id).not.toBeNull();
    expect(count(h, "change_references", "owner_id = ?", turnId)).toBeGreaterThan(0);
  });

  test("a turn an unexpired token holds waits, and nothing behind it is lost", async () => {
    const h = setup();
    const first = await runTurn(h, "env-1", "r1", "one");
    const second = await runTurn(h, "env-1", "r2", "two");
    const ledger = h.service.ledger;
    const held = ledger.latestMeasurement("turn", first.turnId, "turn-net")!.measurementId;
    const future = Date.now() + PAST_WINDOW;
    ledger.transaction(() =>
      ledger.insertRestoreToken({
        token: "long",
        measurementId: held,
        payloadJson: "{}",
        ownerFence: 0,
        expiresAt: new Date(future + DAY).toISOString(),
      }),
    );
    await h.service.retention.run(future);
    expect(ledger.measurement(held)).not.toBeNull();
    expect(ledger.latestMeasurement("turn", second.turnId, "turn-net")).not.toBeNull();

    await h.service.retention.run(future + 2 * DAY);
    expect(ledger.measurement(held)).toBeNull();
    expect(ledger.latestMeasurement("turn", second.turnId, "turn-net")).toBeNull();
  });

  test("restore records, cursors, gaps and empty bindings past the window go", async () => {
    const h = setup();
    const ledger = h.service.ledger;
    const old = new Date(Date.now() - PAST_WINDOW).toISOString();
    ledger.transaction(() => {
      ledger.recordGap({ gapId: "g", bindingId: "b", coverageJson: "{}", reason: "r" });
      ledger.setCursor("source", "epoch", 3);
      ledger.setMeta("pending-evidence-ack:source", "");
      ledger.resolveBinding({
        sourceKey: "s",
        environmentId: "env-1",
        provider: "claude",
        conversationId: "c",
        worktreeId: null,
      });
      ledger.insertRestoreToken({
        token: "old",
        measurementId: "m",
        payloadJson: "{}",
        ownerFence: 0,
        expiresAt: old,
      });
      ledger.insertRestoreOperation({
        id: "done",
        idempotencyKey: "done",
        token: "old",
        measurementId: "m",
      });
      ledger.finishRestoreOperation("done", "applied", "{}");
    });
    const future = Date.now() + PAST_WINDOW;
    await h.service.retention.run(future);
    for (const table of [
      "change_evidence_gaps",
      "change_evidence_cursors",
      "change_bindings",
      "change_restore_tokens",
      "change_restore_operations",
    ]) {
      expect(`${table}: ${count(h, table)}`).toBe(`${table}: 0`);
    }
    expect(ledger.meta("pending-evidence-ack:source")).toBeNull();
  });

  test("an unsent acknowledgment keeps its cursor", async () => {
    const h = setup();
    const ledger = h.service.ledger;
    ledger.transaction(() => {
      ledger.setCursor("source", "epoch", 3);
      ledger.setMeta("pending-evidence-ack:source", '{"upTo":3}');
    });
    await h.service.retention.run(Date.now() + PAST_WINDOW);
    expect(ledger.cursor("source")).not.toBeNull();
  });

  test("a large backlog goes in batches, resuming from a durable cursor", async () => {
    const h = setup();
    const { turnId } = await runTurn(h, "env-1", "r1");
    const ledger = h.service.ledger;
    const seed = ledger.turn(turnId)!;
    ledger.transaction(() => {
      for (let index = 0; index < 200; index++) {
        ledger.insertTurn({ ...seed, turn_id: `bulk-${index}`, ordinal: index + 10 });
        ledger.addReference({
          ownerKind: "turn",
          ownerId: `bulk-${index}`,
          snapshotId: seed.start_snapshot_id!,
          reason: "turn-start",
        });
      }
    });
    const transaction = spyOn(ledger, "transaction");
    const report = await h.service.retention.run(Date.now() + PAST_WINDOW);
    expect(report.releasedForQuota).toBe(201);
    expect(count(h, "change_references", "owner_kind = 'turn'")).toBe(0);
    expect(transaction.mock.calls.length).toBeGreaterThan(201 / 16);
    transaction.mockRestore();
    expect(ledger.meta("retention:turn-cursor")).not.toBeNull();
    // A later pass walks nothing it already retired.
    const again = await h.service.retention.run(Date.now() + PAST_WINDOW);
    expect(again.releasedForQuota).toBe(0);
  });

  test("the first pass on an existing 31–89 day backlog yields between bounded batches", async () => {
    const h = setup();
    const { turnId } = await runTurn(h, "env-1", "r1");
    const seed = h.service.ledger.turn(turnId)!;
    const now = Date.now();
    h.service.ledger.transaction(() => {
      for (let index = 0; index < 200; index++) {
        const finishedAt = new Date(now - (31 + (index % 59)) * DAY).toISOString();
        h.service.ledger.insertTurn({
          ...seed,
          turn_id: `aged-${index}`,
          ordinal: index + 10,
          started_at: finishedAt,
          finished_at: finishedAt,
        });
        h.service.ledger.addReference({
          ownerKind: "turn",
          ownerId: `aged-${index}`,
          snapshotId: seed.start_snapshot_id!,
          reason: "turn-start",
        });
      }
    });
    h.service.shutdown();
    // A fresh connection/service sees committed rows from the previous instance.
    const database = openChangeLedgerDatabase(h.dataDir);
    const service = new ChangeTrackingService({
      dataDir: h.dataDir,
      database: () => database,
      emit: () => {},
      environmentTarget: async () => null,
      durable: false,
      manualScheduling: true,
    });
    const remaining = () =>
      (
        database.db
          .query(
            "SELECT COUNT(*) AS n FROM change_references WHERE owner_kind = 'turn' AND owner_id LIKE 'aged-%'",
          )
          .get() as { n: number }
      ).n;
    const observed: number[] = [];
    const timer = setInterval(() => observed.push(remaining()), 0);
    const transaction = service.ledger.transaction.bind(service.ledger);
    const deletedPerTransaction: number[] = [];
    const probe = spyOn(service.ledger, "transaction").mockImplementation((fn) => {
      const before = remaining();
      const result = transaction(fn);
      deletedPerTransaction.push(before - remaining());
      return result;
    });
    try {
      expect(service.policies.policy.archivedBodyRetentionDays).toBe(30);
      const report = await service.retention.run(now);
      expect(report.releasedForQuota).toBe(200);
      expect(remaining()).toBe(0);
      expect(observed.some((n) => n > 0 && n < 200)).toBe(true);
      const productive = deletedPerTransaction.filter((n) => n > 0);
      expect(productive.length).toBeGreaterThan(1);
      expect(Math.max(...productive)).toBeLessThanOrEqual(16);
      // The recent turn is still retained; boundary history stays for every turn.
      expect(service.ledger.latestMeasurement("turn", turnId, "turn-net")).not.toBeNull();
      expect(count(h, "change_turn_boundaries")).toBe(201);
      expect((await service.retention.run(now)).releasedForQuota).toBe(0);
    } finally {
      clearInterval(timer);
      probe.mockRestore();
      service.shutdown();
      database.close();
    }
  });

  test("the age walk seeks its index rather than scanning every boundary", async () => {
    const h = setup();
    await h.service.retention.run();
    const plan = h
      .database()
      .db.query(
        `EXPLAIN QUERY PLAN SELECT turn_id FROM change_turn_boundaries
         WHERE (COALESCE(finished_at, started_at), turn_id) > ('', '')
           AND COALESCE(finished_at, started_at) < 'z'
         ORDER BY COALESCE(finished_at, started_at), turn_id LIMIT 16`,
      )
      .all() as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join("\n")).toContain("change_turn_boundaries_age");
  });
});

describe("active turns", () => {
  const STATES = [
    ["preparing-start", true],
    ["start-ready", true],
    ["start-unavailable", true],
    ["running", true],
    ["settling", true],
    ["capturing-end", true],
    ["finalized", false],
    ["interrupted", false],
    ["end-unavailable", false],
    ["abandoned", false],
  ] as const;

  test("every lifecycle state answers as it did under the old NOT IN", async () => {
    const h = setup();
    const { turnId } = await runTurn(h, "env-1", "r1");
    const ledger = h.service.ledger;
    const seed = ledger.turn(turnId)!;
    ledger.transaction(() => {
      ledger.updateTurn(turnId, { lifecycle: "finalized" });
      for (const [lifecycle] of STATES) {
        ledger.insertTurn({ ...seed, turn_id: `state-${lifecycle}`, lifecycle });
      }
    });
    const active = new Set(ledger.activeTurns().map((turn) => turn.lifecycle as string));
    for (const [lifecycle, expected] of STATES) {
      expect(`${lifecycle}: ${active.has(lifecycle)}`).toBe(`${lifecycle}: ${expected}`);
    }
    const old = h
      .database()
      .db.query(
        "SELECT lifecycle FROM change_turn_boundaries WHERE lifecycle NOT IN ('finalized', 'interrupted', 'end-unavailable', 'abandoned')",
      )
      .all() as Array<{ lifecycle: string }>;
    expect([...active].sort()).toEqual(old.map((row) => row.lifecycle).sort());
  });

  test("the query seeks the lifecycle index", async () => {
    const h = setup();
    const statements: string[] = [];
    const db = h.database().db;
    const query = spyOn(db, "query");
    h.service.ledger.activeTurns();
    for (const call of query.mock.calls) statements.push(String(call[0]));
    query.mockRestore();
    expect(statements).toHaveLength(1);
    const plan = db.query(`EXPLAIN QUERY PLAN ${statements[0]}`).all() as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "USING INDEX change_turn_boundaries_lifecycle",
    );
  });
});

describe("the evidence body store's sweep", () => {
  function store(h: Harness) {
    const root = join(h.dataDir, "bodies-under-test");
    mkdirSync(root, { recursive: true });
    return { root, bodies: new EvidenceBodyStore(root, false) };
  }
  const bytes = (text: string) => new TextEncoder().encode(text);

  test("takes only old, unreachable bodies, and forgets each it removes", async () => {
    const h = setup();
    const { bodies } = store(h);
    const kept = bytes("kept");
    const orphan = bytes("orphan");
    await bodies.put(bodyIdFor(kept), kept);
    await bodies.put(bodyIdFor(orphan), orphan);
    const forgotten: string[] = [];
    const nowMs = Date.now();
    const young = await bodies.sweep(new Set([bodyIdFor(kept)]), HOUR, nowMs, (id) =>
      forgotten.push(id),
    );
    expect(young.removed).toBe(0);
    const old = await bodies.sweep(new Set([bodyIdFor(kept)]), HOUR, nowMs + 2 * HOUR, (id) =>
      forgotten.push(id),
    );
    expect(old).toEqual({ removed: 1, bytes: orphan.length });
    expect(forgotten).toEqual([bodyIdFor(orphan)]);
    expect(await bodies.get(bodyIdFor(kept))).not.toBeNull();
    expect(await bodies.get(bodyIdFor(orphan))).toBeNull();
  });

  test("adopting a stored body renews its fence, so a sweep walking now keeps it", async () => {
    const h = setup();
    const { root, bodies } = store(h);
    const body = bytes("adopted");
    const id = bodyIdFor(body);
    await bodies.put(id, body);
    const hex = id.slice("sha256:".length);
    const file = join(root, hex.slice(0, 2), hex.slice(2));
    const past = new Date(Date.now() - 3 * HOUR);
    utimesSync(file, past, past);
    expect(await bodies.reuse(id)).toBe(true);
    const swept = await bodies.sweep(new Set(), HOUR, Date.now(), () => undefined);
    expect(swept.removed).toBe(0);
    utimesSync(file, past, past);
    expect(await bodies.put(id, body)).toBe(true);
    expect((await bodies.sweep(new Set(), HOUR, Date.now(), () => undefined)).removed).toBe(0);
  });

  test("a body gone from disk cannot be adopted", async () => {
    const h = setup();
    const { root, bodies } = store(h);
    const body = bytes("gone");
    const id = bodyIdFor(body);
    await bodies.put(id, body);
    const hex = id.slice("sha256:".length);
    rmSync(join(root, hex.slice(0, 2), hex.slice(2)));
    expect(await bodies.reuse(id)).toBe(false);
    expect(await bodies.reuse("not-a-body-id")).toBe(false);
  });

  test("abandoned temporaries go, a temporary in use does not", async () => {
    const h = setup();
    const { root, bodies } = store(h);
    const directory = join(root, "ab");
    mkdirSync(directory, { recursive: true });
    const temp = join(directory, `${"c".repeat(62)}.uuid.tmp`);
    writeFileSync(temp, "partial");
    expect((await bodies.sweep(new Set(), HOUR, Date.now(), () => undefined)).removed).toBe(0);
    const forgotten: string[] = [];
    await bodies.sweep(new Set(), HOUR, Date.now() + 2 * HOUR, (id) => forgotten.push(id));
    expect(forgotten).toEqual([]);
    expect(await Bun.file(temp).exists()).toBe(false);
  });

  test("ingestion fetches a body again when its record outlived the file", async () => {
    const h = setup();
    await recordEdit(h, "env-1", "c1", "again\n");
    const bodyId = bodyIdFor(bytes("again\n"));
    const hex = bodyId.slice("sha256:".length);
    rmSync(join(h.dataDir, "change-tracking", "evidence-bodies", hex.slice(0, 2), hex.slice(2)));
    expect(h.service.ledger.body(bodyId)?.state).toBe("available");
    await recordEdit(h, "env-1", "c2", "again\n");
    expect(await h.service.bodies.get(bodyId)).not.toBeNull();
  });
});

describe("retirement regressions", () => {
  test("a pin admitted between purge transactions stops later batches", async () => {
    const h = setup();
    const { turnId } = await runTurn(h, "env-1", "later");
    const ledger = h.service.ledger;
    const measurement = ledger.latestMeasurement("turn", turnId, "turn-net")!.measurementId;
    await recordEdit(h, "env-1", "bulk");
    const seed = ledger.db.query("SELECT * FROM change_evidence LIMIT 1").get() as Parameters<
      typeof ledger.insertEvidence
    >[0];
    for (let i = 1; i <= 600; i++)
      ledger.insertEvidence({ ...seed, revision: i + 10, revision_key: `extra-${i}` });
    h.service.environmentDeleted("env-1");
    const purges = h.service.retention.purges;
    const original = purges.purgeEnvironmentBatch.bind(purges);
    let release = () => {};
    let batches = 0;
    const spy = spyOn(purges, "purgeEnvironmentBatch").mockImplementation((...args) => {
      const result = original(...args);
      if (++batches === 1) release = ledger.pinMeasurement(measurement);
      return result;
    });
    expect((await h.service.retention.run()).purgesWaiting).toBe(true);
    expect(ledger.measurement(measurement)).not.toBeNull();
    expect(count(h, "change_measurement_files", "measurement_id = ?", measurement)).toBeGreaterThan(
      0,
    );
    spy.mockRestore();
    release();
    await h.service.retention.run(Date.now() + 2 * HOUR);
    expect(ledger.measurement(measurement)).toBeNull();
    // A completed purge releases the process-local admission block.
    await runTurn(h, "env-1", "reused");
    expect(ledger.turn(turnIdFor("env-1", SESSION, "reused"))).not.toBeNull();
  });

  test("a large evidence stream and pinned selection range obey every batch budget", async () => {
    const h = setup();
    const { turnId } = await runTurn(h, "env-1", "budget");
    await recordEdit(h, "env-1", "bulk");
    const ledger = h.service.ledger;
    const measurementId = ledger.latestMeasurement("turn", turnId, "turn-net")!.measurementId;
    const seed = ledger.db.query("SELECT * FROM change_evidence LIMIT 1").get() as Parameters<
      typeof ledger.insertEvidence
    >[0];
    for (let i = 1; i <= 1000; i++) {
      ledger.insertEvidence({ ...seed, revision: i + 10, revision_key: `extra-${i}` });
      ledger.db
        .query("INSERT INTO change_diff_identities VALUES (?, ?, ?, ?)")
        .run(`identity-${i}`, measurementId, "{}", "2026-01-01");
      ledger.db
        .query("INSERT INTO change_evidence_chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(seed.evidence_id, seed.revision_key, "target", i, `chunk-${i}`, i, "body", 0);
      ledger.db
        .query(
          "INSERT INTO change_selections (selection_key, measurement_id, selector, revision, updated_at) VALUES (?, ?, 'latest', 1, '2026-01-01')",
        )
        .run(`commit/environment/env-1%40${i}/pinned`, "missing");
    }
    let done = false;
    for (let i = 0; i < 500 && !done; i++) {
      const before = (ledger.db.query("SELECT total_changes() AS n").get() as { n: number }).n;
      const result = h.service.retention.purges.purgeEnvironmentBatch("env-1", 17);
      const after = (ledger.db.query("SELECT total_changes() AS n").get() as { n: number }).n;
      expect(after - before).toBeLessThanOrEqual(17);
      expect(result.rows).toBe(after - before);
      done = result.done;
    }
    expect(done).toBe(true);
    expect(count(h, "change_evidence")).toBe(0);
    expect(count(h, "change_evidence_chunks")).toBe(0);
    expect(count(h, "change_selections")).toBe(0);
  });

  test("append targets and chunk bodies remain reachable until their evidence retires", async () => {
    const h = setup();
    await recordEdit(h, "env-1", "append");
    const ledger = h.service.ledger;
    const ids: string[] = [];
    for (const value of ["append target", "append chunk", "metadata target"]) {
      const bytes = new TextEncoder().encode(value);
      const id = bodyIdFor(bytes);
      ids.push(id);
      await h.service.bodies.put(id, bytes);
    }
    const row = ledger.db
      .query("SELECT evidence_id, revision_key FROM change_evidence LIMIT 1")
      .get() as { evidence_id: string; revision_key: string };
    ledger.db
      .query("UPDATE change_evidence SET evidence_json = ? WHERE evidence_id = ?")
      .run(JSON.stringify({ appendOf: { targetBodyId: ids[2] } }), row.evidence_id);
    ledger.db
      .query("INSERT INTO change_evidence_chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.evidence_id, row.revision_key, ids[0]!, 0, "chunk", 0, ids[1]!, 1);
    await h.service.retention.run(Date.now() + 2 * HOUR);
    for (const id of ids) expect(await h.service.bodies.get(id)).not.toBeNull();
    h.service.environmentDeleted("env-1");
    await h.service.retention.run(Date.now() + 3 * HOUR);
    for (const id of ids) expect(await h.service.bodies.get(id)).toBeNull();
  });
});

describe("production retention scheduling", () => {
  test("starts first and hourly timers, retries waiting purges, logs failures and clears timers on shutdown", async () => {
    const { configureLogger, resetLogger } = await import("@orkestrator/protocol/logger");
    const records: string[] = [];
    configureLogger({ level: "warn", sink: (output) => records.push(output.line) });
    const timeout = spyOn(globalThis, "setTimeout");
    const interval = spyOn(globalThis, "setInterval");
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
    const clearIntervalSpy = spyOn(globalThis, "clearInterval");
    const h = createHarness({ manualScheduling: false });
    harnesses.push(h);
    const run = spyOn(h.service.retention, "run");
    const first = timeout.mock.calls.find((call) => call[1] === 120_000)!;
    expect(first).toBeDefined();
    expect(interval.mock.calls.some((call) => call[1] === HOUR)).toBe(true);
    try {
      // Obtain a genuine report before replacing the scheduled pass.
      const base = await h.service.retention.run();
      run.mockResolvedValue({ ...base, purgesWaiting: true });
      (first[0] as () => void)();
      await Promise.resolve();
      const retry = timeout.mock.calls.find((call) => call[1] === 30_000)!;
      expect(retry).toBeDefined();
      expect(h.service.lastRetention()).toMatchObject({
        outcome: "completed",
        failedPasses: 0,
        report: { purgesWaiting: true },
      });
      run.mockRejectedValue(new Error("retention test failure"));
      (retry[0] as () => void)();
      await Promise.resolve();
      await Promise.resolve();
      expect(records.some((line) => line.includes("retention.failed"))).toBe(true);
      expect(h.service.lastRetention()).toMatchObject({
        outcome: "failed",
        failedPasses: 1,
        report: null,
      });
      h.service.shutdown();
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(clearIntervalSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      run.mockRestore();
      timeout.mockRestore();
      interval.mockRestore();
      clearTimeoutSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      resetLogger();
    }
  });
});
