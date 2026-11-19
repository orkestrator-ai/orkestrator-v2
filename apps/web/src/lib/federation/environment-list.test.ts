import { describe, expect, test } from "bun:test";
import { emptyPortalLayout, type PortalLayout } from "@orkestrator/protocol/portal-layout";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import type { MachineView } from "./aggregate";
import {
  byMachineDropTarget,
  manualOrderAfterDrop,
  mergeManualOrder,
  orderRepository,
  pruneEnvironmentOrder,
  repositoryEntries,
  repositoryGroupKey,
  repositoryOrderAfterMove,
  type EnvironmentsOf,
} from "./environment-list";
import type { FederatedEnvironment, FederatedProject } from "./summaries";

const REPO = "github.com/acme/app";

function project(
  node: string,
  id: string,
  extra: Partial<FederatedProject> = {},
): FederatedProject {
  const ref = projectRef(node as BackendId, id);
  return { ref, key: projectKey(ref), name: id, order: 0, repositoryHint: REPO, ...extra };
}

function environment(
  node: string,
  projectId: string,
  id: string,
  order: number,
): FederatedEnvironment {
  const ref = environmentRef(node as BackendId, id);
  return {
    ref,
    key: environmentKey(ref),
    projectId,
    name: id,
    order,
    status: "running",
    activity: "idle",
    hasUnreadWork: false,
    deleting: false,
    isProjectHome: false,
  } as FederatedEnvironment;
}

function machine(
  id: string,
  projects: FederatedProject[],
  environments: FederatedEnvironment[],
  extra: Partial<MachineView> = {},
): MachineView {
  const byProject = new Map<string, FederatedEnvironment[]>();
  for (const entry of environments) {
    byProject.set(entry.projectId, [...(byProject.get(entry.projectId) ?? []), entry]);
  }
  return {
    connectionId: id,
    backendId: id as BackendId,
    name: id,
    colorToken: "teal",
    bound: false,
    freshness: "current",
    transport: "connected",
    projects,
    environmentsByProject: byProject,
    truncated: false,
    loadedAt: 1,
    ...extra,
  };
}

const environmentsOf: EnvironmentsOf = (owner, member) =>
  [...(owner.environmentsByProject.get(member.ref.projectId) ?? [])].sort(
    (left, right) => left.order - right.order,
  );
const key = (node: string, id: string) => environmentKey(environmentRef(node as BackendId, id));
const layout = (extra: Partial<PortalLayout> = {}): PortalLayout => ({
  ...emptyPortalLayout(),
  ...extra,
});
const ids = (rows: ReadonlyArray<{ environment: FederatedEnvironment }>) =>
  rows.map((row) => `${row.environment.ref.backendId}/${row.environment.name}`);

function fleet() {
  const mini = machine(
    "mini",
    [project("mini", "app")],
    [environment("mini", "app", "m1", 0), environment("mini", "app", "m2", 1)],
  );
  const beelink = machine(
    "beelink",
    [project("beelink", "app"), project("beelink", "loose", { repositoryHint: undefined })],
    [environment("beelink", "app", "b1", 0), environment("beelink", "app", "b2", 1)],
  );
  const empty = machine("rkmbp", [project("rkmbp", "app")], []);
  return { mini, beelink, empty, machines: [mini, beelink, empty] };
}

const all = (machines: readonly MachineView[]) =>
  new Set(machines.map((entry) => entry.connectionId));

describe("repository entries", () => {
  test("one entry per repository, a project with none its own entry", () => {
    const { machines } = fleet();
    const { entries } = repositoryEntries(machines, all(machines), layout(), "mini");
    expect(entries.map((entry) => entry.label)).toEqual(["acme/app", "loose"]);
    expect(entries[0]!.members.map((member) => member.machine.name)).toEqual([
      "mini",
      "beelink",
      "rkmbp",
    ]);
    expect(entries[1]!.repository).toBeNull();
    expect(entries[1]!.key).toBe(repositoryGroupKey(fleet().beelink.projects[1]!));
  });

  test("a filtered-out machine leaves the shown members but stays in allMembers", () => {
    const { machines } = fleet();
    const { entries } = repositoryEntries(machines, new Set(["mini"]), layout(), "mini");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.members.map((member) => member.machine.name)).toEqual(["mini"]);
    expect(entries[0]!.allMembers).toHaveLength(3);
  });

  test("dragging a heading writes the repository order", () => {
    const { machines } = fleet();
    const repositories = repositoryEntries(machines, all(machines), layout(), "mini");
    const [first, second] = repositories.entries;
    const update = repositoryOrderAfterMove(repositories, machines, first!.dragId, second!.dragId);
    expect(update?.repositoryOrder[0]).toBe(
      projectKey(projectRef("beelink" as BackendId, "loose")),
    );
    expect(repositoryOrderAfterMove(repositories, machines, first!.dragId, first!.dragId)).toBe(
      null,
    );
  });
});

