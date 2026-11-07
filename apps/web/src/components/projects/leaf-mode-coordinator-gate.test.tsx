import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { portalStore } from "@/lib/portal/portal-store";
import { useProjectStore, useUIStore } from "@/stores";
import { uiStore } from "@/stores/uiStore";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { useRealmShellStore } from "@/stores/realmShellStore";
import type { Project } from "@/types";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { projectStore } from "@/stores/projectStore";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import * as openWorkspace from "@/lib/federation/open-workspace";
import { LeafModeCoordinatorGate } from "./LeafModeCoordinatorGate";

const nativeInvoke = invoke as ReturnType<typeof mock>;
const originalHref = window.location.href;
const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;

afterEach(() => {
  cleanup();
  delete window.orkestratorWorkspaceTarget;
  delete window.orkestrator;
  happyDOM.setURL(originalHref);
  nativeInvoke.mockReset();
  nativeInvoke.mockResolvedValue(undefined);
  portalStore.store.setState({ status: null, loaded: false, self: null, selfId: null });
  useProjectStore.setState({ projects: [], hasLoaded: false, error: null, isLoading: false });
  useRealmShellStore.setState({ grouping: null });
  useUIStore.setState({ openedLeafCoordinators: [] });
});

/** This node's own portal status: leaf mode under the given controllers. */
function leafStatus(controllers: string[]) {
  return {
    nodeId: "bk_middle" as never,
    mode: "leaf" as const,
    registrationEnabled: true,
    controllers: controllers.map((displayName, order) => ({
      controllerId: `bk_top_${order}` as never,
      displayName,
      attachedAt: "",
      lastContactAt: "",
    })),
    detachedControllers: [],
    suspendedSubordinateCount: 0,
  };
}

/** A window whose workspace is a realm on a leaf, with the command node's own projects. */
function onLeafWindow(commandRepositories: string[]) {
  window.orkestratorWorkspaceTarget = { nodeId: "bk_leaf", nodeName: "Leaf", path: "direct" };
  useProjectStore.setState({
    hasLoaded: true,
    projects: [
      { id: "leaf-project", name: "app", gitUrl: "git@github.com:acme/app.git" } as Project,
    ],
  });
  portalStore.store.setState({
    loaded: true,
    selfId: "bk_top" as never,
    // The portal status is the command node's own; it is not in leaf mode.
    status: {
      nodeId: "bk_top" as never,
      mode: "command",
      registrationEnabled: true,
      controllers: [],
      detachedControllers: [],
      suspendedSubordinateCount: 0,
    },
    self: {
      nodeId: "bk_top" as never,
      displayName: "Office desktop",
      loadedAt: 1,
      truncated: false,
      projects: commandRepositories.map((repositoryHint, order) => ({
        ref: { backendId: "bk_top" as never, projectId: `top-project-${order}` },
        key: `bk_top:top-project-${order}`,
        name: "app",
        order,
        repositoryHint,
      })),
      environments: [],
    } as never,
  });
}

function renderGate() {
  render(
    <LeafModeCoordinatorGate projectId="leaf-project">
      <div data-testid="coordinator-chat">chat</div>
    </LeafModeCoordinatorGate>,
  );
}

