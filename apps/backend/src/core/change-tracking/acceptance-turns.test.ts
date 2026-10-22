/**
 * Acceptance matrix (guide §16) for turn boundaries, fencing, background
 * settlement and restart durability: H03, H04, H07, H09, H12, H13, V12.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeMeasurement } from "@orkestrator/protocol/change-measurements";
import {
  environmentChangeResourceKey,
  type ChangeProjection,
} from "@orkestrator/protocol/change-resources";
import type { ProviderChangeCapabilities } from "@orkestrator/protocol/change-evidence";
import { ChangeEvidenceRecorder } from "@orkestrator/protocol/node/change-tracking/evidence-builders";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import { getLocalGitStatusDetailed, type LocalGitFetches } from "../commands-files.js";
import type { DiffStatsTarget } from "../diff-stats-service.js";
import { openBackendDatabase } from "../storage-stores.js";
import { operationIdFor, toolResourceKeys, turnResourceKeys } from "./identities.js";
import type { ChangeTrackingPolicy } from "./policy-registry.js";
import { ChangeTrackingService } from "./service.js";
import { createHarness, git, spoolSource, type Harness } from "./service-test-support.js";
import { turnIdFor } from "./turn-boundaries.js";

const SESSION = "env-env-1:tab";
const harnesses: Harness[] = [];
const extraCleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of extraCleanups.splice(0)) cleanup();
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

function harness(options: Parameters<typeof createHarness>[0] = {}) {
  const created = createHarness(options);
  harnesses.push(created);
  return created;
}

const turnId = (requestId: string) => turnIdFor("env-1", SESSION, requestId);

async function startTurn(service: ChangeTrackingService, requestId: string) {
  const start = await service.prepareTurnStart({
    environmentId: "env-1",
    logicalSessionKey: SESSION,
    requestId,
    provider: "claude",
  });
  service.markTurnDispatched("env-1", SESSION, requestId, "accepted");
  return start;
}

function finishTurn(service: ChangeTrackingService, requestId: string) {
  return service.finalizeTurn({ environmentId: "env-1", logicalSessionKey: SESSION, requestId });
}

async function runTurn(h: Harness, requestId: string, work: () => void) {
  const start = await startTurn(h.service, requestId);
  work();
  await finishTurn(h.service, requestId);
  return start;
}

function turnMeasurement(service: ChangeTrackingService, requestId: string): ChangeMeasurement {
  const measurement = service.ledger.latestMeasurement("turn", turnId(requestId), "turn-net");
  if (!measurement) throw new Error("no turn measurement");
  return measurement;
}

function threadMeasurement(service: ChangeTrackingService): ChangeMeasurement {
  const thread = service.threadResource("env-1", SESSION);
  const measurement = thread ? service.projections.selectedMeasurement(thread.resourceKey) : null;
  if (!measurement) throw new Error("no thread measurement");
  return measurement;
}

function projection(service: ChangeTrackingService, resourceKey: string): ChangeProjection {
  const view = service.getView({ resourceKey });
  if (view.kind !== "projection") throw new Error(`expected a projection, got ${view.kind}`);
  return view.projection;
}

function addedLines(body: Awaited<ReturnType<ChangeTrackingService["diffBodies"]["getDiff"]>>) {
  if (body.kind !== "body") throw new Error(`expected a body, got ${body.kind}`);
  return body.files
    .flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines))
    .filter((line) => line.type === "add")
    .map((line) => line.text);
}

/** A real environment-owner scan of the harness repository (as DiffStatsService runs it). */
async function scanEnvironment(h: Harness): Promise<void> {
  const target: DiffStatsTarget = {
    environmentId: "env-1",
    comparisonRef: "main",
    kind: "local",
    worktreePath: h.repo,
  };
  const fetches: LocalGitFetches = { ensureFetched: async () => undefined } as LocalGitFetches;
  const detailed = await getLocalGitStatusDetailed(h.repo, "main", true, fetches);
  const at = new Date().toISOString();
  h.service.onDiffScanEvent({
    kind: "scanned",
    target,
    result: {
      stats: {
        additions: detailed.changes.reduce((sum, change) => sum + change.additions, 0),
        deletions: detailed.changes.reduce((sum, change) => sum + change.deletions, 0),
        filesChanged: detailed.changes.length,
        truncated: detailed.truncated,
      },
      changes: detailed.changes,
      ...(detailed.baseOid ? { baseOid: detailed.baseOid } : {}),
    },
    changed: true,
    at,
    startedAt: at,
  });
  await h.service.environments.idle();
}

