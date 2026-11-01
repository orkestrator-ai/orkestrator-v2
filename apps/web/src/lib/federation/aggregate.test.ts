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
          lastActivityAt: "2026-10-21T10:00:00Z",
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
          lastActivityAt: "2026-10-21T09:00:00Z",
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
  test("activity puts attention first and breaks ties deterministically", () => {
    const rows = activityRows([mini, vps, laptop]);
    expect(rows.map((row) => `${row.environment.ref.backendId}/${row.environment.name}`)).toEqual([
      "bk_vps/env-1",
      "bk_mini/env-1",
      "bk_laptop/env-9",
    ]);
  });

  test("newest and oldest first order by activity time alone", () => {
    const names = (rows: ReturnType<typeof activityRows>) =>
      rows.map((row) => `${row.environment.ref.backendId}/${row.environment.name}`);
    expect(names(activityRows([mini, vps, laptop], "newest"))).toEqual([
      "bk_mini/env-1",
      "bk_vps/env-1",
      "bk_laptop/env-9",
    ]);
    expect(names(activityRows([mini, vps, laptop], "oldest"))).toEqual([
      "bk_laptop/env-9",
      "bk_vps/env-1",
      "bk_mini/env-1",
    ]);
  });

  test("chronological orders follow activity independently of snapshot and lease writes", () => {
    const a = environment("bk_a", "a", "p", {
      activity: "working",
      lastActivityAt: "2026-10-21T12:00:00Z",
      activityUpdatedAt: "2026-10-21T09:00:00Z",
    });
    const b = environment("bk_b", "b", "p", {
      activity: "working",
      lastActivityAt: "2026-10-21T11:00:00Z",
      activityUpdatedAt: "2026-10-21T11:00:00Z",
    });
    const machines = [
      machine("a", "A", { environmentsByProject: new Map([["p", [a]]]) }),
      machine("b", "B", { environmentsByProject: new Map([["p", [b]]]) }),
    ];
    const ids = (order: "priority" | "newest" | "oldest") =>
      activityRows(machines, order).map((row) => row.environment.ref.environmentId);
    expect(ids("newest")).toEqual(["a", "b"]);
    expect(ids("oldest")).toEqual(["b", "a"]);
    expect(ids("priority")).toEqual(["b", "a"]);

    // Another prompt/completion while the aggregate state remains working.
    b.lastActivityAt = "2026-10-21T13:00:00Z";
    expect(ids("newest")).toEqual(["b", "a"]);
    expect(ids("oldest")).toEqual(["a", "b"]);

    // A snapshot/lease refresh alone must not move the row chronologically.
    a.activityUpdatedAt = "2026-10-21T14:00:00Z";
    expect(ids("newest")).toEqual(["b", "a"]);
    expect(ids("oldest")).toEqual(["a", "b"]);
    expect(ids("priority")).toEqual(["a", "b"]);
  });

  test("chronological orders treat invalid/missing activity as undated and keep ID ties stable", () => {
    const timestamp = "2026-10-21T12:00:00Z";
    const a = machine("a", "A", {
      environmentsByProject: new Map([
        [
          "p",
          [
            environment("bk_a", "z", "p", { lastActivityAt: timestamp }),
            environment("bk_a", "a", "p", { lastActivityAt: timestamp }),
            environment("bk_a", "invalid", "p", {
              lastActivityAt: "invalid",
              activityUpdatedAt: timestamp,
            }),
            environment("bk_a", "missing", "p", { activityUpdatedAt: timestamp }),
          ],
        ],
      ]),
    });
    const b = machine("b", "B", {
      environmentsByProject: new Map([
        ["p", [environment("bk_b", "a", "p", { lastActivityAt: timestamp })]],
      ]),
    });
    const ids = (order: "newest" | "oldest") =>
      activityRows([b, a], order).map(
        (row) => `${row.machine.backendId}/${row.environment.ref.environmentId}`,
      );
    expect(ids("newest")).toEqual(["bk_a/a", "bk_a/z", "bk_b/a", "bk_a/invalid", "bk_a/missing"]);
    expect(ids("oldest")).toEqual(["bk_a/invalid", "bk_a/missing", "bk_a/a", "bk_a/z", "bk_b/a"]);
  });

  test("connectivity never claims everything is current while a machine is missing", () => {
    const summary = connectivitySummary([mini, vps, laptop]);
    expect(summary.label).toBe("2 connected · 1 unavailable");
    expect(summary.complete).toBe(false);
    expect(connectivitySummary([mini, vps]).complete).toBe(true);
  });

  test("filtering changes presentation only", () => {
    expect(filterMachines([mini, vps, laptop], "vps")).toEqual([vps]);
    expect(filterMachines([mini, vps], "all")).toHaveLength(2);
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

test("build-active rows sort with working rows on bound and remote machines", () => {
  for (const bound of [true, false]) {
    const view = machine("build", "Build", {
      bound,
      environmentsByProject: new Map([
        [
          "p",
          [
            environment("bk_build", "idle", "p", { order: 0 }),
            environment("bk_build", "build", "p", { order: 1, buildActive: true }),
            environment("bk_build", "working", "p", { order: 2, activity: "working" }),
          ],
        ],
      ]),
    });
    expect(activityRows([view]).map((row) => row.environment.name)).toEqual([
      "build",
      "working",
      "idle",
    ]);
  }
});
