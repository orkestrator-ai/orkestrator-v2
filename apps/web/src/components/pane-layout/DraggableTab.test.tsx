import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realSortable from "@dnd-kit/sortable";
import * as realUtilities from "@dnd-kit/utilities";
import type { TabInfo } from "@/types/paneLayout";
import { useSessionStore } from "@/stores/sessionStore";
import { useClaudeStore, createClaudeSessionKey } from "@/stores/claudeStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useFileDirtyStore } from "@/stores";

const realSortableSnapshot = { ...realSortable };
const realUtilitiesSnapshot = { ...realUtilities };

mock.module("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: null,
    isDragging: false,
  }),
}));

mock.module("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: { toString: () => "" },
  },
}));

const { DraggableTab } = await import("./DraggableTab");

afterAll(() => {
  mock.module("@dnd-kit/sortable", () => realSortableSnapshot);
  mock.module("@dnd-kit/utilities", () => realUtilitiesSnapshot);
});

function renderTab(tab: TabInfo, index = 0) {
  return render(
    <DraggableTab
      tab={tab}
      paneId="pane-1"
      index={index}
      isActive={false}
      canClose
      onSelect={() => {}}
    />,
  );
}

describe("DraggableTab title precedence", () => {
  beforeEach(() => {
    cleanup();
    useSessionStore.setState({ sessions: new Map() });
    useClaudeStore.setState({ sessions: new Map() });
    useBuildPipelineStore.setState({ pipelines: new Map() });
    useFileDirtyStore.setState({ dirtyFiles: new Map() });
  });

  afterEach(() => {
    cleanup();
  });

  test("session.name beats every other source", () => {
    const tab: TabInfo = {
      id: "tab-a",
      type: "claude-native",
      displayTitle: "Review",
      claudeNativeData: { environmentId: "env-1" },
    };

    useSessionStore.setState({
      sessions: new Map([
        ["sess-1", {
          id: "sess-1",
          environmentId: "env-1",
          tabId: "tab-a",
          name: "Custom",
          status: "connected",
          sessionType: "claude",
          containerId: "c-1",
          createdAt: "2024-01-01T00:00:00.000Z",
          lastActivityAt: "2024-01-01T00:00:00.000Z",
          order: 0,
        }],
      ]),
    });
    useClaudeStore.setState({
      sessions: new Map([
        [createClaudeSessionKey("env-1", "tab-a"), { title: "Auto Title" } as never],
      ]),
    });

    renderTab(tab, 2);

    expect(screen.getByText("Custom 3")).toBeDefined();
  });

  test("claudeSessionTitle beats displayTitle once the agent has named the session", () => {
    const tab: TabInfo = {
      id: "tab-a",
      type: "claude-native",
      displayTitle: "Review",
      claudeNativeData: { environmentId: "env-1" },
    };

    useClaudeStore.setState({
      sessions: new Map([
        [createClaudeSessionKey("env-1", "tab-a"), { title: "Auto Title" } as never],
      ]),
    });

    renderTab(tab, 0);

    expect(screen.getByText("Auto Title")).toBeDefined();
  });

  test("displayTitle is used when no claude session title exists", () => {
    const tab: TabInfo = {
      id: "tab-a",
      type: "codex-native",
      displayTitle: "Review",
      codexNativeData: { environmentId: "env-1" },
    };

    renderTab(tab, 0);

    expect(screen.getByText("Review 1")).toBeDefined();
  });

  test("displayTitle includes the tab number from index + 1", () => {
    const tab: TabInfo = {
      id: "tab-a",
      type: "codex-native",
      displayTitle: "PR",
      codexNativeData: { environmentId: "env-1" },
    };

    renderTab(tab, 4);

    expect(screen.getByText("PR 5")).toBeDefined();
  });

  test("falls back to type-default when no title sources are present", () => {
    const tab: TabInfo = {
      id: "tab-a",
      type: "codex-native",
      codexNativeData: { environmentId: "env-1" },
    };

    renderTab(tab, 1);

    expect(screen.getByText("Codex 2")).toBeDefined();
  });

  test("claude-tmux tab falls back to the Claude default label", () => {
    const tab: TabInfo = {
      id: "tab-tmux",
      type: "claude-tmux",
      claudeTmuxData: { environmentId: "env-1" },
    };
    renderTab(tab, 0);
    expect(screen.getByText("Claude 1")).toBeDefined();
  });

  test("claude-tmux tab uses displayTitle when provided", () => {
    const tab: TabInfo = {
      id: "tab-tmux",
      type: "claude-tmux",
      displayTitle: "Custom Tmux",
      claudeTmuxData: { environmentId: "env-1" },
    };
    renderTab(tab, 2);
    expect(screen.getByText("Custom Tmux 3")).toBeDefined();
  });

  test("browser tabs use the browser label", () => {
    renderTab({ id: "browser-a", type: "browser", browserData: { url: "" } }, 1);
    expect(screen.getByText("Browser 2")).toBeDefined();
  });

  test("file tab title uses the basename and ignores displayTitle", () => {
    const tab: TabInfo = {
      id: "tab-a",
      type: "file",
      displayTitle: "Should not show",
      fileData: { filePath: "src/components/Foo/Bar.tsx" },
    };

    renderTab(tab, 0);

    expect(screen.getByText("Bar.tsx")).toBeDefined();
  });
});