function evidenceSetup(
  h: Harness,
  capabilities: Partial<Omit<ProviderChangeCapabilities, "capabilityRevision">> = {},
) {
  const spool = new ChangeEvidenceSpool();
  const recorder = new ChangeEvidenceRecorder({
    spool,
    provider: "claude",
    capabilities: {
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
      ...capabilities,
    },
  });
  h.service.rememberConversation("env-1", "claude", "s1", SESSION);
  return { spool, recorder, source: spoolSource(spool) };
}

/**
 * Restart the backend process: stop the running service and close its
 * database, then open a fresh service on the same data root and object store.
 */
function restart(
  h: Harness,
  running: { service: ChangeTrackingService; close(): void },
  policy?: Partial<ChangeTrackingPolicy>,
): { service: ChangeTrackingService; close(): void } {
  running.close();
  const database = openBackendDatabase(h.dataDir);
  const service = new ChangeTrackingService({
    dataDir: h.dataDir,
    database: () => database,
    emit: () => undefined,
    environmentTarget: async (environmentId) =>
      environmentId === "env-1" ? { kind: "local", worktreePath: h.repo } : null,
    durable: false,
    manualScheduling: true,
    policy,
  });
  service.start();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    service.shutdown();
    database.close();
  };
  extraCleanups.push(close);
  return { service, close };
}

