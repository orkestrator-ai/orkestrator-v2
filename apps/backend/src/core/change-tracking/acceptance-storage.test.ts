import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangeMeasurement } from "@orkestrator/protocol/change-measurements";
import {
  CHANGE_PROJECTION_CHANGED_EVENT,
  type ChangeProjectionEvent,
} from "@orkestrator/protocol/change-resources";
import type { StorageDatabase } from "../storage-database.js";
import { openBackendDatabase } from "../storage-stores.js";
import { captureWorktree, displayPath, HostCaptureExecutor, readManifest } from "./capture.js";
import { gitScopeResourceKey } from "./git-scopes.js";
import type { ChangeTrackingPolicy } from "./policy-registry.js";
import { ChangeTrackingService } from "./service.js";
import { createHarness, git, type Harness } from "./service-test-support.js";
import { turnIdFor } from "./turn-boundaries.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** chmod-based fixtures are meaningless when permission checks are bypassed. */
const runningAsRoot = process.getuid?.() === 0;

function harness(options: Parameters<typeof createHarness>[0] = {}): Harness {
  const created = createHarness(options);
  cleanups.push(() => created.cleanup());
  return created;
}

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function runTurn(h: Harness, requestId: string, work: () => void): Promise<void> {
  await h.service.prepareTurnStart({
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
}

function turnMeasurement(service: ChangeTrackingService, requestId: string): ChangeMeasurement {
  const turnId = turnIdFor("env-1", "env-env-1:tab", requestId);
  const measurement = service.ledger.latestMeasurement("turn", turnId, "turn-net");
  if (!measurement) throw new Error(`no turn measurement for ${requestId}`);
  return measurement;
}

async function bodyLines(service: ChangeTrackingService, diffIdentityId: string) {
  const body = await service.diffBodies.getDiff({ diffIdentityId });
  if (body.kind !== "body") throw new Error(`expected a body, got ${body.kind}`);
  return body.files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines));
}

/** Every snapshot row must resolve to a readable manifest whose blobs exist. */
async function danglingReferences(service: ChangeTrackingService): Promise<string[]> {
  const missing: string[] = [];
  for (const snapshot of service.ledger.snapshots()) {
    const manifest = await readManifest(service.objects, snapshot.tree_oid);
    if (!manifest) {
      missing.push(snapshot.id);
      continue;
    }
    for (const entry of manifest.entries) {
      if (entry.m !== "160000" && !(await service.objects.has(entry.o)))
        missing.push(`${snapshot.id}:${displayPath(entry.p)}`);
    }
  }
  return missing;
}

/** A fresh process over the same data directory (ledger + object store). */
function reopen(h: Harness, policy: Partial<ChangeTrackingPolicy> = {}) {
  let database: StorageDatabase | null = null;
  const events: Array<{ event: string; payload: unknown }> = [];
  const service = new ChangeTrackingService({
    dataDir: h.dataDir,
    database: () => (database ??= openBackendDatabase(h.dataDir)),
    emit: (event, payload) => events.push({ event, payload }),
    environmentTarget: async (environmentId) =>
      environmentId === "env-1" ? { kind: "local", worktreePath: h.repo } : null,
    durable: false,
    manualScheduling: true,
    policy,
  });
  // Registered before the harness cleanup runs (cleanups run in reverse).
  cleanups.push(() => {
    service.shutdown();
    database?.close();
  });
  return { service, events };
}

function announcedKeys(events: Array<{ event: string; payload: unknown }>): Set<string> {
  const keys = new Set<string>();
  for (const { event, payload } of events) {
    if (event !== CHANGE_PROJECTION_CHANGED_EVENT) continue;
    const typed = payload as ChangeProjectionEvent;
    if (typed.kind === "projection") keys.add(typed.projection.resourceKey);
  }
  return keys;
}

