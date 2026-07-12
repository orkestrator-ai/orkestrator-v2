import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { listen } from "@/lib/native/events";
import { useAgentActivityStore } from "../../../apps/web/src/stores/agentActivityStore";
import { useAgentState } from "../../../apps/web/src/hooks/useAgentState";
import { useAgentStateCallbacks } from "../../../apps/web/src/hooks/useAgentStateCallbacks";

const listenMock = listen as unknown as ReturnType<typeof mock>;

afterEach(() => {
  cleanup();
  listenMock.mockReset();
  listenMock.mockImplementation(() => Promise.resolve(() => undefined));
  useAgentActivityStore.setState({
    tabStates: {}, containerStates: {}, containerRefCounts: {}, stateChangeCallbacks: new Map(),
  });
});

describe("useAgentState", () => {
  test("subscribes per container, accepts known states, and cleans up", async () => {
    const unlisten = mock(() => undefined);
    let callback: ((event: { payload: { state: string } }) => void) | undefined;
    listenMock.mockImplementation(async (_event: string, next: typeof callback) => {
      callback = next;
      return unlisten;
    });
    const { rerender, unmount } = renderHook(
      ({ containerId }) => useAgentState(containerId, "tab-1"),
      { initialProps: { containerId: "container-1" as string | null } },
    );
    await waitFor(() => expect(listenMock).toHaveBeenCalledWith("claude-state-container-1", expect.any(Function)));

    act(() => callback?.({ payload: { state: "working" } }));
    expect(useAgentActivityStore.getState().getTabState("tab-1")).toBe("working");
    act(() => callback?.({ payload: { state: "unknown" } }));
    expect(useAgentActivityStore.getState().getTabState("tab-1")).toBe("working");

    rerender({ containerId: null });
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(useAgentActivityStore.getState().getTabState("tab-1")).toBe("idle");
    unmount();
  });

  test("disposes a listener that resolves after unmount", async () => {
    const unlisten = mock(() => undefined);
    let resolveListen: ((value: () => void) => void) | undefined;
    listenMock.mockImplementation(() => new Promise((resolve) => { resolveListen = resolve; }));
    const { unmount } = renderHook(() => useAgentState("container-1", "tab-1"));
    unmount();
    await act(async () => {
      resolveListen?.(unlisten);
      await Promise.resolve();
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("useAgentStateCallbacks", () => {
  test("filters containers and dispatches generic and specific transitions", async () => {
    const onStateChange = mock(() => undefined);
    const onBecomeIdle = mock(() => undefined);
    const onBecomeWorking = mock(() => undefined);
    const { unmount } = renderHook(() => useAgentStateCallbacks({
      containerId: "env-1",
      onStateChange,
      onBecomeIdle,
      onBecomeWorking,
    }));

    act(() => {
      useAgentActivityStore.getState().setContainerState("other", "working");
      useAgentActivityStore.getState().setContainerState("env-1", "working");
    });
    await act(async () => Promise.resolve());
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onBecomeWorking).toHaveBeenCalledWith("env-1");

    act(() => useAgentActivityStore.getState().setContainerState("env-1", "idle"));
    await act(async () => Promise.resolve());
    expect(onBecomeIdle).toHaveBeenCalledWith("env-1");
    unmount();
    expect(useAgentActivityStore.getState().stateChangeCallbacks.size).toBe(0);
  });
});
