import { describe, test, expect, beforeEach, mock } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { PrMonitorEnvironmentState } from "@orkestrator/protocol/pr-monitor";
import { useEnvironmentStore } from "../../../apps/web/src/stores/environmentStore";
import { usePrMonitorStore } from "../../../apps/web/src/stores/prMonitorStore";
import { createMockEnvironment } from "../utils/testFactories";

// Mock backend module BEFORE importing the hook
const mockGetEnvironmentPrUrl = mock<(environmentId: string) => Promise<string | null>>(() => Promise.resolve(null));
const mockClearEnvironmentPr = mock<(environmentId: string) => Promise<void>>(() => Promise.resolve());
const mockOpenInBrowser = mock<(url: string) => Promise<void>>(() => Promise.resolve());
const mockPrMonitorWatch = mock<(environmentId: string, mode: string) => Promise<void>>(() => Promise.resolve());
const mockArmPrRefreshAfterAgentCompletion = mock<(environmentId: string) => Promise<string | null>>(
  () => Promise.resolve("armed-at-1"),
);
const mockDisarmPrRefreshAfterAgentCompletion = mock<
  (environmentId: string, armedAt: string) => Promise<void>
>(() => Promise.resolve());

mock.module("@/lib/backend", () => ({
  getEnvironmentPrUrl: mockGetEnvironmentPrUrl,
  clearEnvironmentPr: mockClearEnvironmentPr,
  openInBrowser: mockOpenInBrowser,
  prMonitorWatch: mockPrMonitorWatch,
  armPrRefreshAfterAgentCompletion: mockArmPrRefreshAfterAgentCompletion,
  disarmPrRefreshAfterAgentCompletion: mockDisarmPrRefreshAfterAgentCompletion,
}));