describe("acceptance: storage durability, retention and representation", () => {
  test("H11: crashes around object publication, ledger commit and outbox drain recover without dangling references", async () => {
    const h = harness();
    await runTurn(h, "r1", () => writeFileSync(join(h.repo, "a.txt"), "one\nTWO\n"));
    expect(h.service.ledger.pendingOutbox(100)).toHaveLength(0);

    // Crash point A: the publication transaction itself fails part-way —
    // nothing of it commits (no measurement without its outbox row).
    const appendOutbox = h.service.ledger.appendOutbox.bind(h.service.ledger);
    h.service.ledger.appendOutbox = () => {
      throw new Error("simulated crash inside the ledger commit");
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      await runTurn(h, "r-crash", () => writeFileSync(join(h.repo, "c.txt"), "lost\n"));
    } finally {
      console.warn = warn;
      h.service.ledger.appendOutbox = appendOutbox;
    }
    const crashedTurn = turnIdFor("env-1", "env-env-1:tab", "r-crash");
    expect(h.service.ledger.latestMeasurement("turn", crashedTurn, "turn-net")).toBeNull();
    expect(h.service.ledger.pendingOutbox(100)).toHaveLength(0);

    // Crash point B: the ledger commit (with its outbox rows) succeeded, the
    // process died before the outbox was drained to clients.
    h.service.publisher.drainOutbox = () => 0;
    await runTurn(h, "r2", () => writeFileSync(join(h.repo, "b.txt"), "agent\n"));
    const undelivered = h.service.ledger.pendingOutbox(100);
    expect(undelivered.length).toBeGreaterThan(0);
    const second = turnMeasurement(h.service, "r2");

    // Crash point C: objects published to the store, ledger commit never ran.
    const worktreeId = second.worktreeId;
    const fence = h.service.registry.ownerById(worktreeId)!.ownerFence();
    h.service.ledger.transaction(() =>
      h.service.ledger.reserveCapture({
        boundaryKey: "crash:objects-before-commit",
        worktreeId,
        ownerEpoch: fence,
        requiredAfterBoundarySeq: 0,
        purpose: "refresh",
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    writeFileSync(join(h.repo, "orphan.txt"), `orphan ${randomUUID()}\n`);
    const orphan = await captureWorktree({
      executor: new HostCaptureExecutor(h.repo),
      store: h.service.objects,
    });
    if (orphan.kind !== "captured") throw new Error("orphan capture failed");
    const orphanBlob = orphan.manifest.entries.find((e) => displayPath(e.p) === "orphan.txt")!.o;
    const orphanIds = [orphan.manifestId, orphanBlob];
    for (const id of orphanIds) expect(await h.service.objects.has(id)).toBe(true);
    expect(h.service.ledger.snapshots().some((s) => s.tree_oid === orphan.manifestId)).toBe(false);

    // The process dies; a new one opens the same ledger and object store.
    h.database().close();
    const restarted = reopen(h, { orphanGraceMs: 60_000 });
    restarted.service.start();
    await Bun.sleep(0);
    const { ledger } = restarted.service;

    // Outbox recovery: every committed-but-undelivered row is announced once.
    expect(ledger.pendingOutbox(100)).toHaveLength(0);
    const announced = announcedKeys(restarted.events);
    for (const row of undelivered) expect(announced.has(row.resource_key)).toBe(true);
    expect(restarted.service.publisher.drainOutbox()).toBe(0);

    // The interrupted capture attempt is abandoned, never published.
    expect(ledger.pendingCaptures()).toHaveLength(0);
    const attempt = ledger.transaction(() =>
      ledger.reserveCapture({
        boundaryKey: "crash:objects-before-commit",
        worktreeId,
        ownerEpoch: fence,
        requiredAfterBoundarySeq: 0,
        purpose: "refresh",
        deadlineAt: new Date().toISOString(),
      }),
    );
    expect(attempt).toMatchObject({ status: "abandoned", snapshot_id: null });

    // No ready row points at a missing object.
    expect(await danglingReferences(restarted.service)).toEqual([]);
    for (const requestId of ["r1", "r2"]) {
      const measurement = turnMeasurement(restarted.service, requestId);
      expect(ledger.snapshot(measurement.beforeSnapshotId!)).not.toBeNull();
      expect(ledger.snapshot(measurement.afterSnapshotId!)).not.toBeNull();
    }

    // Within the grace fence the orphan survives (it could be a concurrent
    // publication); after it, cleanup reclaims it and is idempotent.
    await restarted.service.retention.run(Date.now());
    for (const id of orphanIds) expect(await restarted.service.objects.has(id)).toBe(true);
    const later = Date.now() + 120_000;
    const first = await restarted.service.retention.run(later);
    expect(first.removedObjects).toBeGreaterThanOrEqual(orphanIds.length);
    for (const id of orphanIds) expect(await restarted.service.objects.has(id)).toBe(false);
    const again = await restarted.service.retention.run(later + 1);
    expect(again).toMatchObject({ removedObjects: 0, deletedSnapshots: 0 });
    expect(await danglingReferences(restarted.service)).toEqual([]);

    // Referenced history is still readable after both sweeps.
    const firstLines = await bodyLines(
      restarted.service,
      turnMeasurement(restarted.service, "r1").diffIdentityId!,
    );
    expect(firstLines.find((line) => line.type === "add")?.text).toBe("TWO");
    const secondLines = await bodyLines(restarted.service, second.diffIdentityId!);
    expect(secondLines.find((line) => line.type === "add")?.text).toBe("agent");
  });

  test("H15: an active body read survives eviction under its reader pin; afterwards the body is typed body-expired", async () => {
    const h = harness({ policy: { orphanGraceMs: 0 } });
    await runTurn(h, "r1", () => writeFileSync(join(h.repo, "a.txt"), "one\nthree\n"));
    const turn = turnMeasurement(h.service, "r1");
    // Drop every retention reference, as an expired window would.
    h.service.ledger.transaction(() => {
      h.service.ledger.removeReferences("turn", turn.logicalOwner.turnId!);
      h.service.ledger.removeReferences("segment", turn.logicalOwner.threadSegmentId!);
    });

    // Hold the read open at its first object access.
    const store = h.service.objects;
    const get = store.get.bind(store);
    let entered!: () => void;
    const readStarted = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let gated = true;
    store.get = async (id) => {
      if (gated) {
        gated = false;
        entered();
        await gate;
      }
      return get(id);
    };
    cleanups.push(() => {
      store.get = get;
    });

    const reading = h.service.diffBodies.getDiff({ diffIdentityId: turn.diffIdentityId! });
    await readStarted;
    expect(h.service.diffBodies.readerPins.has(turn.beforeSnapshotId!)).toBe(true);
    expect(h.service.diffBodies.readerPins.has(turn.afterSnapshotId!)).toBe(true);
    await h.service.retention.run(Date.now() + 10);
    expect(h.service.ledger.snapshot(turn.beforeSnapshotId!)).not.toBeNull();
    expect(h.service.ledger.snapshot(turn.afterSnapshotId!)).not.toBeNull();
    release();
    const body = await reading;
    expect(body.kind).toBe("body");
    if (body.kind !== "body") return;
    const lines = body.files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines));
    expect(lines.find((line) => line.type === "add")?.text).toBe("three");
    expect(h.service.diffBodies.readerPins.size).toBe(0);

    // Unpinned, the next pass evicts; the request is a typed expiry with
    // the retained counts, never a live-file fallback.
    await h.service.retention.run(Date.now() + 20);
    expect(h.service.ledger.snapshot(turn.beforeSnapshotId!)).toBeNull();
    const expired = await h.service.diffBodies.getDiff({ diffIdentityId: turn.diffIdentityId! });
    expect(expired).toMatchObject({ kind: "error", error: { code: "body-expired" } });
    expect(h.service.ledger.measurement(turn.measurementId)?.totals.additions).toEqual({
      value: 1,
      quality: "complete",
      bound: "exact",
    });
  });

  test("H16: an external clean filter never runs; raw history counts literal bytes and the Git scope reports the unsupported representation", async () => {
    const h = harness();
    const marker = join(tempDir("ork-ct-marker-"), "ran");
    git(h.repo, "config", "filter.upper.clean", `sh -c 'touch ${marker}; tr a-z A-Z'`);
    git(h.repo, "config", "filter.upper.smudge", `sh -c 'touch ${marker}; cat'`);
    git(h.repo, "config", "filter.upper.required", "true");
    writeFileSync(join(h.repo, ".gitattributes"), "a.txt filter=upper\n");
    await runTurn(h, "r1", () => {
      writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nthree\n");
      writeFileSync(join(h.repo, "plain.txt"), "plain\n");
    });

    // Physical history: literal bytes, exact counts, no filter execution.
    const turn = turnMeasurement(h.service, "r1");
    expect(turn.totals.additions).toEqual({ value: 2, quality: "complete", bound: "exact" });
    expect(turn.completeness.files).toBe("complete");

    // Git representation: the filtered path is explicitly unsupported, the
    // rest keeps exact counts, and nothing is presented as complete.
    for (const scope of ["uncommitted-net", "unstaged"] as const) {
      const key = gitScopeResourceKey(scope, "env-1");
      await h.service.ensureResource(key);
      const measurement = h.service.projections.selectedMeasurement(key);
      if (!measurement) throw new Error(`no ${scope} measurement`);
      expect(measurement.completeness.files).toBe("partial");
      expect(measurement.completeness.reasons).toContain("git-filter-unsupported");
      expect(measurement.totals.additions.quality).not.toBe("complete");
      const rows = h.service.ledger.measurementFiles(measurement.measurementId, 0, 50);
      expect(rows.find((row) => row.path_id === "u:a.txt")).toMatchObject({
        additions: null,
        additions_quality: "unknown",
        file_kind: "unknown",
        reason: "git-filter-unsupported",
      });
      if (scope === "uncommitted-net") {
        expect(rows.find((row) => row.path_id === "u:plain.txt")).toMatchObject({
          additions: 1,
          additions_quality: "complete",
          reason: null,
        });
      }
    }
    expect(existsSync(marker)).toBe(false);
  });

  test("V04: a historical rename keeps its old path and original body after later edits and repository deletion", async () => {
    const h = harness();
    await runTurn(h, "r1", () => {
      renameSync(join(h.repo, "a.txt"), join(h.repo, "renamed.txt"));
      writeFileSync(join(h.repo, "notes.txt"), "first\n");
    });
    await runTurn(h, "r2", () => writeFileSync(join(h.repo, "renamed.txt"), "rewritten\n"));
    writeFileSync(join(h.repo, "renamed.txt"), "later user edit\n");
    rmSync(h.repo, { recursive: true, force: true });

    const first = turnMeasurement(h.service, "r1");
    const rows = h.service.ledger.measurementFiles(first.measurementId, 0, 10);
    expect(rows.find((row) => row.status === "renamed")).toMatchObject({
      old_path: "u:a.txt",
      new_path: "u:renamed.txt",
    });
    const body = await h.service.diffBodies.getDiff({ diffIdentityId: first.diffIdentityId! });
    if (body.kind !== "body") throw new Error(`expected a body, got ${body.kind}`);
    expect(body.files.find((file) => file.status === "renamed")).toMatchObject({
      oldPathDisplay: "a.txt",
      newPathDisplay: "renamed.txt",
      bodyAvailability: "available",
      hunks: [],
    });
    // The rename's retained endpoint holds the original bytes, not today's.
    const after = h.service.ledger.snapshot(first.afterSnapshotId!)!;
    const manifest = await readManifest(h.service.objects, after.tree_oid);
    const entry = manifest!.entries.find((e) => displayPath(e.p) === "renamed.txt")!;
    expect(new TextDecoder().decode((await h.service.objects.get(entry.o))!)).toBe("one\ntwo\n");

    // The later edit is its own history and still resolves from the store.
    const second = turnMeasurement(h.service, "r2");
    const lines = await bodyLines(h.service, second.diffIdentityId!);
    expect(lines.filter((line) => line.type === "remove").map((line) => line.text)).toEqual([
      "one",
      "two",
    ]);
    expect(lines.filter((line) => line.type === "add").map((line) => line.text)).toEqual([
      "rewritten",
    ]);
  });

  test.skipIf(runningAsRoot)(
    "V16: a multi-file restore that fails midway persists a partial outcome naming completed and failed paths",
    async () => {
      const h = harness();
      mkdirSync(join(h.repo, "locked"));
      writeFileSync(join(h.repo, "locked", "keep.txt"), "kept\n");
      git(h.repo, "add", ".");
      git(h.repo, "commit", "-qm", "locked");
      await runTurn(h, "r1", () => {
        writeFileSync(join(h.repo, "a.txt"), "one\nagent\n");
        writeFileSync(join(h.repo, "locked", "keep.txt"), "agent\n");
      });
      const turn = turnMeasurement(h.service, "r1");
      const preview = await h.service.restore.prepare({ measurementId: turn.measurementId });
      if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
      expect(preview.files.map((file) => file.action)).toEqual(["write", "write"]);
      expect(preview.residualRiskKeys).toContain("changes.restore.risk.not-atomic");

      // The second destination becomes unwritable between preview and apply.
      const locked = join(h.repo, "locked");
      chmodSync(locked, 0o555);
      cleanups.push(() => chmodSync(locked, 0o755));
      const applied = await h.service.restore.apply({
        actionToken: preview.actionToken,
        idempotencyKey: "v16",
      });
      expect(applied).toMatchObject({
        kind: "applied",
        outcome: "partial",
        completedPathIds: ["u:a.txt"],
        failedPathIds: ["u:locked/keep.txt"],
      });
      expect(readFileSync(join(h.repo, "a.txt"), "utf8")).toBe("one\ntwo\n");
      // The failed destination is untouched and no temporary is left behind.
      expect(readFileSync(join(locked, "keep.txt"), "utf8")).toBe("agent\n");
      expect(readdirSync(locked)).toEqual(["keep.txt"]);

      const persisted = h.service.ledger.restoreOperationByKey("v16")!;
      expect(persisted.state).toBe("partial");
      expect(JSON.parse(persisted.outcome_json!)).toEqual(applied);
      // A retry returns the recorded partial outcome; it never claims complete.
      expect(
        await h.service.restore.apply({ actionToken: preview.actionToken, idempotencyKey: "v16" }),
      ).toEqual(applied);
    },
  );

  test.skipIf(runningAsRoot)(
    "C11: unreadable and oversized files are explicit partial omissions with reasons, never zero",
    async () => {
      const h = harness({ policy: { captureMaxFileBytes: 64 } });
      const secret = join(h.repo, "secret.txt");
      cleanups.push(() => chmodSync(secret, 0o644));
      await runTurn(h, "r1", () => {
        writeFileSync(secret, "hidden\nlines\n");
        chmodSync(secret, 0o000);
        writeFileSync(join(h.repo, "big.txt"), "x\n".repeat(64));
        writeFileSync(join(h.repo, "a.txt"), "one\ntwo\nthree\n");
      });
      const turn = turnMeasurement(h.service, "r1");
      expect(turn.completeness.files).toBe("partial");
      expect(turn.completeness.reasons).toEqual(
        expect.arrayContaining(["omitted-unreadable", "omitted-too-large"]),
      );
      expect(turn.completeness.omittedFileCount).toBe(2);
      expect(turn.totals.changedFiles).toBe(3);
      // Known lines stay a lower bound, not an exact total.
      expect(turn.totals.additions).toMatchObject({ value: 1, quality: "partial" });
      const rows = h.service.ledger.measurementFiles(turn.measurementId, 0, 10);
      expect(rows.find((row) => row.path_id === "u:secret.txt")).toMatchObject({
        status: "unknown",
        additions: null,
        additions_quality: "unknown",
        reason: "omitted-unreadable",
      });
      expect(rows.find((row) => row.path_id === "u:big.txt")).toMatchObject({
        status: "unknown",
        additions: null,
        reason: "omitted-too-large",
      });
    },
  );

  test("C11: a body budget truncates bodies but never the counts", async () => {
    const h = harness({ policy: { diffBatchBytes: 1 } });
    const many = Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n");
    await runTurn(h, "r1", () => {
      writeFileSync(join(h.repo, "a.txt"), "one\nTWO\n");
      writeFileSync(join(h.repo, "b.txt"), `${many}\n`);
    });
    const turn = turnMeasurement(h.service, "r1");
    expect(turn.completeness.files).toBe("complete");
    expect(turn.totals.additions).toEqual({ value: 51, quality: "complete", bound: "exact" });
    expect(turn.totals.deletions).toEqual({ value: 1, quality: "complete", bound: "exact" });
    const body = await h.service.diffBodies.getDiff({ diffIdentityId: turn.diffIdentityId! });
    if (body.kind !== "body") throw new Error(`expected a body, got ${body.kind}`);
    expect(body.files[0]).toMatchObject({ newPathDisplay: "a.txt", truncated: false });
    expect(body.files[1]).toMatchObject({
      newPathDisplay: "b.txt",
      truncated: true,
      reasonKey: "changes.body.batch-limit",
      hunks: [],
    });
    // The body's measurement is the same exact one.
    expect(body.measurement?.totals).toEqual(turn.totals);
  });
});
