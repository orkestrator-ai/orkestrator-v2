/**
 * Background recovery of turn ends whose capture timed out (todo 7310 task 1).
 * A finalization deadline of 0 makes every end capture time out at once; the
 * retry has its own deadline.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeMeasurement } from "@orkestrator/protocol/change-measurements";
import type { ProviderChangeCapabilities } from "@orkestrator/protocol/change-evidence";
import { ChangeEvidenceRecorder } from "@orkestrator/protocol/node/change-tracking/evidence-builders";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import { HostCaptureExecutor } from "./capture.js";
import { openChangeLedgerDatabase } from "./ledger-schema.js";
import type { ChangeTrackingPolicy } from "./policy-registry.js";
import { ChangeTrackingService } from "./service.js";
import { createHarness, spoolSource, type Harness } from "./service-test-support.js";
import { turnIdFor } from "./turn-boundaries.js";

const SESSION = "env-env-1:tab";
const TIMED_OUT: Partial<ChangeTrackingPolicy> = { finalizationDeadlineMs: 0 };

const harnesses: Harness[] = [];
const extraCleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of extraCleanups.splice(0)) cleanup();
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

function harness(options: Parameters<typeof createHarness>[0] = {}): Harness {
  const created = createHarness(options);
  harnesses.push(created);
  return created;
}

const turnId = (requestId: string, environmentId = "env-1", session = SESSION) =>
  turnIdFor(environmentId, session, requestId);

async function startTurn(
  service: ChangeTrackingService,
  requestId: string,
  environmentId = "env-1",
  session = SESSION,
) {
  const start = await service.prepareTurnStart({
    environmentId,
    logicalSessionKey: session,
    requestId,
    provider: "claude",
  });
  service.markTurnDispatched(environmentId, session, requestId, "accepted");
  return start;
}

function finishTurn(
  service: ChangeTrackingService,
  requestId: string,
  environmentId = "env-1",
  session = SESSION,
) {
  return service.finalizeTurn({ environmentId, logicalSessionKey: session, requestId });
}

/** A turn that edits `a.txt` and adds `b.txt`, whose end capture times out. */
async function timedOutTurn(h: Harness, requestId = "r1") {
  await startTurn(h.service, requestId);
  writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(h.repo, "b.txt"), "added\n");
  await finishTurn(h.service, requestId);
  const row = h.service.ledger.turn(turnId(requestId))!;
  expect(row.lifecycle).toBe("end-unavailable");
  expect(row.reason).toBe("capture-timeout");
}

function turnMeasurement(service: ChangeTrackingService, requestId: string): ChangeMeasurement {
  const measurement = service.ledger.latestMeasurement("turn", turnId(requestId), "turn-net");
  if (!measurement) throw new Error("no turn measurement");
  return measurement;
}

function awaiting(service: ChangeTrackingService): string[] {
  return service.ledger.turnsAwaitingEndRecovery(10).map((turn) => turn.turn_id);
}