describe("DraggableTab tooltip and context menu structure", () => {
  beforeEach(() => {
    cleanup();
    useSessionStore.setState({ sessions: new Map() });
    useClaudeStore.setState({ sessions: new Map() });
    useBuildPipelineStore.setState({ pipelines: new Map() });
    useFileDirtyStore.setState({ dirtyFiles: new Map() });
  });

  afterEach(() => {
    cleanup();
  });

  test("shows a path tooltip for file tabs", async () => {
    const tab: TabInfo = {
      id: "tab-file",
      type: "file",
      fileData: { filePath: "src/components/Foo/Bar.tsx" },
    };

    renderTab(tab, 0);

    const trigger = screen.getByText("Bar.tsx").closest("div");
    expect(trigger).toBeTruthy();
    fireEvent.mouseEnter(trigger!);

    await waitFor(() => {
      expect(screen.getByText("src/components/Foo/Bar.tsx")).toBeTruthy();
    });
  });

  test("does not wrap the title of a non-file tab in a tooltip trigger", () => {
    const tab: TabInfo = {
      id: "tab-terminal",
      type: "plain",
    };

    renderTab(tab, 0);

    expect(screen.getByText("Terminal 1").getAttribute("data-slot")).toBeNull();
  });

  test("marks an active tab with an accent even when its pane is not focused", () => {
    const { container } = render(
      <DraggableTab
        tab={{ id: "tab-terminal", type: "plain" }}
        paneId="pane-1"
        index={0}
        isActive
        isFocused={false}
        canClose={false}
        onSelect={() => {}}
      />,
    );

    const indicator = container.querySelector("[aria-hidden='true'].bg-primary");
    expect(indicator).toBeTruthy();
    expect(indicator?.className).toContain("opacity-60");
  });

  test("renders a close button that calls onClose without selecting the tab", () => {
    const onClose = mock(() => {});
    const onSelect = mock(() => {});

    render(
      <DraggableTab
        tab={{ id: "tab-terminal", type: "plain" }}
        paneId="pane-1"
        index={0}
        isActive={false}
        canClose
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(onClose).toHaveBeenCalledTimes(1);
    // handleClose stops propagation so the tab is not also selected.
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("does not render a close button when canClose is false", () => {
    render(
      <DraggableTab
        tab={{ id: "tab-terminal", type: "plain" }}
        paneId="pane-1"
        index={0}
        isActive={false}
        canClose={false}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
  });

  test("exposes the close actions through the context menu", () => {
    const onClose = mock(() => {});

    render(
      <DraggableTab
        tab={{ id: "tab-terminal", type: "plain" }}
        paneId="pane-1"
        index={0}
        isActive={false}
        canClose
        onSelect={() => {}}
        onClose={onClose}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Terminal 1"));

    expect(screen.getByText("Close")).toBeDefined();
    expect(screen.getByText("Close all")).toBeDefined();
    expect(screen.getByText("Close others")).toBeDefined();
    expect(screen.getByText("Close to the right")).toBeDefined();
    expect(screen.queryByText("Refresh")).toBeNull();

    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("exposes Refresh for server-backed agent tabs", () => {
    const onRefresh = mock(() => {});

    render(
      <DraggableTab
        tab={{
          id: "tab-claude",
          type: "claude-native",
          claudeNativeData: { environmentId: "env-1" },
        }}
        paneId="pane-1"
        index={0}
        isActive={false}
        canClose
        onSelect={() => {}}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Claude 1"));
    fireEvent.click(screen.getByText("Refresh"));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
