import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { COORDINATOR_ACTIVITY_COMMAND } from "@orkestrator/protocol/coordinator-activity";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { coordinatorActivityStore } from "@/stores/coordinatorActivityStore";
import { uiStore } from "@/stores/uiStore";
import type { Environment, Project } from "@/types";
import { MachineHomeIcon } from "@/components/federation/MachineDot";
import { SortableProjectGroup } from "./SortableProjectGroup";
import { appCommandStore } from "@/test/app-command-store";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

afterEach(() => {
  cleanup();
  appCommandStore(coordinatorActivityStore).getState().reset();
  invokeMock.mockReset();
});

test("project header highlights Home selection, counts worker rows, and opens the board", () => {
  const project = { id: "project", name: "Checkout", gitUrl: "", order: 0 } as Project;
  const home = {
    id: "home",
    projectId: project.id,
    projectHome: true,
    hasUnreadWork: true,
  } as Environment;
  appCommandStore(uiStore).setState({
    selectedProjectId: project.id,
    selectedEnvironmentId: home.id,
    projectBoardTab: "home",
  });
  const noop = mock(() => {});
  const view = renderInAppCommandScope(
    <SortableProjectGroup
      project={project}
      home={home}
      environments={[]}
      isCollapsed
      isSelected
      selectedEnvironmentId={home.id}
      onToggleCollapse={noop}
      onSelectProject={() => appCommandStore(uiStore).getState().selectProject(project.id)}
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
  // The chevron sits last even without a machine icon, as on folder headings.
  const expand = screen.getByRole("button", { name: "Expand project Checkout" });
  expect(expand.parentElement!.lastElementChild === expand).toBe(true);
  expect(screen.getByRole("button", { name: "Checkout Home needs attention" })).toBeTruthy();
  expect(screen.queryByText("project-home") === null).toBe(true);
  fireEvent.click(row);
  expect(appCommandStore(uiStore).getState().projectBoardTab).toBe("coordinator");
  appCommandStore(uiStore).setState({ projectBoardTab: "home" });
  fireEvent.contextMenu(row);
  fireEvent.click(screen.getByText("Open Board"));
  expect(appCommandStore(uiStore).getState().projectBoardTab).toBe("coordinator");
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
    const view = renderInAppCommandScope(<SortableProjectGroup {...props} isCollapsed={false} />);
    const row = screen.getByRole("button", { name: label });
    const icon = within(row).getByTestId("machine-home-icon");
    // The home leads the row inside the coordinator's activity ring, idle here.
    const ring = within(row).getByTestId("coordinator-activity-icon");
    expect(row.firstElementChild === ring).toBe(true);
    expect(ring.contains(icon)).toBe(true);
    expect(ring.getAttribute("data-state")).toBe("idle");
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

test("a working coordinator rings the project's icon, and shows its own icon when the project has none", async () => {
  const project = { id: "project", name: "Checkout", gitUrl: "", order: 0 } as Project;
  let activity: Record<string, string> = { project: "working" };
  invokeMock.mockImplementation(async (command: string) =>
    command === COORDINATOR_ACTIVITY_COMMAND ? { projects: activity } : undefined,
  );
  const noop = () => {};
  const props = {
    project,
    environments: [],
    isCollapsed: true,
    isSelected: false,
    selectedEnvironmentId: null,
    onToggleCollapse: noop,
    onSelectProject: noop,
    onSelectEnvironment: noop,
    onDeleteProject: noop,
    onOpenSettings: noop,
    onDeleteEnvironment: noop,
    onStartEnvironment: noop,
    onStopEnvironment: noop,
    onRestartEnvironment: noop,
    onCreateEnvironment: noop,
  };
  const view = renderInAppCommandScope(<SortableProjectGroup {...props} />);
  // The state is a description, so the row keeps its name.
  const row = screen.getByRole("button", { name: "Checkout" });
  await waitFor(() =>
    expect(within(row).getByTestId("coordinator-activity-icon").getAttribute("data-state")).toBe(
      "working",
    ),
  );
  expect(
    within(row)
      .getByTestId("coordinator-activity-ring")
      .className.includes("environment-working-spinner"),
  ).toBe(true);
  // The row keeps its icon ring; only the toolbar tab circles itself.
  expect(within(row).queryByTestId("coordinator-working-outline") === null).toBe(true);
  const description = row.getAttribute("aria-describedby")!.split(" ").at(-1)!;
  expect(document.getElementById(description)?.textContent).toBe("Coordinator working");

  view.rerender(
    <SortableProjectGroup
      {...props}
      machineIcon={<MachineHomeIcon colorToken="violet" machineName="This computer" />}
    />,
  );
  const ring = within(row).getByTestId("coordinator-activity-icon");
  expect(ring.contains(within(row).getByTestId("machine-home-icon"))).toBe(true);

  // Idle again: a project without an icon of its own shows nothing.
  activity = {};
  view.rerender(<SortableProjectGroup {...props} />);
  await act(() => appCommandStore(coordinatorActivityStore).getState().refresh());
  await waitFor(() =>
    expect(within(row).queryByTestId("coordinator-activity-icon") === null).toBe(true),
  );
  expect(row.getAttribute("aria-describedby")?.includes(description) ?? false).toBe(false);
});

test("a waiting coordinator's halo stays on the project's icon", async () => {
  const project = { id: "project", name: "Checkout", gitUrl: "", order: 0 } as Project;
  invokeMock.mockImplementation(async (command: string) =>
    command === COORDINATOR_ACTIVITY_COMMAND ? { projects: { project: "waiting" } } : undefined,
  );
  const noop = () => {};
  renderInAppCommandScope(
    <SortableProjectGroup
      project={project}
      environments={[]}
      isCollapsed
      isSelected={false}
      selectedEnvironmentId={null}
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
  const row = screen.getByRole("button", { name: "Checkout" });
  await waitFor(() =>
    expect(within(row).getByTestId("coordinator-activity-icon").getAttribute("data-state")).toBe(
      "waiting",
    ),
  );
  expect(within(row).getByTestId("coordinator-activity-ring").className).toContain("animate-pulse");
  expect(within(row).queryByTestId("coordinator-working-outline") === null).toBe(true);
});