describe("end capture recovery", () => {
  test("a turn whose end capture timed out is measured later and becomes restorable", async () => {
    const h = harness({ policy: TIMED_OUT });
    await timedOutTurn(h);
    const unavailable = turnMeasurement(h.service, "r1");
    expect(unavailable.afterSnapshotId).toBeNull();
    expect(await h.service.restore.prepare({ measurementId: unavailable.measurementId })).toEqual({
      kind: "disabled",
      reasonKey: "changes.restore.no-retained-endpoints",
    });
    expect(awaiting(h.service)).toEqual([turnId("r1")]);

    const result = await h.service.endRecovery.attempt(turnId("r1"));
    expect(result.kind).toBe("recovered");

    const row = h.service.ledger.turn(turnId("r1"))!;
    // The turn's own end stays unavailable; the later observation supersedes its measurement.
    expect(row.lifecycle).toBe("end-unavailable");
    expect(row.end_snapshot_id).toBeNull();
    expect(row.reason).toBe("end-captured-later");
    const recovered = turnMeasurement(h.service, "r1");
    expect(recovered.supersedesMeasurementId).toBe(unavailable.measurementId);
    expect(recovered.finality).toBe("final");
    expect(recovered.boundary).toEqual({ before: "fresh-before", after: "later-recovery" });
    expect(recovered.totals.additions.value).toBe(2);
    expect(recovered.completeness.reasons).toContain("end-captured-later");
    expect(h.service.ledger.measurement(unavailable.measurementId)).toEqual(unavailable);
    const thread = h.service.threadResource("env-1", SESSION)!;
    expect(h.service.projections.selectedMeasurement(thread.resourceKey)?.boundary.after).toBe(
      "later-recovery",
    );
    expect(awaiting(h.service)).toEqual([]);
    // Once recovered it is not retried.
    expect(await h.service.endRecovery.attempt(turnId("r1"))).toEqual({
      kind: "done",
      reason: "not-eligible",
    });

    const preview = await h.service.restore.prepare({ measurementId: recovered.measurementId });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect(preview.files.map((file) => file.action).sort()).toEqual(["delete", "write"]);
    const applied = await h.service.restore.apply({
      actionToken: preview.actionToken,
      idempotencyKey: "undo-r1",
    });
    expect(applied).toMatchObject({ kind: "applied", outcome: "complete" });
    expect(readFileSync(join(h.repo, "a.txt"), "utf8")).toBe("one\ntwo\n");
    expect(existsSync(join(h.repo, "b.txt"))).toBe(false);
  });

  for (const restart of [false, true]) {
    for (const failedScope of ["turn-net", "thread-net"]) {
      test(`publication resumes after a partial failure (restart=${restart}, scope=${failedScope})`, async () => {
        const h = harness({ policy: TIMED_OUT });
        await timedOutTurn(h);
        const measure = h.service.measurements.measureSnapshots.bind(h.service.measurements);
        const failure = spyOn(h.service.measurements, "measureSnapshots").mockImplementation(
          async (input) => {
            if (input.scope === failedScope) throw new Error("publication failed");
            return measure(input);
          },
        );
        await expect(h.service.endRecovery.attempt(turnId("r1"))).rejects.toThrow(
          "publication failed",
        );
        failure.mockRestore();
        const recoveredId = turnMeasurement(h.service, "r1").measurementId;
        const snapshot = h.service.ledger.pendingEndRecoverySnapshot(turnId("r1"));
        expect(snapshot).not.toBeNull();
        expect(awaiting(h.service)).toEqual([turnId("r1")]);
        let service = h.service;
        if (restart) {
          h.service.shutdown();
          h.database().close();
          const database = openChangeLedgerDatabase(h.dataDir);
          service = new ChangeTrackingService({
            dataDir: h.dataDir,
            database: () => database,
            emit: () => undefined,
            environmentTarget: async () => ({ kind: "local", worktreePath: h.repo }),
            durable: false,
            manualScheduling: false,
            policy: { ...TIMED_OUT, endRecoveryDelayMs: 0 },
          });
          extraCleanups.push(() => {
            service.shutdown();
            database.close();
          });
          service.start();
          await service.endRecovery.idle();
        } else {
          expect((await service.endRecovery.attempt(turnId("r1"))).kind).toBe("recovered");
        }
        if (failedScope === "thread-net")
          expect(turnMeasurement(service, "r1").measurementId).toBe(recoveredId);
        expect(turnMeasurement(service, "r1").afterSnapshotId).toBe(snapshot);
        const turn = service.ledger.turn(turnId("r1"))!;
        expect(
          service.ledger.latestMeasurement("segment", turn.segment_id, "thread-net")
            ?.afterSnapshotId,
        ).toBe(snapshot);
        expect(awaiting(service)).toEqual([]);
      });
    }
  }

  test("an older recovery cannot replace thread selection after a newer turn commits", async () => {
    const h = harness({ policy: TIMED_OUT });
    await timedOutTurn(h);
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const measure = h.service.measurements.measureSnapshots.bind(h.service.measurements);
    const pause = spyOn(h.service.measurements, "measureSnapshots").mockImplementation(
      async (input) => {
        if (input.scope === "thread-net" && input.boundary.after === "later-recovery") {
          entered();
          await gate;
        }
        return measure(input);
      },
    );
    try {
      const recovery = h.service.endRecovery.attempt(turnId("r1"));
      await reached;
      h.service.policies.update({ finalizationDeadlineMs: 30_000 }, "newer-turn");
      await startTurn(h.service, "r2");
      writeFileSync(join(h.repo, "a.txt"), "newer endpoint\n");
      await finishTurn(h.service, "r2");
      const key = h.service.threadResource("env-1", SESSION)!.resourceKey;
      const newer = h.service.ledger.selection(key);
      release();
      expect((await recovery).kind).toBe("recovered");
      expect(h.service.ledger.selection(key)).toEqual(newer);
      expect(turnMeasurement(h.service, "r1").boundary.after).toBe("later-recovery");
    } finally {
      release();
      pause.mockRestore();
    }
  });

  test("pending publication resumes after a newer same-thread turn without selecting its old endpoint", async () => {
    const h = harness({ policy: TIMED_OUT });
    await timedOutTurn(h);
    const measure = h.service.measurements.measureSnapshots.bind(h.service.measurements);
    const fail = spyOn(h.service.measurements, "measureSnapshots").mockImplementation(
      async (input) => {
        if (input.scope === "thread-net") throw new Error("interrupted publication");
        return measure(input);
      },
    );
    try {
      await expect(h.service.endRecovery.attempt(turnId("r1"))).rejects.toThrow(
        "interrupted publication",
      );
    } finally {
      fail.mockRestore();
    }
    const snapshot = h.service.ledger.pendingEndRecoverySnapshot(turnId("r1"));
    expect(snapshot).not.toBeNull();
    await startTurn(h.service, "r2");
    const key = h.service.threadResource("env-1", SESSION)!.resourceKey;
    const newer = h.service.ledger.selection(key);
    expect((await h.service.endRecovery.attempt(turnId("r1"))).kind).toBe("recovered");
    expect(h.service.ledger.selection(key)).toEqual(newer);
    expect(turnMeasurement(h.service, "r1").afterSnapshotId).toBe(snapshot);
    expect(h.service.ledger.pendingEndRecoverySnapshot(turnId("r1"))).toBeNull();
  });

  test("a refused dispatch on another thread does not supersede recovery", async () => {
    const h = harness({ policy: TIMED_OUT, aliases: ["env-2"] });
    await timedOutTurn(h);
    await h.service.prepareTurnStart({
      environmentId: "env-2",
      logicalSessionKey: "env-env-2:tab",
      requestId: "refused",
      provider: "claude",
    });
    h.service.markTurnDispatched("env-2", "env-env-2:tab", "refused", "rejected");
    expect(h.service.ledger.turn(turnId("refused", "env-2", "env-env-2:tab"))?.lifecycle).toBe(
      "abandoned",
    );
    expect((await h.service.endRecovery.attempt(turnId("r1"))).kind).toBe("recovered");
  });

  test("restore apply cancels a running recovery before its checkpoint", async () => {
    const h = harness();
    await startTurn(h.service, "earlier");
    writeFileSync(join(h.repo, "a.txt"), "earlier edit\n");
    await finishTurn(h.service, "earlier");
    const preview = await h.service.restore.prepare({
      measurementId: turnMeasurement(h.service, "earlier").measurementId,
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    h.service.policies.update({ finalizationDeadlineMs: 0 }, "test-timeout");
    await startTurn(h.service, "r1");
    await finishTurn(h.service, "r1");
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = HostCaptureExecutor.prototype.describe;
    let blocking = true;
    const slow = spyOn(HostCaptureExecutor.prototype, "describe").mockImplementation(
      async function (
        this: HostCaptureExecutor,
        ...args: Parameters<HostCaptureExecutor["describe"]>
      ) {
        if (blocking) {
          entered();
          await new Promise((resolve) =>
            args[2].addEventListener("abort", resolve, { once: true }),
          );
          args[2].throwIfAborted();
        }
        return original.apply(this, args);
      },
    );
    try {
      const recovery = h.service.endRecovery.attempt(turnId("r1"));
      await reached;
      blocking = false;
      expect(
        await h.service.restore.apply({
          actionToken: preview.actionToken,
          idempotencyKey: "restore-during-recovery",
        }),
      ).toMatchObject({ kind: "applied", outcome: "complete" });
      expect(await recovery).toEqual({ kind: "done", reason: "cancelled" });
      expect(readFileSync(join(h.repo, "a.txt"), "utf8")).toBe("one\ntwo\n");
    } finally {
      slow.mockRestore();
    }
  });

  test("a later turn of the thread ends the turn's eligibility", async () => {
    const h = harness({ policy: TIMED_OUT });
    await timedOutTurn(h);
    const before = turnMeasurement(h.service, "r1");
    await startTurn(h.service, "r2");
    expect(await h.service.endRecovery.attempt(turnId("r1"))).toEqual({
      kind: "done",
      reason: "superseded",
    });
    expect(turnMeasurement(h.service, "r1").measurementId).toBe(before.measurementId);
  });

  test("a turn of another thread that ran on the worktree since ends the turn's eligibility", async () => {
    const h = harness({ policy: TIMED_OUT, aliases: ["env-2"] });
    await timedOutTurn(h);
    await startTurn(h.service, "o1", "env-2", "env-env-2:tab");
    writeFileSync(join(h.repo, "c.txt"), "other\n");
    await finishTurn(h.service, "o1", "env-2", "env-env-2:tab");
    // Its writes are on disk now; a capture would credit them to r1.
    expect(await h.service.endRecovery.attempt(turnId("r1"))).toEqual({
      kind: "done",
      reason: "superseded",
    });
  });

  test("a new turn's start cancels a running retry instead of waiting behind it", async () => {
    const h = harness({ policy: TIMED_OUT });
    await timedOutTurn(h);
    let blocking = true;
    let entered: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (entered = resolve));
    const describeFiles = HostCaptureExecutor.prototype.describe;
    const slow = spyOn(HostCaptureExecutor.prototype, "describe").mockImplementation(
      async function (
        this: HostCaptureExecutor,
        ...args: Parameters<HostCaptureExecutor["describe"]>
      ) {
        if (blocking) {
          // A cold capture of a bulk turn: it runs until something stops it.
          const signal = args[2];
          entered();
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          signal.throwIfAborted();
        }
        return describeFiles.apply(this, args);
      },
    );
    try {
      const retry = h.service.endRecovery.attempt(turnId("r1"));
      await reached;
      blocking = false;
      const start = await startTurn(h.service, "r2");
      expect(start.kind).toBe("ready");
      expect(await retry).toEqual({ kind: "done", reason: "cancelled" });
    } finally {
      slow.mockRestore();
    }
  });

  test("a capture honours its caller's abort signal", async () => {
    const h = harness();
    await startTurn(h.service, "r1");
    const owner = h.service.registry.ownerById(h.service.ledger.turn(turnId("r1"))!.worktree_id)!;
    expect(
      await owner.capture({ purpose: "refresh", deadlineMs: 10_000, signal: AbortSignal.abort() }),
    ).toEqual({ kind: "unavailable", reason: "capture-cancelled", boundarySeq: 0 });
  });
});

describe("end capture recovery scheduling", () => {
  const automatic = (policy: Partial<ChangeTrackingPolicy>) =>
    harness({
      manualScheduling: false,
      policy: { ...TIMED_OUT, endRecoveryDelayMs: 0, ...policy },
    });

  test("restore invalidates a scheduled retry during a paused write and after restart", async () => {
    const h = harness({ manualScheduling: false, policy: { endRecoveryDelayMs: 60_000 } });
    await startTurn(h.service, "earlier");
    writeFileSync(join(h.repo, "a.txt"), "earlier edit\n");
    await finishTurn(h.service, "earlier");
    const preview = await h.service.restore.prepare({
      measurementId: turnMeasurement(h.service, "earlier").measurementId,
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    h.service.policies.update(TIMED_OUT, "timeout");
    const timers = spyOn(globalThis, "setTimeout");
    await startTurn(h.service, "r1");
    await finishTurn(h.service, "r1");
    const timer = timers.mock.calls.find((args) => args[1] === 60_000)?.[0];
    timers.mockRestore();
    expect(timer).toBeDefined();
    const unavailable = turnMeasurement(h.service, "r1");
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const writer = h.service.restore as unknown as {
      write: (...args: unknown[]) => Promise<unknown>;
    };
    const original = writer.write.bind(writer);
    const pause = spyOn(writer, "write").mockImplementation(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    try {
      const applying = h.service.restore.apply({
        actionToken: preview.actionToken,
        idempotencyKey: "scheduled-restore",
      });
      await reached;
      // Even a callback already queued before clearTimeout must refuse a capture.
      if (typeof timer === "function") timer();
      await h.service.endRecovery.idle();
      expect(await h.service.endRecovery.attempt(turnId("r1"))).toEqual({
        kind: "done",
        reason: "not-eligible",
      });
      expect(turnMeasurement(h.service, "r1")).toEqual(unavailable);
      release();
      expect(await applying).toMatchObject({ kind: "applied", outcome: "complete" });
    } finally {
      release();
      pause.mockRestore();
    }
    h.service.shutdown();
    h.database().close();
    const database = openChangeLedgerDatabase(h.dataDir);
    const service = new ChangeTrackingService({
      dataDir: h.dataDir,
      database: () => database,
      emit: () => undefined,
      environmentTarget: async () => ({ kind: "local", worktreePath: h.repo }),
      durable: false,
      manualScheduling: false,
      policy: { ...TIMED_OUT, endRecoveryDelayMs: 0 },
    });
    extraCleanups.push(() => {
      service.shutdown();
      database.close();
    });
    service.start();
    await service.endRecovery.idle();
    expect(awaiting(service)).toEqual([]);
    expect(await service.endRecovery.attempt(turnId("r1"))).toEqual({
      kind: "done",
      reason: "not-eligible",
    });
    expect(turnMeasurement(service, "r1")).toEqual(unavailable);
    expect(readFileSync(join(h.repo, "a.txt"), "utf8")).toBe("one\ntwo\n");
  });

  test("a timed-out end is retried in the background after the turn ended", async () => {
    const h = automatic({});
    await timedOutTurn(h);
    await h.service.endRecovery.idle();
    expect(h.service.ledger.turn(turnId("r1"))!.reason).toBe("end-captured-later");
    expect(turnMeasurement(h.service, "r1").boundary.after).toBe("later-recovery");
  });

  test("retries stop after the attempt budget and are not offered again", async () => {
    const h = automatic({ endRecoveryDeadlineMs: 0, endRecoveryAttempts: 2 });
    await timedOutTurn(h);
    const unavailable = turnMeasurement(h.service, "r1");
    const capture = spyOn(
      h.service.registry.ownerById(h.service.ledger.turn(turnId("r1"))!.worktree_id)!,
      "capture",
    );
    try {
      await h.service.endRecovery.idle();
      expect(capture.mock.calls.map(([options]) => options.purpose)).toEqual([
        "turn-recovery",
        "turn-recovery",
      ]);
    } finally {
      capture.mockRestore();
    }
    expect(h.service.ledger.turn(turnId("r1"))!.reason).toBe("capture-timeout-unrecovered");
    expect(awaiting(h.service)).toEqual([]);
    expect(turnMeasurement(h.service, "r1").measurementId).toBe(unavailable.measurementId);
  });

  test("shutdown cancels a scheduled retry", async () => {
    const h = automatic({ endRecoveryDelayMs: 60_000 });
    await timedOutTurn(h);
    h.service.shutdown();
    await h.service.endRecovery.idle();
    expect(h.service.ledger.turn(turnId("r1"))!.reason).toBe("capture-timeout");
  });

  test("a restart resumes the retry of a turn the previous process left unrecovered", async () => {
    const h = harness({ policy: TIMED_OUT });
    await timedOutTurn(h);
    h.service.shutdown();
    h.database().close();
    const database = openChangeLedgerDatabase(h.dataDir);
    const service = new ChangeTrackingService({
      dataDir: h.dataDir,
      database: () => database,
      emit: () => undefined,
      environmentTarget: async (environmentId) =>
        environmentId === "env-1" ? { kind: "local", worktreePath: h.repo } : null,
      durable: false,
      manualScheduling: false,
      policy: { ...TIMED_OUT, endRecoveryDelayMs: 0 },
    });
    extraCleanups.push(() => {
      service.shutdown();
      database.close();
    });
    service.start();
    await service.endRecovery.idle();
    expect(service.ledger.turn(turnId("r1"))!.reason).toBe("end-captured-later");
    expect(turnMeasurement(service, "r1").boundary.after).toBe("later-recovery");
  });

  test("a turn whose writers were unresolved is retried once they settle", async () => {
    const h = automatic({});
    const spool = new ChangeEvidenceSpool();
    const capabilities: Omit<ProviderChangeCapabilities, "capabilityRevision"> = {
      resolution: "resolved",
      beforeTurn: "controlled-dispatch",
      afterTurn: "terminal-observed",
      beforeTool: "observed-after-start",
      afterTool: "observed",
      historicalCallIdentity: "stable",
      fileEvidence: { resolution: "confirmed", kinds: ["replacement"] },
      turnDiff: "absent",
      captureExecutor: "host-worker",
      captureAvailability: "ready",
      backgroundCompletion: "observable",
    };
    const recorder = new ChangeEvidenceRecorder({ spool, provider: "claude", capabilities });
    h.service.rememberConversation("env-1", "claude", "s1", SESSION);
    const source = spoolSource(spool);
    await startTurn(h.service, "b1");
    await h.service.pullEvidence(source);
    writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nforeground\n");
    const child = (phase: "running" | "succeeded") =>
      recorder.backgroundTask(
        { conversationId: "s1", callId: "launch" },
        {
          taskId: "t1",
          parentCallId: "launch",
          phase,
          executionOccurrence: "started",
          writerLiveness: phase === "running" ? "may-write" : "quiescent",
        },
      );
    child("running");
    recorder.turn({ conversationId: "s1", turnId: "pt1" }, "cancelled", "unknown");
    await finishTurn(h.service, "b1");
    await h.service.endRecovery.idle();
    // The child may still write: the retry waits for it.
    expect(h.service.ledger.turn(turnId("b1"))!.reason).toBe("capture-timeout");
    expect(await h.service.endRecovery.attempt(turnId("b1"))).toEqual({
      kind: "done",
      reason: "writers-unresolved",
    });

    writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nforeground\nbackground\n");
    child("succeeded");
    await h.service.pullEvidence(source);
    await h.service.endRecovery.idle();
    expect(h.service.ledger.turn(turnId("b1"))!.reason).toBe("end-captured-later");
    const recovered = turnMeasurement(h.service, "b1");
    expect(recovered.finality).toBe("final");
    expect(recovered.boundary.after).toBe("later-recovery");
    expect(recovered.totals.additions.value).toBe(2);
  });
});