describe("ordering by machine", () => {
  test("groups each machine's environments in machine order", () => {
    const { machines } = fleet();
    const entry = repositoryEntries(machines, all(machines), layout(), "mini").entries[0]!;
    const byMachine = orderRepository(entry, machines, "machine", layout(), environmentsOf);
    expect(ids(byMachine.rows)).toEqual(["mini/m1", "mini/m2", "beelink/b1", "beelink/b2"]);
    // The machine order decides, not the members' list order.
    const reversed = [machines[1]!, machines[0]!, machines[2]!];
    expect(ids(orderRepository(entry, reversed, "machine", layout(), environmentsOf).rows)).toEqual(
      ["beelink/b1", "beelink/b2", "mini/m1", "mini/m2"],
    );
  });

  test("a drop stays within the dragged environment's own machine run", () => {
    const { machines } = fleet();
    const entry = repositoryEntries(machines, all(machines), layout(), "mini").entries[0]!;
    const { rows } = orderRepository(entry, machines, "machine", layout(), environmentsOf);
    expect(byMachineDropTarget(rows, key("mini", "m2"), key("mini", "m1"))?.over.id).toBe(
      key("mini", "m1"),
    );
    expect(byMachineDropTarget(rows, key("mini", "m2"), key("beelink", "b1"))).toBeNull();
    expect(byMachineDropTarget(rows, key("mini", "m2"), key("mini", "m2"))).toBeNull();
  });
});