describe("acceptance: baselines and attribution", () => {
  test("H03: preexisting tracked, staged and untracked dirt nets a zero turn while the environment still shows it", async () => {
    const h = harness();
    writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nunstaged\n");
    writeFileSync(join(h.repo, "staged.txt"), "staged\n");
    git(h.repo, "add", "staged.txt");
    writeFileSync(join(h.repo, "untracked.txt"), "untracked\n");

    await runTurn(h, "r1", () => {});

    const turn = turnMeasurement(h.service, "r1");
    expect(turn.boundary).toEqual({ before: "fresh-before", after: "after-terminal" });
    expect(turn.totals.changedFiles).toBe(0);
    expect(turn.totals.additions).toEqual({ value: 0, quality: "complete", bound: "exact" });
    expect(turn.totals.deletions).toEqual({ value: 0, quality: "complete", bound: "exact" });
    // The thread baseline is the same fresh start, so the thread is zero too.
    expect(threadMeasurement(h.service).totals.changedFiles).toBe(0);

    // The environment scope compares against the branch base: the dirt stays visible.
    await scanEnvironment(h);
    const environment = projection(h.service, environmentChangeResourceKey("env-1"));
    expect(environment.counters.changedFiles).toBe(3);
    expect(environment.counters.additions.value).toBe(3);
    expect(environment.hasFileChanges).toBe(true);
    expect(environment.filePage!.rows.map((row) => row.newPathDisplay).sort()).toEqual([
      "a.txt",
      "staged.txt",
      "untracked.txt",
    ]);
  });

  test("H04: an edit made after a message is queued but before dispatch belongs to the start, not the turn", async () => {
    const h = harness();
    await startTurn(h.service, "r1");
    writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nr1\n");
    // The user queues r2 while r1 runs: nothing is captured at queue time.
    const queuedAt = h.service.ledger.snapshots().length;
    await finishTurn(h.service, "r1");
    const r1End = h.service.ledger.turn(turnId("r1"))!.end_snapshot_id;
    // External edit while r2 waits in the queue.
    writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nr1\nuser\n");
    writeFileSync(join(h.repo, "user.txt"), "user file\n");
    expect(h.service.ledger.turn(turnId("r2"))).toBeNull();

    const start = await startTurn(h.service, "r2");
    expect(start.kind).toBe("ready");
    const r2 = h.service.ledger.turn(turnId("r2"))!;
    // A fresh capture at dispatch, never an alias of the previous turn's end.
    expect(r2.start_snapshot_id).not.toBe(r1End);
    expect(h.service.ledger.snapshots().length).toBeGreaterThan(queuedAt);

    writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nr1\nuser\nagent\n");
    await finishTurn(h.service, "r2");
    const turn = turnMeasurement(h.service, "r2");
    expect(turn.totals.changedFiles).toBe(1);
    expect(turn.totals.additions.value).toBe(1);
    expect(turn.totals.deletions.value).toBe(0);
    expect(
      addedLines(await h.service.diffBodies.getDiff({ diffIdentityId: turn.diffIdentityId! })),
    ).toEqual(["agent"]);
    // The thread still sees the queued-time edit between its endpoints.
    expect(threadMeasurement(h.service).totals.changedFiles).toBe(2);
  });

  test("H07: a read-only tool observed after an external edit keeps a prior-observation boundary and no exclusive authorship", async () => {
    const h = harness();
    const { recorder, source } = evidenceSetup(h);
    await startTurn(h.service, "r1");
    // The user edits a file while the turn runs; the agent then runs a read-only command.
    writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nuser\n");
    recorder.tool(
      { conversationId: "s1", callId: "ro" },
      { toolKind: "shell", phase: "succeeded", executionOccurrence: "started" },
    );
    recorder.observation(
      { conversationId: "s1", callId: "ro" },
      {
        boundary: { before: "prior-observation", after: "after-terminal" },
        overlap: "none-observed",
        change: {
          additions: 1,
          deletions: 0,
          files: [{ path: "a.txt", status: "M", additions: 1, deletions: 0 }],
        },
      },
    );
    await h.service.pullEvidence(source);

    const operationId = operationIdFor({
      environmentId: "env-1",
      provider: "claude",
      conversationId: "s1",
      callId: "ro",
    });
    const keys = toolResourceKeys(operationId);
    // Observation window only: never promoted to a tool effect.
    expect(h.service.ledger.selection(keys.effect)).toBeNull();
    const observed = h.service.projections.selectedMeasurement(keys.observation)!;
    expect(observed.scope).toBe("observation-window");
    expect(observed.boundary).toEqual({ before: "prior-observation", after: "after-terminal" });
    expect(observed.effectClaim).toBe("workspace-observed");
    expect(observed.attribution.basis).toBe("workspace-observation");
    expect(observed.attribution.writerIsolation).toBe("shared");
    expect(projection(h.service, keys.observation).provenanceLabelKey).toBe(
      "changes.provenance.observed-after-start",
    );
    // The backend's own window for the after-start tool records the same boundary.
    expect(h.service.ledger.window(`win_${operationId}`)?.before_quality).toBe("prior-observation");

    await finishTurn(h.service, "r1");
    // The turn still owns the external edit only as a workspace observation.
    const turn = turnMeasurement(h.service, "r1");
    expect(turn.attribution.basis).toBe("workspace-observation");
    expect(turn.totals.additions.value).toBe(1);
  });

  test("H09: a mid-turn commit and later ref moves keep the turn delta, its object ids and baseline version", async () => {
    const h = harness();
    await runTurn(h, "r1", () => {
      writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nthree\nfour\n");
      git(h.repo, "commit", "-qam", "agent commit");
    });
    const before = turnMeasurement(h.service, "r1");
    expect(before.totals.additions.value).toBe(2);
    const turnRow = h.service.ledger.turn(turnId("r1"))!;
    const endpoints = [turnRow.start_snapshot_id!, turnRow.end_snapshot_id!].map((id) =>
      h.service.ledger.snapshot(id)!,
    );
    const files = h.service.ledger.measurementFiles(before.measurementId, 0, 100);
    const threadBaseline = threadMeasurement(h.service).baselineVersion;
    expect(threadBaseline).not.toBeNull();

    // Branch and ref moves after publication, then a later turn and retention.
    git(h.repo, "checkout", "-q", "-b", "side", "HEAD~1");
    git(h.repo, "update-ref", "refs/heads/main", "HEAD");
    git(h.repo, "commit", "-q", "--allow-empty", "-m", "unrelated");
    await runTurn(h, "r2", () => {});
    await h.service.retention.run();

    const after = turnMeasurement(h.service, "r1");
    expect(after).toEqual(before);
    expect(h.service.ledger.measurementFiles(before.measurementId, 0, 100)).toEqual(files);
    for (const endpoint of endpoints) {
      const row = h.service.ledger.snapshot(endpoint.id)!;
      expect(row.tree_oid).toBe(endpoint.tree_oid);
      expect(row.coverage_json).toBe(endpoint.coverage_json);
    }
    expect(threadMeasurement(h.service).baselineVersion).toBe(threadBaseline);
    // The retained body is the historical one, not today's worktree or HEAD.
    expect(readFileSync(join(h.repo, "a.txt"), "utf8")).toBe("one\ntwo\n");
    expect(
      addedLines(await h.service.diffBodies.getDiff({ diffIdentityId: before.diffIdentityId! })),
    ).toEqual(["three", "four"]);
  });
});

