/**
 * The transcript engine on its own: chunk files plus manifest rows in the
 * database, committed by the caller's transaction (plan step 16).
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BUILD_PIPELINE_TRANSCRIPT_DIRECTORY,
  BUILD_PIPELINE_TRANSCRIPT_NAMESPACE,
  BuildPipelineTranscriptStore,
  transcriptPipelineTag,
  stablePrefix,
  type BuildPipelineTranscriptFaults,
  type BuildPipelineTranscriptLimits,
  type StagedTranscript,
  type TranscriptCommitInput,
  type TranscriptCommitResult,
} from "./build-pipeline-transcript-store.js";
import {
  BUILD_PIPELINE_TRANSCRIPT_LEGACY_MIGRATION_STORE,
  BUILD_PIPELINE_TRANSCRIPT_MANIFEST_STORE,
} from "./build-pipeline-transcript-layout.js";
import { recordFileStem } from "./keyed-record-format.js";
import { writeLegacyTranscriptSession as writeLegacySession } from "./build-pipeline-transcript-test-fixtures.js";
import { transcriptFingerprint } from "./build-pipeline-service-helpers.js";
import type { StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";
import { storageFilesContain } from "./storage-test-support.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function dataDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pipeline-transcripts-"));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function open(dataDir: string): StorageDatabase {
  const database = openBackendDatabase(dataDir);
  cleanups.push(() => database.close());
  return database;
}

interface Harness {
  dataDir: string;
  directory: string;
  database: StorageDatabase;
  transcripts: BuildPipelineTranscriptStore;
}

function store(
  dataDir: string,
  options: {
    database?: StorageDatabase;
    limits?: Partial<BuildPipelineTranscriptLimits>;
    faults?: BuildPipelineTranscriptFaults;
    now?: () => number;
    live?: ReadonlySet<string>;
  } = {},
): Harness {
  const database = options.database ?? open(dataDir);
  const directory = path.join(dataDir, BUILD_PIPELINE_TRANSCRIPT_DIRECTORY);
  const transcripts = new BuildPipelineTranscriptStore({
    directory,
    database: () => database,
    limits: { targetChunkBytes: 1_024, ...options.limits },
    ...(options.faults ? { faults: () => options.faults } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.live ? { isLivePipeline: (tag: string) => options.live!.has(tag) } : {}),
  });
  return { dataDir, directory, database, transcripts };
}

function messages(count: number, size = 200, prefix = "m"): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    role: index === 0 ? "user" : "assistant",
    text: `${index}:${"x".repeat(size)}`,
  }));
}

function input(
  body: readonly unknown[],
  overrides: Partial<TranscriptCommitInput> = {},
): TranscriptCommitInput {
  return {
    pipelineId: "pipeline-1",
    sessionKey: "pipeline-1:build:0:a",
    sdkSessionId: "sdk-1",
    messages: body,
    revision: 1,
    fingerprint: transcriptFingerprint(body),
    ...overrides,
  };
}

function staged(result: TranscriptCommitResult) {
  if (result.status !== "staged") throw new Error(`stage ${result.status}: ${result.reason}`);
  return result;
}

/** Stage, then commit in a transaction the way the control write does. */
async function commit(harness: Harness, value: TranscriptCommitInput) {
  const result = staged(await harness.transcripts.stage(value));
  if (result.staged) {
    const outcome = harness.database.transaction(() =>
      harness.transcripts.commitStagedInTransaction(result.staged!),
    );
    if (!outcome.ok) throw new Error(`commit refused: ${outcome.reason}`);
    await harness.transcripts.settleCommitted([result.staged]);
  }
  return result;
}

async function chunkFiles(directory: string): Promise<Map<string, number>> {
  const inodes = new Map<string, number>();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(path.join(directory, "chunks"));
  } catch {
    return inodes;
  }
  for (const name of entries.filter((entry) => entry.endsWith(".chunk"))) {
    inodes.set(name, (await fs.stat(path.join(directory, "chunks", name))).ino);
  }
  return inodes;
}

const KEY = "pipeline-1:build:0:a";

