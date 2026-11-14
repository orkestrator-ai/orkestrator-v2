// Part 2 of 4 of the terminal history suite, split from the former terminal-history.test.ts so
// `bun test --parallel` can spread its large on-disk fixtures across workers. The shared
// harness lives in terminal-history-test-support.ts.
import { describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { TERMINAL_HISTORY_PENDING_BYTES, type TerminalHistory } from "./terminal-history.js";
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

/** Every archived row of a session, oldest first, following the page cursors back. */
function readAllRows(sessionId: string): Promise<string[]> {
  return readArchivedRows(history, sessionId);
}

/** A session whose archive is ready, so a test's output is numbered from a known start. */
function readySession(dataDir: string, sessionId: string): Promise<string> {
  return readyArchiveDirectory(history, dataDir, sessionId);
}

describe.serial("terminal history", () => {
  test("normalizes lines, CRLF, Unicode, and ANSI across transport chunks and pages", async () => {
    const dataDir = await temporaryDirectory();
    history.configure({
      sessionId: "fragmented-session",
      dataDir,
      stableIdentity: "fragmented-terminal",
      cols: 80,
      rows: 24,
    });
    history.append("fragmented-session", "hel", 1, 1);
    history.append("fragmented-session", "lo\r", 2, 1);
    history.append("fragmented-session", "\n\x1b[3", 3, 1);
    history.append("fragmented-session", "1mred\x1b[0m \ud83d", 4, 1);
    history.append("fragmented-session", "\ude42\r\n", 5, 1);
    for (let index = 0; index < 1_005; index += 1) {
      history.append("fragmented-session", `line-${index}-`, index * 2 + 6, 1);
      history.append("fragmented-session", `continued\r\n`, index * 2 + 7, 1);
      if (index % 200 === 0) await history.flush();
    }
    await history.complete("fragmented-session");

    const recent = await history.page("fragmented-session");
    const earlier = await history.page("fragmented-session", recent!.previousCursor!);
    const rows = [...earlier!.rows, ...recent!.rows].map((row) => row.text);
    expect(rows).toContain("hello");
    expect(rows).toContain("red 🙂");
    expect(rows).toContain("line-0-continued");
    expect(rows).toContain("line-1004-continued");
    expect(rows.some((row) => row.includes("\x1b"))).toBe(false);
  });

  test("explicit deletion removes active and dormant history", async () => {
    const dataDir = await temporaryDirectory();
    history.configure({
      sessionId: "deleted-session",
      dataDir,
      stableIdentity: "local\0environment-delete\0tab-delete",
      cols: 80,
      rows: 24,
      environmentId: "environment-delete",
      tabId: "tab-delete",
    });
    history.append("deleted-session", "private output", 1, 1);
    await history.complete("deleted-session");
    await history.deleteHistories({
      dataDir,
      environmentId: "environment-delete",
      tabId: "tab-delete",
    });
    expect(await history.stateSnapshot("deleted-session")).toBeNull();
    expect(await readdir(path.join(dataDir, "terminal-history"))).toHaveLength(0);
  });

  test("age retention does not delete a history while its terminal is still active", async () => {
    const dataDir = await temporaryDirectory();
    history.configureRetention({ sessionMb: 64, globalMb: 1024, days: 1 });
    history.configure({
      sessionId: "active-completed-session",
      dataDir,
      stableIdentity: "active-completed-terminal",
      cols: 80,
      rows: 24,
    });
    history.append("active-completed-session", "finished command", 1, 1);
    await history.complete("active-completed-session");
    const snapshot = await history.stateSnapshot("active-completed-session");
    const historyDirectory = path.join(dataDir, "terminal-history", snapshot!.historyId);
    const manifestPath = path.join(historyDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { updatedAt: number };
    manifest.updatedAt = 0;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    await history.pruneStorage(dataDir);
    expect((await stat(historyDirectory)).isDirectory()).toBe(true);

    await history.dispose("active-completed-session");
    await history.pruneStorage(dataDir);
    await expect(stat(historyDirectory)).rejects.toThrow();
  });

  test("automatically prunes expired disposed histories in a long-running process", async () => {
    const dataDir = await temporaryDirectory();
    history.configureRetention({ sessionMb: 64, globalMb: 128, days: 1 });
    history.configure({
      sessionId: "expired-session",
      dataDir,
      stableIdentity: "expired-terminal",
      cols: 80,
      rows: 24,
    });
    history.append("expired-session", "expired output\r\n", 1, 1);
    await history.complete("expired-session");
    const snapshot = await history.stateSnapshot("expired-session");
    const historyDirectory = path.join(dataDir, "terminal-history", snapshot!.historyId);
    const manifestPath = path.join(historyDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { updatedAt: number };
    manifest.updatedAt = 0;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await history.dispose("expired-session");
    await expect(stat(historyDirectory)).rejects.toThrow();
  });

  test("automatically enforces the global archive budget across dormant histories", async () => {
    const dataDir = await temporaryDirectory();
    const root = path.join(dataDir, "terminal-history");
    await mkdir(root, { recursive: true });
    for (let index = 1; index <= 2; index += 1) {
      const historyId = String(index).repeat(64);
      const directory = path.join(root, historyId);
      await mkdir(directory);
      await writeFile(
        path.join(directory, "manifest.json"),
        `${JSON.stringify({
          formatVersion: 1,
          historyId,
          incarnation: `incarnation-${index}`,
          createdAt: index,
          updatedAt: index,
          earliestSequence: 1,
          latestSequence: 1,
          durableThroughSequence: 1,
          historyTruncated: false,
          archiveTruncated: false,
          historyGap: false,
          completed: true,
          segments: [{ number: 1, bytes: 70 * 1024 * 1024, first: 1, last: 1 }],
        })}\n`,
      );
    }
    history.configureRetention({ sessionMb: 64, globalMb: 128, days: 7 });
    history.configure({
      sessionId: "prune-trigger",
      dataDir,
      stableIdentity: "prune-trigger-terminal",
      cols: 1,
      rows: 1,
    });
    await history.dispose("prune-trigger");
    const remaining = await readdir(root);
    expect(
      remaining.filter((entry) => entry === "1".repeat(64) || entry === "2".repeat(64)).length,
    ).toBeLessThan(2);
  });

  test("bounds completed in-memory collectors", async () => {
    const dataDir = await temporaryDirectory();
    for (let index = 0; index < 12; index += 1) {
      history.configure({
        sessionId: `completed-${index}`,
        dataDir,
        stableIdentity: `completed-terminal-${index}`,
        cols: 1,
        rows: 1,
      });
      history.append(`completed-${index}`, `done-${index}\r\n`, 1, 1);
      await history.complete(`completed-${index}`);
    }
    expect(history.stats().sessions).toBeLessThanOrEqual(8);
    expect(history.stats().estimatedStateBytes).toBeLessThanOrEqual(8 * 2_001 * 96);

    const restoredState = await history.stateSnapshot("completed-0");
    const restoredPage = await history.page("completed-0");
    expect(restoredState).toMatchObject({ completed: true, revision: 1 });
    expect(restoredState?.output).toContain("done-0");
    expect(restoredPage?.rows.some((row) => row.text === "done-0")).toBe(true);
    expect(history.stats().sessions).toBeLessThanOrEqual(8);
  });

  test("revives completed collectors before same-generation output and eviction", async () => {
    const dataDir = await temporaryDirectory();
    history.configure({
      sessionId: "revived",
      dataDir,
      stableIdentity: "revived-terminal",
      cols: 20,
      rows: 4,
    });
    history.append("revived", "first run\r\n", 1, 1);
    await history.complete("revived");
    await history.resume("revived");
    history.append("revived", "second run\r\n", 2, 1);

    for (let index = 0; index < 9; index += 1) {
      history.configure({
        sessionId: `eviction-${index}`,
        dataDir,
        stableIdentity: `eviction-terminal-${index}`,
        cols: 1,
        rows: 1,
      });
      history.append(`eviction-${index}`, `done-${index}\r\n`, 1, 1);
      await history.complete(`eviction-${index}`);
    }
    await history.pruneStorage(dataDir);

    const snapshot = await history.stateSnapshot("revived");
    expect(snapshot).toMatchObject({ completed: false, revision: 2 });
    expect(snapshot?.output).toContain("second run");
  });

  test("keeps the first partial archive line after a generation change", async () => {
    const dataDir = await temporaryDirectory();
    history.configure({
      sessionId: "generation-carry",
      dataDir,
      stableIdentity: "generation-carry-terminal",
      cols: 20,
      rows: 4,
    });
    history.append("generation-carry", "old partial", 1, 1);
    history.append("generation-carry", "prompt> ", 1, 2);
    history.append("generation-carry", "ls\r\n", 2, 2);
    await history.complete("generation-carry");

    const page = await history.page("generation-carry");
    expect(page?.rows.map((row) => row.text)).toContain("prompt> ls");
  });

  test("truncates an uncommitted segment tail before reusing its sequence", async () => {
    const dataDir = await temporaryDirectory();
    const stableIdentity = "torn-segment-terminal";
    history.configure({
      sessionId: "before-torn-write",
      dataDir,
      stableIdentity,
      cols: 40,
      rows: 5,
    });
    history.append("before-torn-write", "committed\r\n", 1, 1);
    await history.complete("before-torn-write");
    const snapshot = await history.stateSnapshot("before-torn-write");
    await history.dispose("before-torn-write");
    const historyDirectory = path.join(dataDir, "terminal-history", snapshot!.historyId);
    const manifest = JSON.parse(
      await readFile(path.join(historyDirectory, "manifest.json"), "utf8"),
    ) as { segments: Array<{ number: number; bytes: number }> };
    const segment = manifest.segments.at(-1)!;
    await Bun.write(
      path.join(historyDirectory, `segment-${String(segment.number).padStart(6, "0")}.jsonl`),
      `${await readFile(path.join(historyDirectory, `segment-${String(segment.number).padStart(6, "0")}.jsonl`), "utf8")}${JSON.stringify({ sequence: 2, at: Date.now(), text: "orphan" })}\n`,
    );
    await writeFile(path.join(historyDirectory, "segment-999999.jsonl"), "unlisted tail\n");

    history.configure({
      sessionId: "after-torn-write",
      dataDir,
      stableIdentity,
      cols: 40,
      rows: 5,
    });
    history.append("after-torn-write", "replacement\r\n", 2, 1);
    await history.complete("after-torn-write");
    const page = await history.page("after-torn-write");
    const ids = page!.rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(page?.rows.some((row) => row.text === "orphan")).toBe(false);
    expect(page?.rows.some((row) => row.text === "replacement")).toBe(true);
    expect(page?.historyGap).toBe(true);
    expect(await readdir(historyDirectory)).not.toContain("segment-999999.jsonl");
  });

  test("bounds retained history directory count per prune pass", async () => {
    const dataDir = await temporaryDirectory();
    const root = path.join(dataDir, "terminal-history");
    await mkdir(root, { recursive: true });
    history = createHistory({ maxHistoryDirectories: 4 });
    for (let index = 0; index < 6; index += 1) {
      const historyId = String(index).padStart(64, "0");
      const directory = path.join(root, historyId);
      await mkdir(directory);
      await writeFile(
        path.join(directory, "manifest.json"),
        `${JSON.stringify({
          formatVersion: 1,
          archiveRowsVersion: 1,
          historyId,
          incarnation: `incarnation-${index}`,
          createdAt: index,
          updatedAt: index,
          earliestSequence: 1,
          latestSequence: 0,
          durableThroughSequence: 0,
          historyTruncated: false,
          archiveTruncated: false,
          historyGap: false,
          completed: true,
          segments: [],
        })}\n`,
      );
    }
    await history.pruneStorage(dataDir);
    expect((await readdir(root)).length).toBeLessThanOrEqual(4);
  });

  test("contains final checkpoint serialization failures and records completion", async () => {
    const dataDir = await temporaryDirectory();
    let failSerialization = false;
    history = createHistory({
      serializeHook: () => {
        if (failSerialization) throw new Error("snapshot too large");
      },
    });
    history.configure({
      sessionId: "oversized-screen",
      dataDir,
      stableIdentity: "oversized-screen-terminal",
      cols: 80,
      rows: 24,
    });
    history.append("oversized-screen", "output\r\n", 1, 1);
    failSerialization = true;
    await expect(history.complete("oversized-screen")).resolves.toBeUndefined();
    failSerialization = false;
    const snapshot = await history.stateSnapshot("oversized-screen");
    expect(snapshot?.completed).toBe(true);
    expect(snapshot?.historyGap).toBe(true);
  });

  test("limits concurrent history page reads without waiter barging", async () => {
    const dataDir = await temporaryDirectory();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let maximum = 0;
    // Pages are only read below, so the hook can hold every read from the start.
    const pagedHistory = createHistory({
      pageReadHook: async () => {
        maximum = Math.max(maximum, pagedHistory.stats().pageReads);
        await barrier;
      },
    });
    history = pagedHistory;
    history.configure({
      sessionId: "concurrent-pages",
      dataDir,
      stableIdentity: "concurrent-pages-terminal",
      cols: 80,
      rows: 24,
    });
    history.append("concurrent-pages", "line\r\n", 1, 1);
    await history.flush();
    // Different histories may read concurrently; reads of one history serialize
    // with its writes and retention.
    const ids = Array.from({ length: 12 }, (_, index) => `concurrent-${index}`);
    for (const id of ids) await readySession(dataDir, id);
    const reads = ids.map((id) => history.page(id));
    await Bun.sleep(10);
    expect(history.stats().pageReads).toBe(4);
    release();
    await Promise.all(reads);
    expect(maximum).toBe(4);
  });

  test("can disable durable history and remove existing archives", async () => {
    const dataDir = await temporaryDirectory();
    history.configure({
      sessionId: "private-session",
      dataDir,
      stableIdentity: "private-terminal",
      cols: 80,
      rows: 24,
    });
    history.append("private-session", "secret\r\n", 1, 1);
    await history.complete("private-session");
    history.configureRetention({ enabled: false });
    await history.pruneStorage(dataDir);
    expect(
      history.configure({
        sessionId: "disabled-session",
        dataDir,
        stableIdentity: "disabled-terminal",
        cols: 80,
        rows: 24,
      }),
    ).toBeNull();
    await expect(stat(path.join(dataDir, "terminal-history"))).rejects.toThrow();
  });

  // The shape that lost its end in the browser smoke trace: 1,100 lines of 480
  // characters, with no chance for the 250 ms flush timer to fire.
  const burstLines = Array.from({ length: 1_100 }, (_, index) => String(index).padStart(480, "0"));

  test("keeps every line of a burst over 256 lines delivered as one chunk", async () => {
    await readySession(await temporaryDirectory(), "burst-session");
    history.append("burst-session", `${burstLines.join("\r\n")}\r\n`, 1, 1);
    expect(history.stats().queuedBytes).toBeLessThanOrEqual(TERMINAL_HISTORY_PENDING_BYTES);

    const rows = await readAllRows("burst-session");
    expect(rows.length).toBe(burstLines.length);
    expect(rows).toEqual(burstLines);
    expect((await history.page("burst-session"))?.historyGap).toBe(false);
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedChunks: 0 });
  });

  test("keeps every line of a burst over 256 lines delivered line by line", async () => {
    await readySession(await temporaryDirectory(), "burst-session");
    burstLines.forEach((line, index) => {
      history.append("burst-session", `${line}\r\n`, index + 1, 1);
    });

    const rows = await readAllRows("burst-session");
    expect(rows.length).toBe(burstLines.length);
    expect(rows).toEqual(burstLines);
    expect((await history.page("burst-session"))?.historyGap).toBe(false);
  });
});
