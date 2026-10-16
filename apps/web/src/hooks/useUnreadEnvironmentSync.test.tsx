import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as backend from "@/lib/backend";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useUIStore } from "@/stores/uiStore";
import type { Environment } from "@/types";
import { mockToast, resetSonnerMocks } from "../../../../tests/mocks/sonner";
import { useUnreadEnvironmentSync } from "./useUnreadEnvironmentSync";

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "Review",
    type: "local",
    status: "running",
    order: 0,
    hasUnreadWork: true,
    lastActivityAt: "2026-09-15T08:00:00.000Z",
    ...overrides,
  } as Environment;
}

let persistResolvers: Array<(value: Environment) => void>;
let setUnread: ReturnType<typeof spyOn>;

beforeEach(() => {
  persistResolvers = [];
  useEnvironmentStore.setState({ environments: [environment()] });
  useUIStore.setState({ selectedEnvironmentId: "env-1" });
  setUnread = spyOn(backend, "setEnvironmentUnread").mockImplementation(
    () =>
      new Promise<Environment>((resolve) => {
        persistResolvers.push(resolve);
      }),
  );
});

afterEach(() => {
  cleanup();
  resetSonnerMocks();
  setUnread.mockRestore();
  useEnvironmentStore.setState({ environments: [] });
  useUIStore.setState({ selectedEnvironmentId: null });
});

describe("useUnreadEnvironmentSync", () => {
  test("keeps a newer unread activity signal when the optimistic clear resolves late", async () => {
    const { unmount } = renderHook(() => useUnreadEnvironmentSync());
    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.hasUnreadWork).toBe(false);
    expect(setUnread).toHaveBeenCalledWith("env-1", false, "2026-09-15T08:00:00.000Z");

    unmount();
    act(() => {
      useEnvironmentStore.getState().updateEnvironment("env-1", {
        hasUnreadWork: true,
        lastActivityAt: "2026-09-15T09:00:00.000Z",
      });
    });
    await act(async () => {
      persistResolvers[0]!(
        environment({ hasUnreadWork: false, lastActivityAt: "2026-09-15T08:00:00.000Z" }),
      );
      await Promise.resolve();
    });

    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")).toMatchObject({
      hasUnreadWork: true,
      lastActivityAt: "2026-09-15T09:00:00.000Z",
    });
  });

  test("reconciles the badge from a current authoritative response", async () => {
    renderHook(() => useUnreadEnvironmentSync());
    await act(async () => {
      persistResolvers[0]!(environment({ hasUnreadWork: true }));
      await Promise.resolve();
    });

    expect(setUnread).toHaveBeenCalledTimes(2);
    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.hasUnreadWork).toBe(false);
    await act(async () => {
      persistResolvers[1]!(environment({ hasUnreadWork: false }));
      await Promise.resolve();
    });
    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.hasUnreadWork).toBe(false);
  });
});

describe("activation toast", () => {
  test("opening an environment with a bell shows why it rang", () => {
    useEnvironmentStore.setState({
      environments: [
        environment({ hasUnreadWork: false }),
        environment({ id: "env-2", name: "Fixes", unreadReason: "agent_waiting" }),
      ],
    });
    renderHook(() => useUnreadEnvironmentSync());
    expect(mockToast).not.toHaveBeenCalled();

    act(() => useUIStore.setState({ selectedEnvironmentId: "env-2" }));

    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast.mock.calls[0]?.[0]).toBe("Agent needs your input");
    expect(mockToast.mock.calls[0]?.[1]).toMatchObject({ id: "environment-unread:env-2" });
    expect(useEnvironmentStore.getState().getEnvironmentById("env-2")).toMatchObject({
      hasUnreadWork: false,
      unreadReason: undefined,
    });
  });

  test("work finishing in the environment already on screen clears without a toast", () => {
    useEnvironmentStore.setState({ environments: [environment({ hasUnreadWork: false })] });
    renderHook(() => useUnreadEnvironmentSync());

    act(() => {
      useEnvironmentStore.getState().updateEnvironment("env-1", {
        hasUnreadWork: true,
        unreadReason: "agent_finished",
        lastActivityAt: "2026-09-15T09:00:00.000Z",
      });
    });

    expect(setUnread).toHaveBeenCalledTimes(1);
    expect(mockToast).not.toHaveBeenCalled();
  });

  test("a selection restored before environments load still toasts once they arrive", () => {
    useEnvironmentStore.setState({ environments: [] });
    renderHook(() => useUnreadEnvironmentSync());

    act(() => {
      useEnvironmentStore.setState({
        environments: [environment({ unreadReason: "terminal_finished" })],
      });
    });

    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast.mock.calls[0]?.[0]).toBe("Terminal agent finished");
  });
});

test("an obscured home keeps unread work until Home is visible", () => {
  useEnvironmentStore.setState({ environments: [environment({ projectHome: true })] });
  useUIStore.setState({ projectBoardTab: "kanban" });
  renderHook(() => useUnreadEnvironmentSync());
  expect(setUnread).not.toHaveBeenCalled();
  expect(useEnvironmentStore.getState().environments[0]?.hasUnreadWork).toBe(true);
  act(() => useUIStore.getState().setProjectBoardTab("home"));
  expect(setUnread).toHaveBeenCalledTimes(1);
});