describe("BuildPipelineTranscriptStore", () => {
  test("commits a session transcript and reads any window of it", async () => {
    const harness = store(await dataDirectory());
    const body = messages(40);
    const { reference } = await commit(harness, input(body));
    expect(reference).toMatchObject({
      version: 1,
      sdkSessionId: "sdk-1",
      manifestRevision: 1,
      revision: 1,
      messageCount: 40,
      complete: true,
    });

    const whole = await harness.transcripts.read("pipeline-1", KEY, reference);
    expect(whole).toMatchObject({ status: "found", startIndex: 0, messageCount: 40 });
    expect(whole.status === "found" ? whole.messages : []).toEqual(body);

    const before = harness.transcripts.stats().chunkReads;
    const tail = await harness.transcripts.read("pipeline-1", KEY, reference, { fromIndex: 37 });
    expect(tail.status === "found" ? tail.messages : []).toEqual(body.slice(37));
    expect(tail.status === "found" ? tail.startIndex : -1).toBe(37);
    // Only the chunks overlapping the window are read.
    expect(harness.transcripts.stats().chunkReads - before).toBeLessThanOrEqual(2);
  });

  test("a byte-budgeted read stops before the message that would exceed it", async () => {
    const harness = store(await dataDirectory());
    const body = messages(40);
    const { reference } = await commit(harness, input(body));
    const size = (index: number) => Buffer.byteLength(JSON.stringify(body[index]), "utf8");
    const before = harness.transcripts.stats().chunkReads;
    const read = await harness.transcripts.read("pipeline-1", KEY, reference, {
      fromIndex: 0,
      maxBytes: size(0) + size(1) + size(2) + 2,
    });
    expect(read).toMatchObject({ status: "found", truncated: true, messageCount: 40 });
    expect(read.status === "found" ? read.messages : []).toEqual(body.slice(0, 3));
    // Three ~230-byte messages sit in the first 1 KiB chunk.
    expect(harness.transcripts.stats().chunkReads - before).toBe(1);
  });

  test("an active tail update writes only the tail chunk and the manifest row", async () => {
    const dataDir = await dataDirectory();
    const harness = store(dataDir, { limits: { targetChunkBytes: 8_192 } });
    for (const session of ["review", "verify"]) {
      await commit(
        harness,
        input(messages(1_000, 300, session), {
          sessionKey: `pipeline-1:${session}:0:a`,
          sdkSessionId: `sdk-${session}`,
        }),
      );
    }
    const body = messages(1_000, 300);
    await commit(harness, input(body));
    const before = await chunkFiles(harness.directory);
    const statsBefore = harness.transcripts.stats();

    // The provider streams into the newest entry.
    const streamed = [...body.slice(0, -1), { ...(body.at(-1) as object), text: "streamed more" }];
    const { reference } = await commit(harness, input(streamed, { revision: 2 }));
    const stats = harness.transcripts.stats();
    const after = await chunkFiles(harness.directory);

    const chunkBytes = stats.chunkBytesWritten - statsBefore.chunkBytesWritten;
    const manifestBytes = stats.manifestBytesWritten - statsBefore.manifestBytesWritten;
    const historyBytes = 3 * 1_000 * 330;
    expect(stats.chunkWrites - statsBefore.chunkWrites).toBe(1);
    // One chunk file plus one directory fsync; the commit is SQLite's one WAL sync.
    expect(stats.fileSyncs - statsBefore.fileSyncs).toBe(2);
    expect(chunkBytes).toBeLessThanOrEqual(8_192);
    expect(chunkBytes + manifestBytes).toBeLessThan(historyBytes / 20);
    // Sealed chunks are referenced, never rewritten; the replaced tail is unlinked.
    const rewritten = [...before].filter(
      ([name, inode]) => after.has(name) && after.get(name) !== inode,
    );
    expect(rewritten).toEqual([]);
    expect(after.size).toBe(before.size);
    const read = await harness.transcripts.read("pipeline-1", KEY, reference);
    expect(read.status === "found" ? read.messages : []).toEqual(streamed);
  });

  test("an identical commit is idempotent and stages nothing", async () => {
    const harness = store(await dataDirectory());
    const body = messages(10);
    const first = await commit(harness, input(body));
    const writes = harness.transcripts.stats();
    const retry = staged(await harness.transcripts.stage(input(body, { revision: 5 })));
    expect(retry.written).toBe(false);
    expect(retry.staged).toBeUndefined();
    expect(retry.reference).toEqual(first.reference);
    expect(harness.transcripts.stats().chunkWrites).toBe(writes.chunkWrites);
    expect(harness.transcripts.stats().manifestBytesWritten).toBe(writes.manifestBytesWritten);
  });

  test("a newly omitted message advances the reference and fingerprint", async () => {
    const harness = store(await dataDirectory(), {
      limits: { maxChunkBytes: 4_096, maxSessionBytes: 20_000 },
    });
    const body = messages(1);
    const first = await commit(harness, input(body));
    const appended = [...body, { id: "huge", text: "x".repeat(10_000) }];
    const second = await commit(harness, input(appended, { revision: 2 }));
    expect(second.written).toBe(true);
    expect(second.reference.manifestRevision).toBeGreaterThan(first.reference.manifestRevision);
    expect(second.reference).toMatchObject({ complete: false, omittedMessages: 1, revision: 2 });
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  test("records oversized content as explicitly incomplete instead of failing", async () => {
    const harness = store(await dataDirectory(), {
      limits: { maxChunkBytes: 4_096, maxSessionBytes: 20_000 },
    });
    const huge = { id: "huge", role: "assistant", text: "y".repeat(10_000) };
    const body = [...messages(100, 300), huge];
    const { reference } = await commit(harness, input(body));
    expect(reference.complete).toBe(false);
    expect(reference.omittedMessages).toBe(101 - reference.messageCount);
    expect(reference.bytes).toBeLessThanOrEqual(20_000);
    const read = await harness.transcripts.read("pipeline-1", KEY, reference);
    expect(read.status === "found" ? read.messages : []).toEqual(
      body.slice(100 - reference.messageCount, 100),
    );
  });

  test("a staged checkpoint is invisible to other readers until committed", async () => {
    const dataDir = await dataDirectory();
    const harness = store(dataDir);
    const old = messages(12);
    const { reference: oldReference } = await commit(harness, input(old));
    const next = staged(
      await harness.transcripts.stage(input(messages(30, 200, "new"), { revision: 2 })),
    );

    // Another process sees only the committed manifest.
    const other = store(dataDir);
    expect(await other.transcripts.describe("pipeline-1", KEY)).toMatchObject({
      reference: { manifestRevision: 1, messageCount: 12 },
    });
    const read = await other.transcripts.read("pipeline-1", KEY, oldReference);
    expect(read).toMatchObject({ status: "found", substituted: false, revision: 1 });
    expect(read.status === "found" ? read.messages : []).toEqual(old);
    // The staging process can already page its own staged reference.
    const own = await harness.transcripts.read("pipeline-1", KEY, next.reference);
    expect(own).toMatchObject({ status: "found", messageCount: 30, substituted: false });
  });

  test("a crash between chunk write and commit leaves the old transcript; repair collects the chunks", async () => {
    const dataDir = await dataDirectory();
    const clock = { now: Date.now() };
    const body = messages(20);
    const first = store(dataDir, { now: () => clock.now });
    const { reference } = await commit(first, input(body));
    const chunksBefore = await chunkFiles(first.directory);
    const crashing = store(dataDir, {
      now: () => clock.now,
      faults: {
        at: (stage) => {
          if (stage === "after-chunks") throw new Error("crash after chunk write");
        },
      },
    });
    await expect(
      crashing.transcripts.stage(input(messages(40, 200, "next"), { revision: 2 })),
    ).rejects.toThrow("crash after chunk write");

    const restarted = store(dataDir, { now: () => clock.now });
    const read = await restarted.transcripts.read("pipeline-1", KEY, reference);
    expect(read.status === "found" ? read.messages : []).toEqual(body);
    expect((await chunkFiles(first.directory)).size).toBeGreaterThan(chunksBefore.size);

    // Inside the grace window the orphans may still belong to a staged commit.
    expect((await restarted.transcripts.repair()).removedChunks).toBe(0);
    clock.now += 11 * 60_000;
    const repair = await restarted.transcripts.repair();
    expect(repair).toMatchObject({ complete: true });
    expect(repair.removedChunks).toBeGreaterThan(0);
    expect([...(await chunkFiles(first.directory)).keys()].sort()).toEqual(
      [...chunksBefore.keys()].sort(),
    );
    const again = await restarted.transcripts.read("pipeline-1", KEY, reference);
    expect(again.status === "found" ? again.messages : []).toEqual(body);
  });

  test("a failed commit transaction leaves the old manifest and its totals", async () => {
    const harness = store(await dataDirectory());
    const body = messages(10);
    const { reference } = await commit(harness, input(body));
    const totalsBefore = harness.transcripts.rows.totals();
    const next = staged(
      await harness.transcripts.stage(input(messages(25, 200, "next"), { revision: 2 })),
    );
    expect(() =>
      harness.database.transaction(() => {
        expect(harness.transcripts.commitStagedInTransaction(next.staged!)).toEqual({ ok: true });
        throw new Error("control write failed");
      }),
    ).toThrow("control write failed");
    expect(harness.transcripts.rows.totals()).toEqual(totalsBefore);
    const read = await store(harness.dataDir).transcripts.read("pipeline-1", KEY, reference);
    expect(read).toMatchObject({ status: "found", substituted: false, messageCount: 10 });
  });

  test("a commit staged on a stale base is refused, in-process or across processes", async () => {
    const dataDir = await dataDirectory();
    const a = store(dataDir);
    const b = store(dataDir);
    await commit(a, input(messages(5)));
    const fromA = staged(await a.transcripts.stage(input(messages(8, 200, "a"), { revision: 2 })));
    const fromB = staged(await b.transcripts.stage(input(messages(9, 200, "b"), { revision: 2 })));
    expect(fromA.reference.manifestRevision).toBe(2);
    expect(fromB.reference.manifestRevision).toBe(2);

    expect(
      b.database.transaction(() => b.transcripts.commitStagedInTransaction(fromB.staged!)),
    ).toEqual({ ok: true });
    await b.transcripts.settleCommitted([fromB.staged!]);
    // A's checkpoint was planned against revision 1: it must not overwrite B's.
    expect(
      a.database.transaction(() => a.transcripts.commitStagedInTransaction(fromA.staged!)),
    ).toEqual({ ok: false, reason: "conflict" });
    await a.transcripts.discard([fromA.staged!]);
    const read = await a.transcripts.read("pipeline-1", KEY, fromB.reference);
    expect(read).toMatchObject({ status: "found", messageCount: 9, substituted: false });
    expect(read.status === "found" ? read.messages : []).toEqual(messages(9, 200, "b"));
  });

  test("a commit whose new chunk vanished is refused", async () => {
    const harness = store(await dataDirectory());
    await commit(harness, input(messages(3)));
    const next = staged(await harness.transcripts.stage(input(messages(6, 200, "n"))));
    const chunk = next.staged!.newChunks[0]!;
    await fs.rm(path.join(harness.directory, "chunks", chunk.name));
    expect(
      harness.database.transaction(() =>
        harness.transcripts.commitStagedInTransaction(next.staged!),
      ),
    ).toEqual({ ok: false, reason: "chunk-missing" });
  });

  test("never unlinks a chunk a committed manifest references", async () => {
    const harness = store(await dataDirectory());
    const { reference } = await commit(harness, input(messages(30)));
    const names = [...(await chunkFiles(harness.directory)).keys()];
    expect(await harness.transcripts.unlinkUnreferenced(names)).toBe(0);
    const read = await harness.transcripts.read("pipeline-1", KEY, reference);
    expect(read).toMatchObject({ status: "found", messageCount: 30 });
  });

  test("quota admission refuses at staging and again inside the commit", async () => {
    const harness = store(await dataDirectory(), { limits: { maxTotalBytes: 25_000 } });
    await commit(harness, input(messages(10)));
    expect(
      await harness.transcripts.stage(input(messages(100), { sessionKey: "pipeline-1:big" })),
    ).toEqual({ status: "rejected", reason: "quota-exceeded" });

    // Two checkpoints that each fit, but not together: the second commit is refused.
    const one = staged(
      await harness.transcripts.stage(input(messages(12, 1_000, "one"), { sessionKey: "s1" })),
    );
    const two = staged(
      await harness.transcripts.stage(input(messages(12, 1_000, "two"), { sessionKey: "s2" })),
    );
    expect(
      harness.database.transaction(() =>
        harness.transcripts.commitStagedInTransaction(one.staged!),
      ),
    ).toEqual({ ok: true });
    expect(
      harness.database.transaction(() =>
        harness.transcripts.commitStagedInTransaction(two.staged!),
      ),
    ).toEqual({ ok: false, reason: "quota-exceeded" });
    expect(harness.transcripts.rows.totals().bytes).toBeLessThanOrEqual(25_000);
  });

  test("the session count is bounded", async () => {
    const harness = store(await dataDirectory(), { limits: { maxSessions: 2 } });
    await commit(harness, input(messages(2), { sessionKey: "a" }));
    await commit(harness, input(messages(2), { sessionKey: "b" }));
    expect(await harness.transcripts.stage(input(messages(2), { sessionKey: "c" }))).toEqual({
      status: "rejected",
      reason: "too-many-sessions",
    });
    // Replacing an existing session is still admitted.
    await commit(harness, input(messages(3), { sessionKey: "a" }));
  });

  test("deleting a pipeline removes its manifest rows from the database files and unlinks its chunks", async () => {
    const harness = store(await dataDirectory());
    const marker = "SDK-SESSION-MARKER-4242";
    await commit(harness, input(messages(10), { sdkSessionId: marker }));
    await commit(
      harness,
      input(messages(10), { sessionKey: "pipeline-1:review:0:b", sdkSessionId: `${marker}-b` }),
    );
    await commit(harness, input(messages(5), { pipelineId: "pipeline-2" }));
    const otherChunks = await chunkFiles(harness.directory);

    const deleted = harness.database.transaction(() =>
      harness.transcripts.deletePipelineInTransaction("pipeline-1"),
    );
    expect(deleted.sessions).toBe(2);
    harness.database.scrubDeletedContent();
    await harness.transcripts.unlinkUnreferenced(deleted.chunks);

    expect(storageFilesContain(harness.dataDir, marker)).toBe(false);
    expect(await harness.transcripts.describe("pipeline-1", KEY)).toBeNull();
    expect(await harness.transcripts.describe("pipeline-2", KEY)).not.toBeNull();
    const remaining = await chunkFiles(harness.directory);
    expect(remaining.size).toBeGreaterThan(0);
    expect(remaining.size).toBeLessThan(otherChunks.size);
    for (const name of deleted.chunks) expect(remaining.has(name)).toBe(false);
    expect(harness.transcripts.rows.totals().sessions).toBe(1);
  });

  test("the orphan sweep removes rows no live pipeline owns after the grace window", async () => {
    const dataDir = await dataDirectory();
    const clock = { now: Date.now() };
    const live = new Set([transcriptPipelineTag("pipeline-1")]);
    const harness = store(dataDir, { now: () => clock.now, live });
    await commit(harness, input(messages(5)));
    await commit(harness, input(messages(5), { pipelineId: "orphan" }));

    expect(await harness.transcripts.sweepOrphans()).toBe(0);
    clock.now += 11 * 60_000;
    expect(await harness.transcripts.sweepOrphans()).toBe(1);
    expect(await harness.transcripts.describe("orphan", KEY)).toBeNull();
    expect(await harness.transcripts.describe("pipeline-1", KEY)).not.toBeNull();
  });

  test("raw row writes move the store revision every connection observes", async () => {
    const dataDir = await dataDirectory();
    const harness = store(dataDir);
    const observer = open(dataDir);
    expect(observer.storeRevision(BUILD_PIPELINE_TRANSCRIPT_MANIFEST_STORE)).toBeNull();
    await commit(harness, input(messages(5)));
    const first = observer.storeRevision(BUILD_PIPELINE_TRANSCRIPT_MANIFEST_STORE)!;
    const assembled = observer.readStore(BUILD_PIPELINE_TRANSCRIPT_MANIFEST_STORE)?.value as Record<
      string,
      { revision: number }
    >;
    expect(Object.values(assembled).map((row) => row.revision)).toEqual([1]);
    await commit(harness, input(messages(6), { revision: 2 }));
    expect(observer.storeRevision(BUILD_PIPELINE_TRANSCRIPT_MANIFEST_STORE)).toBeGreaterThan(first);
    const reread = observer.readStore(BUILD_PIPELINE_TRANSCRIPT_MANIFEST_STORE)?.value as Record<
      string,
      { revision: number }
    >;
    expect(Object.values(reread).map((row) => row.revision)).toEqual([2]);
  });
});

describe("pre-database manifest migration", () => {
  test("a transient manifest read failure keeps the migration cursor and recovery files", async () => {
    const dataDir = await dataDirectory();
    const directory = path.join(dataDir, BUILD_PIPELINE_TRANSCRIPT_DIRECTORY);
    const body = messages(4, 50, "retry");
    const key = await writeLegacySession(directory, "pipeline-1", KEY, body);
    const file = path.join(
      directory,
      "manifests",
      `${recordFileStem(BUILD_PIPELINE_TRANSCRIPT_NAMESPACE, key)}.rec`,
    );
    const harness = store(dataDir);
    const original = fs.lstat.bind(fs);
    let failed = false;
    const failedRead = async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === file && !failed) {
        failed = true;
        throw Object.assign(new Error("temporary I/O failure"), { code: "EIO" });
      }
      return original(...args);
    };
    const fault = spyOn(fs, "lstat").mockImplementation(failedRead as typeof fs.lstat);
    try {
      expect(await harness.transcripts.migrateLegacyManifests()).toMatchObject({
        complete: false,
        imported: 0,
      });
    } finally {
      fault.mockRestore();
    }
    expect(failed).toBe(true);
    expect((await fs.stat(file)).isFile()).toBe(true);
    expect(await harness.transcripts.repair(0)).toMatchObject({
      complete: false,
      removedChunks: 0,
    });
    expect(await harness.transcripts.migrateLegacyManifests()).toMatchObject({
      complete: true,
      imported: 1,
    });
    const read = await harness.transcripts.read("pipeline-1", KEY, { manifestRevision: 1 });
    expect(read.status === "found" ? read.messages : []).toEqual(body);
  });

  test("imports file manifests in resumable batches, then removes the old files", async () => {
    const dataDir = await dataDirectory();
    const directory = path.join(dataDir, BUILD_PIPELINE_TRANSCRIPT_DIRECTORY);
    const bodies = new Map<string, unknown[]>();
    for (const index of [0, 1, 2, 3, 4]) {
      const body = messages(6 + index, 50, `legacy-${index}`);
      bodies.set(`s${index}`, body);
      await writeLegacySession(directory, "pipeline-1", `s${index}`, body, { revision: 3 });
    }
    await writeLegacySession(directory, "deleted", "s0", messages(3, 50, "gone"));
    const live = new Set([transcriptPipelineTag("pipeline-1")]);

    let batches = 0;
    const crashing = store(dataDir, {
      live,
      faults: {
        at: (stage) => {
          if (stage === "legacy-manifest-batch" && ++batches === 2) throw new Error("crash");
        },
      },
    });
    await expect(crashing.transcripts.migrateLegacyManifests({ batchSize: 2 })).rejects.toThrow(
      "crash",
    );
    const progress = crashing.database.readStore(BUILD_PIPELINE_TRANSCRIPT_LEGACY_MIGRATION_STORE)
      ?.value as { status: string; cursor: string; imported: number };
    const importedBeforeCrash = progress.imported;
    expect(progress.status).toBe("importing");
    expect(importedBeforeCrash).toBeGreaterThan(0);

    // A fresh process resumes after the last committed batch.
    const resumed = store(dataDir, { live, database: open(dataDir) });
    const report = await resumed.transcripts.migrateLegacyManifests({ batchSize: 2 });
    expect(report.complete).toBe(true);
    expect(report.imported + importedBeforeCrash).toBe(5);
    await expect(fs.stat(path.join(directory, "manifests"))).rejects.toThrow();
    for (const [sessionKey, body] of bodies) {
      const read = await resumed.transcripts.read("pipeline-1", sessionKey, {
        manifestRevision: 3,
      });
      expect(read).toMatchObject({
        status: "found",
        substituted: false,
        messageCount: body.length,
      });
      expect(read.status === "found" ? read.messages : []).toEqual(body);
    }
    // A pipeline without a control record is never resurrected.
    expect(await resumed.transcripts.describe("deleted", "s0")).toBeNull();
    // Re-running is a no-op.
    expect(await resumed.transcripts.migrateLegacyManifests()).toEqual({
      imported: 0,
      skipped: 0,
      complete: true,
    });
    // Its unreferenced chunks are collected once migration finished.
    const repair = await resumed.transcripts.repair(0);
    expect(repair).toMatchObject({ complete: true, removedChunks: 2 });
  });

  test("a read ahead of the background job imports that session on demand", async () => {
    const dataDir = await dataDirectory();
    const directory = path.join(dataDir, BUILD_PIPELINE_TRANSCRIPT_DIRECTORY);
    const body = messages(9, 50, "on-demand");
    await writeLegacySession(directory, "pipeline-1", KEY, body, { revision: 4 });
    const harness = store(dataDir);
    // Repair cannot prove legacy chunks unreferenced before the import.
    expect(await harness.transcripts.repair(0)).toMatchObject({
      complete: false,
      removedChunks: 0,
    });
    const read = await harness.transcripts.read("pipeline-1", KEY, { manifestRevision: 4 });
    expect(read.status === "found" ? read.messages : []).toEqual(body);
    // The next checkpoint continues the imported revision sequence and reuses its chunks.
    const writes = harness.transcripts.stats().chunkWrites;
    const next = await commit(harness, input([...body, { id: "new" }], { revision: 5 }));
    expect(next.reference.manifestRevision).toBe(5);
    expect(harness.transcripts.stats().chunkWrites - writes).toBe(1);
    expect((await harness.transcripts.migrateLegacyManifests()).imported).toBe(0);
  });

  test("a corrupt current file falls back to the retained previous generation", async () => {
    const dataDir = await dataDirectory();
    const directory = path.join(dataDir, BUILD_PIPELINE_TRANSCRIPT_DIRECTORY);
    const body = messages(4, 50, "previous");
    const key = await writeLegacySession(directory, "pipeline-1", KEY, body, {
      revision: 2,
      generation: ".prev",
    });
    const stem = recordFileStem(BUILD_PIPELINE_TRANSCRIPT_NAMESPACE, key);
    await fs.writeFile(path.join(directory, "manifests", `${stem}.rec`), "corrupt");
    const harness = store(dataDir);
    expect((await harness.transcripts.migrateLegacyManifests()).imported).toBe(1);
    const read = await harness.transcripts.read("pipeline-1", KEY, { manifestRevision: 2 });
    expect(read.status === "found" ? read.messages : []).toEqual(body);
  });
});

