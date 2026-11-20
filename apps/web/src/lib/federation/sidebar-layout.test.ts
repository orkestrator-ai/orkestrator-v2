import { describe, expect, test } from "bun:test";
import { emptyPortalLayout, type PortalLayout } from "@orkestrator/protocol/portal-layout";
import { projectKey, projectRef, type BackendId } from "@orkestrator/protocol/federation";
import { resolveProjectArrangement, buildProjectTree } from "@/lib/project-folders";
import type { MachineView } from "./aggregate";
import {
  arrangeMachines,
  buildRepositoryTree,
  inMachineOrder,
  mergeOrder,
  mergedProjectList,
  orderMachines,
  placeShown,
  registryOrder,
  repositoryArrangementUpdate,
  repositoryLabel,
  repositoryOpenTarget,
  repositoryProjectList,
} from "./sidebar-layout";
import type { FederatedProject } from "./summaries";

function project(
  node: string,
  id: string,
  order: number,
  extra: Partial<FederatedProject> = {},
): FederatedProject {
  const ref = projectRef(node as BackendId, id);
  return { ref, key: projectKey(ref), name: id, order, ...extra };
}

function machine(
  id: string,
  projects: FederatedProject[] = [],
  extra: Partial<MachineView> = {},
): MachineView {
  return {
    connectionId: id,
    backendId: id as BackendId,
    name: id,
    colorToken: "teal",
    bound: false,
    freshness: "current",
    transport: "connected",
    projects,
    environmentsByProject: new Map(),
    truncated: false,
    loadedAt: 1,
    ...extra,
  };
}

const key = (node: string, id: string) => projectKey(projectRef(node as BackendId, id));
const names = (items: ReadonlyArray<{ project: FederatedProject }>) =>
  items.map((item) => `${item.project.ref.backendId}/${item.project.name}`);

function layout(extra: Partial<PortalLayout> = {}): PortalLayout {
  return { ...emptyPortalLayout(), ...extra };
}

describe("order merging", () => {
  test("new entries go after their predecessor in the defaults; stored ones keep their place", () => {
    expect(mergeOrder(["c", "a"], ["a", "b", "c", "d"])).toEqual(["c", "d", "a", "b"]);
    expect(mergeOrder([], ["a", "b"])).toEqual(["a", "b"]);
    expect(mergeOrder(["gone", "a"], ["new", "a"])).toEqual(["new", "gone", "a"]);
  });

  test("a drag over the shown entries leaves hidden ones in their slots", () => {
    expect(placeShown(["a", "hidden", "b", "c"], ["c", "a", "b"])).toEqual([
      "c",
      "hidden",
      "a",
      "b",
    ]);
  });
});

describe("machine order", () => {
  const control = machine("bk_control");
  const leafA = machine("bk_a");
  const leafB = machine("bk_b", [], { transport: "unreachable" });
  const registry = ["bk_control", "bk_a", "bk_b"];

  test("the command node comes first, then the registry order, whichever machine is bound", () => {
    const boundLeaf = { ...leafB, bound: true };
    const machines = registryOrder([boundLeaf, control, leafA], registry);
    expect(orderMachines(machines, layout(), "bk_control").map((m) => m.connectionId)).toEqual([
      "bk_control",
      "bk_a",
      "bk_b",
    ]);
  });

  test("a stored order wins and a machine added later goes after its predecessor", () => {
    const leafC = machine("bk_c");
    const machines = registryOrder([control, leafA, leafB, leafC], [...registry, "bk_c"]);
    const stored = layout({ machineOrder: ["bk_control", "bk_b", "bk_a"] });
    expect(orderMachines(machines, stored, "bk_control").map((m) => m.connectionId)).toEqual([
      "bk_control",
      "bk_b",
      "bk_c",
      "bk_a",
    ]);
  });

  test("moving a shown machine keeps a hidden one's place and drops a forgotten one", () => {
    const stored = layout({ machineOrder: ["bk_control", "bk_b", "bk_forgotten", "bk_a"] });
    const next = arrangeMachines(
      [control, leafA, leafB],
      [control, leafA],
      stored,
      "bk_control",
      "bk_a",
      "bk_control",
    );
    expect(next).toEqual(["bk_a", "bk_b", "bk_control"]);
  });

  test("the machine lists show the command node first wherever it is stored", () => {
    const ids = ["bk_a", "bk_control", "bk_b", "bk_new"];
    expect(
      inMachineOrder(ids, (id) => id, ["bk_b", "bk_control", "bk_gone", "bk_a"], "bk_control"),
    ).toEqual(["bk_control", "bk_b", "bk_new", "bk_a"]);
    expect(inMachineOrder(ids, (id) => id, [], null)).toEqual(ids);
  });

  test("moving the machines around the command node leaves its stored place alone", () => {
    const next = arrangeMachines(
      [control, leafA, leafB],
      [leafA, leafB],
      layout({ machineOrder: ["bk_a", "bk_control", "bk_b"] }),
      "bk_control",
      "bk_b",
      "bk_a",
    );
    expect(next).toEqual(["bk_b", "bk_control", "bk_a"]);
  });
});

