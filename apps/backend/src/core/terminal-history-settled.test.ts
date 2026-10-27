import { describe, expect, test } from "bun:test";
import { TerminalHistory } from "./terminal-history.js";

// Inject deferred work at the write-queue boundary so settlement tests need no
// disk timing, terminal parsing, or sleeps. No collector or timer is started.
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
});
