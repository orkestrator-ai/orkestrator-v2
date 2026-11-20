/**
 * The compact sidebar's popover, on the real sidebar and stores: resting on a
 * repository icon lists its environments with the full sidebar's rows.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { FederationProvider } from "@/components/federation/FederationProvider";
import {
  HOVER_POPOVER_CLOSE_DELAY_MS,
  HOVER_POPOVER_EXIT_FALLBACK_MS,
  HOVER_POPOVER_OPEN_DELAY_MS,
} from "@/components/ui/hover-popover";
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
import {
  installControlledTimeout,
  type ControlledTimeout,
} from "../../../../../tests/helpers/controlled-timeout";

const initialView = useMachineViewStore.getState();
const initialUI = appCommandStore(uiStore).getState();
const initialProjects = appCommandStore(projectStore).getState();
const initialEnvironments = appCommandStore(environmentStore).getState();
const initialRemote = useRemoteWorkspaceStore.getState();
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
const featureA = {
  ...localHome,
  id: "feature-a",
  name: "feature-a",
  projectHome: false,
  order: 1,
} as Environment;
const featureB = {
  ...localHome,
  id: "feature-b",
  name: "feature-b",
  projectHome: false,
  status: "stopped",
  order: 2,
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
          "leaf-app": [{ id: "leaf-app-env", projectId: "leaf-app", name: "remote-app", order: 0 }],
          "leaf-tools": [
            {
              id: "tools-feature",
              projectId: "leaf-tools",
              name: "tools-feature",
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
          ? [localHome, featureA]
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

const timers: ControlledTimeout[] = [];
let openTimer: ControlledTimeout;
let closeTimer: ControlledTimeout;
let exitTimer: ControlledTimeout;

function popover(): HTMLElement | null {
  return screen.queryByTestId("compact-repository-popover");
}

/** Rests the pointer on an icon until its popover opens. */
function hoverOpen(icon: HTMLElement): HTMLElement {
  fireEvent.pointerEnter(icon);
  act(() => void openTimer.advance());
  const shown = popover();
  expect(shown !== null).toBe(true);
  return shown!;
}

/** Lets the close delay and the exit animation run out. */
function settleClose() {
  act(() => void closeTimer.advance());
  act(() => void exitTimer.advance());
}

beforeEach(() => {
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
  useRemoteWorkspaceStore.setState({ active: null });
  appCommandStore(projectStore).getState().setProjects([localProject]);
  appCommandStore(environmentStore).getState().setEnvironments([localHome, featureA, featureB]);
  appCommandStore(uiStore).setState({
    selectedProjectId: null,
    selectedEnvironmentId: null,
    selectedEnvironmentIds: [],
    collapsedProjects: [],
  });
  useUIChromeStore.setState({ environmentSortMode: "project" });
  useMachineViewStore.setState({
    grouping: "compact",
    machineFilter: [],
    collapsedMachines: [],
    collapsedProjectKeys: [],
    collapsedFolderKeys: [],
    revealedProject: null,
    openedRepository: null,
    recentKeys: [],
  });
  openTimer = installControlledTimeout(HOVER_POPOVER_OPEN_DELAY_MS, { label: "open delay" });
  closeTimer = installControlledTimeout(HOVER_POPOVER_CLOSE_DELAY_MS, { label: "close delay" });
  exitTimer = installControlledTimeout(HOVER_POPOVER_EXIT_FALLBACK_MS, { label: "exit" });
  timers.push(openTimer, closeTimer, exitTimer);
});

afterEach(() => {
  cleanup();
  for (const timer of timers.splice(0).reverse()) timer.restore();
  uninstallDesktopFake();
  window.matchMedia = originalMatchMedia;
  useMachineViewStore.setState(initialView, true);
  appCommandStore(uiStore).setState(initialUI, true);
  appCommandStore(projectStore).setState(initialProjects, true);
  appCommandStore(environmentStore).setState(initialEnvironments, true);
  useRemoteWorkspaceStore.setState(initialRemote, true);
});

