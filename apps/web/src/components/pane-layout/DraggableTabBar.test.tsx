import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import type { PaneLeaf } from "@/types/paneLayout";
import { useFileDirtyStore } from "@/stores/fileDirtyStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useClaudeStore } from "@/stores/claudeStore";
import { createSessionKey } from "@/lib/utils";
import { invoke } from "@/lib/native/backend";
import { DraggableTabBar } from "./DraggableTabBar";

beforeEach(() => {
  useFileDirtyStore.setState({ dirtyFiles: new Map() });
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  (invoke as unknown as { mockClear: () => void }).mockClear();
  (invoke as unknown as {
    mockImplementation: (implementation: () => Promise<unknown>) => void;
  }).mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  cleanup();
  useFileDirtyStore.setState({ dirtyFiles: new Map() });
});

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
          type: "agent-native",
          nativeAgentData: { platform: "claude", environmentId: "environment" },
        },
        {
          id: "codex",
          type: "agent-native",
          nativeAgentData: { platform: "codex", environmentId: "environment" },
        },
        {
          id: "opencode",
          type: "agent-native",
          nativeAgentData: { platform: "opencode", environmentId: "environment" },
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

  test("clears a clean file buffer when the tab is explicitly closed", async () => {
    const environmentId = "environment";
    usePaneLayoutStore.getState().initialize("container", environmentId);
    usePaneLayoutStore.getState().addTab("default", {
      id: "file",
      type: "file",
      fileData: { filePath: "src/index.ts", containerId: "container" },
    }, environmentId);
    useFileDirtyStore.getState().setOriginalContent("file", "disk");
    const pane = usePaneLayoutStore.getState().getPane("default", environmentId)!;

    const { container } = render(
      <DndContext>
        <DraggableTabBar
          pane={pane}
          environmentId={environmentId}
          onTabSelect={() => undefined}
        />
      </DndContext>,
    );
    const close = container.querySelector("button");
    if (!close) throw new Error("close button missing");
    fireEvent.click(close);

    await waitFor(() => {
      expect(useFileDirtyStore.getState().dirtyFiles.has("file")).toBe(false);
      expect(
        usePaneLayoutStore.getState().getPane("default", environmentId)?.tabs,
      ).toEqual([]);
    });
  });

  test("clears a dirty file buffer after confirming discard", async () => {
    const environmentId = "environment";
    usePaneLayoutStore.getState().initialize("container", environmentId);
    usePaneLayoutStore.getState().addTab("default", {
      id: "dirty-file",
      type: "file",
      fileData: { filePath: "src/dirty.ts", containerId: "container" },
    }, environmentId);
    useFileDirtyStore.getState().hydrateDraft("dirty-file", "changed", "disk");
    const pane = usePaneLayoutStore.getState().getPane("default", environmentId)!;

    const { container } = render(
      <DndContext>
        <DraggableTabBar
          pane={pane}
          environmentId={environmentId}
          onTabSelect={() => undefined}
        />
      </DndContext>,
    );
    const close = container.querySelector("button");
    if (!close) throw new Error("close button missing");
    fireEvent.click(close);
    expect(screen.getByText("Unsaved Changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Without Saving" }));

    await waitFor(() => {
      expect(useFileDirtyStore.getState().dirtyFiles.has("dirty-file")).toBe(false);
      expect(
        usePaneLayoutStore.getState().getPane("default", environmentId)?.tabs,
      ).toEqual([]);
    });
  });

  test("deletes native compose storage and clears its store when closing a tab", async () => {
    const environmentId = "environment";
    const sessionKey = createSessionKey(environmentId, "claude-tab");
    usePaneLayoutStore.getState().initialize("container", environmentId);
    usePaneLayoutStore.getState().addTab("default", {
      id: "claude-tab",
      type: "agent-native",
      nativeAgentData: { platform: "claude", environmentId, containerId: "container" },
    }, environmentId);
    useClaudeStore.getState().setDraftText(sessionKey, "orphaned prompt");
    const pane = usePaneLayoutStore.getState().getPane("default", environmentId)!;

    const { container } = render(
      <DndContext>
        <DraggableTabBar
          pane={pane}
          environmentId={environmentId}
          onTabSelect={() => undefined}
        />
      </DndContext>,
    );
    const close = container.querySelector("button");
    if (!close) throw new Error("close button missing");
    fireEvent.click(close);

    await waitFor(() => {
      expect(useClaudeStore.getState().draftText.has(sessionKey)).toBe(false);
      expect(
        usePaneLayoutStore.getState().getPane("default", environmentId)?.tabs,
      ).toEqual([]);
    });
    expect(invoke).toHaveBeenCalledWith("delete_compose_draft", {
      draftKey: `claude:${environmentId}:${encodeURIComponent(sessionKey)}`,
      expectedRevision: 0,
    });
  });

  test("close all confirms mixed dirty tabs before removing the complete set", async () => {
    const environmentId = "environment";
    usePaneLayoutStore.getState().initialize("container", environmentId);
    usePaneLayoutStore.getState().addTab("default", {
      id: "dirty-file",
      type: "file",
      fileData: { filePath: "src/dirty.ts", containerId: "container" },
    }, environmentId);
    usePaneLayoutStore.getState().addTab("default", {
      id: "terminal",
      type: "plain",
    }, environmentId);
    useFileDirtyStore.getState().hydrateDraft("dirty-file", "changed", "disk");
    const pane = usePaneLayoutStore.getState().getPane("default", environmentId)!;

    render(
      <DndContext>
        <DraggableTabBar
          pane={pane}
          environmentId={environmentId}
          onTabSelect={() => undefined}
        />
      </DndContext>,
    );

    fireEvent.contextMenu(screen.getByText("Terminal 2"));
    fireEvent.click(await screen.findByText(/close all/i));
    expect(screen.getByText(/unsaved changes in dirty\.ts/i)).toBeTruthy();
    expect(usePaneLayoutStore.getState().getPane("default", environmentId)?.tabs)
      .toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Close Without Saving" }));
    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getPane("default", environmentId)?.tabs)
        .toEqual([]);
      expect(useFileDirtyStore.getState().dirtyFiles.has("dirty-file")).toBe(false);
    });
  });

  test("rechecks dirtiness after draft cleanup before closing all requested tabs", async () => {
    const environmentId = "environment";
    let resolveDelete!: () => void;
    const deletePending = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    (invoke as unknown as {
      mockImplementation: (
        implementation: (command: string) => Promise<unknown>,
      ) => void;
    }).mockImplementation((command) =>
      command === "delete_file_draft" ? deletePending : Promise.resolve()
    );
    usePaneLayoutStore.getState().initialize("container", environmentId);
    usePaneLayoutStore.getState().addTab("default", {
      id: "file",
      type: "file",
      fileData: { filePath: "src/racing.ts", containerId: "container" },
    }, environmentId);
    usePaneLayoutStore.getState().addTab("default", {
      id: "terminal",
      type: "plain",
    }, environmentId);
    useFileDirtyStore.getState().setOriginalContent("file", "disk");
    const pane = usePaneLayoutStore.getState().getPane("default", environmentId)!;

    render(
      <DndContext>
        <DraggableTabBar
          pane={pane}
          environmentId={environmentId}
          onTabSelect={() => undefined}
        />
      </DndContext>,
    );
    fireEvent.contextMenu(screen.getByText("Terminal 2"));
    fireEvent.click(await screen.findByText(/close all/i));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "delete_file_draft",
      expect.any(Object),
    ));

    useFileDirtyStore.getState().setContent("file", "changed while closing");
    resolveDelete();

    expect(await screen.findByText(/unsaved changes in racing\.ts/i)).toBeTruthy();
    expect(usePaneLayoutStore.getState().getPane("default", environmentId)?.tabs)
      .toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Close Without Saving" }));
    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getPane("default", environmentId)?.tabs)
        .toEqual([]);
    });
  });
});
