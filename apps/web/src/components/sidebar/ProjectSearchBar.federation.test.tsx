import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { portalStore } from "@/lib/portal/portal-store";
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

function renderSearch(projects = [localProject], environments = [localEnvironment]) {
  const onSelectProject = mock((_projectId: string) => undefined);
  const onSelectEnvironment = mock((_environmentId: string) => undefined);
  const onSelectMachineProject = mock((_machine: MachineView, _projectId: string) => undefined);
  render(
    <FederationProvider>
      <ProjectSearchBar
        projects={projects}
        environments={environments}
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

  for (const scope of ["remote", "local"] as const) {
    test(`an empty ${scope} machine keeps query-specific no-match copy`, async () => {
      if (scope === "remote") {
        uninstallDesktopFake();
        installDesktopFake({
          list: connectionList([MBP3]),
          datasets: { mbp3: { projects: [], environments: {} } },
        });
      }
      renderSearch(scope === "local" ? [] : [localProject], []);
      const input = await openAndType("telegram");
      await waitFor(() => expect(portalStore.getState().nodes.length).toBeGreaterThan(0));
      fireEvent.pointerDown(screen.getByTestId("project-search-filter"));
      fireEvent.click(
        await screen.findByRole("menuitemradio", {
          name: scope === "remote" ? /mbp3/ : /^This machine/,
        }),
      );
      expect(
        await screen.findByText("No projects or environments match that search."),
      ).toBeTruthy();
      expectDomAbsent(screen.queryByText("No projects yet"), "global empty-state copy");
      fireEvent.change(input, { target: { value: "" } });
      expect(await screen.findByText("No projects on this machine")).toBeTruthy();
    });
  }

  test("shows the initial empty state when no machine has projects", async () => {
    uninstallDesktopFake();
    installDesktopFake({
      list: connectionList([MBP3]),
      datasets: { mbp3: { projects: [], environments: {} } },
    });
    renderSearch([], []);
    await openAndType("");
    expect(await screen.findByText("No projects yet")).toBeTruthy();
  });

  test("arrow keys traverse local and remote projects before Enter reveals the remote project", async () => {
    const { onSelectProject, onSelectEnvironment, onSelectMachineProject } = renderSearch();
    const input = await openAndType("orkestrator");
    const local = await option("orkestrator-v2, project on This computer");
    const remote = await option("orkestrator-v2, project on mbp3");

    expect(local.getAttribute("aria-selected")).toBe("true");
    for (const [key, selected, unselected] of [
      ["ArrowDown", remote, local],
      ["ArrowUp", local, remote],
      ["ArrowDown", remote, local],
    ] as const) {
      fireEvent.keyDown(input, { key });
      expect(selected.getAttribute("aria-selected")).toBe("true");
      expect(unselected.getAttribute("aria-selected")).toBe("false");
      expect(input.getAttribute("aria-activedescendant")).toBe(selected.id);
    }
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelectMachineProject).toHaveBeenCalledTimes(1);
    expect(onSelectMachineProject).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "bk_mbp3" }),
      "ork-3",
    );
    expect(onSelectProject).not.toHaveBeenCalled();
    expect(onSelectEnvironment).not.toHaveBeenCalled();
    expectDomAbsent(screen.queryByRole("combobox"), "palette after remote project selection");
  });

  test("arrow keys traverse local and remote environments before Enter opens the remote workspace", async () => {
    const { onSelectProject, onSelectEnvironment, onSelectMachineProject } = renderSearch();
    const input = await openAndType("orkestrator");
    await option("run-desktop-app, environment of orkestrator-v2 on mbp3");
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.keyDown(input, { key: "Tab" });
    const local = await option("main, environment of orkestrator-v2 on This computer");
    const remote = await option("run-desktop-app, environment of orkestrator-v2 on mbp3");

    expect(local.getAttribute("aria-selected")).toBe("true");
    for (const [key, selected, unselected] of [
      ["ArrowDown", remote, local],
      ["ArrowUp", local, remote],
      ["ArrowDown", remote, local],
    ] as const) {
      fireEvent.keyDown(input, { key });
      expect(selected.getAttribute("aria-selected")).toBe("true");
      expect(unselected.getAttribute("aria-selected")).toBe("false");
      expect(input.getAttribute("aria-activedescendant")).toBe(selected.id);
    }
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useRemoteWorkspaceStore.getState().active).toMatchObject({
      nodeId: "bk_mbp3",
      projectId: "ork-3",
      environmentId: "run",
    });
    expect(onSelectProject).not.toHaveBeenCalled();
    expect(onSelectEnvironment).not.toHaveBeenCalled();
    expect(onSelectMachineProject).not.toHaveBeenCalled();
    expectDomAbsent(screen.queryByRole("combobox"), "palette after remote environment selection");
  });

  for (const close of ["Escape", "selection"] as const) {
    test(`closing via ${close} resets the machine filter when the palette reopens`, async () => {
      renderSearch();
      const input = await openAndType("orkestrator");
      await option("orkestrator-v2, project on mbp3");
      fireEvent.pointerDown(screen.getByTestId("project-search-filter"));
      fireEvent.click(await screen.findByRole("menuitemradio", { name: /mbp3/ }));
      expect(await screen.findByLabelText("Filter results: All, mbp3")).toBeTruthy();
      expectDomAbsent(
        screen.queryByRole("option", { name: "orkestrator-v2, project on This computer" }),
        "local project while scoped to mbp3",
      );

      if (close === "Escape") fireEvent.keyDown(input, { key: "Escape" });
      else fireEvent.click(await option("orkestrator-v2, project on mbp3"));
      expectDomAbsent(screen.queryByRole("combobox"), "closed palette");

      await openAndType("orkestrator");
      expect(await screen.findByLabelText("Filter results: All")).toBeTruthy();
      expect(await option("orkestrator-v2, project on This computer")).toBeTruthy();
      expect(await option("orkestrator-v2, project on mbp3")).toBeTruthy();
      expect(await option("orkestrator-v2, project on mini, offline")).toBeTruthy();
      fireEvent.pointerDown(screen.getByTestId("project-search-filter"));
      expect(
        (await screen.findByRole("menuitemradio", { name: "All machines" })).getAttribute(
          "aria-checked",
        ),
      ).toBe("true");
    });
  }

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
  test("navigation reported by an active realm leads the empty-query recent results", async () => {
    renderSearch();
    await openAndType("telegram");
    await option("telegram-scraper, project on mbp3");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    act(() => {
      useRemoteWorkspaceStore.getState().open("bk_mbp3", { projectId: "tg" });
      useRemoteWorkspaceStore
        .getState()
        .noteRealmSelection("bk_mbp3", { projectId: "ork-3", environmentId: "run" });
    });
    await openAndType("");
    const rows = screen.getAllByRole("option");
    expect(
      rows
        .find((row) => /, project on /.test(row.getAttribute("aria-label") ?? ""))
        ?.getAttribute("aria-label"),
    ).toBe("orkestrator-v2, project on mbp3");
    expect(
      rows
        .find((row) => /, environment of /.test(row.getAttribute("aria-label") ?? ""))
        ?.getAttribute("aria-label"),
    ).toBe("run-desktop-app, environment of orkestrator-v2 on mbp3");
  });

  for (const state of ["loading", "truncated"] as const) {
    test(`empty-query recent results warn about a ${state} machine with no rows`, async () => {
      renderSearch();
      await openAndType("");
      await option("telegram-scraper, project on mbp3");
      act(() =>
        portalStore.store.setState((current) => ({
          nodes: current.nodes.map((node) =>
            node.nodeId === "bk_mini"
              ? {
                  ...node,
                  available: true,
                  view: {
                    ...node.view,
                    connection: { ...node.view.connection, state: "connected" },
                  },
                  freshness: state === "loading" ? "initializing" : "current",
                  loadedAt: state === "loading" ? null : 1,
                  truncated: state === "truncated",
                  projects: [],
                  environments: [],
                }
              : node,
          ),
        })),
      );
      expect(screen.getByTestId("federated-search-incomplete")).toBeTruthy();
      fireEvent.pointerDown(screen.getByTestId("project-search-filter"));
      fireEvent.click(await screen.findByRole("menuitemradio", { name: /mbp3/ }));
      await waitFor(() =>
        expectDomAbsent(
          screen.queryByTestId("federated-search-incomplete"),
          "incomplete note for a complete machine",
        ),
      );
    });
  }

  test("a forgotten machine filter falls back to all machines", async () => {
    renderSearch();
    await openAndType("orkestrator");
    await option("orkestrator-v2, project on mbp3");
    fireEvent.pointerDown(screen.getByTestId("project-search-filter"));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /mbp3/ }));
    expect(await screen.findByLabelText("Filter results: All, mbp3")).toBeTruthy();
    act(() =>
      portalStore.store.setState((state) => ({
        nodes: state.nodes.filter((node) => node.nodeId !== "bk_mbp3"),
      })),
    );
    expect(await screen.findByLabelText("Filter results: All")).toBeTruthy();
    expect(await option("orkestrator-v2, project on This computer")).toBeTruthy();
    expect(await option("orkestrator-v2, project on mini, offline")).toBeTruthy();
  });

  for (const availability of ["offline", "stale"] as const) {
    test(`greyed ${availability} project accepts Enter and its environment accepts a click`, async () => {
      const { onSelectMachineProject, onSelectProject, onSelectEnvironment } = renderSearch();
      const input = await openAndType("telegram");
      await option("telegram-scraper, project on mbp3");
      act(() =>
        portalStore.store.setState((state) => ({
          nodes: state.nodes.map((node) =>
            node.nodeId === "bk_mbp3"
              ? {
                  ...node,
                  freshness: "stale",
                  available: availability !== "offline",
                  view: {
                    ...node.view,
                    connection: {
                      ...node.view.connection,
                      state: availability === "offline" ? "unavailable" : "connected",
                    },
                  },
                }
              : node,
          ),
        })),
      );
      const row = await option(`telegram-scraper, project on mbp3, ${availability}`);
      expect(row.className).toContain("opacity-60");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onSelectMachineProject).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: "bk_mbp3" }),
        "tg",
      );
      expect(onSelectProject).not.toHaveBeenCalled();
      await openAndType("run-desktop");
      fireEvent.click(
        await option(`run-desktop-app, environment of orkestrator-v2 on mbp3, ${availability}`),
      );
      expect(useRemoteWorkspaceStore.getState().active).toMatchObject({
        nodeId: "bk_mbp3",
        projectId: "ork-3",
        environmentId: "run",
      });
      expect(onSelectEnvironment).not.toHaveBeenCalled();
    });
  }
});
