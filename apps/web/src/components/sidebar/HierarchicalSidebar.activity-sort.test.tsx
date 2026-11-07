import { afterEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope, renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import { useBoundMachineView } from "@/components/federation/useMachineViews";
import { buildPipelineStore } from "@/stores/buildPipelineStore";
import { activityRows } from "@/lib/federation/aggregate";
import { displayedActivityResolver } from "@/lib/environment-activity-sort";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { environmentStore, projectStore, uiStore } from "@/stores";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import type { Environment, Project } from "@/types";
import { HierarchicalSidebar, sortEnvironmentsByActivity } from "./HierarchicalSidebar";
import { appCommandStore } from "@/test/app-command-store";

const originalNative = window.orkestrator;
const initialBuilds = appCommandStore(buildPipelineStore).getState();
const initialView = useMachineViewStore.getState();
const initialUI = appCommandStore(uiStore).getState();
const initialProjects = appCommandStore(projectStore).getState();
const initialEnvironments = appCommandStore(environmentStore).getState();

afterEach(() => {
  cleanup();
  appCommandStore(buildPipelineStore).setState(initialBuilds, true);
  uninstallDesktopFake();
  window.orkestrator = originalNative;
  useMachineViewStore.setState(initialView, true);
  appCommandStore(uiStore).setState(initialUI, true);
  appCommandStore(projectStore).setState(initialProjects, true);
  appCommandStore(environmentStore).setState(initialEnvironments, true);
});

const project: Project = {
  id: "p",
  name: "App",
  gitUrl: "https://github.com/acme/app.git",
  localPath: null,
  addedAt: "2026-10-21T00:00:00Z",
  order: 0,
};
const environment: Environment = {
  id: "a",
  projectId: "p",
  name: "A",
  branch: "main",
  containerId: null,
  environmentType: "local",
  status: "running",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2026-10-21T00:00:00Z",
  networkAccessMode: "restricted",
  order: 0,
  agentActivityState: "working",
  lastActivityAt: "2026-10-21T12:00:00Z",
  agentActivityUpdatedAt: "2026-10-21T09:00:00Z",
};

function displayedNames(): string[] {
  return Array.from(
    screen
      .getByTestId("federated-activity-list")
      .querySelectorAll<HTMLElement>('[data-testid="federated-environment-row"]'),
  ).map((row) =>
    within(row)
      .getByRole("button", { name: /, on Machine/ })
      .getAttribute("aria-label")!
      .split(",")[0]!
      .toLowerCase(),
  );
}

async function chooseOrder(label: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Sort environments: By activity" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: label }));
}

test("sidebar menu orders cross-machine activity and preserves the order under a machine filter", async () => {
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
  const b: Environment = {
    ...environment,
    id: "b",
    name: "B",
    lastActivityAt: "2026-10-21T11:00:00Z",
    agentActivityUpdatedAt: "2026-10-21T11:00:00Z",
  };
  const c: Environment = {
    ...environment,
    id: "c",
    name: "C",
    lastActivityAt: "2026-10-21T10:00:00Z",
    agentActivityUpdatedAt: "2026-10-21T15:00:00Z",
  };
  installDesktopFake({
    list: connectionList([
      remoteConnection("a", "Machine A", "teal"),
      remoteConnection("b", "Machine B", "rose"),
    ]),
    datasets: {
      a: { projects: [{ ...project }], environments: { p: [{ ...c }, { ...environment }] } },
      b: { projects: [{ ...project }], environments: { p: [{ ...b }] } },
    },
    respondPortal: (command) => (command === "get_projects" ? [] : undefined),
  });
  appCommandStore(projectStore).setState({ projects: [], hasLoaded: true });
  appCommandStore(environmentStore).setState({ environments: [], deletingEnvironments: new Set() });
  useUIChromeStore.setState({ environmentSortMode: "activity", activitySortOrder: "priority" });
  useMachineViewStore.setState({ machineFilter: "all" });
  renderInAppCommandScope(
    <FederationProvider>
      <HierarchicalSidebar />
    </FederationProvider>,
  );
  // Priority recency is lastActivityAt (a 12:00, b 11:00, c 10:00); c's later
  // snapshot time is a refresh, not activity.
  await waitFor(() => expect(displayedNames()).toEqual(["a", "b", "c"]));

  for (const [label, order, expected] of [
    ["Newest first", "newest", ["a", "b", "c"]],
    ["Oldest first", "oldest", ["c", "b", "a"]],
  ] as const) {
    await chooseOrder(label);
    await waitFor(() => expect(displayedNames()).toEqual([...expected]));
    expect(
      sortEnvironmentsByActivity([c, b, environment], [project], order).map((env) => env.id),
    ).toEqual([...expected]);
  }

  fireEvent.pointerDown(screen.getByTestId("machines-filter"));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Machine A,/ }));
  await waitFor(() => expect(displayedNames()).toEqual(["c", "a"]));
  await chooseOrder("Newest first");
  await waitFor(() => expect(displayedNames()).toEqual(["a", "c"]));
  expect(useMachineViewStore.getState().machineFilter).toBe("bk_a");
});

