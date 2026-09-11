import { describe, expect, test } from "bun:test";
import { OpenCodeStreamState } from "./opencode-stream-state.js";

describe("OpenCodeStreamState turn clock", () => {
  test("beginTurn stamps and rejectTurn clears only the matching dispatch", () => {
    const state = new OpenCodeStreamState();
    state.beginTurn("session", 1_000);
    expect(state.turnStartedAt("session")).toBe(1_000);

    state.rejectTurn("session", 999);
    expect(state.turnStartedAt("session")).toBe(1_000);

    state.rejectTurn("session", 1_000);
    expect(state.turnStartedAt("session")).toBeUndefined();
  });

  test("ensureTurnStarted backfills once and keeps the first observation", () => {
    const state = new OpenCodeStreamState();
    expect(state.ensureTurnStarted("session", 1_000)).toBe(1_000);
    expect(state.ensureTurnStarted("session", 5_000)).toBe(1_000);
    expect(state.turnStartedAt("session")).toBe(1_000);
  });

  test("ensureTurnStarted ignores a stale expected event version", () => {
    const state = new OpenCodeStreamState();
    state.apply({
      type: "session.updated",
      properties: { sessionID: "session", info: { id: "session", title: "Streamed" } },
    } as never);
    const version = state.eventVersion("session");

    expect(state.ensureTurnStarted("session", 2_000, version - 1)).toBeUndefined();
    expect(state.turnStartedAt("session")).toBeUndefined();

    expect(state.ensureTurnStarted("session", 2_000, version)).toBe(2_000);
    expect(state.turnStartedAt("session")).toBe(2_000);
  });

  test("terminal events clear the turn clock", () => {
    const state = new OpenCodeStreamState();

    state.beginTurn("session", 1_000);
    state.apply({
      type: "session.error",
      properties: { sessionID: "session", error: { name: "ProviderError" } },
    } as never);
    expect(state.turnStartedAt("session")).toBeUndefined();

    state.beginTurn("session", 2_000);
    state.apply({
      type: "session.deleted",
      properties: { sessionID: "session", info: { id: "session" } },
    } as never);
    expect(state.turnStartedAt("session")).toBeUndefined();

    state.beginTurn("session", 3_000);
    state.apply({
      type: "session.status",
      properties: { sessionID: "session", status: { type: "idle" } },
    } as never);
    expect(state.turnStartedAt("session")).toBeUndefined();

    state.beginTurn("session", 4_000);
    state.apply({ type: "session.idle", properties: { sessionID: "session" } } as never);
    expect(state.turnStartedAt("session")).toBeUndefined();
  });

  test("busy and retry events establish the clock from observation time", () => {
    const state = new OpenCodeStreamState();

    state.apply(
      {
        type: "session.status",
        properties: { sessionID: "session", status: { type: "busy" } },
      } as never,
      7_000,
    );
    expect(state.turnStartedAt("session")).toBe(7_000);

    state.apply(
      {
        type: "session.status",
        properties: { sessionID: "session", status: { type: "retry" } },
      } as never,
      8_000,
    );
    expect(state.turnStartedAt("session")).toBe(7_000);
  });
});
