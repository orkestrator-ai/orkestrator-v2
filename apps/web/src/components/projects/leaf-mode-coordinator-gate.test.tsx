import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { portalStore } from "@/lib/portal/portal-store";
import { useProjectStore } from "@/stores";
import { useRealmShellStore } from "@/stores/realmShellStore";
import type { Project } from "@/types";
import { LeafModeCoordinatorGate } from "./LeafModeCoordinatorGate";

afterEach(() => {
  cleanup();
  delete window.orkestratorWorkspaceTarget;
  portalStore.store.setState({ status: null, loaded: false, self: null, selfId: null });
  useProjectStore.setState({ projects: [], hasLoaded: false });
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
    expect(
      screen.getByRole("button", { name: "Open the coordinator on Office desktop" }),
    ).toBeTruthy();
  });

  test("grouped by repository, a leaf's coordinator opens directly when the command node has no copy", () => {
    onLeafWindow(["github.com/acme/other"]);
    useRealmShellStore.setState({ grouping: "repository" });
    renderGate();
    expect(screen.getByTestId("coordinator-chat")).toBeTruthy();
  });

  for (const grouping of ["machine", "project"] as const) {
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