describe("hovering an icon", () => {
  test("opens a popover with the project's name and its environments, as the full list rows them", async () => {
    appCommandStore(environmentStore)
      .getState()
      .setEnvironments([
        localHome,
        {
          ...featureA,
          agentActivityState: "working",
          agentActivityUpdatedAt: new Date().toISOString(),
        },
        featureB,
      ]);
    renderSidebar();
    const [icon] = await findCompactIcons(1);
    fireEvent.pointerEnter(icon!);
    // Passing the pointer across the rail opens nothing until it rests.
    expect(popover() === null).toBe(true);
    act(() => void openTimer.advance());
    const shown = popover()!;
    expect(shown.getAttribute("role")).toBe("dialog");
    expect(shown.getAttribute("aria-label")).toBe("app environments");
    expect(shown.dataset.state).toBe("open");
    expect(icon!.getAttribute("aria-expanded")).toBe("true");
    expect(icon!.getAttribute("aria-controls")).toBe(shown.id);
    expect(within(shown).getByText("app")).toBeTruthy();
    const rows = within(shown).getAllByTestId("repository-environment-row");
    // The project home is the icon's own status, as on the full list's header.
    expect(rows.map((row) => within(row).getByText(/^feature-/).textContent)).toEqual([
      "feature-a",
      "feature-b",
    ]);
    // The shared row: its status marker, with the environment's own state.
    const markers = rows.map((row) => within(row).getByTestId("environment-status-marker"));
    expect(markers.map((marker) => marker.dataset.shape)).toEqual(["circle", "circle"]);
    expect(markers.map((marker) => marker.dataset.state)).toEqual(["working", "idle"]);
    // Rows in a hover popover are not dragged.
    expect(within(shown).queryByRole("button", { name: /^Reorder / }) === null).toBe(true);
  });

  test("the pointer leaving the icon and the popover closes it, leaving only the icon", async () => {
    renderSidebar();
    const [icon] = await findCompactIcons(1);
    hoverOpen(icon!);
    fireEvent.pointerLeave(icon!);
    expect(popover()?.dataset.state).toBe("open");
    act(() => void closeTimer.advance());
    // It slides back in before it goes.
    expect(popover()?.dataset.state).toBe("closed");
    act(() => void exitTimer.advance());
    expect(popover() === null).toBe(true);
    expect(icon!.getAttribute("aria-expanded")).toBe("false");
  });

  test("moving from the icon into the popover keeps it open, across the gap", async () => {
    renderSidebar();
    const [icon] = await findCompactIcons(1);
    const shown = hoverOpen(icon!);
    fireEvent.pointerLeave(icon!);
    fireEvent.pointerEnter(shown.parentElement!);
    expect(closeTimer.pendingCount()).toBe(0);
    expect(popover()?.dataset.state).toBe("open");
    fireEvent.pointerLeave(shown.parentElement!);
    settleClose();
    expect(popover() === null).toBe(true);
  });

  test("moving to another icon replaces the popover; only one is ever shown", async () => {
    installTwoMachines();
    renderSidebar();
    const [app, tools] = await findCompactIcons(2);
    hoverOpen(app!);
    expect(popover()!.dataset.repository).toBe("github.com/acme/app");
    fireEvent.pointerLeave(app!);
    fireEvent.pointerEnter(tools!);
    // Already open, so the switch waits for no delay.
    expect(openTimer.pendingCount()).toBe(0);
    expect(screen.getAllByTestId("compact-repository-popover")).toHaveLength(1);
    expect(popover()!.dataset.repository).toBe("github.com/acme/tools");
    expect(app!.getAttribute("aria-expanded")).toBe("false");
    expect(tools!.getAttribute("aria-expanded")).toBe("true");
  });

  test("a repository on two machines lists both machines' environments, by machine", async () => {
    installTwoMachines();
    renderSidebar();
    const [app] = await findCompactIcons(2);
    const shown = hoverOpen(app!);
    await waitFor(() => {
      const rows = within(shown).getAllByRole("button", { name: /feature-a|remote-app/ });
      expect(rows.map((row) => row.getAttribute("aria-label")?.split(",")[0])).toEqual([
        "feature-a",
        "remote-app",
      ]);
    });
    expect(within(shown).getAllByTestId("repository-environment-row")).toHaveLength(1);
    expect(within(shown).getAllByTestId("federated-environment-row")).toHaveLength(1);
  });

  test("another machine's repository shows its rows and its status", async () => {
    installTwoMachines();
    renderSidebar();
    const [, tools] = await findCompactIcons(2);
    const shown = hoverOpen(tools!);
    await waitFor(() =>
      expect(within(shown).getByTestId("federated-environment-row").textContent).toContain(
        "tools-feature",
      ),
    );
    expect(within(shown).getByText(/Needs attention/)).toBeTruthy();
  });

  test("a project with no environments shows its name and an empty state", async () => {
    appCommandStore(environmentStore).getState().setEnvironments([localHome]);
    renderSidebar();
    const [icon] = await findCompactIcons(1);
    const shown = hoverOpen(icon!);
    expect(within(shown).getByText("app")).toBeTruthy();
    expect(within(shown).getByTestId("compact-popover-empty").textContent).toBe("No environments");
    expect(within(shown).queryAllByTestId("repository-environment-row")).toHaveLength(0);
  });
});

