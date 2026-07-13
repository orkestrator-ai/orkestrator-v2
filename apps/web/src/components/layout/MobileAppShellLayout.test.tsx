import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MobileAppShellLayout } from "./MobileAppShellLayout";

afterEach(cleanup);

function renderLayout(overrides: Partial<React.ComponentProps<typeof MobileAppShellLayout>> = {}) {
  const props: React.ComponentProps<typeof MobileAppShellLayout> = {
    selectedProjectId: "project-1",
    selectedEnvironmentId: "environment-1",
    filesPanelOpen: false,
    centralPanelStyle: { backgroundColor: "rgb(1, 2, 3)" },
    actionBar: <div>Actions</div>,
    sidebar: <div>Projects</div>,
    filesPanel: <div>Files</div>,
    onTitleBarMouseDown: mock(() => undefined),
    children: <div>Workspace</div>,
    ...overrides,
  };
  return { ...render(<MobileAppShellLayout {...props} />), props };
}

describe("MobileAppShellLayout", () => {
  test("opens and closes the project drawer while keeping workspace content mounted", () => {
    renderLayout();
    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Projects and environments" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open projects and environments" }));
    expect(screen.getByRole("dialog", { name: "Projects and environments" })).toBeTruthy();
    expect(screen.getByText("Projects")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Close projects and environments" })[0]!);
    expect(screen.queryByRole("dialog", { name: "Projects and environments" })).toBeNull();
    expect(screen.getByText("Workspace")).toBeTruthy();
  });

  test("closes the drawer when project or environment selection changes", () => {
    const { rerender, props } = renderLayout();
    fireEvent.click(screen.getByRole("button", { name: "Open projects and environments" }));
    rerender(<MobileAppShellLayout {...props} selectedEnvironmentId="environment-2" />);
    expect(screen.queryByRole("dialog", { name: "Projects and environments" })).toBeNull();
  });

  test("shows the files panel as a mobile overlay", () => {
    renderLayout({ filesPanelOpen: true });
    expect(screen.getByRole("complementary", { name: "Workspace files" })).toBeTruthy();
    expect(screen.getByText("Files")).toBeTruthy();
  });
});
