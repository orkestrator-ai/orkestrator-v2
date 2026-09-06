import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import {
  appendTerminalHistory,
  completeTerminalHistory,
  configureTerminalHistory,
  configureTerminalHistoryRetention,
  deleteTerminalHistories,
  disposeTerminalHistory,
  flushTerminalHistories,
  getTerminalHistoryPage,
  getTerminalStateSnapshot,
  pruneTerminalHistoryStorage,
  resumeTerminalHistory,
  resizeTerminalHistory,
  terminalHistoryTesting,
} from "./terminal-history.js";

const directories: string[] = [];

afterEach(async () => {
  terminalHistoryTesting.clear();
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

describe.serial("terminal history", () => {
  test("serializes current terminal state and pages backend-owned history", async () => {
    const dataDir = await temporaryDirectory();
    configureTerminalHistory({
      sessionId: "session-1",
      dataDir,
      stableIdentity: "local\0environment-1\0tab-1",
      cols: 20,
      rows: 4,
      environmentId: "environment-1",
      tabId: "tab-1",
    });

    appendTerminalHistory("session-1", "first\r\n", 1, 1);
    appendTerminalHistory("session-1", "\x1b[31mfinal-marker\x1b[0m", 2, 1);
    const snapshot = await getTerminalStateSnapshot("session-1");

    expect(snapshot).toMatchObject({
      formatVersion: 1,
      generation: 1,
      revision: 2,
      cols: 20,
      rows: 4,
      historyGap: false,
    });
    expect(snapshot?.output).toContain("final-marker");

    await completeTerminalHistory("session-1");
    const page = await getTerminalHistoryPage("session-1");
    expect(page?.rows.map((row) => row.text).join("\n")).toContain("final-marker");
    expect(page?.rows.map((row) => row.text).join("\n")).not.toContain("\x1b[31m");

    const historyDirectory = path.join(dataDir, "terminal-history", snapshot!.historyId);
    expect((await stat(historyDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(historyDirectory, "manifest.json"))).mode & 0o777).toBe(0o600);
  });

  test("restores the durable checkpoint for a new PTY incarnation", async () => {
    const dataDir = await temporaryDirectory();
    const stableIdentity = "container\0environment-1\0tab-1";
    configureTerminalHistory({
      sessionId: "old-session",
      dataDir,
      stableIdentity,
      cols: 30,
      rows: 5,
    });
    appendTerminalHistory("old-session", "survives-restart", 1, 1);
    await completeTerminalHistory("old-session");
    terminalHistoryTesting.clear();

    configureTerminalHistory({
      sessionId: "new-session",
      dataDir,
      stableIdentity,
      cols: 30,
      rows: 5,
    });
    const restored = await getTerminalStateSnapshot("new-session");
    expect(restored?.output).toContain("survives-restart");
    expect(restored?.incarnation).not.toBeUndefined();
  });

  test("forces the latest active state into a graceful-shutdown checkpoint", async () => {
    const dataDir = await temporaryDirectory();
    const stableIdentity = "graceful-restart-terminal";
    configureTerminalHistory({
      sessionId: "before-graceful-restart",
      dataDir,
      stableIdentity,
      cols: 30,
      rows: 5,
    });
    appendTerminalHistory("before-graceful-restart", "first\r\n", 1, 1);
    await getTerminalStateSnapshot("before-graceful-restart");
    appendTerminalHistory("before-graceful-restart", "latest-marker", 2, 1);
    await flushTerminalHistories(true);
    appendTerminalHistory("before-graceful-restart", "after-quiesce", 3, 1);
    terminalHistoryTesting.clear();

    configureTerminalHistory({
      sessionId: "after-graceful-restart",
      dataDir,
      stableIdentity,
      cols: 30,
      rows: 5,
    });
    const restored = await getTerminalStateSnapshot("after-graceful-restart");
    expect(restored?.revision).toBe(2);
    expect(restored?.output).toContain("latest-marker");
    expect(restored?.output).not.toContain("after-quiesce");
  });

  test("rejects cursors from another terminal incarnation", async () => {
    const dataDir = await temporaryDirectory();
    configureTerminalHistory({
      sessionId: "session-a",
      dataDir,
      stableIdentity: "terminal-a",
      cols: 80,
      rows: 24,
    });
    appendTerminalHistory("session-a", "a", 1, 1);
    await completeTerminalHistory("session-a");
    const page = await getTerminalHistoryPage("session-a");

    configureTerminalHistory({
      sessionId: "session-b",
      dataDir,
      stableIdentity: "terminal-b",
      cols: 80,
      rows: 24,
    });
    await expect(
      getTerminalHistoryPage("session-b", page?.previousCursor ?? "invalid"),
    ).rejects.toThrow("invalid or expired");
  });

  test("restores the final screen after both legacy replay limits roll over", async () => {
    const dataDir = await temporaryDirectory();
    configureTerminalHistory({
      sessionId: "rollover-session",
      dataDir,
      stableIdentity: "rollover-terminal",
      cols: 80,
      rows: 24,
    });
    appendTerminalHistory("rollover-session", "initial-marker\r\n", 1, 1);
    for (let revision = 2; revision <= 1_100; revision += 1) {
      appendTerminalHistory(
        "rollover-session",
        `${String(revision).padStart(4, "0")}:${"x".repeat(500)}\r\n`,
        revision,
        1,
      );
    }
    appendTerminalHistory("rollover-session", "FINAL-OFFLINE-MARKER\r\n", 1_101, 1);

    const snapshot = await getTerminalStateSnapshot("rollover-session");
    expect(snapshot?.revision).toBe(1_101);
    expect(snapshot?.output).toContain("FINAL-OFFLINE-MARKER");
    expect(snapshot?.historyTruncated).toBe(true);
  });

  test("preserves a split control sequence and subsequent terminal behavior", async () => {
    const dataDir = await temporaryDirectory();
    configureTerminalHistory({
      sessionId: "parser-session",
      dataDir,
      stableIdentity: "parser-terminal",
      cols: 12,
      rows: 4,
    });
    appendTerminalHistory("parser-session", "before\r\n\x1b[3", 1, 1);
    const snapshot = await getTerminalStateSnapshot("parser-session");
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
    configureTerminalHistory({
      sessionId: "paged-session",
      dataDir,
      stableIdentity: "paged-terminal",
      cols: 80,
      rows: 24,
    });
    for (let batch = 0; batch < 5; batch += 1) {
      for (let row = 0; row < 250; row += 1) {
        const sequence = batch * 250 + row + 1;
        appendTerminalHistory("paged-session", `row-${sequence}\r\n`, sequence, 1);
      }
      await flushTerminalHistories();
    }
    const recent = await getTerminalHistoryPage("paged-session");
    expect(recent?.rows.at(-1)?.text).toBe("row-1250");
    expect(recent?.rows.some((row) => row.text === "row-1250")).toBe(true);
    expect(recent?.previousCursor).not.toBeNull();
    const earlier = await getTerminalHistoryPage("paged-session", recent!.previousCursor!);
    expect(earlier?.rows.some((row) => row.text === "row-1")).toBe(true);

    configureTerminalHistory({
      sessionId: "other-session",
      dataDir,
      stableIdentity: "other-terminal",
      cols: 80,
      rows: 24,
    });
    await expect(getTerminalHistoryPage("other-session", recent!.previousCursor!)).rejects.toThrow(
      "invalid or expired",
    );
  });

  test("normalizes lines, CRLF, Unicode, and ANSI across transport chunks and pages", async () => {
    const dataDir = await temporaryDirectory();
    configureTerminalHistory({
      sessionId: "fragmented-session",
      dataDir,
      stableIdentity: "fragmented-terminal",
      cols: 80,
      rows: 24,
    });
    appendTerminalHistory("fragmented-session", "hel", 1, 1);
    appendTerminalHistory("fragmented-session", "lo\r", 2, 1);
    appendTerminalHistory("fragmented-session", "\n\x1b[3", 3, 1);
    appendTerminalHistory("fragmented-session", "1mred\x1b[0m \ud83d", 4, 1);
    appendTerminalHistory("fragmented-session", "\ude42\r\n", 5, 1);
    for (let index = 0; index < 1_005; index += 1) {
      appendTerminalHistory("fragmented-session", `line-${index}-`, index * 2 + 6, 1);
      appendTerminalHistory("fragmented-session", `continued\r\n`, index * 2 + 7, 1);
      if (index % 200 === 0) await flushTerminalHistories();
    }
    await completeTerminalHistory("fragmented-session");

    const recent = await getTerminalHistoryPage("fragmented-session");
    const earlier = await getTerminalHistoryPage("fragmented-session", recent!.previousCursor!);
    const rows = [...earlier!.rows, ...recent!.rows].map((row) => row.text);
    expect(rows).toContain("hello");
    expect(rows).toContain("red 🙂");
    expect(rows).toContain("line-0-continued");
    expect(rows).toContain("line-1004-continued");
    expect(rows.some((row) => row.includes("\x1b"))).toBe(false);
  });

  test("explicit deletion removes active and dormant history", async () => {
    const dataDir = await temporaryDirectory();
    configureTerminalHistory({
      sessionId: "deleted-session",
      dataDir,
      stableIdentity: "local\0environment-delete\0tab-delete",
      cols: 80,
      rows: 24,
      environmentId: "environment-delete",
      tabId: "tab-delete",
    });
    appendTerminalHistory("deleted-session", "private output", 1, 1);
    await completeTerminalHistory("deleted-session");
    await deleteTerminalHistories({
      dataDir,
      environmentId: "environment-delete",
      tabId: "tab-delete",
    });
    expect(await getTerminalStateSnapshot("deleted-session")).toBeNull();
    expect(await readdir(path.join(dataDir, "terminal-history"))).toHaveLength(0);
  });

  test("age retention does not delete a history while its terminal is still active", async () => {
    const dataDir = await temporaryDirectory();
    configureTerminalHistoryRetention({ sessionMb: 64, globalMb: 1024, days: 1 });
    configureTerminalHistory({
      sessionId: "active-completed-session",
      dataDir,
      stableIdentity: "active-completed-terminal",
      cols: 80,
      rows: 24,
    });
    appendTerminalHistory("active-completed-session", "finished command", 1, 1);
    await completeTerminalHistory("active-completed-session");
    const snapshot = await getTerminalStateSnapshot("active-completed-session");
    const historyDirectory = path.join(dataDir, "terminal-history", snapshot!.historyId);
    const manifestPath = path.join(historyDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { updatedAt: number };
    manifest.updatedAt = 0;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    await pruneTerminalHistoryStorage(dataDir);
    expect((await stat(historyDirectory)).isDirectory()).toBe(true);

    await disposeTerminalHistory("active-completed-session");
    await pruneTerminalHistoryStorage(dataDir);
    await expect(stat(historyDirectory)).rejects.toThrow();
  });

  test("automatically prunes expired disposed histories in a long-running process", async () => {
    const dataDir = await temporaryDirectory();
    configureTerminalHistoryRetention({ sessionMb: 64, globalMb: 128, days: 1 });
    configureTerminalHistory({
      sessionId: "expired-session",
      dataDir,
      stableIdentity: "expired-terminal",
      cols: 80,
      rows: 24,
    });
    appendTerminalHistory("expired-session", "expired output\r\n", 1, 1);
    await completeTerminalHistory("expired-session");
    const snapshot = await getTerminalStateSnapshot("expired-session");
    const historyDirectory = path.join(dataDir, "terminal-history", snapshot!.historyId);
    const manifestPath = path.join(historyDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { updatedAt: number };
    manifest.updatedAt = 0;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await disposeTerminalHistory("expired-session");
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
    configureTerminalHistoryRetention({ sessionMb: 64, globalMb: 128, days: 7 });
    configureTerminalHistory({
      sessionId: "prune-trigger",
      dataDir,
      stableIdentity: "prune-trigger-terminal",
      cols: 1,
      rows: 1,
    });
    await disposeTerminalHistory("prune-trigger");
    const remaining = await readdir(root);
    expect(
      remaining.filter((entry) => entry === "1".repeat(64) || entry === "2".repeat(64)).length,
    ).toBeLessThan(2);
  });

  test("bounds completed in-memory collectors", async () => {
    const dataDir = await temporaryDirectory();
    for (let index = 0; index < 12; index += 1) {
      configureTerminalHistory({
        sessionId: `completed-${index}`,
        dataDir,
        stableIdentity: `completed-terminal-${index}`,
        cols: 1,
        rows: 1,
      });
      appendTerminalHistory(`completed-${index}`, `done-${index}\r\n`, 1, 1);
      await completeTerminalHistory(`completed-${index}`);
    }
    expect(terminalHistoryTesting.stats().sessions).toBeLessThanOrEqual(8);
    expect(terminalHistoryTesting.stats().estimatedStateBytes).toBeLessThanOrEqual(8 * 2_001 * 96);

    const restoredState = await getTerminalStateSnapshot("completed-0");
    const restoredPage = await getTerminalHistoryPage("completed-0");
    expect(restoredState).toMatchObject({ completed: true, revision: 1 });
    expect(restoredState?.output).toContain("done-0");
    expect(restoredPage?.rows.some((row) => row.text === "done-0")).toBe(true);
    expect(terminalHistoryTesting.stats().sessions).toBeLessThanOrEqual(8);
  });

  test("revives completed collectors before same-generation output and eviction", async () => {
    const dataDir = await temporaryDirectory();
    configureTerminalHistory({
      sessionId: "revived",
      dataDir,
      stableIdentity: "revived-terminal",
      cols: 20,
      rows: 4,
    });
    appendTerminalHistory("revived", "first run\r\n", 1, 1);
    await completeTerminalHistory("revived");
    await resumeTerminalHistory("revived");
    appendTerminalHistory("revived", "second run\r\n", 2, 1);

    for (let index = 0; index < 9; index += 1) {
      configureTerminalHistory({
        sessionId: `eviction-${index}`,
        dataDir,
        stableIdentity: `eviction-terminal-${index}`,
        cols: 1,
        rows: 1,
      });
      appendTerminalHistory(`eviction-${index}`, `done-${index}\r\n`, 1, 1);
      await completeTerminalHistory(`eviction-${index}`);
    }
    await pruneTerminalHistoryStorage(dataDir);

    const snapshot = await getTerminalStateSnapshot("revived");
    expect(snapshot).toMatchObject({ completed: false, revision: 2 });
    expect(snapshot?.output).toContain("second run");
  });

  test("keeps the first partial archive line after a generation change", async () => {
    const dataDir = await temporaryDirectory();
    configureTerminalHistory({
      sessionId: "generation-carry",
      dataDir,
      stableIdentity: "generation-carry-terminal",
      cols: 20,
      rows: 4,
    });
    appendTerminalHistory("generation-carry", "old partial", 1, 1);
    appendTerminalHistory("generation-carry", "prompt> ", 1, 2);
    appendTerminalHistory("generation-carry", "ls\r\n", 2, 2);
    await completeTerminalHistory("generation-carry");

    const page = await getTerminalHistoryPage("generation-carry");
    expect(page?.rows.map((row) => row.text)).toContain("prompt> ls");
  });

  test("truncates an uncommitted segment tail before reusing its sequence", async () => {
    const dataDir = await temporaryDirectory();
    const stableIdentity = "torn-segment-terminal";
    configureTerminalHistory({
      sessionId: "before-torn-write",
      dataDir,
      stableIdentity,
      cols: 40,
      rows: 5,
    });
    appendTerminalHistory("before-torn-write", "committed\r\n", 1, 1);
    await completeTerminalHistory("before-torn-write");
    const snapshot = await getTerminalStateSnapshot("before-torn-write");
    await disposeTerminalHistory("before-torn-write");
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

    configureTerminalHistory({
      sessionId: "after-torn-write",
      dataDir,
      stableIdentity,
      cols: 40,
      rows: 5,
    });
    appendTerminalHistory("after-torn-write", "replacement\r\n", 2, 1);
    await completeTerminalHistory("after-torn-write");
    const page = await getTerminalHistoryPage("after-torn-write");
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
    terminalHistoryTesting.setMaxHistoryDirectories(4);
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
    await pruneTerminalHistoryStorage(dataDir);
    expect((await readdir(root)).length).toBeLessThanOrEqual(4);
  });

  test("contains final checkpoint serialization failures and records completion", async () => {
    const dataDir = await temporaryDirectory();
    configureTerminalHistory({
      sessionId: "oversized-screen",
      dataDir,
      stableIdentity: "oversized-screen-terminal",
      cols: 80,
      rows: 24,
    });
    appendTerminalHistory("oversized-screen", "output\r\n", 1, 1);
    terminalHistoryTesting.setSerializeHook(() => {
      throw new Error("snapshot too large");
    });
    await expect(completeTerminalHistory("oversized-screen")).resolves.toBeUndefined();
    terminalHistoryTesting.setSerializeHook(null);
    const snapshot = await getTerminalStateSnapshot("oversized-screen");
    expect(snapshot?.completed).toBe(true);
    expect(snapshot?.historyGap).toBe(true);
  });

  test("limits concurrent history page reads without waiter barging", async () => {
    const dataDir = await temporaryDirectory();
    configureTerminalHistory({
      sessionId: "concurrent-pages",
      dataDir,
      stableIdentity: "concurrent-pages-terminal",
      cols: 80,
      rows: 24,
    });
    appendTerminalHistory("concurrent-pages", "line\r\n", 1, 1);
    await flushTerminalHistories();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let maximum = 0;
    terminalHistoryTesting.setPageReadHook(async () => {
      maximum = Math.max(maximum, terminalHistoryTesting.stats().pageReads);
      await barrier;
    });
    const reads = Array.from({ length: 12 }, () => getTerminalHistoryPage("concurrent-pages"));
    await Bun.sleep(10);
    expect(terminalHistoryTesting.stats().pageReads).toBe(4);
    release();
    await Promise.all(reads);
    expect(maximum).toBe(4);
  });

  test("can disable durable history and remove existing archives", async () => {
    const dataDir = await temporaryDirectory();
    configureTerminalHistory({
      sessionId: "private-session",
      dataDir,
      stableIdentity: "private-terminal",
      cols: 80,
      rows: 24,
    });
    appendTerminalHistory("private-session", "secret\r\n", 1, 1);
    await completeTerminalHistory("private-session");
    configureTerminalHistoryRetention({ enabled: false });
    await pruneTerminalHistoryStorage(dataDir);
    expect(
      configureTerminalHistory({
        sessionId: "disabled-session",
        dataDir,
        stableIdentity: "disabled-terminal",
        cols: 80,
        rows: 24,
      }),
    ).toBeNull();
    await expect(stat(path.join(dataDir, "terminal-history"))).rejects.toThrow();
  });

  test("persists an explicit gap when the bounded archive queue overflows", async () => {
    const dataDir = await temporaryDirectory();
    configureTerminalHistory({
      sessionId: "overloaded-session",
      dataDir,
      stableIdentity: "overloaded-terminal",
      cols: 80,
      rows: 24,
    });
    for (let revision = 1; revision <= 300; revision += 1) {
      appendTerminalHistory("overloaded-session", `record-${revision}\r\n`, revision, 1);
    }
    const snapshot = await getTerminalStateSnapshot("overloaded-session");
    expect(snapshot?.historyGap).toBe(true);
    await flushTerminalHistories();
    const manifest = JSON.parse(
      await readFile(
        path.join(dataDir, "terminal-history", snapshot!.historyId, "manifest.json"),
        "utf8",
      ),
    ) as { historyGap: boolean };
    expect(manifest.historyGap).toBe(true);
  });

  test("marks a corrupt checkpoint as a gap while retaining usable archive data", async () => {
    const dataDir = await temporaryDirectory();
    const stableIdentity = "corrupt-checkpoint-terminal";
    configureTerminalHistory({
      sessionId: "before-corruption",
      dataDir,
      stableIdentity,
      cols: 80,
      rows: 24,
    });
    appendTerminalHistory("before-corruption", "archived-before-corruption", 1, 1);
    await completeTerminalHistory("before-corruption");
    const before = await getTerminalStateSnapshot("before-corruption");
    await disposeTerminalHistory("before-corruption");
    await writeFile(
      path.join(dataDir, "terminal-history", before!.historyId, "checkpoint.json"),
      '{"formatVersion":1,"output":"damaged","checksum":"wrong"}\n',
    );

    configureTerminalHistory({
      sessionId: "after-corruption",
      dataDir,
      stableIdentity,
      cols: 80,
      rows: 24,
    });
    const recovered = await getTerminalStateSnapshot("after-corruption");
    const page = await getTerminalHistoryPage("after-corruption");
    expect(recovered?.historyGap).toBe(true);
    expect(page?.rows.some((row) => row.text.includes("archived-before-corruption"))).toBe(true);
  });

  test("reserves bounded recovery storage when admitting many active terminals", async () => {
    const dataDir = await temporaryDirectory();
    configureTerminalHistoryRetention({ sessionMb: 8, globalMb: 128, days: 7 });
    for (let index = 0; index < 42; index += 1) {
      configureTerminalHistory({
        sessionId: `admitted-${index}`,
        dataDir,
        stableIdentity: `admitted-terminal-${index}`,
        cols: 1,
        rows: 1,
      });
    }
    expect(
      configureTerminalHistory({
        sessionId: "refused-43",
        dataDir,
        stableIdentity: "refused-terminal-43",
        cols: 1,
        rows: 1,
      }),
    ).toBeNull();
    await flushTerminalHistories();
  });

  test("reports scrollback reclaimed for another terminal as truncated", async () => {
    const dataDir = await temporaryDirectory();
    configureTerminalHistory({
      sessionId: "reclaimed",
      dataDir,
      stableIdentity: "reclaimed-terminal",
      cols: 1_000,
      rows: 1_000,
    });
    configureTerminalHistory({
      sessionId: "admitted-after-reclaim",
      dataDir,
      stableIdentity: "admitted-after-reclaim-terminal",
      cols: 500,
      rows: 500,
    });

    expect((await getTerminalStateSnapshot("reclaimed"))?.historyTruncated).toBe(true);
  });

  test("degrades history resize without throwing when the emulator budget is saturated", async () => {
    const dataDir = await temporaryDirectory();
    for (let index = 0; index < 9; index += 1) {
      configureTerminalHistory({
        sessionId: `resize-${index}`,
        dataDir,
        stableIdentity: `resize-terminal-${index}`,
        cols: 80,
        rows: 24,
      });
    }
    expect(() => resizeTerminalHistory("resize-0", 1_000, 1_000)).not.toThrow();
    expect(terminalHistoryTesting.stats().estimatedStateBytes).toBeLessThanOrEqual(
      128 * 1024 * 1024,
    );
    await flushTerminalHistories();
  });
});
