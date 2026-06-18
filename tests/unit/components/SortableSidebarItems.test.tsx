import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Environment, Project } from "../../../src/types";
import * as realSortable from "@dnd-kit/sortable";
import * as realEnvironmentItem from "@/components/environments/EnvironmentItem";

const realSortableSnapshot = { ...realSortable };
const realEnvironmentItemSnapshot = { ...realEnvironmentItem };
const sortableState = { isDragging: false };

mock.module("@dnd-kit/sortable", () => ({
  ...realSortableSnapshot,
  SortableContext: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sortable-context">{children}</div>
  ),
  verticalListSortingStrategy: {},
  useSortable: mock(() => ({
    attributes: { "data-sortable-attributes": "true" },
    listeners: { onPointerDown: () => {} },
    setNodeRef: () => {},
    transform: null,
    transition: null,
    isDragging: sortableState.isDragging,
  })),
}));

mock.module("@/components/environments/EnvironmentItem", () => ({
  EnvironmentItem: ({
    environment,
    onSelect,
  }: {
    environment: Environment;
    onSelect: (environmentId: string) => void;
  }) => (
    <button type="button" onClick={() => onSelect(environment.id)}>
      {environment.name}
    </button>
  ),
}));

const { SortableEnvironmentItem } = await import("../../../src/components/sidebar/SortableEnvironmentItem");
const { SortableProjectGroup } = await import("../../../src/components/sidebar/SortableProjectGroup");

const project: Project = {
  id: "project-1",
  name: "Project One",
  gitUrl: "https://github.com/acme/project-one.git",
  localPath: "/workspace/project-one",
  addedAt: "2026-01-01T00:00:00.000Z",
  order: 0,
};

const environment: Environment = {
  id: "env-1",
  projectId: "project-1",
  name: "Feature Env",
  branch: "feature",
  containerId: "container-1",
  status: "running",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  networkAccessMode: "restricted",
  order: 0,
  environmentType: "containerized",
};

describe("sortable sidebar items", () => {
  afterEach(() => {
    cleanup();
    sortableState.isDragging = false;
  });

  afterAll(() => {
    mock.module("@dnd-kit/sortable", () => realSortableSnapshot);
    mock.module("@/components/environments/EnvironmentItem", () => realEnvironmentItemSnapshot);
  });

  test("SortableEnvironmentItem applies selected and dragging treatments", () => {
    sortableState.isDragging = true;

    const { container } = render(
      <SortableEnvironmentItem
        environment={environment}
        isSelected={true}
        onSelect={() => {}}
        onDelete={() => {}}
        onStart={() => {}}
        onStop={() => {}}
        onRestart={() => {}}
      />,
    );

    expect(container.firstElementChild?.className).toContain("opacity-50");
    const selectedRow = Array.from(container.querySelectorAll("div")).find((element) =>
      element.className.includes("bg-zinc-800/85"),
    ) as HTMLElement;
    expect(selectedRow.className).toContain("border-zinc-700/70");
    expect(screen.getByRole("button", { name: "Feature Env" })).toBeTruthy();
  });

  test("SortableProjectGroup renders project count, selected environment, and add action", () => {
    const onCreateEnvironment = mock(() => {});
    const onSelectProject = mock(() => {});

    render(
      <SortableProjectGroup
        project={project}
        environments={[environment]}
        isCollapsed={false}
        onToggleCollapse={() => {}}
        selectedEnvironmentId="env-1"
        onSelectProject={onSelectProject}
        onSelectEnvironment={() => {}}
        onDeleteProject={() => {}}
        onOpenSettings={() => {}}
        onDeleteEnvironment={() => {}}
        onStartEnvironment={() => {}}
        onStopEnvironment={() => {}}
        onRestartEnvironment={() => {}}
        onCreateEnvironment={onCreateEnvironment}
      />,
    );

    const projectButton = screen.getByRole("button", { name: /Project One/i });
    expect(projectButton.className).toContain("hover:bg-zinc-800/80");
    expect(screen.getByText("1").className).toContain("bg-zinc-800");
    expect(screen.getByTestId("sortable-context")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Create environment"));
    expect(onCreateEnvironment).toHaveBeenCalled();

    fireEvent.click(projectButton);
    expect(onSelectProject).toHaveBeenCalled();
  });
});