describe("opening from the popover", () => {
  test("clicking an environment opens it as the full list does, and closes the popover", async () => {
    renderSidebar();
    const [icon] = await findCompactIcons(1);
    const shown = hoverOpen(icon!);
    fireEvent.click(within(shown).getByRole("button", { name: /^feature-b/ }));
    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("feature-b");
    expect(appCommandStore(uiStore).getState().selectedProjectId).toBe("local");
    act(() => void exitTimer.advance());
    expect(popover() === null).toBe(true);
  });

  test("clicking the icon still opens the project", async () => {
    renderSidebar();
    const [icon] = await findCompactIcons(1);
    hoverOpen(icon!);
    fireEvent.click(icon!);
    expect(appCommandStore(uiStore).getState().selectedProjectId).toBe("local");
    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBeNull();
  });
});

describe("the keyboard", () => {
  test("Right moves into the popover; Up and Down move among its rows; Enter opens one", async () => {
    renderSidebar();
    const [icon] = await findCompactIcons(1);
    act(() => icon!.focus());
    fireEvent.keyDown(icon!, { key: "ArrowRight" });
    const shown = popover()!;
    const rows = within(shown).getAllByRole("button", { name: /^feature-/ });
    expect(document.activeElement).toBe(rows[0]!);
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]!);
    fireEvent.keyDown(rows[1]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows[0]!);
    fireEvent.keyDown(rows[0]!, { key: "End" });
    expect(document.activeElement).toBe(rows[1]!);
    fireEvent.keyDown(rows[1]!, { key: "Enter" });
    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("feature-b");
    expect(popover()?.dataset.state).toBe("closed");
  });

  test("Escape closes the popover and returns focus to the icon", async () => {
    renderSidebar();
    const [icon] = await findCompactIcons(1);
    act(() => icon!.focus());
    fireEvent.keyDown(icon!, { key: "ArrowRight" });
    const row = within(popover()!).getAllByRole("button", { name: /^feature-/ })[0]!;
    expect(document.activeElement).toBe(row);
    fireEvent.keyDown(row, { key: "Escape" });
    expect(document.activeElement).toBe(icon!);
    expect(popover()?.dataset.state).toBe("closed");
    act(() => void exitTimer.advance());
    expect(popover() === null).toBe(true);
    expect(icon!.getAttribute("aria-expanded")).toBe("false");
  });

  test("Escape on the icon closes a popover it opened", async () => {
    renderSidebar();
    const [icon] = await findCompactIcons(1);
    hoverOpen(icon!);
    act(() => icon!.focus());
    fireEvent.keyDown(icon!, { key: "Escape" });
    expect(popover()?.dataset.state).toBe("closed");
  });

  test("Tab past the last row returns to the icon", async () => {
    appCommandStore(environmentStore).getState().setEnvironments([localHome, featureA]);
    renderSidebar();
    const [icon] = await findCompactIcons(1);
    act(() => icon!.focus());
    fireEvent.keyDown(icon!, { key: "ArrowRight" });
    const shown = popover()!;
    const focusable = Array.from(
      shown.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    const last = focusable[focusable.length - 1]!;
    act(() => last.focus());
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(icon!);
    expect(popover()?.dataset.state).toBe("closed");
  });

  test("an empty popover still takes focus, and Escape returns it", async () => {
    appCommandStore(environmentStore).getState().setEnvironments([localHome]);
    renderSidebar();
    const [icon] = await findCompactIcons(1);
    act(() => icon!.focus());
    fireEvent.keyDown(icon!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(popover()!);
    fireEvent.keyDown(popover()!, { key: "Escape" });
    expect(document.activeElement).toBe(icon!);
  });
});

describe("motion", () => {
  test("under reduced motion the popover disappears without the slide", async () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    renderSidebar();
    const [icon] = await findCompactIcons(1);
    hoverOpen(icon!);
    fireEvent.pointerLeave(icon!);
    act(() => void closeTimer.advance());
    expect(popover() === null).toBe(true);
  });
});

describe("outside compact", () => {
  test("the full list draws no popover", async () => {
    useMachineViewStore.setState({ grouping: "repository" });
    renderSidebar();
    await screen.findByText("feature-a");
    expect(screen.queryByTestId("compact-repository-list") === null).toBe(true);
    expect(popover() === null).toBe(true);
  });
});