describe("transcript engine failure injection", () => {
  test("a database failure during the commit refuses it without touching rows or totals", async () => {
    const harness = store(await dataDirectory());
    await commit(harness, input(messages(4)));
    const next = staged(await harness.transcripts.stage(input(messages(7, 200, "x"))));
    const failing = spyOn(harness.database, "writeStoreInTransaction").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    try {
      expect(() =>
        harness.database.transaction(() =>
          harness.transcripts.commitStagedInTransaction(next.staged as StagedTranscript),
        ),
      ).toThrow("disk I/O error");
    } finally {
      failing.mockRestore();
    }
    expect(await harness.transcripts.describe("pipeline-1", KEY)).toMatchObject({
      reference: { manifestRevision: 1, messageCount: 4 },
    });
    expect(harness.transcripts.rows.totals().sessions).toBe(1);
  });
});

describe("transcript prefix fallbacks", () => {
  for (const edited of [false, true]) {
    test(`a shrinking transcript retains only unchanged leading rows (edited: ${edited})`, async () => {
      const harness = store(await dataDirectory(), { limits: { targetChunkBytes: 8_192 } });
      const first = messages(50, 50);
      await commit(harness, input(first));
      const shrunk = first.slice(0, 40);
      if (edited) shrunk[10] = { id: "changed", text: "changed before the removed tail" };
      const { reference } = await commit(harness, input(shrunk, { revision: 2 }));
      const read = await harness.transcripts.read("pipeline-1", KEY, reference);
      if (read.status !== "found") throw new Error("expected transcript");
      const from = stablePrefix(read, 1);
      expect(from).toBe(edited ? 10 : 40);
      expect([...first.slice(0, from), ...read.messages.slice(from)]).toEqual(shrunk);
    });
  }

  test("a checkpoint reusing its base display revision drops the ambiguous edit chain", async () => {
    const harness = store(await dataDirectory());
    const first = messages(20, 20);
    await commit(harness, input(first));
    const second = [...first];
    second[19] = { id: "changed-tail", text: "second" };
    await commit(harness, input(second, { revision: 2 }));
    const third = [...second];
    third[10] = { id: "changed-earlier", text: "third" };
    const { reference } = await commit(harness, input(third, { revision: 2 }));
    const read = await harness.transcripts.read("pipeline-1", KEY, reference);
    if (read.status !== "found") throw new Error("expected transcript");
    expect(read.manifestRevision).toBe(3);
    expect(read.revision).toBe(2);
    expect(stablePrefix(read, 1)).toBeUndefined();
    expect(read.changes).toBeUndefined();
    expect(read.messages).toEqual(third);
  });

  test("a reader older than the 32-checkpoint history must reconcile whole", async () => {
    const harness = store(await dataDirectory());
    const first = messages(20, 20);
    const { reference: initial } = await commit(harness, input(first));
    let body = first;
    for (let revision = 2; revision <= 35; revision += 1) {
      body = [...body];
      body[19] = { id: "stream", text: `revision ${revision}` };
      await commit(harness, input(body, { revision }));
    }
    const read = await harness.transcripts.read("pipeline-1", KEY, initial);
    if (read.status !== "found") throw new Error("expected transcript");
    expect(read.changes).toHaveLength(32);
    expect(stablePrefix(read, 1)).toBeUndefined();
    expect(stablePrefix(read, 34)).toBe(19);
    expect(read.messages).toEqual(body);
  });

  for (const eviction of ["uncommitted stages", "session cache limit"]) {
    test(`tail digest eviction after ${eviction} falls back to a conservative chunk prefix`, async () => {
      const harness = store(await dataDirectory(), { limits: { targetChunkBytes: 8_192 } });
      const first = messages(20, 50);
      await commit(harness, input(first));
      if (eviction === "uncommitted stages") {
        for (let index = 0; index < 3; index += 1) {
          const candidate = [...first];
          candidate[19] = { id: "uncommitted", text: `candidate ${index}` };
          staged(await harness.transcripts.stage(input(candidate, { revision: 2 })));
        }
      } else {
        for (let index = 0; index < 65; index += 1) {
          await commit(harness, input(messages(1, 20), { sessionKey: `other-${index}` }));
        }
      }
      const second = [...first];
      second[17] = { id: "late-result", text: "changed row 17" };
      const { reference } = await commit(harness, input(second, { revision: 2 }));
      const read = await harness.transcripts.read("pipeline-1", KEY, reference);
      if (read.status !== "found") throw new Error("expected transcript");
      const from = stablePrefix(read, 1);
      // Every row fits the mutable chunk. Its evicted digests cannot prove
      // row-level equality, so the entire chunk must be sent again.
      expect(from).toBe(0);
      expect([...first.slice(0, from), ...read.messages.slice(from)]).toEqual(second);
    });
  }
});