function monitorState(
  environmentId: string,
  overrides: Partial<PrMonitorEnvironmentState> = {},
): PrMonitorEnvironmentState {
  return {
    environmentId,
    mode: "normal",
    checkInProgress: false,
    consecutiveErrors: 0,
    lastCheckAt: null,
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    ...overrides,
  };
}

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

    usePrMonitorStore.setState({ states: new Map() });

    // Reset mocks
    mockGetEnvironmentPrUrl.mockClear();
    mockClearEnvironmentPr.mockClear();
    mockOpenInBrowser.mockClear();
    mockPrMonitorWatch.mockClear();
    mockArmPrRefreshAfterAgentCompletion.mockClear();
    mockDisarmPrRefreshAfterAgentCompletion.mockClear();

    // Reset to default implementations
    mockGetEnvironmentPrUrl.mockImplementation(() => Promise.resolve(null));
    mockClearEnvironmentPr.mockImplementation(() => Promise.resolve());
    mockOpenInBrowser.mockImplementation(() => Promise.resolve());
    mockPrMonitorWatch.mockImplementation(() => Promise.resolve());
    mockArmPrRefreshAfterAgentCompletion.mockImplementation(() => Promise.resolve("armed-at-1"));
    mockDisarmPrRefreshAfterAgentCompletion.mockImplementation(() => Promise.resolve());
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

  test("reacts to authoritative environment and monitor snapshot changes", () => {
    useEnvironmentStore.setState({
      environments: [createMockEnvironment({ id: "env-1", prUrl: null })],
      isLoading: false,
      error: null,
    });
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    act(() => {
      useEnvironmentStore.getState().setEnvironmentPR(
        "env-1",
        "https://github.com/test/repo/pull/789",
        "open",
        true,
      );
      usePrMonitorStore.setState({
        states: new Map([["env-1", monitorState("env-1", { checkInProgress: true })]]),
      });
    });

    expect(result.current).toMatchObject({
      prUrl: "https://github.com/test/repo/pull/789",
      prState: "open",
      hasMergeConflicts: true,
      isDetecting: true,
    });
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

  test("viewPR reports browser rejection after fetching a missing URL", async () => {
    mockGetEnvironmentPrUrl.mockResolvedValueOnce("https://github.com/test/repo/pull/456");
    mockOpenInBrowser.mockRejectedValueOnce(new Error("browser unavailable"));
    useEnvironmentStore.setState({
      environments: [createMockEnvironment({ id: "env-1", prUrl: null })],
      isLoading: false,
      error: null,
    });
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    await act(async () => {
      await result.current.viewPR();
    });

    expect(result.current.error).toBe("browser unavailable");
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

  test("viewPR handles a rejected fallback URL lookup", async () => {
    mockGetEnvironmentPrUrl.mockRejectedValueOnce(new Error("backend unavailable"));
    useEnvironmentStore.setState({
      environments: [createMockEnvironment({ id: "env-1", prUrl: null })],
      isLoading: false,
      error: null,
    });
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    await act(async () => {
      await result.current.viewPR();
    });

    expect(result.current.error).toBe("No PR URL available");
    expect(mockOpenInBrowser).not.toHaveBeenCalled();
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

  test("viewPR clears a stale error after a later successful open", async () => {
    mockOpenInBrowser
      .mockRejectedValueOnce(new Error("browser unavailable"))
      .mockResolvedValueOnce(undefined);
    useEnvironmentStore.setState({
      environments: [createMockEnvironment({
        id: "env-1",
        prUrl: "https://github.com/test/repo/pull/123",
      })],
      isLoading: false,
      error: null,
    });
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    await act(async () => result.current.viewPR());
    expect(result.current.error).toBe("browser unavailable");
    await act(async () => result.current.viewPR());

    expect(result.current.error).toBeNull();
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

  test("resetPR preserves the snapshot and reports backend rejection", async () => {
    mockClearEnvironmentPr.mockRejectedValueOnce("backend offline");
    const env = createMockEnvironment({
      id: "env-1",
      prUrl: "https://github.com/test/repo/pull/123",
      prState: "open",
    });
    useEnvironmentStore.setState({ environments: [env], isLoading: false, error: null });
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    await act(async () => {
      await result.current.resetPR();
    });

    expect(result.current.error).toBe("Failed to reset PR");
    expect(result.current.prUrl).toBe(env.prUrl);
  });

  test("resetPR does nothing when no environmentId", async () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: null }));

    await act(async () => {
      await result.current.resetPR();
    });

    expect(mockClearEnvironmentPr).not.toHaveBeenCalled();
  });

  test("isDetecting mirrors the backend monitor's checkInProgress", () => {
    usePrMonitorStore.setState({
      states: new Map([["env-1", monitorState("env-1", { checkInProgress: true })]]),
    });

    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    expect(result.current.isDetecting).toBe(true);
  });

  test("isDetecting is false for an unmonitored environment", () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    expect(result.current.isDetecting).toBe(false);
  });

  test("setModeCreatePending requests backend create-pending monitoring", () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    act(() => {
      result.current.setModeCreatePending();
    });

    expect(mockPrMonitorWatch).toHaveBeenCalledWith("env-1", "create-pending");
  });

  test("setModeMergePending requests backend merge-pending monitoring", () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    act(() => {
      result.current.setModeMergePending();
    });

    expect(mockPrMonitorWatch).toHaveBeenCalledWith("env-1", "merge-pending");
  });

  test("arms the backend-owned post-completion PR refresh", async () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    let armedAt: string | null | undefined;
    await act(async () => {
      armedAt = await result.current.armRefreshAfterAgentCompletion();
    });

    expect(mockArmPrRefreshAfterAgentCompletion).toHaveBeenCalledWith("env-1");
    expect(armedAt).toBe("armed-at-1");
  });

  test("arm refresh is a null no-op without an environment", async () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: null }));

    let armedAt: string | null | undefined;
    await act(async () => {
      armedAt = await result.current.armRefreshAfterAgentCompletion();
    });

    expect(armedAt).toBeNull();
    expect(mockArmPrRefreshAfterAgentCompletion).not.toHaveBeenCalled();
  });

  test("arm refresh propagates backend rejection to its caller", async () => {
    mockArmPrRefreshAfterAgentCompletion.mockRejectedValueOnce(new Error("arm rejected"));
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    await expect(result.current.armRefreshAfterAgentCompletion()).rejects.toThrow("arm rejected");
  });

  test("disarms the exact backend-owned refresh token", async () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    await act(async () => {
      await result.current.disarmRefreshAfterAgentCompletion("armed-at-1");
    });

    expect(mockDisarmPrRefreshAfterAgentCompletion).toHaveBeenCalledWith(
      "env-1",
      "armed-at-1",
    );
  });

  test("disarm refresh is a no-op without an environment", async () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: null }));

    await act(async () => {
      await result.current.disarmRefreshAfterAgentCompletion("armed-at-1");
    });

    expect(mockDisarmPrRefreshAfterAgentCompletion).not.toHaveBeenCalled();
  });

  test("disarm refresh propagates backend rejection to its caller", async () => {
    mockDisarmPrRefreshAfterAgentCompletion.mockRejectedValueOnce(new Error("disarm rejected"));
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    await expect(result.current.disarmRefreshAfterAgentCompletion("armed-at-1"))
      .rejects.toThrow("disarm rejected");
  });

  test("a failed mode request is swallowed rather than thrown into the caller", async () => {
    mockPrMonitorWatch.mockImplementation(() => Promise.reject(new Error("backend offline")));
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    act(() => {
      result.current.setModeMergePending();
    });

    await waitFor(() => expect(mockPrMonitorWatch).toHaveBeenCalledTimes(1));
  });

  test("a failed create-pending request is contained by the hook", async () => {
    mockPrMonitorWatch.mockRejectedValueOnce(new Error("backend offline"));
    const { result } = renderHook(() => usePullRequest({ environmentId: "env-1" }));

    act(() => {
      result.current.setModeCreatePending();
    });

    await waitFor(() => expect(mockPrMonitorWatch).toHaveBeenCalledWith(
      "env-1",
      "create-pending",
    ));
  });

  test("setModeCreatePending does nothing when no environmentId", () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: null }));

    act(() => {
      result.current.setModeCreatePending();
    });

    expect(mockPrMonitorWatch).not.toHaveBeenCalled();
  });

  test("setModeMergePending does nothing when no environmentId", () => {
    const { result } = renderHook(() => usePullRequest({ environmentId: null }));

    act(() => {
      result.current.setModeMergePending();
    });

    expect(mockPrMonitorWatch).not.toHaveBeenCalled();
  });
});
