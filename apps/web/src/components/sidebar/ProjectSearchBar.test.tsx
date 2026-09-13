import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Environment, Project } from "@/types";
import { useConfigStore } from "@/stores/configStore";
import { useUIStore } from "@/stores/uiStore";
import { ProjectSearchBar } from "./ProjectSearchBar";

const project: Project = {
  id: "project-1",
  name: "orkestrator-v2",
  gitUrl: "https://github.com/acme/orkestrator-v2.git",
  localPath: null,
  addedAt: "2026-01-01T00:00:00.000Z",
  order: 0,
};

const localEnvironment: Environment = {
  id: "env-local",
  projectId: "project-1",
  name: "main",
  branch: "main",
  containerId: null,
  status: "running",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: "2026-09-13T08:00:00.000Z",
  networkAccessMode: "restricted",
  order: 0,
  environmentType: "local",
  worktreePath: "/tmp/orkestrator-v2",
};

const containerEnvironment: Environment = {
  id: "env-container",
  projectId: "project-1",
  name: "build-modal-steps",
  branch: "build-modal-steps",
  containerId: "container-1",
  status: "stopped",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2026-01-02T00:00:00.000Z",
  lastActivityAt: "2026-09-09T10:00:00.000Z",
  networkAccessMode: "restricted",
  order: 1,
  environmentType: "containerized",
};

function renderSearchBar(
  overrides: {
    onSelectProject?: (projectId: string) => void;
    onSelectEnvironment?: (environmentId: string) => void;
  } = {},
) {
  const onSelectProject = mock(overrides.onSelectProject ?? (() => undefined));
  const onSelectEnvironment = mock(overrides.onSelectEnvironment ?? (() => undefined));
  render(
    <ProjectSearchBar
      projects={[project]}
      environments={[localEnvironment, containerEnvironment]}
      onSelectProject={onSelectProject}
      onSelectEnvironment={onSelectEnvironment}
    />,
  );
  return { onSelectProject, onSelectEnvironment };
}

async function openSearch() {
  fireEvent.click(screen.getByTestId("project-search-trigger"));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  return screen.getByRole("textbox", { name: "Search projects and environments" });
}

describe("ProjectSearchBar", () => {
  beforeEach(() => {
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = () => {};
    }
    useUIStore.setState({ recentProjectIds: ["project-1"] });
    useConfigStore.setState((state) => ({
      config: {
        ...state.config,
        repositories: {
          "project-1": {
            defaultBranch: "main",
            prBaseBranch: "main",
          },
        },
      },
    }));
  });

  afterEach(() => {
    cleanup();
  });

  test("opens a palette of recent projects and environments, including containerized ones", async () => {
    renderSearchBar();
    await openSearch();

    expect(screen.getByText("Recent projects")).toBeTruthy();
    expect(screen.getByText("Recent environments")).toBeTruthy();
    expect(screen.getByTestId("project-search-item-project-1")).toBeTruthy();
    expect(screen.getByTestId("project-search-item-env-local")).toBeTruthy();
    expect(screen.getByTestId("project-search-item-env-container")).toBeTruthy();
    expect(screen.getByText("primary")).toBeTruthy();
  });

  test("filters to matching environments and opens the keyboard selection", async () => {
    const { onSelectEnvironment, onSelectProject } = renderSearchBar();
    const input = await openSearch();

    fireEvent.change(input, { target: { value: "build" } });
    expect(await screen.findByTestId("project-search-item-env-container")).toBeTruthy();
    expect(screen.queryByTestId("project-search-item-env-local")).toBeNull();
    expect(screen.queryByTestId("project-search-item-project-1")).toBeNull();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelectEnvironment).toHaveBeenCalledWith("env-container");
    expect(onSelectProject).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("cycles the type filter with Tab", async () => {
    renderSearchBar();
    const input = await openSearch();

    fireEvent.keyDown(input, { key: "Tab" });
    expect(await screen.findByLabelText("Filter results: Projects")).toBeTruthy();
    expect(screen.queryByTestId("project-search-item-env-local")).toBeNull();
    expect(screen.getByTestId("project-search-item-project-1")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Tab" });
    expect(await screen.findByLabelText("Filter results: Environments")).toBeTruthy();
    expect(screen.queryByTestId("project-search-item-project-1")).toBeNull();
    expect(screen.getByTestId("project-search-item-env-container")).toBeTruthy();
  });

  test("opens from the command-or-control K shortcut", async () => {
    renderSearchBar();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});
