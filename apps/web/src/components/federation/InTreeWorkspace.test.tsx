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
import {
  closeInTreeScopes,
  configureInTreeScopes,
  inTreeScopeHolds,
} from "@/lib/federation/in-tree-scopes";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import { WindowScopeProvider } from "@/lib/node-scope/providers";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { uiStore } from "@/stores/uiStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { FederationProvider } from "./FederationProvider";
import { RemoteWorkspaceRegion } from "./RemoteWorkspaceRegion";

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

let leafClients: LeafClient[];
let restoreScopes: () => void;

function install(nodes = ["a", "b"]) {
  const fake = installDesktopFake({
    list: connectionList(
      nodes.map((id) => remoteConnection(id, `Machine ${id.toUpperCase()}`, "teal")),
    ),
    datasets: Object.fromEntries(nodes.map((id) => [id, sharedIdDataset("working")])),
  });
  return fake;
}

function anchorElement(): HTMLDivElement {
  const anchor = document.createElement("div");
  anchor.getBoundingClientRect = () =>
    ({ left: 300, top: 40, width: 900, height: 700, right: 1200, bottom: 740 }) as DOMRect;
  document.body.appendChild(anchor);
  return anchor;
}

function renderRegion() {
  return render(
    <WindowScopeProvider>
      <FederationProvider>
        <RemoteWorkspaceRegion anchor={anchorElement()} />
      </FederationProvider>
    </WindowScopeProvider>,
  );
}

/** Commands that would stop or discard work on a node. */
function workStoppingCalls(commands: string[]): string[] {
  return commands.filter((command) =>
    /^(stop|cancel|kill|delete|interrupt|close_terminal)_/.test(command),
  );
}

beforeEach(() => {
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
  useUIChromeStore.setState({ environmentSortMode: "project" });
  useMachineViewStore.setState({ grouping: "machine" });
  sessionStorage.clear();
  leafClients = [];
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
        leafClients.push(client);
        return windowScope.open({ role: "leaf", client });
      },
    },
    // The warm services are 3014's; this suite checks the seam around them.
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
  setFilesPanelTestState({ isOpen: false });
  resetWindowScopeForTests();
  document.body.innerHTML = "";
});

/** The fake client the in-tree scopes opened for `nodeId`. */
function clientFor(nodeId: string): LeafClient {
  const client = leafClients.find((candidate) => candidate.nodeId === nodeId);
  if (!client) throw new Error(`no client for ${nodeId}`);
  return client;
}

test("every node renders in the window's tree, each in its own scope", async () => {
  install();
  renderRegion();
  act(() => useRemoteWorkspaceStore.getState().open("bk_b", { projectId: "project-1" }));
  act(() => useRemoteWorkspaceStore.getState().open(LEAF, { projectId: project.id }));

  await waitFor(() => expect(screen.getAllByTestId("in-tree-workspace")).toHaveLength(2));
  expect(
    screen.getAllByTestId("in-tree-workspace").map((element) => element.getAttribute("data-node")),
  ).toEqual(["bk_b", LEAF]);
  expect(getWindowScope().get("bk_b" as BackendId)?.role).toBe("leaf");

  // The in-tree node's scope is a leaf scope of the window, held by the view.
  const scope = getWindowScope().get(LEAF);
  expect(scope?.role).toBe("leaf");
  expect(inTreeScopeHolds(LEAF)).toBe(1);

  // The window's request reached the node's host through the window's store:
  // it selected the project on the leaf's own uiStore, and the window's
  // node-qualified selection moved with it.
  await waitFor(() => expect(scope!.store(uiStore).getState().selectedProjectId).toBe(project.id));
  expect(getWindowScope().selection.get()).toMatchObject({ nodeId: LEAF, projectId: project.id });
  expect(useRemoteWorkspaceStore.getState().active?.nodeId).toBe(LEAF);
  // Nothing crashed into the node's error boundary.
  expect(screen.queryByTestId("node-workspace-error")).toBeNull();
  // The leaf answered its own workspace's reads.
  expect(clientFor(LEAF).calls("get_projects").length).toBeGreaterThan(0);
});

