import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { PR_MONITOR_CHANGED_EVENT, type PrMonitorEvent } from "@orkestrator/protocol/pr-monitor";
import * as realBackend from "@/lib/backend";
import * as realNativeEvents from "@/lib/native/events";
import * as realNotificationSounds from "@/lib/notification-sounds";
import { useEnvironmentStore } from "@/stores/environmentStore";

const handlers = new Map<string, (event: { payload: unknown }) => void>();
const listen = mock(async (event: string, handler: (event: { payload: unknown }) => void) => {
  handlers.set(event, handler);
  return () => handlers.delete(event);
});
const getPrMonitorState = mock(async () => ({ entries: [] }));
const playConfiguredNotificationSound = mock(async () => true);

mock.module("@/lib/backend", () => ({ ...realBackend, getPrMonitorState }));
mock.module("@/lib/native/events", () => ({ ...realNativeEvents, listen }));
mock.module("@/lib/notification-sounds", () => ({
  ...realNotificationSounds,
  playConfiguredNotificationSound,
}));

const { usePrMonitorService } = await import("./usePrMonitorService");

beforeEach(() => {
  handlers.clear();
  listen.mockClear();
  getPrMonitorState.mockClear();
  getPrMonitorState.mockResolvedValue({ entries: [] });
  playConfiguredNotificationSound.mockClear();
  useEnvironmentStore.setState({
    environments: [{ id: "env-1", branch: "feature/sounds" }] as never,
  });
});

afterEach(cleanup);

afterAll(() => {
  mock.module("@/lib/backend", () => realBackend);
  mock.module("@/lib/native/events", () => realNativeEvents);
  mock.module("@/lib/notification-sounds", () => realNotificationSounds);
});

describe("usePrMonitorService sound notifications", () => {
  test("plays the merge cue once for a deduplicated merged transition", async () => {
    const observer = renderHook(() => usePrMonitorService());
    await waitFor(() => expect(handlers.has(PR_MONITOR_CHANGED_EVENT)).toBe(true));

    const event: PrMonitorEvent = {
      environmentId: "env-1",
      state: {
        environmentId: "env-1",
        mode: "normal",
        checkInProgress: false,
        consecutiveErrors: 0,
        lastCheckAt: "2026-09-19T12:00:00.000Z",
        prUrl: "https://github.com/example/repo/pull/1",
        prState: "merged",
        hasMergeConflicts: false,
        checkSummary: null,
      },
      transition: {
        url: "https://github.com/example/repo/pull/1",
        state: "merged",
        previousState: "open",
      },
    };

    act(() => {
      handlers.get(PR_MONITOR_CHANGED_EVENT)?.({ payload: event });
      handlers.get(PR_MONITOR_CHANGED_EVENT)?.({ payload: event });
    });

    expect(playConfiguredNotificationSound).toHaveBeenCalledTimes(1);
    expect(playConfiguredNotificationSound).toHaveBeenCalledWith("pr-merged");
    observer.unmount();
  });
});