describe("acceptance: fencing", () => {
  test("H12: a capture in flight across an owner replacement completes late and cannot publish", async () => {
    const h = harness();
    await runTurn(h, "r1", () => {});
    const turnRow = h.service.ledger.turn(turnId("r1"))!;
    const owner = h.service.registry.ownerById(turnRow.worktree_id)!;
    const snapshotsBefore = h.service.ledger.snapshots().length;

    const inFlight = owner.capture({ purpose: "refresh", deadlineMs: 10_000 });
    // Another process claims the worktree while the capture is still running.
    h.service.ledger.claimOwnership(turnRow.worktree_id, "other-process");
    writeFileSync(join(h.repo, "late.txt"), "late\n");
    expect(await inFlight).toMatchObject({ kind: "unavailable", reason: "owner-replaced" });
    expect(h.service.ledger.snapshots().length).toBe(snapshotsBefore);
    expect(owner.isReplaced).toBe(true);
  });

  test("H12: a stale holder's turn end cannot advance the current pointer", async () => {
    const h = harness();
    await startTurn(h.service, "r1");
    const worktreeId = h.service.ledger.turn(turnId("r1"))!.worktree_id;
    h.service.ledger.claimOwnership(worktreeId, "other-process");
    writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nstale\n");
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect(await finishTurn(h.service, "r1")).toEqual([]);
    } finally {
      console.warn = warn;
    }
    expect(h.service.ledger.turn(turnId("r1"))).toMatchObject({
      lifecycle: "end-unavailable",
      reason: "owner-replaced",
    });
    const key = turnResourceKeys(turnId("r1"), null).turnNet;
    expect(h.service.ledger.selection(key)).toBeNull();
    expect(h.service.ledger.latestMeasurement("turn", turnId("r1"), "turn-net")).toBeNull();
  });

  test("H12: a start captured under a fence replaced before authorization is refused as a dispatch boundary", async () => {
    const h = harness();
    // Resolve the owner once so the test can intercept its capture.
    await runTurn(h, "r0", () => {});
    const worktreeId = h.service.ledger.turn(turnId("r0"))!.worktree_id;
    const owner = h.service.registry.ownerById(worktreeId)!;
    const capture = owner.capture.bind(owner);
    owner.capture = async (options) => {
      const outcome = await capture(options);
      // Ownership moves after the capture published but before the start is authorized.
      if (options.purpose === "turn-start")
        h.service.ledger.claimOwnership(worktreeId, "other-process");
      return outcome;
    };
    const start = await h.service.prepareTurnStart({
      environmentId: "env-1",
      logicalSessionKey: SESSION,
      requestId: "r1",
      provider: "claude",
    });
    expect(start).toMatchObject({ kind: "degraded", reason: "owner-replaced" });
    const row = h.service.ledger.turn(turnId("r1"))!;
    expect(row.start_snapshot_id).toBeNull();
    expect(row.before_quality).toBe("unknown");
  });

  test("H12: strict checkpoints hold a dispatch whose start fence was replaced", async () => {
    const h = harness({ policy: { strictCheckpoints: true } });
    await runTurn(h, "r0", () => {});
    const worktreeId = h.service.ledger.turn(turnId("r0"))!.worktree_id;
    const owner = h.service.registry.ownerById(worktreeId)!;
    const capture = owner.capture.bind(owner);
    owner.capture = async (options) => {
      const outcome = await capture(options);
      h.service.ledger.claimOwnership(worktreeId, "other-process");
      return outcome;
    };
    const start = await h.service.prepareTurnStart({
      environmentId: "env-1",
      logicalSessionKey: SESSION,
      requestId: "r1",
      provider: "claude",
    });
    expect(start).toMatchObject({ kind: "held", reason: "owner-replaced" });
    expect(h.service.ledger.turn(turnId("r1"))!.dispatch_token).toBeNull();
  });
});

