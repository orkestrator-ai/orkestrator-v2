import { afterEach, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useBoundMachineView } from "@/components/federation/useMachineViews";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { activityRows } from "@/lib/federation/aggregate";
import { displayedActivityResolver } from "@/lib/environment-activity-sort";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useEnvironmentStore, useProjectStore, useUIStore } from "@/stores";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import type { Environment, Project } from "@/types";
import { HierarchicalSidebar, sortEnvironmentsByActivity } from "./HierarchicalSidebar";

const originalNative = window.orkestrator;
const initialBuilds = useBuildPipelineStore.getState();
const initialView = useMachineViewStore.getState();
const initialUI = useUIStore.getState();
const initialProjects = useProjectStore.getState();
const initialEnvironments = useEnvironmentStore.getState();

afterEach(() => {
  cleanup();
  useBuildPipelineStore.setState(initialBuilds, true);
  uninstallDesktopFake();
  window.orkestrator = originalNative;
  useMachineViewStore.setState(initialView, true);
  useUIStore.setState(initialUI, true);
  useProjectStore.setState(initialProjects, true);
  useEnvironmentStore.setState(initialEnvironments, true);
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
  useProjectStore.setState({ projects: [], hasLoaded: true });
  useEnvironmentStore.setState({ environments: [], deletingEnvironments: new Set() });
  useUIStore.setState({ environmentSortMode: "activity", activitySortOrder: "priority" });
  useMachineViewStore.setState({ machineFilter: "all" });
  render(
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
  useProjectStore.setState({ projects: [], hasLoaded: true });
  useEnvironmentStore.setState({ environments: [], deletingEnvironments: new Set() });
  const { container } = render(
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
  ).toEqual(["build", "working", "idle"]);
});

test("bound machine activity order rehydrates from the active build store", async () => {
  installDesktopFake({ list: connectionList([]), datasets: {} });
  const idle = { ...environment, id: "idle", agentActivityState: "idle", order: 0 } as Environment;
  const build = { ...idle, id: "build", order: 1 };
  useEnvironmentStore.setState({ environments: [idle, build] });
  useProjectStore.setState({ projects: [project] });
  const { result, unmount } = renderHook(() => useBoundMachineView(), {
    wrapper: FederationProvider,
  });
  await waitFor(() => expect(result.current).not.toBeNull());
  const ids = () => activityRows([result.current!]).map((row) => row.environment.ref.environmentId);
  expect(ids()).toEqual(["idle", "build"]);
  act(() => useBuildPipelineStore.setState({ activeBuildEnvironmentIds: new Set(["build"]) }));
  expect(ids()).toEqual(["build", "idle"]);
  unmount();
  const restored = renderHook(() => useBoundMachineView(), { wrapper: FederationProvider });
  await waitFor(() => expect(restored.result.current).not.toBeNull());
  expect(
    activityRows([restored.result.current!]).map((row) => row.environment.ref.environmentId),
  ).toEqual(["build", "idle"]);
});
