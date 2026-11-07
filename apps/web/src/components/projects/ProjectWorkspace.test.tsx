import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { projectStore, uiStore } from "@/stores";
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
  const view = render(<ProjectWorkspace projectId="project" />);
  expect(screen.getByRole("tabpanel").id).toBe("project-panel-home");
  expect(screen.getByText("Opening project home…")).toBeTruthy();
  view.rerender(<ProjectWorkspace projectId="project" homeError="offline" onRetryHome={retry} />);
  expect(screen.getByRole("alert").textContent).toContain("offline");
  fireEvent.click(screen.getByRole("button", { name: "Retry opening Home" }));
  expect(retry).toHaveBeenCalledTimes(1);
  appCommandStore(projectStore).setState({ projects: [] });
  view.rerender(<ProjectWorkspace projectId="project" />);
  expect(screen.getByRole("tabpanel").textContent).toContain("Set a local checkout");
  expect(screen.queryByText("Opening project home…") === null).toBe(true);
});

test("Notes tab shows the project notes editor in its own panel", () => {
  const loadNotes = mock(async (_projectId: string) => {});
  appCommandStore(kanbanStore).setState({ loadNotes });
  appCommandStore(uiStore).setState({ projectBoardTab: "notes" });
  appCommandStore(projectStore).setState({
    projects: [{ id: "project", name: "Acme" } as Project],
  });
  render(<ProjectWorkspace projectId="project" />);
  expect(screen.getByRole("tabpanel").id).toBe("project-panel-notes");
  expect(screen.getByText("Acme Notes")).toBeTruthy();
  expect(loadNotes).toHaveBeenCalledWith("project");
});
