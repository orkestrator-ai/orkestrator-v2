import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { WorkspaceRealmHost } from "./WorkspaceRealmHost";

const originalOrkestrator = window.orkestrator;
const originalUI = useUIStore.getState();
const originalProjects = useProjectStore.getState();

afterEach(() => {
  cleanup();
  window.orkestrator = originalOrkestrator;
  useUIStore.setState(originalUI, true);
  useProjectStore.setState(originalProjects, true);
});

test("panel messages leave sidebar and selection untouched; only sidebar messages change its visibility", async () => {
  let deliver: (message: unknown) => void = () => undefined;
  window.orkestrator = {
    ...originalOrkestrator,
    workspaceRealm: {
      post: () => undefined,
      onMessage: (callback: (message: unknown) => void) => {
        deliver = callback;
        return () => {
          deliver = () => undefined;
        };
      },
    },
  } as typeof window.orkestrator;
  (nativeInvoke as ReturnType<typeof mock>).mockImplementation(async (command: string) => {
    if (command === "get_projects") return [];
    return undefined;
  });
  useProjectStore.setState({ projects: [], hasLoaded: true });
  useUIStore.setState({ sidebarOpen: true, selectedProjectId: null, selectedEnvironmentId: null });
  render(<WorkspaceRealmHost />);
  await waitFor(() => expect(useProjectStore.getState().isLoading).toBe(false));
  const selection = useUIStore.getState().projectSelectionRevision;
  for (const open of [false, true]) {
    act(() => deliver({ type: "panel", panel: "agent", open, inset: 6, seq: 1 }));
    expect(useUIStore.getState().sidebarOpen).toBe(true);
    expect(useUIStore.getState().projectSelectionRevision).toBe(selection);
  }
  act(() => deliver({ type: "sidebar", open: false }));
  expect(useUIStore.getState().sidebarOpen).toBe(false);
  act(() => deliver({ type: "panel", panel: "usage", open: true, inset: 6, seq: 2 }));
  expect(useUIStore.getState().sidebarOpen).toBe(false);
  expect(useUIStore.getState().projectSelectionRevision).toBe(selection);
});
