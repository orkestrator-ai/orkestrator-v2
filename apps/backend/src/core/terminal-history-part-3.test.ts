// Part 3 of 4 of the terminal history suite, split from the former terminal-history.test.ts so
// `bun test --parallel` can spread its large on-disk fixtures across workers. The shared
// harness lives in terminal-history-test-support.ts.
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  TERMINAL_HISTORY_PENDING_BYTES,
  TERMINAL_HISTORY_SEGMENT_BYTES,
  type TerminalHistory,
  type TerminalHistoryOptions,
} from "./terminal-history.js";
import {
  readArchivedRows,
  readyArchiveDirectory,
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
  // The shape that lost its end in the browser smoke trace: 1,100 lines of 480
  // characters, with no chance for the 250 ms flush timer to fire.
  const burstLines = Array.from({ length: 1_100 }, (_, index) => String(index).padStart(480, "0"));

  test("keeps a burst that arrives before the archive is ready", async () => {
    history.configure({
      sessionId: "early-burst",
      dataDir: await temporaryDirectory(),
      stableIdentity: "early-burst",
      cols: 80,
      rows: 24,
    });
    history.append("early-burst", `${burstLines.join("\r\n")}\r\n`, 1, 1);

    const rows = await readAllRows("early-burst");
    expect(rows.length).toBe(burstLines.length);
    expect((await history.page("early-burst"))?.historyGap).toBe(false);
  });

  test("starts draining a large queue without waiting for the flush timer", async () => {
    await readySession(await temporaryDirectory(), "draining-session");
    history.append("draining-session", "line\r\n".repeat(50_000), 1, 1);
    expect(history.stats().queuedChunks).toBe(1);

    // No page, flush or completion: only the queue's own high-water mark starts this write.
    await history.settled();
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
    expect((await readAllRows("draining-session")).length).toBe(50_000);
  });

  test("starts draining many small chunks without waiting for the flush timer", async () => {
    await readySession(await temporaryDirectory(), "draining-chunks");
    for (let index = 0; index < 256; index += 1) {
      history.append("draining-chunks", "line\r\n", index + 1, 1);
    }
    expect(history.stats().queuedChunks).toBe(256);

    await history.settled();
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
  });

  test("splits one flush across segments without losing or reordering records", async () => {
    const directory = await readySession(await temporaryDirectory(), "rollover-session");
    const line = "y".repeat(1_000);
    const perBurst = 800;
    const bursts = Math.ceil(TERMINAL_HISTORY_SEGMENT_BYTES / (perBurst * line.length)) + 1;
    for (let burst = 0; burst < bursts; burst += 1) {
      history.append("rollover-session", `${line}\r\n`.repeat(perBurst), burst + 1, 1);
      await history.settled();
    }

    const rows = await readAllRows("rollover-session");
    expect(rows.length).toBe(perBurst * bursts);
    await history.flush();
    const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as {
      historyGap: boolean;
      durableThroughSequence: number;
      segments: Array<{ number: number; bytes: number; first: number; last: number }>;
    };
    expect(manifest.historyGap).toBe(false);
    expect(manifest.durableThroughSequence).toBe(perBurst * bursts);
    expect(manifest.segments.length).toBeGreaterThan(1);
    let expectedFirst = 1;
    for (const segment of manifest.segments) {
      const file = await stat(
        path.join(directory, `segment-${String(segment.number).padStart(6, "0")}.jsonl`),
      );
      expect(segment.first).toBe(expectedFirst);
      expect(file.size).toBe(segment.bytes);
      expect(file.size).toBeLessThanOrEqual(TERMINAL_HISTORY_SEGMENT_BYTES);
      expect(file.mode & 0o777).toBe(0o600);
      expectedFirst = segment.last + 1;
    }
    expect(expectedFirst).toBe(perBurst * bursts + 1);
  });

  test("reports a gap and returns its queue slots when a batch write fails", async () => {
    const directory = await readySession(await temporaryDirectory(), "failing-write");
    await mkdir(path.join(directory, "segment-000001.jsonl"));
    history.append("failing-write", "line\r\n".repeat(50_000), 1, 1);

    await history.settled();
    expect((await history.page("failing-write"))?.historyGap).toBe(true);
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
  });

  for (const failure of ["partial append", "chmod"] as const) {
    test(`rolls back ${failure} and preserves committed rows across refill and restart`, async () => {
      const dataDir = await temporaryDirectory();
      const id = `rollback-${failure}`;
      const directory = await readySession(dataDir, id);
      const file = path.join(directory, "segment-000001.jsonl");
      const expected: string[] = [];
      for (let burst = 0; burst < 4; burst += 1) {
        const lines = Array.from({ length: 800 }, (_, i) => `${burst}:${i}`.padEnd(1_000, "x"));
        history.append(id, `${lines.join("\r\n")}\r\n`, burst + 1, 1);
        await history.settled();
        expected.push(...lines);
      }
      const committedBytes = (await stat(file)).size;
      const append = fs.appendFile;
      const chmod = fs.chmod;
      let injected = false;
      const spy =
        failure === "partial append"
          ? spyOn(fs, "appendFile").mockImplementation(async (...args) => {
              if (args[0] === file && !injected) {
                injected = true;
                // A real on-disk remnant larger than the maximum record allowance.
                await append(file, String(args[1]).slice(0, 200 * 1024));
                throw new Error("injected partial append");
              }
              return append(...args);
            })
          : spyOn(fs, "chmod").mockImplementation(async (...args) => {
              if (args[0] === file && !injected) {
                injected = true;
                throw new Error("injected chmod failure after append");
              }
              return chmod(...args);
            });
      try {
        history.append(id, `${"lost".padEnd(1_000, "x")}\r\n`.repeat(600), 5, 1);
        await history.settled();
        expect(injected).toBe(true);
        expect((await stat(file)).size).toBe(committedBytes);
      } finally {
        spy.mockRestore();
      }
      expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
      const recovered = Array.from({ length: 900 }, (_, i) => `recovered:${i}`.padEnd(1_000, "y"));
      history.append(id, `${recovered.join("\r\n")}\r\n`, 6, 1);
      expected.push(...recovered);
      expect(await readAllRows(id)).toEqual(expected);
      expect((await history.page(id))?.historyGap).toBe(true);
      await history.flush();
      restartHistory();
      await readySession(dataDir, id);
      expect(await readAllRows(id)).toEqual(expected);
      expect((await history.page(id))?.historyGap).toBe(true);
    });
  }

  test("serializes pages with high-water writes through segment rollover", async () => {
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
    const directory = await readySession(await temporaryDirectory(), "overlap");
    const expected: string[] = [];
    for (let burst = 0; burst < 6; burst += 1) {
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      hold = true;
      const reading = history.page("overlap");
      await started;
      const lines = Array.from({ length: 800 }, (_, index) =>
        `${burst}:${index}`.padEnd(1_000, "x"),
      );
      history.append("overlap", `${lines.join("\r\n")}\r\n`, burst + 1, 1);
      hold = false;
      release();
      const before = await reading;
      expect(before?.historyGap).toBe(false);
      // This page owns the I/O slot before the newly queued high-water write.
      expect(before?.rows.map((row) => row.text)).toEqual(
        before?.rows.length ? expected.slice(-before.rows.length) : [],
      );
      expected.push(...lines);
      expect(await readAllRows("overlap")).toEqual(expected);
      expect((await history.page("overlap"))?.historyGap).toBe(false);
    }
    const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
    expect(manifest.segments.length).toBeGreaterThan(1);
  });

  test("recovers after a failed first batch and retains the explicit gap", async () => {
    const directory = await readySession(await temporaryDirectory(), "retry-write");
    const blocked = path.join(directory, "segment-000001.jsonl");
    await mkdir(blocked);
    history.append("retry-write", "lost\r\n".repeat(50_000), 1, 1);
    await history.settled();
    await rm(blocked, { recursive: true });
    history.append("retry-write", "recovered\r\n", 2, 1);
    expect(await readAllRows("retry-write")).toEqual(["recovered"]);
    expect((await history.page("retry-write"))?.historyGap).toBe(true);
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
  });

  test("keeps the successful part of a rollover batch when its next segment fails", async () => {
    const directory = await readySession(await temporaryDirectory(), "partial-rollover");
    const line = "x".repeat(1_000);
    for (let burst = 0; burst < 4; burst += 1) {
      history.append("partial-rollover", `${line}\r\n`.repeat(800), burst + 1, 1);
      await history.settled();
    }
    const blocked = path.join(directory, "segment-000002.jsonl");
    await mkdir(blocked);
    history.append("partial-rollover", `${line}\r\n`.repeat(900), 5, 1);
    await history.settled();
    const committed = (await readFile(path.join(directory, "segment-000001.jsonl"), "utf8"))
      .trimEnd()
      .split("\n")
      .map((row) => JSON.parse(row));
    expect(committed.length).toBeGreaterThan(3_200);
    expect(committed.length).toBeLessThan(4_100);
    await rm(blocked, { recursive: true });
    history.append("partial-rollover", "recovered\r\n", 6, 1);
    expect(await readAllRows("partial-rollover")).toEqual([
      ...committed.map((row) => row.text),
      "recovered",
    ]);
    expect((await history.page("partial-rollover"))?.historyGap).toBe(true);
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
  });

  test("keeps every small chunk that arrives before the archive is ready", async () => {
    history.configure({
      sessionId: "early-chunks",
      dataDir: await temporaryDirectory(),
      stableIdentity: "early-chunks",
      cols: 80,
      rows: 24,
    });
    for (let index = 0; index < 300; index += 1) {
      history.append("early-chunks", `${index}\r\n`, index + 1, 1);
    }
    expect(history.stats().queuedChunks).toBe(300);
    expect(await readAllRows("early-chunks")).toEqual(
      Array.from({ length: 300 }, (_, index) => String(index)),
    );
    expect((await history.page("early-chunks"))?.historyGap).toBe(false);
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
  });

  test("bounds output before the archive is ready and resumes afterward", async () => {
    const line = `${"x".repeat(1_000)}\r\n`;
    history.configure({
      sessionId: "early-flood",
      dataDir: await temporaryDirectory(),
      stableIdentity: "early-flood",
      cols: 80,
      rows: 24,
    });
    history.append("early-flood", line.repeat(2_000), 1, 1);
    expect(history.stats().queuedBytes).toBeLessThanOrEqual(TERMINAL_HISTORY_PENDING_BYTES);

    const rows = await readAllRows("early-flood");
    expect(rows.length).toBe(Math.floor((TERMINAL_HISTORY_PENDING_BYTES - 80) / line.length));
    history.append("early-flood", "after-init\r\n", 2, 1);
    expect((await readAllRows("early-flood")).at(-1)).toBe("after-init");
    expect((await history.page("early-flood"))?.historyGap).toBe(true);
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
  });
});
