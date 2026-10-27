import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TerminalHistory } from "./terminal-history.js";

// Queue-boundary tests inject deferred work without relying on disk timing.
type PendingHistory = {
  sessions: Map<string, { parseTail: Promise<void>; ioTail: Promise<void> }>;
  historyIoTails: Map<string, Promise<void>>;
  historyDisposals: Map<string, Promise<void>>;
  rootPruneTails: Map<string, Promise<void>>;
};

describe("TerminalHistory.settled", () => {
  test("returns when no work is pending, including on repeated calls", async () => {
    const history = new TerminalHistory();
    await history.settled();
    await history.settled();
    expect(history.stats().sessions).toBe(0);
  });

  test("waits for every writer and work queued while settlement is waiting", async () => {
    const history = new TerminalHistory();
    const pending = history as unknown as PendingHistory;
    const work = Array.from({ length: 5 }, () => Promise.withResolvers<void>());
    pending.sessions.set("fixture", { parseTail: work[0]!.promise, ioTail: work[1]!.promise });
    pending.historyIoTails.set("history", work[2]!.promise);
    pending.historyDisposals.set("disposed", work[3]!.promise);
    pending.rootPruneTails.set("root", work[4]!.promise);
    const queued = Promise.withResolvers<void>();
    const observedQueued = Promise.withResolvers<void>();
    void work[4]!.promise.then(() => {
      pending.historyIoTails.set("new-write", queued.promise);
      observedQueued.resolve();
    });
    let settled = false;
    const settlement = history.settled().then(() => {
      settled = true;
    });
    try {
      for (const writer of work) {
        expect(settled).toBe(false);
        writer.resolve();
        await writer.promise;
      }
      await observedQueued.promise;
      // Flush the original batch, then verify the newly queued write owns the wait.
      await Promise.resolve();
      expect(settled).toBe(false);
      queued.resolve();
      await settlement;
      expect(settled).toBe(true);
      await history.settled();
    } finally {
      for (const writer of work) writer.resolve();
      queued.resolve();
      await settlement;
    }
  });

  test("drains output appended by a collector after shutdown", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ork-history-shutdown-"));
    const history = new TerminalHistory();
    try {
      history.configure({
        sessionId: "late",
        dataDir: root,
        stableIdentity: "late-output",
        cols: 80,
        rows: 24,
      });
      history.append("late", "before shutdown\r\n", 1, 1);
      history.shutdown();
      const settling = history.settled();
      history.append("late", "after shutdown", 2, 1);
      let parsedAfterShutdown = false;
      void (history as unknown as PendingHistory).sessions.get("late")!.parseTail.then(() => {
        parsedAfterShutdown = true;
      });
      await settling;
      expect(parsedAfterShutdown).toBe(true);
      const snapshot = await history.stateSnapshot("late");
      expect(snapshot?.revision).toBe(2);
      expect(snapshot?.output).toContain("after shutdown");
      // Quiesce and drain the final checkpoint just as graceful shutdown does.
      await history.flush(true);
      await history.settled();
    } finally {
      history.shutdown();
      await history.settled();
      await rm(root, { recursive: true, force: true });
    }
  });
});
