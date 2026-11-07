import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, waitFor } from "@testing-library/react";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import { uiStore } from "@/stores/uiStore";
import { useSidebarHydration } from "./useSidebarHydration";
import { appCommandStore } from "@/test/app-command-store";

const initial = appCommandStore(uiStore).getState();
afterEach(() => {
  cleanup();
  mock.restore();
  sessionStorage.clear();
  appCommandStore(uiStore).setState(initial, true);
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
  appCommandStore(uiStore).getState().setProjectCollapsed("explicit", false);
  const { result, rerender } = renderHookInAppCommandScope(
    ({ environments }) => useSidebarHydration(projects, true, environments, load),
    {
      initialProps: { environments: [] as { projectId: string }[] },
    },
  );
  expect(result.current).toBe(false);
  expect(appCommandStore(uiStore).getState().collapsedProjects).toEqual([]);
  rerender({ environments: [{ projectId: "populated" }] });
  await act(async () => pending.resolve());
  await waitFor(() => expect(result.current).toBe(true));
  expect(appCommandStore(uiStore).getState().collapsedProjects).toEqual(["empty"]);
});

test("new projects on a seeded client get defaults without resetting existing choices", async () => {
  const load = mock(async () => undefined);
  appCommandStore(uiStore).getState().setProjectCollapsed("old", false);
  const { rerender } = renderHookInAppCommandScope(
    ({ projects }) => useSidebarHydration(projects, true, [], load),
    {
      initialProps: { projects: [{ id: "old" }] },
    },
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  rerender({ projects: [{ id: "old" }, { id: "new" }] });
  await waitFor(() =>
    expect(appCommandStore(uiStore).getState().collapsedProjects).toEqual(["new"]),
  );
});

test("a project expanded by default collapses when empty on a later mount; an explicit expansion survives", async () => {
  const load = async () => undefined;
  const projects = [{ id: "default" }, { id: "explicit" }];
  const first = renderHookInAppCommandScope(() =>
    useSidebarHydration(
      projects,
      true,
      [{ projectId: "default" }, { projectId: "explicit" }],
      load,
    ),
  );
  await waitFor(() => expect(first.result.current).toBe(true));
  act(() => appCommandStore(uiStore).getState().setProjectCollapsed("explicit", false));
  first.unmount();
  renderHookInAppCommandScope(() => useSidebarHydration(projects, true, [], load));
  await waitFor(() =>
    expect(appCommandStore(uiStore).getState().collapsedProjects).toEqual(["default"]),
  );
});

test("project homes do not keep an otherwise empty project expanded", async () => {
  const load = async () => undefined;
  renderHookInAppCommandScope(() =>
    useSidebarHydration(
      [{ id: "home-only" }],
      true,
      [{ projectId: "home-only", projectHome: true }],
      load,
    ),
  );
  await waitFor(() =>
    expect(appCommandStore(uiStore).getState().collapsedProjects).toEqual(["home-only"]),
  );
});
