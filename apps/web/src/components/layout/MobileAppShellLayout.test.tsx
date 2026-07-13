import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createPortal } from "react-dom";
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

  test("closes tools for a portaled context-menu action and restores trigger focus", async () => {
    renderLayout({
      actionBar: createPortal(
        <div data-slot="context-menu-item" role="menuitem" tabIndex={0}>Claude Native</div>,
        document.body,
      ),
    });

    const toolsButton = screen.getByRole("button", { name: "Open tools" });
    fireEvent.click(toolsButton);
    fireEvent.click(screen.getByRole("menuitem", { name: "Claude Native" }));

    expect(screen.queryByRole("dialog", { name: "Tools" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(toolsButton));
  });

  test("keeps tools open when a nested control consumes Escape", () => {
    renderLayout({
      actionBar: (
        <button
          type="button"
          onKeyDown={(event) => event.preventDefault()}
        >
          Nested control
        </button>
      ),
    });

    fireEvent.click(screen.getByRole("button", { name: "Open tools" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Nested control" }), { key: "Escape" });

    expect(screen.getByRole("dialog", { name: "Tools" })).toBeTruthy();
  });

  test("closes tools from the backdrop and restores trigger focus", async () => {
    const { container } = renderLayout();
    const toolsButton = screen.getByRole("button", { name: "Open tools" });
    fireEvent.click(toolsButton);

    const backdrop = container.querySelector("button.fixed.inset-0");
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);

    expect(screen.queryByRole("dialog", { name: "Tools" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(toolsButton));
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

  test("closes the project drawer from its backdrop and restores trigger focus", async () => {
    const { container } = renderLayout();
    const menuButton = screen.getByRole("button", { name: "Open projects and environments" });
    fireEvent.click(menuButton);

    const backdrop = container.querySelector("#mobile-projects-drawer > button.absolute.inset-0");
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);

    expect(screen.queryByRole("dialog", { name: "Projects and environments" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(menuButton));
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
