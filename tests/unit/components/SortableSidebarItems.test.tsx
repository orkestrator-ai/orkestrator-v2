import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Environment, Project } from "../../../apps/web/src/types";
import * as realSortable from "@dnd-kit/sortable";
import * as realEnvironmentItem from "@/components/environments/EnvironmentItem";

const realSortableSnapshot = { ...realSortable };
const realEnvironmentItemSnapshot = { ...realEnvironmentItem };
const sortableState = { isDragging: false, dragPointerDown: mock(() => {}) };

mock.module("@dnd-kit/sortable", () => ({
  ...realSortableSnapshot,
  SortableContext: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sortable-context">{children}</div>
  ),
  verticalListSortingStrategy: {},
  useSortable: mock(() => ({
    attributes: { "data-sortable-attributes": "true" },
    listeners: { onPointerDown: () => sortableState.dragPointerDown() },
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

const { SortableEnvironmentItem } =
  await import("../../../apps/web/src/components/sidebar/SortableEnvironmentItem");
const { SortableProjectGroup } =
  await import("../../../apps/web/src/components/sidebar/SortableProjectGroup");
const { SortableProjectFolder } =
  await import("../../../apps/web/src/components/sidebar/SortableProjectFolder");

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
    sortableState.dragPointerDown.mockClear();
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

  test("SortableEnvironmentItem activates dragging from the grip handle only", () => {
    const { container } = render(
      <SortableEnvironmentItem
        environment={environment}
        isSelected={false}
        onSelect={() => {}}
        onDelete={() => {}}
        onStart={() => {}}
        onStop={() => {}}
        onRestart={() => {}}
      />,
    );

    const grip = container.querySelector('button[data-sortable-attributes="true"]');
    expect(grip).not.toBeNull();

    fireEvent.pointerDown(grip!);
    expect(sortableState.dragPointerDown).toHaveBeenCalledTimes(1);

    // The row keeps its own controls (selection, and an actions button on
    // mobile), so drag activation must stay off the environment row itself.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Feature Env" }));
    expect(sortableState.dragPointerDown).toHaveBeenCalledTimes(1);
  });

  test("SortableProjectGroup renders project count, selected environment, and add action", () => {
    const onCreateEnvironment = mock(() => {});
    const onSelectProject = mock(() => {});

    render(
      <SortableProjectGroup
        project={project}
        environments={[environment]}
        isCollapsed={false}
        isSelected={false}
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
    const projectHeader = getProjectHeader(projectButton);
    expect(projectHeader.className).toContain("hover:bg-zinc-800/55");
    expect(screen.getByText("1").className).toContain("bg-zinc-800");
    expect(screen.getByTestId("sortable-context")).toBeTruthy();

    const addEnvironmentButton = screen.getByTitle("Create environment");
    expect(addEnvironmentButton.className).toContain("opacity-100");
    expect(addEnvironmentButton.className).toContain("md:opacity-0");
    expect(addEnvironmentButton.className).not.toContain("md:opacity-100");

    fireEvent.mouseEnter(projectHeader);
    expect(addEnvironmentButton.className).toContain("md:opacity-100");
    expect(addEnvironmentButton.className).not.toContain("md:opacity-0");

    fireEvent.mouseLeave(projectHeader);
    expect(addEnvironmentButton.className).toContain("md:opacity-0");
    expect(addEnvironmentButton.className).not.toContain("md:opacity-100");

    fireEvent.click(addEnvironmentButton);
    expect(onCreateEnvironment).toHaveBeenCalled();

    fireEvent.click(projectButton);
    expect(onSelectProject).toHaveBeenCalled();
  });

  test("SortableProjectGroup highlights the header only when isSelected is true", () => {
    const { rerender } = render(
      <SortableProjectGroup
        project={project}
        environments={[environment]}
        isCollapsed={false}
        isSelected={true}
        onToggleCollapse={() => {}}
        selectedEnvironmentId={null}
        onSelectProject={() => {}}
        onSelectEnvironment={() => {}}
        onDeleteProject={() => {}}
        onOpenSettings={() => {}}
        onDeleteEnvironment={() => {}}
        onStartEnvironment={() => {}}
        onStopEnvironment={() => {}}
        onRestartEnvironment={() => {}}
        onCreateEnvironment={() => {}}
      />,
    );

    let projectHeader = getProjectHeader(screen.getByRole("button", { name: /Project One/i }));
    expect(projectHeader.className).toContain("bg-zinc-800/85");
    expect(projectHeader.className).toContain("border-zinc-700/70");
    expect(projectHeader.className).not.toContain("border-transparent");

    rerender(
      <SortableProjectGroup
        project={project}
        environments={[environment]}
        isCollapsed={false}
        isSelected={false}
        onToggleCollapse={() => {}}
        selectedEnvironmentId={null}
        onSelectProject={() => {}}
        onSelectEnvironment={() => {}}
        onDeleteProject={() => {}}
        onOpenSettings={() => {}}
        onDeleteEnvironment={() => {}}
        onStartEnvironment={() => {}}
        onStopEnvironment={() => {}}
        onRestartEnvironment={() => {}}
        onCreateEnvironment={() => {}}
      />,
    );

    projectHeader = getProjectHeader(screen.getByRole("button", { name: /Project One/i }));
    expect(projectHeader.className).toContain("border-transparent");
    expect(projectHeader.className).toContain("hover:bg-zinc-800/55");
    expect(projectHeader.className).not.toContain("bg-zinc-800/85");
  });

  // The selectable project header is the nearest ancestor div carrying the
  // group/project marker class used for the selected/hover treatment.
  function getProjectHeader(projectButton: HTMLElement): HTMLElement {
    let node: HTMLElement | null = projectButton.parentElement;
    while (node && !node.className.includes("group/project")) {
      node = node.parentElement;
    }
    if (!node) {
      throw new Error("Could not locate project header element");
    }
    return node;
  }

  function renderProjectGroup(
    overrides: Partial<React.ComponentProps<typeof SortableProjectGroup>> = {},
  ) {
    return render(
      <SortableProjectGroup
        project={project}
        environments={[environment]}
        isCollapsed={false}
        isSelected={false}
        onToggleCollapse={() => {}}
        selectedEnvironmentId="env-1"
        onSelectProject={() => {}}
        onSelectEnvironment={() => {}}
        onDeleteProject={() => {}}
        onOpenSettings={() => {}}
        onDeleteEnvironment={() => {}}
        onStartEnvironment={() => {}}
        onStopEnvironment={() => {}}
        onRestartEnvironment={() => {}}
        onCreateEnvironment={() => {}}
        {...overrides}
      />,
    );
  }

  test("SortableProjectGroup shows the git url and local path in a hover tooltip", async () => {
    renderProjectGroup();

    const projectButton = screen.getByRole("button", { name: /Project One/i });
    fireEvent.mouseEnter(projectButton);

    // HoverTooltip opens after a delay and portals its content into document.body.
    await waitFor(() => {
      expect(screen.getByText("https://github.com/acme/project-one.git")).toBeTruthy();
    });
    expect(screen.getByText("/workspace/project-one")).toBeTruthy();
    expect(screen.getByText("Click to open board")).toBeTruthy();
  });

  test("SortableProjectGroup tooltip describes an empty project without a local path", async () => {
    renderProjectGroup({
      project: { ...project, localPath: null },
      environments: [],
      selectedEnvironmentId: null,
    });

    fireEvent.mouseEnter(screen.getByRole("button", { name: /Project One/i }));

    expect(await screen.findByText("0 environments")).toBeTruthy();
    expect(screen.queryByText("/workspace/project-one") === null).toBe(true);
    expect(screen.queryByText(/running/) === null).toBe(true);
  });

  test("SortableProjectGroup tooltip pluralizes totals and reports only running environments", async () => {
    const stoppedEnvironment: Environment = {
      ...environment,
      id: "env-2",
      name: "Stopped Env",
      status: "stopped",
      order: 1,
    };
    renderProjectGroup({ environments: [environment, stoppedEnvironment] });

    fireEvent.mouseEnter(screen.getByRole("button", { name: /Project One/i }));

    expect(await screen.findByText("2 environments (1 running)")).toBeTruthy();
  });

  test("SortableProjectGroup tooltip omits the running summary when every environment is stopped", async () => {
    const stoppedEnvironments: Environment[] = [
      { ...environment, id: "env-1", status: "stopped" },
      { ...environment, id: "env-2", name: "Stopped Env", status: "stopped", order: 1 },
    ];
    renderProjectGroup({ environments: stoppedEnvironments });

    fireEvent.mouseEnter(screen.getByRole("button", { name: /Project One/i }));

    expect(await screen.findByText("2 environments")).toBeTruthy();
    expect(screen.queryByText(/running/) === null).toBe(true);
  });

  test("SortableProjectGroup renders the collapse chevron rotated when expanded", () => {
    const { container } = renderProjectGroup({ isCollapsed: false });

    const chevron = container.querySelector("svg.lucide-chevron-right");
    expect(chevron).not.toBeNull();
    expect(chevron!.getAttribute("class")).toContain("rotate-90");
  });

  test("SortableProjectGroup chevron is not rotated when collapsed", () => {
    const { container } = renderProjectGroup({ isCollapsed: true });

    const chevron = container.querySelector("svg.lucide-chevron-right");
    expect(chevron).not.toBeNull();
    expect(chevron!.getAttribute("class")).not.toContain("rotate-90");
  });

  test("SortableProjectGroup toggles collapse when the chevron is clicked", () => {
    const onToggleCollapse = mock(() => {});
    const { container } = renderProjectGroup({ onToggleCollapse });

    const chevronButton = container.querySelector("svg.lucide-chevron-right")?.closest("button");
    expect(chevronButton).toBeTruthy();

    fireEvent.click(chevronButton!);
    expect(onToggleCollapse).toHaveBeenCalled();
  });

  test("SortableProjectGroup applies the dragging treatment to the project wrapper", () => {
    sortableState.isDragging = true;
    const { container } = renderProjectGroup();

    expect(container.firstElementChild?.className).toContain("opacity-50");
    expect(container.firstElementChild?.className).toContain("z-50");
  });

  test("SortableProjectGroup confirms project deletion and closes the dialog", async () => {
    const onDeleteProject = mock(() => {});
    renderProjectGroup({ onDeleteProject });

    fireEvent.contextMenu(screen.getByRole("button", { name: /Project One/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete Project" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Project One");
    expect(dialog.textContent).toContain("1 environment");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });

    expect(onDeleteProject).toHaveBeenCalledTimes(1);
    expect(onDeleteProject).toHaveBeenCalledWith("project-1");
    // confirmDelete awaits the deletion callback, so flush that continuation
    // with act. The controlled close state is owned by this component; Radix
    // may keep the hidden portal mounted while exit-presence settles.
    expect(dialog.getAttribute("data-state")).toBe("closed");
    expect(screen.queryByRole("alertdialog") === null).toBe(true);
    // Radix transitions for a menu followed by a modal can exceed Bun's default
    // ceiling when all root UI suites are sharing a saturated runner.
  }, 15_000);

  test("SortableProjectGroup keeps the delete confirmation open after deletion fails", async () => {
    const onDeleteProject = mock(async () => {
      throw new Error("delete failed");
    });
    renderProjectGroup({ onDeleteProject });

    fireEvent.contextMenu(screen.getByRole("button", { name: /Project One/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete Project" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(onDeleteProject).toHaveBeenCalledWith("project-1"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  test("SortableProjectGroup add action does not also trigger project selection", () => {
    const onCreateEnvironment = mock(() => {});
    const onSelectProject = mock(() => {});
    renderProjectGroup({ onCreateEnvironment, onSelectProject });

    fireEvent.click(screen.getByTitle("Create environment"));

    expect(onCreateEnvironment).toHaveBeenCalledTimes(1);
    // The add button stops propagation so it must not select the project too.
    expect(onSelectProject).not.toHaveBeenCalled();
  });

  function renderFolder(
    overrides: Partial<Parameters<typeof SortableProjectFolder>[0]> = {},
  ): ReturnType<typeof render> {
    return render(
      <SortableProjectFolder
        name="Work"
        projectCount={2}
        isCollapsed={false}
        onToggleCollapse={() => {}}
        onRename={() => {}}
        onUngroup={() => {}}
        {...overrides}
      >
        <div>Members</div>
      </SortableProjectFolder>,
    );
  }

  async function openRenameDialog(): Promise<HTMLElement> {
    fireEvent.contextMenu(screen.getByTitle("Collapse folder Work"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename Folder" }));
    return await screen.findByLabelText("Rename folder Work");
  }

  test("SortableProjectFolder ignores a rename submitted with a blank draft", async () => {
    const onRename = mock(() => {});
    renderFolder({ onRename });

    const input = await openRenameDialog();
    fireEvent.change(input, { target: { value: "   " } });
    // The submit button is disabled for a blank draft, so the reachable path is
    // the form's own submit — pressing Enter in the field.
    fireEvent.submit(input.closest("form")!);

    expect(onRename).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByLabelText("Rename folder Work") === null).toBe(true));
  });

  test("SortableProjectFolder ignores a rename to the name the folder already has", async () => {
    const onRename = mock(() => {});
    renderFolder({ onRename });

    const input = await openRenameDialog();
    // Surrounding whitespace is trimmed before the comparison, so this is the
    // same name rather than a new one.
    fireEvent.change(input, { target: { value: "  Work  " } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    expect(onRename).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByLabelText("Rename folder Work") === null).toBe(true));
  });

  test("SortableProjectFolder resets an abandoned rename draft when the dialog reopens", async () => {
    renderFolder();

    const input = await openRenameDialog();
    fireEvent.change(input, { target: { value: "Personal" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByLabelText("Rename folder Work") === null).toBe(true));

    // Without the resync the abandoned draft would still be there, so the next
    // rename would submit a name the user typed for a gesture they cancelled.
    const reopened = await openRenameDialog();
    expect((reopened as HTMLInputElement).value).toBe("Work");
  });

  test("SortableProjectFolder collapse controls report and toggle the folder state", () => {
    const onToggleCollapse = mock(() => {});
    const { rerender } = renderFolder({ isCollapsed: true, onToggleCollapse });

    const header = screen.getByTitle("Expand folder Work");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    // Members are unmounted rather than hidden: a registered sortable node the
    // user cannot see would still resolve drops.
    expect(document.querySelector('[data-project-folder-content="Work"]') === null).toBe(true);

    fireEvent.click(header);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Expand folder Work" }));
    expect(onToggleCollapse).toHaveBeenCalledTimes(2);

    rerender(
      <SortableProjectFolder
        name="Work"
        projectCount={2}
        isCollapsed={false}
        onToggleCollapse={onToggleCollapse}
        onRename={() => {}}
        onUngroup={() => {}}
      >
        <div>Members</div>
      </SortableProjectFolder>,
    );
    expect(screen.getByTitle("Collapse folder Work").getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[data-project-folder-content="Work"]')).not.toBeNull();
  });
});
