// Part 1 of 4 of the terminal history suite, split from terminal-history.test.ts so
// `bun test --parallel` can spread its large on-disk fixtures across workers. The shared
// harness lives in terminal-history-test-support.ts.
import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { type TerminalHistory, type TerminalHistoryOptions } from "./terminal-history.js";
import { useTerminalHistoryHarness, writeTerminal } from "./terminal-history-test-support.js";

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
});
