import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
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
    projects?: Project[];
    environments?: Environment[];
    onSelectProject?: (projectId: string) => void;
    onSelectEnvironment?: (environmentId: string) => void;
  } = {},
) {
  const onSelectProject = mock(overrides.onSelectProject ?? (() => undefined));
  const onSelectEnvironment = mock(overrides.onSelectEnvironment ?? (() => undefined));
  const props = {
    projects: overrides.projects ?? [project],
    environments: overrides.environments ?? [localEnvironment, containerEnvironment],
    onSelectProject,
    onSelectEnvironment,
  };
  const view = render(<ProjectSearchBar {...props} />);
  return {
    onSelectProject,
    onSelectEnvironment,
    rerender: (next: { projects?: Project[]; environments?: Environment[] }) =>
      view.rerender(
        <ProjectSearchBar
          projects={next.projects ?? props.projects}
          environments={next.environments ?? props.environments}
          onSelectProject={onSelectProject}
          onSelectEnvironment={onSelectEnvironment}
        />,
      ),
  };
}

async function openSearch() {
  fireEvent.click(screen.getByTestId("project-search-trigger"));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  return screen.getByRole("combobox", { name: "Search projects and environments" });
}

function expectActiveOption(input: HTMLElement, hitId: string) {
  expect(input.getAttribute("aria-activedescendant")).toBe(`project-search-option-${hitId}`);
  expect(screen.getByTestId(`project-search-item-${hitId}`).getAttribute("aria-selected")).toBe(
    "true",
  );
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

  test("matches the responsive workspace tab bar height", () => {
    renderSearchBar();

    const trigger = screen.getByTestId("project-search-trigger");
    expect(trigger.parentElement?.className).toContain("min-h-[40px]");
    expect(trigger.parentElement?.className).toContain("md:min-h-[32px]");
    expect(trigger.className).toContain("md:h-7");
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
    expectDomAbsent(screen.queryByTestId("project-search-item-env-local"), "unmatched local env");
    expectDomAbsent(screen.queryByTestId("project-search-item-project-1"), "unmatched project");
    expectActiveOption(input, "env-container");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelectEnvironment).toHaveBeenCalledWith("env-container");
    expect(onSelectProject).not.toHaveBeenCalled();
    await waitFor(() => expectDomAbsent(screen.queryByRole("dialog"), "closed search palette"));
  });

  test("opens the environment that matches the visible query on the same tick as Enter", async () => {
    const { onSelectEnvironment } = renderSearchBar();
    const input = await openSearch();

    fireEvent.change(input, { target: { value: "build-modal-steps" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelectEnvironment).toHaveBeenCalledWith("env-container");
  });

  test("cycles the type filter with Tab and Shift+Tab", async () => {
    renderSearchBar();
    const input = await openSearch();

    fireEvent.keyDown(input, { key: "Tab" });
    expect(await screen.findByLabelText("Filter results: Projects")).toBeTruthy();
    expectDomAbsent(screen.queryByTestId("project-search-item-env-local"), "hidden environment");
    expect(screen.getByTestId("project-search-item-project-1")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Tab" });
    expect(await screen.findByLabelText("Filter results: Environments")).toBeTruthy();
    expectDomAbsent(screen.queryByTestId("project-search-item-project-1"), "hidden project");
    expect(screen.getByTestId("project-search-item-env-container")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(await screen.findByLabelText("Filter results: Projects")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(await screen.findByLabelText("Filter results: All")).toBeTruthy();
    expect(screen.getByTestId("project-search-item-env-local")).toBeTruthy();
  });

  test("starts from All and Shift+Tab moves to Environments", async () => {
    renderSearchBar();
    const input = await openSearch();

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(await screen.findByLabelText("Filter results: Environments")).toBeTruthy();
    expectDomAbsent(screen.queryByTestId("project-search-item-project-1"), "hidden project");
  });

  test("applies the filter chosen from the dropdown", async () => {
    renderSearchBar();
    await openSearch();

    fireEvent.pointerDown(screen.getByTestId("project-search-filter"));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Environments" }));

    expect(await screen.findByLabelText("Filter results: Environments")).toBeTruthy();
    expectDomAbsent(screen.queryByTestId("project-search-item-project-1"), "hidden project");
    expect(screen.getByTestId("project-search-item-env-local")).toBeTruthy();
  });

  test("moves the highlight across project and environment rows and clamps at both ends", async () => {
    renderSearchBar();
    const input = await openSearch();

    expectActiveOption(input, "project-1");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expectActiveOption(input, "env-local");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expectActiveOption(input, "env-container");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expectActiveOption(input, "env-container");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expectActiveOption(input, "env-local");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expectActiveOption(input, "project-1");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expectActiveOption(input, "project-1");
  });

  test("keeps the highlighted environment when live data reorders the list", async () => {
    const older = { ...localEnvironment, lastActivityAt: "2026-09-13T07:00:00.000Z" };
    const newer = {
      ...containerEnvironment,
      lastActivityAt: "2026-09-13T08:00:00.000Z",
    };
    const { onSelectEnvironment, rerender } = renderSearchBar({
      environments: [older, newer],
    });
    const input = await openSearch();

    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(await screen.findByLabelText("Filter results: Environments")).toBeTruthy();
    expectActiveOption(input, "env-container");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expectActiveOption(input, "env-local");

    rerender({
      environments: [
        { ...newer, lastActivityAt: "2026-09-13T06:00:00.000Z" },
        { ...older, lastActivityAt: "2026-09-13T09:00:00.000Z" },
      ],
    });

    expectActiveOption(input, "env-local");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelectEnvironment).toHaveBeenCalledWith("env-local");
  });

  test("falls back to the first remaining hit when the highlighted id disappears", async () => {
    const { onSelectEnvironment, rerender } = renderSearchBar();
    const input = await openSearch();

    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expectActiveOption(input, "env-container");

    rerender({ environments: [localEnvironment] });
    expectActiveOption(input, "env-local");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelectEnvironment).toHaveBeenCalledWith("env-local");
  });

  test("opens a result from a mouse click", async () => {
    const { onSelectProject } = renderSearchBar();
    await openSearch();

    fireEvent.click(screen.getByTestId("project-search-item-project-1"));
    expect(onSelectProject).toHaveBeenCalledWith("project-1");
    await waitFor(() => expectDomAbsent(screen.queryByRole("dialog"), "closed search palette"));
  });

  test("resets query, filter, and highlight when the palette closes", async () => {
    renderSearchBar();
    const input = await openSearch();

    fireEvent.change(input, { target: { value: "build" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(await screen.findByLabelText("Filter results: Projects")).toBeTruthy();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expectDomAbsent(screen.queryByRole("dialog"), "closed search palette"));

    const reopened = await openSearch();
    expect((reopened as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("Filter results: All")).toBeTruthy();
    expect(screen.getByText("Recent projects")).toBeTruthy();
    expectActiveOption(reopened, "project-1");
  });

  test("resets palette state after Escape", async () => {
    renderSearchBar();
    const input = await openSearch();

    fireEvent.change(input, { target: { value: "build" } });
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expectDomAbsent(screen.queryByRole("dialog"), "closed search palette"));

    const reopened = await openSearch();
    expect((reopened as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("Filter results: All")).toBeTruthy();
  });

  test("shows empty-state copy for no projects, no environments, and no matches", async () => {
    renderSearchBar({ projects: [], environments: [] });
    await openSearch();
    expect(screen.getByText("No projects yet")).toBeTruthy();
    cleanup();

    renderSearchBar({ environments: [] });
    const noEnvs = await openSearch();
    fireEvent.keyDown(noEnvs, { key: "Tab" });
    fireEvent.keyDown(noEnvs, { key: "Tab" });
    expect(await screen.findByText("No environments yet")).toBeTruthy();
    cleanup();

    renderSearchBar();
    const input = await openSearch();
    fireEvent.change(input, { target: { value: "zzzz-no-match" } });
    expect(await screen.findByText("No projects or environments match that search.")).toBeTruthy();
  });

  test("opens from the command-or-control K shortcut", async () => {
    renderSearchBar();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  test("does not open from Command+K while another field is focused", () => {
    renderSearchBar();
    const field = document.createElement("input");
    document.body.appendChild(field);
    try {
      field.focus();
      fireEvent.keyDown(field, { key: "k", metaKey: true });
      expectDomAbsent(screen.queryByRole("dialog"), "search palette while typing");
    } finally {
      field.remove();
    }
  });

  test("does not open from Control+K in a textarea or contenteditable", () => {
    renderSearchBar();
    const textarea = document.createElement("textarea");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    document.body.append(textarea, editable);
    try {
      textarea.focus();
      fireEvent.keyDown(textarea, { key: "k", ctrlKey: true });
      expectDomAbsent(screen.queryByRole("dialog"), "search palette from textarea");

      editable.focus();
      fireEvent.keyDown(editable, { key: "k", ctrlKey: true });
      expectDomAbsent(screen.queryByRole("dialog"), "search palette from contenteditable");
    } finally {
      textarea.remove();
      editable.remove();
    }
  });
});
