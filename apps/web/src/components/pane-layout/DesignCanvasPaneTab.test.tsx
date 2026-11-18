import { designStore, emptyProjection } from "@/stores/designStore";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { appCommandStore } from "@/test/app-command-store";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import type { TabInfo } from "@/types/paneLayout";
import * as realCanvas from "@/components/design/DesignCanvasTab";
import { DesignCanvasPaneTab } from "./DesignCanvasPaneTab";
const snapshot = { ...realCanvas };
mock.module("@/components/design/DesignCanvasTab", () => ({
  DesignCanvasTab: ({
    agentPanel,
    onClose,
  }: {
    agentPanel: { adopt?: (id: string) => void };
    onClose: () => void;
  }) => (
    <>
      <button onClick={() => agentPanel.adopt?.("agent")}>Ask adoption</button>
      <button onClick={onClose}>Close design</button>
    </>
  ),
}));
afterAll(() => mock.module("@/components/design/DesignCanvasTab", () => snapshot));
afterEach(() => {
  cleanup();
  appCommandStore(designStore).setState({ projections: new Map() });
});
const host = {
  id: "design",
  type: "design-canvas",
  designCanvasData: { canvasId: "canvas" },
} as const;
const agent: TabInfo = {
  id: "agent",
  type: "agent-native",
  nativeAgentData: { platform: "codex", environmentId: "env" },
};
function mount(embedded = false) {
  const store = appCommandStore(paneLayoutStore);
  store.setState({
    environments: new Map([
      [
        "env",
        {
          root: {
            kind: "leaf",
            id: "pane",
            tabs: [host, { ...agent, ...(embedded ? { embeddedIn: host.id } : {}) }],
            activeTabId: host.id,
          },
          activePaneId: "pane",
          containerId: null,
        },
      ],
    ]),
    hydration: new Map([["env", "done"]]),
  });
  function Harness() {
    const state = store.getState();
    const tabs = state.getAllTabs("env");
    const tab = tabs.find((t) => t.id === host.id)! as typeof host;
    return (
      <DesignCanvasPaneTab
        tab={tab}
        paneTabs={tabs}
        environmentId="env"
        isTabActive
        isActive
        hiddenByLayout={false}
        ownsGlobalShortcuts
        loadingFallback={null}
        renderError={() => null}
        renderAgent={(tab, _data, view) => (
          <input
            aria-label="Composer"
            defaultValue={tab.id}
            data-active={String(view.isActive)}
            data-owns={String(view.ownsGlobalShortcuts)}
          />
        )}
      />
    );
  }
  const view = renderInAppCommandScope(<Harness />);
  return { store, refresh: () => view.rerender(<Harness />) };
}
test("blank host hides the panel; Ask adoption opens it; pop out restores an empty panel", async () => {
  const { store, refresh } = mount();
  expect(screen.getByRole("region", { name: "Agent panel" }).classList.contains("hidden")).toBe(
    true,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Ask adoption" }));
  refresh();
  expect(
    store
      .getState()
      .getAllTabs("env")
      .find((t) => t.id === "agent")?.embeddedIn,
  ).toBe("design");
  const composer = screen.getByRole("textbox", { name: "Composer" });
  fireEvent.change(composer, { target: { value: "unsent" } });
  fireEvent.pointerDown(composer);
  expect(composer.getAttribute("data-owns")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Hide agent panel" }));
  refresh();
  expect(composer.getAttribute("data-active")).toBe("false");
  expect((composer as HTMLInputElement).value).toBe("unsent");
  fireEvent.keyDown(window, { key: ".", ctrlKey: true });
  refresh();
  expect(composer.getAttribute("data-active")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Open agent in its own tab" }));
  refresh();
  expect(
    store
      .getState()
      .getAllTabs("env")
      .find((t) => t.id === "agent")?.embeddedIn,
  ).toBeUndefined();
  expect(screen.getByText("No agent in this design")).toBeTruthy();
});
test("embedded default is open and closeDesign removes both tabs", async () => {
  const { store } = mount(true);
  expect(screen.getByRole("textbox").getAttribute("data-active")).toBe("true");
  fireEvent.click(await screen.findByRole("button", { name: "Close design" }));
  await waitFor(() => expect(store.getState().getAllTabs("env")).toHaveLength(0));
});

test("Show here lists only linked open native agents and adopts the selected one", () => {
  const projection = emptyProjection("key", "env", "canvas");
  appCommandStore(designStore).setState({
    projections: new Map([
      [
        "key",
        {
          ...projection,
          workspace: {
            recordSequence: 1,
            statusVersion: 1,
            incarnation: "test",
            createdAt: "",
            modifiedAt: "",
            frames: {},
            history: { revision: 1, undoCount: 0, redoCount: 0, canUndo: false, canRedo: false },
            sessions: ["agent", "closed"].map((tabId) => ({
              id: tabId,
              tabId,
              platform: "codex",
              role: "design" as const,
              createdAt: "",
              label: tabId,
            })),
          },
        },
      ],
    ]),
  });
  const { store, refresh } = mount();
  fireEvent.keyDown(window, { key: ".", ctrlKey: true });
  refresh();
  expect(screen.getByText("agent · Codex")).toBeTruthy();
  expect(screen.queryByText("closed · Codex") === null).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Show here" }));
  refresh();
  expect(
    store
      .getState()
      .getAllTabs("env")
      .find((t) => t.id === "agent")?.embeddedIn,
  ).toBe("design");
  expect(screen.getByRole("textbox").getAttribute("data-active")).toBe("true");
});
