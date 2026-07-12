import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { usePrMonitorService } from "../../../apps/web/src/hooks/usePrMonitorService";
import { useAgentActivityStore } from "../../../apps/web/src/stores/agentActivityStore";
import { usePrMonitorStore } from "../../../apps/web/src/stores/prMonitorStore";
import { useUIStore } from "../../../apps/web/src/stores/uiStore";

afterEach(() => {
  cleanup();
  useAgentActivityStore.setState({
    tabStates: {}, containerStates: {}, containerRefCounts: {}, stateChangeCallbacks: new Map(),
  });
  usePrMonitorStore.setState({ monitoredEnvironments: {}, activeEnvironmentId: null });
  useUIStore.setState({ selectedEnvironmentId: null });
});

describe("usePrMonitorService", () => {
  test("registers singleton polling subscriptions and releases them on unmount", () => {
    useUIStore.setState({ selectedEnvironmentId: null });
    const { unmount } = renderHook(() => usePrMonitorService());
    expect(useAgentActivityStore.getState().stateChangeCallbacks.size).toBe(1);
    expect(usePrMonitorStore.getState().activeEnvironmentId).toBeNull();

    unmount();
    expect(useAgentActivityStore.getState().stateChangeCallbacks.size).toBe(0);
  });
});
