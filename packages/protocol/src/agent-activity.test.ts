import { describe, expect, test } from "bun:test";
import {
  aggregateAgentActivityState,
  AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS,
  AGENT_ACTIVITY_SOURCES,
  AGENT_ACTIVITY_STATES,
  isAgentActivityTimestamp,
  parseUsableAgentActivityTime,
} from "./agent-activity.js";

describe("agent activity vocabulary", () => {
  test("enumerates every supported state and source", () => {
    expect(AGENT_ACTIVITY_STATES).toEqual(["idle", "working", "waiting"]);
    expect(AGENT_ACTIVITY_SOURCES).toEqual([
      "frontend",
      "claude-terminal",
      "claude-tmux",
      "native-agent",
    ]);
  });
});

describe("isAgentActivityTimestamp", () => {
  test("accepts the forms this codebase actually mints", () => {
    expect(isAgentActivityTimestamp("2026-07-27T12:00:00.000Z")).toBe(true);
    expect(isAgentActivityTimestamp(new Date().toISOString())).toBe(true);
    expect(isAgentActivityTimestamp("2026-07-27T12:00:00Z")).toBe(true);
    expect(isAgentActivityTimestamp("2026-07-27T12:00:00+01:00")).toBe(true);
    // The extended year is still ISO-8601, and rejecting it here would mask the
    // separate "too far in the future" error that callers rely on.
    expect(isAgentActivityTimestamp("+275760-09-13T00:00:00.000Z")).toBe(true);
  });

  test("rejects the implementation-defined forms Date.parse also accepts", () => {
    // Date.parse takes all of these, which would make an "ISO timestamp"
    // contract a lie and let two clients disagree about what a token means.
    for (const value of [
      "Jul 27 2026 12:00:00",
      "2026-07-27",
      "2026/07/27 12:00:00",
      "12:00:00",
    ]) {
      expect(isAgentActivityTimestamp(value)).toBe(false);
    }
  });

  test("rejects non-strings, blanks and unparseable values", () => {
    expect(isAgentActivityTimestamp(undefined)).toBe(false);
    expect(isAgentActivityTimestamp(null)).toBe(false);
    expect(isAgentActivityTimestamp(1_700_000_000_000)).toBe(false);
    expect(isAgentActivityTimestamp("")).toBe(false);
    expect(isAgentActivityTimestamp("not-a-date")).toBe(false);
    // Shaped like ISO, but not a real instant.
    expect(isAgentActivityTimestamp("2026-13-45T99:00:00.000Z")).toBe(false);
  });
});

describe("parseUsableAgentActivityTime", () => {
  test("returns a comparable time for a usable token", () => {
    expect(parseUsableAgentActivityTime("2026-07-27T12:00:00.000Z", Date.parse(
      "2026-07-27T12:00:00.000Z",
    ))).toBe(Date.parse("2026-07-27T12:00:00.000Z"));
  });

  test("treats the skew allowance as inclusive at its boundary", () => {
    const reference = Date.parse("2026-07-27T12:00:00.000Z");
    const atLimit = new Date(
      reference + AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS,
    ).toISOString();
    const pastLimit = new Date(
      reference + AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS + 1,
    ).toISOString();

    expect(parseUsableAgentActivityTime(atLimit, reference))
      .toBe(reference + AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS);
    expect(parseUsableAgentActivityTime(pastLimit, reference))
      .toBe(Number.NEGATIVE_INFINITY);
  });

  test("loses every ordering comparison when the token is unusable", () => {
    // -Infinity rather than NaN: callers gate on Number.isFinite, and a token
    // that cannot be trusted must lose comparisons rather than win them.
    for (const value of [undefined, "", "not-a-date", "Jul 27 2026"]) {
      expect(parseUsableAgentActivityTime(value)).toBe(Number.NEGATIVE_INFINITY);
    }
  });

  test("defaults its reference to now", () => {
    const recent = new Date(Date.now() - 1_000).toISOString();
    expect(parseUsableAgentActivityTime(recent)).toBe(Date.parse(recent));
    const farFuture = new Date(
      Date.now() + AGENT_ACTIVITY_MAX_FUTURE_SKEW_MS + 60_000,
    ).toISOString();
    expect(parseUsableAgentActivityTime(farFuture))
      .toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("aggregateAgentActivityState", () => {
  const at = "2026-07-27T12:00:00.000Z";

  test("is idle only when nothing is happening", () => {
    expect(aggregateAgentActivityState({})).toBe("idle");
    expect(aggregateAgentActivityState({
      frontend: { state: "idle", updatedAt: at },
      "claude-terminal": { state: "idle", updatedAt: at },
    })).toBe("idle");
  });

  test("lets waiting outrank idle and working outrank both", () => {
    expect(aggregateAgentActivityState({
      frontend: { state: "idle", updatedAt: at },
      "claude-terminal": { state: "waiting", updatedAt: at },
    })).toBe("waiting");
    expect(aggregateAgentActivityState({
      frontend: { state: "waiting", updatedAt: at },
      "claude-terminal": { state: "working", updatedAt: at },
    })).toBe("working");
    // Precedence must not depend on iteration order.
    expect(aggregateAgentActivityState({
      frontend: { state: "working", updatedAt: at },
      "claude-terminal": { state: "waiting", updatedAt: at },
    })).toBe("working");
  });

  test("ignores absent sources", () => {
    expect(aggregateAgentActivityState({
      frontend: undefined,
      "claude-terminal": { state: "waiting", updatedAt: at },
    })).toBe("waiting");
  });

  test("aggregates independently keyed renderer observations", () => {
    expect(aggregateAgentActivityState({
      "renderer-a": { state: "idle", updatedAt: at },
      "renderer-b": { state: "working", updatedAt: at },
    })).toBe("working");
  });
});
