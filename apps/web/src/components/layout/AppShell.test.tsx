import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as realResizable from "@/components/ui/resizable";
import * as realFilesPanelComponents from "@/components/files-panel";
import * as realStores from "@/stores";
import * as realHooks from "@/hooks";
import * as realNativeWindow from "@/lib/native/window";
import * as realActionBar from "./ActionBar";
import * as realSidebar from "./Sidebar";
import * as realOpenFileDialog from "./OpenFileDialog";
import * as realMobileAppShellLayout from "./MobileAppShellLayout";

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
mock.module("./MobileAppShellLayout", () => ({
  MobileAppShellLayout: ({
    title,
    actionBar,
    children,
  }: {
    title: string;
    actionBar: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <div data-testid="mobile-layout" data-title={title}>
      {actionBar}
      {children}
    </div>
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
});

beforeEach(() => {
  isMobile = true;
  selectedProjectId = "project-1";
  selectedEnvironmentId = "environment-1";
  filesPanelOpen = false;
  startDraggingMock.mockReset();
  document.title = "";
});

afterEach(cleanup);

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

  test("falls back to the product title when selection records are unavailable", () => {
    selectedProjectId = "missing-project";
    selectedEnvironmentId = "missing-environment";
    render(<AppShell />);

    expect(screen.getByTestId("mobile-layout").getAttribute("data-title")).toBe("Orkestrator AI");
    expect(document.title).toBe("Orkestrator AI");
  });
});
