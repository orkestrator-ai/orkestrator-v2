import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { projectKey, projectRef, type BackendId } from "@orkestrator/protocol/federation";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { FederationProvider } from "@/components/federation/FederationProvider";
import type { MachineView } from "@/lib/federation/aggregate";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { useConfigStore } from "@/stores/configStore";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useUIStore } from "@/stores/uiStore";
import type { Environment, Project } from "@/types";
import { ProjectSearchBar } from "./ProjectSearchBar";

const INITIAL_MACHINE_VIEW_STATE = useMachineViewStore.getState();
const INITIAL_REMOTE_WORKSPACE_STATE = useRemoteWorkspaceStore.getState();

const localProject: Project = {
  id: "ork-local",
  name: "orkestrator-v2",
  gitUrl: "https://github.com/acme/orkestrator-v2.git",
  localPath: "/code/orkestrator-v2",
  addedAt: "2026-01-01T00:00:00.000Z",
  order: 0,
};

const localEnvironment: Environment = {
  id: "env-local",
  projectId: "ork-local",
  name: "main",
  branch: "main",
  containerId: null,
  status: "running",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: "2026-09-13T08:00:00.000Z",
  networkAccessMode: "restricted",
  order: 0,
  environmentType: "local",
};

const MBP3 = remoteConnection("mbp3", "mbp3", "teal");
const MINI = remoteConnection("mini", "mini", "rose", { transport: "unreachable" });

function install() {
  return installDesktopFake({
    list: connectionList([MBP3, MINI]),
    datasets: {
      mbp3: {
        projects: [
          {
            id: "tg",
            name: "telegram-scraper",
            gitUrl: "git@github.com:acme/telegram-scraper.git",
            order: 0,
          },
          {
            id: "ork-3",
            name: "orkestrator-v2",
            gitUrl: "https://github.com/acme/orkestrator-v2.git",
            order: 1,
            defaultBranch: "develop",
          },
        ],
        environments: {
          "ork-3": [
            {
              id: "run",
              projectId: "ork-3",
              name: "run-desktop-app",
              branch: "develop",
              status: "stopped",
              worktreePath: "/Users/someone/worktrees/run-desktop-wt",
            },
          ],
        },
      },
      mini: {
        projects: [
          {
            id: "ork-m",
            name: "orkestrator-v2",
            gitUrl: "https://github.com/acme/orkestrator-v2.git",
            order: 0,
          },
        ],
        environments: {},
      },
    },
  });
}

function renderSearch() {
  const onSelectProject = mock((_projectId: string) => undefined);
  const onSelectEnvironment = mock((_environmentId: string) => undefined);
  const onSelectMachineProject = mock((_machine: MachineView, _projectId: string) => undefined);
  render(
    <FederationProvider>
      <ProjectSearchBar
        projects={[localProject]}
        environments={[localEnvironment]}
        onSelectProject={onSelectProject}
        onSelectEnvironment={onSelectEnvironment}
        onSelectMachineProject={onSelectMachineProject}
      />
    </FederationProvider>,
  );
  return { onSelectProject, onSelectEnvironment, onSelectMachineProject };
}

async function openAndType(query: string) {
  fireEvent.click(screen.getByTestId("project-search-trigger"));
  const input = await screen.findByRole("combobox", { name: "Search projects and environments" });
  fireEvent.change(input, { target: { value: query } });
  return input;
}

function option(name: string | RegExp) {
  return screen.findByRole("option", { name });
}

