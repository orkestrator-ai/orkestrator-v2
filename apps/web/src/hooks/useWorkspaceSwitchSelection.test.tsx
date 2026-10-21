import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useUIStore } from "@/stores/uiStore";
import type { Environment } from "@/types";
import { useWorkspaceSwitchSelection } from "./useWorkspaceSwitchSelection";

const INTENT_KEY = "orkestrator.workspace-switch-intent";

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "leaf-env",
    projectId: "leaf-app",
    name: "leaf-env",
    environmentType: "local",
    status: "stopped",
    order: 0,
    ...overrides,
  } as Environment;
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  useEnvironmentStore.setState({ environments: [] });
  useUIStore.setState({
    selectedProjectId: null,
    selectedEnvironmentId: null,
    collapsedProjects: [],
  });
});

describe("after the window moved to another node", () => {
  test("selects the clicked environment once it is loaded, as the sidebar would", () => {
    sessionStorage.setItem(
      INTENT_KEY,
      JSON.stringify({ projectId: "leaf-app", environmentId: "leaf-env" }),
    );
    useUIStore.setState({ collapsedProjects: ["leaf-app"] });
    const start = mock(async (_id: string) => undefined);
    renderHook(() => useWorkspaceSwitchSelection(start));
    expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
    // The intent is taken at once, so a later reload does not reapply it.
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();

    act(() => useEnvironmentStore.setState({ environments: [environment()] }));
    const ui = useUIStore.getState();
    expect(ui.selectedProjectId).toBe("leaf-app");
    expect(ui.selectedEnvironmentId).toBe("leaf-env");
    expect(ui.collapsedProjects).not.toContain("leaf-app");
    expect(start).toHaveBeenCalledWith("leaf-env");
  });

  test("an environment with a worktree is selected without starting it", () => {
    sessionStorage.setItem(
      INTENT_KEY,
      JSON.stringify({ projectId: "leaf-app", environmentId: "leaf-env" }),
    );
    useEnvironmentStore.setState({
      environments: [environment({ worktreePath: "/srv/leaf-env", status: "running" })],
    });
    const start = mock(async (_id: string) => undefined);
    renderHook(() => useWorkspaceSwitchSelection(start));
    expect(useUIStore.getState().selectedEnvironmentId).toBe("leaf-env");
    expect(start).not.toHaveBeenCalled();
  });

  test("without a switch nothing is selected", () => {
    useEnvironmentStore.setState({ environments: [environment()] });
    const start = mock(async (_id: string) => undefined);
    renderHook(() => useWorkspaceSwitchSelection(start));
    expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });
});
