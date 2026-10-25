import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import { portalStore } from "@/lib/portal/portal-store";
import { useProjectStore } from "@/stores";
import { useRealmShellStore } from "@/stores/realmShellStore";
import type { Project } from "@/types";
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
});

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
