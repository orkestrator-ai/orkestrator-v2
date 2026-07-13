import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MobileAppShellLayout } from "./MobileAppShellLayout";

afterEach(cleanup);

function renderLayout(overrides: Partial<React.ComponentProps<typeof MobileAppShellLayout>> = {}) {
  const props: React.ComponentProps<typeof MobileAppShellLayout> = {
    selectedProjectId: "project-1",
    selectedEnvironmentId: "environment-1",
    title: "pgstack1 - feature-auth",
    filesPanelOpen: false,
    centralPanelStyle: { backgroundColor: "rgb(1, 2, 3)" },
    actionBar: <button type="button">Actions</button>,
    sidebar: <div>Projects</div>,
    filesPanel: <div>Files</div>,
    onTitleBarMouseDown: mock(() => undefined),
    children: <div>Workspace</div>,
    ...overrides,
  };
  return { ...render(<MobileAppShellLayout {...props} />), props };
}

describe("MobileAppShellLayout", () => {
  test("shows the active project name and opens tools in a popover", () => {
    renderLayout();

    expect(screen.getByText("pgstack1 - feature-auth")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Tools" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open tools" }));
    expect(screen.getByRole("dialog", { name: "Tools" })).toBeTruthy();
    expect(screen.getByText("Actions")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.queryByRole("dialog", { name: "Tools" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open tools" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Tools" })).toBeNull();
  });

  test("opens and closes the project drawer while keeping workspace content mounted", () => {
    renderLayout();
    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Projects and environments" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open projects and environments" }));
    expect(screen.getByRole("dialog", { name: "Projects and environments" })).toBeTruthy();
    expect(screen.getByText("Projects")).toBeTruthy();
    const closeButtons = screen.getAllByRole("button", { name: "Close projects and environments" });
    const drawerCloseButton = closeButtons.find((button) => button.classList.contains("top-1"));
    expect(drawerCloseButton).toBeTruthy();
    fireEvent.click(drawerCloseButton!);
    expect(screen.queryByRole("dialog", { name: "Projects and environments" })).toBeNull();
    expect(screen.getByText("Workspace")).toBeTruthy();
  });

  test("toggles the project drawer closed with a second menu-button tap", () => {
    renderLayout();
    const menuButton = screen.getByRole("button", { name: "Open projects and environments" });

    fireEvent.click(menuButton);
    expect(menuButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Projects and environments" })).toBeTruthy();

    fireEvent.click(menuButton);
    expect(menuButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog", { name: "Projects and environments" })).toBeNull();
  });

  test("closes the drawer when project or environment selection changes", () => {
    const { rerender, props } = renderLayout();
    fireEvent.click(screen.getByRole("button", { name: "Open projects and environments" }));
    rerender(<MobileAppShellLayout {...props} selectedEnvironmentId="environment-2" />);
    expect(screen.queryByRole("dialog", { name: "Projects and environments" })).toBeNull();
  });

  test("closes the tools popover when the active selection changes", () => {
    const { rerender, props } = renderLayout();
    fireEvent.click(screen.getByRole("button", { name: "Open tools" }));
    rerender(<MobileAppShellLayout {...props} selectedEnvironmentId="environment-2" />);
    expect(screen.queryByRole("dialog", { name: "Tools" })).toBeNull();
  });

  test("shows the files panel as a mobile overlay", () => {
    renderLayout({ filesPanelOpen: true });
    expect(screen.getByRole("complementary", { name: "Workspace files" })).toBeTruthy();
    expect(screen.getByText("Files")).toBeTruthy();
  });
});
