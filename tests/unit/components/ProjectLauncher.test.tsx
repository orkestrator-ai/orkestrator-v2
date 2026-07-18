import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as realUseProjects from "@/hooks/useProjects";
import * as realCreateEnvironmentFlow from "@/components/environments/CreateEnvironmentFlowDialog";
import { useUIStore } from "@/stores/uiStore";
import type { CreateEnvironmentFlowOperations } from "@/components/environments/CreateEnvironmentFlowDialog";
import type { Project } from "@/types";

const realUseProjectsSnapshot = { ...realUseProjects };
const realCreateEnvironmentFlowSnapshot = { ...realCreateEnvironmentFlow };
let projectsValue: Project[] = [];
let isLoadingValue = false;
let flowProps: (CreateEnvironmentFlowOperations & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
}) | null = null;

mock.module("@/hooks/useProjects", () => ({
  useProjects: () => ({ projects: projectsValue, isLoading: isLoadingValue }),
}));

mock.module("@/components/environments/CreateEnvironmentFlowDialog", () => ({
  CreateEnvironmentFlowDialog: (
    props: CreateEnvironmentFlowOperations & {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      projectId: string | null;
    },
  ) => {
    flowProps = props;
    return props.open ? (
      <button type="button" onClick={() => props.onOpenChange(false)}>
        Close create flow
      </button>
    ) : null;
  },
}));

import {
  ProjectLauncher,
  ProjectLauncherContent,
  resolveRecentProjects,
} from "@/components/projects/ProjectLauncher";

function makeProject(index: number, addedAt = `2026-07-${String(index).padStart(2, "0")}T00:00:00.000Z`): Project {
  return {
    id: `project-${index}`,
    name: `Project ${index}`,
    gitUrl: `https://github.com/acme/project-${index}.git`,
    localPath: index === 1 ? `/work/project-${index}` : null,
    addedAt,
    order: index,
  };
}

beforeEach(() => {
  projectsValue = [];
  isLoadingValue = false;
  flowProps = null;
  useUIStore.setState({
    selectedProjectId: null,
    selectedEnvironmentId: null,
    recentProjectIds: [],
  });
});

afterEach(cleanup);

afterAll(() => {
  mock.module("@/hooks/useProjects", () => realUseProjectsSnapshot);
  mock.module(
    "@/components/environments/CreateEnvironmentFlowDialog",
    () => realCreateEnvironmentFlowSnapshot,
  );
});

describe("ProjectLauncher", () => {
  test("resolves five projects in recent order and fills missing history by date added", () => {
    const projects = Array.from({ length: 7 }, (_, index) => makeProject(index + 1));

    expect(
      resolveRecentProjects(projects, ["deleted-project", "project-2", "project-5", "project-2"])
        .map((project) => project.id),
    ).toEqual(["project-2", "project-5", "project-7", "project-6", "project-4"]);
  });

  test("handles empty input, bounds valid history, and falls back to order for invalid or equal dates", () => {
    expect(resolveRecentProjects([], ["missing"])).toEqual([]);

    const projects = Array.from({ length: 7 }, (_, index) =>
      makeProject(index + 1, index < 2 ? "invalid" : "2026-01-01T00:00:00.000Z"),
    );
    expect(
      resolveRecentProjects(projects, projects.map((project) => project.id)).map(
        (project) => project.id,
      ),
    ).toEqual(["project-1", "project-2", "project-3", "project-4", "project-5"]);

    expect(resolveRecentProjects(projects.slice(0, 3), []).map((project) => project.id))
      .toEqual(["project-1", "project-2", "project-3"]);
  });

  test("opens the project row and keeps its environment action separate", () => {
    const onOpenProject = mock(() => {});
    const onCreateEnvironment = mock(() => {});
    const projects = [makeProject(1), makeProject(2)];

    render(
      <ProjectLauncherContent
        projects={projects}
        isLoading={false}
        onOpenProject={onOpenProject}
        onCreateEnvironment={onCreateEnvironment}
      />,
    );

    expect(screen.getByText("/work/project-1")).toBeTruthy();
    expect(screen.getByText("https://github.com/acme/project-2.git")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open Project 1" }));
    expect(onOpenProject).toHaveBeenCalledWith("project-1");
    expect(onCreateEnvironment).not.toHaveBeenCalled();

    onOpenProject.mockClear();
    fireEvent.click(
      screen.getByRole("button", { name: "Create environment for Project 1" }),
    );
    expect(onCreateEnvironment).toHaveBeenCalledWith("project-1");
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  test("renders clear loading and no-project states", () => {
    const props = {
      projects: [],
      onOpenProject: () => {},
      onCreateEnvironment: () => {},
    };

    const loadingView = render(<ProjectLauncherContent {...props} isLoading />);
    expect(screen.getByText("Loading projects...")).toBeTruthy();
    loadingView.unmount();

    render(<ProjectLauncherContent {...props} isLoading={false} />);
    expect(screen.getByText("No projects yet")).toBeTruthy();
  });

  test("keeps available projects visible while a refresh is loading", () => {
    render(
      <ProjectLauncherContent
        projects={[makeProject(1)]}
        isLoading
        onOpenProject={() => {}}
        onCreateEnvironment={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Open Project 1" })).toBeTruthy();
    expect(screen.queryByText("Loading projects...")).toBeNull();
  });

  test("integrates recent project selection and opens and closes the shared create flow", () => {
    const operations = {
      createEnvironment: mock(async () => { throw new Error("not called"); }),
      updateEnvironment: mock(() => {}),
      startEnvironment: mock(async () => {}),
    } satisfies CreateEnvironmentFlowOperations;
    projectsValue = [makeProject(1), makeProject(2)];
    useUIStore.setState({ recentProjectIds: ["project-2"] });

    render(<ProjectLauncher {...operations} />);

    const projectButtons = screen.getAllByRole("button", { name: /^Open Project/ });
    expect(projectButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Open Project 2",
      "Open Project 1",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Open Project 2" }));
    expect(useUIStore.getState().selectedProjectId).toBe("project-2");
    expect(useUIStore.getState().recentProjectIds[0]).toBe("project-2");

    fireEvent.click(
      screen.getByRole("button", { name: "Create environment for Project 1" }),
    );
    expect(screen.getByRole("button", { name: "Close create flow" })).toBeTruthy();
    expect(flowProps).toMatchObject({
      open: true,
      projectId: "project-1",
      ...operations,
    });

    fireEvent.click(screen.getByRole("button", { name: "Close create flow" }));
    expect(screen.queryByRole("button", { name: "Close create flow" })).toBeNull();
    expect(flowProps?.projectId).toBeNull();
  });
});
