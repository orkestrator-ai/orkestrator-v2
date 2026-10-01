import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { SortableProjectGroup } from "./SortableProjectGroup";
import type { Environment, Project } from "@/types";

afterEach(cleanup);
const environment = (id: string, projectHome = false) =>
  ({
    id,
    projectId: "project-1",
    name: id,
    projectHome,
    branch: "feature/x",
    status: "running",
    environmentType: "local",
    order: 0,
    networkAccessMode: "full",
    createdAt: "2026-10-01T00:00:00Z",
  }) as Environment;

test("the home stays first and cannot be dragged when regular environment order changes", () => {
  const props = {
    project: { id: "project-1", name: "Project", gitUrl: "https://github.com/org/repo" } as Project,
    isCollapsed: false,
    isSelected: false,
    selectedEnvironmentId: null,
    onToggleCollapse: () => {},
    onSelectProject: () => {},
    onSelectEnvironment: () => {},
    onDeleteProject: () => {},
    onOpenSettings: () => {},
    onDeleteEnvironment: () => {},
    onStartEnvironment: () => {},
    onStopEnvironment: () => {},
    onRestartEnvironment: () => {},
    onCreateEnvironment: () => {},
  };
  const view = render(
    <DndContext>
      <SortableProjectGroup
        {...props}
        environments={[environment("worker-a"), environment("home", true), environment("worker-b")]}
      />
    </DndContext>,
  );
  const order = () =>
    screen
      .getAllByRole("button")
      .filter((button) =>
        ["home", "worker-a", "worker-b"].includes(button.textContent?.trim() ?? ""),
      )
      .map((button) => button.textContent?.trim());
  expect(order()).toEqual(["home", "worker-a", "worker-b"]);
  expect(
    screen
      .getAllByRole("button", { name: "" })
      .filter((button) => button.getAttribute("aria-roledescription") === "sortable"),
  ).toHaveLength(2);
  view.rerender(
    <DndContext>
      <SortableProjectGroup
        {...props}
        environments={[environment("worker-b"), environment("worker-a"), environment("home", true)]}
      />
    </DndContext>,
  );
  expect(order()).toEqual(["home", "worker-b", "worker-a"]);
});
