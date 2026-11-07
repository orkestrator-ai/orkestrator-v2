/**
 * The central region that holds other nodes' workspaces in the window's own
 * tree. What each node's workspace does inside it (its scope, requests,
 * tiers) is `InTreeWorkspace*.test.tsx`; this suite covers the region: its
 * placement over the current layout's central region, what it shows, and
 * what it lets go.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  sharedIdDataset,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { closeInTreeScopes, configureInTreeScopes } from "@/lib/federation/in-tree-scopes";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import { WindowScopeProvider } from "@/lib/node-scope/providers";
import { portalStore } from "@/lib/portal/portal-store";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { FederationProvider } from "./FederationProvider";
import { RemoteWorkspaceRegion } from "./RemoteWorkspaceRegion";

const INITIAL_REMOTE = useRemoteWorkspaceStore.getState();
const originalReload = window.location.reload;
let reload = mock(() => undefined);
let restoreScopes: () => void;

function install(nodes = ["a", "b"]) {
  return installDesktopFake({
    list: connectionList(
      nodes.map((id) => remoteConnection(id, `Machine ${id.toUpperCase()}`, "teal")),
    ),
    datasets: Object.fromEntries(nodes.map((id) => [id, sharedIdDataset("working")])),
  });
}

function anchorElement(): HTMLDivElement {
  const anchor = document.createElement("div");
  anchor.getBoundingClientRect = () =>
    ({ left: 300, top: 40, width: 900, height: 700, right: 1200, bottom: 740 }) as DOMRect;
  document.body.appendChild(anchor);
  return anchor;
}

function renderRegion(anchor: HTMLElement | null = anchorElement()) {
  return render(
    <WindowScopeProvider>
      <FederationProvider>
        <RemoteWorkspaceRegion anchor={anchor} />
      </FederationProvider>
    </WindowScopeProvider>,
  );
}

const region = () => screen.getByTestId("remote-workspace-region");

beforeEach(() => {
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
  reload = mock(() => undefined);
  window.location.reload = reload;
  restoreScopes = configureInTreeScopes({
    host: {
      kind: "browser",
      async openLeafScope(windowScope, nodeId) {
        const client = new FakeNodeClient({
          nodeId,
          invoke: { get_projects: [], get_environments: [], get_environment_snapshots: [] },
        });
        return windowScope.open({ role: "leaf", client });
      },
    },
    startServices: () => () => undefined,
  });
});

afterEach(() => {
  cleanup();
  closeInTreeScopes();
  restoreScopes();
  uninstallDesktopFake();
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
  window.location.reload = originalReload;
  resetWindowScopeForTests();
  document.body.innerHTML = "";
});

test("nothing is drawn until another node is opened", () => {
  install();
  renderRegion();
  expectDomAbsent(screen.queryByTestId("remote-workspace-region"));
});

test("the shown node is placed over the anchor; going back keeps every node held, hidden, without a reload", async () => {
  install();
  renderRegion();
  act(() => useRemoteWorkspaceStore.getState().open("bk_a", {}));
  act(() => useRemoteWorkspaceStore.getState().open("bk_b", {}));
  await waitFor(() => expect(screen.getAllByTestId("in-tree-workspace")).toHaveLength(2));
  expect(region().getAttribute("data-node")).toBe("bk_b");
  expect(region().style.left).toBe("300px");
  expect(region().style.top).toBe("40px");
  expect(region().style.width).toBe("900px");
  expect(region().style.height).toBe("700px");
  expect(region().className).not.toContain("hidden");
  // Only the shown node's workspace is visible.
  const [a, b] = screen.getAllByTestId("in-tree-workspace");
  expect(a!.classList.contains("hidden")).toBe(true);
  expect(b!.classList.contains("hidden")).toBe(false);

  // Back to this window's own node: the region hides, both nodes stay held.
  act(() => useRemoteWorkspaceStore.getState().showLocal());
  await waitFor(() => expect(region().className).toContain("hidden"));
  expect(useRemoteWorkspaceStore.getState().openNodes).toEqual(["bk_a", "bk_b"]);
  expect(screen.getAllByTestId("in-tree-workspace")).toHaveLength(2);
  expect(reload).not.toHaveBeenCalled();
});

test("a selection of the window's own node brings the central region back to it", async () => {
  install();
  renderRegion();
  act(() => useRemoteWorkspaceStore.getState().open("bk_a", { projectId: "project-1" }));
  await screen.findByTestId("in-tree-workspace");
  expect(useRemoteWorkspaceStore.getState().active?.nodeId).toBe("bk_a");
  act(() => getWindowScope().select(null));
  await waitFor(() => expect(useRemoteWorkspaceStore.getState().active).toBeNull());
  expect(region().className).toContain("hidden");
});

test("without an anchor (a layout switching over) the region is held, hidden", async () => {
  install();
  renderRegion(null);
  act(() => useRemoteWorkspaceStore.getState().open("bk_a", {}));
  await screen.findByTestId("in-tree-workspace");
  expect(region().className).toContain("hidden");
});

test("a machine removed from the command node takes its workspace with it", async () => {
  install();
  renderRegion();
  act(() => useRemoteWorkspaceStore.getState().open("bk_a", { projectId: "project-1" }));
  await screen.findByTestId("in-tree-workspace");
  await waitFor(() => expect(portalStore.getState().loaded).toBe(true));
  act(() => portalStore.store.setState({ nodes: [] }));
  await waitFor(() => expect(useRemoteWorkspaceStore.getState().openNodes).toEqual([]));
  expect(useRemoteWorkspaceStore.getState().active).toBeNull();
  expectDomAbsent(screen.queryByTestId("in-tree-workspace"));
});
