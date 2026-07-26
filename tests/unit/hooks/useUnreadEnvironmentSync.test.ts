import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useUnreadEnvironmentSync } from "@/hooks/useUnreadEnvironmentSync";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useUIStore } from "@/stores/uiStore";
import * as backend from "@/lib/backend";
import type { Environment } from "@/types";

const setEnvironmentUnreadMock = mock<typeof backend.setEnvironmentUnread>(
  async (_environmentId: string, _unread: boolean) => ({} as Environment),
);

mock.module("@/lib/backend", () => ({
  ...backend,
  setEnvironmentUnread: setEnvironmentUnreadMock,
}));

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "env",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    ...overrides,
  };
}

beforeEach(() => {
  setEnvironmentUnreadMock.mockClear();
  useEnvironmentStore.setState({ environments: [], isLoading: false, error: null });
  useUIStore.setState({ selectedEnvironmentId: null });
});

afterEach(() => {
  useUIStore.setState({ selectedEnvironmentId: null });
});

describe("useUnreadEnvironmentSync", () => {
  test("clears the badge in the backend when the unread environment is opened", async () => {
    useEnvironmentStore.setState({ environments: [environment({ hasUnreadWork: true })] });
    useUIStore.setState({ selectedEnvironmentId: "env-1" });

    await act(async () => {
      renderHook(() => useUnreadEnvironmentSync());
    });

    expect(setEnvironmentUnreadMock).toHaveBeenCalledWith("env-1", false);
    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.hasUnreadWork)
      .toBe(false);
  });

  test("does nothing for an environment that is already read", async () => {
    useEnvironmentStore.setState({ environments: [environment({ hasUnreadWork: false })] });
    useUIStore.setState({ selectedEnvironmentId: "env-1" });

    await act(async () => {
      renderHook(() => useUnreadEnvironmentSync());
    });

    expect(setEnvironmentUnreadMock).not.toHaveBeenCalled();
  });

  test("does not clear an unread environment that is not the selected one", async () => {
    useEnvironmentStore.setState({
      environments: [
        environment({ id: "env-1", hasUnreadWork: false }),
        environment({ id: "env-2", hasUnreadWork: true }),
      ],
    });
    useUIStore.setState({ selectedEnvironmentId: "env-1" });

    await act(async () => {
      renderHook(() => useUnreadEnvironmentSync());
    });

    expect(setEnvironmentUnreadMock).not.toHaveBeenCalled();
    expect(useEnvironmentStore.getState().getEnvironmentById("env-2")?.hasUnreadWork)
      .toBe(true);
  });

  test("clears again when the selection moves to another unread environment", async () => {
    useEnvironmentStore.setState({
      environments: [
        environment({ id: "env-1", hasUnreadWork: true }),
        environment({ id: "env-2", hasUnreadWork: true }),
      ],
    });
    useUIStore.setState({ selectedEnvironmentId: "env-1" });

    await act(async () => {
      renderHook(() => useUnreadEnvironmentSync());
    });
    await act(async () => {
      useUIStore.setState({ selectedEnvironmentId: "env-2" });
    });

    expect(setEnvironmentUnreadMock.mock.calls.map(([id]) => id)).toEqual(["env-1", "env-2"]);
  });

  test("clears an environment that becomes unread while it is already open", async () => {
    useEnvironmentStore.setState({ environments: [environment({ hasUnreadWork: false })] });
    useUIStore.setState({ selectedEnvironmentId: "env-1" });

    await act(async () => {
      renderHook(() => useUnreadEnvironmentSync());
    });
    expect(setEnvironmentUnreadMock).not.toHaveBeenCalled();

    // Another client marked it unread; this one is looking at it, so it is read.
    await act(async () => {
      useEnvironmentStore.getState().updateEnvironment("env-1", { hasUnreadWork: true });
    });

    expect(setEnvironmentUnreadMock).toHaveBeenCalledWith("env-1", false);
  });

  test("does nothing when no environment is selected", async () => {
    useEnvironmentStore.setState({ environments: [environment({ hasUnreadWork: true })] });

    await act(async () => {
      renderHook(() => useUnreadEnvironmentSync());
    });

    expect(setEnvironmentUnreadMock).not.toHaveBeenCalled();
  });

  test("keeps the optimistic clear when the backend write fails", async () => {
    setEnvironmentUnreadMock.mockImplementationOnce(async () => {
      throw new Error("gateway is down");
    });
    useEnvironmentStore.setState({ environments: [environment({ hasUnreadWork: true })] });
    useUIStore.setState({ selectedEnvironmentId: "env-1" });

    await act(async () => {
      renderHook(() => useUnreadEnvironmentSync());
      await Promise.resolve();
    });

    // The badge must not flicker back on for the client that is looking at it.
    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.hasUnreadWork)
      .toBe(false);
  });
});
