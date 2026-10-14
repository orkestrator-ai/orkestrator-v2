import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { useAgentActivityStore } from "../../../apps/web/src/stores/agentActivityStore";
import { useAgentState } from "../../../apps/web/src/hooks/useAgentState";

const listenMock = listen as unknown as ReturnType<typeof mock>;
const invokeMock = invoke as unknown as ReturnType<typeof mock>;

type Callback = (event: { payload: unknown }) => void;

/** Captures the latest callback registered for each event name. */
function captureListeners(unlisten: () => void = () => undefined) {
  const callbacks = new Map<string, Callback>();
  listenMock.mockImplementation(async (event: string, next: Callback) => {
    callbacks.set(event, next);
    return unlisten;
  });
  return callbacks;
}

afterEach(() => {
  cleanup();
  listenMock.mockReset();
  listenMock.mockImplementation(() => Promise.resolve(() => undefined));
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  useAgentActivityStore.setState({
    tabStates: {},
    containerStates: {},
    containerStateUpdatedAt: {},
  });
});

describe("useAgentState", () => {
  test("subscribes per container, accepts known states, and cleans up", async () => {
    const unlisten = mock(() => undefined);
    const callbacks = captureListeners(unlisten);
    const { rerender, unmount } = renderHook(
      ({ containerId }) => useAgentState(containerId, "tab-1"),
      { initialProps: { containerId: "container-1" as string | null } },
    );
    await waitFor(() =>
      expect(listenMock).toHaveBeenCalledWith("claude-state-container-1", expect.any(Function)),
    );
    await waitFor(() => expect(callbacks.has(NATIVE_EVENT_STREAM_CONNECTED_EVENT)).toBe(true));

    const event = callbacks.get("claude-state-container-1")!;
    act(() => event({ payload: { state: "working" } }));
    expect(useAgentActivityStore.getState().getTabState("tab-1")).toBe("working");
    act(() => event({ payload: { state: "unknown" } }));
    expect(useAgentActivityStore.getState().getTabState("tab-1")).toBe("working");

    rerender({ containerId: null });
    // Both the event and its resync subscription are released.
    expect(unlisten).toHaveBeenCalledTimes(2);
    expect(useAgentActivityStore.getState().getTabState("tab-1")).toBe("idle");
    unmount();
  });

  test("hydrates a late-mounted tab without a second connected event", async () => {
    const callbacks = captureListeners();
    invokeMock.mockResolvedValue({ state: "working", occurredAt: "2026-10-14T10:00:00.000Z" });
    renderHook(() => useAgentState("container-1", "tab-1"));
    await waitFor(() =>
      expect(useAgentActivityStore.getState().getTabState("tab-1")).toBe("working"),
    );
    expect(invokeMock).toHaveBeenCalledWith("get_claude_terminal_state", {
      containerId: "container-1",
    });
    expect(callbacks.has(NATIVE_EVENT_STREAM_CONNECTED_EVENT)).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  test("re-reads the persisted state when the event stream resyncs", async () => {
    const callbacks = captureListeners();
    invokeMock.mockImplementation(async (command: string, args: { containerId: string }) =>
      command === "get_claude_terminal_state" && args.containerId === "container-1"
        ? { state: "waiting", occurredAt: "2026-10-14T10:00:00.000Z" }
        : undefined,
    );
    renderHook(() => useAgentState("container-1", "tab-1"));
    await waitFor(() => expect(callbacks.has(NATIVE_EVENT_STREAM_CONNECTED_EVENT)).toBe(true));

    await act(async () => {
      callbacks.get(NATIVE_EVENT_STREAM_CONNECTED_EVENT)!({ payload: undefined });
    });
    await waitFor(() =>
      expect(useAgentActivityStore.getState().getTabState("tab-1")).toBe("waiting"),
    );
  });

  test("never lets an older snapshot roll back a newer live event", async () => {
    const callbacks = captureListeners();
    let answer!: (value: unknown) => void;
    invokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    renderHook(() => useAgentState("container-1", "tab-1"));
    await waitFor(() => expect(callbacks.has(NATIVE_EVENT_STREAM_CONNECTED_EVENT)).toBe(true));

    await act(async () => {
      callbacks.get(NATIVE_EVENT_STREAM_CONNECTED_EVENT)!({ payload: undefined });
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    act(() =>
      callbacks.get("claude-state-container-1")!({
        payload: { state: "working", occurred_at: "2026-10-14T10:00:05.000Z" },
      }),
    );
    await act(async () => {
      answer({ state: "waiting", occurredAt: "2026-10-14T10:00:00.000Z" });
    });
    expect(useAgentActivityStore.getState().getTabState("tab-1")).toBe("working");
  });

  test("disposes listeners that resolve after unmount", async () => {
    const unlisten = mock(() => undefined);
    const resolvers: Array<(value: () => void) => void> = [];
    listenMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { unmount } = renderHook(() => useAgentState("container-1", "tab-1"));
    unmount();
    await act(async () => {
      resolvers[0]?.(unlisten);
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
      resolvers[1]?.(unlisten);
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    });
    expect(unlisten).toHaveBeenCalledTimes(2);
  });
});
