import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  terminalHistoryTesting,
} from "./terminal-history.js";

const directories: string[] = [];

afterEach(async () => {
  terminalHistoryTesting.clear();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
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
        appendTerminalHistory("paged-session", `row-${sequence}`, sequence, 1);
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
      appendTerminalHistory("overloaded-session", `record-${revision}`, revision, 1);
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
    expect(() =>
      configureTerminalHistory({
        sessionId: "refused-43",
        dataDir,
        stableIdentity: "refused-terminal-43",
        cols: 1,
        rows: 1,
      }),
    ).toThrow("storage admission limit");
    await flushTerminalHistories();
  });
});
