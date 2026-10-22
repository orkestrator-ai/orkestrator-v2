import { afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { projectKey, projectRef, type BackendId } from "@orkestrator/protocol/federation";
import { sidebarFolderKey, useMachineViewStore } from "@/stores/machineViewStore";
import { useUIStore } from "@/stores/uiStore";
import type { Project } from "@/types";
import { useBoundCollapseSync } from "./useBoundCollapseSync";

const initialUI = useUIStore.getState();
const initialView = useMachineViewStore.getState();
const machine = "bk_leaf" as BackendId;
const key = (id: string) => projectKey(projectRef(machine, id));
const projects = [{ id: "p", folder: "Work" }] as Project[];
afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  useMachineViewStore.setState(initialView, true);
});

test("does not adopt or record before projects have actually loaded", () => {
  useMachineViewStore.getState().setProjectKeyCollapsed(key("p"), true);
  const { rerender } = renderHook(
    ({ items, loaded }) => useBoundCollapseSync(machine, items, loaded),
    {
      initialProps: { items: [] as Project[], loaded: false },
    },
  );
  expect(useMachineViewStore.getState().seededMachines).not.toContain(machine);
  rerender({ items: projects, loaded: true });
  expect(useUIStore.getState().collapsedProjects).toContain("p");
  expect(useMachineViewStore.getState().collapsedProjectKeys).toContain(key("p"));
});

test("first binding adopts remote collapsed and explicitly expanded choices and folders", () => {
  const view = useMachineViewStore.getState();
  view.setProjectKeyCollapsed(key("p"), true);
  view.setProjectKeyCollapsed(key("expanded"), false);
  view.setFolderKeyCollapsed(sidebarFolderKey(machine, "work"), true);
  useUIStore.setState({ collapsedProjects: ["expanded"] });
  renderHook(() =>
    useBoundCollapseSync(machine, [...projects, { id: "expanded" } as Project], true),
  );
  expect(useUIStore.getState().collapsedProjects).toEqual(["p"]);
  expect(useUIStore.getState().collapsedProjectFolders).toEqual(["work"]);
});

test("projects appearing later adopt once and bound edits remain recorded", () => {
  useMachineViewStore.getState().setProjectKeyCollapsed(key("p"), true);
  const { rerender } = renderHook(({ items }) => useBoundCollapseSync(machine, items, true), {
    initialProps: { items: [] as Project[] },
  });
  rerender({ items: projects });
  act(() => useUIStore.getState().setProjectCollapsed("p", false));
  rerender({ items: [...projects] });
  expect(useUIStore.getState().collapsedProjects).not.toContain("p");
  expect(useMachineViewStore.getState().collapsedProjectKeys).not.toContain(key("p"));
});

test("remount preserves choices and leaves new empty projects eligible for defaults", () => {
  const first = renderHook(() => useBoundCollapseSync(machine, projects, true));
  act(() => useUIStore.getState().setProjectCollapsed("p", false));
  first.unmount();
  renderHook(() => useBoundCollapseSync(machine, [...projects, { id: "new" } as Project], true));
  act(() => useUIStore.getState().collapseEmptyProjects(["p", "new"], new Set()));
  expect(useUIStore.getState().collapsedProjects).toEqual(["new"]);
  expect(useMachineViewStore.getState().collapsedProjectKeys).toContain(key("new"));
});

test("returning to a prior binding adopts its choices rather than the machine just left", () => {
  const other = "bk_other" as BackendId;
  const view = useMachineViewStore.getState();
  view.setProjectKeyCollapsed(key("p"), true);
  view.setProjectKeyCollapsed(projectKey(projectRef(other, "p")), false);
  const { rerender } = renderHook(({ backend }) => useBoundCollapseSync(backend, projects, true), {
    initialProps: { backend: machine },
  });
  expect(useUIStore.getState().collapsedProjects).toContain("p");
  rerender({ backend: other });
  expect(useUIStore.getState().collapsedProjects).not.toContain("p");
  act(() => useUIStore.getState().setProjectFolderCollapsed("Work", true));
  rerender({ backend: machine });
  expect(useUIStore.getState().collapsedProjects).toContain("p");
  expect(useUIStore.getState().collapsedProjectFolders).not.toContain("Work");
});
