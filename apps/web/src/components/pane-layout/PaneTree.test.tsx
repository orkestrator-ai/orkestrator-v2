import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import * as realResizable from "@/components/ui/resizable";
import * as realHooks from "@/hooks";
import { MOBILE_SHELL_MEDIA_QUERY } from "@/components/layout/MobileAppShellLayout";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { PaneLeaf, PaneNode, PaneSplit } from "@/types/paneLayout";
import * as realPaneLeafContainer from "./PaneLeafContainer";

const realResizableSnapshot = { ...realResizable };
const realHooksSnapshot = { ...realHooks };
const realPaneLeafContainerSnapshot = { ...realPaneLeafContainer };

// A media query the test can flip while the tree stays rendered, the way a
// window narrowing or a phone rotating does.
let isMobile = false;
const queries: string[] = [];
const viewportListeners = new Set<() => void>();
function setMobile(next: boolean) {
  act(() => {
    isMobile = next;
    for (const listener of viewportListeners) listener();
  });
}

mock.module("@/hooks", () => ({
  ...realHooksSnapshot,
  useMediaQuery: (query: string) => {
    queries.push(query);
    return useSyncExternalStore(
      (listener) => {
        viewportListeners.add(listener);
        return () => viewportListeners.delete(listener);
      },
      () => isMobile,
    );
  },
}));

mock.module("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div data-testid="resizable-group">{children}</div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resize-handle" />,
}));

/** Mount count per pane id; a state initializer runs once per mount. */
let mounts = new Map<string, number>();

mock.module("./PaneLeafContainer", () => ({
  PaneLeafContainer: ({ pane, isActive }: { pane: PaneLeaf; isActive: boolean }) => {
    const [mountIndex] = useState(() => {
      const next = (mounts.get(pane.id) ?? 0) + 1;
      mounts.set(pane.id, next);
      return next;
    });
    const [dialogOpen, setDialogOpen] = useState(false);
    return (
      <section
        aria-label={`Pane ${pane.id}`}
        data-active={String(isActive)}
        data-mount-index={String(mountIndex)}
      >
        <button type="button" onClick={() => setDialogOpen(true)}>
          Open dialog in {pane.id}
        </button>
        {dialogOpen && <div role="dialog" aria-label={`Dialog in ${pane.id}`} />}
      </section>
    );
  },
}));

const { PaneTree } = await import("./PaneTree");

const ENVIRONMENT_ID = "env-pane-tree";

function leaf(id: string): PaneLeaf {
  return {
    kind: "leaf",
    id,
    tabs: [{ id: `${id}-tab`, type: "plain", title: id } as PaneLeaf["tabs"][number]],
    activeTabId: `${id}-tab`,
  };
}

function split(id: string, first: PaneNode, second: PaneNode): PaneSplit {
  return {
    kind: "split",
    id,
    direction: "horizontal",
    sizes: [50, 50],
    depth: 1,
    children: [first, second],
  } as PaneSplit;
}

function seedStore(root: PaneNode, activePaneId: string) {
  usePaneLayoutStore.setState({
    environments: new Map([[ENVIRONMENT_ID, { containerId: null, activePaneId, root }]]),
  });
}

function renderTree(node: PaneNode, activePaneId = "right") {
  seedStore(node, activePaneId);
  const view = render(
    <PaneTree node={node} containerId={null} environmentId={ENVIRONMENT_ID} isActive />,
  );
  return {
    ...view,
    rerenderTree: (next: PaneNode) => {
      seedStore(next, usePaneLayoutStore.getState().environments.get(ENVIRONMENT_ID)!.activePaneId);
      view.rerender(
        <PaneTree node={next} containerId={null} environmentId={ENVIRONMENT_ID} isActive />,
      );
    },
  };
}

// Panes the switcher hides are still mounted but have no accessible name, so
// the lookup goes by label rather than by role.
const pane = (id: string) => {
  const element = document.querySelector<HTMLElement>(`section[aria-label="Pane ${id}"]`);
  if (!element) throw new Error(`Pane ${id} is not mounted`);
  return element;
};
const switcherPanel = (id: string) => document.getElementById(`mobile-pane-panel-${id}`);

