import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeMeasurement } from "@orkestrator/protocol/change-measurements";
import { CHANGE_PROJECTION_CHANGED_EVENT } from "@orkestrator/protocol/change-resources";
import { ChangeEvidenceRecorder } from "@orkestrator/protocol/node/change-tracking/evidence-builders";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import { unknownCapabilities } from "@orkestrator/protocol/change-evidence";
import { createHarness, git, spoolSource, type Harness } from "./service-test-support.js";
import { turnIdFor } from "./turn-boundaries.js";

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

function harness(options: Parameters<typeof createHarness>[0] = {}) {
  const created = createHarness(options);
  harnesses.push(created);
  return created;
}

async function runTurn(h: Harness, requestId: string, work: () => void) {
  const start = await h.service.prepareTurnStart({
    environmentId: "env-1",
    logicalSessionKey: "env-env-1:tab",
    requestId,
    provider: "claude",
  });
  h.service.markTurnDispatched("env-1", "env-env-1:tab", requestId, "accepted");
  work();
  await h.service.finalizeTurn({
    environmentId: "env-1",
    logicalSessionKey: "env-env-1:tab",
    requestId,
  });
  return start;
}

function turnMeasurement(h: Harness, requestId: string): ChangeMeasurement {
  const turnId = turnIdFor("env-1", "env-env-1:tab", requestId);
  const measurement = h.service.ledger.latestMeasurement("turn", turnId, "turn-net");
  if (!measurement) throw new Error("no turn measurement");
  return measurement;
}

function threadMeasurement(h: Harness): ChangeMeasurement {
  const thread = h.service.threadResource("env-1", "env-env-1:tab");
  const measurement = thread ? h.service.projections.selectedMeasurement(thread.resourceKey) : null;
  if (!measurement) throw new Error("no thread measurement");
  return measurement;
}