test("closing an in-tree node's view releases its scope after the grace period, never cancelling work", async () => {
  install();
  renderRegion();
  act(() => useRemoteWorkspaceStore.getState().open(LEAF, { projectId: project.id }));
  await screen.findByTestId("in-tree-workspace");
  act(() => useRemoteWorkspaceStore.getState().closeNode(LEAF));
  await waitFor(() => expect(screen.queryByTestId("in-tree-workspace")).toBeNull());
  // Released, kept for the grace period, then disposed by `closeInTreeScopes`
  // in afterEach (the grace timer itself is covered by in-tree-scopes.test.ts).
  expect(inTreeScopeHolds(LEAF)).toBe(0);
  expect(getWindowScope().get(LEAF)?.disposed).toBe(false);
  expect(workStoppingCalls(leafClients[0]!.invocations.map((call) => call.command))).toEqual([]);
});

test("a node whose scope cannot open shows its failure with Try again, and the other node is unaffected", async () => {
  install();
  restoreScopes();
  let attempts = 0;
  restoreScopes = configureInTreeScopes({
    host: {
      kind: "browser",
      async openLeafScope(windowScope, nodeId) {
        attempts += 1;
        if (attempts === 1) throw new Error("The machine did not answer.");
        const client = new LeafClient({ nodeId, invoke: { get_projects: [project] } });
        leafClients.push(client);
        return windowScope.open({ role: "leaf", client });
      },
    },
    startServices: () => () => undefined,
  });
  renderRegion();
  act(() => useRemoteWorkspaceStore.getState().open(LEAF, { projectId: project.id }));
  expect(await screen.findByText("The machine did not answer.")).toBeTruthy();
  act(() => screen.getByText("Try again").click());
  await waitFor(() => expect(getWindowScope().get(LEAF)?.role).toBe("leaf"));
  await waitFor(() => expect(screen.queryByText("The machine did not answer.")).toBeNull());
  expect(attempts).toBe(2);
});

test("a hidden node follows its tier: suspended it unmounts its views, back to summary it reopens when shown", async () => {
  install();
  const OTHER = "bk_b" as BackendId;
  renderRegion();
  act(() => useRemoteWorkspaceStore.getState().open(OTHER, { projectId: project.id }));
  act(() => useRemoteWorkspaceStore.getState().open(LEAF, { projectId: project.id }));
  await waitFor(() => expect(screen.getAllByTestId("in-tree-workspace")).toHaveLength(2));
  const region = (nodeId: string) =>
    screen
      .getAllByTestId("in-tree-workspace")
      .find((el) => el.getAttribute("data-node") === nodeId)!;
  const hidden = getWindowScope().get(OTHER)!;
  // Hidden but warm: mounted, so switching back is instant.
  await waitFor(() => expect(hidden.tier.get()).toBe("warm"));
  await waitFor(() => expect(region(OTHER).childElementCount).toBeGreaterThan(0));
  expect(getWindowScope().get(LEAF)!.tier.get()).toBe("live");

  // The iOS app's memory warning (or the suspend timer) suspends it: its
  // views go, its scope and light stores stay.
  act(() => {
    window.dispatchEvent(new Event("orkestrator:memory-warning"));
  });
  expect(hidden.tier.get()).toBe("suspended");
  await waitFor(() => expect(region(OTHER).childElementCount).toBe(0));
  expect(hidden.disposed).toBe(false);

  // A second warning takes it back to summary; the shown node is untouched.
  act(() => {
    window.dispatchEvent(new Event("orkestrator:memory-warning"));
  });
  expect(hidden.disposed).toBe(true);
  expect(getWindowScope().get(LEAF)!.tier.get()).toBe("live");
  expect(region(LEAF).childElementCount).toBeGreaterThan(0);

  // Shown again, it opens afresh (summary → warm → live) with a new client.
  const clientsBefore = leafClients.length;
  act(() => useRemoteWorkspaceStore.getState().open(OTHER, { projectId: project.id }));
  await waitFor(() => expect(getWindowScope().get(OTHER)?.tier.get()).toBe("live"));
  expect(leafClients.length).toBe(clientsBefore + 1);
  await waitFor(() => expect(region(OTHER).childElementCount).toBeGreaterThan(0));
  // Nothing on either node was asked to stop.
  for (const client of leafClients) {
    expect(workStoppingCalls(client.invocations.map((call) => call.command))).toEqual([]);
  }
});
