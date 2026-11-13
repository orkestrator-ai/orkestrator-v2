// Part 4 of 4 of the terminal history suite, split from the former terminal-history.test.ts so
// `bun test --parallel` can spread its large on-disk fixtures across workers. The shared
// harness lives in terminal-history-test-support.ts.
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  TERMINAL_HISTORY_GLOBAL_PENDING_BYTES,
  TERMINAL_HISTORY_PENDING_BYTES,
  type TerminalHistory,
  type TerminalHistoryOptions,
} from "./terminal-history.js";
import {
  readArchivedRows,
  readyArchiveDirectory,
  seqOutput,
  useTerminalHistoryHarness,
} from "./terminal-history-test-support.js";

let history: TerminalHistory;
const { createHistory, temporaryDirectory } = useTerminalHistoryHarness(() => {
  history = createHistory();
});
history = createHistory();

/** A backend restart: the old owner shuts down and a new one reads the same data directory. */
function restartHistory(options?: TerminalHistoryOptions): void {
  history.shutdown();
  history = createHistory(options);
}

/** Every archived row of a session, oldest first, following the page cursors back. */
function readAllRows(sessionId: string): Promise<string[]> {
  return readArchivedRows(history, sessionId);
}

/** A session whose archive is ready, so a test's output is numbered from a known start. */
function readySession(dataDir: string, sessionId: string): Promise<string> {
  return readyArchiveDirectory(history, dataDir, sessionId);
}