describe("turn and thread boundaries", () => {
  test("a turn's writes are measured from its fresh start to its end", async () => {
    const h = harness();
    const start = await runTurn(h, "r1", () =>
      writeFileSync(join(h.repo, "a.txt"), "one\nTWO\nthree\n"),
    );
    expect(start.kind).toBe("ready");
    const turn = turnMeasurement(h, "r1");
    expect(turn.scope).toBe("turn-net");
    expect(turn.totals.additions).toEqual({ value: 2, quality: "complete", bound: "exact" });
    expect(turn.totals.deletions).toEqual({ value: 1, quality: "complete", bound: "exact" });
    expect(turn.boundary).toEqual({ before: "fresh-before", after: "after-terminal" });
    expect(turn.finality).toBe("final");
    expect(h.events.some((e) => e.event === CHANGE_PROJECTION_CHANGED_EVENT)).toBe(true);
  });

  test("H03: preexisting dirt with no writes is a zero turn delta", async () => {
    const h = harness();
    writeFileSync(join(h.repo, "a.txt"), "dirty\n");
    writeFileSync(join(h.repo, "untracked.txt"), "u\n");
    git(h.repo, "add", "untracked.txt");
    await runTurn(h, "r1", () => {});
    const turn = turnMeasurement(h, "r1");
    expect(turn.totals.changedFiles).toBe(0);
    expect(turn.totals.additions.value).toBe(0);
  });

  test("H05: an idle edit between turns is excluded from the next turn but kept by the thread", async () => {
    const h = harness();
    await runTurn(h, "r1", () => writeFileSync(join(h.repo, "b.txt"), "agent\n"));
    // External edit while idle.
    writeFileSync(join(h.repo, "external.txt"), "user\n");
    await runTurn(h, "r2", () => writeFileSync(join(h.repo, "c.txt"), "agent2\n"));
    const second = turnMeasurement(h, "r2");
    expect(second.totals.changedFiles).toBe(1);
    const thread = threadMeasurement(h);
    // b.txt, external.txt and c.txt all survive between the thread endpoints.
    expect(thread.totals.changedFiles).toBe(3);
    expect(thread.attribution.basis).toBe("workspace-observation");
  });

  test("H06: add then remove across turns nets to zero while turn history survives", async () => {
    const h = harness();
    await runTurn(h, "r1", () => writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nadded\n"));
    await runTurn(h, "r2", () => writeFileSync(join(h.repo, "a.txt"), "one\ntwo\n"));
    expect(turnMeasurement(h, "r1").totals.additions.value).toBe(1);
    expect(turnMeasurement(h, "r2").totals.deletions.value).toBe(1);
    const thread = threadMeasurement(h);
    expect(thread.totals.changedFiles).toBe(0);
    expect(thread.totals.additions.value).toBe(0);
    const history = h.service.getHistory({
      environmentId: "env-1",
      logicalSessionKey: "env-env-1:tab",
    });
    expect(history.kind === "page" && history.entries.length).toBe(2);
  });

  test("H09: a commit during a turn does not erase the physical turn delta", async () => {
    const h = harness();
    await runTurn(h, "r1", () => {
      writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nthree\n");
      git(h.repo, "commit", "-qam", "agent commit");
    });
    expect(turnMeasurement(h, "r1").totals.additions.value).toBe(1);
  });

  test("an unavailable start is recorded before dispatch; the thread baseline stays unknown", async () => {
    const h = harness({ repo: false });
    const start = await runTurn(h, "r1", () => {});
    expect(start.kind).toBe("degraded");
    const turn = turnMeasurement(h, "r1");
    expect(turn.totals.additions.value).toBeNull();
    expect(turn.completeness.reasons).toContain("start-unavailable");
    const thread = threadMeasurement(h);
    expect(thread.baselineVersion).toBeNull();
    expect(thread.completeness.files).toBe("unknown");
  });

  test("strict checkpoints hold dispatch when the start cannot be captured", async () => {
    const h = harness({ repo: false, policy: { strictCheckpoints: true } });
    const start = await h.service.prepareTurnStart({
      environmentId: "env-1",
      logicalSessionKey: "env-env-1:tab",
      requestId: "r1",
      provider: "claude",
    });
    expect(start.kind).toBe("held");
  });

  test("a rejected dispatch never establishes the thread baseline", async () => {
    const h = harness();
    await h.service.prepareTurnStart({
      environmentId: "env-1",
      logicalSessionKey: "env-env-1:tab",
      requestId: "r0",
      provider: "claude",
    });
    h.service.markTurnDispatched("env-1", "env-env-1:tab", "r0", "rejected");
    writeFileSync(join(h.repo, "between.txt"), "x\n");
    await runTurn(h, "r1", () => {});
    const thread = threadMeasurement(h);
    // The baseline came from r1's start, which already included between.txt.
    expect(thread.totals.changedFiles).toBe(0);
  });

  test("a historical turn body is served from retained endpoints, not the later-edited file", async () => {
    const h = harness();
    await runTurn(h, "r1", () => writeFileSync(join(h.repo, "a.txt"), "one\nchanged\n"));
    writeFileSync(join(h.repo, "a.txt"), "completely different later\n");
    const turn = turnMeasurement(h, "r1");
    const body = await h.service.diffBodies.getDiff({ diffIdentityId: turn.diffIdentityId! });
    expect(body.kind).toBe("body");
    if (body.kind !== "body") return;
    const lines = body.files[0]!.hunks.flatMap((hunk) => hunk.lines);
    expect(lines.find((line) => line.type === "add")?.text).toBe("changed");
    expect(readFileSync(join(h.repo, "a.txt"), "utf8")).toContain("later");
  });

  test("V13: a whitespace-insensitive view is a separate identity and never changes counts", async () => {
    const h = harness();
    await runTurn(h, "r1", () => writeFileSync(join(h.repo, "a.txt"), "one \ntwo\n"));
    const turn = turnMeasurement(h, "r1");
    const view = await h.service.diffBodies.getDiff({
      diffIdentityId: turn.diffIdentityId!,
      display: { whitespace: "ignore-for-view" },
    });
    expect(view.kind === "body" && view.viewIdentityId).toBe(`${turn.diffIdentityId}:ws-ignore`);
    expect(view.kind === "body" && view.files[0]!.hunks.length).toBe(0);
    expect(turnMeasurement(h, "r1").totals.additions.value).toBe(1);
  });

  test("H12: a replaced owner cannot publish with its old fence", async () => {
    const h = harness();
    await runTurn(h, "r1", () => {});
    const turn = turnMeasurement(h, "r1");
    const owner = h.service.registry.ownerById(turn.worktreeId)!;
    const staleFence = owner.ownerFence();
    // Another owner claims the worktree.
    h.service.ledger.claimOwnership(turn.worktreeId, "other-process");
    expect(() =>
      h.service.ledger.transaction(() => h.service.ledger.assertFence(turn.worktreeId, staleFence)),
    ).toThrow();
    const outcome = await owner.capture({ purpose: "refresh", deadlineMs: 10_000 });
    expect(outcome).toMatchObject({ kind: "unavailable", reason: "owner-replaced" });
  });

  test("V07: a file cursor from an older revision is stale, never mixed", async () => {
    const h = harness();
    await runTurn(h, "r1", () => {
      for (let index = 0; index < 5; index++)
        writeFileSync(join(h.repo, `f${index}.txt`), `${index}\n`);
    });
    const key = `turn-net/turn/${encodeURIComponent(turnIdFor("env-1", "env-env-1:tab", "r1"))}/live`;
    const view = h.service.getView({ resourceKey: key, pageSize: 2 });
    if (view.kind !== "projection") throw new Error("expected projection");
    const page = view.projection.filePage!;
    expect(page.rows).toHaveLength(2);
    expect(page.totalRows).toBe(5);
    h.service.projections.bump(key);
    const stale = h.service.projections.files(key, page.snapshotToken, page.nextCursor, 2);
    expect(stale).toMatchObject({ kind: "error", error: { code: "stale-cursor" } });
  });

  test("V15: restore skips a destination the user changed, applies the rest and replays idempotently", async () => {
    const h = harness();
    await runTurn(h, "r1", () => {
      writeFileSync(join(h.repo, "a.txt"), "one\nagent\n");
      writeFileSync(join(h.repo, "new.txt"), "agent file\n");
    });
    // The user edits one destination after the turn.
    writeFileSync(join(h.repo, "new.txt"), "user edit\n");
    const turn = turnMeasurement(h, "r1");
    const preview = await h.service.restore.prepare({ measurementId: turn.measurementId });
    expect(preview.kind).toBe("preview");
    if (preview.kind !== "preview") return;
    expect(preview.files.find((f) => f.pathDisplay === "new.txt")?.action).toBe("skip");
    const applied = await h.service.restore.apply({
      actionToken: preview.actionToken,
      idempotencyKey: "k1",
    });
    expect(applied).toMatchObject({ kind: "applied", outcome: "complete" });
    expect(readFileSync(join(h.repo, "a.txt"), "utf8")).toBe("one\ntwo\n");
    expect(readFileSync(join(h.repo, "new.txt"), "utf8")).toBe("user edit\n");
    // Idempotent retry returns the recorded outcome.
    expect(
      await h.service.restore.apply({ actionToken: preview.actionToken, idempotencyKey: "k1" }),
    ).toEqual(applied);
  });

  test("V12/H15: retention keeps counts when a body expires, and pinned bodies survive", async () => {
    const h = harness({ policy: { orphanGraceMs: 0 } });
    await runTurn(h, "r1", () => writeFileSync(join(h.repo, "a.txt"), "one\nthree\n"));
    const turn = turnMeasurement(h, "r1");
    await h.service.retention.run();
    expect(
      (await h.service.diffBodies.getDiff({ diffIdentityId: turn.diffIdentityId! })).kind,
    ).toBe("body");
    // Drop every pin, as an expired retention window would.
    h.service.ledger.transaction(() => {
      h.service.ledger.removeReferences("turn", turn.logicalOwner.turnId!);
      h.service.ledger.removeReferences("segment", turn.logicalOwner.threadSegmentId!);
    });
    await h.service.retention.run(Date.now() + 10);
    const expired = await h.service.diffBodies.getDiff({ diffIdentityId: turn.diffIdentityId! });
    expect(expired).toMatchObject({ kind: "error", error: { code: "body-expired" } });
    expect(h.service.ledger.measurement(turn.measurementId)?.totals.additions.value).toBe(1);
  });

  test("H14: a fork inherits the parent's history by reference and keeps its objects", async () => {
    const h = harness({ policy: { orphanGraceMs: 0 } });
    await h.service.prepareTurnStart({
      environmentId: "env-1",
      logicalSessionKey: "env-env-1:tab",
      requestId: "p1",
      provider: "claude",
      providerSessionId: "parent",
    });
    h.service.markTurnDispatched("env-1", "env-env-1:tab", "p1", "accepted");
    writeFileSync(join(h.repo, "a.txt"), "one\nparent\n");
    await h.service.finalizeTurn({
      environmentId: "env-1",
      logicalSessionKey: "env-env-1:tab",
      requestId: "p1",
    });
    const parentSegment = h.service.threadResource("env-1", "env-env-1:tab")!.segmentId;
    h.service.noteFork({
      environmentId: "env-1",
      provider: "claude",
      parentLogicalSessionKey: "env-env-1:tab",
      childProviderSessionId: "child",
    });
    await h.service.prepareTurnStart({
      environmentId: "env-1",
      logicalSessionKey: "env-env-1:fork",
      requestId: "c1",
      provider: "claude",
      providerSessionId: "child",
    });
    const childSegment = h.service.ledger.segment(
      h.service.threadResource("env-1", "env-env-1:fork")!.segmentId,
    )!;
    expect(childSegment.inherited_prefix_id).toBe(parentSegment);
    const parent = h.service.ledger.segment(parentSegment)!;
    // Deleting the parent thread drops only its own references.
    h.service.ledger.transaction(() => {
      h.service.ledger.removeReferences("segment", parentSegment);
      h.service.ledger.removeReferences("turn", turnIdFor("env-1", "env-env-1:tab", "p1"));
    });
    await h.service.retention.run(Date.now() + 10);
    expect(h.service.ledger.snapshot(parent.baseline_snapshot_id!)).not.toBeNull();
  });

  test("H13: a background writer still running at turn end leaves the turn interrupted, not final", async () => {
    const h = harness();
    const spool = new ChangeEvidenceSpool();
    const recorder = new ChangeEvidenceRecorder({
      spool,
      provider: "claude",
      capabilities: unknownCapabilities("test"),
    });
    const source = spoolSource(spool);
    h.service.rememberConversation("env-1", "claude", "s1", "env-env-1:tab");
    await h.service.prepareTurnStart({
      environmentId: "env-1",
      logicalSessionKey: "env-env-1:tab",
      requestId: "b1",
      provider: "claude",
    });
    h.service.markTurnDispatched("env-1", "env-env-1:tab", "b1", "accepted");
    await h.service.pullEvidence(source);
    recorder.backgroundTask(
      { conversationId: "s1" },
      {
        taskId: "t1",
        phase: "running",
        executionOccurrence: "started",
        writerLiveness: "may-write",
      },
    );
    writeFileSync(join(h.repo, "a.txt"), "one\nTWO\nthree\n");
    // The turn end pulls the provider's pending frames before deciding.
    await h.service.finalizeTurn({
      environmentId: "env-1",
      logicalSessionKey: "env-env-1:tab",
      requestId: "b1",
    });
    const turn = turnMeasurement(h, "b1");
    expect(turn.finality).not.toBe("final");
    expect(turn.boundary.after).toBe("running-observation");
  });

  test("restart reconciliation abandons reserved captures and open windows", () => {
    const h = harness();
    h.service.ledger.transaction(() =>
      h.service.ledger.reserveCapture({
        boundaryKey: "x",
        worktreeId: "w",
        ownerEpoch: 1,
        requiredAfterBoundarySeq: 1,
        purpose: "turn-start",
        deadlineAt: new Date().toISOString(),
      }),
    );
    h.service.turns.reconcileAfterRestart();
    expect(h.service.ledger.pendingCaptures()).toHaveLength(0);
  });
});
