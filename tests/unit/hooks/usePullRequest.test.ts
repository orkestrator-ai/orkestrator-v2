import { describe, test, expect, beforeEach, mock } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useEnvironmentStore } from "../../../apps/web/src/stores/environmentStore";
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

// Mock prMonitorStore
const mockSetMonitoringMode = mock(() => {});
const mockGetMonitoringState = mock(() => null as { checkInProgress: boolean } | null);

mock.module("@/stores/prMonitorStore", () => ({
  usePrMonitorStore: () => ({
    setMonitoringMode: mockSetMonitoringMode,
    getMonitoringState: mockGetMonitoringState,
  }),
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

    // Reset mocks
    mockGetEnvironmentPrUrl.mockClear();
    mockClearEnvironmentPr.mockClear();
    mockOpenInBrowser.mockClear();
    mockSetMonitoringMode.mockClear();
    mockGetMonitoringState.mockClear();

    // Reset to default implementations
    mockGetEnvironmentPrUrl.mockImplementation(() => Promise.resolve(null));
    mockClearEnvironmentPr.mockImplementation(() => Promise.resolve());
    mockOpenInBrowser.mockImplementation(() => Promise.resolve());
    mockGetMonitoringState.mockImplementation(() => null);
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
    mockGetMonitoringState.mockImplementation(() => ({ checkInProgress: true }));

    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    expect(result.current.isDetecting).toBe(true);
  });

  test("setModeCreatePending calls setMonitoringMode with create-pending", () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    act(() => {
      result.current.setModeCreatePending();
    });

    expect(mockSetMonitoringMode).toHaveBeenCalledWith("env-1", "create-pending");
  });

  test("setModeMergePending calls setMonitoringMode with merge-pending", () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    act(() => {
      result.current.setModeMergePending();
    });

    expect(mockSetMonitoringMode).toHaveBeenCalledWith("env-1", "merge-pending");
  });

  test("setModeCreatePending does nothing when no environmentId", () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: null }));

    act(() => {
      result.current.setModeCreatePending();
    });

    expect(mockSetMonitoringMode).not.toHaveBeenCalled();
  });
});
