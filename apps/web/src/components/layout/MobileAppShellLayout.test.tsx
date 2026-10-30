import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { createPortal } from "react-dom";
import { onGlobalSettingsRequest } from "@/lib/settings-navigation";
import { SidebarBottomBar } from "../sidebar/SidebarBottomBar";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { portalStore } from "@/lib/portal/portal-store";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useUIStore } from "@/stores/uiStore";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useBugReportStore } from "@/stores/bugReportStore";
import { useGlobalSettingsStore } from "@/stores/globalSettingsStore";
import { FullscreenSettingsLayout } from "@/components/settings/FullscreenSettingsLayout";
import {
  MOBILE_TOOLS_TRIGGER_LABEL,
  MOBILE_TOOLS_TRIGGER_SELECTOR,
  MobileAppShellLayout,
} from "./MobileAppShellLayout";

const originalOrkestrator = window.orkestrator;
const originalGateway = window.orkestratorGateway;

afterEach(() => {
  cleanup();
  useAppDialogStore.setState({ request: null });
  useGlobalSettingsStore.setState({ open: false, section: undefined, sectionRequest: 0 });
  useBugReportStore.setState({ sheetOpen: false, draftInProgress: false });
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
  if (!options.keepInitialDrawerOpen && props.initialSidebarOpen !== false) {
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
  test("exposes the collapsed tools trigger under its published selector", () => {
    /*
     * `ActionBar` returns focus here by query selector when a dialog launched
     * from inside the tools popover closes, because the toolbar's own trigger
     * is still mounted but hidden. Renaming this button would silently strand
     * focus, so assert the two agree — and that the selector deliberately stops
     * matching once the popover is open and the toolbar is reachable again.
     */
    const { container } = renderLayout();

    expect(container.ownerDocument.querySelector(MOBILE_TOOLS_TRIGGER_SELECTOR)).toBe(
      screen.getByRole("button", { name: MOBILE_TOOLS_TRIGGER_LABEL }),
    );

    fireEvent.click(screen.getByRole("button", { name: MOBILE_TOOLS_TRIGGER_LABEL }));
    expect(container.ownerDocument.querySelector(MOBILE_TOOLS_TRIGGER_SELECTOR) === null).toBe(
      true,
    );
  });

  test("places the tools spanner third from the right without overlapping the other actions", () => {
    /*
     * No CSS is compiled under `bun test`, so restating the Tailwind offset
     * literals proves nothing — the buttons could be anywhere. What is testable
     * is the structure: all three controls share one trailing flex row, the
     * tools trigger precedes the inbox and information controls, and the title
     * flexes into the space that row leaves available.
     */
    const { container } = renderLayout({
      agentInfoButton: (
        <>
          <button type="button">Agent inbox</button>
          <button type="button">Agent info</button>
        </>
      ),
    });

    const titleBar = container.querySelector<HTMLElement>("div[data-backend-drag-region]")!;
    const tools = screen.getByRole("button", { name: "Open tools" });
    const slot = screen.getByTestId("mobile-agent-info-slot");
    const actions = screen.getByTestId("mobile-title-actions");
    const title = screen.getByRole("button", { name: "pgstack1 - feature-auth" });

    expect(slot.contains(screen.getByRole("button", { name: "Agent info" }))).toBe(true);
    expect(slot.contains(screen.getByRole("button", { name: "Agent inbox" }))).toBe(true);
    expect(actions.parentElement).toBe(titleBar);
    expect(tools.parentElement).toBe(actions);
    expect(tools.nextElementSibling).toBe(slot);
    expect(actions.classList.contains("flex")).toBe(true);
    expect(actions.classList.contains("shrink-0")).toBe(true);
    expect(title.classList.contains("flex-1")).toBe(true);
    expect([...title.classList].some((name) => name.startsWith("right-"))).toBe(false);
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
    expect(screen.getByTestId("mobile-agent-info-slot").textContent).toBe("Custom slot content");
  });

  test("shows the active project name and opens tools in a popover", () => {
    renderLayout();

    expect(screen.getByText("pgstack1 - feature-auth")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Tools" }) === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Open tools" }));
    expect(screen.getByRole("dialog", { name: "Tools" })).toBeTruthy();
    expect(screen.getByText("Actions")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.queryByRole("dialog", { name: "Tools" }) === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Open tools" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Tools" }) === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Open tools" }));
    const closeToolsTrigger = screen
      .getAllByRole("button", { name: "Close tools" })
      .find((button) => button.hasAttribute("aria-controls"));
    expect(closeToolsTrigger).toBeTruthy();
    fireEvent.click(closeToolsTrigger!);
    expect(screen.queryByRole("dialog", { name: "Tools" }) === null).toBe(true);
  });

  test("shimmers only the environment name in the title while its PR is ready to merge", () => {
    const { rerender, props } = renderLayout({
      titleEnvironmentName: "feature-auth",
      titleNameSignal: "merge-ready" as const,
    });
    const title = screen.getByRole("button", { name: "pgstack1 - feature-auth" });
    // Visible text is unchanged; the description beside it is `hidden`.
    const visibleText = Array.from(title.childNodes)
      .filter((node) => !(node instanceof HTMLElement && node.hidden))
      .map((node) => node.textContent)
      .join("");
    expect(visibleText).toBe("pgstack1 - feature-auth");
    const name = title.querySelector<HTMLElement>("[data-merge-ready]");
    expect(name?.textContent).toBe("feature-auth");
    expect(name?.classList).toContain("text-shimmer");
    expect(name?.classList).toContain("merge-ready-name");
    const describedBy = title.getAttribute("aria-describedby");
    expect(describedBy ? document.getElementById(describedBy)?.textContent : null).toBe(
      "Ready to merge",
    );
    expect(title.querySelector('[data-testid="merge-ready-indicator"]')?.classList).toContain(
      "motion-reduce:inline-block",
    );

    rerender(<MobileAppShellLayout {...props} titleNameSignal={null} />);
    const plain = screen.getByRole("button", { name: "pgstack1 - feature-auth" });
    expect(plain.querySelector("[data-merge-ready]")).toBeNull();
    expect(plain.hasAttribute("aria-describedby")).toBe(false);
    expect(plain.textContent).toBe("pgstack1 - feature-auth");
  });

  test("leaves a title that does not name the environment unstyled", () => {
    renderLayout({
      title: "pgstack1",
      titleEnvironmentName: "feature-auth",
      titleNameSignal: "merge-ready" as const,
    });
    const title = screen.getByRole("button", { name: "pgstack1" });
    expect(title.querySelector("[data-merge-ready]")).toBeNull();
  });

  test("bounds the mobile title and toggles its full text with touch taps", async () => {
    const title = "A project and environment name that is far too long for a mobile title bar";
    const { props } = renderLayout({ title });

    const titleButton = screen.getByRole("button", { name: title });
    expect(titleButton.classList.contains("truncate")).toBe(true);
    expect(titleButton.classList.contains("ml-12")).toBe(true);
    expect(titleButton.classList.contains("flex-1")).toBe(true);
    expect([...titleButton.classList].some((name) => name.startsWith("right-"))).toBe(false);

    fireEvent.mouseDown(titleButton);
    expect(props.onTitleBarMouseDown).not.toHaveBeenCalled();
    touchTap(titleButton);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain(title);
    expect(titleButton.getAttribute("aria-expanded")).toBe("true");

    touchTap(titleButton);
    await waitFor(() => expect(screen.queryByRole("tooltip") === null).toBe(true));
    expect(titleButton.getAttribute("aria-expanded")).toBe("false");
  });

  // WebKit and iOS Safari never focus a tapped button, so no blur closes the
  // tooltip there; the bubble has to close itself (todo 0202).
  test("closes the title tooltip from a touch or pen tap on the bubble", async () => {
    renderLayout();
    const titleButton = screen.getByRole("button", { name: "pgstack1 - feature-auth" });

    touchTap(titleButton);
    const tooltip = await screen.findByRole("tooltip");
    fireEvent.pointerDown(tooltip, { pointerType: "touch" });
    fireEvent.touchStart(tooltip);
    expect(screen.queryByRole("tooltip")).toBe(tooltip);
    // Cancellation is the unit-level contract. Real engine compatibility
    // mouse/click suppression is covered by the CI browser spec.
    expect(fireEvent.touchEnd(tooltip)).toBe(false);
    await waitFor(() => expect(screen.queryByRole("tooltip") === null).toBe(true));
    expect(titleButton.getAttribute("aria-expanded")).toBe("false");

    fireEvent.pointerDown(titleButton, { pointerType: "pen" });
    fireEvent.pointerUp(titleButton, { pointerType: "pen" });
    fireEvent.click(titleButton);
    const penTooltip = await screen.findByRole("tooltip");
    expect(fireEvent.pointerDown(penTooltip, { pointerType: "pen" })).toBe(false);
    fireEvent.pointerUp(penTooltip, { pointerType: "pen" });
    expect(screen.getByRole("tooltip")).toBe(penTooltip);
    // Older engines expose click as MouseEvent, without pointerType.
    expect(fireEvent.click(penTooltip)).toBe(false);
    await waitFor(() => expect(screen.queryByRole("tooltip") === null).toBe(true));
  });

  test("does not treat a cancelled pen press or a mouse click as a pen tap", async () => {
    renderLayout();
    touchTap(screen.getByRole("button", { name: "pgstack1 - feature-auth" }));
    const tooltip = await screen.findByRole("tooltip");
    fireEvent.pointerDown(tooltip, { pointerType: "pen" });
    fireEvent.pointerCancel(tooltip, { pointerType: "pen" });
    fireEvent.click(tooltip);
    expect(screen.getByRole("tooltip")).toBe(tooltip);
    fireEvent.pointerDown(tooltip, { pointerType: "mouse" });
    fireEvent.pointerUp(tooltip, { pointerType: "mouse" });
    fireEvent.click(tooltip);
    expect(screen.getByRole("tooltip")).toBe(tooltip);
  });

  test("preserves Radix keyboard activation, Escape, hover, blur, and outside dismissal", async () => {
    renderLayout();
    const titleButton = screen.getByRole("button", { name: "pgstack1 - feature-auth" });

    fireEvent.focus(titleButton);
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    fireEvent.click(titleButton, { detail: 0 });
    await waitFor(() => expect(screen.queryByRole("tooltip") === null).toBe(true));

    fireEvent.blur(titleButton);
    fireEvent.focus(titleButton);
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip") === null).toBe(true));

    fireEvent.blur(titleButton);
    fireEvent.pointerMove(titleButton, { pointerType: "mouse" });
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    fireEvent.pointerDown(document.body, { pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("tooltip") === null).toBe(true));

    fireEvent.focus(titleButton);
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    fireEvent.blur(titleButton);
    await waitFor(() => expect(screen.queryByRole("tooltip") === null).toBe(true));
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
    await waitFor(() => expect(screen.queryByRole("tooltip") === null).toBe(true));
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
    await waitFor(() => expect(screen.queryByRole("tooltip") === null).toBe(true));
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
    await waitFor(() => expect(screen.queryByRole("tooltip") === null).toBe(true));

    const renamedProps = { ...props, title: "Renamed title" };
    fireEvent.focus(screen.getByRole("button", { name: "Renamed title" }));
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    rerender(<MobileAppShellLayout {...renamedProps} selectedProjectId="project-2" />);
    await waitFor(() => expect(screen.queryByRole("tooltip") === null).toBe(true));

    fireEvent.blur(screen.getByRole("button", { name: "Renamed title" }));
    fireEvent.focus(screen.getByRole("button", { name: "Renamed title" }));
    expect(await screen.findByRole("tooltip")).toBeTruthy();
    rerender(<MobileAppShellLayout {...renamedProps} selectedEnvironmentId="environment-2" />);
    await waitFor(() => expect(screen.queryByRole("tooltip") === null).toBe(true));
  });

  test("closes tools for a portaled context-menu action and restores trigger focus", async () => {
    renderLayout({
      actionBar: createPortal(
        <div data-slot="context-menu-item" role="menuitem" tabIndex={0}>
          Claude Native
        </div>,
        document.body,
      ),
    });

    const toolsButton = screen.getByRole("button", { name: "Open tools" });
    fireEvent.click(toolsButton);
    fireEvent.click(screen.getByRole("menuitem", { name: "Claude Native" }));

    expect(screen.queryByRole("dialog", { name: "Tools" }) === null).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(toolsButton));
  });

  test("keeps tools open when a nested control consumes Escape", () => {
    renderLayout({
      actionBar: (
        <button type="button" onKeyDown={(event) => event.preventDefault()}>
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

    expect(screen.queryByRole("dialog", { name: "Tools" }) === null).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(toolsButton));
  });

  test("starts closed when initialSidebarOpen is false and still opens on demand", () => {
    const { container, props, rerender } = renderLayout({ initialSidebarOpen: false });
    const trigger = getTitleBarSidebarTrigger(container);
    expect(screen.queryByRole("dialog", { name: "Projects and environments" }) === null).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Workspace")).toBeTruthy();

    rerender(<MobileAppShellLayout {...props} title="Updated workspace" />);
    expect(screen.queryByRole("dialog", { name: "Projects and environments" }) === null).toBe(true);
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Projects and environments" })).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  test("opens the project drawer on initial mobile entry and keeps workspace content mounted", async () => {
    renderLayout({}, { keepInitialDrawerOpen: true });
    expect(screen.getByText("Workspace")).toBeTruthy();
    const dialog = screen.getByRole("dialog", { name: "Projects and environments" });
    expect(dialog).toBeTruthy();
    expect(screen.getByText("Projects")).toBeTruthy();
    const drawerCloseButton = dialog.querySelector<HTMLButtonElement>("button.absolute.right-2");
    expect(drawerCloseButton).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(drawerCloseButton!));
  });

  test("closes the initial project drawer from its close button and restores trigger focus", async () => {
    const { container } = renderLayout({}, { keepInitialDrawerOpen: true });
    const menuButton = getTitleBarSidebarTrigger(container);
    const dialog = screen.getByRole("dialog", { name: "Projects and environments" });
    const drawerCloseButton = dialog.querySelector<HTMLButtonElement>("button.absolute.right-2");
    expect(drawerCloseButton).toBeTruthy();

    fireEvent.click(drawerCloseButton!);
    expect(screen.queryByRole("dialog", { name: "Projects and environments" }) === null).toBe(true);
    expect(screen.getByText("Workspace")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(menuButton));
  }, 20_000);

  test("toggles the project drawer closed with a second menu-button tap", () => {
    const { container } = renderLayout({}, { keepInitialDrawerOpen: true });
    const closeMenuButton = screen
      .getAllByRole("button", { name: "Close projects and environments" })
      .find((button) => button.hasAttribute("aria-controls"));
    expect(closeMenuButton).toBeTruthy();

    fireEvent.click(closeMenuButton!);
    expect(screen.queryByRole("dialog", { name: "Projects and environments" }) === null).toBe(true);

    const openMenuButton = getTitleBarSidebarTrigger(container);
    expect(openMenuButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(openMenuButton);
    expect(openMenuButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Projects and environments" })).toBeTruthy();
  });

  test("keeps the drawer open for a click on its backdrop that a press inside it began", () => {
    // A tap that opens a row's menu inside the drawer ends with a click that
    // lands on the backdrop, because the drawer stops taking pointer events
    // while the menu is open above it.
    renderLayout(
      { sidebar: <button type="button">Environment actions</button> },
      { keepInitialDrawerOpen: true },
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Environment actions" }), {
      pointerType: "touch",
    });
    fireEvent.click(document.querySelector("[data-slot='mobile-projects-overlay']")!);

    expect(screen.getByRole("dialog", { name: "Projects and environments" })).toBeTruthy();
  });

  test("gives way to a dialog requested from the drawer and returns focus to its trigger once it closes", async () => {
    const { container } = renderLayout({}, { keepInitialDrawerOpen: true });
    const menuButton = getTitleBarSidebarTrigger(container);
    // Stands in for the dialog `AppDialogHost` renders, which takes focus.
    const dialogControl = document.createElement("button");
    document.body.append(dialogControl);

    try {
      act(() => {
        useAppDialogStore
          .getState()
          .open({ kind: "environment-settings", environmentId: "environment-1" });
      });
      dialogControl.focus();

      expect(screen.queryByRole("dialog", { name: "Projects and environments" }) === null).toBe(
        true,
      );
      // The closing drawer leaves the dialog's focus alone.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(document.activeElement).toBe(dialogControl);

      act(() => useAppDialogStore.getState().close());
      expect(document.activeElement).toBe(menuButton);
    } finally {
      dialogControl.remove();
    }
  });

  test.each([
    [
      "global settings",
      () => useGlobalSettingsStore.getState().openSection("general"),
      () => useGlobalSettingsStore.getState().close(),
    ],
    [
      "the bug report sheet",
      () => useBugReportStore.getState().openSheet(),
      () => useBugReportStore.getState().closeSheet(),
    ],
  ])(
    "gives way to %s opened from the drawer and returns focus to its trigger",
    async (_name, open, close) => {
      const { container } = renderLayout({}, { keepInitialDrawerOpen: true });
      const menuButton = getTitleBarSidebarTrigger(container);
      // Stands in for the surface `AppShell` hosts, which takes focus.
      const surfaceControl = document.createElement("button");
      document.body.append(surfaceControl);
      try {
        act(open);
        surfaceControl.focus();
        expect(screen.queryByRole("dialog", { name: "Projects and environments" }) === null).toBe(
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(document.activeElement).toBe(surfaceControl);

        act(close);
        expect(document.activeElement).toBe(menuButton);
      } finally {
        surfaceControl.remove();
      }
    },
  );

  test("returns focus only once the last surface opened from the drawer closes", () => {
    const { container } = renderLayout({}, { keepInitialDrawerOpen: true });
    const menuButton = getTitleBarSidebarTrigger(container);
    const surfaceControl = document.createElement("button");
    document.body.append(surfaceControl);
    try {
      act(() => useGlobalSettingsStore.getState().openSection("machines"));
      act(() =>
        useAppDialogStore.getState().open({ kind: "repository-settings", projectId: "project-1" }),
      );
      surfaceControl.focus();
      act(() => useAppDialogStore.getState().close());
      // Settings are still open over the workspace.
      expect(document.activeElement).toBe(surfaceControl);
      act(() => useGlobalSettingsStore.getState().close());
      expect(document.activeElement).toBe(menuButton);
    } finally {
      surfaceControl.remove();
    }
  });

  test("returns focus to its trigger past the focus trap of the dialog that closes", async () => {
    // The real fullscreen settings layer, standing in for `AppDialogHost`: its
    // trap would pull focus back if the trigger took it before the layer unmounted.
    function RequestedSettings() {
      const request = useAppDialogStore((state) => state.request);
      const close = useAppDialogStore((state) => state.close);
      return (
        <FullscreenSettingsLayout
          open={request !== null}
          onOpenChange={(open) => {
            if (!open) close();
          }}
          title="Environment Settings"
          menuItems={[{ id: "general", label: "General", icon: null }]}
        >
          {() => <button type="button">Inside settings</button>}
        </FullscreenSettingsLayout>
      );
    }
    const { container } = renderLayout(
      { children: <RequestedSettings /> },
      { keepInitialDrawerOpen: true },
    );
    const menuButton = getTitleBarSidebarTrigger(container);

    act(() => {
      useAppDialogStore
        .getState()
        .open({ kind: "environment-settings", environmentId: "environment-1" });
    });
    const settings = await screen.findByRole("dialog", { name: "Environment Settings" });
    await waitFor(() => expect(settings.contains(document.activeElement)).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

    expectDomAbsent(screen.queryByRole("dialog", { name: "Environment Settings" }));
    expect(document.activeElement).toBe(menuButton);
  });

  test("leaves focus to a dialog requested while the drawer is closed", () => {
    const { container } = renderLayout();
    const menuButton = getTitleBarSidebarTrigger(container);
    const opener = document.createElement("button");
    document.body.append(opener);

    try {
      opener.focus();
      act(() => {
        useAppDialogStore
          .getState()
          .open({ kind: "environment-settings", environmentId: "environment-1" });
      });
      act(() => useAppDialogStore.getState().close());
      expect(document.activeElement).toBe(opener);
      expect(document.activeElement).not.toBe(menuButton);
    } finally {
      opener.remove();
    }
  });

  test("closes the initial drawer with Escape and restores trigger focus", async () => {
    const { container } = renderLayout({}, { keepInitialDrawerOpen: true });
    const menuButton = getTitleBarSidebarTrigger(container);

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Projects and environments" }) === null).toBe(
        true,
      );
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
      <MobileAppShellLayout {...props} selectedProjectId={null} selectedEnvironmentId={null} />,
    );
    expect(screen.getByRole("dialog", { name: "Projects and environments" })).toBeTruthy();

    rerender(
      <MobileAppShellLayout
        {...props}
        selectedProjectId="project-1"
        selectedEnvironmentId={null}
      />,
    );
    expect(screen.queryByRole("dialog", { name: "Projects and environments" }) === null).toBe(true);
  });

  test("closes the drawer when project or environment selection changes", () => {
    const { rerender, props } = renderLayout({}, { keepInitialDrawerOpen: true });
    rerender(<MobileAppShellLayout {...props} selectedEnvironmentId="environment-2" />);
    expect(screen.queryByRole("dialog", { name: "Projects and environments" }) === null).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Open projects and environments" }));
    rerender(<MobileAppShellLayout {...props} selectedProjectId="project-2" />);
    expect(screen.queryByRole("dialog", { name: "Projects and environments" }) === null).toBe(true);
  });

  test("closes the tools popover when the active selection changes", () => {
    const { rerender, props } = renderLayout();
    fireEvent.click(screen.getByRole("button", { name: "Open tools" }));
    rerender(<MobileAppShellLayout {...props} selectedEnvironmentId="environment-2" />);
    expect(screen.queryByRole("dialog", { name: "Tools" }) === null).toBe(true);
  });

  test("closes the tools popover when the active project changes", () => {
    const { rerender, props } = renderLayout();
    fireEvent.click(screen.getByRole("button", { name: "Open tools" }));
    rerender(<MobileAppShellLayout {...props} selectedProjectId="project-2" />);
    expect(screen.queryByRole("dialog", { name: "Tools" }) === null).toBe(true);
  });

  test("applies the central panel style and conditionally shows the files overlay", () => {
    const { rerender, props } = renderLayout();
    const workspaceMain = screen.getByText("Workspace").parentElement;
    expect(workspaceMain?.parentElement?.getAttribute("style")).toContain(
      "background-color: rgb(1, 2, 3)",
    );
    expect(screen.queryByRole("complementary", { name: "Workspace files" }) === null).toBe(true);
    expect(screen.queryByText("Files") === null).toBe(true);

    rerender(<MobileAppShellLayout {...props} filesPanelOpen />);
    expect(screen.getByRole("complementary", { name: "Workspace files" })).toBeTruthy();
    expect(screen.getByText("Files")).toBeTruthy();
  });
});

