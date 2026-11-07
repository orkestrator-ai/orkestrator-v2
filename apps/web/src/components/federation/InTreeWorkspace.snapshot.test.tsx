/**
 * Plan item 4003, Done when: a cold open of a previously seen node paints
 * from its local snapshot before the first authoritative read, on the
 * desktop (main's node scope through the preload) and in a browser (the
 * node-client registry). The snapshot shows read-only with the stale marker;
 * mutations wait; the real workspace replaces it once the reads land.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDefaultAppConfig } from "@orkestrator/protocol/app-config-defaults";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { NodeInvokeOptions } from "@orkestrator/protocol/node-client";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { clientEnvironmentFixture } from "@/test/environments-results";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  sharedIdDataset,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { setFilesPanelTestState } from "@/test/files-panel-state";
import {
  closeInTreeScopes,
  configureInTreeScopes,
  desktopInTreeScopeHost,
  type InTreeScopeHost,
} from "@/lib/federation/in-tree-scopes";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScopeProvider } from "@/lib/node-scope/providers";
import { invokeInScope } from "@/lib/node-scope/scope-transport";
import {
  createNodeSnapshotStore,
  memorySnapshotBackend,
  NODE_SNAPSHOT_VERSION,
  type NodeSnapshotStore,
} from "@/lib/node-scope/snapshot-store";
import { scopeSnapshotSync } from "@/lib/node-scope/snapshot-sync";
import { configureNodeSnapshots } from "@/lib/node-snapshots";
import { requestResourceResync, resetResourceSync } from "@/lib/resource-sync";
import { startStoreResourceSync, STORE_RESOURCE_HANDLERS } from "@/lib/store-resource-sync";
import { projectStore } from "@/stores/projectStore";
import { useInTreeNodesStore } from "@/stores/inTreeNodesStore";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { FederationProvider } from "./FederationProvider";
import { RemoteWorkspaceRegion } from "./RemoteWorkspaceRegion";

const INITIAL_REMOTE = useRemoteWorkspaceStore.getState();
const INITIAL_MACHINE = useMachineViewStore.getState();
const LEAF = "bk_a" as BackendId;

const project = {
  id: "project-1",
  name: "Checkout",
  gitUrl: "git@github.com:acme/checkout.git",
  localPath: null,
  addedAt: "2026-11-01T10:00:00.000Z",
  order: 0,
};
const environment = clientEnvironmentFixture({
  id: "env-1",
  projectId: project.id,
  name: "feature-login",
  branch: "feature/login",
  status: "running",
  environmentType: "local",
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** What the leaf answers; `get_projects` is held until the test lets it land. */
function leafAnswers(projects: Promise<unknown>) {
  return (command: string): unknown => {
    if (command === "get_projects") return projects;
    if (command === "get_environment_snapshots" || command === "get_environments") {
      return [environment];
    }
    if (command === "get_config") return createDefaultAppConfig();
    // The workspace's boot restores, once it mounts.
    if (command === "list_multi_review_workflows" || command === "list_build_pipelines") return [];
    return null;
  };
}

/** A leaf client answering `answer(command)`; recorded like `FakeNodeClient`. */
class LeafClient extends FakeNodeClient {
  constructor(
    nodeId: BackendId,
    private readonly answer: (command: string) => unknown,
  ) {
    super({ nodeId });
  }
  override async invokeRaw<T = unknown>(
    command: string,
    args: Readonly<Record<string, unknown>> = {},
    _options?: NodeInvokeOptions,
  ): Promise<T> {
    this.invocations.push({ command, args });
    return (await this.answer(command)) as T;
  }
}

let store: NodeSnapshotStore;
let restoreSnapshots: () => void;
let restoreScopes: () => void;
let commands: string[];

/** The bindings of the gated collections, the warm services this proof needs. */
const GATED_HANDLERS = STORE_RESOURCE_HANDLERS.filter((entry) =>
  ["projects", "environments", "config"].includes(entry.name),
);

/** The node's store bindings and their first resync. */
function startServices(scope: NodeScope) {
  const stop = startStoreResourceSync({}, { scope, handlers: GATED_HANDLERS });
  requestResourceResync(scope);
  return () => {
    stop();
    resetResourceSync(scope);
  };
}

/** A browser host: the grant answers when the test says so. */
function browserHost(grant: Promise<void>, projects: Promise<unknown>): InTreeScopeHost {
  return {
    kind: "browser",
    async openLeafScope(windowScope, nodeId) {
      await grant;
      const client = new LeafClient(nodeId, (command) => {
        commands.push(command);
        return leafAnswers(projects)(command);
      });
      return windowScope.open({ role: "leaf", client });
    },
  };
}

/** The desktop host over a preload `node(nodeId)` whose stream opens when the test says so. */
function installDesktopNode(streamReady: Promise<void>, projects: Promise<unknown>) {
  const answer = leafAnswers(projects);
  const api = {
    nodeId: LEAF,
    invoke: async (command: string) => {
      commands.push(command);
      return answer(command);
    },
    listen: () => () => undefined,
    eventStreamReady: () => streamReady,
    eventStreamConnection: { state: () => "connected", subscribe: () => () => undefined },
  };
  Object.assign(window.orkestrator as object, {
    node: (nodeId: string) => (nodeId === LEAF ? api : undefined),
  });
}

function install() {
  installDesktopFake({
    list: connectionList([remoteConnection("a", "Studio Mac", "teal")]),
    datasets: { a: sharedIdDataset("working") },
  });
  delete (window.orkestrator as { workspaceViews?: unknown }).workspaceViews;
}

