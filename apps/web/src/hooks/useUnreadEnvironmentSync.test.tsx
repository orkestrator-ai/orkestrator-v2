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
  useUIStore.setState({ selectedEnvironmentId: "env-1", projectBoardTab: "home" });
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

  test("restores the reason after a stale clear and silently clears again", async () => {
    useEnvironmentStore.setState({
      environments: [environment({ unreadReason: "agent_finished" })],
    });
    renderHook(() => useUnreadEnvironmentSync());
    expect(mockToast).toHaveBeenCalledTimes(1);
    const newerActivityAt = "2026-09-15T09:00:00.000Z";
    // A resource snapshot advances the activity token while the clear is in flight.
    act(() => {
      useEnvironmentStore.getState().updateEnvironment("env-1", {
        lastActivityAt: newerActivityAt,
      });
    });
    const restored: Environment[] = [];
    const unsubscribe = useEnvironmentStore.subscribe((state) => {
      const current = state.getEnvironmentById("env-1");
      if (current?.hasUnreadWork) restored.push({ ...current });
    });
    try {
      await act(async () => {
        persistResolvers[0]!(
          environment({
            hasUnreadWork: true,
            unreadReason: "agent_question",
            lastActivityAt: newerActivityAt,
          }),
        );
        await Promise.resolve();
      });
    } finally {
      unsubscribe();
    }

    expect(restored).toEqual([
      expect.objectContaining({ hasUnreadWork: true, unreadReason: "agent_question" }),
    ]);
    expect(setUnread).toHaveBeenCalledTimes(2);
    expect(setUnread).toHaveBeenLastCalledWith("env-1", false, newerActivityAt);
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")).toMatchObject({
      hasUnreadWork: false,
      unreadReason: undefined,
    });
    await act(async () => {
      persistResolvers[1]!(environment({ hasUnreadWork: false, lastActivityAt: newerActivityAt }));
      await Promise.resolve();
    });
    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.hasUnreadWork).toBe(false);
    expect(mockToast).toHaveBeenCalledTimes(1);
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

test("an obscured home toasts and clears unread work only when Home becomes visible", () => {
  useEnvironmentStore.setState({
    environments: [
      environment({ name: "project-home", projectHome: true, unreadReason: "agent_ready" }),
    ],
  });
  useUIStore.setState({ projectBoardTab: "kanban" });
  renderHook(() => useUnreadEnvironmentSync());
  expect(setUnread).not.toHaveBeenCalled();
  expect(mockToast).not.toHaveBeenCalled();
  expect(useEnvironmentStore.getState().environments[0]?.hasUnreadWork).toBe(true);
  act(() => useUIStore.getState().setProjectBoardTab("home"));
  expect(setUnread).toHaveBeenCalledTimes(1);
  expect(mockToast).toHaveBeenCalledTimes(1);
  expect(mockToast.mock.calls[0]?.[0]).toBe("Agent ready for input");
  expect(mockToast.mock.calls[0]?.[1]).toMatchObject({
    description: "Project home: You can send another message while background work continues.",
  });
});