describe("LM-04 coordinator conversations in leaf mode", () => {
  test("are hidden behind a warning that names the controller, and can still be opened", () => {
    portalStore.store.setState({
      loaded: true,
      status: {
        nodeId: "bk_middle" as never,
        mode: "leaf",
        registrationEnabled: true,
        controllers: [
          {
            controllerId: "bk_top" as never,
            displayName: "Office desktop",
            attachedAt: "",
            lastContactAt: "",
          },
        ],
        detachedControllers: [],
        suspendedSubordinateCount: 1,
      },
    });
    render(
      <LeafModeCoordinatorGate>
        <div data-testid="coordinator-chat">chat</div>
      </LeafModeCoordinatorGate>,
    );
    expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
    expect(screen.getByTestId("leaf-mode-coordinator-gate").textContent).toContain(
      "controlled by Office desktop",
    );
    fireEvent.click(screen.getByRole("button", { name: /Open this node's coordinator anyway/ }));
    expect(screen.getByTestId("coordinator-chat")).toBeTruthy();
  });

  test("a command node or standalone node shows its coordinator directly", () => {
    portalStore.store.setState({
      loaded: true,
      status: {
        nodeId: "bk_top" as never,
        mode: "command",
        registrationEnabled: true,
        controllers: [],
        detachedControllers: [],
        suspendedSubordinateCount: 0,
      },
    });
    render(
      <LeafModeCoordinatorGate>
        <div data-testid="coordinator-chat">chat</div>
      </LeafModeCoordinatorGate>,
    );
    expect(screen.getByTestId("coordinator-chat")).toBeTruthy();
  });

  test("grouped by repository, a window working on a leaf leads to the command node's coordinator for the same repository", () => {
    onLeafWindow(["github.com/acme/app"]);
    useRealmShellStore.setState({ grouping: "repository" });
    renderGate();
    expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
    expect(screen.getByTestId("leaf-mode-coordinator-gate").textContent).toContain(
      "controlled by Office desktop",
    );
    const post = mock(() => undefined);
    window.orkestrator = { workspaceRealm: { post } } as never;
    happyDOM.setURL("https://command.test/?realm=workspace");
    fireEvent.click(screen.getByRole("button", { name: "Open the coordinator on Office desktop" }));
    expect(post).toHaveBeenCalledWith({
      type: "open",
      nodeId: "bk_top",
      projectId: "top-project-0",
      boardTab: "coordinator",
      title: "app",
    });
    expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
  });

  test("grouped by repository, a leaf's coordinator opens directly when the command node has no copy", () => {
    onLeafWindow(["github.com/acme/other"]);
    useRealmShellStore.setState({ grouping: "repository" });
    renderGate();
    expect(screen.getByTestId("coordinator-chat")).toBeTruthy();
  });

  for (const grouping of ["machine", "project", "activity"] as const) {
    test(`grouped by ${grouping}, a leaf's coordinator opens directly`, () => {
      onLeafWindow(["github.com/acme/app"]);
      useRealmShellStore.setState({ grouping });
      renderGate();
      expect(screen.getByTestId("coordinator-chat")).toBeTruthy();
      expect(screen.queryByTestId("leaf-mode-coordinator-gate") === null).toBe(true);
    });
  }

  test("a leaf's coordinator waits for the window's grouping, then follows it", () => {
    onLeafWindow(["github.com/acme/app"]);
    renderGate();
    expect(screen.getByTestId("leaf-mode-coordinator-pending")).toBeTruthy();
    expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
    act(() => useRealmShellStore.setState({ grouping: "machine" }));
    expect(screen.getByTestId("coordinator-chat")).toBeTruthy();
    act(() => useRealmShellStore.setState({ grouping: "repository" }));
    expect(screen.getByTestId("leaf-mode-coordinator-gate")).toBeTruthy();
  });

  test("a node in leaf mode keeps the notice whatever the grouping", () => {
    useRealmShellStore.setState({ grouping: "machine" });
    portalStore.store.setState({
      loaded: true,
      status: {
        nodeId: "bk_middle" as never,
        mode: "leaf",
        registrationEnabled: true,
        controllers: [],
        detachedControllers: [],
        suspendedSubordinateCount: 0,
      },
    });
    renderGate();
    expect(screen.getByTestId("leaf-mode-coordinator-gate")).toBeTruthy();
  });
});

describe("0410 leaf-mode gate edge cases", () => {
  test("a node shows neither the notice nor its coordinator until its portal status loads", () => {
    const refresh = spyOn(portalStore, "refresh").mockResolvedValue(undefined);
    try {
      renderGate();
      expect(refresh).toHaveBeenCalled();
      expect(screen.getByTestId("leaf-mode-coordinator-pending").textContent).toContain(
        "Checking repository coordination",
      );
      expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
      expect(screen.queryByTestId("leaf-mode-coordinator-gate") === null).toBe(true);
      act(() =>
        portalStore.store.setState({ loaded: true, status: leafStatus(["Office desktop"]) }),
      );
      expect(screen.getByTestId("leaf-mode-coordinator-gate")).toBeTruthy();
      expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
    } finally {
      refresh.mockRestore();
    }
  });

  test("a node that is not in leaf mode opens its coordinator once its status loads", () => {
    const refresh = spyOn(portalStore, "refresh").mockResolvedValue(undefined);
    try {
      renderGate();
      expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
      act(() =>
        portalStore.store.setState({
          loaded: true,
          status: { ...leafStatus([]), mode: "standalone" },
        }),
      );
      expect(screen.getByTestId("coordinator-chat")).toBeTruthy();
    } finally {
      refresh.mockRestore();
    }
  });

  test("a failed portal status read falls through to the coordinator", async () => {
    nativeInvoke.mockImplementation(async (command: string) => {
      if (command === "get_node_status") throw new Error("portal unavailable");
      if (command === "get_node_summaries") throw new Error("portal unavailable");
    });
    renderGate();
    expect(screen.getByTestId("leaf-mode-coordinator-pending")).toBeTruthy();
    expect(await screen.findByTestId("coordinator-chat")).toBeTruthy();
    expect(portalStore.getState().status).toBeNull();
    expect(screen.queryByTestId("leaf-mode-coordinator-gate") === null).toBe(true);
  });

  for (const [label, controllers] of [
    ["an empty controller list", []],
    ["blank controller names", ["", "  "]],
  ] as const) {
    test(`${label} names the command node`, () => {
      portalStore.store.setState({ loaded: true, status: leafStatus([...controllers]) });
      renderGate();
      const notice = screen.getByTestId("leaf-mode-coordinator-gate").textContent ?? "";
      expect(notice).toContain("It is controlled by the command node.");
      expect(notice).not.toContain("controlled by .");
    });
  }

  test("several controllers are listed by name, skipping blank ones", () => {
    portalStore.store.setState({
      loaded: true,
      status: leafStatus(["Office desktop", " ", "Laptop"]),
    });
    renderGate();
    expect(screen.getByTestId("leaf-mode-coordinator-gate").textContent).toContain(
      "It is controlled by Office desktop, Laptop.",
    );
  });

  test("opening anyway is remembered per project for the app session, not persisted", () => {
    portalStore.store.setState({ loaded: true, status: leafStatus(["Office desktop"]) });
    renderGate();
    fireEvent.click(screen.getByRole("button", { name: /Open this node's coordinator anyway/ }));
    expect(screen.getByTestId("coordinator-chat")).toBeTruthy();
    cleanup();

    // Returning to the same project's coordinator skips the notice.
    renderGate();
    expect(screen.getByTestId("coordinator-chat")).toBeTruthy();
    cleanup();

    // Another project on the same node still shows it.
    render(
      <LeafModeCoordinatorGate projectId="other-project">
        <div data-testid="coordinator-chat">chat</div>
      </LeafModeCoordinatorGate>,
    );
    expect(screen.getByTestId("leaf-mode-coordinator-gate")).toBeTruthy();
    expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);

    expect(useUIStore.getState().openedLeafCoordinators).toEqual(["local:leaf-project"]);
    // The command scope's instance carries the `persist` API the def's type leaves out.
    const instance = getWindowScope().commandScope().store(uiStore) as unknown as {
      persist: { getOptions(): { partialize?: (state: unknown) => object } };
    };
    const persisted = instance.persist.getOptions().partialize?.(useUIStore.getState());
    expect(Object.keys(persisted ?? {})).not.toContain("openedLeafCoordinators");
  });

  test("a leaf window keys the choice by the leaf node, so the same project id elsewhere is not opened", () => {
    useUIStore.setState({ openedLeafCoordinators: ["local:leaf-project"] });
    onLeafWindow(["github.com/acme/app"]);
    useRealmShellStore.setState({ grouping: "repository" });
    renderGate();
    expect(screen.getByTestId("leaf-mode-coordinator-gate")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open this node's coordinator anyway/ }));
    expect(screen.getByTestId("coordinator-chat")).toBeTruthy();
    expect(useUIStore.getState().openedLeafCoordinators).toContain("bk_leaf:leaf-project");
  });
});

for (const pending of ["portal", "projects"] as const) {
  test(`repository grouping waits for ${pending} metadata and recovers when it arrives`, () => {
    onLeafWindow(["github.com/acme/app"]);
    useRealmShellStore.setState({ grouping: "repository" });
    const refresh = spyOn(portalStore, "refresh").mockResolvedValue(undefined);
    try {
      if (pending === "portal") portalStore.store.setState({ loaded: false });
      else useProjectStore.setState({ hasLoaded: false, isLoading: true });
      renderGate();
      expect(screen.getByTestId("leaf-mode-coordinator-pending")).toBeTruthy();
      expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
      expect(screen.queryByTestId("leaf-mode-coordinator-gate") === null).toBe(true);
      act(() => {
        portalStore.store.setState({ loaded: true });
        useProjectStore.setState({ hasLoaded: true, isLoading: false });
      });
      expect(
        screen.getByRole("button", { name: "Open the coordinator on Office desktop" }),
      ).toBeTruthy();
      expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
    } finally {
      refresh.mockRestore();
    }
  });
}

test("a failed command summary read remains gated and can be retried", async () => {
  onLeafWindow(["github.com/acme/app"]);
  const self = portalStore.getState().self;
  useRealmShellStore.setState({ grouping: "repository" });
  portalStore.store.setState({ self: null });
  nativeInvoke.mockImplementation(async (command: string) => {
    if (command === "get_node_summaries") throw new Error("summary unavailable");
  });
  await portalStore.refresh();
  renderGate();
  expect(screen.getByRole("alert").textContent).toContain("repository information is unavailable");
  expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
  nativeInvoke.mockImplementation(async (command: string) =>
    command === "get_node_summaries" ? { selfId: "bk_top", nodes: [], self } : undefined,
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("button", { name: "Open the coordinator on Office desktop" });
  expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
});

test("a truncated command summary cannot prove absence, but a matching entry can still lead to its coordinator", () => {
  onLeafWindow(["github.com/acme/other"]);
  useRealmShellStore.setState({ grouping: "repository" });
  const self = portalStore.getState().self!;
  portalStore.store.setState({ self: { ...self, truncated: true } });
  renderGate();
  expect(screen.getByRole("alert").textContent).toContain("repository list is incomplete");
  expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
  act(() =>
    portalStore.store.setState({
      self: {
        ...self,
        truncated: true,
        projects: self.projects.map((project) => ({
          ...project,
          repositoryHint: "github.com/acme/app",
        })),
      },
    }),
  );
  expect(
    screen.getByRole("button", { name: "Open the coordinator on Office desktop" }),
  ).toBeTruthy();
  expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
  act(() => portalStore.store.setState({ self }));
  expect(screen.getByTestId("coordinator-chat")).toBeTruthy();
});

test("a failed initial project read exposes recovery and retry loads the correct repository", async () => {
  onLeafWindow(["github.com/acme/app"]);
  const projects = useProjectStore.getState().projects;
  useRealmShellStore.setState({ grouping: "repository" });
  useProjectStore.setState({ projects: [], hasLoaded: false, isLoading: false, error: "Offline" });
  let resolveProjects!: (projects: Project[]) => void;
  nativeInvoke.mockImplementation((command: string) =>
    command === "get_projects"
      ? new Promise<Project[]>((resolve) => {
          resolveProjects = resolve;
        })
      : Promise.resolve(),
  );
  renderGate();
  expect(screen.getByRole("alert").textContent).toContain(
    "Could not load this node's projects: Offline",
  );
  expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
  expect(screen.getByRole("button", { name: /Open this node's coordinator anyway/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(nativeInvoke).toHaveBeenCalledWith("get_projects"));
  expect(screen.getByTestId("leaf-mode-coordinator-pending")).toBeTruthy();
  expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
  await act(async () => resolveProjects(projects));
  expect(
    screen.getByRole("button", { name: "Open the coordinator on Office desktop" }),
  ).toBeTruthy();
  expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
});

test("unavailable repository metadata still permits an explicit manual open", () => {
  onLeafWindow([]);
  useRealmShellStore.setState({ grouping: "repository" });
  portalStore.store.setState({ self: null });
  renderGate();
  fireEvent.click(screen.getByRole("button", { name: /Open this node's coordinator anyway/ }));
  expect(screen.getByTestId("coordinator-chat")).toBeTruthy();
});

test("a leaf shown in the window's tree follows the window's own grouping, not a realm's message (plan item 4005)", () => {
  const initialViews = useMachineViewStore.getState();
  const initialChrome = useUIChromeStore.getState();
  try {
    const gitUrl = "git@github.com:acme/app.git";
    const windowScope = new WindowScope();
    windowScope
      .open({ role: "command", client: new FakeNodeClient({ nodeId: "bk_top" as never }) })
      .store(projectStore)
      .setState({
        hasLoaded: true,
        projects: [{ id: "top-project", name: "app", gitUrl } as Project],
      });
    useUIChromeStore.setState({ environmentSortMode: "project" });
    useMachineViewStore.setState({ grouping: "repository" });
    const { scope } = renderInNodeScope(
      <LeafModeCoordinatorGate projectId="leaf-project">
        <div data-testid="coordinator-chat">chat</div>
      </LeafModeCoordinatorGate>,
      { role: "leaf", nodeId: "bk_leaf" as never, windowScope },
    );
    act(() =>
      scope.store(projectStore).setState({
        hasLoaded: true,
        projects: [{ id: "leaf-project", name: "app", gitUrl } as Project],
      }),
    );
    // No realm message set a grouping, yet the window's repository grouping applies.
    expect(useRealmShellStore.getState().grouping).toBeNull();
    expect(screen.getByTestId("leaf-mode-coordinator-gate")).toBeTruthy();
    act(() => useMachineViewStore.setState({ grouping: "machine" }));
    expect(screen.getByTestId("coordinator-chat")).toBeTruthy();
  } finally {
    cleanupNodeScopes();
    useMachineViewStore.setState(initialViews, true);
    useUIChromeStore.setState(initialChrome, true);
  }
});

/**
 * The same decisions for a leaf shown in the window's own tree (plan items
 * 4001, 4005 and 5004): the grouping comes from the window's `machineViewStore`
 * and the command node's projects from the window's command scope. Nothing
 * reads the realm page globals or the portal's self summary.
 */
describe("a leaf shown in the window's tree", () => {
  const gitUrl = "git@github.com:acme/app.git";
  const initialViews = useMachineViewStore.getState();
  const initialChrome = useUIChromeStore.getState();

  afterEach(() => {
    cleanupNodeScopes();
    delete window.orkestratorPortal;
    useMachineViewStore.setState(initialViews, true);
    useUIChromeStore.setState(initialChrome, true);
    mock.restore();
  });

  /** Counts reads of `window.orkestratorPortal`; nothing on this path should make any. */
  function watchPortalGlobal() {
    let reads = 0;
    Object.defineProperty(window, "orkestratorPortal", {
      configurable: true,
      get() {
        reads += 1;
        return { invoke: mock(), listen: mock() };
      },
    });
    return () => reads;
  }

  function renderInTree({
    commandProjects = [{ id: "top-project", name: "app", gitUrl } as Project],
    commandState = "loaded",
    grouping = "repository",
    sortMode = "project",
  }: {
    commandProjects?: Project[];
    commandState?: "loaded" | "loading" | "failed";
    grouping?: "machine" | "project" | "repository" | "compact";
    sortMode?: "project" | "activity";
  } = {}) {
    const commandClient = new FakeNodeClient({
      nodeId: "bk_top" as never,
      invoke: { get_projects: () => commandProjects },
    });
    const windowScope = new WindowScope();
    const commandScope = windowScope.open({ role: "command", client: commandClient });
    commandScope
      .store(projectStore)
      .setState(
        commandState === "loaded"
          ? { hasLoaded: true, isLoading: false, error: null, projects: commandProjects }
          : commandState === "loading"
            ? { hasLoaded: false, isLoading: true, error: null, projects: [] }
            : { hasLoaded: false, isLoading: false, error: "Offline", projects: [] },
      );
    useUIChromeStore.setState({ environmentSortMode: sortMode });
    useMachineViewStore.setState({ grouping });
    const rendered = renderInNodeScope(
      <LeafModeCoordinatorGate projectId="leaf-project">
        <div data-testid="coordinator-chat">chat</div>
      </LeafModeCoordinatorGate>,
      { role: "leaf", nodeId: "bk_leaf" as never, windowScope },
    );
    act(() =>
      rendered.scope.store(projectStore).setState({
        hasLoaded: true,
        projects: [{ id: "leaf-project", name: "app", gitUrl } as Project],
      }),
    );
    return { ...rendered, commandScope, commandClient };
  }

  test("grouped by repository, it leads to the command scope's coordinator for the same repository", () => {
    const reads = watchPortalGlobal();
    const open = spyOn(openWorkspace, "openMachineWorkspace").mockImplementation(() => undefined);
    // The portal's self summary is a realm's source; in the tree it is not read.
    portalStore.store.setState({ loaded: false, self: null, selfId: null });
    renderInTree();
    expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
    expect(screen.getByTestId("leaf-mode-coordinator-gate").textContent).toContain(
      "Coordination happens on the command node",
    );
    // No portal id yet: the command scope's own node is opened.
    fireEvent.click(screen.getByRole("button", { name: /^Open the coordinator on/ }));
    expect(open).toHaveBeenCalledWith({
      connectionId: "bk_top",
      projectId: "top-project",
      boardTab: "coordinator",
      title: "app",
    });
    expect(reads()).toBe(0);
  });

  test("the portal's id names the command node once known", () => {
    const open = spyOn(openWorkspace, "openMachineWorkspace").mockImplementation(() => undefined);
    portalStore.store.setState({ loaded: true, selfId: "bk_command" as never });
    renderInTree();
    fireEvent.click(screen.getByRole("button", { name: /^Open the coordinator on/ }));
    expect(open.mock.calls[0]?.[0]).toMatchObject({ connectionId: "bk_command" });
  });

  test("compact links repositories as repository grouping does", () => {
    renderInTree({ grouping: "compact" });
    expect(screen.getByTestId("leaf-mode-coordinator-gate")).toBeTruthy();
  });

  test("the leaf's coordinator opens directly when the command scope has no copy", () => {
    // A realm's summary would say otherwise; the tree does not consult it.
    portalStore.store.setState({
      loaded: true,
      self: {
        nodeId: "bk_top" as never,
        displayName: "Office desktop",
        loadedAt: 1,
        truncated: false,
        projects: [
          {
            ref: { backendId: "bk_top" as never, projectId: "top-project-0" },
            key: "bk_top:top-project-0",
            name: "app",
            order: 0,
            repositoryHint: "github.com/acme/app",
          },
        ],
        environments: [],
      } as never,
    });
    renderInTree({
      commandProjects: [
        { id: "other", name: "other", gitUrl: "git@github.com:acme/other.git" } as Project,
      ],
    });
    expect(screen.getByTestId("coordinator-chat")).toBeTruthy();
  });

  for (const [label, options] of [
    ["machine", { grouping: "machine" }],
    ["project", { grouping: "project" }],
    ["activity", { sortMode: "activity" }],
  ] as const) {
    test(`grouped by ${label}, the leaf's coordinator opens directly`, () => {
      renderInTree(options);
      expect(screen.getByTestId("coordinator-chat")).toBeTruthy();
      expect(screen.queryByTestId("leaf-mode-coordinator-gate") === null).toBe(true);
    });
  }

  test("waits for the command scope's projects, then follows them", () => {
    const { commandScope } = renderInTree({ commandState: "loading" });
    expect(screen.getByTestId("leaf-mode-coordinator-pending")).toBeTruthy();
    expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
    act(() =>
      commandScope.store(projectStore).setState({
        hasLoaded: true,
        isLoading: false,
        projects: [{ id: "top-project", name: "app", gitUrl } as Project],
      }),
    );
    expect(screen.getByTestId("leaf-mode-coordinator-gate")).toBeTruthy();
  });

  test("a failed read of the command scope's projects stays gated and retries on the command scope", async () => {
    const { commandClient } = renderInTree({ commandState: "failed" });
    expect(screen.getByRole("alert").textContent).toContain(
      "repository information is unavailable",
    );
    expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: /^Open the coordinator on/ });
    expect(commandClient.calls("get_projects")).toHaveLength(1);
    expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
  });

  test("opening anyway is remembered under the leaf node, in the leaf's own UI state", () => {
    const { scope } = renderInTree();
    fireEvent.click(screen.getByRole("button", { name: /Open this node's coordinator anyway/ }));
    expect(screen.getByTestId("coordinator-chat")).toBeTruthy();
    expect(scope.store(uiStore).getState().openedLeafCoordinators).toEqual([
      "bk_leaf:leaf-project",
    ]);
  });
});
