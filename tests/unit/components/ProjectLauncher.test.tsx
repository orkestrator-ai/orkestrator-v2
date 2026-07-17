import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ProjectLauncherContent,
  resolveRecentProjects,
} from "@/components/projects/ProjectLauncher";
import type { Project } from "@/types";

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

afterEach(cleanup);

describe("ProjectLauncher", () => {
  test("resolves five projects in recent order and fills missing history by date added", () => {
    const projects = Array.from({ length: 7 }, (_, index) => makeProject(index + 1));

    expect(
      resolveRecentProjects(projects, ["deleted-project", "project-2", "project-5", "project-2"])
        .map((project) => project.id),
    ).toEqual(["project-2", "project-5", "project-7", "project-6", "project-4"]);
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
});
