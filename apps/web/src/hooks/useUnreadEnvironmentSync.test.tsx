import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as backend from "@/lib/backend";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useUIStore } from "@/stores/uiStore";
import type { Environment } from "@/types";
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
