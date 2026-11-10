import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { configStore, projectStore, uiStore } from "@/stores";
import { kanbanStore } from "@/stores/kanbanStore";
import type { Project } from "@/types";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { appCommandStore } from "@/test/app-command-store";

afterEach(cleanup);

test("Home placeholder exposes its panel, loading, error and no-checkout states", () => {
  appCommandStore(uiStore).setState({ projectBoardTab: "home" });
  appCommandStore(projectStore).setState({
    projects: [{ id: "project", localPath: "/checkout" } as Project],
  });
  const retry = mock(() => {});
  const view = renderInAppCommandScope(<ProjectWorkspace projectId="project" />);
  expect(screen.getByRole("tabpanel").id).toBe("project-panel-home");
  expect(screen.getByText("Opening project home…")).toBeTruthy();
  view.rerender(<ProjectWorkspace projectId="project" homeError="offline" onRetryHome={retry} />);
  expect(screen.getByRole("alert").textContent).toContain("offline");
  fireEvent.click(screen.getByRole("button", { name: "Retry opening Home" }));
  expect(retry).toHaveBeenCalledTimes(1);
  appCommandStore(projectStore).setState({
    projects: [{ id: "project", localPath: null } as unknown as Project],
  });
  view.rerender(<ProjectWorkspace projectId="project" />);
  expect(screen.getByRole("tabpanel").textContent).toContain("Set a local checkout");
  expect(screen.queryByText("Opening project home…") === null).toBe(true);

  // A project id this node does not have (ids are per node) is not a missing checkout.
  appCommandStore(projectStore).setState({ projects: [], hasLoaded: false, isLoading: true });
  view.rerender(<ProjectWorkspace projectId="project" />);
  expect(screen.getByRole("tabpanel").textContent).toContain("Loading project…");
  appCommandStore(projectStore).setState({ hasLoaded: true, isLoading: false });
  view.rerender(<ProjectWorkspace projectId="project" />);
  expect(screen.getByRole("tabpanel").textContent).toContain("no project with this id");
  expect(screen.getByRole("tabpanel").textContent).not.toContain("Set a local checkout");
  appCommandStore(projectStore).setState({ hasLoaded: false, isLoading: false });
});

test("Notes tab shows the project notes editor in its own panel", () => {
  const loadNotes = mock(async (_projectId: string) => {});
  appCommandStore(kanbanStore).setState({ loadNotes });
  appCommandStore(uiStore).setState({ projectBoardTab: "notes" });
  appCommandStore(projectStore).setState({
    projects: [{ id: "project", name: "Acme" } as Project],
  });
  renderInAppCommandScope(<ProjectWorkspace projectId="project" />);
  expect(screen.getByRole("tabpanel").id).toBe("project-panel-notes");
  expect(screen.getByText("Acme Notes")).toBeTruthy();
  expect(loadNotes).toHaveBeenCalledWith("project");
});

test("Scheduling tab shows the project's schedules in its own panel", () => {
  appCommandStore(uiStore).setState({ projectBoardTab: "schedules" });
  appCommandStore(projectStore).setState({
    projects: [{ id: "project", name: "Acme" } as Project],
  });
  // Off, so the panel renders without reading the backend.
  const config = appCommandStore(configStore);
  const previous = config.getState();
  config.setState({
    hasLoaded: true,
    config: {
      ...previous.config,
      global: { ...previous.config.global, experimentalScheduling: false },
    },
  });
  try {
    renderInAppCommandScope(<ProjectWorkspace projectId="project" />);
    expect(screen.getByRole("tabpanel").id).toBe("project-panel-schedules");
    expect(screen.getByText(/Work the backend starts in Acme/)).toBeTruthy();
  } finally {
    // Unmount first: restoring the config would otherwise mount the live list.
    cleanup();
    config.setState({ hasLoaded: previous.hasLoaded, config: previous.config });
  }
});