describe("manual ordering", () => {
  test("defaults to the by-machine order until the user arranges it", () => {
    const { machines } = fleet();
    const entry = repositoryEntries(machines, all(machines), layout(), "mini").entries[0]!;
    expect(ids(orderRepository(entry, machines, "manual", layout(), environmentsOf).rows)).toEqual([
      "mini/m1",
      "mini/m2",
      "beelink/b1",
      "beelink/b2",
    ]);
  });

  test("follows the stored order, across machines", () => {
    const { machines } = fleet();
    const entry = repositoryEntries(machines, all(machines), layout(), "mini").entries[0]!;
    const stored = layout({
      environmentOrder: {
        [REPO]: [key("beelink", "b2"), key("mini", "m1"), key("beelink", "b1"), key("mini", "m2")],
      },
    });
    expect(ids(orderRepository(entry, machines, "manual", stored, environmentsOf).rows)).toEqual([
      "beelink/b2",
      "mini/m1",
      "beelink/b1",
      "mini/m2",
    ]);
    // By machine ignores the manual order but keeps it.
    expect(ids(orderRepository(entry, machines, "machine", stored, environmentsOf).rows)).toEqual([
      "mini/m1",
      "mini/m2",
      "beelink/b1",
      "beelink/b2",
    ]);
  });

  test("a new environment goes after the last one of its own machine", () => {
    expect(
      mergeManualOrder(
        [key("beelink", "b1"), key("mini", "m1"), key("beelink", "b2"), key("mini", "m2")],
        [key("mini", "m1"), key("mini", "m2"), key("mini", "new"), key("beelink", "b1")],
      ),
    ).toEqual([
      key("beelink", "b1"),
      key("mini", "m1"),
      key("beelink", "b2"),
      key("mini", "m2"),
      key("mini", "new"),
    ]);
    // A machine with no stored entry yet follows its predecessor in the defaults.
    expect(
      mergeManualOrder(
        [key("beelink", "b1"), key("mini", "m1")],
        [key("mini", "m1"), key("rkmbp", "r1"), key("beelink", "b1")],
      ),
    ).toEqual([key("beelink", "b1"), key("mini", "m1"), key("rkmbp", "r1")]);
  });

  test("a drag can place an environment between another machine's", () => {
    const { machines } = fleet();
    const entry = repositoryEntries(machines, all(machines), layout(), "mini").entries[0]!;
    const ordered = orderRepository(entry, machines, "manual", layout(), environmentsOf);
    const next = manualOrderAfterDrop(ordered, key("beelink", "b2"), key("mini", "m2"));
    expect(next).toEqual([
      key("mini", "m1"),
      key("beelink", "b2"),
      key("mini", "m2"),
      key("beelink", "b1"),
    ]);
  });

  test("with a filter, hidden machines' environments keep their places", () => {
    const { machines } = fleet();
    const stored = layout({
      environmentOrder: {
        [REPO]: [key("mini", "m1"), key("beelink", "b1"), key("mini", "m2"), key("beelink", "b2")],
      },
    });
    const entry = repositoryEntries(machines, new Set(["mini"]), stored, "mini").entries[0]!;
    const ordered = orderRepository(entry, machines, "manual", stored, environmentsOf);
    expect(ids(ordered.rows)).toEqual(["mini/m1", "mini/m2"]);
    const next = manualOrderAfterDrop(ordered, key("mini", "m2"), key("mini", "m1"));
    expect(next).toEqual([
      key("mini", "m2"),
      key("beelink", "b1"),
      key("mini", "m1"),
      key("beelink", "b2"),
    ]);
  });

  test("a confirmed deletion cannot anchor a new same-machine row", () => {
    const { mini, beelink } = fleet();
    const stored = layout({
      environmentOrder: { [REPO]: [key("mini", "m1"), key("beelink", "b1"), key("mini", "gone")] },
    });
    const active = [mini, beelink];
    const entry = repositoryEntries(active, all(active), stored, "mini").entries[0]!;
    expect(
      orderRepository(entry, active, "manual", stored, environmentsOf).full.slice(0, 3),
    ).toEqual([key("mini", "m1"), key("mini", "m2"), key("beelink", "b1")]);
    const offline = [{ ...mini, transport: "unreachable" as const }, beelink];
    const offlineEntry = repositoryEntries(offline, new Set(["beelink"]), stored, "mini")
      .entries[0]!;
    expect(orderRepository(offlineEntry, offline, "manual", stored, environmentsOf).full).toContain(
      key("mini", "gone"),
    );
  });

  test("a remote drop keeps saved local slots until the bound project snapshots arrive", () => {
    const { mini, beelink } = fleet();
    const saved = {
      [REPO]: [key("beelink", "b1"), key("mini", "m1"), key("beelink", "b2"), key("mini", "m2")],
    };
    const stored = layout({ environmentOrder: saved });
    const local = { ...mini, bound: true };
    const loading = [{ ...local, environmentsByProject: new Map() }, beelink];
    const entry = repositoryEntries(loading, all(loading), stored, "mini").entries[0]!;
    const ordered = orderRepository(entry, loading, "manual", stored, environmentsOf);
    const order = manualOrderAfterDrop(ordered, key("beelink", "b2"), key("beelink", "b1"))!;
    const ready = [{ ...local, boundEnvironmentsComplete: true }, beelink];
    const reloaded = layout({ environmentOrder: { [REPO]: order } });
    const readyEntry = repositoryEntries(ready, all(ready), reloaded, "mini").entries[0]!;
    expect(
      ids(orderRepository(readyEntry, ready, "manual", reloaded, environmentsOf).rows),
    ).toEqual(["beelink/b2", "mini/m1", "beelink/b1", "mini/m2"]);
  });

  test("a write drops environments a complete machine no longer has, and forgotten machines", () => {
    const { machines } = fleet();
    expect(
      pruneEnvironmentOrder(
        [key("mini", "m1"), key("mini", "gone"), key("ghost", "g1"), key("beelink", "b1")],
        machines,
        [key("mini", "m1"), key("beelink", "b1")],
      ),
    ).toEqual([key("mini", "m1"), key("beelink", "b1")]);
    // An unreachable machine's entries are kept: its list may be stale.
    const offline = machines.map((entry) =>
      entry.connectionId === "mini" ? { ...entry, transport: "unreachable" as const } : entry,
    );
    expect(pruneEnvironmentOrder([key("mini", "gone")], offline, [])).toEqual([
      key("mini", "gone"),
    ]);
  });
});