describe("the default project order across machines", () => {
  const control = machine("bk_control", [
    project("bk_control", "zeta", 0),
    project("bk_control", "beta", 2, { folder: "Work" }),
    project("bk_control", "alpha", 1, { folder: "Work" }),
  ]);
  const leaf = machine("bk_leaf", [
    project("bk_leaf", "one", 0),
    project("bk_leaf", "two", 1, { folder: "Work" }),
  ]);
  const offline = machine("bk_offline", [project("bk_offline", "far", 0)], {
    transport: "unreachable",
  });
  const shown = new Set(["bk_control", "bk_leaf"]);

  test("the command node's projects come first with their folders, other machines below", () => {
    // Even when the user moved another machine's tile above it.
    const list = mergedProjectList([leaf, control, offline], shown, layout(), "bk_control");
    expect(names(list.shown)).toEqual([
      "bk_control/zeta",
      "bk_control/alpha",
      "bk_control/beta",
      "bk_leaf/one",
      "bk_leaf/two",
    ]);
    // A machine that is not connected is hidden but keeps its place.
    expect(list.full).toContain(key("bk_offline", "far"));
    const tree = buildProjectTree(list.shown);
    expect(
      tree.map((entry) =>
        entry.kind === "folder"
          ? `${entry.name}[${names(entry.projects).join(",")}]`
          : names([entry.project])[0],
      ),
    ).toEqual([
      "bk_control/zeta",
      "Work[bk_control/alpha,bk_control/beta,bk_leaf/two]",
      "bk_leaf/one",
    ]);
  });
});

describe("the repository order", () => {
  const control = machine("bk_control", [
    project("bk_control", "app", 0, { repositoryHint: "github.com/acme/app" }),
    project("bk_control", "tools", 1),
  ]);
  const leaf = machine("bk_leaf", [
    project("bk_leaf", "app", 0, { repositoryHint: "github.com/acme/app" }),
  ]);
  const machines = [control, leaf];
  const shown = new Set(["bk_control", "bk_leaf"]);

  test("follows the default project order and groups by repository", () => {
    const list = repositoryProjectList(machines, shown, layout(), "bk_control");
    const tree = buildProjectTree(list.shown);
    expect(
      tree.map((entry) => (entry.kind === "folder" ? entry.name : entry.project.name)),
    ).toEqual(["github.com/acme/app", "tools"]);
  });

  test("groups can be reordered, but a project cannot leave its repository", () => {
    const list = repositoryProjectList(machines, shown, layout(), "bk_control");
    const moved = repositoryArrangementUpdate(
      list,
      machines,
      resolveProjectArrangement(key("bk_control", "tools"), "project-folder:github.com/acme/app", [
        ...list.shown,
      ]),
    );
    expect(moved).toBeNull();
    const reordered = repositoryArrangementUpdate(
      list,
      machines,
      resolveProjectArrangement("project-folder:github.com/acme/app", key("bk_control", "tools"), [
        ...list.shown,
      ]),
    );
    expect(reordered?.repositoryOrder).toEqual([
      key("bk_control", "tools"),
      key("bk_control", "app"),
      key("bk_leaf", "app"),
    ]);
  });

  test("a group's heading opens the command node's project, else the first shown", () => {
    const list = repositoryProjectList(
      machines,
      shown,
      layout({
        repositoryOrder: [
          key("bk_leaf", "app"),
          key("bk_control", "app"),
          key("bk_control", "tools"),
        ],
      }),
      "bk_control",
    );
    const group = list.shown.filter((item) => item.folder === "github.com/acme/app");
    expect(group[0]?.id).toBe(key("bk_leaf", "app"));
    expect(repositoryOpenTarget(group, "bk_control")?.id).toBe(key("bk_control", "app"));
    expect(repositoryOpenTarget(group, "bk_other")?.id).toBe(key("bk_leaf", "app"));
    expect(repositoryOpenTarget([], "bk_control")).toBeNull();
  });
});

test("repository identities retain long common prefixes and case-sensitive suffixes", () => {
  const prefix = `github.example/${"organization".repeat(6)}/`;
  const hints = [`${prefix}repository-a`, `${prefix}repository-b`, `${prefix}Repository-a`];
  const machines = [
    machine(
      "bk_a",
      hints.map((repositoryHint, i) => project("bk_a", String(i), i, { repositoryHint })),
    ),
  ];
  const list = repositoryProjectList(machines, new Set(["bk_a"]), layout(), null);
  const tree = buildRepositoryTree(list.shown);
  expect(tree.map((entry) => (entry.kind === "folder" ? entry.name : null))).toEqual(hints);
  expect(tree.map((entry) => (entry.kind === "folder" ? entry.key : null))).toEqual(hints);
});

test("repository labels preserve namespaces with shared trailing segments", () => {
  expect(repositoryLabel("gitlab.example/team-a/shared/app")).toBe("team-a/shared/app");
  expect(repositoryLabel("gitlab.example/team-b/shared/app")).toBe("team-b/shared/app");
  expect(repositoryLabel("github.com/acme/app")).toBe("acme/app");
  expect(repositoryLabel("acme/app")).toBe("acme/app");
  expect(repositoryLabel("app")).toBe("app");
});
