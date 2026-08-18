import { describe, expect, test } from "bun:test";
import {
  findLatestBackendTurnElapsedSeconds,
  findLatestBackendUserTurnStartedAt,
  parseBackendTurnStartedAt,
  reconcileTimedSession,
  type TimedSessionState,
  updateTimedSessionLoading,
} from "./session-timer";

describe("session-timer helpers", () => {
  test("parses backend timestamps and rejects malformed clocks", () => {
    expect(parseBackendTurnStartedAt("2026-07-31T20:00:00.000Z")).toBe(
      Date.parse("2026-07-31T20:00:00.000Z"),
    );
    expect(parseBackendTurnStartedAt(1234)).toBeUndefined();
    expect(parseBackendTurnStartedAt("not-a-date")).toBeUndefined();
    expect(parseBackendTurnStartedAt(-1)).toBeUndefined();
  });

  test("finds the current backend user turn without reusing an older turn", () => {
    const messages = [
      { id: "server-old", role: "user", createdAt: "2026-07-31T20:00:00.000Z" },
      { id: "assistant", role: "assistant", createdAt: "2026-07-31T20:01:00.000Z" },
      { id: "optimistic-new", role: "user", createdAt: "2026-07-31T20:02:00.000Z" },
    ];
    expect(
      findLatestBackendUserTurnStartedAt(
        messages,
        (message) => !message.id.startsWith("optimistic-"),
      ),
    ).toBeUndefined();

    messages[2] = {
      id: "server-new",
      role: "user",
      createdAt: "2026-07-31T20:02:03.000Z",
    };
    expect(
      findLatestBackendUserTurnStartedAt(
        messages,
        (message) => !message.id.startsWith("optimistic-"),
      ),
    ).toBe(Date.parse("2026-07-31T20:02:03.000Z"));
  });

  test.each([
    ["missing", undefined],
    ["malformed", "not-a-date"],
  ])("does not reuse an older backend turn when the current clock is %s", (_label, createdAt) => {
    const messages = [
      { id: "server-old", role: "user", createdAt: "2026-07-31T20:00:00.000Z" },
      { id: "assistant", role: "assistant", createdAt: "2026-07-31T20:01:00.000Z" },
      { id: "server-current", role: "user", createdAt },
    ];

    expect(findLatestBackendUserTurnStartedAt(messages)).toBeUndefined();
  });

  describe("findLatestBackendTurnElapsedSeconds", () => {
    const isBackend = (message: { id: string }) => !message.id.startsWith("optimistic-");

    test("measures the last turn from its prompt to its newest response section", () => {
      // Split display rows each carry their own section clock, so the newest
      // one — not the last row in the array — closes the turn.
      const messages = [
        { id: "user-1", role: "user", createdAt: "2026-07-31T20:00:00.000Z" },
        { id: "a-1", role: "assistant", createdAt: "2026-07-31T20:00:30.000Z" },
        { id: "user-2", role: "user", createdAt: "2026-07-31T20:01:00.000Z" },
        { id: "a-2", role: "assistant", createdAt: "2026-07-31T20:01:45.000Z" },
        { id: "a-2:text-block:1", role: "assistant", createdAt: "2026-07-31T20:02:10.000Z" },
        { id: "a-2:text-block:2", role: "assistant", createdAt: "2026-07-31T20:02:05.000Z" },
      ];

      expect(findLatestBackendTurnElapsedSeconds(messages, isBackend)).toBe(70);
    });

    test("floors a partial second rather than rounding the turn up", () => {
      expect(
        findLatestBackendTurnElapsedSeconds([
          { id: "user-1", role: "user", createdAt: "2026-07-31T20:00:00.000Z" },
          { id: "a-1", role: "assistant", createdAt: "2026-07-31T20:00:01.900Z" },
        ]),
      ).toBe(1);
    });

    test("reports a same-instant turn as zero rather than nothing", () => {
      expect(
        findLatestBackendTurnElapsedSeconds([
          { id: "user-1", role: "user", createdAt: "2026-07-31T20:00:00.000Z" },
          { id: "a-1", role: "assistant", createdAt: "2026-07-31T20:00:00.000Z" },
        ]),
      ).toBe(0);
    });

    test("ignores responses that belong to an earlier turn", () => {
      // The newest prompt has no response yet, so there is no duration to show
      // even though an earlier turn has perfectly good clocks.
      expect(
        findLatestBackendTurnElapsedSeconds([
          { id: "user-1", role: "user", createdAt: "2026-07-31T20:00:00.000Z" },
          { id: "a-1", role: "assistant", createdAt: "2026-07-31T20:00:30.000Z" },
          { id: "user-2", role: "user", createdAt: "2026-07-31T20:01:00.000Z" },
        ]),
      ).toBeUndefined();
    });

    test("reports nothing while the prompt is still optimistic", () => {
      expect(
        findLatestBackendTurnElapsedSeconds(
          [
            { id: "optimistic-user", role: "user", createdAt: "2026-07-31T20:01:00.000Z" },
            { id: "a-1", role: "assistant", createdAt: "2026-07-31T20:01:30.000Z" },
          ],
          isBackend,
        ),
      ).toBeUndefined();
    });

    test("skips client-only responses when closing the turn", () => {
      expect(
        findLatestBackendTurnElapsedSeconds(
          [
            { id: "user-1", role: "user", createdAt: "2026-07-31T20:00:00.000Z" },
            { id: "a-1", role: "assistant", createdAt: "2026-07-31T20:00:20.000Z" },
            { id: "optimistic-note", role: "assistant", createdAt: "2026-07-31T20:09:00.000Z" },
          ],
          isBackend,
        ),
      ).toBe(20);
    });

    test.each([
      ["an empty transcript", []],
      [
        "a transcript with no prompt",
        [{ id: "a-1", role: "assistant", createdAt: "2026-07-31T20:00:30.000Z" }],
      ],
      [
        "a prompt with no clock",
        [
          { id: "user-1", role: "user", createdAt: undefined },
          { id: "a-1", role: "assistant", createdAt: "2026-07-31T20:00:30.000Z" },
        ],
      ],
      [
        "a prompt with a malformed clock",
        [
          { id: "user-1", role: "user", createdAt: "not-a-date" },
          { id: "a-1", role: "assistant", createdAt: "2026-07-31T20:00:30.000Z" },
        ],
      ],
      [
        "a response with no usable clock",
        [
          { id: "user-1", role: "user", createdAt: "2026-07-31T20:00:00.000Z" },
          { id: "a-1", role: "assistant", createdAt: "not-a-date" },
        ],
      ],
      [
        "a response stamped before its prompt",
        [
          { id: "user-1", role: "user", createdAt: "2026-07-31T20:01:00.000Z" },
          { id: "a-1", role: "assistant", createdAt: "2026-07-31T20:00:00.000Z" },
        ],
      ],
    ])("reports nothing for %s", (_label, messages) => {
      expect(
        findLatestBackendTurnElapsedSeconds(
          messages as Array<{ id: string; role: string; createdAt?: string }>,
        ),
      ).toBeUndefined();
    });
  });

  test("does not invent a clock for a newly started loading session", () => {
    const incoming: TimedSessionState = {
      isLoading: true,
      loadingStartedAt: undefined,
      lastCompletedElapsedSeconds: undefined,
    };

    const next = reconcileTimedSession(undefined, incoming, 5000);

    expect(next.loadingStartedAt).toBeUndefined();
    expect(next.lastCompletedElapsedSeconds).toBeNull();
  });

  test("preserves the original loadingStartedAt for an in-progress session", () => {
    const previous: TimedSessionState = {
      isLoading: true,
      loadingStartedAt: 1000,
      lastCompletedElapsedSeconds: null,
    };
    const incoming: TimedSessionState = {
      isLoading: true,
      loadingStartedAt: undefined,
      lastCompletedElapsedSeconds: undefined,
    };

    const next = reconcileTimedSession(previous, incoming, 5000);

    expect(next.loadingStartedAt).toBe(1000);
    expect(next.lastCompletedElapsedSeconds).toBeNull();
  });

  test("preserves explicit incoming timer metadata", () => {
    const previous: TimedSessionState = {
      isLoading: true,
      loadingStartedAt: 1000,
      lastCompletedElapsedSeconds: null,
    };
    const incoming: TimedSessionState = {
      isLoading: true,
      loadingStartedAt: 2500,
      lastCompletedElapsedSeconds: 9,
    };

    const next = reconcileTimedSession(previous, incoming, 5000);

    expect(next.loadingStartedAt).toBe(2500);
    expect(next.lastCompletedElapsedSeconds).toBe(9);
  });

  test("computes lastCompletedElapsedSeconds when loading finishes", () => {
    const previous: TimedSessionState = {
      isLoading: true,
      loadingStartedAt: 1000,
      lastCompletedElapsedSeconds: null,
    };
    const incoming: TimedSessionState = {
      isLoading: false,
      loadingStartedAt: undefined,
      lastCompletedElapsedSeconds: undefined,
    };

    const next = reconcileTimedSession(previous, incoming, 6500);

    expect(next.loadingStartedAt).toBeUndefined();
    expect(next.lastCompletedElapsedSeconds).toBe(5);
  });

  test("updateTimedSessionLoading waits for an authoritative start clock", () => {
    const idle: TimedSessionState = {
      isLoading: false,
      loadingStartedAt: undefined,
      lastCompletedElapsedSeconds: 7,
    };

    const started = updateTimedSessionLoading(idle, true, 2000);

    expect(started.isLoading).toBe(true);
    expect(started.loadingStartedAt).toBeUndefined();
    expect(started.lastCompletedElapsedSeconds).toBeNull();

    const completed = updateTimedSessionLoading(started, false, 8200);
    expect(completed.isLoading).toBe(false);
    expect(completed.loadingStartedAt).toBeUndefined();
    expect(completed.lastCompletedElapsedSeconds).toBeNull();
  });

  test("returns the same session when already loading with a start time", () => {
    const loading: TimedSessionState = {
      isLoading: true,
      loadingStartedAt: 2000,
      lastCompletedElapsedSeconds: null,
    };

    expect(updateTimedSessionLoading(loading, true, 9000)).toBe(loading);
  });

  test("replaces a renderer start with an authoritative backend timestamp", () => {
    const loading: TimedSessionState = {
      isLoading: true,
      loadingStartedAt: 5000,
      lastCompletedElapsedSeconds: null,
    };

    const reconciled = updateTimedSessionLoading(loading, true, 9000, 2000);

    expect(reconciled.loadingStartedAt).toBe(2000);
    expect(reconciled.lastCompletedElapsedSeconds).toBeNull();
  });
});
