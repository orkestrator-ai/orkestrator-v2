import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { DndContext, KeyboardSensor, useSensor, useSensors } from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { PaneLeaf } from "@/types/paneLayout";
import { createPaneTabElementId } from "@/types/paneLayout";
import { useFileDirtyStore } from "@/stores/fileDirtyStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { multiReviewStore } from "@/stores/multiReviewStore";
import { tabLaunchStore } from "@/stores/tabLaunchStore";
import { createSessionKey } from "@/lib/utils";
import { invoke } from "@/lib/native/backend";
import { DraggableTabBar } from "./DraggableTabBar";
import { TAB_STRIP_CLASS, WORKSPACE_BAR_HEIGHT_CLASS } from "./TabShell";
import { appCommandStore } from "@/test/app-command-store";

beforeEach(() => {
  useFileDirtyStore.setState({ dirtyFiles: new Map() });
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  appCommandStore(multiReviewStore).setState({ workflows: new Map() });
  (invoke as unknown as { mockClear: () => void }).mockClear();
  (
    invoke as unknown as {
      mockImplementation: (implementation: () => Promise<unknown>) => void;
    }
  ).mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  cleanup();
  useFileDirtyStore.setState({ dirtyFiles: new Map() });
});

describe("DraggableTabBar", () => {
  test("renders nothing for an empty pane", () => {
    const pane: PaneLeaf = { kind: "leaf", id: "pane", tabs: [], activeTabId: null };
    const { container } = renderInAppCommandScope(
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
    const { container } = renderInAppCommandScope(
      <DndContext>
        <DraggableTabBar pane={pane} environmentId="environment" onTabSelect={onTabSelect} />
      </DndContext>,
    );

    const tabBar = container.querySelector(".overflow-x-auto");
    expect(TAB_STRIP_CLASS).toContain(WORKSPACE_BAR_HEIGHT_CLASS);
    for (const token of WORKSPACE_BAR_HEIGHT_CLASS.split(" ")) {
      expect(tabBar?.className).toContain(token);
    }
    expect(tabBar?.className).toContain("bg-background");
    // The rule below the strip is the same declaration the action bar uses
    // above it, so the row is bounded by one hairline on each side rather than
    // two that only look alike.
    expect(tabBar?.className).toContain("border-b");
    expect(tabBar?.className).toContain("border-border/80");
    fireEvent.click(screen.getByText("Terminal 1"));
    expect(onTabSelect).toHaveBeenCalledWith("terminal");
  });

  describe("tab semantics", () => {
    const environmentId = "environment";

    function renderStrip(ids: string[], activeTabId = ids[0]!) {
      usePaneLayoutStore.getState().initialize("container", environmentId);
      for (const id of ids) {
        usePaneLayoutStore.getState().addTab("default", { id, type: "plain" }, environmentId);
      }
      usePaneLayoutStore.getState().setActiveTab("default", activeTabId, environmentId);
      function Strip() {
        const pane = usePaneLayoutStore((state) => state.getPane("default", environmentId))!;
        return (
          <DraggableTabBar
            pane={pane}
            environmentId={environmentId}
            onTabSelect={(tabId) =>
              usePaneLayoutStore.getState().setActiveTab("default", tabId, environmentId)
            }
          />
        );
      }
      // The real sensors, so the keys below reach the drag the way the app's do.
      function Sensors({ children }: { children: ReactNode }) {
        const sensors = useSensors(
          useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
        );
        return (
          <DndContext sensors={sensors} onDragStart={onDragStart}>
            {children}
          </DndContext>
        );
      }
      return renderInAppCommandScope(
        <Sensors>
          <Strip />
        </Sensors>,
      );
    }

    const onDragStart = mock(() => undefined);
    const paneTabIds = () =>
      usePaneLayoutStore
        .getState()
        .getPane("default", environmentId)
        ?.tabs.map((tab) => tab.id);

    beforeEach(() => onDragStart.mockClear());

    test("exposes a tablist of one focusable tab per tab, with no other tab stops", () => {
      const { container } = renderStrip(["one", "two"], "two");

      const strip = screen.getByRole("tablist", { name: "Environment tabs" });
      const tabs = within(strip).getAllByRole("tab");
      expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
        "Terminal 1",
        "Terminal 2",
      ]);
      expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]);
      expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, 0]);
      const stops = Array.from(container.querySelectorAll<HTMLElement>("*")).filter(
        (element) => element.tabIndex === 0,
      );
      expect(stops).toEqual(tabs);
    });

    test("Delete closes the focused tab and hands focus to the one in its place", async () => {
      renderStrip(["one", "two", "three"]);
      const two = screen.getByRole("tab", { name: "Terminal 2" });
      two.focus();

      fireEvent.keyDown(two, { key: "Delete", code: "Delete" });

      await waitFor(() => expect(paneTabIds()).toEqual(["one", "three"]));
      await waitFor(() => {
        expect(document.activeElement?.getAttribute("aria-label")).toBe("Terminal 2");
      });
      // The first tab stays selected: closing another does not move the selection.
      expect(screen.getByRole("tab", { name: "Terminal 1" }).getAttribute("aria-selected")).toBe(
        "true",
      );
    });

    test("closing the last tab in the strip hands focus to the one before it", async () => {
      renderStrip(["one", "two"], "two");
      const two = screen.getByRole("tab", { name: "Terminal 2" });
      two.focus();

      fireEvent.keyDown(two, { key: "Delete", code: "Delete" });

      await waitFor(() => expect(paneTabIds()).toEqual(["one"]));
      await waitFor(() => {
        expect(document.activeElement?.getAttribute("aria-label")).toBe("Terminal 1");
      });
    });

    test("a surface that took focus while the tab closed keeps it", async () => {
      const { container } = renderStrip(["one", "two"]);
      const terminal = document.createElement("textarea");
      container.append(terminal);
      const two = screen.getByRole("tab", { name: "Terminal 2" });
      two.focus();

      fireEvent.keyDown(two, { key: "Delete", code: "Delete" });
      terminal.focus();

      await waitFor(() => expect(paneTabIds()).toEqual(["one"]));
      expect(document.activeElement).toBe(terminal);
    });

    test("Delete on a dirty file asks first, and Cancel leaves the tab open", async () => {
      usePaneLayoutStore.getState().initialize("container", environmentId);
      usePaneLayoutStore.getState().addTab(
        "default",
        {
          id: "dirty-file",
          type: "file",
          fileData: { filePath: "src/dirty.ts", containerId: "container" },
        },
        environmentId,
      );
      useFileDirtyStore.getState().hydrateDraft("dirty-file", "changed", "disk");
      const pane = usePaneLayoutStore.getState().getPane("default", environmentId)!;
      renderInAppCommandScope(
        <DndContext>
          <DraggableTabBar
            pane={pane}
            environmentId={environmentId}
            onTabSelect={() => undefined}
          />
        </DndContext>,
      );

      fireEvent.keyDown(screen.getByRole("tab", { name: "dirty.ts, unsaved changes" }), {
        key: "Delete",
        code: "Delete",
      });
      fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

      expect(paneTabIds()).toEqual(["dirty-file"]);
    });

    for (const fromMenu of [false, true]) {
      test(`dirty keyboard close restores focus after async confirmation (${fromMenu ? "menu" : "Delete"})`, async () => {
        renderStrip(["one"]);
        usePaneLayoutStore.getState().addTab(
          "default",
          {
            id: "dirty",
            type: "file",
            fileData: { filePath: "dirty.ts", containerId: "container" },
          },
          environmentId,
        );
        useFileDirtyStore.getState().hydrateDraft("dirty", "changed", "disk");
        const tab = await screen.findByRole("tab", { name: "dirty.ts, unsaved changes" });
        tab.focus();
        if (fromMenu) {
          fireEvent.keyDown(tab, { key: "ContextMenu" });
          const close = await screen.findByRole("menuitem", { name: /^Close$/ });
          close.focus();
          fireEvent.keyDown(close, { key: "Enter" });
        } else fireEvent.keyDown(tab, { key: "Delete" });
        let finish!: () => void;
        (
          invoke as unknown as { mockImplementation: (fn: () => Promise<unknown>) => void }
        ).mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        );
        const confirm = await screen.findByRole("button", { name: "Close Without Saving" });
        confirm.focus();
        fireEvent.click(confirm);
        await waitFor(() => expect(finish).toBeDefined());
        expect(paneTabIds()).toContain("dirty");
        finish();
        await waitFor(() => expect(paneTabIds()).toEqual(["one"]));
        await waitFor(() => expect(screen.queryByRole("alertdialog") === null).toBe(true));
        await waitFor(() =>
          expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Terminal 1" })),
        );
      });
    }

    test.each(["file", "review"])(
      "failed keyboard %s close cannot hand off focus after a later pointer close",
      async (kind) => {
        renderStrip(["one"]);
        usePaneLayoutStore.getState().addTab(
          "default",
          {
            id: "file",
            type: kind === "file" ? "file" : "multi-review",
            fileData:
              kind === "file" ? { filePath: "file.ts", containerId: "container" } : undefined,
            multiReviewTabData:
              kind === "review" ? { environmentId, workflowId: "failed-review" } : undefined,
          },
          environmentId,
        );
        appCommandStore(multiReviewStore).setState({
          workflows: new Map([["failed-review", { phase: "cancelled" } as never]]),
        });
        await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
        const tab = screen.getAllByRole("tab")[1]!;
        (
          invoke as unknown as { mockImplementation: (fn: () => Promise<unknown>) => void }
        ).mockImplementation(() => Promise.reject(new Error("discard unavailable")));
        tab.focus();
        fireEvent.keyDown(tab, { key: "Delete" });
        await waitFor(() => expect(invoke).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(paneTabIds()).toContain("file");
        (
          invoke as unknown as { mockImplementation: (fn: () => Promise<unknown>) => void }
        ).mockImplementation(() => Promise.resolve());
        fireEvent.click(within(tab).getByRole("button"));
        await waitFor(() => expect(paneTabIds()).toEqual(["one"]));
        expect(document.activeElement).not.toBe(screen.getByRole("tab", { name: "Terminal 1" }));
      },
    );

    test("arrow keys, Home and End move focus without selecting", () => {
      renderStrip(["one", "two", "three"]);
      const [one, two, three] = screen.getAllByRole("tab");
      one!.focus();

      fireEvent.keyDown(one!, { key: "ArrowRight" });
      expect(document.activeElement).toBe(two!);
      fireEvent.keyDown(two!, { key: "End" });
      expect(document.activeElement).toBe(three!);
      fireEvent.keyDown(three!, { key: "ArrowRight" });
      expect(document.activeElement).toBe(one!);
      fireEvent.keyDown(one!, { key: "ArrowLeft" });
      expect(document.activeElement).toBe(three!);
      fireEvent.keyDown(three!, { key: "Home" });
      expect(document.activeElement).toBe(one!);

      expect(one!.getAttribute("aria-selected")).toBe("true");
      expect(two!.getAttribute("aria-selected")).toBe("false");
    });

    test("a modified arrow key stays with whatever else owns it", () => {
      renderStrip(["one", "two"]);
      const one = screen.getByRole("tab", { name: "Terminal 1" });
      one.focus();

      fireEvent.keyDown(one, { key: "ArrowRight", altKey: true });

      expect(document.activeElement).toBe(one);
    });

    test("arrow keys stay with the drag while a tab is being dragged", () => {
      const pane: PaneLeaf = {
        kind: "leaf",
        id: "pane",
        activeTabId: "one",
        tabs: [
          { id: "one", type: "plain" },
          { id: "two", type: "plain" },
        ],
      };
      renderInAppCommandScope(
        <DndContext>
          <DraggableTabBar
            pane={pane}
            environmentId={environmentId}
            onTabSelect={() => undefined}
            activeDragId="tab:one:pane:pane"
          />
        </DndContext>,
      );
      const one = screen.getByRole("tab", { name: "Terminal 1" });
      one.focus();

      fireEvent.keyDown(one, { key: "ArrowRight" });

      expect(document.activeElement).toBe(one);
    });

    test("Space picks the tab up through the real sensor, and Enter selects instead", () => {
      renderStrip(["one", "two"]);
      const two = screen.getByRole("tab", { name: "Terminal 2" });
      two.focus();

      fireEvent.keyDown(two, { key: "Enter", code: "Enter" });
      expect(onDragStart).not.toHaveBeenCalled();
      expect(two.getAttribute("aria-selected")).toBe("true");

      fireEvent.keyDown(two, { key: " ", code: "Space" });
      expect(onDragStart).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    });
  });

  test("a launching tab joins the tablist as the selected tab and selects by keyboard", () => {
    const environmentId = "environment";
    usePaneLayoutStore.getState().initialize("container", environmentId);
    usePaneLayoutStore
      .getState()
      .addTab("default", { id: "terminal", type: "plain" }, environmentId);
    appCommandStore(tabLaunchStore).setState({
      launches: new Map([
        [
          environmentId,
          [{ tabId: "launch", title: "Claude", focused: true, arrived: false } as never],
        ],
      ]),
    });
    const pane = usePaneLayoutStore.getState().getPane("default", environmentId)!;
    try {
      renderInAppCommandScope(
        <DndContext>
          <DraggableTabBar
            pane={pane}
            environmentId={environmentId}
            onTabSelect={() => undefined}
            isPaneFocused
          />
        </DndContext>,
      );

      const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
      expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]);
      expect(tabs[1]?.getAttribute("tabindex")).toBe("0");
      expect(tabs[1]?.id).toBe(createPaneTabElementId(environmentId, "default", "launch"));

      for (const key of ["Enter", " "]) {
        appCommandStore(tabLaunchStore).setState({
          launches: new Map([
            [
              environmentId,
              [{ tabId: "launch", title: "Claude", focused: false, arrived: false } as never],
            ],
          ]),
        });
        fireEvent.keyDown(screen.getByTestId("tab-launch-placeholder"), { key });
        expect(
          appCommandStore(tabLaunchStore).getState().launches.get(environmentId)?.[0]?.focused,
        ).toBe(true);
      }
    } finally {
      appCommandStore(tabLaunchStore).setState({ launches: new Map() });
    }
  });

  test("requests refreshes only for server-backed tabs", () => {
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
        {
          id: "multi-review",
          type: "multi-review",
          multiReviewTabData: {
            environmentId: "environment",
            workflowId: "workflow",
          },
        },
        { id: "terminal", type: "plain" },
      ],
    };

    renderInAppCommandScope(
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
      ["Multi Review 6", "multi-review"],
    ] as const) {
      fireEvent.contextMenu(screen.getByText(label));
      fireEvent.click(screen.getByText("Refresh"));
      expect(onTabRefresh).toHaveBeenLastCalledWith(tabId);
    }

    expect(onTabRefresh).toHaveBeenCalledTimes(6);
    fireEvent.contextMenu(screen.getByText("Terminal 7"));
    expect(screen.queryByText("Refresh") === null).toBe(true);
  });

  test("clears a clean file buffer when the tab is explicitly closed", async () => {
    const environmentId = "environment";
    usePaneLayoutStore.getState().initialize("container", environmentId);
    usePaneLayoutStore.getState().addTab(
      "default",
      {
        id: "file",
        type: "file",
        fileData: { filePath: "src/index.ts", containerId: "container" },
      },
      environmentId,
    );
    useFileDirtyStore.getState().setOriginalContent("file", "disk");
    const pane = usePaneLayoutStore.getState().getPane("default", environmentId)!;

    const { container } = renderInAppCommandScope(
      <DndContext>
        <DraggableTabBar pane={pane} environmentId={environmentId} onTabSelect={() => undefined} />
      </DndContext>,
    );
    const close = container.querySelector("button");
    if (!close) throw new Error("close button missing");
    fireEvent.click(close);

    await waitFor(() => {
      expect(useFileDirtyStore.getState().dirtyFiles.has("file")).toBe(false);
      expect(usePaneLayoutStore.getState().getPane("default", environmentId)?.tabs).toEqual([]);
    });
  });

  test("sends one backend teardown intent before closing a Multi Review parent tab", async () => {
    const environmentId = "environment";
    usePaneLayoutStore.getState().initialize("container", environmentId);
    usePaneLayoutStore.getState().addTab(
      "default",
      {
        id: "multi-review",
        type: "multi-review",
        multiReviewTabData: {
          environmentId,
          workflowId: "workflow-1",
        },
      },
      environmentId,
    );
    appCommandStore(multiReviewStore).setState({
      workflows: new Map([["workflow-1", { phase: "cancelled" } as never]]),
    });
    const pane = usePaneLayoutStore.getState().getPane("default", environmentId)!;

    const { container } = renderInAppCommandScope(
      <DndContext>
        <DraggableTabBar pane={pane} environmentId={environmentId} onTabSelect={() => undefined} />
      </DndContext>,
    );
    const close = container.querySelector("button");
    if (!close) throw new Error("close button missing");
    fireEvent.click(close);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("delete_multi_review_workflow", {
        workflowId: "workflow-1",
      });
      expect(usePaneLayoutStore.getState().getPane("default", environmentId)?.tabs).toEqual([]);
    });
  });

  test.each(["reviewing", "failed"] as const)(
    "hides a %s Multi Review parent without tearing down its workflow",
    async (phase) => {
      const environmentId = "environment";
      usePaneLayoutStore.getState().initialize("container", environmentId);
      usePaneLayoutStore.getState().addTab(
        "default",
        {
          id: "multi-review",
          type: "multi-review",
          multiReviewTabData: { environmentId, workflowId: "workflow-1" },
        },
        environmentId,
      );
      appCommandStore(multiReviewStore).setState({
        workflows: new Map([["workflow-1", { phase } as never]]),
      });
      const pane = usePaneLayoutStore.getState().getPane("default", environmentId)!;

      const { container } = renderInAppCommandScope(
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
        expect(usePaneLayoutStore.getState().getPane("default", environmentId)?.tabs).toEqual([]);
      });
      expect(invoke).not.toHaveBeenCalledWith("delete_multi_review_workflow", expect.anything());
    },
  );

  test("closing a reviewer tab never tears down its parent workflow", async () => {
    const environmentId = "environment";
    usePaneLayoutStore.getState().initialize("container", environmentId);
    usePaneLayoutStore.getState().addTab(
      "default",
      {
        id: "multi-reviewer",
        type: "multi-review",
        multiReviewTabData: {
          environmentId,
          workflowId: "workflow-1",
          reviewerId: "reviewer-1",
        },
      },
      environmentId,
    );
    appCommandStore(multiReviewStore).setState({
      workflows: new Map([["workflow-1", { phase: "cancelled" } as never]]),
    });
    const pane = usePaneLayoutStore.getState().getPane("default", environmentId)!;

    const { container } = renderInAppCommandScope(
      <DndContext>
        <DraggableTabBar pane={pane} environmentId={environmentId} onTabSelect={() => undefined} />
      </DndContext>,
    );
    const close = container.querySelector("button");
    if (!close) throw new Error("close button missing");
    fireEvent.click(close);

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getPane("default", environmentId)?.tabs).toEqual([]);
    });
    expect(invoke).not.toHaveBeenCalledWith("delete_multi_review_workflow", expect.anything());
  });

  test("clears a dirty file buffer after confirming discard", async () => {
    const environmentId = "environment";
    usePaneLayoutStore.getState().initialize("container", environmentId);
    usePaneLayoutStore.getState().addTab(
      "default",
      {
        id: "dirty-file",
        type: "file",
        fileData: { filePath: "src/dirty.ts", containerId: "container" },
      },
      environmentId,
    );
    useFileDirtyStore.getState().hydrateDraft("dirty-file", "changed", "disk");
    const pane = usePaneLayoutStore.getState().getPane("default", environmentId)!;

    const { container } = renderInAppCommandScope(
      <DndContext>
        <DraggableTabBar pane={pane} environmentId={environmentId} onTabSelect={() => undefined} />
      </DndContext>,
    );
    const close = container.querySelector("button");
    if (!close) throw new Error("close button missing");
    fireEvent.click(close);
    expect(screen.getByText("Unsaved Changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Without Saving" }));

    await waitFor(() => {
      expect(useFileDirtyStore.getState().dirtyFiles.has("dirty-file")).toBe(false);
      expect(usePaneLayoutStore.getState().getPane("default", environmentId)?.tabs).toEqual([]);
    });
  });

  test("deletes persisted Claude compose drafts when closing a native tab", async () => {
    const environmentId = "environment";
    const sessionKey = createSessionKey(environmentId, "claude-tab");
    usePaneLayoutStore.getState().initialize("container", environmentId);
    usePaneLayoutStore.getState().addTab(
      "default",
      {
        id: "claude-tab",
        type: "agent-native",
        nativeAgentData: { platform: "claude", environmentId, containerId: "container" },
      },
      environmentId,
    );
    const pane = usePaneLayoutStore.getState().getPane("default", environmentId)!;

    const { container } = renderInAppCommandScope(
      <DndContext>
        <DraggableTabBar pane={pane} environmentId={environmentId} onTabSelect={() => undefined} />
      </DndContext>,
    );
    const close = container.querySelector("button");
    if (!close) throw new Error("close button missing");
    fireEvent.click(close);

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getPane("default", environmentId)?.tabs).toEqual([]);
    });
    expect(invoke).toHaveBeenCalledWith("delete_compose_draft", {
      draftKey: `claude:${environmentId}:${encodeURIComponent(sessionKey)}`,
      expectedRevision: 0,
    });
  });

  test("deletes persisted Pi compose drafts when closing a native tab", async () => {
    const environmentId = "environment";
    const sessionKey = createSessionKey(environmentId, "pi-tab");
    usePaneLayoutStore.getState().initialize("container", environmentId);
    usePaneLayoutStore.getState().addTab(
      "default",
      {
        id: "pi-tab",
        type: "agent-native",
        nativeAgentData: { platform: "pi", environmentId, containerId: "container" },
      },
      environmentId,
    );
    const pane = usePaneLayoutStore.getState().getPane("default", environmentId)!;

    const { container } = renderInAppCommandScope(
      <DndContext>
        <DraggableTabBar pane={pane} environmentId={environmentId} onTabSelect={() => undefined} />
      </DndContext>,
    );
    const close = container.querySelector("button");
    if (!close) throw new Error("close button missing");
    fireEvent.click(close);

    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getPane("default", environmentId)?.tabs).toEqual([]);
    });
    expect(invoke).toHaveBeenCalledWith("delete_compose_draft", {
      draftKey: `pi:${environmentId}:${encodeURIComponent(sessionKey)}`,
      expectedRevision: 0,
    });
  });

  test("close all confirms mixed dirty tabs before removing the complete set", async () => {
    const environmentId = "environment";
    usePaneLayoutStore.getState().initialize("container", environmentId);
    usePaneLayoutStore.getState().addTab(
      "default",
      {
        id: "dirty-file",
        type: "file",
        fileData: { filePath: "src/dirty.ts", containerId: "container" },
      },
      environmentId,
    );
    usePaneLayoutStore.getState().addTab(
      "default",
      {
        id: "terminal",
        type: "plain",
      },
      environmentId,
    );
    useFileDirtyStore.getState().hydrateDraft("dirty-file", "changed", "disk");
    const pane = usePaneLayoutStore.getState().getPane("default", environmentId)!;

    renderInAppCommandScope(
      <DndContext>
        <DraggableTabBar pane={pane} environmentId={environmentId} onTabSelect={() => undefined} />
      </DndContext>,
    );

    fireEvent.contextMenu(screen.getByText("Terminal 2"));
    fireEvent.click(await screen.findByText(/close all/i));
    expect(screen.getByText(/unsaved changes in dirty\.ts/i)).toBeTruthy();
    expect(usePaneLayoutStore.getState().getPane("default", environmentId)?.tabs).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Close Without Saving" }));
    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getPane("default", environmentId)?.tabs).toEqual([]);
      expect(useFileDirtyStore.getState().dirtyFiles.has("dirty-file")).toBe(false);
    });
  });

  test("a failed review teardown does not block other confirmed tabs from closing", async () => {
    const environmentId = "environment";
    (
      invoke as unknown as {
        mockImplementation: (implementation: (command: string) => Promise<unknown>) => void;
      }
    ).mockImplementation((command) =>
      command === "delete_multi_review_workflow"
        ? Promise.reject(new Error("bridge unavailable"))
        : Promise.resolve(),
    );
    usePaneLayoutStore.getState().initialize("container", environmentId);
    usePaneLayoutStore.getState().addTab(
      "default",
      {
        id: "dirty-file",
        type: "file",
        fileData: { filePath: "src/dirty.ts", containerId: "container" },
      },
      environmentId,
    );
    usePaneLayoutStore.getState().addTab(
      "default",
      {
        id: "multi-review",
        type: "multi-review",
        multiReviewTabData: { environmentId, workflowId: "workflow-1" },
      },
      environmentId,
    );
    usePaneLayoutStore
      .getState()
      .addTab("default", { id: "terminal", type: "plain" }, environmentId);
    useFileDirtyStore.getState().hydrateDraft("dirty-file", "changed", "disk");
    appCommandStore(multiReviewStore).setState({
      workflows: new Map([["workflow-1", { phase: "cancelled" } as never]]),
    });
    const pane = usePaneLayoutStore.getState().getPane("default", environmentId)!;

    renderInAppCommandScope(
      <DndContext>
        <DraggableTabBar pane={pane} environmentId={environmentId} onTabSelect={() => undefined} />
      </DndContext>,
    );
    fireEvent.contextMenu(screen.getByText("Terminal 3"));
    fireEvent.click(await screen.findByText(/close all/i));
    fireEvent.click(screen.getByRole("button", { name: "Close Without Saving" }));

    await waitFor(() => {
      expect(
        usePaneLayoutStore
          .getState()
          .getPane("default", environmentId)
          ?.tabs.map((tab) => tab.id),
      ).toEqual(["multi-review"]);
      expect(useFileDirtyStore.getState().dirtyFiles.has("dirty-file")).toBe(false);
      expect(screen.queryByText("Unsaved Changes") === null).toBe(true);
    });
  });

  test.each([
    ["Close others", ["selected"]],
    ["Close to the right", ["left", "selected"]],
  ])("%s closes exactly its requested tab set", async (action, expectedIds) => {
    const environmentId = "environment";
    usePaneLayoutStore.getState().initialize("container", environmentId);
    for (const id of ["left", "selected", "right"]) {
      usePaneLayoutStore.getState().addTab("default", { id, type: "plain" }, environmentId);
    }
    const pane = usePaneLayoutStore.getState().getPane("default", environmentId)!;

    renderInAppCommandScope(
      <DndContext>
        <DraggableTabBar pane={pane} environmentId={environmentId} onTabSelect={() => undefined} />
      </DndContext>,
    );
    fireEvent.contextMenu(screen.getByText("Terminal 2"));
    fireEvent.click(await screen.findByText(action));

    await waitFor(() => {
      expect(
        usePaneLayoutStore
          .getState()
          .getPane("default", environmentId)
          ?.tabs.map((tab) => tab.id),
      ).toEqual(expectedIds);
    });
  });

  test("rechecks dirtiness after draft cleanup before closing all requested tabs", async () => {
    const environmentId = "environment";
    let resolveDelete!: () => void;
    const deletePending = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    (
      invoke as unknown as {
        mockImplementation: (implementation: (command: string) => Promise<unknown>) => void;
      }
    ).mockImplementation((command) =>
      command === "delete_file_draft" ? deletePending : Promise.resolve(),
    );
    usePaneLayoutStore.getState().initialize("container", environmentId);
    usePaneLayoutStore.getState().addTab(
      "default",
      {
        id: "file",
        type: "file",
        fileData: { filePath: "src/racing.ts", containerId: "container" },
      },
      environmentId,
    );
    usePaneLayoutStore.getState().addTab(
      "default",
      {
        id: "terminal",
        type: "plain",
      },
      environmentId,
    );
    useFileDirtyStore.getState().setOriginalContent("file", "disk");
    const pane = usePaneLayoutStore.getState().getPane("default", environmentId)!;

    renderInAppCommandScope(
      <DndContext>
        <DraggableTabBar pane={pane} environmentId={environmentId} onTabSelect={() => undefined} />
      </DndContext>,
    );
    fireEvent.contextMenu(screen.getByText("Terminal 2"));
    fireEvent.click(await screen.findByText(/close all/i));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("delete_file_draft", expect.any(Object)),
    );

    useFileDirtyStore.getState().setContent("file", "changed while closing");
    resolveDelete();

    expect(await screen.findByText(/unsaved changes in racing\.ts/i)).toBeTruthy();
    expect(usePaneLayoutStore.getState().getPane("default", environmentId)?.tabs).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Close Without Saving" }));
    await waitFor(() => {
      expect(usePaneLayoutStore.getState().getPane("default", environmentId)?.tabs).toEqual([]);
    });
  });
});