for (const action of [
  "delete-project",
  "repository-settings",
  "environment-settings",
  "createEnvironment",
] as const) {
  test(`closes the drawer for a remote ${action} request with no local selection`, async () => {
    const remote = useRemoteWorkspaceStore.getState();
    const ui = useUIStore.getState();
    const portal = portalStore.getState();
    try {
      portalStore.store.setState({ selfId: "bk_self" as never });
      useUIStore.setState({ selectedProjectId: null, selectedEnvironmentId: null });
      renderLayout(
        { selectedProjectId: null, selectedEnvironmentId: null },
        { keepInitialDrawerOpen: true },
      );
      expect(screen.getByRole("dialog", { name: "Projects and environments" })).toBeTruthy();
      act(() =>
        openMachineWorkspace({
          connectionId: "bk_remote",
          projectId: "project",
          environmentId: "env",
          title: "Remote",
          ...(action === "createEnvironment" ? { createEnvironment: true } : { dialog: action }),
        }),
      );
      await waitFor(() =>
        expectDomAbsent(screen.queryByRole("dialog", { name: "Projects and environments" })),
      );
      expect(useUIStore.getState().selectedProjectId).toBeNull();
      expect(useRemoteWorkspaceStore.getState().active?.nodeId).toBe("bk_remote");
    } finally {
      useRemoteWorkspaceStore.setState(remote, true);
      useUIStore.setState(ui, true);
      portalStore.store.setState(portal, true);
    }
  });
}

