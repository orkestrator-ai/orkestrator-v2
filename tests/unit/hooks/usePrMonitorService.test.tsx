import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import * as realBackend from "../../../apps/web/src/lib/backend";
import type { PrDetectionResult } from "../../../apps/web/src/lib/backend";
import * as realSonner from "../../../apps/web/node_modules/sonner";
import { useAgentActivityStore } from "../../../apps/web/src/stores/agentActivityStore";
import { useEnvironmentStore } from "../../../apps/web/src/stores/environmentStore";
import { usePrMonitorStore } from "../../../apps/web/src/stores/prMonitorStore";
import { useUIStore } from "../../../apps/web/src/stores/uiStore";
import type { Environment } from "../../../apps/web/src/types";

const realBackendSnapshot = { ...realBackend };
const realSonnerSnapshot = { ...realSonner };
const detectPrMock = mock(async (): Promise<PrDetectionResult | null> => null);
const setEnvironmentPrMock = mock(async () => {});
const toastSuccessMock = mock(() => {});

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  detectPr: detectPrMock,
  setEnvironmentPr: setEnvironmentPrMock,
}));

mock.module("sonner", () => ({
  ...realSonnerSnapshot,
  toast: {
    ...realSonnerSnapshot.toast,
    success: toastSuccessMock,
  },
}));

const { usePrMonitorService } = await import("../../../apps/web/src/hooks/usePrMonitorService");

beforeEach(() => {
  detectPrMock.mockReset();
  setEnvironmentPrMock.mockReset();
  toastSuccessMock.mockReset();
  detectPrMock.mockImplementation(async () => null);
  setEnvironmentPrMock.mockImplementation(async () => {});
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("sonner", () => realSonnerSnapshot);
});

afterEach(() => {
  cleanup();
  useAgentActivityStore.setState({
    tabStates: {}, containerStates: {}, containerRefCounts: {}, stateChangeCallbacks: new Map(),
  });
  usePrMonitorStore.setState({ monitoredEnvironments: {}, activeEnvironmentId: null });
  useUIStore.setState({ selectedEnvironmentId: null });
  useEnvironmentStore.setState({
    environments: [],
    workspaceReadyEnvironments: new Set(),
  });
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

  test("shows a toast when polling detects that a branch was merged", async () => {
    const environment: Environment = {
      id: "env-1",
      projectId: "project-1",
      name: "mobile-toast",
      branch: "feature/mobile-toast",
      containerId: "container-1",
      status: "running",
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "open",
      hasMergeConflicts: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "containerized",
    };
    detectPrMock.mockResolvedValueOnce({
      url: environment.prUrl!,
      state: "merged",
      hasMergeConflicts: false,
    });
    useEnvironmentStore.setState({
      environments: [environment],
      workspaceReadyEnvironments: new Set([environment.id]),
    });
    useUIStore.setState({ selectedEnvironmentId: environment.id });

    const { unmount } = renderHook(() => usePrMonitorService());

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith("Branch merged", {
        description: "feature/mobile-toast",
        id: "branch-merged-env-1",
      });
    });
    expect(setEnvironmentPrMock).toHaveBeenCalledWith(
      "env-1",
      environment.prUrl,
      "merged",
      false,
    );

    unmount();
  });
});