function renderRegion() {
  const anchor = document.createElement("div");
  anchor.getBoundingClientRect = () =>
    ({ left: 300, top: 40, width: 900, height: 700, right: 1200, bottom: 740 }) as DOMRect;
  document.body.appendChild(anchor);
  return render(
    <WindowScopeProvider>
      <FederationProvider>
        <RemoteWorkspaceRegion anchor={anchor} />
      </FederationProvider>
    </WindowScopeProvider>,
  );
}

beforeEach(async () => {
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
  useUIChromeStore.setState({ environmentSortMode: "project" });
  useMachineViewStore.setState({ grouping: "machine" });
  useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
  sessionStorage.clear();
  commands = [];
  store = createNodeSnapshotStore(memorySnapshotBackend());
  restoreSnapshots = configureNodeSnapshots(store);
  restoreScopes = () => undefined;
  // The window saw this node before: its snapshot is on disk.
  await store.write({
    version: NODE_SNAPSHOT_VERSION,
    nodeId: LEAF,
    savedAt: Date.now() - 5 * 60_000,
    projects: [project],
    environments: [
      {
        id: environment.id,
        projectId: project.id,
        name: environment.name,
        branch: environment.branch,
        containerId: null,
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: environment.createdAt,
        networkAccessMode: "restricted",
        order: 0,
        environmentType: "local",
      },
    ],
    config: null,
    paneLayouts: [
      { environmentId: environment.id, activePaneId: "p", activeTabId: "t1", tabIds: ["t1", "t2"] },
    ],
    selection: { projectId: project.id, environmentId: environment.id },
  });
});

afterEach(() => {
  cleanup();
  closeInTreeScopes();
  restoreScopes();
  restoreSnapshots();
  uninstallDesktopFake();
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
  useMachineViewStore.setState(INITIAL_MACHINE, true);
  useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
  setFilesPanelTestState({ isOpen: false });
  resetWindowScopeForTests();
  document.body.innerHTML = "";
});

const hosts = ["browser", "desktop"] as const;

describe.each(hosts)("a cold open on the %s", (kind) => {
  test("paints the node from its snapshot before the first authoritative read, then replaces it", async () => {
    install();
    const connect = deferred<void>();
    const projects = deferred<unknown>();
    if (kind === "browser") {
      restoreScopes = configureInTreeScopes({
        host: browserHost(connect.promise, projects.promise),
        startServices,
      });
    } else {
      installDesktopNode(connect.promise, projects.promise);
      restoreScopes = configureInTreeScopes({ host: desktopInTreeScopeHost(), startServices });
    }
    renderRegion();
    act(() => useRemoteWorkspaceStore.getState().open(LEAF, { projectId: project.id }));

    // 1. Before the node has even answered the open, the snapshot is on screen.
    const preview = await screen.findByTestId("node-snapshot-preview");
    expect(preview.textContent).toContain("Checkout");
    expect(preview.textContent).toContain("feature-login");
    expect(screen.getByTestId("snapshot-stale-marker").getAttribute("data-phase")).toBe(
      "connecting",
    );
    expect(commands).not.toContain("get_projects");

    // 2. The node connects: the scope is hydrated from the snapshot and marked
    //    resyncing; the first authoritative read is out but has not landed.
    await act(async () => connect.resolve());
    await waitFor(() => expect(commands).toContain("get_projects"));
    const scope = getWindowScope().get(LEAF)!;
    expect(scopeSnapshotSync(scope).get().state).toBe("resyncing");
    expect(scope.store(projectStore).getState().projects[0]?.name).toBe("Checkout");
    await waitFor(() =>
      expect(screen.getByTestId("snapshot-stale-marker").getAttribute("data-phase")).toBe(
        "refreshing",
      ),
    );
    expect(screen.getByTestId("node-snapshot-preview").textContent).toContain("Checkout");

    // 3. A mutation made now waits for live.
    const write = invokeInScope(scope, "set_project_folder", { projectId: project.id });
    await act(async () => undefined);
    expect(commands).not.toContain("set_project_folder");

    // 4. The authoritative read lands: live, the real workspace replaces the
    //    snapshot, the marker goes, and the waiting mutation is sent.
    await act(async () => projects.resolve([{ ...project, name: "Checkout (current)" }]));
    await waitFor(() => expect(scopeSnapshotSync(scope).get().state).toBe("live"));
    expect(scope.store(projectStore).getState().projects[0]?.name).toBe("Checkout (current)");
    await waitFor(() => expect(screen.queryByTestId("node-snapshot-preview")).toBeNull());
    expect(screen.queryByTestId("snapshot-stale-marker")).toBeNull();
    expect(screen.getByTestId("in-tree-workspace").childElementCount).toBeGreaterThan(0);
    await write;
    expect(commands).toContain("set_project_folder");
  });
});

test("a node never seen before opens as before: no preview, no marker, nothing waits", async () => {
  install();
  await store.clearAll();
  const connect = deferred<void>();
  const projects = deferred<unknown>();
  restoreScopes = configureInTreeScopes({
    host: browserHost(connect.promise, projects.promise),
    startServices,
  });
  renderRegion();
  act(() => useRemoteWorkspaceStore.getState().open(LEAF, { projectId: project.id }));
  expect(await screen.findByText("Opening Studio Mac…")).toBeTruthy();
  expect(screen.queryByTestId("node-snapshot-preview")).toBeNull();
  await act(async () => connect.resolve());
  const scope = await waitFor(() => getWindowScope().get(LEAF)!);
  expect(scopeSnapshotSync(scope).get().state).toBe("live");
  await act(async () => projects.resolve([project]));
});