for (const remoteReport of [false, true]) {
  test(`drawer bottom bar opens ${remoteReport ? "remote" : "local"} bug report and yields the drawer`, async () => {
    const remote = useRemoteWorkspaceStore.getState();
    const portal = portalStore.getState();
    try {
      portalStore.store.setState({ selfId: "bk_self" as never });
      useRemoteWorkspaceStore.setState({
        ...remote,
        active: remoteReport ? { nodeId: "bk_remote", projectId: "p", environmentId: "e" } : null,
      });
      renderLayout({ sidebar: <SidebarBottomBar /> }, { keepInitialDrawerOpen: true });
      fireEvent.click(screen.getByRole("button", { name: "Report a bug" }));
      await waitFor(() =>
        expectDomAbsent(screen.queryByRole("dialog", { name: "Projects and environments" })),
      );
      if (remoteReport) {
        expect(useRemoteWorkspaceStore.getState().requests.bk_remote?.request).toMatchObject({
          bugReport: true,
          projectId: "p",
          environmentId: "e",
        });
      } else expect(useBugReportStore.getState().sheetOpen).toBe(true);
    } finally {
      useRemoteWorkspaceStore.setState(remote, true);
      portalStore.store.setState(portal, true);
    }
  });
}

test("drawer bottom bar opens global Settings and yields the drawer", async () => {
  const unsubscribe = onGlobalSettingsRequest((section) =>
    useGlobalSettingsStore.getState().openSection(section),
  );
  renderLayout({ sidebar: <SidebarBottomBar /> }, { keepInitialDrawerOpen: true });
  fireEvent.click(screen.getByRole("button", { name: "Global settings" }));
  await waitFor(() =>
    expectDomAbsent(screen.queryByRole("dialog", { name: "Projects and environments" })),
  );
  expect(useGlobalSettingsStore.getState().open).toBe(true);
  unsubscribe();
});