describe("ProjectSearchBar across machines", () => {
  beforeEach(() => {
    if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
    localStorage.removeItem("machine-view-storage");
    useMachineViewStore.setState(INITIAL_MACHINE_VIEW_STATE, true);
    useRemoteWorkspaceStore.setState(INITIAL_REMOTE_WORKSPACE_STATE, true);
    useUIStore.setState({ recentProjectIds: [] });
    useConfigStore.setState((state) => ({
      config: { ...state.config, repositories: {} },
    }));
    install();
  });

  afterEach(() => {
    cleanup();
    uninstallDesktopFake();
    useMachineViewStore.setState(INITIAL_MACHINE_VIEW_STATE, true);
    useRemoteWorkspaceStore.setState(INITIAL_REMOTE_WORKSPACE_STATE, true);
    localStorage.removeItem("machine-view-storage");
  });

  test("finds another machine's project with no environments in the one merged list", async () => {
    const { onSelectMachineProject } = renderSearch();
    const input = await openAndType("tel");
    const row = await option("telegram-scraper, project on mbp3");
    expect(within(row).getByText("mbp3")).toBeTruthy();
    expect(within(row).getByTestId("machine-dot")).toBeTruthy();
    expectDomAbsent(screen.queryByText("Other machines"), "separate machines section");
    expectDomAbsent(
      screen.queryByText("No projects or environments match that search."),
      "no-match message",
    );

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelectMachineProject).toHaveBeenCalledTimes(1);
    const [machine, projectId] = onSelectMachineProject.mock.calls[0]!;
    expect([machine.name, projectId]).toEqual(["mbp3", "tg"]);
  });

  test("lists a project once per machine, each labelled, offline rows greyed with the note", async () => {
    renderSearch();
    await openAndType("orkestrator");
    await option("orkestrator-v2, project on mbp3");
    const rows = screen
      .getAllByRole("option")
      .filter((row) => row.getAttribute("data-testid")?.startsWith("project-search-item"));
    const projectRows = rows.filter((row) => /, project on /.test(row.getAttribute("aria-label")!));
    expect(projectRows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "orkestrator-v2, project on This computer",
      "orkestrator-v2, project on mbp3",
      "orkestrator-v2, project on mini, offline",
    ]);
    const offline = projectRows[2]!;
    expect(offline.getAttribute("data-availability")).toBe("offline");
    expect(offline.className).toContain("opacity-60");
    expect(within(offline).getByTestId("project-search-availability").textContent).toBe("offline");
    expect(screen.getByTestId("federated-search-incomplete")).toBeTruthy();
  });

  test("remote rows match on branch and worktree directory and show primary from the leaf", async () => {
    renderSearch();
    await openAndType("run-desktop-wt");
    const row = await option("run-desktop-app, environment of orkestrator-v2 on mbp3");
    // mbp3 sent its configured default branch, so its develop worktree is primary.
    expect(within(row).getByText("primary")).toBeTruthy();
  });

  test("Tab and the machine filter apply to other machines' rows", async () => {
    renderSearch();
    const input = await openAndType("orkestrator");
    await option("run-desktop-app, environment of orkestrator-v2 on mbp3");

    fireEvent.keyDown(input, { key: "Tab" });
    expect(await screen.findByLabelText("Filter results: Projects")).toBeTruthy();
    expectDomAbsent(
      screen.queryByRole("option", { name: /run-desktop-app/ }),
      "remote environment under the projects filter",
    );
    fireEvent.keyDown(input, { key: "Tab" });
    expect(await screen.findByLabelText("Filter results: Environments")).toBeTruthy();
    expectDomAbsent(
      screen.queryByRole("option", { name: "orkestrator-v2, project on mbp3" }),
      "remote project under the environments filter",
    );
    fireEvent.keyDown(input, { key: "Tab" });

    fireEvent.pointerDown(screen.getByTestId("project-search-filter"));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /mbp3/ }));
    expect(await screen.findByLabelText("Filter results: All, mbp3")).toBeTruthy();
    await waitFor(() =>
      expectDomAbsent(
        screen.queryByRole("option", { name: "orkestrator-v2, project on This computer" }),
        "this machine's project under the mbp3 filter",
      ),
    );
    expect(screen.getByRole("option", { name: "orkestrator-v2, project on mbp3" })).toBeTruthy();
    // mini is out of scope, so its absence no longer makes the results incomplete.
    expectDomAbsent(screen.queryByTestId("federated-search-incomplete"), "incomplete note");

    fireEvent.pointerDown(screen.getByTestId("project-search-filter"));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^This machine/ }));
    expect(await screen.findByLabelText("Filter results: All, This computer")).toBeTruthy();
    await waitFor(() =>
      expectDomAbsent(
        screen.queryByRole("option", { name: "orkestrator-v2, project on mbp3" }),
        "mbp3 project under the this-machine filter",
      ),
    );
  });

  test("a remote environment opens on its machine and is recorded as recently used", async () => {
    const { onSelectEnvironment } = renderSearch();
    await openAndType("run-desktop");
    fireEvent.click(await option("run-desktop-app, environment of orkestrator-v2 on mbp3"));
    expect(onSelectEnvironment).not.toHaveBeenCalled();
    expect(useRemoteWorkspaceStore.getState().active?.nodeId).toBe("bk_mbp3");
    expect(useMachineViewStore.getState().recentKeys).toContain(
      projectKey(projectRef("bk_mbp3" as BackendId, "ork-3")),
    );
  });

  test("the empty-query recent list includes a recently used remote project first", async () => {
    useMachineViewStore.setState({
      recentKeys: [projectKey(projectRef("bk_mbp3" as BackendId, "tg"))],
    });
    renderSearch();
    fireEvent.click(screen.getByTestId("project-search-trigger"));
    await option("telegram-scraper, project on mbp3");
    const projectRows = screen
      .getAllByRole("option")
      .filter((row) => /, project on /.test(row.getAttribute("aria-label") ?? ""));
    expect(projectRows[0]!.getAttribute("aria-label")).toBe("telegram-scraper, project on mbp3");
    expect(screen.getByText("Recent projects")).toBeTruthy();
  });
});
