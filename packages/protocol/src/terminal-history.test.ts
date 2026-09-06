import { describe, expect, test } from "bun:test";
import { isTerminalHistoryPage, isTerminalStateSnapshot } from "./terminal-history";

describe("terminal history protocol", () => {
  test("validates complete state snapshots", () => {
    expect(
      isTerminalStateSnapshot({
        formatVersion: 1,
        mode: "state",
        output: "screen",
        pendingOutput: "",
        generation: 1,
        revision: 2,
        historyId: "history",
        incarnation: "incarnation",
        cols: 80,
        rows: 24,
        earliestSequence: 1,
        latestSequence: 2,
        historyTruncated: false,
        historyGap: false,
        completed: false,
      }),
    ).toBe(true);
    expect(isTerminalStateSnapshot({ formatVersion: 1, output: "partial" })).toBe(false);
  });

  test("validates bounded history pages", () => {
    expect(
      isTerminalHistoryPage({
        formatVersion: 1,
        historyId: "history",
        rows: [{ id: "1:0", text: "line" }],
        previousCursor: null,
        earliestAvailable: true,
        historyTruncated: false,
        historyGap: false,
      }),
    ).toBe(true);
    expect(isTerminalHistoryPage({ formatVersion: 1, rows: [{ id: 1, text: "line" }] })).toBe(
      false,
    );
  });
});
