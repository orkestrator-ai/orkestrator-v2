import { afterEach, beforeEach, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { NodeInvokeOptions } from "@orkestrator/protocol/node-client";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  installDesktopFake,
  connectionList,
  remoteConnection,
  sharedIdDataset,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { setFilesPanelTestState } from "@/test/files-panel-state";
import { closeInTreeScopes, configureInTreeScopes } from "@/lib/federation/in-tree-scopes";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import { WindowScopeProvider } from "@/lib/node-scope/providers";
import {
  mountedInTreeLeaves,
  resetShimUnderLeafGuardForTests,
  ShimUnderLeafError,
  shimUnderLeafCounts,
} from "@/lib/node-scope/shim-under-leaf-guard";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useInTreeNodesStore } from "@/stores/inTreeNodesStore";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { uiStore } from "@/stores/uiStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { FederationProvider } from "./FederationProvider";
import { RemoteWorkspaceRegion } from "./RemoteWorkspaceRegion";

/**
 * Plan item 4004 on the in-tree seam: `InTreeWorkspace` marks its leaf
 * mounted, so the runtime shim guard is on while the node's real workspace
 * renders, and that workspace makes no command-scope shim use.
 */

const INITIAL_REMOTE = useRemoteWorkspaceStore.getState();
const INITIAL_MACHINE = useMachineViewStore.getState();
const LEAF = "bk_a" as BackendId;
const project = { id: "project-1", name: "Checkout", localPath: null, order: 0 };

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

let restoreScopes: () => void;

function anchorElement(): HTMLDivElement {
  const anchor = document.createElement("div");
  anchor.getBoundingClientRect = () =>
    ({ left: 300, top: 40, width: 900, height: 700, right: 1200, bottom: 740 }) as DOMRect;
  document.body.appendChild(anchor);
  return anchor;
}

beforeEach(() => {
  resetShimUnderLeafGuardForTests();
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
  useUIChromeStore.setState({ environmentSortMode: "project" });
  useMachineViewStore.setState({ grouping: "machine" });
  useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
  sessionStorage.clear();
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
  closeInTreeScopes();
  restoreScopes();
  uninstallDesktopFake();
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
  useMachineViewStore.setState(INITIAL_MACHINE, true);
  useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
  setFilesPanelTestState({ isOpen: false });
  resetWindowScopeForTests();
  resetShimUnderLeafGuardForTests();
  document.body.innerHTML = "";
});

test("the guard is on while an in-tree workspace is mounted, and its workspace uses no shim", async () => {
  installDesktopFake({
    list: connectionList([remoteConnection("a", "Machine A", "teal")]),
    datasets: { a: sharedIdDataset("working") },
  });
  delete (window.orkestrator as { workspaceViews?: unknown }).workspaceViews;
  const view = render(
    <WindowScopeProvider>
      <FederationProvider>
        <RemoteWorkspaceRegion anchor={anchorElement()} />
      </FederationProvider>
    </WindowScopeProvider>,
  );
  // Before any leaf is shown, the command node's shim is allowed.
  expect(() => useEnvironmentStore.getState()).not.toThrow();

  act(() => useRemoteWorkspaceStore.getState().open(LEAF, { projectId: project.id }));
  await screen.findByTestId("in-tree-workspace");
  const scope = getWindowScope().get(LEAF);
  await waitFor(() => expect(scope!.store(uiStore).getState().selectedProjectId).toBe(project.id));

  expect(mountedInTreeLeaves()).toEqual([LEAF]);
  // The node's workspace rendered and took the window's request without a shim use.
  expect(screen.queryByTestId("node-workspace-error")).toBeNull();
  expect(shimUnderLeafCounts()).toEqual([]);
  // A misrouted call now fails loudly.
  expect(() => useEnvironmentStore.getState()).toThrow(ShimUnderLeafError);

  view.unmount();
  expect(mountedInTreeLeaves()).toEqual([]);
  expect(() => useEnvironmentStore.getState()).not.toThrow();
});
