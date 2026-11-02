import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realResizable from "@/components/ui/resizable";
import * as realFilesPanelComponents from "@/components/files-panel";
import * as realStores from "@/stores";
import * as realHooks from "@/hooks";
import * as realNativeWindow from "@/lib/native/window";
import * as realActionBar from "./ActionBar";
import * as realSidebar from "./Sidebar";
import * as realOpenFileDialog from "./OpenFileDialog";
import * as realAgentInfoButton from "./AgentInfoButton";
import * as realSystemUsageIndicator from "./SystemUsageIndicator";
import * as realRealmTitleBar from "@/components/federation/RealmTitleBar";
import * as realAgentMailPanel from "@/components/agent-mail/AgentMailPanel";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { usePrMonitorStore } from "@/stores/prMonitorStore";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { portalStore } from "@/lib/portal/portal-store";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  sharedIdDataset,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { ProjectSearchBar } from "@/components/sidebar/ProjectSearchBar";
import { requestAppShortcut, onAppShortcut } from "@/lib/app-shortcuts";
import { useUIStore as realUIStore } from "@/stores/uiStore";
import type { TabInfo } from "@/types/paneLayout";

const uiStore = realUIStore;
const realAgentInfoButtonSnapshot = { ...realAgentInfoButton };
const realSystemUsageIndicatorSnapshot = { ...realSystemUsageIndicator };
const realRealmTitleBarSnapshot = { ...realRealmTitleBar };
const realAgentMailPanelSnapshot = { ...realAgentMailPanel };
const INITIAL_PORTAL = portalStore.getState();
const INITIAL_REMOTE = useRemoteWorkspaceStore.getState();
const realResizableSnapshot = { ...realResizable };
const realFilesPanelComponentsSnapshot = { ...realFilesPanelComponents };
const realStoresSnapshot = { ...realStores };
const realHooksSnapshot = { ...realHooks };
const realNativeWindowSnapshot = { ...realNativeWindow };
const realActionBarSnapshot = { ...realActionBar };
const realSidebarSnapshot = { ...realSidebar };
const realOpenFileDialogSnapshot = { ...realOpenFileDialog };

let isMobile = true;
let selectedProjectId: string | null = "project-1";
let selectedEnvironmentId: string | null = "environment-1";
let filesPanelOpen = false;
/** PR fields of the selected environment record, for the ready-to-merge title. */
let selectedEnvironmentPr: Record<string, unknown> = {};
let mountSearch = false;
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

mock.module("./Sidebar", () => ({
  Sidebar: () => (
    <div>
      Sidebar
      {mountSearch && (
        <ProjectSearchBar
          projects={[]}
          environments={[]}
          onSelectProject={() => {}}
          onSelectEnvironment={() => {}}
        />
      )}
    </div>
  ),
}));
mock.module("./OpenFileDialog", () => ({ OpenFileDialog: () => null }));
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

// The real poll is exercised in its own suite; here it only needs to be
// observable as a slot so the desktop/mobile split can be asserted.
mock.module("./SystemUsageIndicator", () => ({
  SystemUsageIndicator: () => <div data-testid="system-usage-indicator" />,
}));

// Another node's title-bar controls, exercised in their own suite.
mock.module("@/components/federation/RealmTitleBar", () => ({
  RealmSystemUsageMeters: ({ nodeId }: { nodeId: string }) => (
    <div data-testid="realm-system-usage-meters" data-node={nodeId} />
  ),
  RealmAgentInfoTrigger: ({ nodeId }: { nodeId: string }) => (
    <div data-testid="realm-agent-info-trigger" data-node={nodeId} />
  ),
  RealmTitleBarPanels: () => <div data-testid="realm-title-bar-panels" />,
  useRealmPanelDismiss: () => undefined,
}));

// Observable as a slot: the banner's View opens it in whichever layout is shown.
mock.module("@/components/agent-mail/AgentMailPanel", () => ({
  AgentMailPanel: () => <div data-testid="agent-mail-panel-host" />,
}));

mock.module("@/hooks", () => ({
  ...realHooksSnapshot,
  useMediaQuery: () => isMobile,
}));

