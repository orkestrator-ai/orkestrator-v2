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
    agentInfoButton: <button type="button">Agent info</button>,
    sidebar: <div>Projects</div>,
    filesPanel: <div>Files</div>,
    onTitleBarMouseDown: mock(() => undefined),
    children: <div>Workspace</div>,
    ...overrides,
  };
  return { ...render(<MobileAppShellLayout {...props} />), props };
}

describe("MobileAppShellLayout", () => {
  test("places agent information immediately left of the tools spanner", () => {
    /*
     * No CSS is compiled under `bun test`, so restating the Tailwind offset
     * literals proves nothing — the button could be anywhere. What is testable
     * is the structure: both controls are right-anchored siblings of the title
     * bar, the info slot sits directly beside the tools trigger with nothing
     * between them, and its offset from the right edge is the larger of the two.
     */
    const { container } = renderLayout();

    const titleBar = container.querySelector<HTMLElement>("div[data-backend-drag-region]")!;
    const tools = screen.getByRole("button", { name: "Open tools" });
    const slot = screen.getByTestId("mobile-agent-info-slot");

    expect(slot.contains(screen.getByRole("button", { name: "Agent info" }))).toBe(true);
    expect(tools.parentElement).toBe(titleBar);
    expect(slot.parentElement).toBe(titleBar);
    expect(tools.nextElementSibling).toBe(slot);

    const rightOffset = (element: Element): number => {
      const match = [...element.classList].find((name) => /^right-\d/.test(name));
      expect(match).toBeTruthy();
      // Right-anchored, not left-anchored: a `left-*` control is on the wrong side.
      expect([...element.classList].some((name) => /^left-/.test(name))).toBe(false);
      return Number.parseFloat(match!.slice("right-".length));
    };
    expect(rightOffset(slot)).toBeGreaterThan(rightOffset(tools));
  });

  test("keeps the agent-info slot out of the title bar's drag region", () => {
    // The bar starts a window drag on mouse-down; without the stop, tapping the
    // button drags the window instead of opening the panel.
    const { container, props } = renderLayout();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Agent info" }));
    expect(props.onTitleBarMouseDown).not.toHaveBeenCalled();

    // The uncovered bar itself still drags, so the guard is scoped to controls.
    const titleBar = container.querySelector<HTMLElement>("div[data-backend-drag-region]")!;
    fireEvent.mouseDown(titleBar);
    expect(props.onTitleBarMouseDown).toHaveBeenCalledTimes(1);
  });

  test("renders whatever the shell puts in the agent-info slot", () => {
    renderLayout({ agentInfoButton: <span>Custom slot content</span> });
    expect(
      screen.getByTestId("mobile-agent-info-slot").textContent,
    ).toBe("Custom slot content");
  });

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

  test("bounds the mobile title between the header controls and reveals its full text on tap", async () => {
    const title = "A project and environment name that is far too long for a mobile title bar";
    const { props } = renderLayout({ title });

    const titleButton = screen.getByRole("button", { name: title });
    expect(titleButton.classList.contains("truncate")).toBe(true);
    expect(titleButton.classList.contains("left-12")).toBe(true);
    expect(titleButton.classList.contains("right-[5.5rem]")).toBe(true);

    fireEvent.mouseDown(titleButton);
    expect(props.onTitleBarMouseDown).not.toHaveBeenCalled();
    // A real tap may focus the trigger before click. Clicking must keep that
    // focus-opened tooltip visible rather than toggling it closed again.
    fireEvent.focus(titleButton);
    fireEvent.click(titleButton);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain(title);
    expect(titleButton.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
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
