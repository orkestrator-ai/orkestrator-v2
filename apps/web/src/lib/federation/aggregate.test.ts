import { describe, expect, test } from "bun:test";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import {
  activityRows,
  connectivitySummary,
  duplicateMachineColors,
  filterMachines,
  groupByMachine,
  groupByProject,
  groupByRepository,
  searchMachines,
  type MachineView,
} from "./aggregate";
import type { FederatedEnvironment, FederatedProject } from "./summaries";

function project(backendId: string, id: string, name: string, hint?: string): FederatedProject {
  const ref = projectRef(backendId as BackendId, id);
  return { ref, key: projectKey(ref), name, order: 0, ...(hint ? { repositoryHint: hint } : {}) };
}

function environment(
  backendId: string,
  id: string,
  projectId: string,
  extra: Partial<FederatedEnvironment> = {},
): FederatedEnvironment {
  const ref = environmentRef(backendId as BackendId, id);
  return {
    ref,
    key: environmentKey(ref),
    projectId,
    name: id,
    order: 0,
    status: "running",
    activity: "idle",
    hasUnreadWork: false,
    deleting: false,
    isProjectHome: false,
    ...extra,
  };
}

function machine(id: string, name: string, extra: Partial<MachineView> = {}): MachineView {
  return {
    connectionId: id,
    backendId: `bk_${id}` as BackendId,
    name,
    colorToken: "teal",
    bound: false,
    freshness: "current",
    transport: "connected",
    projects: [],
    environmentsByProject: new Map(),
    truncated: false,
    loadedAt: 1,
    ...extra,
  };
}

const mini = machine("mini", "Mac mini", {
  bound: true,
  colorToken: "violet",
  projects: [project("bk_mini", "p1", "Orkestrator", "github.com/acme/orkestrator")],
  environmentsByProject: new Map([
    [
      "p1",
      [
        environment("bk_mini", "env-1", "p1", {
          activity: "working",
          activityUpdatedAt: "2026-10-21T10:00:00Z",
        }),
      ],
    ],
  ]),
});
const vps = machine("vps", "Linux VPS", {
  colorToken: "blue",
  projects: [project("bk_vps", "p1", "Orkestrator", "github.com/acme/orkestrator")],
  environmentsByProject: new Map([
    [
      "p1",
      [
        environment("bk_vps", "env-1", "p1", {
          activity: "waiting",
          activityUpdatedAt: "2026-10-21T09:00:00Z",
        }),
      ],
    ],
  ]),
});
const laptop = machine("laptop", "MacBook Pro", {
  colorToken: "orange",
  transport: "unreachable",
  freshness: "stale",
  projects: [project("bk_laptop", "p9", "Angela Tools")],
  environmentsByProject: new Map([["p9", [environment("bk_laptop", "env-9", "p9")]]]),
});

describe("aggregate projections", () => {
  test("UI-01: duplicate project names stay separate instances with their owners", () => {
    const groups = groupByProject([mini, vps, laptop]);
    expect(groups.map((group) => `${group.project.name}@${group.machine.name}`)).toEqual([
      "Angela Tools@MacBook Pro",
      "Orkestrator@Mac mini",
      "Orkestrator@Linux VPS",
    ]);
    expect(new Set(groups.map((group) => group.project.key)).size).toBe(3);
  });

  test("by machine puts this window's own machine first and keeps backend order", () => {
    expect(groupByMachine([vps, laptop, mini]).map((group) => group.machine.name)).toEqual([
      "Mac mini",
      "Linux VPS",
      "MacBook Pro",
    ]);
  });

  test("UI-02: repository grouping is visual only and needs a published hint", () => {
    const groups = groupByRepository([mini, vps, laptop]);
    const orkestrator = groups.find((group) => group.repository === "github.com/acme/orkestrator");
    expect(orkestrator?.projects.map((group) => group.machine.name)).toEqual([
      "Mac mini",
      "Linux VPS",
    ]);
    expect(groups.find((group) => group.label === "Angela Tools")?.repository).toBeNull();
    // Each grouped project keeps its own record and owner.
    expect(orkestrator?.projects[0]!.project.key).not.toBe(orkestrator?.projects[1]!.project.key);
  });

  test("activity puts attention first and breaks ties deterministically", () => {
    const rows = activityRows([mini, vps, laptop]);
    expect(rows.map((row) => `${row.environment.ref.backendId}/${row.environment.name}`)).toEqual([
      "bk_vps/env-1",
      "bk_mini/env-1",
      "bk_laptop/env-9",
    ]);
  });

  test("connectivity never claims everything is current while a machine is missing", () => {
    const summary = connectivitySummary([mini, vps, laptop]);
    expect(summary.label).toBe("2 connected · 1 unavailable");
    expect(summary.complete).toBe(false);
    expect(connectivitySummary([mini, vps]).complete).toBe(true);
  });

  test("filtering changes presentation only and search reports incompleteness", () => {
    expect(filterMachines([mini, vps, laptop], "vps")).toEqual([vps]);
    expect(filterMachines([mini, vps], "all")).toHaveLength(2);
    const result = searchMachines([mini, vps, laptop], "angela");
    expect(result.rows.map((row) => row.environment.name)).toEqual(["env-9"]);
    expect(result.incomplete).toBe(true);
  });

  test("CL-03: shared colours are reported, never resolved automatically", () => {
    const collisions = duplicateMachineColors([
      { connectionId: "a", colorToken: "teal", name: "A" },
      { connectionId: "b", colorToken: "teal", name: "B" },
      { connectionId: "c", colorToken: "rose", name: "C" },
    ]);
    expect(Array.from(collisions.entries())).toEqual([["teal", ["a", "b"]]]);
  });
});
