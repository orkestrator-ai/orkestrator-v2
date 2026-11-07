/**
 * The sidebar's compact group-by mode, on the real sidebar and stores: what it
 * shows and hides, where its icons lead, and how it is left.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { requestAppShortcut } from "@/lib/app-shortcuts";
import { agentMailStore, useAgentMailStore } from "@/stores/agentMailStore";
import { configStore, useConfigStore } from "@/stores/configStore";
import { coordinatorActivityStore } from "@/stores/coordinatorActivityStore";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { environmentStore, projectStore, uiStore } from "@/stores";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import type { Environment, Project } from "@/types";
import { HierarchicalSidebar } from "./HierarchicalSidebar";
import { appCommandStore } from "@/test/app-command-store";

const initialView = useMachineViewStore.getState();
const initialUI = appCommandStore(uiStore).getState();
const initialProjects = appCommandStore(projectStore).getState();
const initialEnvironments = appCommandStore(environmentStore).getState();
const initialRemote = useRemoteWorkspaceStore.getState();
const initialConfig = appCommandStore(configStore).getState();
const initialMail = appCommandStore(agentMailStore).getState();
const originalMatchMedia = window.matchMedia;

const SHARED_URL = "git@github.com:acme/app.git";
const localProject = {
  id: "local",
  name: "app",
  gitUrl: SHARED_URL,
  localPath: "/local",
  order: 0,
} as Project;
const localHome = {
  id: "local-home",
  projectId: "local",
  name: "app Home",
  projectHome: true,
  environmentType: "local",
  status: "running",
  worktreePath: "/local",
} as Environment;

function installTwoMachines() {
  installDesktopFake({
    list: connectionList([remoteConnection("leaf", "leaf", "teal")]),
    datasets: {
      leaf: {
        projects: [
          { id: "leaf-app", name: "app", gitUrl: SHARED_URL, order: 0 },
          { id: "leaf-tools", name: "tools", gitUrl: "git@github.com:acme/tools.git", order: 1 },
        ],
        environments: {
          "leaf-tools": [
            {
              id: "tools-home",
              projectId: "leaf-tools",
              name: "Home",
              status: "running",
              projectHome: true,
              agentActivityState: "working",
            },
            {
              id: "tools-feature",
              projectId: "leaf-tools",
              name: "feature",
              status: "running",
              hasUnreadWork: true,
            },
          ],
        },
      },
    },
    respondPortal: (command) =>
      command === "get_projects"
        ? [localProject]
        : command === "get_environments" || command === "get_environment_snapshots"
          ? [localHome]
          : undefined,
  });
}

function renderSidebar() {
  renderInAppCommandScope(
    <FederationProvider>
      <HierarchicalSidebar />
    </FederationProvider>,
  );
}

async function findCompactIcons(count: number): Promise<HTMLElement[]> {
  const list = await screen.findByTestId("compact-repository-list");
  await waitFor(() => expect(within(list).getAllByRole("button")).toHaveLength(count));
  return within(list).getAllByRole("button");
}

beforeEach(() => {
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
  useRemoteWorkspaceStore.setState({ active: null });
  appCommandStore(projectStore).getState().setProjects([localProject]);
  appCommandStore(environmentStore).getState().setEnvironments([localHome]);
  appCommandStore(uiStore).setState({
    selectedProjectId: null,
    selectedEnvironmentId: null,
    selectedEnvironmentIds: [],
    collapsedProjects: [],
  });
  useUIChromeStore.setState({
    environmentSortMode: "project",
  });
  useMachineViewStore.setState({
    grouping: "compact",
    groupingBeforeCompact: "machine",
    machineFilter: "all",
    collapsedMachines: [],
    collapsedProjectKeys: [],
    collapsedFolderKeys: [],
    revealedProject: null,
    openedRepository: null,
    recentKeys: [],
  });
});

afterEach(() => {
  cleanup();
  uninstallDesktopFake();
  window.matchMedia = originalMatchMedia;
  useMachineViewStore.setState(initialView, true);
  appCommandStore(uiStore).setState(initialUI, true);
  appCommandStore(projectStore).setState(initialProjects, true);
  appCommandStore(environmentStore).setState(initialEnvironments, true);
  useRemoteWorkspaceStore.setState(initialRemote, true);
  appCommandStore(configStore).setState(initialConfig, true);
  appCommandStore(agentMailStore).setState(initialMail, true);
  appCommandStore(coordinatorActivityStore).setState({ projects: new Map() });
});

describe("what compact shows", () => {
  test("one icon per repository, a repository on two machines being one", async () => {
    installTwoMachines();
    renderSidebar();
    const icons = await findCompactIcons(2);
    expect(icons.map((icon) => icon.getAttribute("aria-label")?.split(",")[0])).toEqual([
      "acme/app",
      "acme/tools",
    ]);
  });

  test("the header is the sort icon alone, and the search is gone", async () => {
    installTwoMachines();
    renderSidebar();
    await findCompactIcons(2);
    const header = document.querySelector("[data-sidebar-header]") as HTMLElement;
    expect(within(header).getAllByRole("button")).toHaveLength(1);
    expect(within(header).getByRole("button", { name: "Sidebar view: Compact" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Search/ }) === null).toBe(true);
    expect(screen.queryByTestId("project-search-dialog") === null).toBe(true);
    expect(screen.queryByTestId("machine-section-header") === null).toBe(true);
    expect(screen.queryByTestId("federated-repository-list") === null).toBe(true);
  });

  test("no text is drawn outside the tooltips", async () => {
    installTwoMachines();
    renderSidebar();
    await findCompactIcons(2);
    expect(document.querySelector("[data-sidebar-view=compact]")?.textContent).toBe("");
  });

  test("the footer actions stay reachable, stacked", async () => {
    installTwoMachines();
    renderSidebar();
    await findCompactIcons(2);
    const footer = document.querySelector("[data-sidebar-bottom-bar]") as HTMLElement;
    expect(footer.className).toContain("flex-col");
    expect(within(footer).getByRole("button", { name: "Global settings" })).toBeTruthy();
    expect(within(footer).getByRole("button", { name: "Report a bug" })).toBeTruthy();
  });

  test("a repository with no icon shows the house tile", async () => {
    installTwoMachines();
    renderSidebar();
    const [icon] = await findCompactIcons(2);
    const tile = within(icon!).getByTestId("command-node-home-icon");
    expect(tile.querySelector("svg")).toBeTruthy();
    expect(within(tile).queryByTestId("project-icon") === null).toBe(true);
  });

  test("a repository with an icon shows it through the shared tile", async () => {
    const icon = "data:image/png;base64,iVBORw0KGgo=";
    appCommandStore(projectStore)
      .getState()
      .setProjects([{ ...localProject, icon }]);
    renderSidebar();
    const [button] = await findCompactIcons(1);
    const tile = within(button!).getByTestId("command-node-home-icon");
    expect(within(tile).getByTestId("project-icon").getAttribute("src")).toBe(icon);
  });

  test("the machine filter does not hide a repository, since its control is gone", async () => {
    installTwoMachines();
    useMachineViewStore.setState({ machineFilter: "bk_self" });
    renderSidebar();
    await findCompactIcons(2);
  });

  test("a window naming no machines lists its projects", async () => {
    renderSidebar();
    const [icon] = await findCompactIcons(1);
    expect(icon!.getAttribute("aria-label")).toBe("app");
    fireEvent.click(icon!);
    expect(appCommandStore(uiStore).getState().selectedProjectId).toBe("local");
  });

  test("with no projects it offers to add one, without text", async () => {
    appCommandStore(projectStore).getState().setProjects([]);
    appCommandStore(environmentStore).getState().setEnvironments([]);
    renderSidebar();
    const [add] = await findCompactIcons(1);
    expect(add!.getAttribute("aria-label")).toBe("Add project");
    fireEvent.click(add!);
    expect(await screen.findByRole("dialog", { name: "Add project" })).toBeTruthy();
  });
});

describe("opening a repository", () => {
  test("clicking opens its project on the command node, selected, and stays compact", async () => {
    installTwoMachines();
    renderSidebar();
    const [app] = await findCompactIcons(2);
    fireEvent.click(app!);
    await waitFor(() =>
      expect(appCommandStore(uiStore).getState().selectedProjectId).toBe("local"),
    );
    expect(appCommandStore(uiStore).getState().projectBoardTab).toBe("coordinator");
    expect(useMachineViewStore.getState().grouping).toBe("compact");
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("compact-repository")[0]!
          .querySelector("button")
          ?.getAttribute("aria-current"),
      ).toBe("page"),
    );
    // Repository grouping would highlight the same heading.
    expect(useMachineViewStore.getState().openedRepository?.name).toBe("github.com/acme/app");
  });

  test("a repository only on another machine opens in that machine's workspace", async () => {
    installTwoMachines();
    renderSidebar();
    const [, tools] = await findCompactIcons(2);
    fireEvent.click(tools!);
    await waitFor(() =>
      expect(useRemoteWorkspaceStore.getState().active).toMatchObject({
        nodeId: "bk_leaf",
        projectId: "leaf-tools",
      }),
    );
    await waitFor(() => {
      const items = screen.getAllByTestId("compact-repository");
      expect(items[1]!.querySelector("button")?.getAttribute("aria-current")).toBe("page");
      expect(items[0]!.querySelector("button")?.getAttribute("aria-current")).toBeNull();
    });
  });

  test("an environment of the project keeps its repository selected", async () => {
    renderSidebar();
    const [icon] = await findCompactIcons(1);
    act(() =>
      appCommandStore(uiStore).setState({
        selectedProjectId: "local",
        selectedEnvironmentId: "env",
      }),
    );
    await waitFor(() => expect(icon!.getAttribute("aria-current")).toBe("page"));
  });
});

describe("status on an icon", () => {
  for (const activity of ["working", "waiting"] as const) {
    test("ordinary local environment " + activity + " survives remount", async () => {
      appCommandStore(environmentStore)
        .getState()
        .setEnvironments([
          localHome,
          {
            ...localHome,
            id: "feature",
            projectHome: false,
            agentActivityState: activity,
            agentActivityUpdatedAt: new Date().toISOString(),
          },
        ]);
      renderSidebar();
      let [icon] = await findCompactIcons(1);
      await waitFor(() =>
        expect(within(icon!).getByTestId("coordinator-activity-icon").dataset.state).toBe(activity),
      );
      cleanup();
      renderSidebar();
      [icon] = await findCompactIcons(1);
      expect(within(icon!).getByTestId("coordinator-activity-icon").dataset.state).toBe(activity);
    });
  }

  test("another machine's working home and unread work", async () => {
    installTwoMachines();
    renderSidebar();
    const [, tools] = await findCompactIcons(2);
    await waitFor(() =>
      expect(within(tools!).getByTestId("coordinator-activity-icon").dataset.state).toBe("working"),
    );
    expect(within(tools!).getByTestId("compact-repository-badge").dataset.badge).toBe("attention");
    expect(tools!.getAttribute("aria-label")).toBe("acme/tools, Working, Needs attention");
  });

  test("this window's coordinator, by the store its row reads", async () => {
    renderSidebar();
    const [icon] = await findCompactIcons(1);
    expect(within(icon!).getByTestId("coordinator-activity-icon").dataset.state).toBe("idle");
    act(() =>
      appCommandStore(coordinatorActivityStore).setState({
        projects: new Map([["local", "waiting"]]),
      }),
    );
    await waitFor(() =>
      expect(within(icon!).getByTestId("coordinator-activity-icon").dataset.state).toBe("waiting"),
    );
    act(() =>
      appCommandStore(coordinatorActivityStore).setState({
        projects: new Map([["local", "working"]]),
      }),
    );
    await waitFor(() =>
      expect(within(icon!).getByTestId("coordinator-activity-icon").dataset.state).toBe("working"),
    );
  });

  test("the ring and badge are outside the tile's layout", async () => {
    renderSidebar();
    const [icon] = await findCompactIcons(1);
    act(() =>
      appCommandStore(coordinatorActivityStore).setState({
        projects: new Map([["local", "working"]]),
      }),
    );
    await waitFor(() =>
      expect(within(icon!).getByTestId("coordinator-activity-ring").className).toContain(
        "absolute",
      ),
    );
    expect(within(icon!).getByTestId("coordinator-activity-icon").className).toContain("-m-[3px]");
  });

  test("unread agent mail is a dot, never a count", async () => {
    appCommandStore(configStore).setState({
      config: {
        ...appCommandStore(configStore).getState().config,
        global: {
          ...appCommandStore(configStore).getState().config.global,
          agentMessaging: { enabled: true },
        },
      } as ReturnType<typeof useConfigStore.getState>["config"],
    });
    appCommandStore(agentMailStore).setState({
      summary: new Map([
        ["mailbox", { projectId: "local", unreadCount: 12, failedInjectCount: 0 }],
      ]) as unknown as ReturnType<typeof useAgentMailStore.getState>["summary"],
    });
    renderSidebar();
    const [icon] = await findCompactIcons(1);
    expect(within(icon!).getByTestId("compact-repository-badge").dataset.badge).toBe("unread");
    expect(icon!.textContent).toBe("");
    expect(icon!.getAttribute("aria-label")).toBe("app, 12 unread agent messages");
  });
});

describe("the keyboard", () => {
  test("rotation reopens a hidden sidebar whose handler is still mounted", async () => {
    renderSidebar();
    await findCompactIcons(1);
    act(() => useUIChromeStore.setState({ sidebarOpen: false }));
    act(() => requestAppShortcut("rotate-sidebar-grouping"));
    expect(useUIChromeStore.getState().sidebarOpen).toBe(true);
    expect(useMachineViewStore.getState().grouping).toBe("machine");
  });

  test("an unreachable saved machine adds no rotation stops", async () => {
    installDesktopFake({
      list: connectionList([
        remoteConnection("leaf", "leaf", "teal", { transport: "unreachable" }),
      ]),
      datasets: {},
    });
    renderSidebar();
    await findCompactIcons(1);
    act(() => requestAppShortcut("rotate-sidebar-grouping"));
    expect(useMachineViewStore.getState().grouping).toBe("machine");
    act(() => requestAppShortcut("rotate-sidebar-grouping"));
    expect(useMachineViewStore.getState().grouping).toBe("compact");
  });

  test("activity rotation preserves sorting and restores grouping through both stores", async () => {
    installTwoMachines();
    useMachineViewStore.setState({ groupingBeforeCompact: "repository" });
    useUIChromeStore.setState({ environmentSortMode: "activity" });
    renderSidebar();
    await findCompactIcons(2);
    act(() => requestAppShortcut("rotate-sidebar-grouping"));
    expect(useMachineViewStore.getState().grouping).toBe("repository");
    expect(useUIChromeStore.getState().environmentSortMode).toBe("activity");
    expect(await screen.findByTestId("federated-activity-list")).toBeTruthy();
    act(() => requestAppShortcut("rotate-sidebar-grouping"));
    expect(useMachineViewStore.getState().grouping).toBe("compact");
    expect(useUIChromeStore.getState().environmentSortMode).toBe("activity");
    await findCompactIcons(2);
  });

  test("Up, Down, Home and End move focus", async () => {
    installTwoMachines();
    renderSidebar();
    const icons = await findCompactIcons(2);
    const app = icons[0]!;
    const tools = icons[1]!;
    app.focus();
    fireEvent.keyDown(app, { key: "ArrowDown" });
    expect(document.activeElement).toBe(tools);
    fireEvent.keyDown(tools, { key: "ArrowDown" });
    expect(document.activeElement).toBe(tools);
    fireEvent.keyDown(tools, { key: "Home" });
    expect(document.activeElement).toBe(app);
    fireEvent.keyDown(app, { key: "End" });
    expect(document.activeElement).toBe(tools);
    fireEvent.keyDown(tools, { key: "ArrowUp" });
    expect(document.activeElement).toBe(app);
    // Native Enter activation is asserted in e2e/SidebarMotion.spec.ts.
    expect(app.tagName).toBe("BUTTON");
    expect(app.className).toContain("focus-hairline");
  });

  test("the rotate shortcut leaves compact and comes back", async () => {
    installTwoMachines();
    renderSidebar();
    await findCompactIcons(2);
    act(() => requestAppShortcut("rotate-sidebar-grouping"));
    expect(useMachineViewStore.getState().grouping).toBe("machine");
    await waitFor(() =>
      expect(screen.queryByTestId("compact-repository-list") === null).toBe(true),
    );
    act(() => requestAppShortcut("rotate-sidebar-grouping"));
    expect(useMachineViewStore.getState().grouping).toBe("project");
    act(() => requestAppShortcut("rotate-sidebar-grouping"));
    expect(useMachineViewStore.getState().grouping).toBe("repository");
    act(() => requestAppShortcut("rotate-sidebar-grouping"));
    expect(useMachineViewStore.getState().grouping).toBe("compact");
    await findCompactIcons(2);
  });

  test("without another machine it rotates between the full list and compact", async () => {
    renderSidebar();
    await findCompactIcons(1);
    act(() => requestAppShortcut("rotate-sidebar-grouping"));
    expect(useMachineViewStore.getState().grouping).toBe("machine");
    act(() => requestAppShortcut("rotate-sidebar-grouping"));
    expect(useMachineViewStore.getState().grouping).toBe("compact");
  });
});

describe("leaving with the mouse", () => {
  test("the sort icon's menu changes the group-by mode", async () => {
    installTwoMachines();
    renderSidebar();
    await findCompactIcons(2);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Sidebar view: Compact" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "By repository" }));
    expect(useMachineViewStore.getState().grouping).toBe("repository");
    await waitFor(() =>
      expect(screen.queryByTestId("compact-repository-list") === null).toBe(true),
    );
    expect(await screen.findByTestId("federated-repository-list")).toBeTruthy();
  });

  test("the menu offers compact back, in the other modes", async () => {
    installTwoMachines();
    useMachineViewStore.setState({ grouping: "machine" });
    renderSidebar();
    fireEvent.pointerDown(await screen.findByRole("button", { name: /^Sort environments/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Compact" }));
    await findCompactIcons(2);
  });

  test("a window naming no machines has it too", async () => {
    useMachineViewStore.setState({ grouping: "machine" });
    renderSidebar();
    fireEvent.pointerDown(await screen.findByRole("button", { name: /^Sort environments/ }));
    expect(await screen.findByRole("menuitemradio", { name: "Full list" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Compact" }));
    await findCompactIcons(1);
  });

  test("the activity list is reachable from compact, restoring the grouping", async () => {
    installTwoMachines();
    useMachineViewStore.setState({ groupingBeforeCompact: "repository" });
    renderSidebar();
    await findCompactIcons(2);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Sidebar view: Compact" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "By activity" }));
    expect(useUIChromeStore.getState().environmentSortMode).toBe("activity");
    expect(useMachineViewStore.getState().grouping).toBe("repository");
    expect(await screen.findByTestId("federated-activity-list")).toBeTruthy();
  });

  test("compact is kept while sorted by activity, with nothing to sort", async () => {
    installTwoMachines();
    useUIChromeStore.setState({ environmentSortMode: "activity" });
    renderSidebar();
    await findCompactIcons(2);
    expect(screen.queryByTestId("federated-activity-list") === null).toBe(true);
  });
});

describe("other surfaces", () => {
  test("a multi-selection is cleared, having no rows to act on", async () => {
    appCommandStore(uiStore).setState({ selectedEnvironmentIds: ["env"] });
    renderSidebar();
    await findCompactIcons(1);
    await waitFor(() =>
      expect(appCommandStore(uiStore).getState().selectedEnvironmentIds).toEqual([]),
    );
  });

  test("the search shortcut opens nothing", async () => {
    installTwoMachines();
    renderSidebar();
    await findCompactIcons(2);
    act(() => requestAppShortcut("search-projects"));
    expect(screen.queryByTestId("project-search-dialog") === null).toBe(true);
    expect(screen.queryByRole("combobox") === null).toBe(true);
  });

  test("the phone layout falls back to the repository list and keeps the choice", async () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    installTwoMachines();
    renderSidebar();
    expect(await screen.findByTestId("federated-repository-list")).toBeTruthy();
    expect(screen.queryByTestId("compact-repository-list") === null).toBe(true);
    expect(useMachineViewStore.getState().grouping).toBe("compact");
  });
});
