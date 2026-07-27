import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as realResizable from "@/components/ui/resizable";
import * as realFilesPanelComponents from "@/components/files-panel";
import * as realStores from "@/stores";
import * as realHooks from "@/hooks";
import * as realNativeWindow from "@/lib/native/window";
import * as realActionBar from "./ActionBar";
import * as realSidebar from "./Sidebar";
import * as realOpenFileDialog from "./OpenFileDialog";
import * as realMobileAppShellLayout from "./MobileAppShellLayout";
import * as realAgentInfoButton from "./AgentInfoButton";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { TabInfo } from "@/types/paneLayout";

const realAgentInfoButtonSnapshot = { ...realAgentInfoButton };
const realResizableSnapshot = { ...realResizable };
const realFilesPanelComponentsSnapshot = { ...realFilesPanelComponents };
const realStoresSnapshot = { ...realStores };
const realHooksSnapshot = { ...realHooks };
const realNativeWindowSnapshot = { ...realNativeWindow };
const realActionBarSnapshot = { ...realActionBar };
const realSidebarSnapshot = { ...realSidebar };
const realOpenFileDialogSnapshot = { ...realOpenFileDialog };
const realMobileAppShellLayoutSnapshot = { ...realMobileAppShellLayout };

let isMobile = true;
let selectedProjectId: string | null = "project-1";
let selectedEnvironmentId: string | null = "environment-1";
let filesPanelOpen = false;
const startDraggingMock = mock(async () => undefined);

function selectState<TState, TResult>(
  state: TState,
  selector?: (state: TState) => TResult,
): TResult | TState {
  return selector ? selector(state) : state;
}

mock.module("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div data-testid="resize-handle" />,
}));

mock.module("@/components/files-panel", () => ({
  FilesPanel: () => <div>Files panel</div>,
}));

mock.module("./ActionBar", () => ({
  ActionBar: ({ presentation = "bar" }: { presentation?: "bar" | "grid" }) => (
    <div data-testid="action-bar" data-presentation={presentation} />
  ),
}));

