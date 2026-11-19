import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { NodeSummary } from "@orkestrator/protocol/node-summaries";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { portalStore } from "@/lib/portal/portal-store";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { projectStore } from "@/stores/projectStore";
import { uiStore } from "@/stores/uiStore";
import { appCommandStore } from "@/test/app-command-store";
import { FakeNodeClient, renderInAppCommandScope } from "@/test/render-in-node-scope";
import type { Project } from "@/types";
import { ProjectMachineSwitcher } from "./ProjectMachineSwitcher";

const REPOSITORY = "github.com/acme/web";

function node(
  nodeId: string,
  displayName: string,
  projects: Array<{ id: string; hint?: string }>,
  available = true,
): NodeSummary {
  return {
    nodeId,
    available,
    view: { displayName },
    projects: projects.map((project) => ({
      ref: { backendId: nodeId, projectId: project.id },
      key: `${nodeId}:${project.id}`,
      name: project.id,
      order: 0,
      ...(project.hint ? { repositoryHint: project.hint } : {}),
    })),
    environments: [],
  } as unknown as NodeSummary;
}

const initialPortal = portalStore.getState();
const initialProjects = appCommandStore(projectStore).getState();
const initialUI = appCommandStore(uiStore).getState();
const initialRemote = useRemoteWorkspaceStore.getState();
const openedScopes: NodeScope[] = [];

function project(id: string, repository = REPOSITORY): Project {
  return {
    id,
    name: "web",
    order: 0,
    addedAt: "2026-11-19T00:00:00Z",
    gitUrl: `https://${repository}`,
    localPath: "/work/web",
  };
}

function openWarm(nodeId: string, projects: Project[]) {
  const scope = getWindowScope().open({
    role: "leaf",
    client: new FakeNodeClient({ nodeId: nodeId as BackendId }),
    tier: "warm",
  });
  openedScopes.push(scope);
  scope.store(projectStore).getState().setProjects(projects);
  return scope;
}

function seed(nodes: NodeSummary[]) {
  appCommandStore(projectStore).setState({
    projects: [project("home-web")],
  });
  portalStore.store.setState({ selfId: getWindowScope().commandScope().nodeId, nodes });
}

function renderSwitcher(tab: Parameters<typeof ProjectMachineSwitcher>[0]["tab"] = "home") {
  return renderInAppCommandScope(
    <ProjectMachineSwitcher projectId="home-web" projectName="web" tab={tab} />,
  );
}

beforeEach(() => {
  useRemoteWorkspaceStore.setState(initialRemote, true);
});

afterEach(() => {
  cleanup();
  for (const scope of openedScopes.splice(0)) scope.dispose();
  portalStore.store.setState(initialPortal, true);
  appCommandStore(projectStore).setState(initialProjects, true);
  appCommandStore(uiStore).setState(initialUI, true);
  useRemoteWorkspaceStore.setState(initialRemote, true);
});

describe("ProjectMachineSwitcher", () => {
  test("draws nothing while no other machine has the repository", () => {
    seed([node("node-other", "other", [{ id: "api", hint: "github.com/acme/api" }])]);
    renderSwitcher();
    expect(screen.queryByRole("combobox", { name: "Machine" }) === null).toBe(true);
  });

  test("lists only the machines with this repository, this one selected", async () => {
    seed([
      node("node-beelink", "beelink", [{ id: "bk-web", hint: REPOSITORY }]),
      node("node-other", "other", [{ id: "api", hint: "github.com/acme/api" }]),
      node("node-laptop", "laptop", [{ id: "lp-web", hint: REPOSITORY }], false),
    ]);
    renderSwitcher();
    const select = screen.getByRole("combobox", { name: "Machine" });
    expect(select.textContent).toContain("This machine");
    fireEvent.click(select);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "This machine",
      "beelink",
      "laptopNot connected",
    ]);
    expect(options[2]!.getAttribute("aria-disabled")).toBe("true");
  });

  test("opens the same tab of the picked machine's copy of the project", async () => {
    seed([node("node-beelink", "beelink", [{ id: "bk-web", hint: REPOSITORY }])]);
    renderSwitcher("kanban");
    fireEvent.click(screen.getByRole("combobox", { name: "Machine" }));
    fireEvent.click(await screen.findByRole("option", { name: /beelink/ }));
    const remote = useRemoteWorkspaceStore.getState();
    expect(remote.requests["node-beelink"]?.request).toEqual({
      projectId: "bk-web",
      boardTab: "kanban",
    });
  });

  test("updates from warm project records when summaries miss an addition, removal or repoint", async () => {
    seed([
      node("node-added", "Added", []),
      node("node-removed", "Removed", [{ id: "deleted", hint: REPOSITORY }]),
      node("node-repointed", "Repointed", [{ id: "repointed", hint: REPOSITORY }]),
      node("node-cold", "Cold", [{ id: "cold-web", hint: REPOSITORY }]),
    ]);
    const added = openWarm("node-added", []);
    const removed = openWarm("node-removed", [project("deleted")]);
    const repointed = openWarm("node-repointed", [project("repointed")]);
    renderSwitcher();
    fireEvent.click(screen.getByRole("combobox", { name: "Machine" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "This machine",
      "Removed",
      "Repointed",
      "Cold",
    ]);

    act(() => {
      added
        .store(projectStore)
        .getState()
        .setProjects([project("new-web")]);
      removed.store(projectStore).getState().setProjects([]);
      repointed
        .store(projectStore)
        .getState()
        .setProjects([project("repointed", "github.com/acme/api")]);
    });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "This machine",
      "Added",
      "Cold",
    ]);
    fireEvent.click(screen.getByRole("option", { name: "Added" }));
    expect(useRemoteWorkspaceStore.getState().requests["node-added"]?.request).toEqual({
      projectId: "new-web",
      boardTab: "home",
    });
  });
});
