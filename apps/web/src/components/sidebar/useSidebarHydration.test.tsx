import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { useUIStore } from "@/stores/uiStore";
import { useSidebarHydration, useSidebarScrollRestore } from "./useSidebarHydration";

const initial = useUIStore.getState();
afterEach(() => {
  cleanup();
  mock.restore();
  sessionStorage.clear();
  useUIStore.setState(initial, true);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("waits for environment results, defaults empty projects only, and respects explicit choices", async () => {
  const pending = deferred();
  const load = mock(() => pending.promise);
  const projects = [{ id: "empty" }, { id: "populated" }, { id: "explicit" }];
  useUIStore.getState().setProjectCollapsed("explicit", false);
  const { result, rerender } = renderHook(
    ({ environments }) => useSidebarHydration(projects, true, environments, load),
    {
      initialProps: { environments: [] as { projectId: string }[] },
    },
  );
  expect(result.current).toBe(false);
  expect(useUIStore.getState().collapsedProjects).toEqual([]);
  rerender({ environments: [{ projectId: "populated" }] });
  await act(async () => pending.resolve());
  await waitFor(() => expect(result.current).toBe(true));
  expect(useUIStore.getState().collapsedProjects).toEqual(["empty"]);
});

test("new projects on a seeded client get defaults without resetting existing choices", async () => {
  const load = mock(async () => undefined);
  useUIStore.getState().setProjectCollapsed("old", false);
  const { rerender } = renderHook(({ projects }) => useSidebarHydration(projects, true, [], load), {
    initialProps: { projects: [{ id: "old" }] },
  });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  rerender({ projects: [{ id: "old" }, { id: "new" }] });
  await waitFor(() => expect(useUIStore.getState().collapsedProjects).toEqual(["new"]));
});

test("saved scroll is restored once after delayed rows and layout hydrate", async () => {
  sessionStorage.setItem("orkestrator.workspace-switch-sidebar-scroll", "700");
  const element = document.createElement("div");
  let height = 100;
  let top = 0;
  Object.defineProperty(element, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      top = Math.min(value, height);
    },
  });
  let frame: FrameRequestCallback | undefined;
  spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    frame = callback;
    return 1;
  });
  spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {
    frame = undefined;
  });
  const { rerender } = renderHook(
    ({ ready }) => {
      const ref = useRef(element);
      useSidebarScrollRestore(ref, ready);
    },
    { initialProps: { ready: false } },
  );
  expect(frame).toBeUndefined();
  expect(top).toBe(0);
  height = 1000;
  rerender({ ready: true });
  act(() => frame?.(0));
  expect(top).toBe(700);
  top = 50;
  rerender({ ready: false });
  rerender({ ready: true });
  expect(top).toBe(50);
});

test("a project expanded by default collapses when empty on a later mount; an explicit expansion survives", async () => {
  const load = async () => undefined;
  const projects = [{ id: "default" }, { id: "explicit" }];
  const first = renderHook(() =>
    useSidebarHydration(
      projects,
      true,
      [{ projectId: "default" }, { projectId: "explicit" }],
      load,
    ),
  );
  await waitFor(() => expect(first.result.current).toBe(true));
  act(() => useUIStore.getState().setProjectCollapsed("explicit", false));
  first.unmount();
  renderHook(() => useSidebarHydration(projects, true, [], load));
  await waitFor(() => expect(useUIStore.getState().collapsedProjects).toEqual(["default"]));
});

test("project homes do not keep an otherwise empty project expanded", async () => {
  const load = async () => undefined;
  renderHook(() =>
    useSidebarHydration(
      [{ id: "home-only" }],
      true,
      [{ projectId: "home-only", projectHome: true }],
      load,
    ),
  );
  await waitFor(() => expect(useUIStore.getState().collapsedProjects).toEqual(["home-only"]));
});