describe("acceptance: background settlement", () => {
  async function interruptedByCancel(h: Harness, backgroundCompletion = "observable" as const) {
    const evidence = evidenceSetup(h, { backgroundCompletion });
    await startTurn(h.service, "b1");
    await h.service.pullEvidence(evidence.source);
    writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nforeground\n");
    evidence.recorder.backgroundTask(
      { conversationId: "s1", callId: "launch" },
      {
        taskId: "t1",
        parentCallId: "launch",
        phase: "running",
        executionOccurrence: "started",
        writerLiveness: "may-write",
      },
    );
    // The user cancels: the provider reports the turn cancelled while its child still runs.
    evidence.recorder.turn({ conversationId: "s1", turnId: "pt1" }, "cancelled", "unknown");
    await finishTurn(h.service, "b1");
    return evidence;
  }

  test("H13: a cancelled turn with a running background child stays interrupted, with its changes kept", async () => {
    const h = harness();
    await interruptedByCancel(h);
    const row = h.service.ledger.turn(turnId("b1"))!;
    expect(row.lifecycle).toBe("interrupted");
    expect(row.reason).toBe("writers-unresolved");
    const turn = turnMeasurement(h.service, "b1");
    expect(turn.finality).toBe("interrupted");
    expect(turn.boundary).toEqual({ before: "fresh-before", after: "running-observation" });
    // Cancelled does not imply zero.
    expect(turn.totals.additions.value).toBe(1);
    expect(
      projection(h.service, turnResourceKeys(turnId("b1"), null).turnNet).reasonKeys,
    ).toContain("changes.reason.interrupted");
  });

  test("H13: the child's terminal report later appends a superseding settlement without rewriting the endpoints", async () => {
    const h = harness();
    const { recorder, source } = await interruptedByCancel(h);
    const interrupted = turnMeasurement(h.service, "b1");
    const endSnapshot = h.service.ledger.turn(turnId("b1"))!.end_snapshot_id;

    // Unrelated evidence while the child still runs settles nothing.
    recorder.tool(
      { conversationId: "s1", callId: "other" },
      { toolKind: "shell", phase: "succeeded", executionOccurrence: "started" },
    );
    await h.service.pullEvidence(source);
    expect(turnMeasurement(h.service, "b1").measurementId).toBe(interrupted.measurementId);

    // The background child writes once more, then reports it finished.
    writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nforeground\nbackground\n");
    recorder.backgroundTask(
      { conversationId: "s1", callId: "launch" },
      {
        taskId: "t1",
        parentCallId: "launch",
        phase: "succeeded",
        executionOccurrence: "started",
        writerLiveness: "quiescent",
      },
    );
    await h.service.pullEvidence(source);

    const settled = turnMeasurement(h.service, "b1");
    expect(settled.measurementId).not.toBe(interrupted.measurementId);
    expect(settled.supersedesMeasurementId).toBe(interrupted.measurementId);
    expect(settled.finality).toBe("final");
    expect(settled.boundary).toEqual({ before: "fresh-before", after: "later-recovery" });
    expect(settled.totals.additions.value).toBe(2);
    // The interrupted result and its retained endpoints are unchanged.
    expect(h.service.ledger.measurement(interrupted.measurementId)).toEqual(interrupted);
    const row = h.service.ledger.turn(turnId("b1"))!;
    expect(row.end_snapshot_id).toBe(endSnapshot);
    expect(row.lifecycle).toBe("interrupted");
    const key = turnResourceKeys(turnId("b1"), null).turnNet;
    expect(h.service.ledger.selection(key)?.measurement_id).toBe(settled.measurementId);
    // A replayed terminal frame does not settle twice.
    await h.service.pullEvidence(source);
    expect(turnMeasurement(h.service, "b1").measurementId).toBe(settled.measurementId);
  });

  test("H13: a launch-only provider's child report cannot settle the turn", async () => {
    const h = harness();
    const { recorder, source } = await interruptedByCancel(h, "launch-only" as "observable");
    const interrupted = turnMeasurement(h.service, "b1");
    recorder.backgroundTask(
      { conversationId: "s1", callId: "launch" },
      {
        taskId: "t1",
        parentCallId: "launch",
        phase: "succeeded",
        executionOccurrence: "started",
        writerLiveness: "quiescent",
      },
    );
    await h.service.pullEvidence(source);
    expect(turnMeasurement(h.service, "b1").measurementId).toBe(interrupted.measurementId);
    expect(turnMeasurement(h.service, "b1").finality).toBe("interrupted");
  });

  test("H13: a newer turn on the thread blocks a late settlement of an older one", async () => {
    const h = harness();
    const { recorder, source } = await interruptedByCancel(h);
    const interrupted = turnMeasurement(h.service, "b1");
    await startTurn(h.service, "b2");
    recorder.backgroundTask(
      { conversationId: "s1", callId: "launch" },
      {
        taskId: "t1",
        parentCallId: "launch",
        phase: "succeeded",
        executionOccurrence: "started",
        writerLiveness: "quiescent",
      },
    );
    await h.service.pullEvidence(source);
    expect(turnMeasurement(h.service, "b1").measurementId).toBe(interrupted.measurementId);
  });
});

