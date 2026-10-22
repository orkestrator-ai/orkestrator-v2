import { afterEach, expect, test } from "bun:test";
import {
  utimesSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { unknownCapabilities } from "@orkestrator/protocol/change-evidence";
import { environmentChangeResourceKey } from "@orkestrator/protocol/change-resources";
import { ChangeEvidenceRecorder } from "@orkestrator/protocol/node/change-tracking/evidence-builders";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import {
  captureWorktree,
  DEFAULT_CAPTURE_LIMITS,
  HostCaptureExecutor,
  type CaptureExecutor,
} from "./capture.js";
import { createHarness, git, spoolSource, type Harness } from "./service-test-support.js";
import { turnIdFor } from "./turn-boundaries.js";
import { gitScopeResourceKey } from "./git-scopes.js";

const active: Harness[] = [];
afterEach(() => {
  for (const h of active.splice(0)) h.cleanup();
});
function harness(options: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness(options);
  active.push(h);
  return h;
}
const context = (requestId: string) => ({
  environmentId: "env-1",
  logicalSessionKey: "tab",
  provider: "claude",
  requestId,
});
async function begin(h: Harness, requestId: string) {
  await h.service.prepareTurnStart(context(requestId));
  h.service.markTurnDispatched("env-1", "tab", requestId, "accepted");
}
async function end(h: Harness, requestId: string) {
  await h.service.finalizeTurn(context(requestId));
  return h.service.ledger.latestMeasurement(
    "turn",
    turnIdFor("env-1", "tab", requestId),
    "turn-net",
  )!;
}
async function owner(h: Harness) {
  const id = await h.service.registry.resolve({ kind: "local", worktreePath: h.repo });
  return h.service.registry.owner(id!);
}

test("host and live detail reject decoded traversal, metadata and symlink ancestors", async () => {
  const h = harness();
  const executor = new HostCaptureExecutor(h.repo);
  mkdirSync(join(h.repo, "nested"));
  writeFileSync(join(h.repo, "nested", "secret"), "inside");
  git(h.repo, "add", "nested/secret");
  rmSync(join(h.repo, "nested"), { recursive: true });
  symlinkSync(h.dataDir, join(h.repo, "nested"));
  writeFileSync(join(h.dataDir, "secret"), "outside sentinel");
  const paths = [
    "u:../secret",
    `b:${Buffer.from("../secret").toString("base64")}`,
    "u:.git/config",
    "u:nested/secret",
  ];
  for (const pathId of paths) {
    const [record] = await executor.fetch(
      [pathId],
      DEFAULT_CAPTURE_LIMITS,
      new AbortController().signal,
    );
    expect(record?.kind).toBe("omitted");
    const detail = await h.service.diffBodies.resolveLiveDetail({
      resourceKey: environmentChangeResourceKey("env-1"),
      pathId,
    });
    if (detail.kind === "identity") {
      const body = await h.service.diffBodies.getDiff({ diffIdentityId: detail.identity.id });
      expect(JSON.stringify(body)).not.toContain("outside sentinel");
    } else expect(detail.kind).toBe("error");
  }
  const capture = await captureWorktree({ executor, store: h.service.objects });
  expect(capture.kind).toBe("captured");
  if (capture.kind === "captured")
    expect(capture.manifest.entries.some((e) => e.p === "u:nested/secret")).toBe(false);
});

test("capture requests bounded byte buffers and reports paths over its budget", async () => {
  const h = harness();
  let largestBatch = 0,
    largestLimit = 0;
  const real = new HostCaptureExecutor(h.repo);
  for (let n = 0; n < 20; n++) writeFileSync(join(h.repo, `f${n}`), "x".repeat(16));
  const executor: CaptureExecutor = {
    kind: "host-worker",
    label: "bounded",
    inventory: (...args) => real.inventory(...args),
    fetch: (paths, limits, signal) => real.fetch(paths, limits, signal),
    describe: (paths, limits, signal, cache) => {
      largestBatch = Math.max(largestBatch, paths.length);
      largestLimit = Math.max(largestLimit, limits.maxFileBytes);
      return real.describe(paths, limits, signal, cache);
    },
  };
  const result = await captureWorktree({
    executor,
    store: h.service.objects,
    limits: { maxCaptureBytes: 32, maxFileBytes: 16 },
  });
  expect(largestBatch).toBe(1);
  expect(largestLimit).toBeLessThanOrEqual(16);
  expect(result.kind).toBe("captured");
  if (result.kind === "captured") {
    expect(result.coverage.retainedBytes).toBeLessThanOrEqual(32);
    expect(result.manifest.omitted.some((o) => o.reason === "capture-byte-budget")).toBe(true);
  }
});

test("foreground and queued deadlines settle while inventory is blocked and fence late publication", async () => {
  const h = harness();
  const o = await owner(h);
  const inventory = o.executor.inventory.bind(o.executor);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  o.executor.inventory = async (...args) => {
    await gate;
    return inventory(...args);
  };
  const started = Date.now();
  const first = o.capture({ purpose: "turn-start", deadlineMs: 30 });
  const second = o.capture({ purpose: "turn-end", deadlineMs: 40 });
  expect((await first).kind).toBe("unavailable");
  expect((await second).kind).toBe("unavailable");
  expect(Date.now() - started).toBeLessThan(300);
  release();
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(h.service.ledger.snapshots()).toHaveLength(0);
});

for (const when of ["prepare", "apply"] as const)
  test(`rename restore preserves both files on an old-name conflict before ${when}`, async () => {
    const h = harness();
    await begin(h, "rename");
    renameSync(join(h.repo, "a.txt"), join(h.repo, "b.txt"));
    const m = await end(h, "rename");
    if (when === "prepare") writeFileSync(join(h.repo, "a.txt"), "user recreated\n");
    const preview = await h.service.restore.prepare({ measurementId: m.measurementId });
    expect(preview.kind).toBe("preview");
    if (preview.kind !== "preview") return;
    if (when === "prepare")
      expect(preview.files).toMatchObject([
        { action: "skip", reasonKey: "changes.restore.destination-changed" },
      ]);
    else writeFileSync(join(h.repo, "a.txt"), "user recreated\n");
    const result = await h.service.restore.apply({
      actionToken: preview.actionToken,
      idempotencyKey: when,
    });
    expect(readFileSync(join(h.repo, "a.txt"), "utf8")).toBe("user recreated\n");
    expect(readFileSync(join(h.repo, "b.txt"), "utf8")).toBe("one\ntwo\n");
    expect(
      await h.service.restore.apply({ actionToken: preview.actionToken, idempotencyKey: when }),
    ).toEqual(result);
  });

for (const when of ["prepare", "apply"] as const)
  test(`restore preserves a mode-only change before ${when}`, async () => {
    const h = harness();
    await begin(h, "mode");
    writeFileSync(join(h.repo, "a.txt"), "changed\n");
    const m = await end(h, "mode");
    if (when === "prepare") chmodSync(join(h.repo, "a.txt"), 0o755);
    const p = await h.service.restore.prepare({ measurementId: m.measurementId });
    expect(p.kind).toBe("preview");
    if (p.kind !== "preview") return;
    if (when === "prepare") expect(p.files[0]?.action).toBe("skip");
    else chmodSync(join(h.repo, "a.txt"), 0o755);
    await h.service.restore.apply({ actionToken: p.actionToken, idempotencyKey: when });
    expect(readFileSync(join(h.repo, "a.txt"), "utf8")).toBe("changed\n");
  });

test("a missing recovery checkpoint admits no writes and replays a settled failure", async () => {
  const h = harness();
  await begin(h, "checkpoint");
  writeFileSync(join(h.repo, "a.txt"), "changed\n");
  const m = await end(h, "checkpoint");
  const p = await h.service.restore.prepare({ measurementId: m.measurementId });
  if (p.kind !== "preview") throw new Error("preview");
  (await owner(h)).capture = async () => ({ kind: "unavailable", reason: "test", boundarySeq: 0 });
  const input = { actionToken: p.actionToken, idempotencyKey: "checkpoint" };
  const result = await h.service.restore.apply(input);
  expect(result.kind).toBe("error");
  expect(readFileSync(join(h.repo, "a.txt"), "utf8")).toBe("changed\n");
  expect(h.service.ledger.restoreOperationByKey("checkpoint")?.state).toBe("failed");
  expect(await h.service.restore.apply(input)).toEqual(result);
});

test("a filesystem failure after admission is settled and replayable", async () => {
  const h = harness();
  mkdirSync(join(h.repo, "dir"));
  writeFileSync(join(h.repo, "dir", "file"), "old\n");
  await begin(h, "fs");
  writeFileSync(join(h.repo, "dir", "file"), "new\n");
  const m = await end(h, "fs");
  const p = await h.service.restore.prepare({ measurementId: m.measurementId });
  if (p.kind !== "preview") throw new Error("preview");
  const o = await owner(h);
  const capture = o.capture.bind(o);
  o.capture = async (options) => {
    const result = await capture(options);
    if (options.purpose === "restore-checkpoint") {
      rmSync(join(h.repo, "dir"), { recursive: true });
      writeFileSync(join(h.repo, "dir"), "blocking parent");
    }
    return result;
  };
  const input = { actionToken: p.actionToken, idempotencyKey: "fs" };
  const result = await h.service.restore.apply(input);
  expect(result).toMatchObject({ kind: "applied", outcome: "partial" });
  expect(await h.service.restore.apply(input)).toEqual(result);
  expect(h.service.ledger.restoreOperationByKey("fs")?.state).toBe("partial");
});

test("the ending turn is fixed at idle and the next dispatch waits for its endpoint", async () => {
  const h = harness();
  await begin(h, "first");
  writeFileSync(join(h.repo, "a.txt"), "first\n");
  const spool = new ChangeEvidenceSpool();
  const source = spoolSource(spool);
  await h.service.pullEvidence(source);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  source.read = async () => {
    await gate;
    return spool.read(0);
  };
  const finishing = h.service.finalizeTurn({ environmentId: "env-1", logicalSessionKey: "tab" });
  let nextStarted = false;
  const next = h.service.prepareTurnStart(context("second")).then(() => {
    nextStarted = true;
    writeFileSync(join(h.repo, "a.txt"), "second\n");
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(nextStarted).toBe(false);
  release();
  await finishing;
  await next;
  expect(h.service.ledger.turn(turnIdFor("env-1", "tab", "first"))?.lifecycle).toBe("finalized");
  expect(h.service.ledger.turn(turnIdFor("env-1", "tab", "second"))?.end_snapshot_id).toBeNull();
  const m = h.service.ledger.latestMeasurement(
    "turn",
    turnIdFor("env-1", "tab", "first"),
    "turn-net",
  )!;
  const body = await h.service.diffBodies.getDiff({ diffIdentityId: m.diffIdentityId! });
  expect(JSON.stringify(body)).toContain("first");
  expect(JSON.stringify(body)).not.toContain('"text":"second"');
});

test("retrying an abandoned dispatch obtains a fresh start and finalizes", async () => {
  const h = harness();
  const first = await h.service.prepareTurnStart(context("retry"));
  h.service.markTurnDispatched("env-1", "tab", "retry", "rejected");
  writeFileSync(join(h.repo, "a.txt"), "idle\n");
  const second = await h.service.prepareTurnStart(context("retry"));
  expect(second.kind).toBe("ready");
  if (first.kind === "ready" && second.kind === "ready")
    expect(second.snapshotId).not.toBe(first.snapshotId);
  h.service.markTurnDispatched("env-1", "tab", "retry", "accepted");
  writeFileSync(join(h.repo, "a.txt"), "agent\n");
  expect((await end(h, "retry")).totals.additions.value).toBe(1);
});

test("inventory caps make turn and thread totals partial even for an unchanged visible prefix", async () => {
  const h = harness({ policy: { captureMaxCandidates: 1 } });
  writeFileSync(join(h.repo, "z.txt"), "before\n");
  await begin(h, "cap");
  writeFileSync(join(h.repo, "z.txt"), "after\n");
  const m = await end(h, "cap");
  for (const measurement of [
    m,
    h.service.projections.selectedMeasurement(
      h.service.threadResource("env-1", "tab")!.resourceKey,
    )!,
  ]) {
    expect(measurement.completeness.files).toBe("partial");
    expect(measurement.completeness.reasons).toContain("inventory-limit");
    expect(measurement.totals.additions.quality).not.toBe("complete");
  }
});

test("hard quota refuses further objects for every capture purpose until capacity returns", async () => {
  const h = harness();
  const o = await owner(h);
  await o.capture({ purpose: "turn-start", deadlineMs: 1000 });
  const bytes = await h.service.objects.storedBytes();
  h.service.policies.update({ snapshotHardBudgetBytes: bytes - 1 }, "tiny");
  for (const purpose of ["turn-start", "turn-end", "restore-checkpoint", "provisional"] as const) {
    const result = await o.capture({ purpose, deadlineMs: 1000 });
    expect(result).toMatchObject({ kind: "unavailable", reason: "capture-storage-quota" });
    expect(await h.service.objects.storedBytes()).toBe(bytes);
  }
  h.service.policies.update({ snapshotHardBudgetBytes: bytes + 10000 }, "room");
  expect((await o.capture({ purpose: "turn-start", deadlineMs: 1000 })).kind).toBe("published");
});

test("retention advances beyond the first 64 released turns and thread-latest owns one endpoint", async () => {
  const h = harness();
  await begin(h, "seed");
  const m = await end(h, "seed");
  const seed = h.service.ledger.turn(turnIdFor("env-1", "tab", "seed"))!;
  const snapshots = [m.beforeSnapshotId!, m.afterSnapshotId!];
  h.service.ledger.transaction(() => {
    for (let i = 0; i < 130; i++) {
      const id = `retention-${i}`;
      h.service.ledger.insertTurn({ ...seed, turn_id: id, ordinal: i + 2 });
      h.service.ledger.addReference({
        ownerKind: "turn",
        ownerId: id,
        snapshotId: snapshots[i % 2]!,
        reason: "turn-end",
      });
      h.service.ledger.addReference({
        ownerKind: "segment",
        ownerId: seed.segment_id,
        snapshotId: snapshots[i % 2]!,
        reason: "thread-latest",
      });
    }
  });
  const refs = () =>
    h
      .database()
      .db.query(
        "SELECT count(*) AS n FROM change_references WHERE owner_kind='segment' AND reason='thread-latest'",
      )
      .get() as { n: number };
  expect(refs().n).toBe(1);
  h.service.policies.update(
    { snapshotSoftBudgetBytes: 0, archivedBodyRetentionDays: 100000 },
    "pressure",
  );
  expect((await h.service.retention.run()).releasedForQuota).toBe(64);
  expect((await h.service.retention.run()).releasedForQuota).toBe(64);
  expect((await h.service.retention.run()).releasedForQuota).toBe(3);
});

test("history starts with the newest of more than one page of turns", async () => {
  const h = harness();
  await begin(h, "seed");
  await end(h, "seed");
  const seed = h.service.ledger.turn(turnIdFor("env-1", "tab", "seed"))!;
  h.service.ledger.transaction(() => {
    for (let i = 2; i <= 30; i++)
      h.service.ledger.insertTurn({ ...seed, turn_id: `history-${i}`, ordinal: i });
  });
  const page = h.service.getHistory({
    environmentId: "env-1",
    logicalSessionKey: "tab",
    pageSize: 25,
    newestFirst: true,
  });
  expect(page.kind).toBe("page");
  if (page.kind !== "page") return;
  expect(page.entries[0]?.turnId).toBe("history-30");
  expect(page.nextCursor).toBe("6");
  const older = h.service.getHistory({
    environmentId: "env-1",
    logicalSessionKey: "tab",
    pageSize: 25,
    newestFirst: true,
    cursor: page.nextCursor,
  });
  expect(older.kind === "page" && older.entries.length).toBe(5);
});

test("untracked inventory caps publish non-exact Git scope totals", async () => {
  const h = harness();
  for (let i = 0; i < 2001; i++) writeFileSync(join(h.repo, `new-${i}`), "x\n");
  const key = gitScopeResourceKey("uncommitted-net", "env-1");
  await h.service.ensureResource(key);
  const m = h.service.projections.selectedMeasurement(key)!;
  expect(m.completeness.files).toBe("partial");
  expect(m.completeness.reasons).toContain("untracked-scan-capped");
  expect(m.totals.additions.quality).toBe("partial");
  expect(m.completeness.omittedFileCount).toBeNull();
});

test("failed acknowledgments are retried on an empty pull and release retained bodies", async () => {
  const h = harness();
  const spool = new ChangeEvidenceSpool();
  const recorder = new ChangeEvidenceRecorder({
    spool,
    provider: "claude",
    capabilities: unknownCapabilities("c"),
  });
  recorder.tool(
    { conversationId: "s", callId: "c" },
    {
      toolKind: "file-edit",
      phase: "succeeded",
      executionOccurrence: "started",
      evidence: [
        {
          kind: "patch",
          text: "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n",
          claim: "provider-reported",
        },
      ],
    },
  );
  const source = spoolSource(spool);
  const ack = source.ack;
  let failures = 1;
  source.ack = async (request) => {
    if (failures-- > 0) throw new Error("lost");
    await ack(request);
  };
  await h.service.pullEvidence(source);
  expect(spool.stats().bodyBytes).toBeGreaterThan(0);
  await h.service.pullEvidence(source);
  expect(spool.stats().bodyBytes).toBe(0);
  expect(spool.stats().entries).toBe(0);
});

test("cumulative A to B to A revisions survive pulls and acknowledgments while exact redelivery dedupes", async () => {
  const h = harness();
  await begin(h, "cumulative");
  h.service.rememberConversation("env-1", "codex", "s", "tab");
  const spool = new ChangeEvidenceSpool();
  const rec = new ChangeEvidenceRecorder({
    spool,
    provider: "codex",
    capabilities: unknownCapabilities("cap"),
  });
  const source = spoolSource(spool, "codex");
  const patch = (value: string) => `--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+${value}\n`;
  for (const value of ["A", "B", "A"]) {
    rec.turnDiff({ conversationId: "s", turnId: "native" }, patch(value));
    await h.service.pullEvidence(source);
  }
  const history = h.service.getHistory({ environmentId: "env-1", logicalSessionKey: "tab" });
  if (history.kind !== "page") throw new Error("history");
  const key = history.entries[0]!.presentation.changes.find(
    (c) => c.role === "provider-turn-diff",
  )!.resourceKey;
  const m = h.service.projections.selectedMeasurement(key)!;
  const body = await h.service.diffBodies.getDiff({ diffIdentityId: m.diffIdentityId! });
  expect(JSON.stringify(body)).toContain('"text":"A"');
  expect(JSON.stringify(body)).not.toContain('"text":"B"');
  rec.turnDiff({ conversationId: "s", turnId: "native" }, patch("A"));
  expect(spool.stats().entries).toBe(0);
  expect(spool.stats().bodyBytes).toBe(0);
});

test("advancing provisional endpoints releases obsolete thread-latest pins for collection", async () => {
  const h = harness({
    policy: { provisionalSpacingLocalMs: 0, orphanGraceMs: 0, archivedBodyRetentionDays: 0 },
  });
  await begin(h, "provisional");
  const o = await owner(h);
  const intermediate: string[] = [];
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(h.repo, "a.txt"), `${i}\n`);
    await h.service.turns.provisional("env-1", o);
    intermediate.push(h.service.ledger.latestSnapshot(o.identity.worktreeId)!.id);
  }
  writeFileSync(join(h.repo, "a.txt"), "final\n");
  await end(h, "provisional");
  await h.service.retention.run(Date.now() + 100);
  for (const id of intermediate) expect(h.service.ledger.snapshot(id)).toBeNull();
  expect(h.service.ledger.snapshots()).toHaveLength(2);
});

test("reusing an old object renews its grace fence against a sweep with stale reachability", async () => {
  const h = harness();
  const bytes = new TextEncoder().encode("reused\n");
  const { id } = await h.service.objects.put("blob", bytes);
  const file = join(h.service.objects.root, "objects", id.slice(0, 2), id.slice(2));
  utimesSync(file, new Date(0), new Date(0));
  await Promise.all([
    h.service.objects.put("blob", bytes),
    h.service.objects.sweep(new Set(), 60_000),
  ]);
  expect(new TextDecoder().decode((await h.service.objects.get(id))!)).toBe("reused\n");
});

test("Pi occurrences keep distinct operations, transcript presentations and per-turn volume", async () => {
  const h = harness();
  const spool = new ChangeEvidenceSpool();
  const rec = new ChangeEvidenceRecorder({
    spool,
    provider: "pi",
    capabilities: unknownCapabilities("pi"),
  });
  const source = spoolSource(spool, "pi");
  h.service.rememberConversation("env-1", "pi", "s", "tab");
  const ids: string[] = [];
  for (const [n, text] of ["same", "same", "different"].entries()) {
    await begin(h, `pi-${n}`);
    rec.tool(
      { conversationId: "s", callId: "reused", attemptId: `row-${n}`, turnId: `pi-${n}` },
      {
        toolKind: "file-edit",
        phase: "succeeded",
        executionOccurrence: "started",
        evidence: [
          {
            kind: "patch",
            text: `--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+${text}\n`,
            claim: "provider-reported",
          },
        ],
      },
    );
    await h.service.pullEvidence(source);
    await end(h, `pi-${n}`);
    const callId = JSON.stringify(["reused", `row-${n}`]);
    const presentation = h.service.getToolPresentations({
      environmentId: "env-1",
      provider: "pi",
      conversationId: "s",
      callIds: [callId],
    }).presentations[callId]!;
    ids.push(presentation.operationId);
    const volume = h.service.ledger.latestMeasurement(
      "turn-volume",
      turnIdFor("env-1", "tab", `pi-${n}`),
      "operation-volume",
    )!;
    expect(volume.totals.additions.value).toBe(1);
    expect(volume.totals.deletions.value).toBe(1);
  }
  expect(new Set(ids).size).toBe(3);
});