mock.module("./Sidebar", () => ({ Sidebar: () => <div>Sidebar</div> }));
mock.module("./OpenFileDialog", () => ({ OpenFileDialog: () => null }));
// The stub has to render `agentInfoButton`: silently dropping the slot made the
// whole agent-info wiring — including which tab it is handed — untestable.
mock.module("./MobileAppShellLayout", () => ({
  MobileAppShellLayout: ({
    title,
    actionBar,
    agentInfoButton,
    children,
  }: {
    title: string;
    actionBar: React.ReactNode;
    agentInfoButton: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <div data-testid="mobile-layout" data-title={title}>
      {actionBar}
      <div data-testid="mobile-agent-info-slot">{agentInfoButton}</div>
      {children}
    </div>
  ),
}));

// Stubbed (with restore) so the tab AppShell derives is observable as a prop
// rather than through the real popover's rendering.
mock.module("./AgentInfoButton", () => ({
  AgentInfoButton: ({ activeTab, mobile }: { activeTab: TabInfo | null; mobile?: boolean }) => (
    <div
      data-testid="agent-info-button"
      data-active-tab-id={activeTab?.id ?? "none"}
      data-active-tab-type={activeTab?.type ?? "none"}
      data-mobile={String(mobile ?? false)}
    />
  ),
}));

mock.module("@/hooks", () => ({
  ...realHooksSnapshot,
  useMediaQuery: () => isMobile,
}));

mock.module("@/stores", () => ({
  ...realStoresSnapshot,
  useFilesPanelStore: <T,>(selector?: (state: { isOpen: boolean }) => T) =>
    selectState({ isOpen: filesPanelOpen }, selector),
  useUIStore: <T,>(selector?: (state: {
    selectedProjectId: string | null;
    selectedEnvironmentId: string | null;
  }) => T) => selectState({ selectedProjectId, selectedEnvironmentId }, selector),
  useProjectStore: <T,>(selector?: (state: {
    projects: Array<{ id: string; name: string }>;
  }) => T) => selectState({ projects: [{ id: "project-1", name: "pgstack1" }] }, selector),
  useEnvironmentStore: <T,>(selector?: (state: {
    environments: Array<{ id: string; name: string }>;
  }) => T) => selectState({ environments: [{ id: "environment-1", name: "feature-auth" }] }, selector),
  useConfigStore: <T,>(selector?: (state: {
    config: { global: { terminalAppearance?: undefined } };
  }) => T) => selectState({ config: { global: {} } }, selector),
}));

mock.module("@/lib/native/window", () => ({
  getCurrentWindow: () => ({ startDragging: startDraggingMock }),
}));

const { AppShell } = await import("./AppShell");

afterAll(() => {
  mock.module("@/components/ui/resizable", () => realResizableSnapshot);
  mock.module("@/components/files-panel", () => realFilesPanelComponentsSnapshot);
  mock.module("@/stores", () => realStoresSnapshot);
  mock.module("@/hooks", () => realHooksSnapshot);
  mock.module("@/lib/native/window", () => realNativeWindowSnapshot);
  mock.module("./ActionBar", () => realActionBarSnapshot);
  mock.module("./Sidebar", () => realSidebarSnapshot);
  mock.module("./OpenFileDialog", () => realOpenFileDialogSnapshot);
  mock.module("./MobileAppShellLayout", () => realMobileAppShellLayoutSnapshot);
  mock.module("./AgentInfoButton", () => realAgentInfoButtonSnapshot);
});

function seedPaneLayout(tabs: TabInfo[], activeTabId: string | null, activePaneId = "pane-a") {
  usePaneLayoutStore.setState({
    environments: new Map([
      [
        "environment-1",
        {
          root: {
            kind: "split",
            id: "root",
            direction: "horizontal",
            children: [
              { kind: "leaf", id: "pane-a", tabs, activeTabId },
              {
                kind: "leaf",
                id: "pane-b",
                tabs: [{ id: "other-tab", type: "plain" }],
                activeTabId: "other-tab",
              },
            ],
          },
          activePaneId,
          containerId: "container-1",
        },
      ],
    ]),
    activeEnvironmentId: "environment-1",
  } as never);
}

const CLAUDE_TAB = {
  id: "claude-tab",
  type: "claude-native",
  claudeNativeData: { environmentId: "environment-1", sessionId: "session-1" },
} as TabInfo;

beforeEach(() => {
  isMobile = true;
  selectedProjectId = "project-1";
  selectedEnvironmentId = "environment-1";
  filesPanelOpen = false;
  startDraggingMock.mockReset();
  document.title = "";
  usePaneLayoutStore.setState({
    environments: new Map(),
    activeEnvironmentId: null,
  } as never);
});

afterEach(() => {
  cleanup();
  usePaneLayoutStore.setState({
    environments: new Map(),
    activeEnvironmentId: null,
  } as never);
});

describe("AppShell", () => {
  test("derives the mobile title and uses the grid action presentation", () => {
    render(<AppShell>Workspace</AppShell>);

    expect(screen.getByTestId("mobile-layout").getAttribute("data-title")).toBe(
      "pgstack1 - feature-auth",
    );
    expect(screen.getByTestId("action-bar").getAttribute("data-presentation")).toBe("grid");
    expect(document.title).toBe("pgstack1 - feature-auth");
    expect(screen.getByText("Workspace")).toBeTruthy();
  });

  test("derives the desktop title, uses the bar presentation, and starts window dragging", () => {
    isMobile = false;
    const { container } = render(<AppShell>Workspace</AppShell>);

    expect(screen.getByText("Orkestrator AI - pgstack1")).toBeTruthy();
    expect(screen.getByTestId("action-bar").getAttribute("data-presentation")).toBe("bar");
    expect(document.title).toBe("Orkestrator AI - pgstack1");

    const titleBar = container.querySelector("div[data-backend-drag-region]");
    expect(titleBar).toBeTruthy();
    fireEvent.mouseDown(titleBar!, { button: 2 });
    expect(startDraggingMock).not.toHaveBeenCalled();
    fireEvent.mouseDown(titleBar!, { button: 0 });
    expect(startDraggingMock).toHaveBeenCalledTimes(1);
  });

  test("mounts the agent-info button in the desktop title bar outside the drag region", () => {
    isMobile = false;
    seedPaneLayout([CLAUDE_TAB], "claude-tab");
    const { container } = render(<AppShell>Workspace</AppShell>);

    const slot = screen.getByTestId("desktop-agent-info-slot");
    const titleBar = container.querySelector("div[data-backend-drag-region]")!;
    expect(titleBar.contains(slot)).toBe(true);
    expect(slot.contains(screen.getByTestId("agent-info-button"))).toBe(true);
    expect(screen.getByTestId("agent-info-button").getAttribute("data-mobile")).toBe("false");

    /*
     * The title bar starts a window drag on every left mouse-down. Without the
     * `no-drag` region and the mouse-down stop, clicking the button dragged the
     * window instead of opening the panel — the desktop entry point for the
     * whole feature.
     */
    fireEvent.mouseDown(screen.getByTestId("agent-info-button"), { button: 0 });
    expect(startDraggingMock).not.toHaveBeenCalled();

    // The bar itself still drags, so the guard is scoped to the button.
    fireEvent.mouseDown(titleBar, { button: 0 });
    expect(startDraggingMock).toHaveBeenCalledTimes(1);
  });

  test("mounts the agent-info button in the mobile title bar in mobile form", () => {
    seedPaneLayout([CLAUDE_TAB], "claude-tab");
    render(<AppShell>Workspace</AppShell>);

    const slot = screen.getByTestId("mobile-agent-info-slot");
    expect(slot.contains(screen.getByTestId("agent-info-button"))).toBe(true);
    expect(screen.getByTestId("agent-info-button").getAttribute("data-mobile")).toBe("true");
    expect(screen.queryByTestId("desktop-agent-info-slot")).toBeNull();
  });

  test("resolves the active tab through the active pane of the selected environment", () => {
    // The memo walks every leaf, picks the *active* pane, then that pane's
    // active tab: a pane-b tab must not be handed to the button.
    seedPaneLayout([CLAUDE_TAB], "claude-tab", "pane-a");
    const { rerender } = render(<AppShell>Workspace</AppShell>);
    expect(screen.getByTestId("agent-info-button").getAttribute("data-active-tab-id")).toBe(
      "claude-tab",
    );
    expect(screen.getByTestId("agent-info-button").getAttribute("data-active-tab-type")).toBe(
      "claude-native",
    );

    act(() => {
      seedPaneLayout([CLAUDE_TAB], "claude-tab", "pane-b");
    });
    rerender(<AppShell>Workspace</AppShell>);
    expect(screen.getByTestId("agent-info-button").getAttribute("data-active-tab-id")).toBe(
      "other-tab",
    );
  });

  test.each([
    ["no environment is selected", () => {
      selectedEnvironmentId = null;
      seedPaneLayout([CLAUDE_TAB], "claude-tab");
    }],
    ["the environment has no pane state", () => {
      usePaneLayoutStore.setState({
        environments: new Map(),
        activeEnvironmentId: null,
      } as never);
    }],
    ["the active pane has no active tab", () => {
      seedPaneLayout([CLAUDE_TAB], null);
    }],
    ["the active tab id matches nothing in the pane", () => {
      seedPaneLayout([CLAUDE_TAB], "missing-tab");
    }],
  ])("hands the button no tab when %s", (_label, seed) => {
    seed();
    render(<AppShell>Workspace</AppShell>);
    expect(screen.getByTestId("agent-info-button").getAttribute("data-active-tab-id")).toBe("none");
  });

  test("falls back to the product title when selection records are unavailable", () => {
    selectedProjectId = "missing-project";
    selectedEnvironmentId = "missing-environment";
    render(<AppShell />);

    expect(screen.getByTestId("mobile-layout").getAttribute("data-title")).toBe("Orkestrator AI");
    expect(document.title).toBe("Orkestrator AI");
  });
});
