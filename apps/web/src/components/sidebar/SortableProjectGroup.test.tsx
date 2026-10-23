import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useUIStore } from "@/stores/uiStore";
import type { Environment, Project } from "@/types";
import { MachineHomeIcon } from "@/components/federation/MachineDot";
import { SortableProjectGroup } from "./SortableProjectGroup";

afterEach(cleanup);

test("project header highlights Home selection, counts worker rows, and opens the board", () => {
  const project = { id: "project", name: "Checkout", gitUrl: "", order: 0 } as Project;
  const home = {
    id: "home",
    projectId: project.id,
    projectHome: true,
    hasUnreadWork: true,
  } as Environment;
  useUIStore.setState({
    selectedProjectId: project.id,
    selectedEnvironmentId: home.id,
    projectBoardTab: "home",
  });
  const noop = mock(() => {});
  const view = render(
    <SortableProjectGroup
      project={project}
      home={home}
      environments={[]}
      isCollapsed
      isSelected
      selectedEnvironmentId={home.id}
      onToggleCollapse={noop}
      onSelectProject={() => useUIStore.getState().selectProject(project.id)}
      onSelectEnvironment={noop}
      onDeleteProject={noop}
      onOpenSettings={noop}
      onDeleteEnvironment={noop}
      onStartEnvironment={noop}
      onStopEnvironment={noop}
      onRestartEnvironment={noop}
      onCreateEnvironment={noop}
    />,
  );
  const row = screen.getByRole("button", { name: "Checkout" });
  expect(row.getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", { name: "Checkout Home needs attention" })).toBeTruthy();
  expect(screen.queryByText("project-home") === null).toBe(true);
  fireEvent.click(row);
  expect(useUIStore.getState().projectBoardTab).toBe("coordinator");
  useUIStore.setState({ projectBoardTab: "home" });
  fireEvent.contextMenu(row);
  fireEvent.click(screen.getByText("Open Board"));
  expect(useUIStore.getState().projectBoardTab).toBe("coordinator");
  view.rerender(
    <SortableProjectGroup
      project={project}
      environments={[{ id: "worker", status: "running" } as Environment]}
      isCollapsed
      isSelected={false}
      selectedEnvironmentId="worker"
      onToggleCollapse={noop}
      onSelectProject={noop}
      onSelectEnvironment={noop}
      onDeleteProject={noop}
      onOpenSettings={noop}
      onDeleteEnvironment={noop}
      onStartEnvironment={noop}
      onStopEnvironment={noop}
      onRestartEnvironment={noop}
      onCreateEnvironment={noop}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Checkout 1" }).getAttribute("aria-current"),
  ).toBeNull();
});

test.each(["This computer", "This computer · Checkout"])(
  "repository member %s leads with a home icon and collapses independently of selection",
  (label) => {
    const project = { id: "project", name: "Checkout", gitUrl: "", order: 0 } as Project;
    const onSelectProject = mock(() => {});
    const onToggleCollapse = mock(() => {});
    const noop = () => {};
    const props = {
      project,
      label,
      machineIcon: <MachineHomeIcon colorToken="violet" machineName="This computer" />,
      environments: [],
      isSelected: true,
      selectedEnvironmentId: null,
      onToggleCollapse,
      onSelectProject,
      onSelectEnvironment: noop,
      onDeleteProject: noop,
      onOpenSettings: noop,
      onDeleteEnvironment: noop,
      onStartEnvironment: noop,
      onStopEnvironment: noop,
      onRestartEnvironment: noop,
      onCreateEnvironment: noop,
    };
    const view = render(<SortableProjectGroup {...props} isCollapsed={false} />);
    const row = screen.getByRole("button", { name: label });
    const icon = within(row).getByTestId("machine-home-icon");
    expect(row.firstElementChild === icon).toBe(true);
    expect(icon.getAttribute("data-machine-color")).toBe("violet");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    const collapse = screen.getByRole("button", { name: "Collapse project Checkout" });
    expect(collapse.parentElement!.contains(row)).toBe(true);
    expect(collapse.parentElement!.lastElementChild === collapse).toBe(true);
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(collapse);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    expect(onSelectProject).not.toHaveBeenCalled();
    view.rerender(<SortableProjectGroup {...props} isCollapsed />);
    expect(
      screen.getByRole("button", { name: "Expand project Checkout" }).getAttribute("aria-expanded"),
    ).toBe("false");
    fireEvent.click(row);
    expect(onSelectProject).toHaveBeenCalledTimes(1);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    expect(row.getAttribute("aria-current")).toBe("page");
  },
);
