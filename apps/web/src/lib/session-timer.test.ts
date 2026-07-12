import { describe, expect, test } from "bun:test";
import {
  reconcileTimedSession,
  type TimedSessionState,
  updateTimedSessionLoading,
} from "./session-timer";

describe("session-timer helpers", () => {
  test("stamps the current time for a newly started loading session", () => {
    const incoming: TimedSessionState = {
      isLoading: true,
      loadingStartedAt: undefined,
      lastCompletedElapsedSeconds: undefined,
    };

    const next = reconcileTimedSession(undefined, incoming, 5000);

    expect(next.loadingStartedAt).toBe(5000);
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

    const next = reconcileTimedSession(
      previous,
      incoming,
      5000,
    );

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

    const next = reconcileTimedSession(
      previous,
      incoming,
      6500,
    );

    expect(next.loadingStartedAt).toBeUndefined();
    expect(next.lastCompletedElapsedSeconds).toBe(5);
  });

  test("updateTimedSessionLoading stamps start and completion times", () => {
    const idle: TimedSessionState = {
      isLoading: false,
      loadingStartedAt: undefined,
      lastCompletedElapsedSeconds: 7,
    };

    const started = updateTimedSessionLoading(
      idle,
      true,
      2000,
    );

    expect(started.isLoading).toBe(true);
    expect(started.loadingStartedAt).toBe(2000);
    expect(started.lastCompletedElapsedSeconds).toBeNull();

    const completed = updateTimedSessionLoading(started, false, 8200);
    expect(completed.isLoading).toBe(false);
    expect(completed.loadingStartedAt).toBeUndefined();
    expect(completed.lastCompletedElapsedSeconds).toBe(6);
  });

  test("returns the same session when already loading with a start time", () => {
    const loading: TimedSessionState = {
      isLoading: true,
      loadingStartedAt: 2000,
      lastCompletedElapsedSeconds: null,
    };

    expect(updateTimedSessionLoading(loading, true, 9000)).toBe(loading);
  });
});