beforeEach(() => {
  isMobile = false;
  queries.length = 0;
  mounts = new Map();
});

afterEach(cleanup);

afterAll(() => {
  mock.module("@/hooks", () => realHooksSnapshot);
  mock.module("@/components/ui/resizable", () => realResizableSnapshot);
  mock.module("./PaneLeafContainer", () => realPaneLeafContainerSnapshot);
});

describe("PaneTree", () => {
  test("keeps every pane mounted, with its open dialog, across the mobile breakpoint", () => {
    renderTree(split("split", leaf("left"), leaf("right")));
    fireEvent.click(screen.getByRole("button", { name: "Open dialog in right" }));
    expect(screen.getAllByTestId("resizable-panel")[1]?.contains(pane("right"))).toBe(true);

    setMobile(true);
    expect(switcherPanel("right")?.contains(pane("right"))).toBe(true);
    expect(switcherPanel("right")?.hasAttribute("inert")).toBe(false);
    expect(screen.getByRole("dialog", { name: "Dialog in right" })).toBeTruthy();
    expectDomAbsent(screen.queryByTestId("resizable-group"));

    setMobile(false);
    expect(screen.getAllByTestId("resizable-panel")[1]?.contains(pane("right"))).toBe(true);
    expect(screen.getByRole("dialog", { name: "Dialog in right" })).toBeTruthy();
    expectDomAbsent(screen.queryByRole("tablist", { name: "Split panes" }));

    // And starting from the phone layout.
    fireEvent.click(screen.getByRole("button", { name: "Open dialog in left" }));
    setMobile(true);
    setMobile(false);
    expect(screen.getByRole("dialog", { name: "Dialog in left" })).toBeTruthy();
    expect(Object.fromEntries(mounts)).toEqual({ left: 1, right: 1 });
    expect(new Set(queries)).toEqual(new Set([MOBILE_SHELL_MEDIA_QUERY]));
  });

  test("marks only the pane the switcher shows as active on mobile", () => {
    isMobile = true;
    // The stored active pane is not in this split, so the switcher shows the first.
    renderTree(split("split", leaf("left"), split("nested", leaf("top"), leaf("bottom"))));

    expect(pane("left").dataset.active).toBe("true");
    expect(pane("top").dataset.active).toBe("false");
    expect(pane("bottom").dataset.active).toBe("false");

    fireEvent.click(screen.getByRole("tab", { name: /^3\./ }));
    expect(pane("left").dataset.active).toBe("false");
    expect(pane("bottom").dataset.active).toBe("true");
    expect(switcherPanel("left")?.hasAttribute("inert")).toBe(true);

    setMobile(false);
    expect(["left", "top", "bottom"].map((id) => pane(id).dataset.active)).toEqual([
      "true",
      "true",
      "true",
    ]);
  });

  test("keeps a pane mounted when it is split, and drops the host of a closed pane", () => {
    const { rerenderTree } = renderTree(leaf("left"), "left");
    fireEvent.click(screen.getByRole("button", { name: "Open dialog in left" }));

    rerenderTree(split("split", leaf("left"), leaf("right")));
    expect(screen.getAllByTestId("resizable-panel")[0]?.contains(pane("left"))).toBe(true);
    expect(screen.getByRole("dialog", { name: "Dialog in left" })).toBeTruthy();
    expect(document.querySelectorAll("[data-pane-host]")).toHaveLength(2);

    rerenderTree(leaf("left"));
    expect(screen.getByRole("dialog", { name: "Dialog in left" })).toBeTruthy();
    expectDomAbsent(document.querySelector('section[aria-label="Pane right"]'));
    expect(
      Array.from(document.querySelectorAll<HTMLElement>("[data-pane-host]")).map(
        (host) => host.dataset.paneHost,
      ),
    ).toEqual(["left"]);
    expect(Object.fromEntries(mounts)).toEqual({ left: 1, right: 1 });
  });
});
