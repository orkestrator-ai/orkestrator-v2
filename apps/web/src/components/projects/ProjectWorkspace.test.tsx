import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useProjectStore, useUIStore } from "@/stores";
import type { Project } from "@/types";
import { ProjectWorkspace } from "./ProjectWorkspace";

afterEach(cleanup);

test("Home placeholder exposes its panel, loading, error and no-checkout states", () => {
  useUIStore.setState({ projectBoardTab: "home" });
  useProjectStore.setState({ projects: [{ id: "project", localPath: "/checkout" } as Project] });
  const retry = mock(() => {});
  const view = render(<ProjectWorkspace projectId="project" />);
  expect(screen.getByRole("tabpanel").id).toBe("project-panel-home");
  expect(screen.getByText("Opening project home…")).toBeTruthy();
  view.rerender(<ProjectWorkspace projectId="project" homeError="offline" onRetryHome={retry} />);
  expect(screen.getByRole("alert").textContent).toContain("offline");
  fireEvent.click(screen.getByRole("button", { name: "Retry opening Home" }));
  expect(retry).toHaveBeenCalledTimes(1);
  useProjectStore.setState({ projects: [] });
  view.rerender(<ProjectWorkspace projectId="project" />);
  expect(screen.getByRole("tabpanel").textContent).toContain("Set a local checkout");
  expect(screen.queryByText("Opening project home…") === null).toBe(true);
});
