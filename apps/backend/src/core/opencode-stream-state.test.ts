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

  test("retry status keeps the turn running and publishes an advisory", () => {
    const state = new OpenCodeStreamState();
    state.apply(
      {
        type: "session.status",
        properties: {
          sessionID: "session",
          status: { type: "retry", attempt: 2, message: "Provider timed out" },
        },
      } as never,
      9_000,
    );
    expect(state.turnStartedAt("session")).toBe(9_000);
    expect(state.notices("session")).toEqual([
      {
        kind: "advisory",
        severity: "warning",
        message: "OpenCode is retrying the model request (attempt 2). Provider timed out",
      },
    ]);
  });

  test("retry status falls back when attempt or message is omitted", () => {
    const state = new OpenCodeStreamState();
    state.apply(
      {
        type: "session.status",
        properties: { sessionID: "session", status: { type: "retry" } },
      } as never,
      9_000,
    );
    expect(state.notices("session")).toEqual([
      {
        kind: "advisory",
        severity: "warning",
        message:
          "OpenCode is retrying the model request. The model request failed and is being retried.",
      },
    ]);

    state.apply(
      {
        type: "session.status",
        properties: {
          sessionID: "session",
          status: { type: "retry", message: "Provider timed out" },
        },
      } as never,
      9_500,
    );
    expect(state.notices("session")).toEqual([
      {
        kind: "advisory",
        severity: "warning",
        message: "OpenCode is retrying the model request. Provider timed out",
      },
    ]);
  });

  test("clears the retry advisory once the retried request is busy again", () => {
    const state = new OpenCodeStreamState();
    state.apply(
      {
        type: "session.status",
        properties: {
          sessionID: "session",
          status: { type: "retry", attempt: 1, message: "Provider timed out" },
        },
      } as never,
      9_000,
    );
    expect(state.notices("session")).toHaveLength(1);

    state.apply(
      {
        type: "session.status",
        properties: { sessionID: "session", status: { type: "busy" } },
      } as never,
      9_500,
    );
    expect(state.notices("session")).toEqual([]);
    expect(state.turnStartedAt("session")).toBe(9_000);
  });

  test("session.updated records the provider session model", () => {
    const state = new OpenCodeStreamState();
    state.apply({
      type: "session.updated",
      properties: {
        sessionID: "session",
        info: {
          id: "session",
          title: "Investigation",
          model: { providerID: "opencode-go", id: "deepseek-v4-flash", variant: "default" },
        },
      },
    } as never);
    expect(state.sessionModel("session")).toEqual({
      modelId: "opencode-go/deepseek-v4-flash",
      reasoningId: "default",
    });
  });
});
