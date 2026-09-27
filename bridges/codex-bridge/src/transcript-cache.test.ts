import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rename, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireTranscriptSnapshot,
  clearTranscriptCache,
  foldTranscript,
  forEachTranscriptBatch,
  getTranscriptCacheStats,
  readTranscriptSince,
  setTranscriptCacheLimitsForTesting,
  unreadableRolloutRecord,
  UNREADABLE_ROLLOUT_RECORD_TYPE,
} from "./transcript-cache.js";
import { parseTranscriptRecordLine, type TranscriptRecord } from "./subagent-transcript.js";

const tempDirs: string[] = [];

afterEach(async () => {
  clearTranscriptCache();
  setTranscriptCacheLimitsForTesting();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempTranscript(filename = "session.jsonl"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-transcript-cache-"));
  tempDirs.push(dir);
  return join(dir, filename);
}

async function readAll(
  path: string,
): Promise<{ records: TranscriptRecord[]; status: string; ok: boolean }> {
  const snapshot = await acquireTranscriptSnapshot(path);
  const records: TranscriptRecord[] = [];
  const ok = await forEachTranscriptBatch(snapshot, (batch) => records.push(...batch));
  return { records, status: snapshot.status, ok };
}

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

function message(index: number, text = `message ${index}`): string {
  return line({
    timestamp: new Date(Date.UTC(2026, 8, 1, 12, 0, index)).toISOString(),
    type: "event_msg",
    payload: { type: "agent_message", phase: "commentary", message: text },
  });
}

/** Filler records a child fold ignores, so fold memos stay small. */
function filler(index: number, padding = 400): string {
  return line({
    timestamp: new Date(Date.UTC(2026, 8, 1, 12, 0, index)).toISOString(),
    type: "event_msg",
    payload: { type: "token_count", index, padding: "p".repeat(padding) },
  });
}

/** A counting reducer: `step` calls reveal whether records were re-folded. */
function countingReducer() {
  let steps = 0;
  return {
    reducer: {
      key: "test-count",
      init: () => ({ count: 0 }),
      step: (state: { count: number }) => {
        steps += 1;
        state.count += 1;
      },
      result: (state: { count: number }, status: string) => ({ count: state.count, status }),
      estimateBytes: () => 64,
    },
    steps: () => steps,
  };
}

describe("rollout cache: appends and boundaries", () => {
  test("appends only complete new lines across incremental reads", async () => {
    const transcriptPath = await createTempTranscript();
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "call-spawn-1",
          arguments: "{}",
        },
      })}\n{"timestamp":"2026-04-16T11:17:24.000Z","type":"event_msg"`,
      "utf8",
    );

    const initial = await readAll(transcriptPath);
    expect(initial.records).toHaveLength(1);

    await appendFile(
      transcriptPath,
      `${',"payload":{"type":"agent_message","phase":"commentary","message":"working"}}\n'}${JSON.stringify(
        {
          timestamp: "2026-04-16T11:17:25.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
          },
        },
      )}\n`,
      "utf8",
    );

    const updated = await readAll(transcriptPath);
    expect(updated.records).toHaveLength(3);
    expect(updated.records[1]?.payload?.type).toBe("agent_message");
    expect(updated.records[2]?.payload?.type).toBe("task_complete");
    expect(getTranscriptCacheStats()).toMatchObject({ coldScans: 1, appendScans: 1 });
  });

  test("an append that completes a UTF-8 sequence split across writes decodes it once", async () => {
    const path = await createTempTranscript();
    const record = Buffer.from(
      `${JSON.stringify({ type: "event_msg", payload: { message: "café 🙂" } })}\n`,
    );
    // Split inside the four-byte emoji.
    const split = record.indexOf(Buffer.from("🙂")) + 2;
    await writeFile(path, record.subarray(0, split));
    expect((await readAll(path)).records).toEqual([]);

    await appendFile(path, record.subarray(split));
    const { records, status } = await readAll(path);
    expect(status).toBe("complete");
    expect(records.map((entry) => entry.payload?.message)).toEqual(["café 🙂"]);
  });

  test("CRLF line endings and blank lines parse like LF", async () => {
    const path = await createTempTranscript();
    await writeFile(path, `{"type":"a"}\r\n\r\n\n{"type":"b"}\r\n`);
    expect((await readAll(path)).records.map((record) => record.type)).toEqual(["a", "b"]);
  });

  test("corrupt lines become positioned markers and the read is degraded, not empty", async () => {
    const path = await createTempTranscript();
    await writeFile(path, `{"type":"a"}\n{broken\n{"type":"b"}\n`);

    const { records, status } = await readAll(path);

    expect(status).toBe("degraded");
    expect(records.map((record) => record.type)).toEqual([
      "a",
      UNREADABLE_ROLLOUT_RECORD_TYPE,
      "b",
    ]);
    expect(unreadableRolloutRecord(records[1]!)).toEqual({
      reason: "corrupt",
      offset: 13,
      bytes: 8,
    });
  });

  test("an overlong record, even one completed by a later append, is skipped with its range", async () => {
    setTranscriptCacheLimitsForTesting({ maxRecordBytes: 64, chunkBytes: 16 });
    const path = await createTempTranscript();
    const before = `{"type":"a"}\n`;
    await writeFile(path, `${before}{"type":"big","pad":"${"x".repeat(80)}`);
    expect((await readAll(path)).records.map((record) => record.type)).toEqual(["a"]);

    await appendFile(path, `${"x".repeat(40)}"}\n{"type":"b"}\n`);
    const { records, status } = await readAll(path);

    expect(status).toBe("degraded");
    expect(records.map((record) => record.type)).toEqual([
      "a",
      UNREADABLE_ROLLOUT_RECORD_TYPE,
      "b",
    ]);
    const bigLength = Buffer.byteLength(`{"type":"big","pad":"${"x".repeat(120)}"}\n`);
    expect(unreadableRolloutRecord(records[1]!)).toEqual({
      reason: "overlong",
      offset: Buffer.byteLength(before),
      bytes: bigLength,
    });
  });
});