mock.module("@/stores", () => ({
  ...realStoresSnapshot,
  useFilesPanelStore: <T,>(selector?: (state: { isOpen: boolean; activeTab: string }) => T) =>
    selectState({ isOpen: filesPanelOpen, activeTab: "changes" }, selector),
  useUIStore: Object.assign(
    <T,>(selector?: (state: ReturnType<typeof uiStore.getState>) => T) =>
      uiStore((state) =>
        selectState({ ...state, selectedProjectId, selectedEnvironmentId }, selector),
      ),
    { getState: uiStore.getState, subscribe: uiStore.subscribe },
  ),
  useProjectStore: <T,>(
    selector?: (state: { projects: Array<{ id: string; name: string }> }) => T,
  ) => selectState({ projects: [{ id: "project-1", name: "pgstack1" }] }, selector),
  useEnvironmentStore: <T,>(
    selector?: (state: {
      environments: Array<{ id: string; name: string }>;
      isDeleting: (id: string) => boolean;
    }) => T,
  ) =>
    selectState(
      {
        environments: [{ id: "environment-1", name: "feature-auth", ...selectedEnvironmentPr }],
        isDeleting: () => selectedEnvironmentPr.lifecycleOperation === "deleting",
      },
      selector,
    ),
  useConfigStore: <T,>(
    selector?: (state: { config: { global: { terminalAppearance?: undefined } } }) => T,
  ) => selectState({ config: { global: {} } }, selector),
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
  mock.module("./AgentInfoButton", () => realAgentInfoButtonSnapshot);
  mock.module("./SystemUsageIndicator", () => realSystemUsageIndicatorSnapshot);
  mock.module("@/components/federation/RealmTitleBar", () => realRealmTitleBarSnapshot);
  mock.module("@/components/agent-mail/AgentMailPanel", () => realAgentMailPanelSnapshot);
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
  type: "agent-native",
  nativeAgentData: { environmentId: "environment-1", sessionId: "session-1" },
} as TabInfo;

beforeEach(() => {
  isMobile = true;
  selectedProjectId = "project-1";
  selectedEnvironmentId = "environment-1";
  filesPanelOpen = false;
  selectedEnvironmentPr = {};
  useBuildPipelineStore.setState({ activeBuildEnvironmentIds: new Set() });
  usePrMonitorStore.setState({ states: new Map(), syncStatus: "idle" });
  uiStore.setState({ sidebarOpen: true });
  mountSearch = false;
  startDraggingMock.mockReset();
  document.title = "";
  usePaneLayoutStore.setState({
    environments: new Map(),
    activeEnvironmentId: null,
  } as never);
});

afterEach(() => {
  cleanup();
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
  usePaneLayoutStore.setState({
    environments: new Map(),
    activeEnvironmentId: null,
  } as never);
});

describe("AppShell", () => {
  test("an open files sheet stays hidden over a remote workspace across layout changes", () => {
    filesPanelOpen = true;
    isMobile = false;
    act(() => useRemoteWorkspaceStore.getState().open("bk_a", {}));
    const view = render(<AppShell>Workspace</AppShell>);
    expect(screen.queryByText("Files panel")).toBeNull();

    isMobile = true;
    view.rerender(<AppShell>Workspace</AppShell>);
    expect(screen.queryByRole("complementary", { name: "Workspace files" })).toBeNull();
    expect(screen.queryByText("Files panel")).toBeNull();
    expect(filesPanelOpen).toBe(true);

    // Returning to the local workspace reveals the retained sheet state.
    act(() => useRemoteWorkspaceStore.getState().showLocal());
    expect(screen.getByRole("complementary", { name: "Workspace files" })).toBeTruthy();
    expect(screen.getByText("Files panel")).toBeTruthy();
  });

  test("derives the mobile title and uses the grid action presentation", () => {
    const { container } = render(<AppShell>Workspace</AppShell>);

    expect(
      screen.getByRole("button", { name: "pgstack1 - feature-auth", hidden: true }),
    ).toBeTruthy();
    expect(screen.getByTestId("action-bar").getAttribute("data-presentation")).toBe("grid");
    expect(document.title).toBe("pgstack1 - feature-auth");
    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(container.firstElementChild?.classList.contains("h-full")).toBe(true);
    expect(container.firstElementChild?.classList.contains("w-full")).toBe(true);
    expect(container.firstElementChild?.classList.contains("h-dvh")).toBe(false);
  });

  test("the mobile title shimmers the selected environment while its PR is ready to merge", () => {
    const prUrl = "https://github.com/acme/pgstack1/pull/4";
    selectedEnvironmentPr = {
      prUrl,
      prState: "open",
      hasMergeConflicts: false,
      prMergeability: "clean",
      environmentType: "local",
      status: "stopped",
    };
    usePrMonitorStore.setState({
      syncStatus: "current",
      states: new Map([
        [
          "environment-1",
          {
            environmentId: "environment-1",
            mode: "normal",
            checkInProgress: false,
            consecutiveErrors: 0,
            lastCheckAt: "2026-10-28T10:00:00.000Z",
            lastSuccessfulCheckAt: "2026-10-28T10:00:00.000Z",
            prUrl,
            prState: "open",
            hasMergeConflicts: false,
            checkSummary: null,
          },
        ],
      ]),
    });
    render(<AppShell>Workspace</AppShell>);

    const title = screen.getByRole("button", { name: "pgstack1 - feature-auth", hidden: true });
    expect(title.querySelector("[data-merge-ready]")?.textContent).toBe("feature-auth");
    // The document title stays plain text.
    expect(document.title).toBe("pgstack1 - feature-auth");

    act(() =>
      usePrMonitorStore.setState((state) => ({
        states: new Map(
          [...state.states].map(([id, reading]) => [id, { ...reading, hasMergeConflicts: true }]),
        ),
      })),
    );
    // No environment refresh follows: the monitor event must immediately veto
    // the still-clean environment snapshot on its own.
    expect(title.querySelector("[data-merge-ready]") === null).toBe(true);
    act(() =>
      usePrMonitorStore.setState((state) => ({
        states: new Map(
          [...state.states].map(([id, reading]) => [id, { ...reading, hasMergeConflicts: false }]),
        ),
      })),
    );
    expect(title.querySelector("[data-merge-ready]")).toBeTruthy();
    act(() => usePrMonitorStore.getState().setSyncStatus("stale"));
    expect(
      screen
        .getByRole("button", { name: "pgstack1 - feature-auth", hidden: true })
        .querySelector("[data-merge-ready]") === null,
    ).toBe(true);
  });

  test.each([
    ["needs-answer", "Waiting for your answer"],
    ["merge-conflicts", "Merge conflicts to resolve"],
    ["merge-ready", "Ready to merge"],
  ])("mobile title describes %s and clears it during deletion", async (signal, label) => {
    selectedEnvironmentPr = {
      environmentType: "local",
      status: "running",
      agentActivityState: signal === "needs-answer" ? "waiting" : "idle",
      agentActivityUpdatedAt: "2026-10-28T10:00:00Z",
      prUrl: "https://github.com/acme/repo/pull/1",
      prState: "open",
      hasMergeConflicts: signal === "merge-conflicts",
      prMergeability: signal === "merge-conflicts" ? "dirty" : "clean",
    };
    usePrMonitorStore.setState({
      syncStatus: "current",
      states: new Map([
        [
          "environment-1",
          {
            environmentId: "environment-1",
            mode: "normal",
            checkInProgress: false,
            consecutiveErrors: 0,
            lastSuccessfulCheckAt: "2026-10-28T10:00:00Z",
            lastCheckAt: "2026-10-28T10:00:00Z",
            prUrl: selectedEnvironmentPr.prUrl as string,
            prState: "open",
            hasMergeConflicts: signal === "merge-conflicts",
            checkSummary: null,
          },
        ],
      ]),
    });
    const view = render(<AppShell>Workspace</AppShell>);
    const title = screen.getByRole("button", { name: "pgstack1 - feature-auth", hidden: true });
    expect(title.querySelector(`[data-name-signal="${signal}"]`)).toBeTruthy();
    expect(document.getElementById(title.getAttribute("aria-describedby")!)?.textContent).toBe(
      label,
    );
    if (signal === "needs-answer") {
      act(() =>
        useBuildPipelineStore.setState({ activeBuildEnvironmentIds: new Set(["environment-1"]) }),
      );
      expect(title.querySelector('[data-name-signal="merge-ready"]')).toBeTruthy();
      act(() => useBuildPipelineStore.setState({ activeBuildEnvironmentIds: new Set() }));
      expect(title.querySelector('[data-name-signal="needs-answer"]')).toBeTruthy();
    }
    fireEvent.pointerDown(title, { pointerType: "touch" });
    fireEvent.click(title);
    expect((await screen.findByRole("tooltip")).textContent).toContain(label);
    selectedEnvironmentPr = { ...selectedEnvironmentPr, lifecycleOperation: "deleting" };
    view.rerender(<AppShell>Workspace</AppShell>);
    expect(title.querySelector(".text-shimmer") === null).toBe(true);
    const describedText = (title.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(describedText).not.toContain(label);
    expect(screen.queryByRole("tooltip")?.textContent ?? "").not.toContain(label);
  });

  test("remote mobile titles stay plain for current clean summaries without monitor health", async () => {
    const data = sharedIdDataset("idle");
    Object.assign(data.environments["project-1"]![0]!, {
      prUrl: "https://github.com/acme/repo/pull/4",
      prState: "open",
      hasMergeConflicts: false,
      prMergeability: "clean",
      environmentType: "local",
    });
    installDesktopFake({
      list: connectionList([remoteConnection("leaf", "Leaf", "teal")]),
      datasets: { leaf: data },
    });
    useRemoteWorkspaceStore.setState({
      active: { nodeId: "bk_leaf", projectId: "project-1", environmentId: "env-1" },
    });
    try {
      render(
        <FederationProvider>
          <AppShell>Workspace</AppShell>
        </FederationProvider>,
      );
      await waitFor(() => expect(portalStore.getState().nodes).toHaveLength(1));
      const node = portalStore.getState().nodes[0]!;
      expect(node.available).toBe(true);
      expect(node.freshness).toBe("current");
      expect(node.environments[0]?.prState).toBe("open");
      expect(node.environments[0]?.prHasMergeConflicts).toBe(false);
      expect(node.environments[0]?.prMergeability).toBe("clean");
      const title = screen.getByRole("button", { name: "app - feature", hidden: true });
      expect(document.title).toBe("app - feature");
      expect(title.querySelector("[data-merge-ready]") === null).toBe(true);
      // A freshly hydrated clean summary is also what a failed leaf monitor
      // or a restarted leaf can return. Neither proves a successful PR check.
      act(() =>
        portalStore.store.setState({
          nodes: portalStore.getState().nodes.map((node) => ({ ...node, freshness: "stale" })),
        }),
      );
      expect(
        screen
          .getByRole("button", { name: "app - feature", hidden: true })
          .querySelector("[data-merge-ready]") === null,
      ).toBe(true);
    } finally {
      cleanup();
      uninstallDesktopFake();
      portalStore.store.setState(INITIAL_PORTAL, true);
    }
  });

  test("derives the desktop title, uses the bar presentation, and starts window dragging", () => {
    isMobile = false;
    const { container } = render(<AppShell>Workspace</AppShell>);

    expect(screen.getByText("Orkestrator AI - pgstack1")).toBeTruthy();
    expect(screen.getByTestId("action-bar").getAttribute("data-presentation")).toBe("bar");
    expect(document.title).toBe("Orkestrator AI - pgstack1");

    const titleBar = container.querySelector("div[data-backend-drag-region]");
    expect(titleBar).toBeTruthy();
    expect(titleBar?.className).toContain("h-[var(--desktop-title-bar-height)]");
    // The title sits at the left, clear of the macOS traffic lights, and the
    // bar carries the same bottom rule as the toolbar below it.
    expect(titleBar?.className).toContain("justify-start");
    expect(titleBar?.className).toContain("pl-[var(--desktop-title-bar-inset)]");
    expect(titleBar?.className).toContain("border-b");
    expect(titleBar?.className).toContain("border-border/80");
    fireEvent.mouseDown(titleBar!, { button: 2 });
    expect(startDraggingMock).not.toHaveBeenCalled();
    fireEvent.mouseDown(titleBar!, { button: 0 });
    expect(startDraggingMock).toHaveBeenCalledTimes(1);
  });

  test("hides the left panel once the sidebar is toggled closed", () => {
    isMobile = false;
    const { rerender } = render(<AppShell>Workspace</AppShell>);
    expect(screen.getByText("Sidebar")).toBeTruthy();

    expect(screen.getByTestId("resize-handle")).toBeTruthy();

    act(() => uiStore.setState({ sidebarOpen: false }));
    rerender(<AppShell>Workspace</AppShell>);
    expect(screen.queryByText("Sidebar") === null).toBe(true);
    expect(screen.queryByTestId("resize-handle") === null).toBe(true);

    act(() => uiStore.setState({ sidebarOpen: true }));
    rerender(<AppShell>Workspace</AppShell>);
    expect(screen.getByText("Sidebar")).toBeTruthy();
    expect(screen.getByTestId("resize-handle")).toBeTruthy();
  });

  test("search reveals the hidden desktop sidebar and delivers the pending request exactly once", async () => {
    isMobile = false;
    mountSearch = true;
    uiStore.setState({ sidebarOpen: false });
    const { rerender } = render(<AppShell>Workspace</AppShell>);
    expect(screen.queryByText("Sidebar") === null).toBe(true);
    fireEvent.keyDown(document.body, { key: "k", code: "KeyK", metaKey: true });
    await waitFor(() => expect(screen.getByTestId("project-search-dialog")).toBeTruthy());
    expect(uiStore.getState().sidebarOpen).toBe(true);
    const input = screen.getByRole("combobox");
    await waitFor(() => expect(document.activeElement).toBe(input));
    // A second delivery would toggle the just-mounted search closed.
    rerender(<AppShell>Workspace</AppShell>);
    expect(screen.getByTestId("project-search-dialog")).toBeTruthy();
    act(() => {
      requestAppShortcut("search-projects");
    });
    await waitFor(() => expect(screen.queryByTestId("project-search-dialog") === null).toBe(true));
    // A later mount must not replay the consumed request.
    cleanup();
    render(<AppShell>Workspace</AppShell>);
    expect(screen.queryByTestId("project-search-dialog") === null).toBe(true);
  });

  test("a closed mobile drawer drops search without opening or replaying it", () => {
    isMobile = false;
    const { rerender } = render(<AppShell>Workspace</AppShell>);
    isMobile = true;
    rerender(<AppShell>Workspace</AppShell>);
    expect(screen.queryByRole("dialog", { name: "Projects and environments" }) === null).toBe(true);
    act(() => {
      requestAppShortcut("search-projects");
    });
    expect(screen.queryByRole("dialog", { name: "Projects and environments" }) === null).toBe(true);
    const delivered = mock(() => {});
    const dispose = onAppShortcut("search-projects", delivered);
    expect(delivered).not.toHaveBeenCalled();
    dispose();
  });

  test("a realm skips the shell's hidden-sidebar fallback", () => {
    isMobile = false;
    uiStore.setState({ sidebarOpen: false });
    const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
    const href = window.location.href;
    happyDOM.setURL("https://node.test/?realm=workspace&workspace=w1");
    try {
      render(<AppShell>Workspace</AppShell>);
      act(() => {
        requestAppShortcut("search-projects");
      });
      expect(uiStore.getState().sidebarOpen).toBe(false);
      expect(screen.queryByText("Sidebar") === null).toBe(true);
    } finally {
      cleanup();
      happyDOM.setURL(href);
    }
    // Neither realm routing nor its unmount queues work in this shell.
    const delivered = mock(() => {});
    const dispose = onAppShortcut("search-projects", delivered);
    expect(delivered).not.toHaveBeenCalled();
    dispose();
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
    expect(screen.queryByTestId("desktop-agent-info-slot") === null).toBe(true);
  });

  test("mounts the system usage meters in the desktop title bar but not in mobile", () => {
    isMobile = false;
    render(<AppShell>Workspace</AppShell>);
    const slot = screen.getByTestId("desktop-agent-info-slot");
    const meters = screen.getByTestId("system-usage-indicator");
    const separator = screen.getByTestId("title-bar-usage-separator");
    expect(slot.contains(meters)).toBe(true);
    expect(slot.contains(separator)).toBe(true);
    expect(separator.getAttribute("aria-hidden")).toBe("true");
    expect(separator.className).toContain("mx-2");
    expect(separator.className).toContain("bg-border/50");
    const slotChildren = Array.from(slot.children);
    expect(slotChildren[0]).toBe(meters);
    expect(slotChildren[1]).toBe(separator);
    expect(slotChildren[2]?.contains(screen.getByTestId("agent-info-button"))).toBe(true);

    cleanup();
    isMobile = true;
    render(<AppShell>Workspace</AppShell>);
    expect(screen.queryByTestId("system-usage-indicator") === null).toBe(true);
    expect(screen.queryByTestId("title-bar-usage-separator") === null).toBe(true);
  });

  test("shows another node's meters and agent button in the same title-bar places", () => {
    isMobile = false;
    act(() =>
      useRemoteWorkspaceStore.setState({
        active: { nodeId: "bk_a", projectId: "project-9", environmentId: "environment-9" },
      }),
    );
    render(<AppShell>Workspace</AppShell>);
    const slot = screen.getByTestId("desktop-agent-info-slot");
    const meters = screen.getByTestId("realm-system-usage-meters");
    const slotChildren = Array.from(slot.children);
    expect(slotChildren[0]).toBe(meters);
    expect(slotChildren[1]).toBe(screen.getByTestId("title-bar-usage-separator"));
    expect(slotChildren[2]?.contains(screen.getByTestId("realm-agent-info-trigger"))).toBe(true);
    expect(meters.getAttribute("data-node")).toBe("bk_a");
    // This window's own node's controls are not shown for another node's workspace.
    expect(screen.queryByTestId("system-usage-indicator") === null).toBe(true);
    expect(screen.queryByTestId("agent-info-button") === null).toBe(true);
  });

  test("a realm draws the title bar's popovers instead of controls in its toolbar", () => {
    isMobile = false;
    const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
    const originalHref = window.location.href;
    happyDOM.setURL("https://node.test/?realm=workspace&workspace=w1");
    try {
      render(<AppShell>Workspace</AppShell>);
      expect(screen.getByTestId("realm-title-bar-panels")).toBeTruthy();
      expect(screen.queryByTestId("system-usage-indicator") === null).toBe(true);
      expect(screen.queryByTestId("agent-info-button") === null).toBe(true);
    } finally {
      happyDOM.setURL(originalHref);
    }
  });

  test("a realm hosts the messages panel its tabs' mail banners open", () => {
    isMobile = false;
    const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
    const originalHref = window.location.href;
    happyDOM.setURL("https://node.test/?realm=workspace&workspace=w1");
    try {
      render(<AppShell>Workspace</AppShell>);
      expect(screen.getByTestId("agent-mail-panel-host")).toBeTruthy();
    } finally {
      happyDOM.setURL(originalHref);
    }
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
      "agent-native",
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
    [
      "no environment is selected",
      () => {
        selectedEnvironmentId = null;
        seedPaneLayout([CLAUDE_TAB], "claude-tab");
      },
    ],
    [
      "the environment has no pane state",
      () => {
        usePaneLayoutStore.setState({
          environments: new Map(),
          activeEnvironmentId: null,
        } as never);
      },
    ],
    [
      "the active pane has no active tab",
      () => {
        seedPaneLayout([CLAUDE_TAB], null);
      },
    ],
    [
      "the active tab id matches nothing in the pane",
      () => {
        seedPaneLayout([CLAUDE_TAB], "missing-tab");
      },
    ],
  ])("hands the button no tab when %s", (_label, seed) => {
    seed();
    render(<AppShell>Workspace</AppShell>);
    expect(screen.getByTestId("agent-info-button").getAttribute("data-active-tab-id")).toBe("none");
  });

  test("falls back to the product title when selection records are unavailable", () => {
    selectedProjectId = "missing-project";
    selectedEnvironmentId = "missing-environment";
    render(<AppShell />);

    expect(screen.getByRole("button", { name: "Orkestrator AI", hidden: true })).toBeTruthy();
    expect(document.title).toBe("Orkestrator AI");
  });

  test("keeps its content mounted when the layout crosses the mobile breakpoint", () => {
    let mounts = 0;
    function Counter() {
      const [count, setCount] = useState(0);
      useEffect(() => {
        mounts += 1;
      }, []);
      return <button onClick={() => setCount(count + 1)}>Count {count}</button>;
    }
    isMobile = false;
    const { rerender } = render(
      <AppShell>
        <Counter />
      </AppShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Count 0" }));
    screen.getByRole("button", { name: "Count 1" }).focus();

    isMobile = true;
    rerender(
      <AppShell>
        <Counter />
      </AppShell>,
    );
    expect(screen.getByRole("main").contains(screen.getByText("Count 1"))).toBe(true);
    // The move between layouts keeps what the user was typing into focused.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Count 1" }));
    expect(screen.queryByRole("dialog", { name: "Projects and environments" }) === null).toBe(true);

    isMobile = false;
    rerender(
      <AppShell>
        <Counter />
      </AppShell>,
    );
    expect(screen.queryByRole("button", { name: "Open projects and environments" }) === null).toBe(
      true,
    );
    expect(screen.getByRole("main").contains(screen.getByText("Count 1"))).toBe(true);
    expect(mounts).toBe(1);
  });

  test("opens the mobile drawer only on a phone-sized first load", () => {
    render(<AppShell>Workspace</AppShell>);
    expect(screen.getByRole("dialog", { name: "Projects and environments" })).toBeTruthy();
    cleanup();

    isMobile = false;
    const { rerender } = render(<AppShell>Workspace</AppShell>);
    isMobile = true;
    rerender(<AppShell>Workspace</AppShell>);
    expect(screen.queryByRole("dialog", { name: "Projects and environments" }) === null).toBe(true);
    const trigger = screen.getByRole("button", { name: "Open projects and environments" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Projects and environments" })).toBeTruthy();
  });
});
