import { describe, test, expect, beforeEach, mock } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useEnvironmentStore } from "../../../apps/web/src/stores/environmentStore";
import { usePrMonitorStore } from "../../../apps/web/src/stores/prMonitorStore";
import { createMockEnvironment } from "../utils/testFactories";

// Mock backend module BEFORE importing the hook
const mockGetEnvironmentPrUrl = mock<(environmentId: string) => Promise<string | null>>(() => Promise.resolve(null));
const mockClearEnvironmentPr = mock<(environmentId: string) => Promise<void>>(() => Promise.resolve());
const mockOpenInBrowser = mock<(url: string) => Promise<void>>(() => Promise.resolve());

mock.module("@/lib/backend", () => ({
  getEnvironmentPrUrl: mockGetEnvironmentPrUrl,
  clearEnvironmentPr: mockClearEnvironmentPr,
  openInBrowser: mockOpenInBrowser,
}));

// Import hook AFTER mocking
import { usePullRequest } from "../../../apps/web/src/hooks/usePullRequest";

describe("usePullRequest", () => {
  beforeEach(() => {
    // Reset store between tests
    useEnvironmentStore.setState({
      environments: [],
      isLoading: false,
      error: null,
    });
    usePrMonitorStore.setState({
      monitoredEnvironments: {},
      activeEnvironmentId: null,
    });

    // Reset mocks
    mockGetEnvironmentPrUrl.mockClear();
    mockClearEnvironmentPr.mockClear();
    mockOpenInBrowser.mockClear();
    // Reset to default implementations
    mockGetEnvironmentPrUrl.mockImplementation(() => Promise.resolve(null));
    mockClearEnvironmentPr.mockImplementation(() => Promise.resolve());
    mockOpenInBrowser.mockImplementation(() => Promise.resolve());
  });

  test("returns initial state with no environment", () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: null }));

    expect(result.current.prUrl).toBeNull();
    expect(result.current.isDetecting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("returns prUrl from environment store", () => {
    const env = createMockEnvironment({
      id: "env-1",
      containerId: "container-123",
      status: "running",
      prUrl: "https://github.com/test/repo/pull/123",
    });

    useEnvironmentStore.setState({
      environments: [env],
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    expect(result.current.prUrl).toBe("https://github.com/test/repo/pull/123");
  });

  test("viewPR opens browser with prUrl", async () => {
    const env = createMockEnvironment({
      id: "env-1",
      containerId: "container-123",
      status: "running",
      prUrl: "https://github.com/test/repo/pull/123",
    });

    useEnvironmentStore.setState({
      environments: [env],
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    await act(async () => {
      await result.current.viewPR();
    });

    expect(mockOpenInBrowser).toHaveBeenCalledWith("https://github.com/test/repo/pull/123");
  });

  test("viewPR fetches prUrl from backend when not in store", async () => {
    mockGetEnvironmentPrUrl.mockImplementation(() =>
      Promise.resolve("https://github.com/test/repo/pull/456")
    );

    const env = createMockEnvironment({
      id: "env-1",
      containerId: "container-123",
      status: "running",
      prUrl: null,
    });

    useEnvironmentStore.setState({
      environments: [env],
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    await act(async () => {
      await result.current.viewPR();
    });

    expect(mockGetEnvironmentPrUrl).toHaveBeenCalledWith("env-1");
    expect(mockOpenInBrowser).toHaveBeenCalledWith("https://github.com/test/repo/pull/456");
  });

  test("viewPR sets error when no prUrl available", async () => {
    const env = createMockEnvironment({
      id: "env-1",
      containerId: "container-123",
      status: "running",
      prUrl: null,
    });

    useEnvironmentStore.setState({
      environments: [env],
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    await act(async () => {
      await result.current.viewPR();
    });

    expect(result.current.error).toBe("No PR URL available");
  });

  test("viewPR sets error on browser open failure", async () => {
    mockOpenInBrowser.mockImplementation(() => Promise.reject(new Error("Failed to open browser")));

    const env = createMockEnvironment({
      id: "env-1",
      containerId: "container-123",
      status: "running",
      prUrl: "https://github.com/test/repo/pull/123",
    });

    useEnvironmentStore.setState({
      environments: [env],
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    await act(async () => {
      await result.current.viewPR();
    });

    expect(result.current.error).toBe("Failed to open browser");
  });

  test("resetPR clears the PR URL", async () => {
    const env = createMockEnvironment({
      id: "env-1",
      containerId: "container-123",
      status: "running",
      prUrl: "https://github.com/test/repo/pull/123",
    });

    useEnvironmentStore.setState({
      environments: [env],
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    expect(result.current.prUrl).toBe("https://github.com/test/repo/pull/123");

    await act(async () => {
      await result.current.resetPR();
    });

    expect(mockClearEnvironmentPr).toHaveBeenCalledWith("env-1");
    // The store should be updated to clear the PR
    expect(useEnvironmentStore.getState().environments[0]?.prUrl).toBeNull();
  });

  test("resetPR does nothing when no environmentId", async () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: null }));

    await act(async () => {
      await result.current.resetPR();
    });

    expect(mockClearEnvironmentPr).not.toHaveBeenCalled();
  });

  test("isDetecting reflects monitor store checkInProgress", () => {
    usePrMonitorStore.getState().startMonitoring("env-1");
    usePrMonitorStore.getState()._setCheckInProgress("env-1", true);

    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    expect(result.current.isDetecting).toBe(true);
  });

  test("reacts to PR and monitoring state changes after mount", async () => {
    useEnvironmentStore.setState({
      environments: [createMockEnvironment({ id: "env-1", prUrl: null })],
    });
    usePrMonitorStore.getState().startMonitoring("env-1");
    const { result } = renderHook(() =>
      usePullRequest({ environmentId: "env-1" })
    );

    act(() => {
      useEnvironmentStore.getState().setEnvironmentPR(
        "env-1",
        "https://github.com/test/repo/pull/789",
        "open",
        true,
      );
      usePrMonitorStore.getState()._setCheckInProgress("env-1", true);
    });

    await waitFor(() => {
      expect(result.current.prUrl).toBe(
        "https://github.com/test/repo/pull/789",
      );
      expect(result.current.prState).toBe("open");
      expect(result.current.hasMergeConflicts).toBe(true);
      expect(result.current.isDetecting).toBe(true);
    });
  });

  test("setModeCreatePending calls setMonitoringMode with create-pending", () => {
    usePrMonitorStore.getState().startMonitoring("env-1");
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    act(() => {
      result.current.setModeCreatePending();
    });

    expect(usePrMonitorStore.getState().getMonitoringState("env-1")?.mode)
      .toBe("create-pending");
  });

  test("setModeMergePending calls setMonitoringMode with merge-pending", () => {
    usePrMonitorStore.getState().startMonitoring("env-1");
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    act(() => {
      result.current.setModeMergePending();
    });

    expect(usePrMonitorStore.getState().getMonitoringState("env-1")?.mode)
      .toBe("merge-pending");
  });

  test("setModeCreatePending does nothing when no environmentId", () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: null }));

    act(() => {
      result.current.setModeCreatePending();
    });

    expect(usePrMonitorStore.getState().monitoredEnvironments).toEqual({});
  });
});
