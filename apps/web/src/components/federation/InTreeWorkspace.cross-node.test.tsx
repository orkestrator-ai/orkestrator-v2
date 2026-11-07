/**
 * Plan items 5002 and 5003: for a node shown in the window's own tree the
 * title bar's meters and popovers, Settings, Report a bug and the app
 * shortcuts are the window's own direct calls.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { NodeInvokeOptions } from "@orkestrator/protocol/node-client";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  SELF_NODE_ID,
  sharedIdDataset,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { setFilesPanelTestState } from "@/test/files-panel-state";
import { closeInTreeScopes, configureInTreeScopes } from "@/lib/federation/in-tree-scopes";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import { WindowScopeProvider } from "@/lib/node-scope/providers";
import { portalStore } from "@/lib/portal/portal-store";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { useBugReportStore } from "@/stores/bugReportStore";
import { onAppShortcut } from "@/lib/app-shortcuts";
import { openBugReport } from "@/lib/bug-report/open-bug-report";
import { onGlobalSettingsRequest, requestGlobalSettings } from "@/lib/settings-navigation";
import { FederationProvider } from "./FederationProvider";
import { RemoteWorkspaceRegion } from "./RemoteWorkspaceRegion";

const INITIAL_REMOTE = useRemoteWorkspaceStore.getState();
const INITIAL_MACHINE = useMachineViewStore.getState();
const INITIAL_CHROME = useUIChromeStore.getState();
const INITIAL_PORTAL = portalStore.getState();
const LEAF = "bk_a" as BackendId;
const project = { id: "project-1", name: "Checkout", localPath: null, order: 0 };
const environment = {
  id: "env-1",
  projectId: project.id,
  name: "feature",
  environmentType: "local",
  status: "running",
};

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

function renderRegion() {
  installDesktopFake({
    list: connectionList([remoteConnection("a", "Machine A", "teal")]),
    datasets: { a: sharedIdDataset("working") },
  });
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
  sessionStorage.clear();
  // The window's own node, so entry points tell it from another node's.
  portalStore.store.setState({ selfId: SELF_NODE_ID });
  restoreScopes = configureInTreeScopes({
    host: {
      kind: "browser",
      async openLeafScope(windowScope, nodeId) {
        const client = new LeafClient({
          nodeId,
          invoke: {
            get_projects: [project],
            get_environments: [environment],
            get_environment_snapshots: [environment],
            check_docker: { available: false },
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
  useBugReportStore.setState({ sheetOpen: false, sheetNodeId: null });
  closeInTreeScopes();
  restoreScopes();
  uninstallDesktopFake();
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
  useMachineViewStore.setState(INITIAL_MACHINE, true);
  useUIChromeStore.setState(INITIAL_CHROME, true);
  setFilesPanelTestState({ isOpen: false });
  useAppDialogStore.setState({ request: null });
  portalStore.store.setState(INITIAL_PORTAL, true);
  resetReadCoordinatorForTests();
  resetWindowScopeForTests();
  document.body.innerHTML = "";
});

test("Settings, Report a bug and every app shortcut are direct calls from an in-tree node", async () => {
  await openLeaf();
  await settle();
  const sections: string[] = [];
  const stopSettings = onGlobalSettingsRequest((section) => sections.push(section));
  const seen: string[] = [];
  const stops = (
    ["search-projects", "open-settings", "rotate-sidebar-grouping", "show-shortcuts"] as const
  ).map((id) => onAppShortcut(id, () => seen.push(id)));
  try {
    // A settings link inside the node's workspace (its account section, say).
    act(() => requestGlobalSettings("claude"));
    expect(sections).toEqual(["claude"]);

    // Keys typed inside the in-tree workspace reach this window's handlers.
    const region = screen.getByTestId("in-tree-workspace");
    const composer = document.createElement("textarea");
    region.append(composer);
    for (const init of [
      { key: "k", metaKey: true },
      { key: ",", metaKey: true },
      { key: "d", metaKey: true, shiftKey: true },
      { key: "/", metaKey: true, shiftKey: true },
    ]) {
      composer.dispatchEvent(
        new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }),
      );
    }
    expect(seen).toEqual([
      "search-projects",
      "open-settings",
      "rotate-sidebar-grouping",
      "show-shortcuts",
    ]);

    // Report a bug for the node: the window's sheet, on its scope.
    act(() => openBugReport(LEAF));
    expect(useBugReportStore.getState()).toMatchObject({ sheetOpen: true, sheetNodeId: LEAF });
  } finally {
    stopSettings();
    for (const stop of stops) stop();
  }
});