describe.serial("terminal history", () => {
  test("preserves an early overflow gap when loading an existing manifest", async () => {
    const dataDir = await temporaryDirectory();
    const directory = await readySession(dataDir, "existing-gap");
    history.append("existing-gap", "before\r\n", 1, 1);
    await history.flush(true);
    restartHistory();
    history.configure({
      sessionId: "existing-gap",
      dataDir,
      stableIdentity: "existing-gap",
      cols: 80,
      rows: 24,
    });
    history.append("existing-gap", "x\r\n".repeat(500_000), 2, 1);
    expect((await history.page("existing-gap"))?.historyGap).toBe(true);
    await history.flush();
    expect(
      JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")).historyGap,
    ).toBe(true);
    restartHistory();
    history.configure({
      sessionId: "existing-gap",
      dataDir,
      stableIdentity: "existing-gap",
      cols: 80,
      rows: 24,
    });
    expect((await history.page("existing-gap"))?.historyGap).toBe(true);
  });

  test("persists an explicit gap when the archive queue's byte bound overflows", async () => {
    const dataDir = await temporaryDirectory();
    const directory = await readySession(dataDir, "overloaded-session");
    const line = `${"x".repeat(1_000)}\r\n`;
    const lineCount = 2_000;
    // Over 1 MiB in one event-loop turn, so no write can return a slot during it.
    history.append("overloaded-session", line.repeat(lineCount), 1, 1);
    const queued = history.stats();
    expect(queued.queuedBytes).toBeLessThanOrEqual(TERMINAL_HISTORY_PENDING_BYTES);
    expect(queued.queuedBytes).toBeGreaterThan(TERMINAL_HISTORY_PENDING_BYTES - line.length);

    const snapshot = await history.stateSnapshot("overloaded-session");
    expect(snapshot?.historyGap).toBe(true);
    await history.flush();
    const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as {
      historyGap: boolean;
    };
    expect(manifest.historyGap).toBe(true);
    const rows = await readAllRows("overloaded-session");
    expect(rows.length).toBe(Math.floor((TERMINAL_HISTORY_PENDING_BYTES - 80) / line.length));
    expect(rows.length).toBeLessThan(lineCount);
    expect(new Set(rows)).toEqual(new Set(["x".repeat(1_000)]));
  });

  test("keeps a flood of short lines past 1 MiB up to the bound and reports the gap", async () => {
    await readySession(await temporaryDirectory(), "short-flood");
    const output = seqOutput(1, 400_000);
    expect(output.length).toBeGreaterThan(TERMINAL_HISTORY_PENDING_BYTES);
    history.append("short-flood", output, 1, 1);
    expect(history.stats().queuedBytes).toBeLessThanOrEqual(TERMINAL_HISTORY_PENDING_BYTES);
    expect(history.stats().queuedBytes).toBeGreaterThan(TERMINAL_HISTORY_PENDING_BYTES - 16);

    const latest = await history.page("short-flood");
    expect(latest?.historyGap).toBe(true);
    const kept = Number(latest?.rows.at(-1)?.text);
    // The kept part is the start of the output, in whole lines.
    expect(latest?.rows.at(-1)?.id).toBe(`${kept}:0`);
    expect(Buffer.byteLength(seqOutput(1, kept))).toBeLessThanOrEqual(
      TERMINAL_HISTORY_PENDING_BYTES - 80,
    );
    expect(Buffer.byteLength(seqOutput(1, kept + 1))).toBeGreaterThan(
      TERMINAL_HISTORY_PENDING_BYTES - 80,
    );
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
  });

  test("keeps multibyte output whole when the byte bound cuts a line with no newline", async () => {
    await readySession(await temporaryDirectory(), "cut-line");
    history.append("cut-line", "界".repeat(TERMINAL_HISTORY_PENDING_BYTES), 1, 1);
    expect(history.stats().queuedBytes).toBeLessThanOrEqual(TERMINAL_HISTORY_PENDING_BYTES);
    expect(history.stats().queuedBytes).toBeGreaterThan(TERMINAL_HISTORY_PENDING_BYTES - 3);
    await history.complete("cut-line");

    const text = (await readAllRows("cut-line")).join("");
    expect(text.length).toBe(Math.floor((TERMINAL_HISTORY_PENDING_BYTES - 80) / 3));
    expect(new Set(text)).toEqual(new Set(["界"]));
    expect((await history.page("cut-line"))?.historyGap).toBe(true);
  });

  /** Output that leaves the queue with no room for even a one-byte chunk, ending in `tail`. */
  function fillQueue(tail = ""): string {
    const size = TERMINAL_HISTORY_PENDING_BYTES - 80 - tail.length;
    return `${`${"f".repeat(998)}\r\n`.repeat(Math.floor(size / 1_000))}${"f".repeat(size % 1_000)}${tail}`;
  }

  test("drops a line whose start was lost rather than archiving its tail as a row", async () => {
    await readySession(await temporaryDirectory(), "mid-line-drop");
    history.append("mid-line-drop", fillQueue(), 1, 1);
    history.append("mid-line-drop", "dropped-start-", 2, 1);
    expect(history.stats().queuedChunks).toBe(1);
    await history.settled();
    history.append("mid-line-drop", "tail-of-dropped\r\nwhole\r\n", 3, 1);

    const rows = await readAllRows("mid-line-drop");
    expect(rows.at(-1)).toBe("whole");
    expect(rows.some((row) => row.includes("tail-of-dropped"))).toBe(false);
    expect((await history.page("mid-line-drop"))?.historyGap).toBe(true);
  });

  test("keeps the next line when dropped output ended at a line end", async () => {
    await readySession(await temporaryDirectory(), "whole-line-drop");
    history.append("whole-line-drop", fillQueue(), 1, 1);
    history.append("whole-line-drop", "dropped\r\n", 2, 1);
    await history.settled();
    history.append("whole-line-drop", "next\r\n", 3, 1);

    const rows = await readAllRows("whole-line-drop");
    expect(rows.at(-1)).toBe("next");
    expect(rows).not.toContain("dropped");
    expect((await history.page("whole-line-drop"))?.historyGap).toBe(true);
  });

  test.each(["\r", "\n"])(
    "recovers a dropped %j without losing real blank lines",
    async (ending) => {
      await readySession(await temporaryDirectory(), "split-drop");
      history.append("split-drop", fillQueue("\r\n"), 1, 1);
      history.append("split-drop", `lost${ending}`, 2, 1);
      await history.settled();
      const before = (await history.stateSnapshot("split-drop"))!.latestSequence;
      history.append("split-drop", "\nnext\r\n", 3, 1);
      const page = await history.page("split-drop");
      expect(page?.rows.filter((row) => Number(row.id.split(":")[0]) > before)).toEqual(
        ending === "\r"
          ? [{ id: `${before + 1}:0`, text: "next" }]
          : [
              { id: `${before + 1}:0`, text: "" },
              { id: `${before + 2}:0`, text: "next" },
            ],
      );
      expect(page?.historyGap).toBe(true);
    },
  );

  test("preserves a generation boundary when its first chunk is dropped whole", async () => {
    await readySession(await temporaryDirectory(), "lost-generation");
    history.append("lost-generation", fillQueue(), 1, 1);
    history.append("lost-generation", "lost", 1, 2);
    await history.settled();
    history.append("lost-generation", "prompt> ls\r\n", 2, 2);
    expect((await readAllRows("lost-generation")).at(-1)).toBe("prompt> ls");
    expect((await history.page("lost-generation"))?.historyGap).toBe(true);
  });

  test("resumes after dropped output held the end of an escape sequence", async () => {
    await readySession(await temporaryDirectory(), "escape-drop");
    history.append("escape-drop", fillQueue("\x1b]0;unterminated title"), 1, 1);
    history.append("escape-drop", "\x07\r\n", 2, 1);
    await history.settled();
    history.append("escape-drop", "visible\r\n", 3, 1);

    const rows = await readAllRows("escape-drop");
    expect(rows.at(-1)).toBe("visible");
    expect(rows.some((row) => row.includes("unterminated"))).toBe(false);
  });

  test("keeps a new generation's first line after output was dropped", async () => {
    await readySession(await temporaryDirectory(), "generation-drop");
    history.append("generation-drop", fillQueue(), 1, 1);
    history.append("generation-drop", "dropped-start-", 2, 1);
    await history.settled();
    history.append("generation-drop", "prompt> ", 1, 2);
    history.append("generation-drop", "ls\r\n", 2, 2);

    expect((await readAllRows("generation-drop")).at(-1)).toBe("prompt> ls");
  });

  test("counts queued empty lines by their bytes, so a flood of them all fits", async () => {
    await readySession(await temporaryDirectory(), "blank-session");
    const count = 20_000;
    history.append("blank-session", "\r\n".repeat(count), 1, 1);
    expect(history.stats()).toMatchObject({ queuedBytes: count * 2 + 80, queuedChunks: 1 });

    expect((await readAllRows("blank-session")).length).toBe(count);
    expect((await history.page("blank-session"))?.historyGap).toBe(false);
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
  });

  test("bounds the count of tiny chunks queued by one session", async () => {
    history = createHistory({ maxPendingChunks: 8 });
    await readySession(await temporaryDirectory(), "tiny-chunks");
    for (let index = 0; index < 9; index += 1) history.append("tiny-chunks", `${index}\n`, 1, 1);
    expect(history.stats().queuedChunks).toBe(8);
    expect(history.stats().queuedBytes).toBe(8 * (2 + 80));

    expect(await readAllRows("tiny-chunks")).toEqual(
      Array.from({ length: 8 }, (_, index) => String(index)),
    );
    expect((await history.page("tiny-chunks"))?.historyGap).toBe(true);
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
  });

  test("bounds the count of chunks queued across sessions", async () => {
    const dataDir = await temporaryDirectory();
    history = createHistory({ maxGlobalPendingChunks: 3 });
    const ids = ["global-0", "global-1", "global-2", "global-3"];
    for (const id of ids) await readySession(dataDir, id);
    for (const id of ids) history.append(id, "line\r\n", 1, 1);
    expect(history.stats().queuedChunks).toBe(3);

    expect((await history.page(ids.at(-1)!))?.historyGap).toBe(true);
    expect((await history.page(ids[0]!))?.historyGap).toBe(false);
  });

  test("bounds bytes queued across sessions", async () => {
    const dataDir = await temporaryDirectory();
    const sessions = TERMINAL_HISTORY_GLOBAL_PENDING_BYTES / TERMINAL_HISTORY_PENDING_BYTES + 1;
    const ids = Array.from({ length: sessions }, (_, index) => `global-bytes-${index}`);
    for (const id of ids) await readySession(dataDir, id);
    const output = "x".repeat(TERMINAL_HISTORY_PENDING_BYTES - 80);
    for (const id of ids) history.append(id, output, 1, 1);
    expect(history.stats().queuedBytes).toBe(TERMINAL_HISTORY_GLOBAL_PENDING_BYTES);

    expect((await history.page(ids.at(-1)!))?.historyGap).toBe(true);
    expect((await history.page(ids[0]!))?.historyGap).toBe(false);
  }, 30_000);

  test("keeps every line of seq 1 20000 delivered as one chunk", async () => {
    await readySession(await temporaryDirectory(), "seq-20000");
    const output = seqOutput(1, 20_000);
    history.append("seq-20000", output, 1, 1);
    // A line costs only its text, not a record's overhead.
    expect(history.stats()).toMatchObject({ queuedBytes: output.length + 80, queuedChunks: 1 });

    const rows = await readAllRows("seq-20000");
    expect(rows).toEqual(Array.from({ length: 20_000 }, (_, index) => String(index + 1)));
    expect((await history.page("seq-20000"))?.historyGap).toBe(false);
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
  });

  test("keeps every line of seq 1 100000 split across PTY-sized chunks", async () => {
    const directory = await readySession(await temporaryDirectory(), "seq-100000");
    const output = seqOutput(1, 100_000);
    expect(output.length).toBeLessThan(TERMINAL_HISTORY_PENDING_BYTES);
    let revision = 0;
    for (let offset = 0; offset < output.length; offset += 4_096) {
      revision += 1;
      history.append("seq-100000", output.slice(offset, offset + 4_096), revision, 1);
    }

    const latest = await history.page("seq-100000");
    expect(latest?.rows.at(-1)).toEqual({ id: "100000:0", text: "100000" });
    expect(latest?.historyGap).toBe(false);
    await history.flush();
    // Read the segments directly: paging 100,000 rows re-parses them once per page.
    const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as {
      durableThroughSequence: number;
      segments: Array<{ number: number }>;
    };
    expect(manifest.durableThroughSequence).toBe(100_000);
    const rows: Array<{ sequence: number; text: string }> = [];
    for (const segment of manifest.segments) {
      const contents = await readFile(
        path.join(directory, `segment-${String(segment.number).padStart(6, "0")}.jsonl`),
        "utf8",
      );
      for (const line of contents.trimEnd().split("\n")) rows.push(JSON.parse(line));
    }
    expect(rows.length).toBe(100_000);
    expect(rows.every((row, index) => row.sequence === index + 1)).toBe(true);
    expect(rows.every((row, index) => row.text === String(index + 1))).toBe(true);
  });

  test("writes a queue of short lines in bounded batches", async () => {
    await readySession(await temporaryDirectory(), "bounded-batches");
    const append = fs.appendFile;
    let largest = 0;
    let writes = 0;
    const spy = spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      largest = Math.max(largest, Buffer.byteLength(String(args[1])));
      writes += 1;
      return append(...args);
    });
    try {
      history.append("bounded-batches", seqOutput(1, 100_000), 1, 1);
      await history.settled();
    } finally {
      spy.mockRestore();
    }
    expect(writes).toBeGreaterThan(1);
    expect(largest).toBeLessThan(257 * 1024);
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
  });

  test("keeps output order while a flush holds its slot and more output queues", async () => {
    await readySession(await temporaryDirectory(), "ordered-flush");
    const append = fs.appendFile;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const spy = spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return append(...args);
    });
    try {
      history.append("ordered-flush", seqOutput(1, 50_000), 1, 1);
      await entered.promise;
      // The first flush is mid-write: these numbers must follow all of its rows.
      history.append("ordered-flush", seqOutput(50_001, 50_100), 2, 1);
      const snapshot = await history.stateSnapshot("ordered-flush");
      expect(snapshot?.latestSequence).toBe(50_100);
      release.resolve();
      const rows = await readAllRows("ordered-flush");
      expect(rows).toEqual(Array.from({ length: 50_100 }, (_, index) => String(index + 1)));
    } finally {
      release.resolve();
      spy.mockRestore();
    }
    expect((await history.page("ordered-flush"))?.historyGap).toBe(false);
  });

  test("snapshots number output still queued, without waiting for its write", async () => {
    let entered!: () => void;
    let release!: () => void;
    let hold = false;
    history = createHistory({
      pageReadHook: async () => {
        if (!hold) return;
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    await readySession(await temporaryDirectory(), "queued-snapshot");
    history.append("queued-snapshot", seqOutput(1, 10), 1, 1);
    await history.page("queued-snapshot");

    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    hold = true;
    const reading = history.page("queued-snapshot");
    await started;
    // The page holds the history's I/O slot, so nothing below can reach the disk.
    history.append("queued-snapshot", seqOutput(11, 25), 2, 1);
    const snapshot = await history.stateSnapshot("queued-snapshot");
    expect(snapshot).toMatchObject({ latestSequence: 25, revision: 2 });
    expect(history.stats().queuedChunks).toBe(1);
    hold = false;
    release();
    expect((await reading)?.rows.at(-1)).toEqual({ id: "10:0", text: "10" });

    const after = await history.page("queued-snapshot");
    expect(after?.rows.at(-1)).toEqual({ id: "25:0", text: "25" });
    expect(after?.rows.map((row) => row.id)).toEqual(
      Array.from({ length: 25 }, (_, index) => `${index + 1}:0`),
    );
  });

  test("carried text stays charged when snapshots number split lines during blocked I/O", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    history = createHistory({
      pageReadHook: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await readySession(await temporaryDirectory(), "carry-bound");
    const reading = history.page("carry-bound");
    await entered.promise;
    try {
      for (let index = 0; index < 40; index += 1) {
        history.append("carry-bound", "x".repeat(64 * 1024), index * 2 + 1, 1);
        await history.stateSnapshot("carry-bound");
        if (index === 0) expect(history.stats().queuedBytes).toBeGreaterThanOrEqual(64 * 1024);
        history.append("carry-bound", "\n", index * 2 + 2, 1);
        const snapshot = await history.stateSnapshot("carry-bound");
        expect(history.stats().queuedBytes).toBeLessThanOrEqual(TERMINAL_HISTORY_PENDING_BYTES);
        // Completed rows are 64 KiB; no more than sixteen can fit the byte cap.
        expect(snapshot!.latestSequence).toBeLessThanOrEqual(16);
      }
    } finally {
      release.resolve();
    }
    await reading;
    await history.flush();
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
    expect((await history.page("carry-bound"))?.historyGap).toBe(true);
  });

  test("the first checkpoint records output still queued", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    history = createHistory({
      pageReadHook: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const directory = await readySession(await temporaryDirectory(), "queued-checkpoint");
    const reading = history.page("queued-checkpoint");
    await entered.promise;
    const readCheckpoint = async () =>
      JSON.parse(await readFile(path.join(directory, "checkpoint.json"), "utf8")) as {
        sequence: number;
        revision: number;
      };
    // Hold I/O so even an expired flush timer cannot drain the queued output.
    history.append("queued-checkpoint", seqOutput(1, 30), 1, 1);
    try {
      expect((await history.stateSnapshot("queued-checkpoint"))?.latestSequence).toBe(30);
      expect(history.stats().queuedChunks).toBe(1);
      expect(await readdir(directory)).not.toContain("segment-000001.jsonl");
    } finally {
      release.resolve();
    }
    await reading;
    await history.settled();
    expect(await readCheckpoint()).toMatchObject({ sequence: 30, revision: 1 });

    history.append("queued-checkpoint", seqOutput(31, 40), 2, 1);
    await history.flush();
    expect(await readCheckpoint()).toMatchObject({ sequence: 40, revision: 2 });
    const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as {
      latestSequence: number;
      durableThroughSequence: number;
    };
    expect(manifest).toMatchObject({ latestSequence: 40, durableThroughSequence: 40 });
  });

  test("continues numbering from the manifest across a restart with output queued early", async () => {
    const dataDir = await temporaryDirectory();
    await readySession(dataDir, "numbered-before");
    history.append("numbered-before", seqOutput(1, 5), 1, 1);
    await history.flush(true);
    restartHistory();

    // Queued before the archive is ready, so numbered only after its manifest loads.
    history.configure({
      sessionId: "numbered-after",
      dataDir,
      stableIdentity: "numbered-before",
      cols: 80,
      rows: 24,
    });
    history.append("numbered-after", seqOutput(6, 8), 1, 1);
    expect((await history.stateSnapshot("numbered-after"))?.latestSequence).toBe(8);
    const page = await history.page("numbered-after");
    expect(page?.rows.map((row) => row.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `${index + 1}:0`),
    );
    expect(page?.rows.map((row) => row.text)).toEqual(
      Array.from({ length: 8 }, (_, index) => String(index + 1)),
    );
  });

  test("pages keep their row numbers while later output is queued", async () => {
    await readySession(await temporaryDirectory(), "queued-pages");
    history.append("queued-pages", seqOutput(1, 1_500), 1, 1);
    const recent = await history.page("queued-pages");
    expect(recent?.rows[0]).toEqual({ id: "501:0", text: "501" });
    expect(recent?.rows.at(-1)).toEqual({ id: "1500:0", text: "1500" });

    history.append("queued-pages", seqOutput(1_501, 1_600), 2, 1);
    const earlier = await history.page("queued-pages", recent!.previousCursor!);
    expect(earlier?.rows[0]).toEqual({ id: "1:0", text: "1" });
    expect(earlier?.rows.at(-1)).toEqual({ id: "500:0", text: "500" });

    const latest = await history.page("queued-pages");
    expect(latest?.rows.at(-1)).toEqual({ id: "1600:0", text: "1600" });
    expect((await history.stateSnapshot("queued-pages"))?.latestSequence).toBe(1_600);
  });

  test("a line split across chunks stays one row when reads number the queue between them", async () => {
    await readySession(await temporaryDirectory(), "split-line");
    history.append("split-line", "par", 1, 1);
    expect((await history.stateSnapshot("split-line"))?.latestSequence).toBe(0);
    history.append("split-line", "t\x1b[3", 2, 1);
    await history.page("split-line");
    history.append("split-line", "1mial \ud83d", 3, 1);
    expect((await history.stateSnapshot("split-line"))?.latestSequence).toBe(0);
    history.append("split-line", "\ude42\r", 4, 1);
    expect((await history.stateSnapshot("split-line"))?.latestSequence).toBe(0);
    history.append("split-line", "\nnext\r\n", 5, 1);

    expect((await history.stateSnapshot("split-line"))?.latestSequence).toBe(2);
    expect((await history.page("split-line"))?.rows).toEqual([
      { id: "1:0", text: "partial 🙂" },
      { id: "2:0", text: "next" },
    ]);
  });

  test("lines split at arbitrary points keep their order across chunks", async () => {
    await readySession(await temporaryDirectory(), "arbitrary-splits");
    const output = seqOutput(1, 3_000);
    const sizes = [1, 2, 3, 5, 7, 11, 13, 251, 4_096];
    let offset = 0;
    let revision = 0;
    while (offset < output.length) {
      const size = sizes[revision % sizes.length]!;
      revision += 1;
      history.append("arbitrary-splits", output.slice(offset, offset + size), revision, 1);
      offset += size;
    }

    const rows = await readAllRows("arbitrary-splits");
    expect(rows).toEqual(Array.from({ length: 3_000 }, (_, index) => String(index + 1)));
  });

  test("a line split across a failed write still joins up", async () => {
    const directory = await readySession(await temporaryDirectory(), "split-failed-write");
    const blocked = path.join(directory, "segment-000001.jsonl");
    await mkdir(blocked);
    history.append("split-failed-write", `lost\r\npar`, 1, 1);
    await history.page("split-failed-write");
    await rm(blocked, { recursive: true });
    history.append("split-failed-write", "tial\r\n", 2, 1);

    expect(await readAllRows("split-failed-write")).toEqual(["partial"]);
    expect((await history.page("split-failed-write"))?.historyGap).toBe(true);
  });

  test("a final carriage return ends a row without adding to its text", async () => {
    await readySession(await temporaryDirectory(), "final-cr");
    history.append("final-cr", "progress\r", 1, 1);
    await history.complete("final-cr");

    expect(await readAllRows("final-cr")).toEqual(["progress"]);
  });

  test("marks a corrupt checkpoint as a gap while retaining usable archive data", async () => {
    const dataDir = await temporaryDirectory();
    const stableIdentity = "corrupt-checkpoint-terminal";
    history.configure({
      sessionId: "before-corruption",
      dataDir,
      stableIdentity,
      cols: 80,
      rows: 24,
    });
    history.append("before-corruption", "archived-before-corruption", 1, 1);
    await history.complete("before-corruption");
    const before = await history.stateSnapshot("before-corruption");
    await history.dispose("before-corruption");
    await writeFile(
      path.join(dataDir, "terminal-history", before!.historyId, "checkpoint.json"),
      '{"formatVersion":1,"output":"damaged","checksum":"wrong"}\n',
    );

    history.configure({
      sessionId: "after-corruption",
      dataDir,
      stableIdentity,
      cols: 80,
      rows: 24,
    });
    const recovered = await history.stateSnapshot("after-corruption");
    const page = await history.page("after-corruption");
    expect(recovered?.historyGap).toBe(true);
    expect(page?.rows.some((row) => row.text.includes("archived-before-corruption"))).toBe(true);
  });

  test("reserves bounded recovery storage when admitting many active terminals", async () => {
    const dataDir = await temporaryDirectory();
    history.configureRetention({ sessionMb: 8, globalMb: 128, days: 7 });
    for (let index = 0; index < 42; index += 1) {
      history.configure({
        sessionId: `admitted-${index}`,
        dataDir,
        stableIdentity: `admitted-terminal-${index}`,
        cols: 1,
        rows: 1,
      });
    }
    expect(
      history.configure({
        sessionId: "refused-43",
        dataDir,
        stableIdentity: "refused-terminal-43",
        cols: 1,
        rows: 1,
      }),
    ).toBeNull();
    await history.flush();
  });

  test("reports scrollback reclaimed for another terminal as truncated", async () => {
    const dataDir = await temporaryDirectory();
    history.configure({
      sessionId: "reclaimed",
      dataDir,
      stableIdentity: "reclaimed-terminal",
      cols: 1_000,
      rows: 1_000,
    });
    history.configure({
      sessionId: "admitted-after-reclaim",
      dataDir,
      stableIdentity: "admitted-after-reclaim-terminal",
      cols: 500,
      rows: 500,
    });

    expect((await history.stateSnapshot("reclaimed"))?.historyTruncated).toBe(true);
  });

  test("degrades history resize without throwing when the emulator budget is saturated", async () => {
    const dataDir = await temporaryDirectory();
    for (let index = 0; index < 9; index += 1) {
      history.configure({
        sessionId: `resize-${index}`,
        dataDir,
        stableIdentity: `resize-terminal-${index}`,
        cols: 80,
        rows: 24,
      });
    }
    expect(() => history.resize("resize-0", 1_000, 1_000)).not.toThrow();
    expect(history.stats().estimatedStateBytes).toBeLessThanOrEqual(128 * 1024 * 1024);
    await history.flush();
  });
});