for (const order of ["newest", "oldest"] as const) {
  test(`local ${order} order follows actual activity and ignores snapshot refreshes`, () => {
    const a = { ...environment };
    const b = {
      ...environment,
      id: "b",
      lastActivityAt: "2026-10-21T11:00:00Z",
      agentActivityUpdatedAt: "2026-10-21T11:00:00Z",
    };
    const ids = () => sortEnvironmentsByActivity([a, b], [project], order).map((env) => env.id);
    expect(ids()).toEqual(order === "newest" ? ["a", "b"] : ["b", "a"]);
    b.lastActivityAt = "2026-10-21T13:00:00Z";
    expect(ids()).toEqual(order === "newest" ? ["b", "a"] : ["a", "b"]);
    a.agentActivityUpdatedAt = "2026-10-21T14:00:00Z";
    expect(ids()).toEqual(order === "newest" ? ["b", "a"] : ["a", "b"]);
  });
}

test("the static bottom bar follows the scrolling list, outside it", async () => {
  installDesktopFake({
    list: connectionList([remoteConnection("a", "Machine A", "teal")]),
    datasets: { a: { projects: [{ ...project }], environments: { p: [{ ...environment }] } } },
    respondPortal: (command) => (command === "get_projects" ? [] : undefined),
  });
  appCommandStore(projectStore).setState({ projects: [], hasLoaded: true });
  appCommandStore(environmentStore).setState({ environments: [], deletingEnvironments: new Set() });
  const { container } = renderInAppCommandScope(
    <FederationProvider>
      <HierarchicalSidebar />
    </FederationProvider>,
  );
  const settings = await screen.findByRole("button", { name: "Global settings" });
  const scroll = container.querySelector("[data-sidebar-scroll]")!;
  const bar = container.querySelector("[data-sidebar-bottom-bar]")!;
  expect(scroll.nextElementSibling).toBe(bar);
  expect(bar.contains(settings)).toBe(true);
  expect(within(bar as HTMLElement).getByRole("button", { name: "Report a bug" })).toBeTruthy();
});

test("an active build sorts with working environments even when persisted activity is idle", () => {
  const idle = { ...environment, id: "idle", agentActivityState: "idle", order: 0 } as Environment;
  const build = { ...idle, id: "build", order: 1 };
  const working = {
    ...idle,
    id: "working",
    agentActivityState: "working",
    order: 2,
  } as Environment;
  expect(
    sortEnvironmentsByActivity(
      [idle, build, working],
      [project],
      "priority",
      displayedActivityResolver({}, {}, new Set(["build"])),
    ).map((row) => row.id),
  ).toEqual(["idle", "build", "working"]);
});

test("bound machine activity order rehydrates from the active build store", async () => {
  installDesktopFake({ list: connectionList([]), datasets: {} });
  const build = {
    ...environment,
    id: "build",
    agentActivityState: "idle",
    order: 0,
  } as Environment;
  const idle = { ...build, id: "idle", order: 1 };
  appCommandStore(environmentStore).setState({ environments: [idle, build] });
  appCommandStore(projectStore).setState({ projects: [project] });
  const { result, unmount } = renderHookInAppCommandScope(() => useBoundMachineView(), {
    wrapper: FederationProvider,
  });
  await waitFor(() => expect(result.current).not.toBeNull());
  const ids = () => activityRows([result.current!]).map((row) => row.environment.ref.environmentId);
  expect(ids()).toEqual(["build", "idle"]);
  act(() =>
    appCommandStore(buildPipelineStore).setState({ activeBuildEnvironmentIds: new Set(["build"]) }),
  );
  expect(ids()).toEqual(["idle", "build"]);
  unmount();
  const restored = renderHookInAppCommandScope(() => useBoundMachineView(), {
    wrapper: FederationProvider,
  });
  await waitFor(() => expect(restored.result.current).not.toBeNull());
  expect(
    activityRows([restored.result.current!]).map((row) => row.environment.ref.environmentId),
  ).toEqual(["idle", "build"]);
});

test("this machine's merged environments sort below unmerged ones in the merged list", async () => {
  installDesktopFake({ list: connectionList([]), datasets: {} });
  const merged = { ...environment, id: "merged", prState: "merged", order: 0 } as Environment;
  const open = { ...environment, id: "open", prState: "open", order: 1 } as Environment;
  appCommandStore(environmentStore).setState({ environments: [merged, open] });
  appCommandStore(projectStore).setState({ projects: [project] });
  const { result, unmount } = renderHookInAppCommandScope(() => useBoundMachineView(), {
    wrapper: FederationProvider,
  });
  await waitFor(() => expect(result.current).not.toBeNull());
  expect(activityRows([result.current!]).map((row) => row.environment.ref.environmentId)).toEqual([
    "open",
    "merged",
  ]);
  unmount();
});
