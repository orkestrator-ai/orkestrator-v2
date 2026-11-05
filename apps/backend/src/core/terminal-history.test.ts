import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import {
  TERMINAL_HISTORY_GLOBAL_PENDING_RECORDS,
  TERMINAL_HISTORY_PENDING_BYTES,
  TERMINAL_HISTORY_PENDING_RECORDS,
  TERMINAL_HISTORY_SEGMENT_BYTES,
  TerminalHistory,
  type TerminalHistoryOptions,
} from "./terminal-history.js";

const directories: string[] = [];
/** Every history a test built, so teardown releases each one's timers. */
const histories: TerminalHistory[] = [];

function createHistory(options: TerminalHistoryOptions = {}): TerminalHistory {
  const created = new TerminalHistory(options);
  histories.push(created);
  return created;
}

let history = createHistory();

/** A backend restart: the old owner shuts down and a new one reads the same data directory. */
function restartHistory(options?: TerminalHistoryOptions): void {
  history.shutdown();
  history = createHistory(options);
}

afterEach(async () => {
  const finished = histories.splice(0);
  for (const created of finished) created.shutdown();
  // Disposal, completion and pruning write after the call returns.
  await Promise.all(finished.map((created) => created.settled()));
  history = createHistory();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ork-terminal-history-"));
  directories.push(directory);
  return directory;
}

function writeTerminal(terminal: HeadlessTerminal, text: string): Promise<void> {
  return new Promise((resolve) => terminal.write(text, resolve));
}

/** Every archived row of a session, oldest first, following the page cursors back. */
async function readAllRows(sessionId: string): Promise<string[]> {
  const rows: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await history.page(sessionId, cursor);
    rows.unshift(...(page?.rows ?? []).map((row) => row.text));
    cursor = page?.previousCursor ?? undefined;
  } while (cursor);
  return rows;
}

/** A session whose archive is ready, so `stats()` counts its queue rather than pre-init chunks. */
async function readySession(dataDir: string, sessionId: string): Promise<string> {
  history.configure({ sessionId, dataDir, stableIdentity: sessionId, cols: 80, rows: 24 });
  const snapshot = await history.stateSnapshot(sessionId);
  return path.join(dataDir, "terminal-history", snapshot!.historyId);
}