describe("rollout cache: replacement and races", () => {
  test("reloads from scratch when the transcript is rewritten at the same size", async () => {
    const transcriptPath = await createTempTranscript();
    await writeFile(transcriptPath, line({ type: "event_msg", payload: { message: "old" } }));

    const initial = await readAll(transcriptPath);
    expect(initial.records[0]?.payload?.message).toBe("old");

    await writeFile(transcriptPath, line({ type: "event_msg", payload: { message: "new" } }));
    const replacementTime = new Date(Date.now() + 1000);
    await utimes(transcriptPath, replacementTime, replacementTime);

    const replaced = await readAll(transcriptPath);
    expect(replaced.records).toHaveLength(1);
    expect(replaced.records[0]?.payload?.message).toBe("new");
    expect(getTranscriptCacheStats().coldScans).toBe(2);
  });

  test("an inode swap rotates the generation", async () => {
    const path = await createTempTranscript();
    await writeFile(path, `{"type":"a"}\n`);
    const first = await acquireTranscriptSnapshot(path);

    const replacement = `${path}.tmp`;
    await writeFile(replacement, `{"type":"b"}\n{"type":"c"}\n`);
    await rename(replacement, path);

    const second = await acquireTranscriptSnapshot(path);
    expect(second.fileId).not.toBe(first.fileId);
    expect(second.generation).not.toBe(first.generation);
    expect((await readAll(path)).records.map((record) => record.type)).toEqual(["b", "c"]);
  });

  test("a shrink reloads rather than keeping stale records", async () => {
    const path = await createTempTranscript();
    await writeFile(path, `{"type":"a"}\n{"type":"b"}\n`);
    await readAll(path);

    await truncate(path, Buffer.byteLength(`{"type":"a"}\n`));
    expect((await readAll(path)).records.map((record) => record.type)).toEqual(["a"]);
    expect(getTranscriptCacheStats().coldScans).toBe(2);
  });

  test("growth over rewritten bytes is detected and not treated as an append", async () => {
    const path = await createTempTranscript();
    await writeFile(path, `{"type":"a"}\n`);
    await readAll(path);

    // Same inode, larger, but the bytes before the old boundary changed.
    await writeFile(path, `{"type":"x"}\n{"type":"y"}\n`);
    expect((await readAll(path)).records.map((record) => record.type)).toEqual(["x", "y"]);
    expect(getTranscriptCacheStats()).toMatchObject({ coldScans: 2, appendScans: 0 });
  });

  test("a file removed mid-read keeps the identity its bytes came from", async () => {
    setTranscriptCacheLimitsForTesting({ chunkBytes: 64 });
    const path = await createTempTranscript();
    await writeFile(path, Array.from({ length: 200 }, (_, index) => message(index)).join(""));

    const reading = acquireTranscriptSnapshot(path);
    while (getTranscriptCacheStats().coldScans === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await rm(path);
    const snapshot = await reading;

    // The open descriptor still reads the removed inode to the end, and the
    // result is labelled with that inode — not mixed with anything newer.
    expect(snapshot.status).toBe("complete");
    expect(snapshot.recordCount).toBe(200);

    const after = await readTranscriptSince(path, 0);
    expect(after).toEqual({ records: [], status: "unavailable" });
    expect(getTranscriptCacheStats().entries).toBe(0);
  });

  test("a file truncated mid-read is re-read instead of installing mixed bytes", async () => {
    setTranscriptCacheLimitsForTesting({ chunkBytes: 64 });
    const path = await createTempTranscript();
    await writeFile(path, Array.from({ length: 200 }, (_, index) => message(index)).join(""));

    const reading = acquireTranscriptSnapshot(path);
    while (getTranscriptCacheStats().coldScans === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await writeFile(path, message(999));
    const snapshot = await reading;

    expect(snapshot.recordCount).toBe(1);
    expect((await readAll(path)).records[0]?.payload?.message).toBe("message 999");
  });

  test("a rollout removed after indexing reports unavailable, not an empty transcript", async () => {
    setTranscriptCacheLimitsForTesting({
      blockSourceBytes: 256,
      softBudgetBytes: 0,
      hardBudgetBytes: 0,
    });
    const path = await createTempTranscript();
    await writeFile(path, Array.from({ length: 20 }, (_, index) => message(index)).join(""));
    const snapshot = await acquireTranscriptSnapshot(path);
    expect(snapshot.blocks.every((block) => block.records === undefined)).toBe(true);

    await rm(path);
    expect(await forEachTranscriptBatch(snapshot, () => undefined)).toBe(false);
    expect(await readTranscriptSince(path, 0)).toEqual({ records: [], status: "unavailable" });
  });
});

describe("rollout cache: sharing and bounds", () => {
  test("concurrent cold reads of one rollout share a single source read", async () => {
    const path = await createTempTranscript();
    await writeFile(path, Array.from({ length: 50 }, (_, index) => message(index)).join(""));
    const { reducer } = countingReducer();

    const results = await Promise.all([
      readTranscriptSince(path, 0),
      readTranscriptSince(path, 0),
      foldTranscript(path, reducer),
      acquireTranscriptSnapshot(path),
      foldTranscript(path, reducer),
    ]);

    expect(getTranscriptCacheStats()).toMatchObject({ coldScans: 1, appendScans: 0 });
    expect(results[0]).toEqual(results[1]);
    expect(results[2]).toEqual({ count: 50, status: "complete" });
    expect(results[4]).toEqual({ count: 50, status: "complete" });
  });

  test("a failing consumer does not poison concurrent or later readers", async () => {
    const path = await createTempTranscript();
    await writeFile(path, Array.from({ length: 10 }, (_, index) => message(index)).join(""));
    const throwing = {
      key: "throws",
      init: () => ({}),
      step: () => {
        throw new Error("consumer failed");
      },
      result: () => null,
      estimateBytes: () => 0,
    };

    const [failed, peer] = await Promise.allSettled([
      foldTranscript(path, throwing),
      readTranscriptSince(path, 0),
    ]);

    expect(failed.status).toBe("rejected");
    expect(peer.status === "fulfilled" && peer.value.records).toHaveLength(10);
    const { reducer } = countingReducer();
    expect(await foldTranscript(path, reducer)).toEqual({ count: 10, status: "complete" });
    expect(getTranscriptCacheStats().coldScans).toBe(1);
  });

  test("a rollout above the hard budget is served repeatedly without re-parsing it", async () => {
    const hardBudgetBytes = 24 * 1024;
    setTranscriptCacheLimitsForTesting({
      softBudgetBytes: 8 * 1024,
      hardBudgetBytes,
      blockSourceBytes: 2 * 1024,
      chunkBytes: 1024,
    });
    const path = await createTempTranscript();
    const count = 128;
    const contents = Array.from({ length: count }, (_, index) => filler(index)).join("");
    await writeFile(path, contents);
    const sourceBytes = Buffer.byteLength(contents);
    // Fully resident, this rollout would be several times the hard budget.
    expect(sourceBytes * 3).toBeGreaterThan(hardBudgetBytes * 4);

    const since = Date.UTC(2026, 8, 1, 12, 0, count - 8);
    const first = await readTranscriptSince(path, since);
    expect(first.records).toHaveLength(8);
    const afterFirst = getTranscriptCacheStats();
    expect(afterFirst.coldScans).toBe(1);
    expect(afterFirst.sourceBytesRead).toBe(sourceBytes);
    expect(afterFirst.bytes).toBeLessThanOrEqual(hardBudgetBytes);
    expect(afterFirst.residentSourceBytes).toBeLessThan(sourceBytes);

    for (let index = 0; index < 20; index += 1) {
      expect(await readTranscriptSince(path, since)).toEqual(first);
    }
    // The turn's blocks stay resident: no source byte was read again.
    expect(getTranscriptCacheStats()).toMatchObject({
      coldScans: 1,
      sourceBytesRead: sourceBytes,
      blockRereads: 0,
    });

    // A whole-history fold re-reads shed blocks once, transiently...
    const counting = countingReducer();
    expect(await foldTranscript(path, counting.reducer)).toEqual({
      count,
      status: "complete",
    });
    const afterFold = getTranscriptCacheStats();
    expect(afterFold.bytes).toBeLessThanOrEqual(hardBudgetBytes);
    // ...and is then memoised: repeating it reads and folds nothing.
    for (let index = 0; index < 5; index += 1) await foldTranscript(path, counting.reducer);
    expect(counting.steps()).toBe(count);
    expect(getTranscriptCacheStats().sourceBytesRead).toBe(afterFold.sourceBytesRead);

    // An append reads only the appended bytes and folds only its records.
    const appended = filler(count) + filler(count + 1);
    await appendFile(path, appended);
    expect(await foldTranscript(path, counting.reducer)).toEqual({
      count: count + 2,
      status: "complete",
    });
    expect(counting.steps()).toBe(count + 2);
    const afterAppend = getTranscriptCacheStats();
    expect(afterAppend).toMatchObject({ coldScans: 1, appendScans: 1 });
    expect(afterAppend.sourceBytesRead - afterFold.sourceBytesRead).toBe(
      Buffer.byteLength(appended),
    );
    expect(afterAppend.bytes).toBeLessThanOrEqual(hardBudgetBytes);
    expect((await readTranscriptSince(path, since)).records).toHaveLength(10);
  });

  test("a working set above the hard budget sheds least-recently-used blocks fairly", async () => {
    const hardBudgetBytes = 40 * 1024;
    setTranscriptCacheLimitsForTesting({
      softBudgetBytes: 4 * 1024,
      hardBudgetBytes,
      blockSourceBytes: 2 * 1024,
      activeGraceMs: 60_000,
    });
    const write = async (name: string) => {
      const path = await createTempTranscript(name);
      await writeFile(path, Array.from({ length: 24 }, (_, index) => filler(index)).join(""));
      return path;
    };
    const parent = await write("parent.jsonl");
    const child = await write("child.jsonl");
    const residentOf = async (path: string) =>
      (await acquireTranscriptSnapshot(path)).blocks.filter((block) => block.records).length;

    await readTranscriptSince(parent, 0);
    const parentResident = await residentOf(parent);
    await readTranscriptSince(child, 0);

    const stats = getTranscriptCacheStats();
    // Both stay indexed (both are active); the budget holds; the older entry
    // lost blocks to make room for the newer one.
    expect(stats.entries).toBe(2);
    expect(stats.bytes).toBeLessThanOrEqual(hardBudgetBytes);
    expect(await residentOf(parent)).toBeLessThan(parentResident);
    expect(await residentOf(child)).toBeGreaterThan(0);

    // Reading the parent again re-admits it at the child's expense.
    const childResident = await residentOf(child);
    await readTranscriptSince(parent, 0);
    expect(getTranscriptCacheStats().bytes).toBeLessThanOrEqual(hardBudgetBytes);
    expect(await residentOf(child)).toBeLessThan(childResident);
    expect(getTranscriptCacheStats().coldScans).toBe(2);
  });

  test("idle entries beyond the soft budget are dropped; the entry count is bounded", async () => {
    setTranscriptCacheLimitsForTesting({ softBudgetBytes: 8 * 1024, activeGraceMs: 0 });
    const paths = await Promise.all(
      ["a.jsonl", "b.jsonl", "c.jsonl"].map(async (name) => {
        const path = await createTempTranscript(name);
        await writeFile(path, Array.from({ length: 8 }, (_, index) => filler(index)).join(""));
        return path;
      }),
    );
    for (const path of paths) await readTranscriptSince(path, 0);
    // With no grace every entry is idle, so the soft budget applies to all.
    expect(getTranscriptCacheStats().bytes).toBeLessThanOrEqual(8 * 1024);

    clearTranscriptCache();
    setTranscriptCacheLimitsForTesting({ maxEntries: 2 });
    for (const path of paths) await readTranscriptSince(path, 0);
    expect(getTranscriptCacheStats().entries).toBe(2);
  });

  test("range and fold queries match a whole-file parse after appends and evictions", async () => {
    setTranscriptCacheLimitsForTesting({
      softBudgetBytes: 0,
      hardBudgetBytes: 12 * 1024,
      blockSourceBytes: 512,
      chunkBytes: 256,
    });
    const path = await createTempTranscript();
    const lines = Array.from({ length: 60 }, (_, index) =>
      index % 3 === 0 ? message(index) : filler(index, 100),
    );
    await writeFile(path, lines.slice(0, 40).join(""));
    await readTranscriptSince(path, 0);
    await appendFile(path, lines.slice(40).join(""));

    const expected = lines
      .map((entry) => parseTranscriptRecordLine(entry.trim()))
      .filter((record): record is TranscriptRecord => record !== null);
    const since = Date.UTC(2026, 8, 1, 12, 0, 25);
    const range = await readTranscriptSince(path, since);
    expect(range.records).toEqual(
      expected.filter((record) => new Date(record.timestamp!).getTime() >= since),
    );
    expect((await readAll(path)).records).toEqual(expected);
  });
});