describe("acceptance: durability", () => {
  test("V12: committed totals survive body expiry and a process restart; detail follows durable objects", async () => {
    const h = harness({ policy: { orphanGraceMs: 0 } });
    await runTurn(h, "r1", () => writeFileSync(join(h.repo, "a.txt"), "one\nthree\nfour\n"));
    const original = turnMeasurement(h.service, "r1");
    const key = turnResourceKeys(turnId("r1"), null).turnNet;
    const counters = projection(h.service, key).counters;

    // Restart with objects intact: same measurement, same counts, body available.
    const policy = { orphanGraceMs: 0 };
    const first = restart(
      h,
      {
        service: h.service,
        close: () => {
          h.service.shutdown();
          h.database().close();
        },
      },
      policy,
    );
    expect(turnMeasurement(first.service, "r1")).toEqual(original);
    expect(projection(first.service, key).counters).toEqual(counters);
    expect(projection(first.service, key).measurementId).toBe(original.measurementId);
    expect(
      addedLines(
        await first.service.diffBodies.getDiff({ diffIdentityId: original.diffIdentityId! }),
      ),
    ).toEqual(["three", "four"]);

    // Retention expires the bodies (every pin dropped), then the process restarts again.
    const ledger = first.service.ledger;
    ledger.transaction(() => {
      ledger.removeReferences("turn", original.logicalOwner.turnId!);
      ledger.removeReferences("segment", original.logicalOwner.threadSegmentId!);
      ledger.removeReferences("segment-live", original.logicalOwner.threadSegmentId!);
    });
    const report = await first.service.retention.run(Date.now() + 10);
    expect(report.deletedSnapshots).toBeGreaterThan(0);
    const { service } = restart(h, first, policy);

    expect(service.ledger.measurement(original.measurementId)).toEqual(original);
    expect(projection(service, key).counters).toEqual(counters);
    expect(projection(service, key).measurementId).toBe(original.measurementId);
    const expired = await service.diffBodies.getDiff({ diffIdentityId: original.diffIdentityId! });
    expect(expired).toMatchObject({ kind: "error", error: { code: "body-expired" } });
  });
});
