import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createPortal } from "react-dom";
import { MobileAppShellLayout } from "./MobileAppShellLayout";

const originalOrkestrator = window.orkestrator;
const originalGateway = window.orkestratorGateway;

afterEach(() => {
  cleanup();
  window.orkestrator = originalOrkestrator;
  window.orkestratorGateway = originalGateway;
});

function renderLayout(
  overrides: Partial<React.ComponentProps<typeof MobileAppShellLayout>> = {},
  options: { keepInitialDrawerOpen?: boolean } = {},
) {
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
  const result = render(<MobileAppShellLayout {...props} />);
  if (!options.keepInitialDrawerOpen) {
    const dialog = screen.getByRole("dialog", { name: "Projects and environments" });
    const closeButton = dialog.querySelector<HTMLButtonElement>(
      "button[aria-controls='mobile-projects-drawer']",
    );
    expect(closeButton).toBeTruthy();
    fireEvent.click(closeButton!);
  }
  return { ...result, props };
}

function touchTap(element: Element) {
  fireEvent.pointerDown(element, { pointerType: "touch" });
  fireEvent.pointerUp(element, { pointerType: "touch" });
  fireEvent.click(element);
}

function getTitleBarSidebarTrigger(container: HTMLElement): HTMLButtonElement {
  const trigger = container.querySelector<HTMLButtonElement>(
    "button[aria-controls='mobile-projects-drawer']",
  );
  expect(trigger).toBeTruthy();
  return trigger!;
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

  test("keeps interactive controls out of the browser title bar's drag handler", () => {
    // The bar starts a window drag on mouse-down; without the stop, tapping the
    // button drags the window instead of opening the panel.
    const { container, props } = renderLayout();
    fireEvent.mouseDown(getTitleBarSidebarTrigger(container));
    fireEvent.mouseDown(screen.getByRole("button", { name: "pgstack1 - feature-auth" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Open tools" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Agent info" }));
    expect(props.onTitleBarMouseDown).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open tools" }));
    fireEvent.mouseDown(screen.getByRole("dialog", { name: "Tools" }));
    expect(props.onTitleBarMouseDown).not.toHaveBeenCalled();

    // The uncovered bar itself still drags, so the guards are scoped to controls.
    const titleBar = container.querySelector<HTMLElement>("div[data-backend-drag-region]")!;
    fireEvent.mouseDown(titleBar);
    expect(props.onTitleBarMouseDown).toHaveBeenCalledTimes(1);
  });

  test("keeps the title draggable in a narrow Electron window", () => {
    window.orkestrator = {
      window: { startDragging: async () => {} },
    } as Window["orkestrator"];
    delete window.orkestratorGateway;
    const { props } = renderLayout();

    const titleButton = screen.getByRole("button", { name: "pgstack1 - feature-auth" });
    expect(titleButton.hasAttribute("data-backend-drag-region")).toBe(true);

    fireEvent.mouseDown(titleButton);
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

    fireEvent.click(screen.getByRole("button", { name: "Open tools" }));
    const closeToolsTrigger = screen
      .getAllByRole("button", { name: "Close tools" })
      .find((button) => button.hasAttribute("aria-controls"));
    expect(closeToolsTrigger).toBeTruthy();
    fireEvent.click(closeToolsTrigger!);
    expect(screen.queryByRole("dialog", { name: "Tools" })).toBeNull();
  });

  test("bounds the mobile title and toggles its full text with touch taps", async () => {
    const title = "A project and environment name that is far too long for a mobile title bar";
    const { props } = renderLayout({ title });

    const titleButton = screen.getByRole("button", { name: title });
    expect(titleButton.classList.contains("truncate")).toBe(true);
    expect(titleButton.classList.contains("left-12")).toBe(true);
    expect(titleButton.classList.contains("right-[5.5rem]")).toBe(true);

    fireEvent.mouseDown(titleButton);
    expect(props.onTitleBarMouseDown).not.toHaveBeenCalled();
    touchTap(titleButton);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain(title);
    expect(titleButton.getAttribute("aria-expanded")).toBe("true");

    touchTap(titleButton);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(titleButton.getAttribute("aria-expanded")).toBe("false");
  });

  test("preserves Radix keyboard activation, Escape, hover, blur, and outside dismissal", async () => {
    renderLayout();
    const titleButton = screen.getByRole("button", { name: "pgstack1 - feature-auth" });

    fireEvent.focus(titleButton);
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    fireEvent.click(titleButton, { detail: 0 });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());

    fireEvent.blur(titleButton);
    fireEvent.focus(titleButton);
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());

    fireEvent.blur(titleButton);
    fireEvent.pointerMove(titleButton, { pointerType: "mouse" });
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    fireEvent.pointerDown(document.body, { pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());

    fireEvent.focus(titleButton);
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    fireEvent.blur(titleButton);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  test("does not misclassify keyboard activation after a cancelled touch", async () => {
    renderLayout();
    const titleButton = screen.getByRole("button", { name: "pgstack1 - feature-auth" });

    fireEvent.pointerDown(titleButton, { pointerType: "touch" });
    fireEvent.pointerCancel(titleButton, { pointerType: "touch" });
    fireEvent.pointerUp(document, { pointerType: "touch" });
    fireEvent.blur(titleButton);
    fireEvent.focus(titleButton);
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    fireEvent.click(titleButton, { detail: 0 });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  test("toggles the full title with pen taps", async () => {
    renderLayout();
    const titleButton = screen.getByRole("button", { name: "pgstack1 - feature-auth" });

    fireEvent.pointerDown(titleButton, { pointerType: "pen" });
    fireEvent.pointerUp(titleButton, { pointerType: "pen" });
    fireEvent.click(titleButton);
    expect(await screen.findByRole("tooltip")).toBeTruthy();

    fireEvent.pointerDown(titleButton, { pointerType: "pen" });
    fireEvent.pointerUp(titleButton, { pointerType: "pen" });
    fireEvent.click(titleButton);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  test("closes the title tooltip when its title, project, or environment changes", async () => {
    const { rerender, props } = renderLayout();
    const openTooltip = async () => {
      const trigger = screen.getByRole("button", { name: props.title });
      fireEvent.blur(trigger);
      fireEvent.focus(trigger);
      expect(await screen.findByRole("tooltip")).toBeTruthy();
    };

    await openTooltip();
    rerender(<MobileAppShellLayout {...props} title="Renamed title" />);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());

    const renamedProps = { ...props, title: "Renamed title" };
    fireEvent.focus(screen.getByRole("button", { name: "Renamed title" }));
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    rerender(<MobileAppShellLayout {...renamedProps} selectedProjectId="project-2" />);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());

    fireEvent.blur(screen.getByRole("button", { name: "Renamed title" }));
    fireEvent.focus(screen.getByRole("button", { name: "Renamed title" }));
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    rerender(<MobileAppShellLayout {...renamedProps} selectedEnvironmentId="environment-2" />);
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

  test("keeps tools open when non-action popover content is clicked", () => {
    renderLayout({ actionBar: <div>Tool status</div> });
    fireEvent.click(screen.getByRole("button", { name: "Open tools" }));
    fireEvent.click(screen.getByText("Tool status"));
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

  test("opens the project drawer on initial mobile entry and keeps workspace content mounted", async () => {
    const { container } = renderLayout({}, { keepInitialDrawerOpen: true });
    const menuButton = getTitleBarSidebarTrigger(container);
    expect(screen.getByText("Workspace")).toBeTruthy();
    const dialog = screen.getByRole("dialog", { name: "Projects and environments" });
    expect(dialog).toBeTruthy();
    expect(screen.getByText("Projects")).toBeTruthy();
    const drawerCloseButton = dialog.querySelector<HTMLButtonElement>("button.absolute.right-2");
    expect(drawerCloseButton).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(drawerCloseButton!));
    fireEvent.click(drawerCloseButton!);
    expect(screen.queryByRole("dialog", { name: "Projects and environments" })).toBeNull();
    expect(screen.getByText("Workspace")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(menuButton));
  });

  test("toggles the project drawer closed with a second menu-button tap", () => {
    const { container } = renderLayout({}, { keepInitialDrawerOpen: true });
    const closeMenuButton = screen
      .getAllByRole("button", { name: "Close projects and environments" })
      .find((button) => button.hasAttribute("aria-controls"));
    expect(closeMenuButton).toBeTruthy();

    fireEvent.click(closeMenuButton!);
    expect(screen.queryByRole("dialog", { name: "Projects and environments" })).toBeNull();

    const openMenuButton = getTitleBarSidebarTrigger(container);
    expect(openMenuButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(openMenuButton);
    expect(openMenuButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Projects and environments" })).toBeTruthy();
  });

  test("closes the project drawer from its backdrop and restores trigger focus", async () => {
    const { container } = renderLayout({}, { keepInitialDrawerOpen: true });
    const menuButton = getTitleBarSidebarTrigger(container);

    const backdrop = document.querySelector("[data-slot='mobile-projects-overlay']");
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);

    expect(screen.queryByRole("dialog", { name: "Projects and environments" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(menuButton));
  });

  test("closes the initial drawer with Escape and restores trigger focus", async () => {
    const { container } = renderLayout({}, { keepInitialDrawerOpen: true });
    const menuButton = getTitleBarSidebarTrigger(container);

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Projects and environments" })).toBeNull();
    });
    expect(document.activeElement).toBe(menuButton);
  });

  test("keeps the initial drawer open across unchanged and partial selections", () => {
    const { rerender, props } = renderLayout(
      {
        selectedProjectId: null,
        selectedEnvironmentId: null,
      },
      { keepInitialDrawerOpen: true },
    );
    expect(screen.getByRole("dialog", { name: "Projects and environments" })).toBeTruthy();

    rerender(
      <MobileAppShellLayout
        {...props}
        selectedProjectId={null}
        selectedEnvironmentId={null}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Projects and environments" })).toBeTruthy();

    rerender(
      <MobileAppShellLayout
        {...props}
        selectedProjectId="project-1"
        selectedEnvironmentId={null}
      />,
    );
    expect(screen.queryByRole("dialog", { name: "Projects and environments" })).toBeNull();
  });

  test("closes the drawer when project or environment selection changes", () => {
    const { rerender, props } = renderLayout({}, { keepInitialDrawerOpen: true });
    rerender(<MobileAppShellLayout {...props} selectedEnvironmentId="environment-2" />);
    expect(screen.queryByRole("dialog", { name: "Projects and environments" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open projects and environments" }));
    rerender(<MobileAppShellLayout {...props} selectedProjectId="project-2" />);
    expect(screen.queryByRole("dialog", { name: "Projects and environments" })).toBeNull();
  });

  test("closes the tools popover when the active selection changes", () => {
    const { rerender, props } = renderLayout();
    fireEvent.click(screen.getByRole("button", { name: "Open tools" }));
    rerender(<MobileAppShellLayout {...props} selectedEnvironmentId="environment-2" />);
    expect(screen.queryByRole("dialog", { name: "Tools" })).toBeNull();
  });

  test("closes the tools popover when the active project changes", () => {
    const { rerender, props } = renderLayout();
    fireEvent.click(screen.getByRole("button", { name: "Open tools" }));
    rerender(<MobileAppShellLayout {...props} selectedProjectId="project-2" />);
    expect(screen.queryByRole("dialog", { name: "Tools" })).toBeNull();
  });

  test("applies the central panel style and conditionally shows the files overlay", () => {
    const { rerender, props } = renderLayout();
    const workspaceMain = screen.getByText("Workspace").parentElement;
    expect(workspaceMain?.parentElement?.getAttribute("style")).toContain(
      "background-color: rgb(1, 2, 3)",
    );
    expect(screen.queryByRole("complementary", { name: "Workspace files" })).toBeNull();
    expect(screen.queryByText("Files")).toBeNull();

    rerender(<MobileAppShellLayout {...props} filesPanelOpen />);
    expect(screen.getByRole("complementary", { name: "Workspace files" })).toBeTruthy();
    expect(screen.getByText("Files")).toBeTruthy();
  });
});
