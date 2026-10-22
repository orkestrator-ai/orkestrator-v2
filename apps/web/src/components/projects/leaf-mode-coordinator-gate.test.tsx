import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { portalStore } from "@/lib/portal/portal-store";
import { useProjectStore } from "@/stores";
import type { Project } from "@/types";
import { LeafModeCoordinatorGate } from "./LeafModeCoordinatorGate";

afterEach(() => {
  cleanup();
  delete window.orkestratorWorkspaceTarget;
  portalStore.store.setState({ status: null, loaded: false, self: null, selfId: null });
  useProjectStore.setState({ projects: [] });
});

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

  test("a window working on a leaf leads to the command node's coordinator for the same repository", () => {
    window.orkestratorWorkspaceTarget = { nodeId: "bk_leaf", nodeName: "Leaf", path: "direct" };
    useProjectStore.setState({
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
        projects: [
          {
            ref: { backendId: "bk_top" as never, projectId: "top-project" },
            key: "bk_top:top-project",
            name: "app",
            order: 0,
            repositoryHint: "github.com/acme/app",
          },
        ],
        environments: [],
      } as never,
    });
    render(
      <LeafModeCoordinatorGate projectId="leaf-project">
        <div data-testid="coordinator-chat">chat</div>
      </LeafModeCoordinatorGate>,
    );
    expect(screen.queryByTestId("coordinator-chat") === null).toBe(true);
    expect(screen.getByTestId("leaf-mode-coordinator-gate").textContent).toContain(
      "controlled by Office desktop",
    );
    expect(
      screen.getByRole("button", { name: "Open the coordinator on Office desktop" }),
    ).toBeTruthy();
  });
});
