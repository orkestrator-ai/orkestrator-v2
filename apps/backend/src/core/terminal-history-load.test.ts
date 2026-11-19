// The shared harness owns temporary history directories and drains every parser.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { HeadlessParseScheduler } from "./terminal-parse-scheduler.js";
import { useTerminalHistoryHarness } from "./terminal-history-test-support.js";

const { createHistory, temporaryDirectory } = useTerminalHistoryHarness(() => {});

describe("terminal history under load", () => {
  test("publishes checkpoints while output keeps arriving behind the parser", async () => {
    const dataDir = await temporaryDirectory();
    const history = createHistory();
    const stableIdentity = "flooded-terminal";
    const historyId = history.configure({
      sessionId: "flood",
      dataDir,
      stableIdentity,
      cols: 40,
      rows: 8,
    });
    const file = Bun.file(path.join(dataDir, "terminal-history", historyId!, "checkpoint.json"));
    const chunk = "flood\r\n".repeat(150_000);
    history.append("flood", "first durable boundary\r\n", 1, 1);
    history.append("flood", chunk, 2, 1);
    let received = 3;
    const producer = setInterval(() => history.append("flood", chunk, received++, 1), 50);
    try {
      const deadline = performance.now() + 2_000;
      let revision = 0;
      while (performance.now() < deadline) {
        try {
          revision = ((await file.json()) as { revision: number }).revision;
        } catch {
          // Atomic rename has not yet published the first checkpoint.
        }
        if (revision > 0 && received > 4) break;
        await Bun.sleep(10);
      }
      expect(revision).toBeGreaterThan(0);
      expect(revision).toBeLessThan(received - 1);
    } finally {
      clearInterval(producer);
    }
  }, 15_000);

  test("restores a valid checkpoint when a newer boundary has oversized parser carry", async () => {
    const dataDir = await temporaryDirectory();
    const stableIdentity = "oversized-carry";
    const history = createHistory();
    history.configure({ sessionId: "flood", dataDir, stableIdentity, cols: 40, rows: 8 });
    history.append("flood", "saved before the control string\r\n", 1, 1);
    history.append("flood", "\x1b]0;" + "x".repeat(1024 * 1024), 2, 1);
    await history.settled();
    history.shutdown();
    await history.settled();

    const restored = createHistory();
    restored.configure({ sessionId: "restored", dataDir, stableIdentity, cols: 40, rows: 8 });
    const snapshot = await restored.stateSnapshot("restored");
    expect(snapshot?.output).toContain("saved before the control string");
  });

  test("interleaves real history parsers and releases the whole budget", async () => {
    const dataDir = await temporaryDirectory();
    const parser = new HeadlessParseScheduler();
    const history = createHistory({ parser });
    for (const sessionId of ["flood", "quiet", "other"]) {
      history.configure({ sessionId, dataDir, stableIdentity: sessionId, cols: 40, rows: 8 });
    }
    await history.settled();
    history.append("flood", "flood\r\n".repeat(70_000), 1, 1);
    history.append("quiet", "quiet terminal\r\n", 1, 1);
    history.append("other", "another terminal\r\n", 1, 1);
    const resolved: string[] = [];
    const snapshots = await Promise.all(
      ["flood", "quiet", "other"].map(async (id) => {
        const snapshot = await history.stateSnapshot(id);
        resolved.push(id);
        return snapshot;
      }),
    );
    expect(resolved.at(-1)).toBe("flood");
    expect(snapshots[1]?.output).toContain("quiet terminal");
    expect(snapshots[2]?.output).toContain("another terminal");
    await history.settled();
    expect(parser.stats()).toEqual({ queuedTargets: 0, inFlightTargets: 0, inFlightChars: 0 });
  });
});
