import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import type { PaneLeaf } from "@/types/paneLayout";
import { DraggableTabBar } from "./DraggableTabBar";

afterEach(cleanup);

describe("DraggableTabBar", () => {
  test("renders nothing for an empty pane", () => {
    const pane: PaneLeaf = { kind: "leaf", id: "pane", tabs: [], activeTabId: null };
    const { container } = render(
      <DraggableTabBar pane={pane} environmentId="environment" onTabSelect={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("renders a horizontally scrollable touch-height tab bar and selects a tab", () => {
    const onTabSelect = mock(() => undefined);
    const pane: PaneLeaf = {
      kind: "leaf",
      id: "pane",
      activeTabId: "terminal",
      tabs: [{ id: "terminal", type: "plain" }],
    };
    const { container } = render(
      <DndContext>
        <DraggableTabBar pane={pane} environmentId="environment" onTabSelect={onTabSelect} />
      </DndContext>,
    );

    const tabBar = container.querySelector(".overflow-x-auto");
    expect(tabBar?.className).toContain("min-h-[40px]");
    expect(tabBar?.className).toContain("md:min-h-[32px]");
    expect(tabBar?.className).toContain("bg-background");
    fireEvent.click(screen.getByText("Terminal 1"));
    expect(onTabSelect).toHaveBeenCalledWith("terminal");
  });

  test("requests server refreshes only for server-backed agent tabs", () => {
    const onTabRefresh = mock(() => undefined);
    const pane: PaneLeaf = {
      kind: "leaf",
      id: "pane",
      activeTabId: "claude",
      tabs: [
        {
          id: "claude",
          type: "claude-native",
          claudeNativeData: { environmentId: "environment" },
        },
        {
          id: "codex",
          type: "codex-native",
          codexNativeData: { environmentId: "environment" },
        },
        {
          id: "opencode",
          type: "opencode-native",
          openCodeNativeData: { environmentId: "environment" },
        },
        {
          id: "tmux",
          type: "claude-tmux",
          claudeTmuxData: { environmentId: "environment" },
        },
        { id: "browser", type: "browser", browserData: { url: "http://localhost:3000/" } },
        { id: "terminal", type: "plain" },
      ],
    };

    render(
      <DndContext>
        <DraggableTabBar
          pane={pane}
          environmentId="environment"
          onTabSelect={() => undefined}
          onTabRefresh={onTabRefresh}
        />
      </DndContext>,
    );

    for (const [label, tabId] of [
      ["Claude 1", "claude"],
      ["Codex 2", "codex"],
      ["OpenCode 3", "opencode"],
      ["Claude 4", "tmux"],
      ["Browser 5", "browser"],
    ] as const) {
      fireEvent.contextMenu(screen.getByText(label));
      fireEvent.click(screen.getByText("Refresh"));
      expect(onTabRefresh).toHaveBeenLastCalledWith(tabId);
    }

    expect(onTabRefresh).toHaveBeenCalledTimes(5);
    fireEvent.contextMenu(screen.getByText("Terminal 6"));
    expect(screen.queryByText("Refresh")).toBeNull();
  });
});
