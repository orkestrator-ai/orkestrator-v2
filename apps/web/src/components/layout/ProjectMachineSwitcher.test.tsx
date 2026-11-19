import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { NodeSummary } from "@orkestrator/protocol/node-summaries";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { portalStore } from "@/lib/portal/portal-store";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { projectStore } from "@/stores/projectStore";
import { uiStore } from "@/stores/uiStore";
import { appCommandStore } from "@/test/app-command-store";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
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

function seed(nodes: NodeSummary[]) {
  appCommandStore(projectStore).setState({
    projects: [
      {
        id: "home-web",
        name: "web",
        order: 0,
        gitUrl: `https://${REPOSITORY}`,
        localPath: "/work/web",
      } as Project,
    ],
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
});
