import { describe, expect, test } from "bun:test";
import {
  checkHistoryPageFence,
  historyPageSession,
  type HistoryPageFence,
} from "./native-history-page-fence";

const session = {
  platform: "codex",
  environmentId: "env-1",
  sessionId: "session-1",
  generation: "generation-1",
};

const requested: HistoryPageFence = {
  sequence: 3,
  operationEpoch: 7,
  session: historyPageSession(session),
  historyEpoch: "epoch-1",
  cursor: "cursor-before-m3",
};

describe("checkHistoryPageFence", () => {
  test("a page whose facts all still hold may be merged", () => {
    expect(checkHistoryPageFence(requested, { ...requested })).toBe("current");
  });

  test("a live tail that moved on, in the same session, does not fence the page", () => {
    // Tail reads change none of the fenced fields; a copy of the session with
    // other projection fields is still the same session.
    const now = {
      ...requested,
      session: historyPageSession({ ...session, title: "streamed" } as typeof session),
    };
    expect(checkHistoryPageFence(requested, now)).toBe("current");
  });

  test.each([
    ["superseded", { sequence: 4 }],
    ["mutated", { operationEpoch: 8 }],
    [
      "session-changed",
      { session: historyPageSession({ ...session, generation: "generation-2" }) },
    ],
    ["session-changed", { session: historyPageSession({ ...session, sessionId: "session-2" }) }],
    ["session-changed", { session: null }],
    ["history-rewritten", { historyEpoch: "epoch-2" }],
    ["history-rewritten", { historyEpoch: undefined }],
    ["cursor-moved", { cursor: "cursor-before-m9" }],
    ["cursor-moved", { cursor: undefined }],
  ] as const)("reports %s", (verdict, change) => {
    expect(checkHistoryPageFence(requested, { ...requested, ...change })).toBe(verdict);
  });

  test("reports the first failing check", () => {
    expect(
      checkHistoryPageFence(requested, {
        ...requested,
        sequence: 4,
        historyEpoch: "epoch-2",
        cursor: undefined,
      }),
    ).toBe("superseded");
  });
});

describe("historyPageSession", () => {
  test("keeps only the identifying fields", () => {
    expect(historyPageSession({ ...session, messages: [] } as typeof session)).toEqual(session);
    expect(historyPageSession(null)).toBeNull();
  });
});