describe.serial("terminal history", () => {
  test("serializes current terminal state and pages backend-owned history", async () => {
    const dataDir = await temporaryDirectory();
    history.configure({
      sessionId: "session-1",
      dataDir,
      stableIdentity: "local\0environment-1\0tab-1",
      cols: 20,
      rows: 4,
      environmentId: "environment-1",
      tabId: "tab-1",
    });

    history.append("session-1", "first\r\n", 1, 1);
    history.append("session-1", "\x1b[31mfinal-marker\x1b[0m", 2, 1);
    const snapshot = await history.stateSnapshot("session-1");

    expect(snapshot).toMatchObject({
      formatVersion: 1,
      generation: 1,
      revision: 2,
      cols: 20,
      rows: 4,
      historyGap: false,
    });
    expect(snapshot?.output).toContain("final-marker");

    await history.complete("session-1");
    const page = await history.page("session-1");
    expect(page?.rows.map((row) => row.text).join("\n")).toContain("final-marker");
    expect(page?.rows.map((row) => row.text).join("\n")).not.toContain("\x1b[31m");

    const historyDirectory = path.join(dataDir, "terminal-history", snapshot!.historyId);
    expect((await stat(historyDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(historyDirectory, "manifest.json"))).mode & 0o777).toBe(0o600);
  });

  test("restores the durable checkpoint for a new PTY incarnation", async () => {
    const dataDir = await temporaryDirectory();
    const stableIdentity = "container\0environment-1\0tab-1";
    history.configure({
      sessionId: "old-session",
      dataDir,
      stableIdentity,
      cols: 30,
      rows: 5,
    });
    history.append("old-session", "survives-restart", 1, 1);
    await history.complete("old-session");
    restartHistory();

    history.configure({
      sessionId: "new-session",
      dataDir,
      stableIdentity,
      cols: 30,
      rows: 5,
    });
    const restored = await history.stateSnapshot("new-session");
    expect(restored?.output).toContain("survives-restart");
    expect(restored?.incarnation).not.toBeUndefined();
  });

  test("forces the latest active state into a graceful-shutdown checkpoint", async () => {
    const dataDir = await temporaryDirectory();
    const stableIdentity = "graceful-restart-terminal";
    history.configure({
      sessionId: "before-graceful-restart",
      dataDir,
      stableIdentity,
      cols: 30,
      rows: 5,
    });
    history.append("before-graceful-restart", "first\r\n", 1, 1);
    await history.stateSnapshot("before-graceful-restart");
    history.append("before-graceful-restart", "latest-marker", 2, 1);
    // Production shuts the owner down before awaiting its final flush. Leave
    // both parser work and an unterminated archive line pending at that point.
    const other = createHistory();
    other.configure({
      sessionId: "other",
      dataDir,
      stableIdentity: "other-backend",
      cols: 30,
      rows: 5,
    });
    other.append("other", "before\r\n", 1, 1);
    history.shutdown();
    await history.flush(true);
    history.append("before-graceful-restart", "after-quiesce", 3, 1);
    restartHistory();

    other.append("other", "still-usable", 2, 1);
    expect(await other.stateSnapshot("other")).toMatchObject({ revision: 2, historyGap: false });
    expect((await other.stateSnapshot("other"))?.output).toContain("still-usable");
    await other.flush(true);

    history.configure({
      sessionId: "after-graceful-restart",
      dataDir,
      stableIdentity,
      cols: 30,
      rows: 5,
    });
    const restored = await history.stateSnapshot("after-graceful-restart");
    expect(restored?.revision).toBe(2);
    expect(restored?.output).toContain("latest-marker");
    expect(restored?.output).not.toContain("after-quiesce");
    expect((await history.page("after-graceful-restart"))?.rows.map((row) => row.text)).toContain(
      "latest-marker",
    );
  });

  test("rejects cursors from another terminal incarnation", async () => {
    const dataDir = await temporaryDirectory();
    history.configure({
      sessionId: "session-a",
      dataDir,
      stableIdentity: "terminal-a",
      cols: 80,
      rows: 24,
    });
    history.append("session-a", "a", 1, 1);
    await history.complete("session-a");
    const page = await history.page("session-a");

    history.configure({
      sessionId: "session-b",
      dataDir,
      stableIdentity: "terminal-b",
      cols: 80,
      rows: 24,
    });
    await expect(history.page("session-b", page?.previousCursor ?? "invalid")).rejects.toThrow(
      "invalid or expired",
    );
  });

  test("restores the final screen after both legacy replay limits roll over", async () => {
    const dataDir = await temporaryDirectory();
    history.configure({
      sessionId: "rollover-session",
      dataDir,
      stableIdentity: "rollover-terminal",
      cols: 80,
      rows: 24,
    });
    history.append("rollover-session", "initial-marker\r\n", 1, 1);
    for (let revision = 2; revision <= 1_100; revision += 1) {
      history.append(
        "rollover-session",
        `${String(revision).padStart(4, "0")}:${"x".repeat(500)}\r\n`,
        revision,
        1,
      );
    }
    history.append("rollover-session", "FINAL-OFFLINE-MARKER\r\n", 1_101, 1);

    const snapshot = await history.stateSnapshot("rollover-session");
    expect(snapshot?.revision).toBe(1_101);
    expect(snapshot?.output).toContain("FINAL-OFFLINE-MARKER");
    expect(snapshot?.historyTruncated).toBe(true);
  });

  test("preserves a split control sequence and subsequent terminal behavior", async () => {
    const dataDir = await temporaryDirectory();
    history.configure({
      sessionId: "parser-session",
      dataDir,
      stableIdentity: "parser-terminal",
      cols: 12,
      rows: 4,
    });
    history.append("parser-session", "before\r\n\x1b[3", 1, 1);
    const snapshot = await history.stateSnapshot("parser-session");
    expect(snapshot?.pendingOutput).toBe("\x1b[3");

    const reference = new HeadlessTerminal({
      allowProposedApi: true,
      cols: 12,
      rows: 4,
      scrollback: 2_000,
      disableStdin: true,
    });
    const restored = new HeadlessTerminal({
      allowProposedApi: true,
      cols: 12,
      rows: 4,
      scrollback: 2_000,
      disableStdin: true,
    });
    const referenceSerializer = new SerializeAddon();
    const restoredSerializer = new SerializeAddon();
    const referenceReplies: string[] = [];
    const restoredReplies: string[] = [];
    reference.loadAddon(referenceSerializer);
    restored.loadAddon(restoredSerializer);
    reference.onData((data) => referenceReplies.push(data));
    restored.onData((data) => restoredReplies.push(data));
    await writeTerminal(reference, "before\r\n\x1b[3");
    await writeTerminal(restored, `${snapshot!.output}${snapshot!.pendingOutput}`);
    const subsequent =
      "1mred\x1b[0m\r\nwide-界-e\u0301-🙂\r\nwrap-1234567890\x1b[2DZZ\x1b[2Kerase\x1b[?1049halt\x1b[?1049lafter\x1b[6n";
    await writeTerminal(reference, subsequent);
    await writeTerminal(restored, subsequent);
    reference.resize(16, 5);
    restored.resize(16, 5);
    await writeTerminal(reference, "\r\nnext");
    await writeTerminal(restored, "\r\nnext");
    expect(restoredSerializer.serialize({ scrollback: 2_000 })).toBe(
      referenceSerializer.serialize({ scrollback: 2_000 }),
    );
    expect(referenceReplies).toEqual([]);
    expect(restoredReplies).toEqual([]);
    reference.dispose();
    restored.dispose();
  });

  test("pages fixed history backwards and rejects a cursor for another history", async () => {
    const dataDir = await temporaryDirectory();
    history.configure({
      sessionId: "paged-session",
      dataDir,
      stableIdentity: "paged-terminal",
      cols: 80,
      rows: 24,
    });
    for (let batch = 0; batch < 5; batch += 1) {
      for (let row = 0; row < 250; row += 1) {
        const sequence = batch * 250 + row + 1;
        history.append("paged-session", `row-${sequence}\r\n`, sequence, 1);
      }
      await history.flush();
    }
    const recent = await history.page("paged-session");
    expect(recent?.rows.at(-1)?.text).toBe("row-1250");
    expect(recent?.rows.some((row) => row.text === "row-1250")).toBe(true);
    expect(recent?.previousCursor).not.toBeNull();
    const earlier = await history.page("paged-session", recent!.previousCursor!);
    expect(earlier?.rows.some((row) => row.text === "row-1")).toBe(true);

    history.configure({
      sessionId: "other-session",
      dataDir,
      stableIdentity: "other-terminal",
      cols: 80,
      rows: 24,
    });
    await expect(history.page("other-session", recent!.previousCursor!)).rejects.toThrow(
      "invalid or expired",
    );
  });

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
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedRecords: 0 });
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
    history.append("draining-session", "line\r\n".repeat(256), 1, 1);
    expect(history.stats().queuedRecords).toBe(256);

    // No page, flush or completion: only the queue's own high-water mark starts this write.
    await history.settled();
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedRecords: 0 });
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
    history.append("failing-write", "line\r\n".repeat(1_100), 1, 1);

    await history.settled();
    expect((await history.page("failing-write"))?.historyGap).toBe(true);
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedRecords: 0 });
  });

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
    history.append("retry-write", "lost\r\n".repeat(256), 1, 1);
    await history.settled();
    await rm(blocked, { recursive: true });
    history.append("retry-write", "recovered\r\n", 2, 1);
    expect(await readAllRows("retry-write")).toEqual(["recovered"]);
    expect((await history.page("retry-write"))?.historyGap).toBe(true);
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedRecords: 0 });
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
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedRecords: 0 });
  });

  test("bounds more than 256 small chunks before initialization and resumes afterward", async () => {
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
    expect(history.stats().queuedRecords).toBe(256);
    expect(history.stats().queuedBytes).toBeLessThanOrEqual(TERMINAL_HISTORY_PENDING_BYTES);
    expect(await readAllRows("early-chunks")).toEqual(
      Array.from({ length: 256 }, (_, index) => String(index)),
    );
    history.append("early-chunks", "after-init\r\n", 301, 1);
    expect((await readAllRows("early-chunks")).at(-1)).toBe("after-init");
    expect((await history.page("early-chunks"))?.historyGap).toBe(true);
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedRecords: 0 });
  });

  test("persists an explicit gap when the archive queue's byte bound overflows", async () => {
    const dataDir = await temporaryDirectory();
    const directory = await readySession(dataDir, "overloaded-session");
    const lineCount = 2_000;
    // Over 1 MiB in one event-loop turn, so no write can return a slot during it.
    history.append("overloaded-session", `${"x".repeat(1_000)}\r\n`.repeat(lineCount), 1, 1);
    const queued = history.stats();
    expect(queued.queuedBytes).toBeLessThanOrEqual(TERMINAL_HISTORY_PENDING_BYTES);
    expect(queued.queuedBytes).toBeGreaterThan(TERMINAL_HISTORY_PENDING_BYTES - 2_000);

    const snapshot = await history.stateSnapshot("overloaded-session");
    expect(snapshot?.historyGap).toBe(true);
    await history.flush();
    const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as {
      historyGap: boolean;
    };
    expect(manifest.historyGap).toBe(true);
    const rows = await readAllRows("overloaded-session");
    expect(rows.length).toBe(queued.queuedRecords);
    expect(rows.length).toBeLessThan(lineCount);
  });

  test("bounds queued empty lines, which carry no text bytes", async () => {
    await readySession(await temporaryDirectory(), "blank-session");
    history.append("blank-session", "\r\n".repeat(TERMINAL_HISTORY_PENDING_RECORDS + 1), 1, 1);
    const queued = history.stats();
    expect(queued.queuedRecords).toBe(TERMINAL_HISTORY_PENDING_RECORDS);
    expect(queued.queuedBytes).toBeLessThanOrEqual(TERMINAL_HISTORY_PENDING_BYTES);

    expect((await history.page("blank-session"))?.historyGap).toBe(true);
    expect(history.stats()).toMatchObject({ queuedBytes: 0, queuedRecords: 0 });
  });

  test("bounds records queued across sessions", async () => {
    const dataDir = await temporaryDirectory();
    const sessions = Math.ceil(
      (TERMINAL_HISTORY_GLOBAL_PENDING_RECORDS + 1) / TERMINAL_HISTORY_PENDING_RECORDS,
    );
    const ids = Array.from({ length: sessions }, (_, index) => `global-${index}`);
    for (const id of ids) await readySession(dataDir, id);
    for (const id of ids) {
      history.append(id, "\r\n".repeat(TERMINAL_HISTORY_PENDING_RECORDS), 1, 1);
    }
    expect(history.stats().queuedRecords).toBe(TERMINAL_HISTORY_GLOBAL_PENDING_RECORDS);

    expect((await history.page(ids.at(-1)!))?.historyGap).toBe(true);
    expect((await history.page(ids[0]!))?.historyGap).toBe(false);
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
