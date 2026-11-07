/**
 * Plan item 4005: an in-tree node's navigation and shared chrome are direct
 * reads and writes of the window's stores. Its loopback carries none of
 * `select`, `sidebar`, `filesPanel`, `grouping`, `visibility`, `ready`,
 * `selection` or `open`; `observeRealmLoopbacks` records everything that
 * still crosses it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { NodeInvokeOptions } from "@orkestrator/protocol/node-client";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  sharedIdDataset,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { setFilesPanelTestState } from "@/test/files-panel-state";
import { closeInTreeScopes, configureInTreeScopes } from "@/lib/federation/in-tree-scopes";
import { observeRealmLoopbacks, type RealmLoopbackTraffic } from "@/lib/federation/realm-channel";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import { WindowScopeProvider } from "@/lib/node-scope/providers";
import { useFilesPanelChromeStore } from "@/stores/filesPanelChromeStore";
import { useInTreeNodesStore } from "@/stores/inTreeNodesStore";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { FederationProvider } from "./FederationProvider";
import { RemoteWorkspaceRegion } from "./RemoteWorkspaceRegion";

const INITIAL_REMOTE = useRemoteWorkspaceStore.getState();
const INITIAL_MACHINE = useMachineViewStore.getState();
const INITIAL_CHROME = useUIChromeStore.getState();
const LEAF = "bk_a" as BackendId;
const project = { id: "project-1", name: "Checkout", localPath: null, order: 0 };

/** The messages plan item 4005 replaces with direct calls. */
const DIRECT = new Set([
  "select",
  "sidebar",
  "filesPanel",
  "grouping",
  "visibility",
  "ready",
  "selection",
  "open",
]);

/** A leaf node that answers its workspace's reads; anything else answers nothing. */
class LeafClient extends FakeNodeClient {
  override async invokeRaw<T = unknown>(
    command: string,
    args: Readonly<Record<string, unknown>> = {},
    options?: NodeInvokeOptions,
  ): Promise<T> {
    try {
      return await super.invokeRaw<T>(command, args, options);
    } catch (error) {
      if (this.disposed) throw error;
      return null as T;
    }
  }
}

let traffic: RealmLoopbackTraffic[];
let stopObserving: () => void;
let restoreScopes: () => void;

/** The messages of plan item 4005 that crossed a loopback. */
function directTraffic(): string[] {
  return traffic
    .map((entry) => `${entry.direction}:${entry.message.type}`)
    .filter((entry) => DIRECT.has(entry.split(":")[1]!));
}

function anchorElement(): HTMLDivElement {
  const anchor = document.createElement("div");
  anchor.getBoundingClientRect = () =>
    ({ left: 300, top: 40, width: 900, height: 700, right: 1200, bottom: 740 }) as DOMRect;
  document.body.appendChild(anchor);
  return anchor;
}

function renderRegion() {
  installDesktopFake({
    list: connectionList([remoteConnection("a", "Machine A", "teal")]),
    datasets: { a: sharedIdDataset("working") },
  });
  // A browser or iOS client: no desktop realms.
  delete (window.orkestrator as { workspaceViews?: unknown }).workspaceViews;
  return render(
    <WindowScopeProvider>
      <FederationProvider>
        <RemoteWorkspaceRegion anchor={anchorElement()} />
      </FederationProvider>
    </WindowScopeProvider>,
  );
}

/** Opens the leaf in the window's tree and waits for its scope. */
async function openLeaf(
  request: Parameters<ReturnType<typeof useRemoteWorkspaceStore.getState>["open"]>[1] = {
    projectId: project.id,
  },
) {
  renderRegion();
  act(() => useRemoteWorkspaceStore.getState().open(LEAF, request));
  await screen.findByTestId("in-tree-workspace");
  await waitFor(() => expect(getWindowScope().get(LEAF)?.role).toBe("leaf"));
  return getWindowScope().get(LEAF)!;
}

/** Lets microtask deliveries and effects land. */
async function settle() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
  useUIChromeStore.setState({ environmentSortMode: "project", sidebarOpen: true });
  useMachineViewStore.setState({ grouping: "machine" });
  useInTreeNodesStore.setState({ nodes: [LEAF] });
  sessionStorage.clear();
  traffic = [];
  stopObserving = observeRealmLoopbacks((entry) => traffic.push(entry));
  restoreScopes = configureInTreeScopes({
    host: {
      kind: "browser",
      async openLeafScope(windowScope, nodeId) {
        const client = new LeafClient({
          nodeId,
          invoke: {
            get_projects: [project],
            get_environments: [],
            get_environment_snapshots: [],
          },
        });
        return windowScope.open({ role: "leaf", client });
      },
    },
    startServices: () => () => undefined,
  });
});

afterEach(() => {
  cleanup();
  stopObserving();
  closeInTreeScopes();
  restoreScopes();
  uninstallDesktopFake();
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
  useMachineViewStore.setState(INITIAL_MACHINE, true);
  useUIChromeStore.setState(INITIAL_CHROME, true);
  useInTreeNodesStore.setState({ nodes: [] });
  setFilesPanelTestState({ isOpen: false });
  resetWindowScopeForTests();
  document.body.innerHTML = "";
});

test("sidebar: the in-tree workspace and the window share one store; nothing is exchanged", async () => {
  await openLeaf();
  await settle();
  // The window hides its sidebar, and the workspace's toolbar shows it again.
  act(() => useUIChromeStore.getState().setSidebarOpen(false));
  await settle();
  act(() => useUIChromeStore.getState().setSidebarOpen(true));
  await settle();
  expect(useUIChromeStore.getState().sidebarOpen).toBe(true);
  expect(directTraffic().filter((entry) => entry.endsWith(":sidebar"))).toEqual([]);
});

test("filesPanel: one open state for every machine, read and toggled in place", async () => {
  await openLeaf();
  await settle();
  // The window opens the panel; the in-tree layout reads the same store.
  act(() => useFilesPanelChromeStore.getState().openPanel());
  await settle();
  act(() => useFilesPanelChromeStore.getState().togglePanel());
  await settle();
  expect(useFilesPanelChromeStore.getState().isOpen).toBe(false);
  expect(directTraffic().filter((entry) => entry.endsWith(":filesPanel"))).toEqual([]);
});

test("grouping: the in-tree workspace reads machineViewStore; nothing is exchanged", async () => {
  await openLeaf();
  await settle();
  act(() => useMachineViewStore.setState({ grouping: "repository" }));
  await settle();
  act(() => useUIChromeStore.setState({ environmentSortMode: "activity" }));
  await settle();
  expect(directTraffic().filter((entry) => entry.endsWith(":grouping"))).toEqual([]);
});
